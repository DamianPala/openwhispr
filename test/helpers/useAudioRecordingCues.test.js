const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// The scripted AudioManager: startStreamingRecording() stays pending until the
// test resolves it, so a test can fire the capture and failure callbacks at the
// moments the real manager would (mid-connect, after connect, after a drop).
const FAKE_AUDIO_MANAGER_SOURCE = `
export default class FakeAudioManager {
  constructor() {
    this.voiceAgentRequested = false;
    this.translationRequested = false;
    this.sttConfig = { success: true };
    globalThis.__cueHarness.manager = this;
  }
  getState() {
    return globalThis.__cueHarness.state;
  }
  setCallbacks(callbacks) {
    globalThis.__cueHarness.callbacks = callbacks;
  }
  setVoiceAgentRequested(value) {
    this.voiceAgentRequested = value;
  }
  setAssistantSelectionContext() {}
  setTranslationRequested(value) {
    this.translationRequested = value;
  }
  shouldUseStreaming() {
    return globalThis.__cueHarness.streaming;
  }
  isSttConfigStale() {
    return false;
  }
  prepareMicCapture() {}
  cancelPreparedMicCapture() {}
  cleanup() {}
  async startStreamingRecording() {
    return globalThis.__cueHarness.pendingStart;
  }
  async startRecording() {
    globalThis.__cueHarness.state = { isRecording: true, isStreaming: false };
    return true;
  }
  async stopStreamingRecording() {
    return true;
  }
}
`;

const CUES_SOURCE = `
export const playStartCue = () => globalThis.__cueHarness.cues.push("start");
export const playStopCue = () => globalThis.__cueHarness.cues.push("stop");
export const playErrorCue = () => globalThis.__cueHarness.cues.push("error");
`;

