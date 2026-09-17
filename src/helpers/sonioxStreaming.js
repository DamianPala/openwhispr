const WebSocket = require("ws");
const debugLogger = require("./debugLogger");

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

function buildConfigMessage({ apiKey, model, language, secondaryLanguage, keyterms, sampleRate }) {
  const config = {
    api_key: apiKey,
    model: resolveModel(model),
    audio_format: "pcm_s16le",
    sample_rate: sampleRate || 16000,
    num_channels: 1,
    language_hints: [
      ...new Set([toBaseLanguage(language), toBaseLanguage(secondaryLanguage)].filter(Boolean)),
    ],
  };
  const terms = (keyterms || []).filter(Boolean);
  if (terms.length) {
    config.context = { terms };
  }
  return config;
}

// Everything a warm socket is configured with, folded the way buildConfigMessage
// folds it, so a warm connection can be compared against the session that wants
// to ride it. The dictionary and sample rate can change between warmup and start,
// just like language on Deepgram — see deepgramStreaming.js's urlIdentity.
const warmIdentity = (options) =>
  JSON.stringify([
    resolveModel(options.model),
    options.language || null,
    options.secondaryLanguage || null,
    options.sampleRate || 16000,
    resolveRegion(options.region),
    (options.keyterms || []).filter(Boolean),
  ]);

// Filler words / hesitations to strip from assembled text.
// Soniox uses sub-word (BPE) tokenization, so fillers must be removed from the
// joined text rather than individual tokens.
const FILLER_WORD = "(?:uh+|um+|yyy+|eee+|mmm+)";
const FILLER_RE = new RegExp(`\\s*,?\\s*\\b${FILLER_WORD}\\b[,.]?\\s*`, "gi");
const LEADING_FILLER_RE = new RegExp(`^\\s*,?\\s*\\b${FILLER_WORD}\\b`, "i");
const POST_SENTENCE_CAP_RE = /([.!?]\s+)(\p{Ll})/gu;

