const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// Records every oscillator a cue schedules, with the gain envelope wired to it.
class FakeAudioContext {
  constructor() {
    this.state = "running";
    this.currentTime = 10;
    this.destination = {};
    this.tones = [];
    this.periodicWaves = [];
  }
  resume() {
    this.state = "running";
    return Promise.resolve();
  }
  createPeriodicWave(real, imag, options) {
    const wave = { real: Array.from(real), imag: Array.from(imag), options };
    this.periodicWaves.push(wave);
    return wave;
  }
  createOscillator() {
    const tone = { type: "sine", wave: null, frequency: null, start: null, stop: null };
    this.tones.push(tone);
    return {
      set type(value) {
        tone.type = value;
      },
      setPeriodicWave: (wave) => {
        tone.wave = wave;
      },
      frequency: {
        setValueAtTime: (value) => {
          tone.frequency = value;
        },
      },
      connect: () => {},
      start: (time) => {
        tone.start = time;
      },
      stop: (time) => {
        tone.stop = time;
      },
    };
  }
  createGain() {
    const ramps = [];
    const node = {
      gain: {
        setValueAtTime: () => {},
        setTargetAtTime: (value, time, timeConstant) =>
          ramps.push({ kind: "target", value, time, timeConstant }),
        linearRampToValueAtTime: (value, time) => ramps.push({ kind: "attack", value, time }),
        exponentialRampToValueAtTime: (value, time) => ramps.push({ kind: "decay", value, time }),
      },
      connect: () => {},
    };
    const tone = this.tones.at(-1);
    tone.ramps = ramps;
    return node;
  }
}

async function loadCues(t, { enabled = true } = {}) {
  const { window } = installBrowserGlobals(t);
  const contexts = [];
  window.AudioContext = function () {
    const context = new FakeAudioContext();
    contexts.push(context);
    return context;
  };
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-dictation-cues-test-",
    mockModules: {
      "/utils/logger": "export default { debug() {}, info() {}, warn() {}, error() {} };",
      "/stores/settingsStore": `export const getSettings = () => ({ audioCuesEnabled: ${enabled} });`,
    },
  });
  const cues = await vite.ssrLoadModule("/utils/dictationCues.js");
  return { cues, contexts };
}

const near = (actual, expected) => Math.abs(actual - expected) < 1e-9;

test("the error cue is two taps, each a 220 Hz soft square under a 440 Hz triangle", async (t) => {
  const { cues, contexts } = await loadCues(t);

  await cues.playErrorCue();

  const { tones } = contexts[0];
  assert.equal(tones.length, 4, "two taps of two layers");
  const [tapOneLow, tapOneHigh, tapTwoLow, tapTwoHigh] = tones;
  assert.equal(tapOneLow.frequency, 220);
  assert.notEqual(tapOneLow.wave, null, "the low layer is a periodic wave, not a sine");
  assert.equal(tapOneHigh.frequency, 440);
  assert.equal(tapOneHigh.type, "triangle");
  assert.equal(tapTwoLow.frequency, 220, "same pitch both times");
  assert.equal(tapTwoHigh.frequency, 440);
  assert.ok(near(tapOneLow.start, tapOneHigh.start), "the layers sound together");
  assert.ok(near(tapTwoLow.start - tapOneLow.start, 0.09 + 0.07), "90 ms note, 70 ms gap");
});

test("the soft square carries odd harmonics 1, 3, 5, 7 at 0,8/h, unnormalized", async (t) => {
  const { cues, contexts } = await loadCues(t);

  await cues.playErrorCue();

  const [wave] = contexts[0].periodicWaves;
  assert.deepEqual(
    wave.real.every((value) => value === 0),
    true
  );
  assert.deepEqual(
    wave.imag,
    [0, 1, 0, 1 / 3, 0, 1 / 5, 0, 1 / 7].map((value) => Math.fround(0.8 * value))
  );
  assert.deepEqual(wave.options, { disableNormalization: true });
  assert.equal(contexts[0].periodicWaves.length, 1, "built once for both taps");
});

test("each error layer attacks in 15 ms to its own gain, then falls as exp(-5t/duration)", async (t) => {
  const { cues, contexts } = await loadCues(t);

  await cues.playErrorCue();

  const [low, high] = contexts[0].tones;
  const ramp = (tone, kind) => tone.ramps.find((entry) => entry.kind === kind);
  assert.equal(ramp(low, "attack").value, 0.3);
  assert.equal(ramp(high, "attack").value, 0.25);
  assert.ok(near(ramp(low, "attack").time - low.start, 0.015));
  assert.equal(ramp(low, "decay"), undefined, "no exponential ramp to a floor");

  const fall = ramp(low, "target");
  assert.equal(fall.value, 0);
  assert.ok(near(fall.time, ramp(low, "attack").time), "the fall starts where the attack ends");
  // setTargetAtTime gives exp(-(t - t0) / timeConstant); the reference cue is
  // exp(-5 (t - attack) / duration).
  assert.ok(near(fall.timeConstant, 0.09 / 5));
  assert.ok(near(ramp(high, "target").timeConstant, 0.09 / 5));
});

test("the start and stop cues keep their two rising and falling sine notes", async (t) => {
  const { cues, contexts } = await loadCues(t);

  await cues.playStartCue();
  await cues.playStopCue();

  const tones = contexts[0].tones;
  assert.deepEqual(
    tones.map((tone) => [tone.frequency, tone.type]),
    [
      [523.25, "sine"],
      [659.25, "sine"],
      [587.33, "sine"],
      [440, "sine"],
    ]
  );
  assert.ok(near(tones[1].start - tones[0].start, 0.09 + 0.025));
  assert.equal(tones[0].ramps.find((ramp) => ramp.kind === "attack").value, 0.2);
  assert.ok(
    tones.every((tone) => tone.ramps.some((ramp) => ramp.kind === "decay")),
    "their exponential ramp to the floor is unchanged"
  );
});

test("with cues switched off no cue plays, the error cue included", async (t) => {
  const { cues, contexts } = await loadCues(t, { enabled: false });

  await cues.playStartCue();
  await cues.playStopCue();
  await cues.playErrorCue();

  assert.equal(contexts.length, 0);
});
