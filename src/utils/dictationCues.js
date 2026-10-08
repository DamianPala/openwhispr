import logger from "./logger";
import { getSettings } from "../stores/settingsStore";

const START_NOTES = [523.25, 659.25];
const STOP_NOTES = [587.33, 440];
const NOTE_DURATION_SECONDS = 0.09;
const NOTE_GAP_SECONDS = 0.025;
const NOTE_ATTACK_SECONDS = 0.015;
const MAX_GAIN = 0.2;
const MIN_GAIN = 0.0001;

// Failure tone: two taps of one pitch, each a low softened square under a
// triangle an octave up. Different pitch, timbre and rhythm from the rising
// start chirp, so it is never mistaken for it.
const ERROR_NOTE_GAP_SECONDS = 0.07;
const SOFT_SQUARE_HARMONICS = [1, 3, 5, 7];
const SOFT_SQUARE_LEVEL = 0.8;
// The envelope falls as exp(-DECAY_RATE * t / duration) after the attack, which
// setTargetAtTime reproduces with time constant duration / DECAY_RATE.
const ERROR_DECAY_RATE = 5;
const ERROR_LAYERS = [
  { frequency: 220, wave: "softSquare", gain: 0.3, naturalDecay: true },
  { frequency: 440, wave: "triangle", gain: 0.25, naturalDecay: true },
];

const tonesOf = (frequencies) => frequencies.map((frequency) => [{ frequency, wave: "sine" }]);
const START_CUE = { notes: tonesOf(START_NOTES), gap: NOTE_GAP_SECONDS };
const STOP_CUE = { notes: tonesOf(STOP_NOTES), gap: NOTE_GAP_SECONDS };
const ERROR_CUE = { notes: [ERROR_LAYERS, ERROR_LAYERS], gap: ERROR_NOTE_GAP_SECONDS };

let audioContext = null;
let softSquareWave = null;
let softSquareContext = null;

const getAudioContext = () => {
  if (typeof window === "undefined") {
    return null;
  }

  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) {
    return null;
  }

  if (!audioContext || audioContext.state === "closed") {
    audioContext = new AudioContextCtor();
  }

  return audioContext;
};

export const resumeContextIfNeeded = async () => {
  try {
    const context = getAudioContext();
    if (!context) {
      return null;
    }

    if (context.state === "suspended") {
      await context.resume();
    }

    return context.state === "running" ? context : null;
  } catch (error) {
    logger.debug(
      "Failed to initialize dictation cue audio context",
      { error: error instanceof Error ? error.message : String(error) },
      "audio"
    );
    return null;
  }
};

// Odd harmonics at 0,8/h: a square wave without its harsh top end. Left
// unnormalized so the layer keeps its level against the triangle.
const getSoftSquareWave = (context) => {
  if (softSquareContext !== context) {
    const real = new Float32Array(SOFT_SQUARE_HARMONICS.at(-1) + 1);
    const imag = new Float32Array(real.length);
    for (const harmonic of SOFT_SQUARE_HARMONICS) imag[harmonic] = SOFT_SQUARE_LEVEL / harmonic;
    softSquareWave = context.createPeriodicWave(real, imag, { disableNormalization: true });
    softSquareContext = context;
  }
  return softSquareWave;
};

const scheduleTone = (
  context,
  { frequency, wave, gain = MAX_GAIN, naturalDecay = false },
  startTime
) => {
  const oscillator = context.createOscillator();
  const gainNode = context.createGain();
  const stopTime = startTime + NOTE_DURATION_SECONDS;

  if (wave === "softSquare") {
    oscillator.setPeriodicWave(getSoftSquareWave(context));
  } else {
    oscillator.type = wave;
  }
  oscillator.frequency.setValueAtTime(frequency, startTime);

  const attackEnd = startTime + NOTE_ATTACK_SECONDS;
  if (naturalDecay) {
    gainNode.gain.setValueAtTime(0, startTime);
    gainNode.gain.linearRampToValueAtTime(gain, attackEnd);
    gainNode.gain.setTargetAtTime(0, attackEnd, NOTE_DURATION_SECONDS / ERROR_DECAY_RATE);
  } else {
    gainNode.gain.setValueAtTime(MIN_GAIN, startTime);
    gainNode.gain.linearRampToValueAtTime(gain, attackEnd);
    gainNode.gain.exponentialRampToValueAtTime(MIN_GAIN, stopTime);
  }

  oscillator.connect(gainNode);
  gainNode.connect(context.destination);

  oscillator.start(startTime);
  oscillator.stop(stopTime + 0.01);
};

const isEnabled = () => getSettings().audioCuesEnabled;

const playCue = async ({ notes, gap }) => {
  try {
    if (!isEnabled()) return;

    const context = await resumeContextIfNeeded();
    if (!context) {
      return;
    }

    const baseTime = context.currentTime + 0.005;
    notes.forEach((layers, index) => {
      const noteStart = baseTime + index * (NOTE_DURATION_SECONDS + gap);
      for (const layer of layers) scheduleTone(context, layer, noteStart);
    });
  } catch (error) {
    logger.debug(
      "Failed to play dictation cue",
      { error: error instanceof Error ? error.message : String(error) },
      "audio"
    );
  }
};

export const playStartCue = () => playCue(START_CUE);

export const playStopCue = () => playCue(STOP_CUE);

export const playErrorCue = () => playCue(ERROR_CUE);
