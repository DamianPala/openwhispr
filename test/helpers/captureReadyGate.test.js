const test = require("node:test");
const assert = require("node:assert/strict");
const { mock } = require("node:test");
const {
  CAPTURE_READY_TIMEOUT_MS,
  createCaptureReadyGate,
  hasNonZeroSample,
} = require("../../src/helpers/captureReadyGate");

const pcm = (...samples) => new Int16Array(samples);

function openGate(t, overrides = {}) {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const ready = [];
  const gate = createCaptureReadyGate({
    onReady: (info) => ready.push(info),
    ...overrides,
  });
  return { gate, ready };
}

test("a frame of digital zeros keeps the gate shut", (t) => {
  const { gate, ready } = openGate(t);

  gate.feed(pcm(0, 0, 0, 0));
  gate.feed(pcm(0, 0, 0, 0).buffer);

  assert.deepEqual(ready, []);
});

test("the first frame with any non-zero sample opens it, once", (t) => {
  const { gate, ready } = openGate(t);

  gate.feed(pcm(0, 0, 0, 0));
  gate.feed(pcm(0, 0, -1, 0));
  gate.feed(pcm(7, 7, 7, 7));
  mock.timers.tick(CAPTURE_READY_TIMEOUT_MS);

  assert.equal(ready.length, 1);
  assert.equal(ready[0].reason, "audio");
});

test("an ArrayBuffer straight from the worklet port is read as PCM16", (t) => {
  const { gate, ready } = openGate(t);

  gate.feed(pcm(0, 0, 0, 12).buffer);

  assert.equal(ready.length, 1);
});

test("silence for the whole ceiling still opens it, as a timeout", (t) => {
  const { gate, ready } = openGate(t);

  gate.feed(pcm(0, 0, 0, 0));
  mock.timers.tick(CAPTURE_READY_TIMEOUT_MS - 1);
  assert.deepEqual(ready, []);

  mock.timers.tick(1);
  assert.equal(ready.length, 1);
  assert.equal(ready[0].reason, "timeout");

  gate.feed(pcm(5, 5, 5, 5));
  assert.equal(ready.length, 1, "a late frame does not fire it again");
});

test("a cancelled gate never opens, by frame or by timeout", (t) => {
  const { gate, ready } = openGate(t);

  gate.cancel();
  gate.feed(pcm(9, 9, 9, 9));
  mock.timers.tick(CAPTURE_READY_TIMEOUT_MS * 2);

  assert.deepEqual(ready, []);
});

test("the ceiling is 1,5 s unless a caller picks another", (t) => {
  assert.equal(CAPTURE_READY_TIMEOUT_MS, 1500);
  const { ready } = openGate(t, { timeoutMs: 200 });

  mock.timers.tick(200);

  assert.equal(ready.length, 1);
});

test("hasNonZeroSample tolerates an empty frame and an odd trailing byte", () => {
  assert.equal(hasNonZeroSample(new Int16Array(0)), false);
  assert.equal(hasNonZeroSample(new ArrayBuffer(0)), false);
  assert.equal(hasNonZeroSample(new Uint8Array([0, 0, 0]).buffer), false);
});
