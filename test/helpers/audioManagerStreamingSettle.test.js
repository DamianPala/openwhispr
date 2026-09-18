const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const QUIET_MS = 250;
const CEILING_MS = 2000;
const FLUSH_CEILING_MS = 120;
// setTimeout schedules on the monotonic clock and can fire while the Date.now()
// delta is still ~1ms short of the nominal delay, so lower bounds need slack.
const TIMER_SLACK_MS = 50;

async function loadManager(t) {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-settle-test-",
    mockModules: {
      "/utils/logger":
        "export default { debug() {}, info() {}, warn() {}, error() {}, logReasoning() {} };",
      "/stores/settingsStore": `
        export const getSettings = () => ({});
        export const getEffectiveCleanupModel = () => null;
        export const isCloudCleanupMode = () => false;
        export const isCloudDictationAgentMode = () => false;
        export const isCloudTranslationMode = () => false;
      `,
      "/services/ReasoningService":
        "export default { processText: async (t) => t, cancelAllRequests() {} };",
      "/services/SyncService.js": "export const syncService = {};",
      "/lib/auth": "export const withSessionRefresh = (fn) => fn();",
      "/utils/permissions": "export const isAccessibilitySkipped = () => false;",
    },
  });
  const AudioManager = (await vite.ssrLoadModule("/helpers/audioManager.js")).default;
  return Object.create(AudioManager.prototype);
}

async function elapsed(fn) {
  const start = Date.now();
  await fn();
  return Date.now() - start;
}

test("settles on the quiet window when the transcript is already complete", async (t) => {
  const manager = await loadManager(t);

  const ms = await elapsed(() => manager.awaitStreamingTextSettled());

  assert.ok(ms >= QUIET_MS - TIMER_SLACK_MS, `settled too early: ${ms}ms`);
  assert.ok(ms < QUIET_MS + 150, `settled too late: ${ms}ms`);
});

test("waits out a slow tail instead of expiring on it", async (t) => {
  const manager = await loadManager(t);
  const lateFinalAt = 600;
  manager.streamingPartialText = "the last few words";
  setTimeout(() => {
    manager.streamingPartialText = "";
    manager.streamingTextBump?.();
  }, lateFinalAt);

  const ms = await elapsed(() => manager.awaitStreamingTextSettled());

  assert.ok(ms >= lateFinalAt + QUIET_MS - TIMER_SLACK_MS, `dropped the late tail: ${ms}ms`);
  assert.ok(ms < CEILING_MS, `should settle on quiet, not the ceiling: ${ms}ms`);
});

test("the ceiling bounds a final that never lands", async (t) => {
  const manager = await loadManager(t);
  manager.streamingPartialText = "never finalized";

  const ms = await elapsed(() => manager.awaitStreamingTextSettled());

  assert.ok(ms >= CEILING_MS - TIMER_SLACK_MS, `gave up too early: ${ms}ms`);
  assert.ok(ms < CEILING_MS + 300, `overran the ceiling: ${ms}ms`);
});

test("a provider can widen the ceiling for a slower final", async (t) => {
  const manager = await loadManager(t);
  const providerCeilingMs = 600;
  manager.streamingPartialText = "never finalized";

  const ms = await elapsed(() => manager.awaitStreamingTextSettled(providerCeilingMs));

  assert.ok(ms >= providerCeilingMs - TIMER_SLACK_MS, `ignored the provider ceiling: ${ms}ms`);
  assert.ok(ms < CEILING_MS, `fell back to the default ceiling: ${ms}ms`);
});

test("a provider's finalized marker settles the wait outright, even mid-partial", async (t) => {
  const manager = await loadManager(t);
  const finalizedAt = 40;
  manager.streamingPartialText = "still moving";
  setTimeout(() => manager.streamingFinalizedSettle?.(), finalizedAt);

  const ms = await elapsed(() => manager.awaitStreamingTextSettled());

  assert.ok(ms < QUIET_MS, `waited for the quiet window instead of the marker: ${ms}ms`);
  assert.equal(manager.streamingFinalizedSettle, null);
});

test("tearing down the listeners settles a wait that can no longer move", async (t) => {
  const manager = await loadManager(t);
  manager.streamingCleanupFns = [];
  manager.streamingPartialText = "still moving";
  setTimeout(() => manager.cleanupStreamingListeners(), 40);

  const ms = await elapsed(() => manager.awaitStreamingTextSettled());

  assert.ok(ms < QUIET_MS, `waited for the ceiling after teardown: ${ms}ms`);
  assert.equal(manager.streamingFinalizedSettle, null);
});

test("clears its timers so a settled wait leaves no handles behind", async (t) => {
  const manager = await loadManager(t);

  await manager.awaitStreamingTextSettled();

  assert.equal(manager.streamingTextBump, null);
  assert.equal(manager.streamingTextDebounce, null);
  assert.equal(manager.streamingFinalizedSettle, null);
});

