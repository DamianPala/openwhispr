const test = require("node:test");
const assert = require("node:assert/strict");

const load = async () => {
  const prompts = await import("../../src/config/prompts.ts");
  const { useSettingsStore } = await import("../../src/stores/settingsStore.ts");
  return { ...prompts, useSettingsStore };
};

const POLISH_BLOCK = /entire output in Polish/;
const CUSTOM = "Clean the transcript. English text stays English.";

function setCustomCleanup(useSettingsStore, value) {
  const customPrompts = { ...useSettingsStore.getState().customPrompts, cleanup: value };
  useSettingsStore.setState({ customPrompts });
}

test("the default cleanup prompt gets the language block", async (t) => {
  const { getCleanupSystemPrompt, useSettingsStore } = await load();
  setCustomCleanup(useSettingsStore, "");
  t.after(() => setCustomCleanup(useSettingsStore, ""));

  assert.match(getCleanupSystemPrompt(null, [], "pl", "en"), POLISH_BLOCK);
});

test("a custom cleanup prompt does not get the language block", async (t) => {
  const { getCleanupSystemPrompt, useSettingsStore } = await load();
  setCustomCleanup(useSettingsStore, CUSTOM);
  t.after(() => setCustomCleanup(useSettingsStore, ""));

  const prompt = getCleanupSystemPrompt(null, [], "pl", "en");
  assert.ok(prompt.startsWith(CUSTOM));
  assert.doesNotMatch(prompt, POLISH_BLOCK);
});

test("a custom cleanup prompt keeps the dictionary suffix", async (t) => {
  const { getCleanupSystemPrompt, useSettingsStore } = await load();
  setCustomCleanup(useSettingsStore, CUSTOM);
  t.after(() => setCustomCleanup(useSettingsStore, ""));

  const prompt = getCleanupSystemPrompt(null, ["Soniox", "OpenWhispr"], "pl", "en");
  assert.ok(prompt.endsWith("Soniox, OpenWhispr"));
  assert.doesNotMatch(prompt, POLISH_BLOCK);
});

test("a custom cleanup prompt leaves other prompt kinds' language block alone", async (t) => {
  const { resolvePrompt, useSettingsStore } = await load();
  setCustomCleanup(useSettingsStore, CUSTOM);
  t.after(() => setCustomCleanup(useSettingsStore, ""));

  const prompt = resolvePrompt("dictationAgent", { agentName: null, language: "pl" });
  assert.match(prompt, POLISH_BLOCK);
});
