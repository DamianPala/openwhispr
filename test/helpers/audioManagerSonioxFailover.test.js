const test = require("node:test");
const assert = require("node:assert/strict");
const { mock } = require("node:test");
const { loadAudioManager } = require("./harness/audioManager");
const { deferred } = require("./harness/deferred");

const SETTINGS = {
  useLocalWhisper: false,
  transcriptionMode: "providers",
  cloudTranscriptionMode: "byok",
  cloudTranscriptionProvider: "soniox",
  cloudTranscriptionModel: "stt-rt-v5",
  sonioxApiKey: "key",
  sonioxRegion: "eu",
  sonioxExtraLanguages: ["en"],
  sonioxRemoveFillers: false,
  isSignedIn: false,
};

const FAILOVER_KEY = (kind) =>
  `hooks.audioRecording.streamingConnection.failover.${kind}.description`;

const mockModules = {
  // The WAV copy the invalid-audio retry sends; the real one needs an AudioContext.
  "/utils/audioContainer": `
    export const needsWavConversion = () => false;
    export const convertToWav = async () =>
      new Blob(["wav-bytes"], { type: "audio/wav" });
  `,
};

const frame = (...samples) => new Int16Array(samples).buffer;

// A streaming start driven against fakes, as in the start-cue suite, but with a
// fallback recorder holding the capture (which is what makes failover possible).
async function startSession(t, { providerName = "soniox", recorder = true, startResult } = {}) {
  const { createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-soniox-failover-test-",
    settingsKey: "__sonioxFailoverSettings",
    settings: SETTINGS,
    mockModules,
  });

  const events = { errors: [], warnings: [], stateChanges: [] };
  const handlers = {};
  const sent = [];
  const start = deferred();
  const provider = {
    awaitsFinalTranscript: true,
    onPartial: () => () => {},
    onFinal: () => () => {},
    onSessionEnd: () => () => {},
    onFinalized: () => () => {},
    onError: () => () => {},
    onStreamIssue: (cb) => {
      handlers.streamIssue = cb;
      return () => {};
    },
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
    startStreamingFallbackRecorder() {
      this.streamingFallbackRecorder = recorder ? { state: "recording" } : null;
    },
    getOrCreateAudioContext: async () => audioContext,
    getWorkletBlobUrl: () => "blob:worklet",
    workletModuleLoaded: true,
    getStreamingProvider: () => provider,
    getStreamingProviderName: () => providerName,
    getEffectiveSttLanguage: () => "en",
    getKeyterms: () => [],
    beginMicRecovery: async () => {},
    micRecovery: { stop() {} },
    streamingCleanupFns: [],
    _streamingStartSettlementWaiters: [],
    _streamingCancellationGeneration: 0,
    onStateChange: (state) => events.stateChanges.push(state),
    onError: (error) => events.errors.push(error),
    onCaptureAudible() {},
    onStreamWarning: (warning) => events.warnings.push(warning),
  });
  const stops = [];
  manager.stopStreamingRecording = async () => {
    stops.push("stop");
    return true;
  };
  let cleanups = 0;
  const cleanupStreaming = manager.cleanupStreaming;
  manager.cleanupStreaming = async function () {
    cleanups += 1;
    return cleanupStreaming.call(this);
  };

  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());

  const started = manager.startStreamingRecording();
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
    cleanups: () => cleanups,
    microphone: (data) => workletNode.port.onmessage({ data }),
  };
}

const CONNECTION_FAILED = {
  success: false,
  error: "Soniox WebSocket connection timeout",
  code: "STREAMING_CONNECTION_FAILED",
};

test("a socket that never opens keeps the recording and promises a transcription after stop", async (t) => {
  const session = await startSession(t);

  session.microphone(frame(1, 2, 3, 4));
  session.start.resolve(CONNECTION_FAILED);
  assert.equal(await session.started, true, "the dictation goes on");

  assert.deepEqual(session.events.errors, [], "no failure toast, the user can keep talking");
  assert.deepEqual(session.events.warnings, [
    { code: "STREAMING_CONNECTION_FAILED", messageKey: FAILOVER_KEY("failed") },
  ]);
  assert.equal(session.manager.isRecording, true);
  assert.equal(session.manager.isStreaming, true);
  assert.equal(session.cleanups(), 0, "the capture is not torn down");
  assert.equal(session.manager._streamingFailoverReason, "stream_connection_failed");

  const before = session.sent.length;
  session.microphone(frame(5, 6, 7, 8));
  assert.equal(session.sent.length, before, "a dead stream is not fed any more");
  assert.deepEqual(session.stops, []);
});

