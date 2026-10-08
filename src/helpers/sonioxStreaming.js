const WebSocket = require("ws");
const debugLogger = require("./debugLogger");
const { isPrivateHost } = require("./providerConnectionTest");
const { STREAMING_CONNECTION_FAILED } = require("./streamingConnectionErrors");

const WEBSOCKET_TIMEOUT_MS = 15000;
const DISCONNECT_TIMEOUT_MS = 3000;
const KEEPALIVE_INTERVAL_MS = 5000;
const KEEPALIVE_IDLE_LIMIT_MS = 30000; // Stop keepalive if no audio sent for 30s
const COLD_START_BUFFER_MAX = 3 * 16000 * 2; // 3 seconds of 16-bit PCM at 16kHz
// Data residency regions from Soniox's docs (US, EU, Japan, India).
const SONIOX_REGION_HOSTS = {
  us: "stt-rt.soniox.com",
  eu: "stt-rt.eu.soniox.com",
  jp: "stt-rt.jp.soniox.com",
  in: "stt-rt.in.soniox.com",
};
const SONIOX_REGIONS = Object.keys(SONIOX_REGION_HOSTS);
const SONIOX_WS_PATH = "/transcribe-websocket";
const DEFAULT_MODEL = "stt-rt-v5";

const toBaseLanguage = (l) => (l && l !== "auto" ? l.split("-")[0] : null);

// An unknown or empty region (stale setting, another provider's value) falls
// back to US rather than being sent as-is.
const resolveRegion = (region) => (Object.hasOwn(SONIOX_REGION_HOSTS, region) ? region : "us");

// A model that isn't a Soniox realtime model (e.g. a stale value imported from
// another provider) falls back to the default rather than being sent as-is —
// the same guard resolveByokModel applies in transcriptionRoute.ts.
const resolveModel = (model) => (model && model.startsWith("stt-rt-") ? model : DEFAULT_MODEL);

// What the recognizer is told about the speech, shared by the realtime config
// and the async request so both transcribe the same dictation the same way.
function buildHints({ language, extraLanguages, keyterms }) {
  const hints = {
    // Main language first, then extras in the user's order — new Set() keeps
    // insertion order, so this also dedupes a base code repeated between them.
    language_hints: [
      ...new Set(
        [toBaseLanguage(language), ...(extraLanguages || []).map(toBaseLanguage)].filter(Boolean)
      ),
    ],
  };
  const terms = (keyterms || []).filter(Boolean);
  if (terms.length) {
    hints.context = { terms };
  }
  return hints;
}

function buildConfigMessage({ apiKey, model, language, extraLanguages, keyterms, sampleRate }) {
  return {
    api_key: apiKey,
    model: resolveModel(model),
    audio_format: "pcm_s16le",
    sample_rate: sampleRate || 16000,
    num_channels: 1,
    ...buildHints({ language, extraLanguages, keyterms }),
  };
}

// Error frames that only say "this stream cannot go on": 408 request timeout,
// 413 the connection hit its duration cap, 500 internal error, 503 service
// unavailable (https://soniox.com/docs/api-reference/errors). The audio was
// fine and the same key works on the async API, so they are reported as a lost
// connection, which the renderer can fail over; every other code (bad key,
// no balance, bad model, rate limit) is one the user has to fix.
const RECOVERABLE_ERROR_CODES = new Set([408, 413, 500, 503]);
const RECOVERABLE_ERROR_TYPES = new Set([
  "request_timeout",
  "max_duration_reached",
  "internal_error",
  "service_unavailable",
]);

const isRecoverableErrorFrame = (frame) =>
  RECOVERABLE_ERROR_CODES.has(Number(frame.error_code)) ||
  RECOVERABLE_ERROR_TYPES.has(frame.error_type);

// A handshake that ends without an open socket (error, close before open,
// timeout) is tagged so the renderer can tell "the connection never came up"
// from a token, policy or key failure and sound the error cue.
function connectionFailure(message, cause) {
  return Object.assign(new Error(message), { code: STREAMING_CONNECTION_FAILED, cause });
}

// Best-effort hostname for logging: buildWebSocketUrl only ever returns a
// value it already parsed with new URL(), so this should never throw, but a
// log helper must never be the thing that crashes the call site.
function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