function removeFillers(text) {
  const hadLeadingFiller = LEADING_FILLER_RE.test(text);
  let result = text.replace(FILLER_RE, (match, offset, fullText) => {
    // Preserve sentence-ending periods consumed by [,.]? in the regex.
    // "word, uh. Next" → ". " (period is sentence boundary)
    // "OK. Uh. Next"   → " "  (filler is standalone sentence)
    if (match.includes(".")) {
      const moreTextAfter = offset + match.length < fullText.length;
      if (moreTextAfter) {
        const textBeforeMatch = fullText.slice(0, offset).trimEnd();
        const isStandaloneFiller = textBeforeMatch === "" || /[.!?]$/.test(textBeforeMatch);
        if (!isStandaloneFiller) return ". ";
      }
    }
    return " ";
  });
  result = result.replace(/  +/g, " ").trim();
  result = result.replace(POST_SENTENCE_CAP_RE, (_, punct, letter) => punct + letter.toUpperCase());
  if (hadLeadingFiller) {
    result = result.replace(/^\p{Ll}/u, (c) => c.toUpperCase());
  }
  return result;
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
    this.pendingResolve = null;
    this.pendingReject = null;
    this.connectionTimeout = null;
    this.keepAliveInterval = null;
    this.isDisconnecting = false;
    this.audioBytesSent = 0;
    this.currentModel = DEFAULT_MODEL;
    this._finalizeSent = false;
    this._lastAudioSentAt = 0;
    this._connecting = false;

    // Warm connection state
    this.warmConnection = null;
    this.warmConnectionReady = false;
    this.warmConnectionOptions = null;
    this.warmKeepAliveInterval = null;
    this.warmIdleTimeout = null;
  }

  getFullTranscript() {
    return removeFillers(this.finalTokens.map((t) => t.text).join("")).trim();
  }

  // process.env.SONIOX_WS_URL is a main-process-only escape hatch for a
  // self-hosted proxy; when set it wins over the region select entirely
  // (no UI, see environment.js's PERSISTED_KEYS).
  buildWebSocketUrl(options = {}) {
    if (process.env.SONIOX_WS_URL) {
      debugLogger.info("Soniox region select ignored: SONIOX_WS_URL override active", {
        region: resolveRegion(options.region),
        url: process.env.SONIOX_WS_URL,
      });
      return process.env.SONIOX_WS_URL;
    }
    const host = SONIOX_REGION_HOSTS[resolveRegion(options.region)];
    return `wss://${host}${SONIOX_WS_PATH}`;
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

    // Set for the whole handshake (cleared in the finally below) so sendAudio
    // can tell "no socket yet, but one is on the way" apart from a real drop.
    this._connecting = true;
    try {
      // Computed before the warm/cold branch so a session promoted onto a warm
      // socket reports the model actually sent (warmIdentity guarantees it
      // matches the model buildConfigMessage would resolve for a cold start).
      const configMessage = buildConfigMessage(options);
      this.currentModel = configMessage.model;

      // Try to use pre-warmed connection for instant start
      if (this.hasWarmConnection()) {
        const identityMatch =
          this.warmConnectionOptions &&
          warmIdentity(this.warmConnectionOptions) === warmIdentity(options);
        if (identityMatch && this.useWarmConnection()) {
          debugLogger.debug("Soniox using warm connection - instant start");
          // Frames sent while this promotion was still in flight (ws was null)
          // were buffered by sendAudio; the promoted socket is open now, so
          // flush them the same way the cold path does after its own "open".
          this.flushColdStartBuffer();
          return;
        }
        this.cleanupWarmConnection();
      }

      // coldStartBuffer is kept: frames sent before this call, buffered against
      // a warm socket whose identity turned out not to match, still belong to
      // this session and go out after the config message.
      this.finalTokens = [];
      this.currentNonFinalText = "";
      this.audioBytesSent = 0;
      this._finalizeSent = false;

      const wsUrl = this.buildWebSocketUrl(options);

      debugLogger.debug("Soniox connecting", {
        url: wsUrl,
        hasApiKey: Boolean(apiKey),
        model: configMessage.model,
        languageHints: configMessage.language_hints,
        contextTerms: configMessage.context?.terms?.length || 0,
      });

      await new Promise((resolve, reject) => {
        this.pendingResolve = resolve;
        this.pendingReject = reject;

        this.connectionTimeout = setTimeout(() => {
          this.cleanup();
          reject(new Error("Soniox WebSocket connection timeout"));
        }, WEBSOCKET_TIMEOUT_MS);

        this.ws = new WebSocket(wsUrl);

        this.ws.on("open", () => {
          debugLogger.debug("Soniox WebSocket opened, sending config");
          this.ws.send(JSON.stringify(configMessage));
          this.startKeepAlive();
          this.flushColdStartBuffer();

          clearTimeout(this.connectionTimeout);
          this.isConnected = true;
          this.pendingResolve();
          this.pendingResolve = null;
          this.pendingReject = null;
        });

        this.attachSessionHandlers();
      });
    } finally {
      this._connecting = false;
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
        this.onError?.(new Error(`Soniox error ${res.error_code}: ${res.error_message}`));
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

      this.onPartialTranscript?.(removeFillers(rawFinal + this.currentNonFinalText));

      if (newFinalTokens) {
        this.onFinalTranscript?.(removeFillers(rawFinal));
      }
      // <fin> closes a finalize: every token for the audio sent before it has
      // already arrived as final, so the stop path can move on without a timer.
      if (finalized) {
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
      debugLogger.error("Soniox WebSocket error", { error: error.message });
      this.cleanup();
      if (this.pendingReject) {
        this.pendingReject(error);
        this.pendingReject = null;
        this.pendingResolve = null;
      }
      this.onError?.(error);
    });

    this.ws.on("close", (code, reason) => {
      if (isStale()) return;
      const wasActive = this.isConnected;
      debugLogger.debug("Soniox WebSocket closed", {
        code,
        reason: reason?.toString(),
        wasActive,
      });
      if (this.pendingReject) {
        this.pendingReject(new Error(`WebSocket closed before ready (code: ${code})`));
        this.pendingReject = null;
        this.pendingResolve = null;
      }
      this.cleanup();
      if (wasActive && !this.isDisconnecting) {
        this.onSessionEnd?.({ text: this.getFullTranscript() });
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
    // while connect() is still pending, the cold socket is mid-handshake, or a
    // warm socket is waiting to be promoted. Buffering them (flushed on open or
    // right after promotion) is not a drop.
    const connectionImminent =
      this._connecting ||
      (this.ws && this.ws.readyState === WebSocket.CONNECTING) ||
      this.hasWarmConnection();

    if (connectionImminent) {
      if (this.coldStartBufferSize >= COLD_START_BUFFER_MAX) return false;
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
        this.cleanup();
        this.onSessionEnd?.({ text: this.getFullTranscript() });
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
      // the renderer kept sending until it noticed; with a warm socket sitting
      // ready those frames were buffered and belong to no session.
      this.coldStartBuffer = [];
      this.coldStartBufferSize = 0;
      return { text: this.getFullTranscript() };
    }

    this.isDisconnecting = true;

    if (closeStream && this.ws.readyState === WebSocket.OPEN && this.audioBytesSent > 0) {
      if (!this._finalizeSent) {
        await this.drainFinalTokens();
      }
      await this.drainSessionEnd();
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

  drainFinalTokens() {
    return this._drainCallback("onFinalTranscript", () =>
      this.ws.send(JSON.stringify({ type: "finalize" }))
    );
  }

  drainSessionEnd() {
    return this._drainCallback("onSessionEnd", () => this.ws.send(""));
  }

  // Only tears down the active socket. The warm connection is a separate,
  // independently-lived resource (see cleanupAll) so a recording's cleanup
  // never cuts short a keep-alive the user asked for (sonioxKeepAliveTimeout).
  cleanup() {
    this.stopKeepAlive();
    clearTimeout(this.connectionTimeout);
    this.connectionTimeout = null;
    // So frames buffered for this session (mid-handshake, or while a warm
    // socket sat ready) can never bleed into the next one.
    this.coldStartBuffer = [];
    this.coldStartBufferSize = 0;

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

  cleanupAll() {
    this.cleanup();
    this.cleanupWarmConnection();
  }

  // --- Warm connection (keep-alive between recordings) ---

  async warmup(options = {}) {
    const { apiKey, idleTimeoutMs } = options;
    if (!apiKey) throw new Error("Soniox API key is required for warmup");

    if (this.warmConnection) {
      debugLogger.debug(
        this.warmConnectionReady
          ? "Soniox connection already warm"
          : "Soniox warmup already in progress, skipping"
      );
      return;
    }

    this.warmConnectionReady = false;
    this.warmConnectionOptions = { ...options };

    const configMessage = buildConfigMessage(options);
    const wsUrl = this.buildWebSocketUrl(options);

    debugLogger.debug("Soniox warming up connection", {
      model: configMessage.model,
      languageHints: configMessage.language_hints,
      idleTimeoutMs,
    });

    return new Promise((resolve, reject) => {
      const warmupTimeout = setTimeout(() => {
        this.cleanupWarmConnection();
        reject(new Error("Soniox warmup connection timeout"));
      }, WEBSOCKET_TIMEOUT_MS);

      const warm = new WebSocket(wsUrl);
      this.warmConnection = warm;
      // Same stale-socket rule as attachSessionHandlers: once this warm socket
      // has been promoted or discarded, its late close/error must not touch
      // whatever warm socket replaced it.
      const isStale = () => this.warmConnection !== warm;

      this.warmConnection.on("open", () => {
        debugLogger.debug("Soniox warm connection opened, sending config");
        this.warmConnection.send(JSON.stringify(configMessage));
        clearTimeout(warmupTimeout);
        this.warmConnectionReady = true;
        this.startWarmKeepAlive(idleTimeoutMs);
        debugLogger.debug("Soniox connection warmed up");
        resolve();
      });

      this.warmConnection.on("message", () => {
        // Discard messages on warm connection (no audio sent yet)
      });

      this.warmConnection.on("error", (error) => {
        if (isStale()) return;
        clearTimeout(warmupTimeout);
        debugLogger.error("Soniox warmup connection error", { error: error.message });
        this.cleanupWarmConnection();
        reject(error);
      });

      this.warmConnection.on("close", (code, reason) => {
        if (isStale()) return;
        clearTimeout(warmupTimeout);
        const wasReady = this.warmConnectionReady;
        debugLogger.debug("Soniox warm connection closed", {
          wasReady,
          code,
          reason: reason?.toString(),
        });
        this.cleanupWarmConnection();
        if (!wasReady) {
          reject(new Error(`Soniox warmup closed before ready (code: ${code})`));
        }
      });
    });
  }

  useWarmConnection() {
    if (!this.warmConnection || !this.warmConnectionReady) {
      return false;
    }

    if (this.warmConnection.readyState !== WebSocket.OPEN) {
      debugLogger.debug("Soniox warm connection readyState not OPEN, discarding", {
        readyState: this.warmConnection.readyState,
      });
      this.cleanupWarmConnection();
      return false;
    }

    this.stopWarmKeepAlive();

    this.ws = this.warmConnection;
    this.isConnected = true;
    this.warmConnection = null;
    this.warmConnectionReady = false;

    this.attachSessionHandlers();

    // Reset session state for fresh dictation. Not the cold-start buffer: it
    // may hold frames sendAudio queued while this warm socket sat ready
    // (identity known, connect() not yet called) — connect() flushes those
    // right after this call returns, the same way the cold path flushes on
    // "open". cleanup() clears it at the end of every session, so nothing
    // from an earlier dictation can survive into this one.
    this.finalTokens = [];
    this.currentNonFinalText = "";
    this.audioBytesSent = 0;
    this._finalizeSent = false;

    this.startKeepAlive();

    debugLogger.debug("Soniox using pre-warmed connection");
    return true;
  }

  startWarmKeepAlive(idleTimeoutMs) {
    this.stopWarmKeepAlive();

    if (idleTimeoutMs > 0) {
      this.warmIdleTimeout = setTimeout(() => {
        debugLogger.debug("Soniox warm connection idle timeout, closing");
        this.cleanupWarmConnection();
      }, idleTimeoutMs);
    }

    this.warmKeepAliveInterval = setInterval(() => {
      if (!this.warmConnection || this.warmConnection.readyState !== WebSocket.OPEN) {
        this.stopWarmKeepAlive();
        return;
      }
      try {
        this.warmConnection.send(JSON.stringify({ type: "keepalive" }));
      } catch (err) {
        debugLogger.debug("Soniox warm keep-alive failed", { error: err.message });
        this.cleanupWarmConnection();
      }
    }, KEEPALIVE_INTERVAL_MS);
  }

  stopWarmKeepAlive() {
    if (this.warmKeepAliveInterval) {
      clearInterval(this.warmKeepAliveInterval);
      this.warmKeepAliveInterval = null;
    }
    if (this.warmIdleTimeout) {
      clearTimeout(this.warmIdleTimeout);
      this.warmIdleTimeout = null;
    }
  }

  cleanupWarmConnection() {
    this.stopWarmKeepAlive();
    if (this.warmConnection) {
      try {
        this.warmConnection.close();
      } catch (err) {
        // ignore
      }
      this.warmConnection = null;
    }
    this.warmConnectionReady = false;
    this.warmConnectionOptions = null;
  }

  hasWarmConnection() {
    return (
      this.warmConnection !== null &&
      this.warmConnectionReady &&
      this.warmConnection.readyState === WebSocket.OPEN
    );
  }

  getStatus() {
    return {
      isConnected: this.isConnected,
      sessionId: null,
      hasWarmConnection: this.hasWarmConnection(),
    };
  }
}

module.exports = SonioxStreaming;
module.exports.removeFillers = removeFillers;
module.exports.buildConfigMessage = buildConfigMessage;
module.exports.DEFAULT_MODEL = DEFAULT_MODEL;
module.exports.SONIOX_REGIONS = SONIOX_REGIONS;