async function mountHook(t) {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  t.after(() => {
    delete globalThis.__cueHarness;
  });

  const harness = {
    cues: [],
    toasts: [],
    callbacks: null,
    state: { isRecording: false, isStreaming: false },
    streaming: true,
    pendingStart: null,
  };
  globalThis.__cueHarness = harness;

  const noopDispose = () => () => {};
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        onToggleDictation: noopDispose,
        onToggleVoiceAgent: noopDispose,
        onToggleTranslation: noopDispose,
        onStartDictation: noopDispose,
        onPrepareDictation: noopDispose,
        onCancelDictationPreparation: noopDispose,
        onStopDictation: noopDispose,
        dictationLifecycleStateChanged: () => {},
        registerCancelHotkey: () => {},
        unregisterCancelHotkey: () => {},
      },
    },
  });
  const container = installHookDom(t);
  globalThis.requestAnimationFrame = (callback) => {
    callback();
    return 1;
  };

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-audio-recording-cues-",
    mockModules: {
      "/helpers/audioManager": FAKE_AUDIO_MANAGER_SOURCE,
      "/utils/dictationCues": CUES_SOURCE,
    },
  });
  const { useAudioRecording } = await vite.ssrLoadModule("/hooks/useAudioRecording.js");

  let api;
  function Harness() {
    api = useAudioRecording((toast) => harness.toasts.push(toast), { onDemoEvent: () => {} });
    return null;
  }
  root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(Harness));
  });

  // Starts a streaming dictation whose connect() is still pending.
  const startStreaming = async () => {
    let resolveStart;
    harness.pendingStart = new Promise((resolve) => (resolveStart = resolve));
    harness.state = { isRecording: false, isStreaming: false };
    let started;
    await React.act(async () => {
      started = api.startRecording();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // The real manager is recording and streaming while connect() is pending.
    harness.state = { isRecording: true, isStreaming: true };
    return {
      connect: async (ok = true) => {
        await React.act(async () => {
          resolveStart(ok);
          await started;
        });
      },
    };
  };

  return { harness, api: () => api, startStreaming };
}

const fire = (harness, name, ...args) => harness.callbacks[name](...args);

test("a streaming dictation sounds its start cue at the first captured audio, before the connection is up", async (t) => {
  const { harness, startStreaming } = await mountHook(t);
  const start = await startStreaming();

  assert.deepEqual(harness.cues, [], "nothing plays before the microphone delivers audio");
  fire(harness, "onCaptureAudible");
  assert.deepEqual(harness.cues, ["start"], "the cue does not wait for connect()");

  await start.connect();
  assert.deepEqual(harness.cues, ["start"], "the finished start adds no second cue");
});

test("a repeated capture signal still sounds one start cue", async (t) => {
  const { harness, startStreaming } = await mountHook(t);
  const start = await startStreaming();

  fire(harness, "onCaptureAudible");
  fire(harness, "onCaptureAudible");
  await start.connect();

  assert.deepEqual(harness.cues, ["start"]);
});

test("a batch recording sounds its start cue once the recorder has started", async (t) => {
  const { harness, api } = await mountHook(t);
  harness.streaming = false;

  await React.act(async () => {
    await api().startRecording();
  });

  assert.deepEqual(harness.cues, ["start"]);
});

test("a connection that never opens sounds the error cue and no start cue", async (t) => {
  const { harness, startStreaming } = await mountHook(t);
  const start = await startStreaming();

  fire(harness, "onError", {
    code: "STREAMING_CONNECTION_FAILED",
    title: "Connection Failed",
    messageKey: "hooks.audioRecording.streamingConnection.failed.description",
  });
  harness.state = { isRecording: false, isStreaming: false };
  await start.connect(false);
  fire(harness, "onCaptureAudible");

  assert.deepEqual(harness.cues, ["error"]);
  assert.equal(harness.toasts.length, 1, "the failure is also shown");
});

test("a connection lost after the start cue sounds the error cue once, however many failures follow", async (t) => {
  const { harness, startStreaming } = await mountHook(t);
  const start = await startStreaming();
  fire(harness, "onCaptureAudible");
  await start.connect();

  fire(harness, "onError", { code: "STREAMING_CONNECTION_LOST", title: "Connection Lost" });
  fire(harness, "onError", { code: "STREAMING_CONNECTION_LOST", title: "Connection Lost" });
  fire(harness, "onStreamWarning", { code: "STREAMING_AUDIO_DROPPED" });

  assert.deepEqual(harness.cues, ["start", "error"]);
});

test("a server error frame sounds one error cue, keeps its toast wording, and the close that follows adds nothing", async (t) => {
  const { harness, startStreaming } = await mountHook(t);
  const start = await startStreaming();
  await start.connect();

  fire(harness, "onError", {
    code: "STREAMING_SESSION_ERROR",
    title: "Streaming Error",
    description: "Soniox error 401: invalid api key",
  });
  fire(harness, "onError", { code: "STREAMING_CONNECTION_LOST", title: "Connection Lost" });

  assert.deepEqual(harness.cues, ["error"], "no start cue had played, and only one error cue");
  assert.equal(harness.toasts[0].title, "Streaming Error");
  assert.equal(harness.toasts[0].description, "Soniox error 401: invalid api key");
});

test("a server error frame after the start cue follows it with one error cue", async (t) => {
  const { harness, startStreaming } = await mountHook(t);
  const start = await startStreaming();
  fire(harness, "onCaptureAudible");
  await start.connect();

  fire(harness, "onError", {
    code: "STREAMING_SESSION_ERROR",
    title: "Streaming Error",
    description: "Soniox error 402: quota",
  });
  fire(harness, "onStreamWarning", { code: "STREAMING_AUDIO_DROPPED" });

  assert.deepEqual(harness.cues, ["start", "error"]);
});

test("dropped audio sounds the error cue and shows a notice without ending the dictation", async (t) => {
  const { harness, startStreaming } = await mountHook(t);
  const start = await startStreaming();
  fire(harness, "onCaptureAudible");

  fire(harness, "onStreamWarning", {
    code: "STREAMING_AUDIO_DROPPED",
    messageKey: "hooks.audioRecording.streamingConnection.audioDropped.description",
  });
  await start.connect();

  assert.deepEqual(harness.cues, ["start", "error"]);
  assert.equal(harness.toasts.length, 1);
  assert.equal(harness.toasts[0].variant, "default");
});

test("other provider errors do not sound the connection error cue", async (t) => {
  const { harness, startStreaming } = await mountHook(t);
  const start = await startStreaming();
  fire(harness, "onCaptureAudible");
  await start.connect();

  fire(harness, "onError", { code: "AUTH_EXPIRED", title: "Session expired" });
  fire(harness, "onError", { title: "Streaming Error", description: "boom" });

  assert.deepEqual(harness.cues, ["start"]);
});

test("a retry is a new dictation with its own cues", async (t) => {
  const { harness, startStreaming } = await mountHook(t);
  let start = await startStreaming();
  fire(harness, "onCaptureAudible");
  await start.connect();
  fire(harness, "onError", { code: "STREAMING_CONNECTION_LOST", title: "Connection Lost" });
  harness.state = { isRecording: false, isStreaming: false };

  start = await startStreaming();
  fire(harness, "onCaptureAudible");
  await start.connect();
  fire(harness, "onError", { code: "STREAMING_CONNECTION_LOST", title: "Connection Lost" });

  assert.deepEqual(harness.cues, ["start", "error", "start", "error"]);
});

test("a release that landed during the start suppresses the start cue", async (t) => {
  const { harness, api, startStreaming } = await mountHook(t);
  const start = await startStreaming();

  await React.act(async () => {
    await api().stopRecording();
  });
  fire(harness, "onCaptureAudible");
  await start.connect();

  assert.equal(harness.cues.includes("start"), false, JSON.stringify(harness.cues));
});