// SONIOX_WS_URL is main-process-only config (environment.js's PERSISTED_KEYS),
// but it still reaches a WebSocket constructor, so it gets the same treatment
// as a user-supplied endpoint: wss: for any host (the api_key in the first
// frame must not cross the network in the clear), ws: only for a host that
// never leaves the machine or the LAN, and no embedded credentials (they would
// otherwise land in a log line or a shell history that captured the .env write).
function validateWsUrlOverride(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    debugLogger.warn("Soniox SONIOX_WS_URL invalid, falling back to region host", {
      reason: "not a valid URL",
    });
    return null;
  }
  if (url.username || url.password) {
    debugLogger.warn("Soniox SONIOX_WS_URL invalid, falling back to region host", {
      reason: "credentials in URL",
      host: url.hostname,
    });
    return null;
  }
  if (url.protocol === "wss:") return url;
  if (url.protocol === "ws:" && isPrivateHost(url.hostname)) return url;
  debugLogger.warn("Soniox SONIOX_WS_URL invalid, falling back to region host", {
    reason:
      url.protocol === "ws:"
        ? "ws: only allowed for private or loopback hosts"
        : "unsupported scheme",
    host: url.hostname,
  });
  return null;
}

// Filler words / hesitations to strip from assembled text.
// Soniox uses sub-word (BPE) tokenization, so fillers must be removed from the
// joined text rather than individual tokens.
//
// Ported from the Hermes Soniox STT plugin (__init__.py's _filler_re /
// _replace_filler / _recapitalize / _strip_fillers), which forked this exact
// algorithm and then fixed it: capitalisation now happens only at the point
// a filler was removed (via a marker character) instead of after every
// sentence-ending punctuation mark in the whole text, and hyphenated words
// like "uh-huh" / "uh-oh" survive.
const FILLER_WORD = "(?:uh+|um+|yyy+|eee+|mmm+)";
const SENTENCE_END = ".!?";
// Hyphens are excluded on both sides so "uh-huh" and "uh-oh" — words, not
// hesitation — survive. The guards spell out Unicode letters because \w is
// ASCII-only in JS even with the u flag, and "umówmy" or "tłum" would be
// cut at the ó / ł. A quote touching the filler also blocks the match: when
// the model wraps "yyy" in quotes the speaker was naming the sound, not
// hesitating. The trailing class absorbs whatever punctuation the speaker's
// pause collected; replaceFiller decides what to give back.
// Horizontal whitespace only ([^\S\n]): a bare \s* would swallow the
// newlines around a filler and silently merge the speaker's paragraphs.
const WORD_OR_QUOTE = "\\p{L}\\p{N}_\"'„“”‘’«»-";
// The optional comma is grouped with its own whitespace run instead of
// sitting between two separately-optional whitespace runs: the old
// `[^\S\n]*,?[^\S\n]*` let both runs trade characters over a horizontal
// whitespace span with nothing to remove, which is cubic backtracking on the
// span's length once no filler follows it.
const FILLER_RE = new RegExp(
  `[^\\S\\n]*(?:,[^\\S\\n]*)?(?<![${WORD_OR_QUOTE}])${FILLER_WORD}(?![${WORD_OR_QUOTE}])[,.!?;:…]*[^\\S\\n]*`,
  "giu"
);
// Marks each point where a filler was removed, so capitalisation is applied
// only there. A blanket "capitalise after .!?" pass would also rewrite
// "e.g. the thing" and "1. first" in transcripts containing no filler at all.
const MARK = "\u0000";

const isSentenceEnd = (ch) => SENTENCE_END.includes(ch);

// Drop the filler, giving back a sentence boundary that was really a clause's.
// The trailing character class eats the punctuation after a filler. That is
// right when the filler was its own sentence ("really? Uh. Maybe so.") or
// when the run is a hesitation ellipsis ("So um... yeah"), and wrong when a
// single sentence-ender belonged to the clause before it ("I think, uh. Let
// me check.") — there the period has to survive.
function replaceFiller(match, offset, fullText) {
  const swallowed = [...match].filter(isSentenceEnd);
  const isEllipsis = swallowed.length > 1;
  if (swallowed.length > 0 && !isEllipsis && offset + match.length < fullText.length) {
    const before = fullText.slice(0, offset).trimEnd();
    const standalone = before === "" || isSentenceEnd(before[before.length - 1]);
    if (!standalone) return `${swallowed[0]} ${MARK}`;
  }
  return ` ${MARK}`;
}