test("a release that landed during a failed start stops the kept recording", async (t) => {
  const session = await startSession(t);
  session.manager.stopRequestedDuringStreamingStart = true;

  session.start.resolve(CONNECTION_FAILED);
  assert.equal(await session.started, true);

  assert.deepEqual(session.stops, ["stop"]);
  assert.deepEqual(session.events.warnings, [], "the user has stopped, so no 'keep talking'");
  assert.equal(session.manager._streamingFailoverReason, "stream_connection_failed");
});

test("a drop while the stop is finalizing is marked but not announced", async (t) => {
  const session = await startSession(t, { startResult: { success: true } });
  assert.equal(await session.started, true);
  session.manager.isProcessing = true;

  session.handlers.streamIssue({ kind: "connection_lost", message: "Connection lost" });

  assert.deepEqual(session.events.warnings, []);
  assert.deepEqual(session.events.errors, []);
  assert.equal(session.manager._streamingFailoverReason, "stream_connection_lost");
});

test("without a fallback recorder a failed start is still a failed dictation", async (t) => {
  const session = await startSession(t, { recorder: false });

  session.start.resolve(CONNECTION_FAILED);
  assert.equal(await session.started, false);

  assert.equal(session.events.errors.length, 1);
  assert.deepEqual(session.events.warnings, []);
  assert.equal(session.manager.isRecording, false);
});

test("another start failure is not failed over", async (t) => {
  const session = await startSession(t);

  session.start.resolve({
    success: false,
    error: "Soniox API key missing",
    code: "API_KEY_MISSING",
  });
  assert.equal(await session.started, false);

  assert.equal(session.events.errors.length, 1);
  assert.deepEqual(session.events.warnings, []);
});

test("a dropped connection no longer ends the dictation", async (t) => {
  const session = await startSession(t, { startResult: { success: true } });
  assert.equal(await session.started, true);

  session.handlers.streamIssue({
    kind: "connection_lost",
    message: "Connection lost (code: 1006)",
  });

  assert.deepEqual(session.events.errors, []);
  assert.deepEqual(session.events.warnings, [
    { code: "STREAMING_CONNECTION_LOST", messageKey: FAILOVER_KEY("lost") },
  ]);
  assert.deepEqual(session.stops, [], "no auto-stop, the user may keep talking");
  assert.equal(session.manager.isRecording, true);

  const before = session.sent.length;
  session.microphone(frame(1, 2, 3, 4));
  assert.equal(session.sent.length, before);
});

test("dropped opening audio keeps the live stream and marks the dictation for a full transcription", async (t) => {
  const session = await startSession(t, { startResult: { success: true } });
  assert.equal(await session.started, true);

  session.handlers.streamIssue({ kind: "audio_dropped" });

  assert.deepEqual(session.events.warnings, [
    { code: "STREAMING_AUDIO_DROPPED", messageKey: FAILOVER_KEY("audioDropped") },
  ]);
  assert.equal(session.manager._streamingFailoverReason, "stream_audio_dropped");
  const before = session.sent.length;
  session.microphone(frame(1, 2, 3, 4));
  assert.equal(session.sent.length, before + 1, "the socket works, so the live text goes on");

  session.handlers.streamIssue({ kind: "connection_lost", message: "later" });
  assert.equal(session.events.warnings.length, 1, "one notice per dictation");
  assert.equal(session.manager._streamingFailoverReason, "stream_connection_lost");
  session.microphone(frame(1, 2, 3, 4));
  assert.equal(session.sent.length, before + 1, "once the stream dies it is not fed");
});

