const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { WebSocketServer } = require("ws");
const { applyVoiceCommands, COMMAND_PAUSE_MS } = require("../../src/helpers/voiceCommands");
const SonioxStreaming = require("../../src/helpers/sonioxStreaming");

const { buildConfigMessage, buildHints } = SonioxStreaming;

const PIECE_MS = 80;
const WORD_GAP_MS = 40;
const DEFAULT_PAUSE_MS = 120;
const LONG_PAUSE_MS = 800;

// Synthetic Soniox tokens: words cut into pieces of up to three characters
// (" CT", "RL", ","), the way sub-word tokens arrive, with timing. A part is a
// phrase or { text, pause } where pause is the silence before it.
function speak(...parts) {
  const tokens = [];
  let clock = 0;
  for (const part of parts) {
    const { text, pause = DEFAULT_PAUSE_MS } = typeof part === "string" ? { text: part } : part;
    // The clock already holds the gap after the previous word.
    if (tokens.length > 0) clock += pause - WORD_GAP_MS;
    for (const word of text.split(/\s+/).filter(Boolean)) {
      const marks = /[.,!?…:;]+$/.exec(word)?.[0] ?? "";
      const body = word.slice(0, word.length - marks.length);
      const pieces = body.match(/.{1,3}/gu) ?? [];
      if (marks) pieces.push(marks);
      pieces.forEach((piece, index) => {
        const lead = index === 0 && tokens.length > 0 ? " " : "";
        tokens.push({ text: lead + piece, start_ms: clock, end_ms: clock + PIECE_MS });
        clock += PIECE_MS;
      });
      clock += WORD_GAP_MS;
    }
  }
  return tokens;
}

const cmd = (text) => ({ text, pause: LONG_PAUSE_MS });
const untimed = (tokens) => tokens.map(({ text }) => ({ text }));
const run = (...parts) => applyVoiceCommands(speak(...parts));

