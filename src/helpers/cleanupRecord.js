import { hashPromptText } from "../config/retiredPrompts";

// Facts about one dictation cleanup call, saved with the history row so a
// raw_text/text pair can later be replayed as an evaluation case. Nothing here
// may carry transcript text, prompt text or credentials: the prompt is kept as
// a short hash and the error as its message only.

export const CLEANUP_ERROR_MAX_LENGTH = 300;
export const CLEANUP_PROMPT_HASH_LENGTH = 12;
export const EMPTY_CLEANUP_REPLY_MESSAGE = "Cleanup model returned an empty reply";

// Mirrors how ReasoningService.processText picks the handler for a cleanup call
// that names no provider of its own.
export function cleanupProviderId({ mode, provider, model }, resolveProvider) {
  if (mode === "openwhispr") return "openwhispr";
  if (mode === "self-hosted") return "lan";
  return resolveProvider(provider, model) || null;
}

function cleanupErrorText(error) {
  const raw = typeof error === "string" ? error : error?.message;
  const message = typeof raw === "string" ? raw.trim() : "";
  return (message || "Cleanup failed").slice(0, CLEANUP_ERROR_MAX_LENGTH);
}

async function promptHash(promptText) {
  if (!promptText) return null;
  try {
    return (await hashPromptText(promptText)).slice(0, CLEANUP_PROMPT_HASH_LENGTH);
  } catch {
    // A missing hash must not cost the rest of the record.
    return null;
  }
}

// `promptText` is the prompt as configured, before the app adds the language
// context and the dictionary suffix; null when the prompt lives on a server.
export async function buildCleanupRecord({ provider, model, promptText, ms, error = null }) {
  return {
    status: error ? "error" : "ok",
    // Strings only: SQLite refuses to bind other types, which would lose the row.
    provider: typeof provider === "string" && provider ? provider : null,
    model: typeof model === "string" && model ? model : null,
    promptHash: await promptHash(promptText),
    ms: Math.max(0, Math.round(ms)),
    error: error ? cleanupErrorText(error) : null,
  };
}