test("other providers keep ending the dictation on a lost connection", async (t) => {
  const session = await startSession(t, {
    providerName: "deepgram",
    startResult: { success: true },
  });
  assert.equal(await session.started, true);

  session.handlers.streamIssue({ kind: "connection_lost", message: "Connection lost" });

  assert.equal(session.events.errors.length, 1);
  assert.deepEqual(session.events.warnings, []);
  assert.deepEqual(session.stops, ["stop"]);
});

// --- after stop -------------------------------------------------------------

async function createStoppingManager(t, overrides = {}) {
  const { AudioManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-soniox-failover-stop-test-",
    settingsKey: "__sonioxFailoverStopSettings",
    settings: SETTINGS,
    mockModules,
  });
  globalThis.window.dispatchEvent = () => true;

  const recording = new Blob(["recorded-opus"], { type: "audio/webm;codecs=opus" });
  const events = { completions: [], errors: [], warnings: [], states: [], saved: [] };
  const manager = Object.assign(Object.create(AudioManager.prototype), {
    isRecording: true,
    isProcessing: false,
    isStreaming: true,
    streamingStartInProgress: false,
    _streamingStartSettlementWaiters: [],
    stopRequestedDuringStreamingStart: false,
    recordingStartTime: Date.now() - 12000,
    _streamingStopPromise: null,
    _streamingStopMode: null,
    _streamingCancellationGeneration: 0,
    _activeTranscriptionAbortController: null,
    _streamingSessionGeneration: 3,
    _activeStreamingSessionId: 3,
    _streamingMicSwapPromise: null,
    _streamingFailoverReason: "stream_connection_lost",
    streamingFinalText: "text with a gap",
    streamingPartialText: "",
    streamingCleanupFns: [],
    streamingProcessor: null,
    streamingSource: null,
    streamingFallbackRecorder: null,
    streamingFallbackChunks: [],
    _streamingFallbackSegments: [],
    pendingAssistantConversation: null,
    pendingSelectionEdit: null,
    micRecovery: { stop() {} },
    finishStreamingFallbackSegment: async () => null,
    mergeRecordedSegments: async () => recording,
    getLargestRecordedSegment: () => null,
    awaitStreamingTextSettled: async () => {},
    getStreamingProvider: () => ({
      awaitsFinalTranscript: true,
      finalize() {},
      stop: async () => ({ success: true, text: "text with a gap" }),
    }),
    getStreamingProviderName: () => "soniox",
    getEffectiveSttLanguage: () => "pl",
    getKeyterms: () => ["Soniox"],
    processTranscription: async (text) => text,
    isReasoningAvailable: async () => false,
    finalizeChineseScript: async (text) => text,
    saveFailedTranscription: (...args) => events.saved.push(args),
    shouldUseStreaming: () => false,
    isRecordingAllowedByPolicy: () => true,
    onStateChange: (state) => events.states.push(state),
    onTranscriptionComplete: (result) => events.completions.push(result),
    onError: (error) => events.errors.push(error),
    onStreamWarning: (warning) => events.warnings.push(warning),
    ...overrides,
  });
  return { manager, events, recording };
}

// A dictation whose stream never produced any text.
const NO_STREAMED_TEXT = {
  streamingFinalText: "",
  getStreamingProvider: () => ({
    awaitsFinalTranscript: true,
    finalize() {},
    stop: async () => ({ success: true }),
  }),
};

const TIMEOUT_RESULT = {
  error: "Soniox took too long to respond.",
  code: "PROVIDER_TIMEOUT",
  messageKey: "providerErrors.timeout",
  messageParams: { provider: "Soniox" },
  surface: "transcription",
};

