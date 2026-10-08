const test = require("node:test");
const assert = require("node:assert/strict");
const { createDictationCueSession } = require("../../src/utils/dictationCueSession");

function session() {
  const played = [];
  const cues = createDictationCueSession({
    playStart: () => played.push("start"),
    playError: () => played.push("error"),
  });
  return { cues, played };
}

test("a dictation gets one start cue however often the microphone reports ready", () => {
  const { cues, played } = session();
  cues.begin();

  assert.equal(cues.startReady(), true);
  assert.equal(cues.startReady(), false);

  assert.deepEqual(played, ["start"]);
});

test("no start cue plays before a dictation has begun", () => {
  const { cues, played } = session();

  assert.equal(cues.startReady(), false);

  assert.deepEqual(played, []);
});

test("a failure before the start cue replaces it", () => {
  const { cues, played } = session();
  cues.begin();

  cues.fail();
  cues.startReady();

  assert.deepEqual(played, ["error"]);
});

test("a failure after the start cue follows it", () => {
  const { cues, played } = session();
  cues.begin();

  cues.startReady();
  cues.fail();

  assert.deepEqual(played, ["start", "error"]);
});

test("one error cue per dictation, however many failures follow", () => {
  const { cues, played } = session();
  cues.begin();

  assert.equal(cues.fail(), true);
  assert.equal(cues.fail(), false);
  assert.equal(cues.fail(), false);

  assert.deepEqual(played, ["error"]);
});

test("the next dictation starts with fresh cues", () => {
  const { cues, played } = session();
  cues.begin();
  cues.startReady();
  cues.fail();

  cues.begin();
  cues.startReady();
  cues.fail();

  assert.deepEqual(played, ["start", "error", "start", "error"]);
});