test("a cancel during finalize joins the in-flight stop; the provider is stopped once", async (t) => {
  const manager = await loadManager(t);
  const sessionId = "session-1";
  const stopModes = [];
  const provider = {
    awaitsFinalTranscript: true,
    stop: async () => {
      stopModes.push(manager._streamingStopMode);
    },
  };
  Object.assign(manager, {
    _streamingCancellationGeneration: 0,
    _activeStreamingSessionId: sessionId,
    _streamingStopPromise: null,
    _streamingStopMode: null,
    _streamingMicSwapPromise: null,
    isStreaming: true,
    isRecording: true,
    isProcessing: false,
    streamingStartInProgress: false,
    recordingStartTime: Date.now(),
    streamingCleanupFns: [],
    streamingFallbackRecorder: null,
    streamingFallbackChunks: [],
    _streamingFallbackSegments: [],
    micRecovery: { stop() {} },
    cleanupStreamingAudio: () => {},
    cleanupPreview: async () => {},
    finishStreamingFallbackSegment: async () => null,
    mergeRecordedSegments: async () => null,
    getLargestRecordedSegment: () => null,
    getStreamingProvider: () => provider,
    onStateChange: () => {},
  });

  // The stop owns _streamingStopPromise for its whole run, so a cancel that
  // lands on the text-settle wait only bumps the cancellation generation and
  // returns that same promise; the abandoned finalize issues the one stop.
  const stop = manager.stopStreamingRecording();
  while (!manager.streamingFinalizedSettle) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const inFlight = manager._streamingStopPromise;
  const cancel = manager.cancelStreamingRecording();

  assert.equal(manager._streamingStopMode, "finalize");
  assert.equal(await stop, true);
  assert.equal(await cancel, true);
  assert.equal(await inFlight, true);
  assert.deepEqual(stopModes, ["finalize"], `provider.stop() modes: ${stopModes}`);
  assert.equal(manager._streamingStopPromise, null);
  assert.equal(manager._streamingStopMode, null);
});

// Shared scaffolding for the flush-sentinel tests below: enough state for
// stopStreamingRecording()'s finalize path to run to completion with no
// transcript, real reasoning or IPC. awaitStreamingTextSettled is stubbed out
// because that wait is covered by the tests above; these two isolate the
// flush-ceiling race in step 2 of _finalizeStreamingRecording.
function primeFinalizingManager(manager, processor) {
  Object.assign(manager, {
    _streamingCancellationGeneration: 0,
    _activeStreamingSessionId: "session-1",
    _streamingStopPromise: null,
    _streamingStopMode: null,
    _streamingMicSwapPromise: null,
    isStreaming: true,
    isRecording: true,
    isProcessing: false,
    streamingStartInProgress: false,
    recordingStartTime: Date.now(),
    streamingCleanupFns: [],
    streamingFallbackRecorder: null,
    streamingFallbackChunks: [],
    _streamingFallbackSegments: [],
    streamingProcessor: processor,
    micRecovery: { stop() {} },
    cleanupStreamingAudio: () => {},
    cleanupPreview: async () => {},
    finishStreamingFallbackSegment: async () => null,
    mergeRecordedSegments: async () => null,
    getLargestRecordedSegment: () => null,
    getStreamingProvider: () => ({
      awaitsFinalTranscript: true,
      stop: async () => ({ success: true }),
    }),
    awaitStreamingTextSettled: async () => {},
    onStateChange: () => {},
  });
}

test("a flushed sentinel lets the stop path continue before the ceiling", async (t) => {
  const manager = await loadManager(t);
  let disconnected = false;
  const port = { onmessage: null };
  // A real worklet posts "stop" then trails it with "flushed"; queueMicrotask
  // stands in for that round trip without waiting on real audio hardware.
  port.postMessage = (msg) => {
    if (msg === "stop") queueMicrotask(() => port.onmessage?.({ data: "flushed" }));
  };
  const processor = {
    port,
    disconnect: () => {
      disconnected = true;
    },
  };
  primeFinalizingManager(manager, processor);
  // Wired the same way startStreamingRecording wires the real handler, so the
  // fake port's reply exercises the actual _streamingFlushResolve() call.
  port.onmessage = (event) => {
    if (event.data === "flushed") manager._streamingFlushResolve?.();
  };

  const ms = await elapsed(() => manager.stopStreamingRecording());

  assert.ok(disconnected, "processor should have been disconnected");
  assert.ok(ms < FLUSH_CEILING_MS - TIMER_SLACK_MS, `waited for the ceiling instead: ${ms}ms`);
});

test("the ceiling still fires when the sentinel never arrives", async (t) => {
  const manager = await loadManager(t);
  const processor = { port: { postMessage: () => {} }, disconnect: () => {} };
  primeFinalizingManager(manager, processor);

  const ms = await elapsed(() => manager.stopStreamingRecording());

  assert.ok(ms >= FLUSH_CEILING_MS - TIMER_SLACK_MS, `gave up too early: ${ms}ms`);
  assert.ok(ms < FLUSH_CEILING_MS + 300, `overran the ceiling: ${ms}ms`);
});