test("after stop the whole recording is transcribed through Soniox and replaces the streamed text", async (t) => {
  const { manager, events, recording } = await createStoppingManager(t);
  const requests = [];
  globalThis.window.electronAPI.sonioxAsyncTranscribe = async (request) => {
    requests.push(request);
    return { success: true, text: "the whole dictation", model: "stt-async-v5" };
  };

  assert.equal(await manager.stopStreamingRecording(), true);

  assert.equal(requests.length, 1);
  const [request] = requests;
  assert.equal(request.mimeType, "audio/webm;codecs=opus");
  assert.equal(request.audioBuffer.byteLength, recording.size);
  assert.equal(request.language, "pl");
  assert.deepEqual(request.extraLanguages, ["en"]);
  assert.equal(request.region, "eu");
  assert.deepEqual(request.keyterms, ["Soniox"]);
  assert.equal(request.removeFillers, false);
  assert.ok(request.durationMs >= 11000 && request.durationMs <= 14000);

  assert.equal(events.completions.length, 1);
  assert.equal(events.completions[0].text, "the whole dictation");
  assert.equal(events.completions[0].source, "soniox-async");
  assert.equal(events.completions[0].rawText, "the whole dictation");
  assert.deepEqual(events.errors, []);
  assert.equal(manager.isProcessing, false);
});

test("the pill stays processing until the transcription arrives", async (t) => {
  const { manager, events } = await createStoppingManager(t);
  const answer = deferred();
  globalThis.window.electronAPI.sonioxAsyncTranscribe = () => answer.promise;

  const stopping = manager.stopStreamingRecording();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.isProcessing, true);
  assert.deepEqual(events.completions, []);

  answer.resolve({ success: true, text: "late but whole" });
  await stopping;
  assert.equal(events.completions[0].text, "late but whole");
  assert.equal(manager.isProcessing, false);
});

test("a failed transcription with no streamed text pastes nothing, keeps the audio and says so, without another cue", async (t) => {
  const { manager, events } = await createStoppingManager(t, NO_STREAMED_TEXT);
  globalThis.window.electronAPI.sonioxAsyncTranscribe = async () => TIMEOUT_RESULT;

  await manager.stopStreamingRecording();

  assert.deepEqual(events.completions, []);
  assert.equal(events.errors.length, 1);
  assert.equal(events.errors[0].code, "PROVIDER_TIMEOUT", "not a connection code, so no cue");
  assert.equal(events.errors[0].messageKey, FAILOVER_KEY("transcriptionFailed"));
  assert.equal(events.saved.length, 1, "the recording is kept for History");
  assert.deepEqual(events.warnings, []);
  assert.equal(manager.isProcessing, false);
});

test("a failed transcription pastes the streamed text with a warning and keeps the recording", async (t) => {
  const processed = [];
  const { manager, events } = await createStoppingManager(t, {
    processTranscription: async (text, source) => {
      processed.push([text, source]);
      return `cleaned ${text}`;
    },
  });
  globalThis.window.electronAPI.sonioxAsyncTranscribe = async () => TIMEOUT_RESULT;

  await manager.stopStreamingRecording();

  assert.deepEqual(processed, [["text with a gap", "soniox-streaming"]]);
  assert.equal(events.completions.length, 1);
  assert.equal(events.completions[0].text, "cleaned text with a gap");
  assert.equal(events.completions[0].rawText, "text with a gap");
  assert.equal(events.completions[0].source, "soniox-streaming");
  assert.deepEqual(events.warnings, [
    {
      code: "STREAMING_FAILOVER_STREAMED_TEXT",
      messageKey: FAILOVER_KEY("streamedTextPasted"),
    },
  ]);
  assert.deepEqual(events.errors, [], "no error toast, the text is on screen");
  assert.deepEqual(events.saved, [], "History keeps the whole recording with the pasted text");
  assert.equal(manager.isProcessing, false);
});

test("streamed text is pasted when the speech gate skips the upload", async (t) => {
  const { manager, events } = await createStoppingManager(t, {
    _streamingSpeechGateState: {
      peakRms: 0,
      peakAmplitude: 0,
      windowCount: 4,
      speechWindowCount: 0,
      consecutiveSpeechWindows: 0,
      maxConsecutiveSpeechWindows: 0,
    },
  });
  let uploads = 0;
  globalThis.window.electronAPI.sonioxAsyncTranscribe = async () => {
    uploads += 1;
    return { success: true, text: "never" };
  };

  await manager.stopStreamingRecording();

  assert.equal(uploads, 0);
  assert.equal(events.completions.length, 1);
  assert.equal(events.completions[0].text, "text with a gap");
  assert.equal(events.completions[0].source, "soniox-streaming");
  assert.equal(events.warnings.length, 1);
  assert.deepEqual(events.errors, []);
});