// Upper-case the first letter after each removed filler that starts a sentence.
function recapitalize(text) {
  const chars = [...text];
  for (let index = 0; index < chars.length; index++) {
    if (chars[index] !== MARK) continue;
    let after = index + 1;
    while (after < chars.length && /\s/u.test(chars[after])) after++;
    if (after >= chars.length || !/\p{Ll}/u.test(chars[after])) continue;
    let before = index - 1;
    while (before >= 0 && (/\s/u.test(chars[before]) || chars[before] === MARK)) before--;
    if (before < 0 || isSentenceEnd(chars[before])) {
      chars[after] = chars[after].toUpperCase();
    }
  }
  return chars.join("");
}

function removeFillers(text) {
  let result = text.replaceAll(MARK, "").replace(FILLER_RE, replaceFiller);
  result = recapitalize(result).replaceAll(MARK, "");
  result = result.replace(/[^\S\n]{2,}/g, " ");
  result = result.replace(/[^\S\n]+(?=\n)/g, "");
  return result.trim();
}

class SonioxStreaming {
  constructor() {
    this.ws = null;
    this.isConnected = false;
    this.finalTokens = [];
    this.currentNonFinalText = "";
    this.coldStartBuffer = [];
    this.coldStartBufferSize = 0;
    this.onPartialTranscript = null;
    this.onFinalTranscript = null;
    this.onError = null;
    this.onSessionEnd = null;
    this.onFinalized = null;
    this.onConnectionLost = null;
    this.onAudioDropped = null;
    this.connectionLossNotified = false;
    this.audioDropNotified = false;
    this.pendingResolve = null;
    this.pendingReject = null;
    this.connectionTimeout = null;
    this.keepAliveInterval = null;
    this.isDisconnecting = false;
    this.audioBytesSent = 0;
    this.currentModel = DEFAULT_MODEL;
    this.removeFillersEnabled = true;
    this._finalizeSent = false;
    // Set once the server's <fin> token for the current session arrives —
    // the signal that closing right away loses no text (see disconnect()).
    this._finalized = false;
    this._lastAudioSentAt = 0;
    this._connecting = false;
    this._connectPromise = null;
  }

  getFullTranscript() {
    return this._clean(this.finalTokens.map((t) => t.text).join(""));
  }

  // removeFillers() already trims, so the disabled branch matches its shape.
  _clean(text) {
    return this.removeFillersEnabled ? removeFillers(text) : text.trim();
  }

  // process.env.SONIOX_WS_URL is a main-process-only escape hatch for a
  // self-hosted proxy; when set and valid it wins over the region select
  // entirely (no UI, see environment.js's PERSISTED_KEYS). An invalid value
  // (bad scheme, credentials, unparseable) is refused and logged with the
  // reason and host only — never the full URL, which could carry credentials.
  buildWebSocketUrl(options = {}) {
    const override = process.env.SONIOX_WS_URL;
    if (override) {
      const validated = validateWsUrlOverride(override);
      if (validated) {
        debugLogger.debug("Soniox region select ignored: SONIOX_WS_URL override active", {
          host: validated.hostname,
        });
        return override;
      }
    }
    const host = SONIOX_REGION_HOSTS[resolveRegion(options.region)];
    return `wss://${host}${SONIOX_WS_PATH}`;
  }

  // Rejects the in-flight connect() (if any) and clears both fields so a
  // later resolve/reject from the same handshake is a no-op. Used by every
  // path that can end a handshake without going through the open handler:
  // cleanup(), the connection timeout, and the error/close handlers.
  _settlePending(error) {
    if (this.pendingReject) {
      this.pendingReject(error);
    }
    this.pendingResolve = null;
    this.pendingReject = null;
  }

  notifyConnectionLost(error) {
    if (this.connectionLossNotified) return;
    this.connectionLossNotified = true;
    if (this.onConnectionLost) {
      this.onConnectionLost(error);
    } else {
      this.onError?.(error);
    }
  }

  // The cold-start buffer is full: the handshake is taking longer than the
  // buffer holds, so the opening of the dictation is being thrown away. Once
  // per session, however many frames follow.
  notifyAudioDropped() {
    if (this.audioDropNotified) return;
    this.audioDropNotified = true;
    this.onAudioDropped?.();
  }

