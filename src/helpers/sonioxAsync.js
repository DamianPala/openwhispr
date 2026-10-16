const debugLogger = require("./debugLogger");
const { ASYNC_INVALID_AUDIO } = require("./streamingConnectionErrors");
const { removeFillers, buildHints, resolveRegion } = require("./sonioxStreaming");
const { applyVoiceCommands } = require("./voiceCommands");
const {
  PROVIDER_ERROR_CODES,
  providerHttpError,
  providerError,
  asProviderError,
} = require("./providerHttpErrors");

// Soniox's file API, used when the realtime stream could not carry a dictation:
// upload the recording, create a transcription, poll, read the tokens, delete
// both (https://soniox.com/docs/stt/async/async-transcription). Same key and
// region as the realtime client; the REST host of a region is the realtime host
// without the "stt-rt" prefix (https://soniox.com/docs/stt/data-residency).
const SONIOX_API_HOSTS = {
  us: "api.soniox.com",
  eu: "api.eu.soniox.com",
  jp: "api.jp.soniox.com",
  in: "api.in.soniox.com",
};
const ASYNC_MODEL = "stt-async-v5";
const PROVIDER = "Soniox";
const SURFACE = "transcription";

// Soniox publishes no turnaround figure, so the wait is generous: a floor for
// the upload and queueing, plus the recording's own length, capped so a stuck
// job cannot hold the pill for ever.
const MIN_DEADLINE_MS = 30000;
const MAX_DEADLINE_MS = 300000;
const POLL_INTERVAL_MS = 1000;
const CLEANUP_TIMEOUT_MS = 10000;
const CLEANUP_RETRY_MS = 5000;
const CLEANUP_MAX_MS = 120000;
const GET_RETRIES = 2;
const GET_RETRY_DELAY_MS = 500;
// The context object is limited to 8,000 tokens (about 10,000 characters);
// beyond that the request is refused, which would lose the dictation.
// https://soniox.com/docs/stt/concepts/context
const MAX_TERMS_CHARS = 8000;

const asyncDeadlineMs = (durationMs) =>
  Math.min(MAX_DEADLINE_MS, MIN_DEADLINE_MS + Math.max(0, Number(durationMs) || 0));

function capTerms(keyterms) {
  const kept = [];
  let chars = 0;
  for (const term of keyterms || []) {
    if (!term) continue;
    chars += term.length;
    if (chars > MAX_TERMS_CHARS) break;
    kept.push(term);
  }
  return kept;
}

function extensionFor(mimeType) {
  if (mimeType.includes("wav")) return "wav";
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("mp4")) return "mp4";
  if (mimeType.includes("mpeg")) return "mp3";
  return "webm";
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

const isTransient = (error) =>
  error?.name !== "AbortError" &&
  error?.name !== "TimeoutError" &&
  (error?.status === undefined || error.status === 408 || error.status >= 500);

function jobError(job) {
  const errorType = job.error_type || "unknown";
  const error = providerError(PROVIDER_ERROR_CODES.ERROR, {
    provider: PROVIDER,
    surface: SURFACE,
    technicalDetails: { underlyingError: errorType },
  });
  if (errorType === "invalid_audio_file") error.code = ASYNC_INVALID_AUDIO;
  return error;
}

function markInvalidAudio(error, bodyText) {
  if (error.status === 400 && /invalid_audio_file/.test(bodyText)) error.code = ASYNC_INVALID_AUDIO;
  return error;
}

