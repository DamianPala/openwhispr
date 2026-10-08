const test = require("node:test");
const assert = require("node:assert/strict");
const { mock } = require("node:test");
const { loadAudioManager } = require("./harness/audioManager");
const { deferred } = require("./harness/deferred");

const CAPTURE_READY_TIMEOUT_MS = 1500;

const SETTINGS = {
  useLocalWhisper: false,
  transcriptionMode: "providers",
  cloudTranscriptionMode: "byok",
  cloudTranscriptionProvider: "soniox",
  cloudTranscriptionModel: "stt-rt-v5",
  sonioxApiKey: "key",
  isSignedIn: false,
};

const frame = (...samples) => new Int16Array(samples).buffer;

// A streaming start driven against fakes: the provider's start() stays pending
// until the test settles it, and the worklet's port is the test's microphone.
async function startSession(t, { startResult, errorCode } = {}) {
  const { createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-start-cue-test-",
    settingsKey: "__startCueSettings",
    settings: SETTINGS,
  });

  const events = { audible: 0, errors: [], warnings: [], stateChanges: [] };
  const handlers = {};
  const sent = [];
  const start = deferred();
  const provider = {
    awaitsFinalTranscript: true,
    onPartial: () => () => {},
    onFinal: () => () => {},
    onSessionEnd: () => () => {},
    onFinalized: () => () => {},
    onError: (cb) => {
      handlers.error = cb;
      return () => {};
    },
    onStreamIssue: (cb) => {
      handlers.streamIssue = cb;
      return () => {};
    },
    errorCode,
    send: (data) => sent.push(data),
    start: () => start.promise,
    stop: async () => ({ success: true }),
  };

  let workletNode = null;
  const previousNode = globalThis.AudioWorkletNode;
  globalThis.AudioWorkletNode = class {
    constructor() {
      this.port = { onmessage: null, postMessage() {} };
      workletNode = this;
    }
    connect() {}
    disconnect() {}
  };
  t.after(() => {
    if (previousNode === undefined) delete globalThis.AudioWorkletNode;
    else globalThis.AudioWorkletNode = previousNode;
  });

  const track = { label: "mic", getSettings: () => ({}), stop() {} };
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
  const audioContext = {
    createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
    createAnalyser: () => ({ fftSize: 0 }),
    audioWorklet: { addModule: async () => {} },
  };

  const manager = createManager({
    isRecordingAllowedByPolicy: () => true,
    preparedMicCapture: { take: async () => null },
    getAudioConstraints: async () => ({}),
    _acquireCaptureStream: async () => stream,
    _markCaptureStreamReleased() {},
    startStreamingFallbackRecorder() {},
    getOrCreateAudioContext: async () => audioContext,
    getWorkletBlobUrl: () => "blob:worklet",
    workletModuleLoaded: true,
    getStreamingProvider: () => provider,
    getStreamingProviderName: () => "soniox",
    getEffectiveSttLanguage: () => "en",
    getKeyterms: () => [],
    beginMicRecovery: async () => {},
    micRecovery: { stop() {} },
    streamingCleanupFns: [],
    _streamingStartSettlementWaiters: [],
    _streamingCancellationGeneration: 0,
    onStateChange: (state) => events.stateChanges.push(state),
    onError: (error) => events.errors.push(error),
    onCaptureAudible: () => {
      events.audible += 1;
    },
    onStreamWarning: (warning) => events.warnings.push(warning),
  });
  const stops = [];
  manager.stopStreamingRecording = async () => {
    stops.push("stop");
    return true;
  };

  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());

  const started = manager.startStreamingRecording();
  // Let the async start reach its pending provider.start().
  while (!workletNode) await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  if (startResult) start.resolve(startResult);
  return {
    manager,
    events,
    handlers,
    sent,
    stops,
    started,
    start,
    microphone: (data) => workletNode.port.onmessage({ data }),
  };
}

test("the start cue fires at the first non-zero frame, while the connection is still opening", async (t) => {
  const session = await startSession(t);

  session.microphone(frame(0, 0, 0, 0));
  session.microphone(frame(0, 0, 0, 0));
  assert.equal(session.events.audible, 0, "digital zeros are not a live microphone");

  session.microphone(frame(0, 0, 3, 0));
  assert.equal(session.events.audible, 1);

  session.microphone(frame(5, 5, 5, 5));
  mock.timers.tick(CAPTURE_READY_TIMEOUT_MS);
  assert.equal(session.events.audible, 1, "once per dictation");
  assert.equal(session.sent.length, 4, "audio kept flowing to the provider the whole time");

  session.start.resolve({ success: true });
  assert.equal(await session.started, true);
  assert.equal(session.events.audible, 1, "connecting adds no cue");
});

test("a microphone that only delivers zeros gets its cue after the ceiling", async (t) => {
  const session = await startSession(t);

  session.microphone(frame(0, 0, 0, 0));
  mock.timers.tick(CAPTURE_READY_TIMEOUT_MS - 1);
  assert.equal(session.events.audible, 0);

  mock.timers.tick(1);
  assert.equal(session.events.audible, 1);

  session.microphone(frame(9, 9, 9, 9));
  assert.equal(session.events.audible, 1);
});