  async connect(options = {}) {
    const { apiKey, mode } = options;
    if (mode !== "byok") {
      throw new Error("Soniox is available only with your own API key.");
    }
    if (!apiKey) throw new Error("Soniox API key is required");

    if (this.isConnected) {
      debugLogger.debug("Soniox already connected");
      return;
    }

    // A second caller while a handshake is in flight joins it instead of
    // opening a competing socket: without this, the first caller's `open`
    // handler would send its config to whichever socket ended up as this.ws.
    if (this._connectPromise) return this._connectPromise;

    this._connecting = true;
    this.connectionLossNotified = false;
    this.audioDropNotified = false;
    this._finalized = false;
    this._connectPromise = this._doConnect(options).finally(() => {
      this._connecting = false;
      this._connectPromise = null;
    });
    return this._connectPromise;
  }

  async _doConnect(options) {
    const configMessage = buildConfigMessage(options);
    this.currentModel = configMessage.model;
    this.removeFillersEnabled = options.removeFillers !== false;

    // coldStartBuffer is kept: frames the renderer sent before this call
    // belong to this session and go out after the config message.
    this.finalTokens = [];
    this.currentNonFinalText = "";
    this.audioBytesSent = 0;
    this._finalizeSent = false;

    const wsUrl = this.buildWebSocketUrl(options);

    debugLogger.debug("Soniox connecting", {
      host: hostOf(wsUrl),
      hasApiKey: Boolean(options.apiKey),
      model: configMessage.model,
      languageHints: configMessage.language_hints,
      contextTerms: configMessage.context?.terms?.length || 0,
    });

    try {
      await new Promise((resolve, reject) => {
        this.pendingResolve = resolve;
        this.pendingReject = reject;

        let ws;
        try {
          ws = new WebSocket(wsUrl);
        } catch (err) {
          this._settlePending(
            connectionFailure(`Soniox WebSocket failed to start: ${err.message}`, err)
          );
          return;
        }
        this.ws = ws;

        // Armed only once the socket exists, so a constructor throw can
        // never leave this timer running with nothing to time out.
        this.connectionTimeout = setTimeout(() => {
          this._settlePending(connectionFailure("Soniox WebSocket connection timeout"));
          this.cleanup();
        }, WEBSOCKET_TIMEOUT_MS);

        ws.on("open", () => {
          // A disconnect()/cleanup() during the handshake can replace this.ws
          // (or null it) before "open" arrives; a stale socket must not send
          // config or resolve a connect() that has already moved on.
          if (this.ws !== ws) return;
          debugLogger.debug("Soniox WebSocket opened, sending config");
          ws.send(JSON.stringify(configMessage));
          this.startKeepAlive();
          this.flushColdStartBuffer();

          clearTimeout(this.connectionTimeout);
          this.connectionTimeout = null;
          this.isConnected = true;
          this.pendingResolve();
          this.pendingResolve = null;
          this.pendingReject = null;
        });

        this.attachSessionHandlers();
      });
    } finally {
      clearTimeout(this.connectionTimeout);
      this.connectionTimeout = null;
    }
  }

  handleMessage(data) {
    try {
      const res = JSON.parse(data.toString());

      if (res.error_code) {
        debugLogger.error("Soniox error response", {
          code: res.error_code,
          message: res.error_message,
        });
        const error = new Error(`Soniox error ${res.error_code}: ${res.error_message}`);
        if (isRecoverableErrorFrame(res)) {
          // Sets the flag too, so the close that follows is not a second report.
          this.notifyConnectionLost(error);
          return;
        }
        // Soniox closes the socket right after an error frame; that close is
        // this same failure, not a second lost connection.
        this.connectionLossNotified = true;
        this.onError?.(error);
        return;
      }

      if (res.finished) {
        debugLogger.debug("Soniox session finished", {
          finalTokens: this.finalTokens.length,
          textLength: this.getFullTranscript().length,
        });
        this.onSessionEnd?.({ text: this.getFullTranscript() });
        return;
      }

      let nonFinalTexts = [];
      let newFinalTokens = false;
      let finalized = false;
      const isValidToken = (t) =>
        t.text && t.text !== "<fin>" && t.text !== "<end>" && t.text !== "�";
      for (const token of res.tokens || []) {
        if (token.text === "<fin>") finalized = true;
        if (!isValidToken(token)) continue;
        if (token.is_final) {
          this.finalTokens.push(token);
          newFinalTokens = true;
        } else {
          nonFinalTexts.push(token.text);
        }
      }

      const rawFinal = this.finalTokens.map((t) => t.text).join("");
      this.currentNonFinalText = nonFinalTexts.join("");

      // Final first: the consumer appends the partial to its committed text, so
      // the partial carries only the non-final tail and must follow the commit.
      if (newFinalTokens) {
        this.onFinalTranscript?.(this._clean(rawFinal));
      }
      this.onPartialTranscript?.(this._clean(this.currentNonFinalText));
      // <fin> closes a finalize: every token for the audio sent before it has
      // already arrived as final, so the stop path can move on without a timer.
      if (finalized) {
        this._finalized = true;
        this.onFinalized?.();
      }
    } catch (err) {
      debugLogger.error("Soniox message parse error", { error: err.message });
    }
  }

