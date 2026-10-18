const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");

const load = () => import("../../src/helpers/cleanupRecord.js");

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

test("a successful call records ok with provider, model, prompt hash and wall time", async () => {
  const { buildCleanupRecord } = await load();
  const promptText = "Clean the transcript. Agent: {{agentName}}";

  const record = await buildCleanupRecord({
    provider: "custom",
    model: "google/gemini-3.5-flash-lite",
    promptText,
    ms: 412.6,
  });

  assert.deepEqual(record, {
    status: "ok",
    provider: "custom",
    model: "google/gemini-3.5-flash-lite",
    promptHash: sha256(promptText).slice(0, 12),
    ms: 413,
    error: null,
  });
  assert.match(record.promptHash, /^[0-9a-f]{12}$/);
});

test("the prompt hash covers the configured template and nothing else", async () => {
  const { buildCleanupRecord } = await load();

  const a = await buildCleanupRecord({ provider: "x", model: "m", promptText: "prompt A", ms: 1 });
  const same = await buildCleanupRecord({
    provider: "y",
    model: "n",
    promptText: "prompt A",
    ms: 9,
  });
  const b = await buildCleanupRecord({ provider: "x", model: "m", promptText: "prompt B", ms: 1 });

  assert.equal(a.promptHash, same.promptHash);
  assert.notEqual(a.promptHash, b.promptHash);
});

test("a server-side prompt leaves the hash null", async () => {
  const { buildCleanupRecord } = await load();

  const record = await buildCleanupRecord({
    provider: "openwhispr",
    model: "server-model",
    promptText: null,
    ms: 80,
  });

  assert.equal(record.status, "ok");
  assert.equal(record.promptHash, null);
});

test("a thrown error records error with its message only", async () => {
  const { buildCleanupRecord } = await load();
  const failure = Object.assign(new Error("Provider returned 503"), {
    code: "PROVIDER_UNAVAILABLE",
    technicalDetails: { requestId: "r-1" },
  });

  const record = await buildCleanupRecord({
    provider: "openrouter",
    model: "m",
    promptText: "p",
    ms: 2500,
    error: failure,
  });

  assert.equal(record.status, "error");
  assert.equal(record.error, "Provider returned 503");
  assert.equal(record.ms, 2500);
  assert.deepEqual(Object.keys(record).sort(), [
    "error",
    "model",
    "ms",
    "promptHash",
    "provider",
    "status",
  ]);
});

test("the error message is cut to 300 characters", async () => {
  const { buildCleanupRecord, CLEANUP_ERROR_MAX_LENGTH } = await load();

  const record = await buildCleanupRecord({
    provider: "custom",
    model: "m",
    promptText: "p",
    ms: 1,
    error: new Error("x".repeat(1000)),
  });

  assert.equal(CLEANUP_ERROR_MAX_LENGTH, 300);
  assert.equal(record.error.length, 300);
});

test("an error without a message still records a non-empty reason", async () => {
  const { buildCleanupRecord } = await load();

  const fromEmpty = await buildCleanupRecord({
    provider: "p",
    model: "m",
    ms: 1,
    error: new Error(""),
  });
  const fromString = await buildCleanupRecord({ provider: "p", model: "m", ms: 1, error: "boom" });

  assert.equal(fromEmpty.status, "error");
  assert.equal(fromEmpty.error, "Cleanup failed");
  assert.equal(fromString.error, "boom");
});

test("missing provider or model are stored as null and a negative time clamps to zero", async () => {
  const { buildCleanupRecord } = await load();

  const record = await buildCleanupRecord({ provider: "", model: undefined, ms: -3 });

  assert.equal(record.provider, null);
  assert.equal(record.model, null);
  assert.equal(record.ms, 0);
  assert.equal(record.promptHash, null);
});

test("cleanupProviderId follows the call's own provider resolution", async () => {
  const { cleanupProviderId } = await load();
  const resolve = (provider, model) => (provider === "qwen" ? "local" : provider || `by-${model}`);

  assert.equal(
    cleanupProviderId({ mode: "openwhispr", provider: "openai", model: "" }, resolve),
    "openwhispr"
  );
  assert.equal(
    cleanupProviderId({ mode: "self-hosted", provider: "", model: "m" }, resolve),
    "lan"
  );
  assert.equal(
    cleanupProviderId({ mode: "providers", provider: "custom", model: "m" }, resolve),
    "custom"
  );
  assert.equal(
    cleanupProviderId({ mode: "local", provider: "qwen", model: "m" }, resolve),
    "local"
  );
  assert.equal(
    cleanupProviderId({ mode: "providers", provider: "", model: "" }, () => ""),
    null
  );
});