test("a dictation that fails before the first frame plays no start cue", async (t) => {
  const session = await startSession(t);

  session.start.resolve({
    success: false,
    error: "Soniox WebSocket connection timeout",
    code: "STREAMING_CONNECTION_FAILED",
  });
  assert.equal(await session.started, false);

  mock.timers.tick(CAPTURE_READY_TIMEOUT_MS);
  assert.equal(session.events.audible, 0);
});

test("frames that arrive after the session ended play no start cue", async (t) => {
  const session = await startSession(t);

  await session.manager.cleanupStreaming();
  session.manager.isStreaming = true;
  mock.timers.tick(CAPTURE_READY_TIMEOUT_MS);

  assert.equal(session.events.audible, 0);
});

test("a connection that fails to open is reported with its own code and message", async (t) => {
  const session = await startSession(t);

  session.start.resolve({
    success: false,
    error: "Soniox WebSocket connection failed: getaddrinfo ENOTFOUND",
    code: "STREAMING_CONNECTION_FAILED",
  });
  assert.equal(await session.started, false);

  assert.equal(session.events.errors.length, 1);
  assert.equal(session.events.errors[0].code, "STREAMING_CONNECTION_FAILED");
  assert.equal(
    session.events.errors[0].messageKey,
    "hooks.audioRecording.streamingConnection.failed.description"
  );
  assert.equal(session.manager.isRecording, false, "the failed dictation is not left recording");
});

test("a start that fails for another reason keeps its own report", async (t) => {
  const session = await startSession(t);

  session.start.resolve({ success: false, error: "Soniox error 401", code: "PROVIDER_AUTH" });
  await session.started;

  assert.equal(session.events.errors.length, 1);
  assert.equal(session.events.errors[0].code, "PROVIDER_AUTH");
  assert.equal(session.events.errors[0].messageKey, undefined);
});

test("a lost connection is reported and ends the dictation, keeping what was transcribed", async (t) => {
  const session = await startSession(t, { startResult: { success: true } });
  assert.equal(await session.started, true);

  session.handlers.streamIssue({
    kind: "connection_lost",
    message: "Connection lost (code: 1006)",
  });

  assert.equal(session.events.errors.length, 1);
  assert.equal(session.events.errors[0].code, "STREAMING_CONNECTION_LOST");
  assert.equal(
    session.events.errors[0].messageKey,
    "hooks.audioRecording.streamingConnection.lost.description"
  );
  assert.deepEqual(session.stops, ["stop"], "the dictation is finalized with the text so far");
});

test("dropped audio is reported as a warning and the recording keeps going", async (t) => {
  const session = await startSession(t);

  session.handlers.streamIssue({ kind: "audio_dropped" });

  assert.deepEqual(session.events.errors, []);
  assert.equal(session.events.warnings.length, 1);
  assert.equal(session.events.warnings[0].code, "STREAMING_AUDIO_DROPPED");
  assert.deepEqual(session.stops, []);
  assert.equal(session.manager.isRecording, true);
});

test("a provider error frame keeps its toast wording, carries the provider's error code, and ends the dictation", async (t) => {
  const session = await startSession(t, {
    startResult: { success: true },
    errorCode: "STREAMING_SESSION_ERROR",
  });
  assert.equal(await session.started, true);

  session.handlers.error("Soniox error 401: invalid api key");

  assert.equal(session.events.errors.length, 1);
  assert.equal(session.events.errors[0].code, "STREAMING_SESSION_ERROR");
  assert.equal(session.events.errors[0].title, "Streaming Error");
  assert.equal(session.events.errors[0].description, "Soniox error 401: invalid api key");
  assert.equal(session.events.errors[0].messageKey, undefined);
  assert.deepEqual(session.stops, ["stop"]);
});

test("the server's close after an error frame, arriving once the stop has finished, is ignored", async (t) => {
  const session = await startSession(t, {
    startResult: { success: true },
    errorCode: "STREAMING_SESSION_ERROR",
  });
  assert.equal(await session.started, true);

  session.handlers.error("Soniox error 402: quota");
  session.manager._activeStreamingSessionId = null;
  session.handlers.streamIssue({
    kind: "connection_lost",
    message: "Connection lost (code: 1006)",
  });

  assert.equal(session.events.errors.length, 1);
  assert.deepEqual(session.stops, ["stop"]);
});

test("a provider without an error code reports its errors as before", async (t) => {
  const session = await startSession(t, { startResult: { success: true } });
  assert.equal(await session.started, true);

  session.handlers.error("boom");

  assert.equal(session.events.errors[0].code, undefined);
});

test("only Soniox's provider entry sounds the error cue for its error frames", async (t) => {
  const { AudioManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-start-cue-table-test-",
    settingsKey: "__startCueTableSettings",
    settings: SETTINGS,
  });
  const providerOf = (name) =>
    AudioManager.prototype.getStreamingProvider.call({ getStreamingProviderName: () => name });

  assert.equal(providerOf("soniox").errorCode, "STREAMING_SESSION_ERROR");
  for (const name of ["deepgram", "assemblyai", "gemini"]) {
    assert.equal(providerOf(name)?.errorCode, undefined, name);
  }
});

test("stream issues from a finished session are ignored", async (t) => {
  const session = await startSession(t);

  session.manager._activeStreamingSessionId = null;
  session.handlers.streamIssue({ kind: "connection_lost", message: "late" });
  session.handlers.streamIssue({ kind: "audio_dropped" });

  assert.deepEqual(session.events.errors, []);
  assert.deepEqual(session.events.warnings, []);
  assert.deepEqual(session.stops, []);
});
