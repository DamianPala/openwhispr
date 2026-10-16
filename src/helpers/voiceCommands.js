// Voice editing commands for Soniox dictation, in the style of Gboard voice
// typing: the prefix "CTRL", a command, and only after a pause. They edit the
// text of the current recording, so the live preview shows the effect at once
// and the field receives the corrected text. A command never reaches the output.
//
// Pure and deterministic, no Electron: the caller hands over the whole list of
// final tokens every time and gets the whole text back, so recomputing after
// each new batch of tokens gives the same result as doing it once at the end.
//
// The transcript is untrusted input. Nothing here evaluates it; a command is
// recognised only when the closed grammar below matches, and anything else
// (including a prefix without a command, or without a pause) stays as text.

const COMMAND_PAUSE_MS = 500;

const SENTENCE_END = ".?!…";
const SEPARATORS = ",;:-–";
const WHITESPACE_RE = /\s/u;
const PREFIX_RE = /(^|\s)(ctrl|control|kontrol)(?![\p{L}\p{N}])/giu;
// Hesitations that may sit between the prefix and the command word.
const FILLER_RE = /^(?:y{2,}|e{2,}|hm+|uh+|um+)$/;
// What removeFillers() takes out of the visible text (sonioxStreaming.js's
// FILLER_WORD); with that cleanup on, these never count as a deleted word.
const HIDDEN_FILLER_RE = /^(?:uh+|um+|yyy+|eee+|mmm+)$/iu;
const MAX_COMMAND_WORDS = 8;

// Grammar words are compared folded: lower case, no diacritics, "ł" as "l".
const DELETE_VERBS = new Set(["usun", "kasuj", "skasuj", "delete"]);
const UNDO_WORDS = new Set(["cofnij", "undo"]);
const ALL_WORDS = new Set(["wszystko", "all", "everything"]);
const MODIFIERS = new Set([
  "poprzednie",
  "poprzedni",
  "poprzednich",
  "ostatnie",
  "ostatni",
  "ostatnich",
  "to",
  "ten",
  "last",
  "previous",
  "the",
]);
const SINGLE_WORD = new Set(["slowo", "word"]);
const COUNTED_WORD = new Set(["slowo", "slowa", "slow", "word", "words"]);
const SENTENCE_WORDS = new Set(["zdanie", "sentence"]);
const NUMBER_WORDS = new Map([
  ["jeden", 1],
  ["jedno", 1],
  ["jedna", 1],
  ["one", 1],
  ["dwa", 2],
  ["dwie", 2],
  ["two", 2],
  ["trzy", 3],
  ["three", 3],
  ["cztery", 4],
  ["four", 4],
  ["piec", 5],
  ["five", 5],
  ["szesc", 6],
  ["six", 6],
  ["siedem", 7],
  ["seven", 7],
  ["osiem", 8],
  ["eight", 8],
  ["dziewiec", 9],
  ["nine", 9],
  ["dziesiec", 10],
  ["ten", 10],
]);

const fold = (word) =>
  word.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replaceAll("ł", "l");

function toCount(word) {
  if (word === undefined) return null;
  if (/^\d+$/.test(word)) {
    const count = Number(word);
    return count > 0 ? count : null;
  }
  return NUMBER_WORDS.get(word) ?? null;
}