describe("voice commands: deleting words", () => {
  it("deletes the last word, PL and EN, with and without a modifier", () => {
    const base = "I said hello world";
    for (const command of [
      "CTRL, delete word.",
      "CTRL, delete last word.",
      "CTRL, delete previous word.",
      "CTRL, usuń słowo.",
      "CTRL, usuń ostatnie słowo.",
      "CTRL, usuń poprzednie słowo.",
      "CTRL, kasuj słowo.",
      "CTRL, skasuj ostatnie słowo.",
    ]) {
      assert.equal(run(base, cmd(command)), "I said hello", command);
    }
  });

  it("deletes one word on a bare verb the recogniser closed with a full stop", () => {
    const bare = cmd("Ctrl usuń.");
    assert.equal(
      run("No i testujemy kolejny test. Bla, bla", cmd("ctrl usuń."), bare, bare, bare),
      "No i testujemy"
    );
    assert.equal(run("I said hello world", cmd("CTRL, delete!"), "again"), "I said hello again");
    // A known target after the stop still wins, as when an endpoint splits the command.
    assert.equal(run("Ala ma kota. Pies.", cmd("CTRL usuń."), cmd("Zdanie.")), "Ala ma kota.");
  });

  it("does not take the next sentence's first word as the target of a closed verb", () => {
    assert.equal(
      run("Pies szczeka.", cmd("CTRL, usuń."), "Wszystko jest w porządku."),
      "Pies wszystko jest w porządku."
    );
    assert.equal(
      run("I said hello world", cmd("CTRL, delete."), "All right, next point."),
      "I said hello all right, next point."
    );
    assert.equal(run("Raz dwa", cmd("CTRL, usuń."), "Słowo daję"), "Raz słowo daję");
  });

  it("keeps a bare verb after control or kontrol as text", () => {
    for (const phrase of ["Control, delete.", "kontrol, usuń."]) {
      const tokens = speak("press", cmd(phrase), "and so on");
      assert.equal(applyVoiceCommands(tokens), tokens.map((t) => t.text).join(""), phrase);
    }
  });

  it("accepts the prefix the way the recogniser writes it", () => {
    for (const command of [
      "Ctrl+usuń słowo.",
      "ctrl+usuń słowo.",
      "CTRL + usuń słowo",
      "CtRl, usuń słowo",
      "Control+ usuń słowo.",
      "Kontrol, usuń słowo.",
      "Ctrl - usuń słowo",
      "Ctrl: usuń słowo",
    ]) {
      assert.equal(run("No i dyktujemy. Blasa", cmd(command)), "No i dyktujemy.", command);
    }
    assert.equal(
      run("No i dyktujemy. Blasa.", cmd("Ctrl+usuń poprzednie zdanie.")),
      "No i dyktujemy."
    );
    assert.equal(run("Ala ma kota.", cmd("CTRL usuń to słowo.")), "Ala ma");
    assert.equal(run("Ala ma kota. Pies.", cmd("CTRL usuń to zdanie.")), "Ala ma kota.");
    // An endpoint can split the command; the full stop between halves is skipped.
    assert.equal(run("Ala ma kota.", cmd("CTRL usuń."), cmd("Słowo.")), "Ala ma");
  });

  it("traces every prefix with its outcome and the silence before it", () => {
    const trace = [];
    applyVoiceCommands(
      speak("alpha beta", cmd("CTRL usuń słowo."), "gamma CTRL usuń słowo", cmd("CTRL coś")),
      { trace }
    );
    assert.deepEqual(
      trace.map((entry) => entry.outcome),
      ["words", "no-pause", "no-command"]
    );
    assert.equal(trace[0].silenceMs, LONG_PAUSE_MS);
    assert.equal(trace[1].silenceMs, WORD_GAP_MS);
    assert.deepEqual(trace[2].next, ["cos"]);
    assert.deepEqual(trace[0].next, ["usun", "slowo"]);
  });

  it("deletes a hidden filler together with the next real word", () => {
    const tokens = speak("tekst do poprawy yyy", cmd("CTRL usuń słowo."));
    assert.equal(applyVoiceCommands(tokens, { skipFillers: true }), "tekst do");
    assert.equal(
      applyVoiceCommands(speak("raz dwa eee, trzy mmm", cmd("CTRL usuń dwa słowa.")), {
        skipFillers: true,
      }),
      "raz"
    );
    // With filler removal off the filler is on screen, so it is the word deleted.
    assert.equal(applyVoiceCommands(tokens), "tekst do poprawy");
  });

  it("deletes N words, N as a digit or spelled out", () => {
    const base = "one two three four five six";
    const cases = [
      ["CTRL usuń 2 słowa.", "one two three four"],
      ["CTRL usuń dwa słowa.", "one two three four"],
      ["CTRL usuń pięć słów.", "one"],
      ["CTRL usuń jedno słowo.", "one two three four five"],
      ["CTRL usuń ostatnie trzy słowa.", "one two three"],
      ["CTRL usuń poprzednich 2 słów.", "one two three four"],
      ["CTRL delete 3 words.", "one two three"],
      ["CTRL delete last two words.", "one two three four"],
      ["CTRL delete one word.", "one two three four five"],
      ["CTRL delete the last four words.", "one two"],
      ["CTRL delete 10 words.", ""],
    ];
    for (const [command, expected] of cases) {
      assert.equal(run(base, cmd(command)), expected, command);
    }
  });

  it("deletes everything when N is larger than the number of words", () => {
    assert.equal(run("just two", cmd("CTRL delete seven words.")), "");
  });

  it("takes the attached punctuation with the word and drops a dangling comma", () => {
    assert.equal(run("Hello, brave world.", cmd("CTRL delete word.")), "Hello, brave");
    assert.equal(run("Hello, world", cmd("CTRL delete word")), "Hello");
    assert.equal(run("First. Second third", cmd("CTRL delete 2 words")), "First.");
  });

  it("does nothing on an empty buffer", () => {
    assert.equal(run(cmd("CTRL delete word.")), "");
    assert.equal(run("hello", cmd("CTRL delete all."), cmd("CTRL delete word.")), "");
  });
});