test("cancelling during the transcription pastes nothing and says nothing", async (t) => {
  const { manager, events } = await createStoppingManager(t);
  const answer = deferred();
  globalThis.window.electronAPI.sonioxAsyncTranscribe = () => answer.promise;
  globalThis.window.electronAPI.cancelSonioxAsync = () => {};

  const stopping = manager.stopStreamingRecording();
  await new Promise((resolve) => setImmediate(resolve));
  manager._requestStreamingCancellation();
  answer.resolve({ error: "Transcription cancelled", name: "AbortError" });
  await stopping;

  assert.deepEqual(events.completions, []);
  assert.deepEqual(events.errors, []);
  assert.deepEqual(events.warnings, []);
  assert.deepEqual(events.saved, []);
});

test("a stream that died at stop does not make the stop wait for a final", async (t) => {
  let waits = 0;
  const { manager } = await createStoppingManager(t, {
    awaitStreamingTextSettled: async () => {
      waits += 1;
    },
  });
  globalThis.window.electronAPI.sonioxAsyncTranscribe = async () => ({ success: true, text: "x" });

  await manager.stopStreamingRecording();
  assert.equal(waits, 0, "connection_lost: no final can come");

  const live = await createStoppingManager(t, {
    _streamingFailoverReason: "stream_audio_dropped",
    awaitStreamingTextSettled: async () => {
      waits += 1;
    },
  });
  await live.manager.stopStreamingRecording();
  assert.equal(waits, 1, "dropped opening audio leaves a working socket, so stop still waits");
});

test("a recording with no speech ends quietly and stays in History", async (t) => {
  const { manager, events } = await createStoppingManager(t);
  globalThis.window.electronAPI.sonioxAsyncTranscribe = async () => ({ success: true, text: "  " });

  await manager.stopStreamingRecording();

  assert.deepEqual(events.errors, []);
  assert.equal(events.saved.length, 1);
  assert.deepEqual(events.completions, [{ success: true, text: "" }]);
});

test("audio Soniox cannot read is sent once more as WAV", async (t) => {
  const { manager, events } = await createStoppingManager(t);
  const types = [];
  globalThis.window.electronAPI.sonioxAsyncTranscribe = async (request) => {
    types.push(request.mimeType);
    return types.length === 1
      ? {
          error: "bad audio",
          code: "PROVIDER_INVALID_AUDIO",
          messageKey: "providerErrors.badRequest",
        }
      : { success: true, text: "from the wav copy" };
  };

  await manager.stopStreamingRecording();

  assert.deepEqual(types, ["audio/webm;codecs=opus", "audio/wav"]);
  assert.equal(events.completions[0].text, "from the wav copy");
  assert.deepEqual(events.errors, []);
});

test("a WAV copy that is refused too is not retried again", async (t) => {
  const { manager, events } = await createStoppingManager(t, NO_STREAMED_TEXT);
  let calls = 0;
  globalThis.window.electronAPI.sonioxAsyncTranscribe = async () => {
    calls += 1;
    return { error: "bad audio", code: "PROVIDER_INVALID_AUDIO" };
  };

  await manager.stopStreamingRecording();

  assert.equal(calls, 2);
  assert.equal(events.errors.length, 1);
});

test("a dictation without a failover is not sent to the file API", async (t) => {
  const { manager, events } = await createStoppingManager(t, { _streamingFailoverReason: null });
  let called = false;
  globalThis.window.electronAPI.sonioxAsyncTranscribe = async () => {
    called = true;
    return { success: true, text: "never" };
  };

  await manager.stopStreamingRecording();

  assert.equal(called, false);
  assert.equal(events.completions[0].text, "text with a gap");
});

test("cancelling a dictation also cancels the file API request", async (t) => {
  const { manager } = await createStoppingManager(t);
  let cancels = 0;
  globalThis.window.electronAPI.cancelSonioxAsync = () => {
    cancels += 1;
  };

  manager._requestStreamingCancellation();

  assert.equal(cancels, 1);
});