// Words after the prefix, each with the offset where it ends. Light punctuation
// between them is ignored, so "CTRL, usuń słowo." and "CTRL usuń słowo" agree.
function lexWords(rest) {
  const words = [];
  // \p{M} keeps a decomposed "ń" (n + combining accent) inside its word.
  // "+" because the recogniser writes the spoken prefix like a shortcut
  // ("Ctrl+usuń słowo").
  const re = /[\s,.:;!?…\-–—+/"'„”“«»()]*([\p{L}\p{M}\p{N}]+)/uy;
  while (words.length < MAX_COMMAND_WORDS) {
    const match = re.exec(rest);
    if (!match) break;
    const closed = /^\s*[.?!…]/u.test(rest.slice(re.lastIndex));
    words.push({ word: fold(match[1]), end: re.lastIndex, closed });
  }
  return words;
}

function parseTarget(words, from) {
  if (ALL_WORDS.has(words[from])) return { type: "all", used: from + 1 };
  let i = from;
  while (MODIFIERS.has(words[i])) i++;
  const count = toCount(words[i]);
  if (count !== null && COUNTED_WORD.has(words[i + 1])) {
    return { type: "words", count, used: i + 2 };
  }
  if (SINGLE_WORD.has(words[i])) return { type: "words", count: 1, used: i + 1 };
  if (SENTENCE_WORDS.has(words[i])) return { type: "sentence", used: i + 1 };
  return null;
}

// `entries` come from lexWords(); the result says what to do and how many of
// them the command used, or null when they are not a command.
function parseCommand(entries) {
  const words = entries.map((entry) => entry.word);
  let i = 0;
  while (i < words.length && FILLER_RE.test(words[i])) i++;
  const head = words[i];
  if (head === undefined) return null;
  if (UNDO_WORDS.has(head)) return { type: "undo", used: i + 1 };
  if (head === "clear") return ALL_WORDS.has(words[i + 1]) ? { type: "all", used: i + 2 } : null;
  if (!DELETE_VERBS.has(head)) return null;
  // A bare verb deletes one word only when the recogniser closed it with a
  // sentence end ("CTRL, usuń."); an unknown word after it ("delete the file")
  // keeps the whole phrase as text.
  const target = parseTarget(words, i + 1);
  if (target) return target;
  return entries[i].closed ? { type: "words", count: 1, used: i + 1 } : null;
}

// The command that starts right after a prefix ending at `from`, and where its
// text ends, punctuation the recogniser put behind it included.
function detectCommand(text, from) {
  const rest = text.slice(from);
  const words = lexWords(rest);
  const command = parseCommand(words);
  if (!command) return null;
  const end = from + words[command.used - 1].end;
  const tail = /^[.,!?…;:]+/u.exec(text.slice(end));
  return { command, end: end + (tail ? tail[0].length : 0) };
}

function tokenEndMs(token) {
  if (typeof token.end_ms === "number") return token.end_ms;
  if (typeof token.start_ms === "number" && typeof token.duration_ms === "number") {
    return token.start_ms + token.duration_ms;
  }
  return null;
}

// Silence between the previous token and the one holding `pos`, or null when
// either side has no timing or the prefix sits inside the previous word's token.
function silenceBefore(tokens, starts, text, pos) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= pos) low = mid;
    else high = mid - 1;
  }
  if (low === 0 || text.slice(starts[low], pos).trim() !== "") return null;
  const previousEnd = tokenEndMs(tokens[low - 1]);
  const start = tokens[low].start_ms;
  if (previousEnd === null || typeof start !== "number") return null;
  return start - previousEnd;
}

// The start of the recording counts as a pause. Without timing the prefix has
// to follow the start of the text or the end of a sentence.
function followsPause(tokens, starts, text, pos) {
  let last = pos - 1;
  while (last >= 0 && WHITESPACE_RE.test(text[last])) last--;
  if (last < 0) return true;
  const silence = silenceBefore(tokens, starts, text, pos);
  if (silence !== null) return silence >= COMMAND_PAUSE_MS;
  return SENTENCE_END.includes(text[last]);
}

// Hanging separators come off the end of the buffer together with whitespace;
// sentence-end marks stay.
function trimTail(text) {
  let end = text.length;
  while (end > 0 && (WHITESPACE_RE.test(text[end - 1]) || SEPARATORS.includes(text[end - 1]))) {
    end--;
  }
  return text.slice(0, end);
}

// Scans backwards from the end, so deleting many words stays linear. A filler
// the preview never showed goes together with the next real word, or the
// user's "delete word" would seem to do nothing and a repeat would cost a word.
function removeWords(buffer, count, skipFillers) {
  let end = buffer.trimEnd().length;
  let left = count;
  while (end > 0 && left > 0) {
    let start = end;
    while (start > 0 && !WHITESPACE_RE.test(buffer[start - 1])) start--;
    const word = buffer.slice(start, end);
    const hidden = skipFillers && HIDDEN_FILLER_RE.test(word.replace(/[^\p{L}]+/gu, ""));
    // A lone dash or mark between words is not a word of its own.
    if (!hidden && /[\p{L}\p{N}]/u.test(word)) left--;
    end = start;
    while (end > 0 && WHITESPACE_RE.test(buffer[end - 1])) end--;
  }
  return trimTail(buffer.slice(0, end));
}

// A sentence ends at a sentence-end mark followed by whitespace, so "3.5" and
// "wp.pl" do not split one. The mark that closes the last sentence is skipped.
function removeSentence(buffer) {
  let end = buffer.trimEnd().length;
  while (end > 0 && SENTENCE_END.includes(buffer[end - 1])) end--;
  const body = buffer.slice(0, end);
  let cut = 0;
  for (const match of body.matchAll(/(?<![.?!…])[.?!…]+(?=\s)/gu)) {
    cut = match.index + match[0].length;
  }
  return trimTail(body.slice(0, cut));
}

function undo(state) {
  const entry = state.undo.pop();
  if (!entry || !state.buffer.startsWith(entry.after)) return;
  // Text dictated since the command stays after the restored text.
  state.buffer = entry.before + state.buffer.slice(entry.after.length);
}

