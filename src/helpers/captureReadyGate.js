// Bluetooth headsets switching to the hands-free profile deliver digital zeros
// before the microphone is really live, so "the stream is open" does not mean
// "the user can start talking". The gate opens at the first captured frame that
// holds any non-zero sample, or after a ceiling so a genuinely silent room
// still gets its cue.
export const CAPTURE_READY_TIMEOUT_MS = 1500;

export function hasNonZeroSample(frame) {
  const samples = ArrayBuffer.isView(frame)
    ? frame
    : new Int16Array(frame, 0, frame.byteLength >> 1);
  for (let index = 0; index < samples.length; index++) {
    if (samples[index] !== 0) return true;
  }
  return false;
}

// onReady fires once with { reason: "audio" | "timeout", elapsedMs }. feed() takes
// PCM16 frames in capture order; cancel() makes the gate silent for good.
export function createCaptureReadyGate({
  onReady,
  timeoutMs = CAPTURE_READY_TIMEOUT_MS,
  now = () => performance.now(),
}) {
  const startedAt = now();
  let settled = false;
  let timer = null;

  const settle = (reason) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    onReady({ reason, elapsedMs: Math.round(now() - startedAt) });
  };

  timer = setTimeout(() => settle("timeout"), timeoutMs);

  return {
    feed(frame) {
      if (settled) return;
      if (hasNonZeroSample(frame)) settle("audio");
    },
    cancel() {
      settled = true;
      clearTimeout(timer);
    },
  };
}
