// The audible cues of one dictation. A dictation gets one start cue, once the
// microphone really delivers audio, and one error cue, however many failures
// follow (a retry begins a new dictation). An error that lands before the start
// cue was due cancels it: a "go ahead" chirp right before a failure tone would
// contradict it.
export function createDictationCueSession({ playStart, playError }) {
  let startState = "idle";
  let errorPlayed = false;

  return {
    begin() {
      startState = "pending";
      errorPlayed = false;
    },
    startReady() {
      if (startState !== "pending") return false;
      startState = "played";
      playStart();
      return true;
    },
    fail() {
      if (errorPlayed) return false;
      errorPlayed = true;
      if (startState === "pending") startState = "skipped";
      playError();
      return true;
    },
  };
}