  attachSessionHandlers() {
    // A socket closed by disconnect() still emits close/error a round-trip
    // later; by then this.ws may already be the next session's socket, so a
    // stale handler must not reject its connect or tear it down.
    const ws = this.ws;
    const isStale = () => this.ws !== ws;
    this.ws.removeAllListeners("message");
    this.ws.removeAllListeners("error");
    this.ws.removeAllListeners("close");

    this.ws.on("message", (data) => {
      if (!isStale()) this.handleMessage(data);
    });

    this.ws.on("error", (error) => {
      if (isStale()) return;
      const wasActive = this.isConnected;
      // A handshake in flight reports this error through the rejected
      // connect(); a second report here would show the user two failures.
      const handshakePending = Boolean(this.pendingReject);
      debugLogger.error("Soniox WebSocket error", { error: error.message });
      this._settlePending(
        connectionFailure(`Soniox WebSocket connection failed: ${error.message}`, error)
      );
      this.cleanup();
      if (wasActive && !this.isDisconnecting) {
        this.notifyConnectionLost(error);
      } else if (!handshakePending && !this.isDisconnecting) {
        this.onError?.(error);
      }
    });

    this.ws.on("close", (code, reason) => {
      if (isStale()) return;
      const wasActive = this.isConnected;
      debugLogger.debug("Soniox WebSocket closed", {
        code,
        reason: reason?.toString(),
        wasActive,
      });
      this._settlePending(connectionFailure(`WebSocket closed before ready (code: ${code})`));
      this.cleanup();
      if (wasActive && !this.isDisconnecting) {
        this.onSessionEnd?.({ text: this.getFullTranscript() });
        // A clean close carries no error frame, but audioManager.js only
        // auto-stops the recording from onError — without this the pill
        // stays "recording" and drops audio until the 2s settle ceiling.
        this.notifyConnectionLost(new Error(`Connection lost (code: ${code})`));
      }
    });
  }

  flushColdStartBuffer() {
    if (this.coldStartBuffer.length === 0) return;

    debugLogger.debug("Soniox flushing cold-start buffer", {
      chunks: this.coldStartBuffer.length,
      bytes: this.coldStartBufferSize,
    });
    for (const buf of this.coldStartBuffer) {
      this.ws.send(buf);
      this.audioBytesSent += buf.length;
    }
    this.coldStartBuffer = [];
    this.coldStartBufferSize = 0;
  }