function execute(state, command) {
  if (command.type === "undo") {
    undo(state);
  } else {
    const before = state.buffer.trimEnd();
    let after = "";
    if (command.type === "words") after = removeWords(before, command.count, state.skipFillers);
    if (command.type === "sentence") after = removeSentence(before);
    if (after !== before) state.undo.push({ before, after });
    state.buffer = after;
  }
  state.buffer = state.buffer.trimEnd();
}

// Soniox capitalises after the full stop it puts behind the command, which is
// wrong once the command has removed the text before it. The first word after
// a command takes its case from what is left of the buffer: upper case at a
// sentence start; lower case mid-sentence when it is a plain capitalised word
// (not a one-letter one, not a name the user listed as a key term).
function adjustFirstWord(buffer, piece, keyterms) {
  const offset = piece.length - piece.trimStart().length;
  const core = /^\S+/u.exec(piece.slice(offset))[0].replace(/[.,;:!?…"”'’)»]+$/u, "");
  if (!core) return piece;
  const sentenceStart = !buffer || SENTENCE_END.includes(buffer[buffer.length - 1]);
  let first = String.fromCodePoint(core.codePointAt(0));
  const length = first.length;
  if (sentenceStart && /\p{Ll}/u.test(first)) first = first.toUpperCase();
  else if (!sentenceStart && /^\p{Lu}\p{Ll}+$/u.test(core) && !keyterms.has(core.toLowerCase())) {
    first = first.toLowerCase();
  }
  return piece.slice(0, offset) + first + piece.slice(offset + length);
}

// The first dictated text after a command is joined to what is left of the
// buffer: case-adjusted, and set off by a space when the recogniser sent none.
function joinAfterCommand(state, piece) {
  state.buffer = state.buffer.trimEnd();
  if (!state.buffer) return adjustFirstWord("", piece.trimStart(), state.keyterms);
  const adjusted = adjustFirstWord(state.buffer, piece, state.keyterms);
  return /^[\p{L}\p{N}]/u.test(adjusted) ? ` ${adjusted}` : adjusted;
}

function append(state, segment) {
  if (!segment) return;
  if (state.afterCommand && segment.trim()) {
    state.afterCommand = false;
    state.buffer += joinAfterCommand(state, segment);
  } else {
    state.buffer += segment;
  }
}

function keytermSet(keyterms) {
  const set = new Set();
  for (const term of keyterms || []) {
    if (typeof term !== "string") continue;
    set.add(term.toLowerCase());
    for (const word of term.split(/\s+/u)) set.add(word.toLowerCase());
  }
  return set;
}

/**
 * Applies the voice editing commands found in Soniox tokens and returns the
 * resulting text. `tokens` are `{ text, start_ms, end_ms | duration_ms }`
 * objects in spoken order. Text without a recognised command comes back
 * unchanged, character for character. `skipFillers` mirrors the filler-removal
 * setting, so word counts match what the preview shows. `trace`, when given,
 * receives one entry per prefix seen (outcome and silence before it, no text),
 * for the debug log.
 */
function applyVoiceCommands(tokens, { keyterms, skipFillers = false, trace } = {}) {
  const list = (tokens || []).filter((t) => t && typeof t.text === "string" && t.text);
  const starts = [];
  let text = "";
  for (const token of list) {
    starts.push(text.length);
    text += token.text;
  }

  const state = {
    buffer: "",
    undo: [],
    afterCommand: false,
    keyterms: keytermSet(keyterms),
    skipFillers,
  };
  let cursor = 0;
  for (const match of text.matchAll(PREFIX_RE)) {
    const prefixStart = match.index + match[1].length;
    if (prefixStart < cursor) continue;
    const found = detectCommand(text, prefixStart + match[2].length);
    const paused = Boolean(found) && followsPause(list, starts, text, prefixStart);
    trace?.push({
      outcome: !found ? "no-command" : paused ? found.command.type : "no-pause",
      silenceMs: silenceBefore(list, starts, text, prefixStart),
      // The command's own words, or what followed an unrecognised prefix, to
      // grow the grammar from real use; never the dictation after a command.
      next: lexWords(text.slice(prefixStart + match[2].length))
        .slice(0, found ? found.command.used : 4)
        .map((entry) => entry.word),
    });
    if (!paused) continue;
    append(state, text.slice(cursor, prefixStart));
    execute(state, found.command);
    state.afterCommand = true;
    cursor = found.end;
  }
  append(state, text.slice(cursor));
  return state.buffer;
}

module.exports = { applyVoiceCommands, COMMAND_PAUSE_MS };