describe("voice commands: sentences and everything", () => {
  it("deletes the last sentence, with or without a closing mark", () => {
    assert.equal(run("Hello there. How are you?", cmd("CTRL delete sentence.")), "Hello there.");
    assert.equal(run("Hello there. How are", cmd("CTRL usuń zdanie.")), "Hello there.");
    assert.equal(run("Raz. Dwa! Trzy?", cmd("CTRL skasuj ostatnie zdanie.")), "Raz. Dwa!");
    assert.equal(run("Only one sentence.", cmd("CTRL delete last sentence.")), "");
  });

  it("does not split a sentence at a decimal point", () => {
    assert.equal(run("It costs 3.5 euro today", cmd("CTRL delete sentence")), "");
  });

  it("clears the buffer", () => {
    for (const command of ["CTRL usuń wszystko.", "CTRL delete all.", "CTRL clear all."]) {
      assert.equal(run("some text. more text", cmd(command)), "", command);
    }
  });
});

describe("voice commands: undo", () => {
  it("restores what the last command removed", () => {
    assert.equal(
      run("one two three", cmd("CTRL delete word."), cmd("CTRL undo.")),
      "one two three"
    );
    assert.equal(
      run("Raz dwa. Trzy cztery.", cmd("CTRL usuń zdanie."), cmd("CTRL cofnij.")),
      "Raz dwa. Trzy cztery."
    );
  });

  it("keeps a space between restored text and text dictated after clearing", () => {
    assert.equal(
      run("Stary tekst.", cmd("CTRL clear all."), "Nowy tekst", cmd("CTRL cofnij.")),
      "Stary tekst. Nowy tekst"
    );
  });

  it("reads ten as a count, not a modifier", () => {
    const base = "a b c d e f g h i j k l";
    assert.equal(run(base, cmd("CTRL delete ten words.")), "a b");
  });

  it("undoes earlier commands with repeated undo", () => {
    const parts = ["one two three four", cmd("CTRL delete word."), cmd("CTRL delete word.")];
    assert.equal(run(...parts), "one two");
    assert.equal(run(...parts, cmd("CTRL undo.")), "one two three");
    assert.equal(run(...parts, cmd("CTRL undo."), cmd("CTRL undo.")), "one two three four");
    assert.equal(
      run(...parts, cmd("CTRL undo."), cmd("CTRL undo."), cmd("CTRL undo.")),
      "one two three four",
      "nothing left to undo"
    );
  });

  it("undoes a sentence deleted before a second sentence was cut", () => {
    const parts = [
      "Aa bb. Cc dd. Ee ff.",
      cmd("CTRL delete sentence."),
      cmd("CTRL delete sentence."),
    ];
    assert.equal(run(...parts), "Aa bb.");
    assert.equal(run(...parts, cmd("CTRL undo."), cmd("CTRL undo.")), "Aa bb. Cc dd. Ee ff.");
  });

  it("does nothing when there is nothing to undo, and the command is still removed", () => {
    assert.equal(run("keep this", cmd("CTRL undo.")), "keep this");
  });

  it("puts the restored words back before text dictated since", () => {
    assert.equal(
      run("one two three", cmd("CTRL delete word."), "and four", cmd("CTRL undo.")),
      "one two three and four"
    );
  });
});