  sendAudio(pcmBuffer) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.flushColdStartBuffer();
      this.ws.send(pcmBuffer);
      this.audioBytesSent += pcmBuffer.length;
      this._lastAudioSentAt = Date.now();
      return true;
    }

    // The renderer starts sending before the start IPC lands, so frames arrive
    // while connect() is pending or the socket is mid-handshake. Buffering them
    // (flushed on open) is not a drop, until the buffer is full.
    const connectionImminent =
      this._connecting || (this.ws && this.ws.readyState === WebSocket.CONNECTING);

    if (connectionImminent) {
      if (this.coldStartBufferSize >= COLD_START_BUFFER_MAX) {
        this.notifyAudioDropped();
        return false;
      }
      const copy = Buffer.from(pcmBuffer);
      this.coldStartBuffer.push(copy);
      this.coldStartBufferSize += copy.length;
      return true;
    }

    return false;
  }

  finalize() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;

    this._finalizeSent = true;
    this.ws.send(JSON.stringify({ type: "finalize" }));
    debugLogger.debug("Soniox finalize sent");
    return true;
  }

  startKeepAlive() {
    this.stopKeepAlive();
    this._lastAudioSentAt = Date.now();
    this.keepAliveInterval = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        this.stopKeepAlive();
        return;
      }
      if (Date.now() - this._lastAudioSentAt > KEEPALIVE_IDLE_LIMIT_MS) {
        debugLogger.debug("Soniox idle timeout, closing connection");
        const wasActive = this.isConnected;
        this.cleanup();
        this.onSessionEnd?.({ text: this.getFullTranscript() });
        if (wasActive && !this.isDisconnecting) {
          this.notifyConnectionLost(new Error("Soniox connection idle timeout"));
        }
        return;
      }
      try {
        this.ws.send(JSON.stringify({ type: "keepalive" }));
      } catch (err) {
        debugLogger.debug("Soniox keep-alive failed", { error: err.message });
        this.stopKeepAlive();
      }
    }, KEEPALIVE_INTERVAL_MS);
  }

  stopKeepAlive() {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }
  }

  async disconnect(closeStream = true) {
    debugLogger.debug("Soniox disconnect", {
      closeStream,
      audioBytesSent: this.audioBytesSent,
      finalTokens: this.finalTokens.length,
      textLength: this.getFullTranscript().length,
    });

    if (!this.ws) {
      // The session already ended on its own (server close, error, idle) and
      // the renderer kept sending until it noticed.
      this.coldStartBuffer = [];
      this.coldStartBufferSize = 0;
      return { text: this.getFullTranscript() };
    }

    this.isDisconnecting = true;

    if (closeStream && this.ws.readyState === WebSocket.OPEN && this.audioBytesSent > 0) {
      if (!this._finalizeSent) {
        this.finalize();
      }
      // <fin> already carries every final token for the audio sent before it,
      // so waiting for it (bounded, same as the old drain) costs nothing the
      // stop path needs — unlike waiting for the server's own "finished" reply
      // afterwards, which is one more round trip for no new text.
      if (!this._finalized) {
        await this._drainCallback("onFinalized", () => {});
      }
      // Keep-alive must never follow the end-of-audio marker below — stop it
      // before sending, not after, so a slow interval tick can't race it.
      this.stopKeepAlive();
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send("");
      }
    }

    if (this.ws) {
      this.ws.close();
    }

    const result = { text: this.getFullTranscript() };
    this.cleanup();
    this.isDisconnecting = false;
    return result;
  }

  _drainCallback(callbackName, sendFn) {
    return new Promise((resolve) => {
      const prev = this[callbackName];

      const tid = setTimeout(() => {
        debugLogger.debug(`Soniox ${callbackName} drain timeout`);
        this[callbackName] = prev;
        resolve();
      }, DISCONNECT_TIMEOUT_MS);

      this[callbackName] = (...args) => {
        clearTimeout(tid);
        this[callbackName] = prev;
        prev?.(...args);
        resolve();
      };

      try {
        sendFn();
      } catch {
        clearTimeout(tid);
        this[callbackName] = prev;
        resolve();
      }
    });
  }

  cleanup() {
    this.stopKeepAlive();
    clearTimeout(this.connectionTimeout);
    this.connectionTimeout = null;
    // So frames buffered for this session (mid-handshake) can never bleed
    // into the next one.
    this.coldStartBuffer = [];
    this.coldStartBufferSize = 0;
    // A no-op once a handler above has already settled the in-flight
    // connect() with a specific reason; the safety net for every other path
    // that can tear the socket down mid-handshake (disconnect() while
    // CONNECTING).
    this._settlePending(new Error("Soniox connection closed"));

    if (this.ws) {
      try {
        this.ws.close();
      } catch (err) {
        // ignore
      }
      this.ws = null;
    }

    this.isConnected = false;
  }

  getStatus() {
    return { isConnected: this.isConnected, sessionId: null };
  }
}

module.exports = SonioxStreaming;
module.exports.removeFillers = removeFillers;
module.exports.buildConfigMessage = buildConfigMessage;
module.exports.buildHints = buildHints;
module.exports.resolveRegion = resolveRegion;
module.exports.isRecoverableErrorFrame = isRecoverableErrorFrame;
module.exports.DEFAULT_MODEL = DEFAULT_MODEL;
module.exports.SONIOX_REGIONS = SONIOX_REGIONS;