function createClient({ apiKey, baseUrl, fetchImpl }) {
  async function call(method, path, { json, form, signal } = {}) {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(json ? { "Content-Type": "application/json" } : {}),
      },
      body: json ? JSON.stringify(json) : form,
      signal,
    });
    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      throw markInvalidAudio(
        providerHttpError({
          provider: PROVIDER,
          status: response.status,
          body: bodyText,
          headers: response.headers,
          surface: SURFACE,
        }),
        bodyText
      );
    }
    return response;
  }

  return {
    async uploadFile({ audio, mimeType, signal }) {
      const form = new FormData();
      form.append(
        "file",
        new Blob([audio], { type: mimeType }),
        `recording.${extensionFor(mimeType)}`
      );
      return (await call("POST", "/v1/files", { form, signal })).json();
    },
    async createTranscription({ fileId, hints, signal }) {
      return (
        await call("POST", "/v1/transcriptions", {
          json: { model: ASYNC_MODEL, file_id: fileId, ...hints },
          signal,
        })
      ).json();
    },
    async getJson(path, signal) {
      for (let attempt = 0; ; attempt++) {
        try {
          return await (await call("GET", path, { signal })).json();
        } catch (error) {
          if (attempt >= GET_RETRIES || signal.aborted || !isTransient(error)) throw error;
          await sleep(GET_RETRY_DELAY_MS * (attempt + 1), signal);
        }
      }
    },
    async remove(path) {
      await call("DELETE", path, { signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS) });
    },
  };
}

// Cleanup runs after the result is handed back, so it never holds up the paste.
// The set keeps each run reachable until it settles (and lets tests wait for it).
const pendingCleanups = new Set();
const NEVER_ABORTED = new AbortController().signal;

function trackCleanup(cleanup) {
  const tracked = cleanup
    .catch((error) => {
      debugLogger.warn("Soniox async cleanup crashed", { error: error?.message }, "transcription");
    })
    .finally(() => pendingCleanups.delete(tracked));
  pendingCleanups.add(tracked);
}

const settleCleanups = () => Promise.all([...pendingCleanups]);

// Deletes one remote object. Soniox refuses (409) to delete a transcription that
// is still processing, so an abandoned job is retried until it has left that
// state or `maxMs` has passed. Only ids and statuses are logged.
async function removeRemote(client, kind, id, { retryMs, maxMs }) {
  const path = kind === "file" ? `/v1/files/${id}` : `/v1/transcriptions/${id}`;
  const giveUpAt = Date.now() + maxMs;
  for (;;) {
    try {
      await client.remove(path);
      return;
    } catch (error) {
      if (error?.status === 404) return;
      const stillProcessing = error?.status === 409 && Date.now() + retryMs < giveUpAt;
      if (!stillProcessing) {
        debugLogger.warn(
          "Soniox async cleanup failed",
          { kind, id, status: error?.status, code: error?.code },
          "transcription"
        );
        return;
      }
      await sleep(retryMs, NEVER_ABORTED);
    }
  }
}

// Best effort: Soniox drops whatever is left after 30 days. A finished job is
// deleted as it is. An abandoned one (timeout, cancel, error) may still be
// processing, so its file goes first: that fails the job, after which the
// transcription can be deleted, retrying while Soniox says it is busy.
async function finishRemote(client, { transcriptionId, fileId }, { finished, retryMs, maxMs }) {
  const targets = [
    transcriptionId && ["transcription", transcriptionId],
    fileId && ["file", fileId],
  ].filter(Boolean);
  if (!finished) targets.reverse();
  for (const [kind, id] of targets) {
    await removeRemote(client, kind, id, { retryMs, maxMs });
  }
  debugLogger.debug("Soniox async cleanup done", { transcriptionId, fileId }, "transcription");
}

const isSpokenToken = (token) =>
  Boolean(token?.text) && token.text !== "<fin>" && token.text !== "<end>" && token.text !== "�";

// The recording as text. With voice commands on they are applied to the tokens
// (their timing is what tells a command from dictation); a reply without tokens
// is handed over as one token, which leaves only the no-timing rule to go by.
function tokensToText(transcript, { voiceCommands, keyterms, skipFillers } = {}) {
  const hasTokens = Array.isArray(transcript?.tokens);
  if (!hasTokens && typeof transcript?.text !== "string") return "";
  if (!voiceCommands) {
    return hasTokens
      ? transcript.tokens
          .filter(isSpokenToken)
          .map((token) => token.text)
          .join("")
      : transcript.text;
  }
  const tokens = hasTokens ? transcript.tokens.filter(isSpokenToken) : [{ text: transcript.text }];
  return applyVoiceCommands(tokens, { keyterms, skipFillers });
}