describe("voice commands: recognising the prefix", () => {
  it("accepts CTRL, Ctrl, control and kontrol, with or without punctuation", () => {
    for (const prefix of [
      "CTRL,",
      "CTRL",
      "Ctrl,",
      "ctrl.",
      "Control,",
      "control",
      "Kontrol,",
      "CTRL:",
    ]) {
      assert.equal(run("alpha beta", cmd(`${prefix} delete word.`)), "alpha", prefix);
    }
  });

  it("works when the tokens split the prefix", () => {
    const tokens = [
      { text: "alpha", start_ms: 0, end_ms: 200 },
      { text: " CT", start_ms: 1200, end_ms: 1300 },
      { text: "RL", start_ms: 1300, end_ms: 1400 },
      { text: ",", start_ms: 1400, end_ms: 1450 },
      { text: " del", start_ms: 1500, end_ms: 1600 },
      { text: "ete", start_ms: 1600, end_ms: 1700 },
      { text: " word", start_ms: 1700, end_ms: 1900 },
      { text: ".", start_ms: 1900, end_ms: 1950 },
    ];
    assert.equal(applyVoiceCommands(tokens), "");
  });

  it("skips hesitation words between the prefix and the command", () => {
    assert.equal(run("alpha beta", cmd("CTRL, yyy, usuń słowo.")), "alpha");
    assert.equal(run("alpha beta", cmd("CTRL eee hmm delete word.")), "alpha");
  });

  it("matches commands written with decomposed diacritics", () => {
    assert.equal(run("alpha beta", cmd("CTRL usuń słowo.".normalize("NFD"))), "alpha");
  });

  it("needs the pause: a prefix said right after the words stays text", () => {
    const tokens = speak("alpha beta", { text: "CTRL, delete word.", pause: DEFAULT_PAUSE_MS });
    assert.equal(applyVoiceCommands(tokens), "alpha beta CTRL, delete word.");
  });

  it("treats the pause threshold as inclusive", () => {
    const at = speak("alpha beta", { text: "CTRL delete word", pause: COMMAND_PAUSE_MS });
    const under = speak("alpha beta", { text: "CTRL delete word", pause: COMMAND_PAUSE_MS - 1 });
    assert.equal(applyVoiceCommands(at), "alpha");
    assert.equal(applyVoiceCommands(under), "alpha beta CTRL delete word");
  });

  it("counts the start of the recording as a pause", () => {
    assert.equal(applyVoiceCommands(speak("CTRL, delete word.", "Hello there")), "Hello there");
  });

  it("reads the end from duration_ms when end_ms is missing", () => {
    const tokens = [
      { text: "alpha", start_ms: 0, duration_ms: 200 },
      { text: " beta", start_ms: 250, duration_ms: 200 },
      { text: " CTRL", start_ms: 1200, duration_ms: 150 },
      { text: " delete", start_ms: 1400, duration_ms: 150 },
      { text: " word", start_ms: 1600, duration_ms: 150 },
    ];
    assert.equal(applyVoiceCommands(tokens), "alpha");
    tokens[2].start_ms = 500;
    assert.equal(applyVoiceCommands(tokens), "alpha beta CTRL delete word");
  });

  it("without timing, needs the start of the text or a sentence end before the prefix", () => {
    const after = untimed(speak("Hello world.", "CTRL, delete word."));
    assert.equal(applyVoiceCommands(after), "Hello");
    const start = untimed(speak("CTRL, delete word. Fine"));
    assert.equal(applyVoiceCommands(start), "Fine");
    const midSentence = untimed(speak("I said CTRL, delete word."));
    assert.equal(applyVoiceCommands(midSentence), "I said CTRL, delete word.");
  });

  it("leaves a prefix without a known command as text", () => {
    for (const phrase of [
      "CTRL, to będzie do skasowania",
      "CTRL, delete the file",
      "CTRL, delete words",
      "CTRL, remove everything",
      "CTRL, delete 0 words",
      "CTRL, usuń to",
      "CTRL, usuń",
      "CTRL,",
      "CTRL",
    ]) {
      const tokens = speak("alpha beta", cmd(phrase));
      assert.equal(applyVoiceCommands(tokens), tokens.map((t) => t.text).join(""), phrase);
    }
  });

  it("leaves key-combination talk alone", () => {
    for (const phrase of [
      "naciśnij Ctrl C",
      "press Ctrl+C",
      "hold control then undo",
      "kontrolować",
    ]) {
      const tokens = speak(phrase);
      assert.equal(applyVoiceCommands(tokens), tokens.map((t) => t.text).join(""), phrase);
    }
  });

  it("applies two commands in a row", () => {
    assert.equal(
      run("one two three four", cmd("CTRL usuń słowo."), cmd("CTRL usuń słowo.")),
      "one two"
    );
  });

  it("keeps the text of a command-free list exactly as it came", () => {
    const tokens = speak("  Hello,  world.\nSecond line…", "and more");
    assert.equal(applyVoiceCommands(tokens), tokens.map((t) => t.text).join(""));
  });
});

describe("voice commands: dictation after a command", () => {
  it("lower-cases a capitalised word that continues the sentence", () => {
    assert.equal(run("I said foo bar", cmd("CTRL, delete word."), "Baz qux"), "I said foo baz qux");
  });

  it("keeps the case of a listed key term, an acronym and a lone I", () => {
    const parts = ["I said foo bar", cmd("CTRL, delete word."), "Baz qux"];
    const tokens = speak(...parts);
    assert.equal(applyVoiceCommands(tokens, { keyterms: ["Baz"] }), "I said foo Baz qux");
    assert.equal(applyVoiceCommands(tokens, { keyterms: ["baz quux"] }), "I said foo Baz qux");
    assert.equal(run("a b", cmd("CTRL delete word."), "NASA says"), "a NASA says");
    assert.equal(run("a b", cmd("CTRL delete word."), "I think"), "a I think");
  });

  it("capitalises after a sentence end or an empty buffer", () => {
    assert.equal(run("First. Second", cmd("CTRL delete word."), "next"), "First. Next");
    assert.equal(run("hello", cmd("CTRL delete all."), "world"), "World");
  });

  it("separates the next text from the buffer when no space came with it", () => {
    const tokens = [
      { text: "alpha beta", start_ms: 0, end_ms: 400 },
      { text: " CTRL delete word", start_ms: 1400, end_ms: 1800 },
      { text: ".", start_ms: 1800, end_ms: 1850 },
      { text: "gamma", start_ms: 1900, end_ms: 2100 },
    ];
    assert.equal(applyVoiceCommands(tokens), "alpha gamma");
  });

  it("leaves later words alone", () => {
    assert.equal(
      run("one two", cmd("CTRL delete word."), "Three Four five"),
      "one three Four five"
    );
  });
});

describe("voice commands: determinism", () => {
  it("gives the same text when it is recomputed, as the stream does per batch", () => {
    const tokens = speak("one two three four", cmd("CTRL delete word."), "five", cmd("CTRL undo."));
    const snapshot = JSON.stringify(tokens);
    const first = applyVoiceCommands(tokens);
    assert.equal(applyVoiceCommands(tokens), first);
    assert.equal(JSON.stringify(tokens), snapshot, "the tokens are not touched");
    let growing = [];
    for (const token of tokens) {
      growing = [...growing, token];
      applyVoiceCommands(growing);
    }
    assert.equal(applyVoiceCommands(growing), first);
  });

  it("shows a half-spoken command as text until it completes", () => {
    const tokens = speak("alpha beta", cmd("CTRL, delete word."));
    const cut = tokens.findIndex((t) => t.text.includes("del"));
    assert.equal(applyVoiceCommands(tokens.slice(0, cut + 1)), "alpha beta CTRL, del");
    assert.equal(applyVoiceCommands(tokens), "alpha");
  });

  it("copes with a long dictation full of prefixes", () => {
    const words = Array.from({ length: 4000 }, () => "word").join(" ");
    const tokens = speak(words, cmd("CTRL delete 3000 words."));
    const started = Date.now();
    assert.equal(applyVoiceCommands(tokens).split(" ").length, 1000);
    const noise = speak(Array.from({ length: 3000 }, () => "CTRL x").join(" "));
    applyVoiceCommands(noise);
    assert.ok(Date.now() - started < 3000);
  });

  it("returns an empty string for no tokens", () => {
    assert.equal(applyVoiceCommands([]), "");
    assert.equal(applyVoiceCommands(undefined), "");
  });
});