// A deadline or a user cancel surfaces as the matching error; anything the
// client could not classify (no network) is classified here.
function settleError(error, { deadline, signal }) {
  if (deadline.aborted)
    return providerError(PROVIDER_ERROR_CODES.TIMEOUT, { provider: PROVIDER, surface: SURFACE });
  if (signal?.aborted)
    return Object.assign(new Error("Transcription cancelled"), { name: "AbortError" });
  return asProviderError(error, { provider: PROVIDER, surface: SURFACE });
}

/**
 * Transcribes a whole recording through Soniox's async API and returns
 * `{ text, transcriptionId, audioDurationMs, timings }`. Never logs audio or text.
 */
async function transcribeRecording({
  apiKey,
  region,
  audio,
  mimeType = "audio/webm",
  durationMs,
  language,
  extraLanguages,
  keyterms,
  removeFillers: stripFillers = true,
  voiceCommands = false,
  signal,
  fetchImpl = fetch,
  baseUrl = `https://${SONIOX_API_HOSTS[resolveRegion(region)]}`,
  pollIntervalMs = POLL_INTERVAL_MS,
  deadlineMs = asyncDeadlineMs(durationMs),
  cleanupRetryMs = CLEANUP_RETRY_MS,
  cleanupMaxMs = CLEANUP_MAX_MS,
}) {
  const deadline = AbortSignal.timeout(deadlineMs);
  const abort = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const client = createClient({ apiKey, baseUrl, fetchImpl });
  const remote = { fileId: null, transcriptionId: null };
  const startedAt = Date.now();
  const timings = {};
  let finished = false;

  try {
    const file = await client.uploadFile({ audio, mimeType, signal: abort });
    remote.fileId = file.id;
    timings.uploadMs = Date.now() - startedAt;
    debugLogger.debug(
      "Soniox async file uploaded",
      { fileId: file.id, bytes: audio.length, uploadMs: timings.uploadMs },
      "transcription"
    );

    const hints = buildHints({
      language,
      extraLanguages,
      keyterms: capTerms(keyterms),
      voiceCommands,
    });
    const created = await client.createTranscription({ fileId: file.id, hints, signal: abort });
    remote.transcriptionId = created.id;

    let job;
    for (;;) {
      job = await client.getJson(`/v1/transcriptions/${created.id}`, abort);
      if (job.status === "completed") break;
      if (job.status === "error") throw jobError(job);
      await sleep(pollIntervalMs, abort);
    }
    timings.processingMs = Date.now() - startedAt - timings.uploadMs;

    const transcript = await client.getJson(`/v1/transcriptions/${created.id}/transcript`, abort);
    const raw = tokensToText(transcript, { voiceCommands, keyterms, skipFillers: stripFillers });
    finished = true;
    timings.totalMs = Date.now() - startedAt;
    debugLogger.info(
      "Soniox async transcription done",
      {
        transcriptionId: created.id,
        audioDurationMs: job.audio_duration_ms,
        textLength: raw.length,
        ...timings,
      },
      "transcription"
    );
    return {
      text: stripFillers ? removeFillers(raw) : raw.trim(),
      model: ASYNC_MODEL,
      transcriptionId: created.id,
      audioDurationMs: job.audio_duration_ms ?? null,
      timings,
    };
  } catch (error) {
    throw settleError(error, { deadline, signal });
  } finally {
    trackCleanup(
      finishRemote(client, remote, {
        finished,
        retryMs: cleanupRetryMs,
        maxMs: cleanupMaxMs,
      })
    );
  }
}

module.exports = {
  transcribeRecording,
  settleCleanups,
  asyncDeadlineMs,
  SONIOX_API_HOSTS,
  ASYNC_MODEL,
  MAX_TERMS_CHARS,
};