describe("SonioxStreaming with voice commands", () => {
  const frame = (tokens) =>
    JSON.stringify({ tokens: tokens.map((t) => ({ ...t, is_final: true })) });

  // A loopback server that only accepts and records the config frame.
  async function withServer(run) {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise((resolve) => server.once("listening", resolve));
    const configs = [];
    server.on("connection", (socket) => {
      socket.on("message", (data) => configs.push(JSON.parse(data.toString())));
    });
    const url = `ws://127.0.0.1:${server.address().port}/transcribe-websocket`;
    try {
      await run(url, configs);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  async function connected(url, options) {
    const streaming = new SonioxStreaming();
    streaming.buildWebSocketUrl = () => url;
    await streaming.connect({ apiKey: "k", mode: "byok", ...options });
    return streaming;
  }

  const tokens = speak("I said foo bar", cmd("CTRL, delete word."), "Baz qux.");

  it("emits and returns text with the commands already applied", async () => {
    await withServer(async (url) => {
      const streaming = await connected(url, { voiceCommands: true });
      const finals = [];
      streaming.onFinalTranscript = (text) => finals.push(text);
      try {
        for (const token of tokens) streaming.handleMessage(frame([token]));
        assert.equal(finals.at(-1), "I said foo baz qux.");
        assert.equal(streaming.getFullTranscript(), "I said foo baz qux.");
        assert.ok(finals.includes("I said foo bar CTRL, del"), "the command shows until it ends");
      } finally {
        await streaming.disconnect(false);
      }
    });
  });

  it("passes keyterms on, so a listed name keeps its capital", async () => {
    await withServer(async (url) => {
      const streaming = await connected(url, { voiceCommands: true, keyterms: ["Baz"] });
      try {
        streaming.handleMessage(frame(tokens));
        assert.equal(streaming.getFullTranscript(), "I said foo Baz qux.");
      } finally {
        await streaming.disconnect(false);
      }
    });
  });

  it("changes nothing when the setting is off", async () => {
    await withServer(async (url, configs) => {
      for (const options of [{}, { voiceCommands: false }]) {
        const streaming = await connected(url, options);
        const finals = [];
        streaming.onFinalTranscript = (text) => finals.push(text);
        try {
          streaming.handleMessage(frame(tokens));
          const expected = "I said foo bar CTRL, delete word. Baz qux.";
          assert.equal(finals.at(-1), expected);
          assert.equal(streaming.getFullTranscript(), expected);
        } finally {
          await streaming.disconnect(false);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      for (const config of configs) assert.equal("context" in config, false);
    });
  });

  it("adds CTRL to the context terms only when the setting is on", async () => {
    await withServer(async (url, configs) => {
      const on = await connected(url, { voiceCommands: true, keyterms: ["Soniox"] });
      await on.disconnect(false);
      const off = await connected(url, { keyterms: ["Soniox"] });
      await off.disconnect(false);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(configs[0].context.terms, ["Soniox", "CTRL"]);
      assert.deepEqual(configs[1].context.terms, ["Soniox"]);
    });
  });

  it("builds the CTRL term once, whatever the user's dictionary holds", () => {
    assert.deepEqual(buildHints({ voiceCommands: true }).context, { terms: ["CTRL"] });
    assert.deepEqual(buildHints({ voiceCommands: true, keyterms: ["ctrl", "x"] }).context, {
      terms: ["ctrl", "x"],
    });
    assert.equal("context" in buildHints({}), false);
    assert.equal("context" in buildConfigMessage({ apiKey: "k" }), false);
    assert.deepEqual(buildConfigMessage({ apiKey: "k", voiceCommands: true }).context, {
      terms: ["CTRL"],
    });
  });
});
