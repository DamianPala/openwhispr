const { describe, it, mock } = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const { WebSocketServer, WebSocket } = require("ws");
const SonioxStreaming = require("../../src/helpers/sonioxStreaming");
const debugLogger = require("../../src/helpers/debugLogger");

const { removeFillers, buildConfigMessage, DEFAULT_MODEL } = SonioxStreaming;

// Mirrors sonioxStreaming.js's own keep-alive constants (not exported: they're
// internal tuning, not part of the module's public contract).
const KEEPALIVE_INTERVAL_MS_FOR_TEST = 5000;
const KEEPALIVE_IDLE_LIMIT_MS_FOR_TEST = 30000;

describe("removeFillers", () => {
  it("passes through normal text unchanged", () => {
    assert.equal(removeFillers("Hello world."), "Hello world.");
  });

  it("removes filler mid-sentence", () => {
    assert.equal(removeFillers("I uh think so"), "I think so");
  });

  it("removes filler with trailing comma mid-sentence", () => {
    assert.equal(removeFillers("I, um, think so"), "I think so");
  });

  it("removes filler after period and capitalizes next word", () => {
    assert.equal(removeFillers("done. Yyy, let me check"), "done. Let me check");
  });

  it("removes filler after question mark and capitalizes", () => {
    assert.equal(removeFillers("right? Eee, or maybe not"), "right? Or maybe not");
  });

  it("removes filler after exclamation mark and capitalizes", () => {
    assert.equal(removeFillers("wow! Um, that was great"), "wow! That was great");
  });

  it("preserves 'Hmm' as intentional expression", () => {
    assert.equal(removeFillers("really? Hmm. Maybe so."), "really? Hmm. Maybe so.");
  });

  it("removes multiple fillers in one text", () => {
    assert.equal(
      removeFillers("OK so let's try. Yyy, does it work? Um, or not? Eee, let me check again."),
      "OK so let's try. Does it work? Or not? Let me check again."
    );
  });

  it("removes filler at start of text and capitalizes", () => {
    assert.equal(removeFillers("Uh, so anyway"), "So anyway");
  });

  it("removes filler at end of text", () => {
    assert.equal(removeFillers("That's all um"), "That's all");
  });

  it("removes consecutive fillers", () => {
    assert.equal(removeFillers("Well uh um ok"), "Well ok");
  });

  it("handles text with only fillers", () => {
    assert.equal(removeFillers("Uh um mmm"), "");
  });

  it("handles empty string", () => {
    assert.equal(removeFillers(""), "");
  });

  it("is case-insensitive", () => {
    assert.equal(removeFillers("So UH yeah"), "So yeah");
    assert.equal(removeFillers("So UHH yeah"), "So yeah");
    assert.equal(removeFillers("So YYY yeah"), "So yeah");
  });

  it("handles filler variations with repeated letters", () => {
    assert.equal(removeFillers("So uhhh yeah"), "So yeah");
    assert.equal(removeFillers("So ummm yeah"), "So yeah");
    assert.equal(removeFillers("So hmmm yeah"), "So hmmm yeah");
    assert.equal(removeFillers("So eeeee yeah"), "So yeah");
    assert.equal(removeFillers("So yyyy yeah"), "So yeah");
  });

  // False positive protection: real words must NOT be removed

  it("preserves real words containing filler substrings", () => {
    assert.equal(removeFillers("The umbrella is here."), "The umbrella is here.");
    assert.equal(removeFillers("She is human."), "She is human.");
    assert.equal(removeFillers("Check the ohms."), "Check the ohms.");
    assert.equal(removeFillers("It is yummy."), "It is yummy.");
    assert.equal(removeFillers("Hot summer day."), "Hot summer day.");
  });

  it("preserves 'Oh' as a real exclamation", () => {
    assert.equal(removeFillers("Oh really?"), "Oh really?");
    assert.equal(removeFillers("Oh, that is nice."), "Oh, that is nice.");
    assert.equal(removeFillers("oh no!"), "oh no!");
    assert.equal(removeFillers("Hello. Oh, nice!"), "Hello. Oh, nice!");
  });

  it("preserves 'Ah' as a real exclamation", () => {
    assert.equal(removeFillers("Ah, I see."), "Ah, I see.");
    assert.equal(removeFillers("done. Ah, great."), "done. Ah, great.");
  });

  it("preserves short tokens like 'ee' and 'hm'", () => {
    assert.equal(removeFillers("I see ee in the code"), "I see ee in the code");
    assert.equal(removeFillers("Hm, interesting."), "Hm, interesting.");
  });

  // Unicode capitalization

  it("capitalizes Unicode letters after filler at sentence boundary", () => {
    assert.equal(
      removeFillers("done. Yyy, ćwiczenie. Eee, ósmy. Um, świetnie"),
      "done. Ćwiczenie. Ósmy. Świetnie"
    );
  });

  it("capitalizes accented Latin letters after filler", () => {
    assert.equal(removeFillers("bien. Um, él sabe"), "bien. Él sabe");
  });

  it("capitalizes Cyrillic letters after filler", () => {
    assert.equal(removeFillers("done. Uhh, это работает"), "done. Это работает");
  });

  it("does not capitalize mid-sentence after filler removal", () => {
    assert.equal(removeFillers("I uh think so"), "I think so");
    assert.equal(removeFillers("let's um try"), "let's try");
  });

  it("does not capitalize first letter when no leading filler was removed", () => {
    assert.equal(removeFillers("iPhone is great"), "iPhone is great");
  });

  // Realistic Soniox output

  it("handles realistic Soniox output with multiple fillers", () => {
    assert.equal(
      removeFillers(
        "OK so let me think. Yyy, does this work? Hmm. Maybe it does. Eee, let me check one more time."
      ),
      "OK so let me think. Does this work? Hmm. Maybe it does. Let me check one more time."
    );
  });

  // Sentence boundary preservation

  it("preserves period when filler is mid-sentence with comma before", () => {
    assert.equal(removeFillers("I think, uh. Let me check."), "I think. Let me check.");
  });

  it("preserves period with lowercase next word and capitalizes", () => {
    assert.equal(removeFillers("it works, um. but not always."), "it works. But not always.");
  });

  it("removes period when filler is standalone sentence", () => {
    assert.equal(removeFillers("really? Uh. Maybe so."), "really? Maybe so.");
  });

  it("removes period when filler is at end of text", () => {
    assert.equal(removeFillers("that is all uh."), "that is all");
  });

  // Hyphenated words are not fillers

  it("preserves hyphenated words that start with a filler", () => {
    assert.equal(removeFillers("uh-huh"), "uh-huh");
    assert.equal(removeFillers("Uh-oh, that broke."), "Uh-oh, that broke.");
    assert.equal(removeFillers("um-hmm"), "um-hmm");
  });

  it("does not cut words where a filler substring meets a non-ASCII letter", () => {
    assert.equal(removeFillers("Umówmy się na jutro."), "Umówmy się na jutro.");
    assert.equal(removeFillers("tłum ludzi"), "tłum ludzi");
    assert.equal(removeFillers("umówiłem się, um, na jutro"), "umówiłem się na jutro");
  });

  it("keeps a quoted filler, which names the sound rather than hesitating", () => {
    assert.equal(removeFillers('dużo "yyy", dużo "hmm".'), 'dużo "yyy", dużo "hmm".');
    assert.equal(removeFillers("mówi „eee” i „yyy”"), "mówi „eee” i „yyy”");
    assert.equal(removeFillers('He said "um, I think so."'), 'He said "um, I think so."');
    assert.equal(removeFillers('I "think", um, so'), 'I "think" so');
  });

  // Punctuation is not orphaned when a filler is removed

  it("does not orphan punctuation after removing a filler", () => {
    assert.equal(removeFillers("uh?"), "");
    assert.equal(removeFillers("um!"), "");
    assert.equal(removeFillers("um..."), "");
    assert.equal(removeFillers("Um? Really."), "Really.");
    assert.equal(removeFillers("So um... yeah"), "So yeah");
  });

  // Capitalization only happens where a filler was actually removed, not
  // after every sentence-ending punctuation mark in the text.

  it("does not capitalize abbreviations or list markers with no filler removed", () => {
    assert.equal(removeFillers("e.g. the thing works"), "e.g. the thing works");
    assert.equal(removeFillers("vs. the other one"), "vs. the other one");
    assert.equal(removeFillers("ok. i.e. this"), "ok. i.e. this");
    assert.equal(removeFillers("1. first 2. second"), "1. first 2. second");
  });

  it("still capitalizes where a filler was removed", () => {
    assert.equal(removeFillers("done. Yyy, let me check"), "done. Let me check");
    assert.equal(removeFillers("it works, um. but not always."), "it works. But not always.");
  });

  // Newlines are preserved

  it("preserves newlines around a removed filler", () => {
    assert.equal(removeFillers("first line um\n\nsecond line"), "first line\n\nsecond line");
  });

  // Performance guard: no catastrophic backtracking

  it("handles a large number of fillers without catastrophic backtracking", () => {
    const start = Date.now();
    removeFillers("uh ".repeat(20000));
    assert.ok(Date.now() - start < 2000);
  });

  // Regression guard for the ambiguous `[^\S\n]*,?[^\S\n]*` prefix: a long
  // horizontal-whitespace run with no filler after it used to backtrack
  // cubically (tens of seconds at 5000 spaces; a filler right after the run
  // matches on the first attempt and never exercised it). The fix makes the
  // comma's whitespace its own optional group.
  it("handles a long whitespace run with no trailing filler without cubic backtracking", () => {
    const start = Date.now();
    const result = removeFillers("a" + " ".repeat(5000) + "b");
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 500, `expected well under 500ms, took ${elapsed}ms`);
    assert.equal(result, "a b");
  });

  // Polish abbreviations are not sentence boundaries

  it("does not capitalize after a Polish abbreviation with no filler removed", () => {
    assert.equal(removeFillers("Kup np. jabłka i gruszki."), "Kup np. jabłka i gruszki.");
  });

  it("still capitalizes before a Polish abbreviation when a filler was removed", () => {
    assert.equal(removeFillers("Yyy, kup np. jabłka."), "Kup np. jabłka.");
  });
});

describe("buildConfigMessage", () => {
  it("includes context.terms when a dictionary is provided", () => {
    const msg = buildConfigMessage({ apiKey: "k", keyterms: ["Qdrant", "Whispr"] });
    assert.deepEqual(msg.context, { terms: ["Qdrant", "Whispr"] });
  });

  it("filters empty entries out of the dictionary before sending", () => {
    const msg = buildConfigMessage({ apiKey: "k", keyterms: ["", null, "Qdrant"] });
    assert.deepEqual(msg.context, { terms: ["Qdrant"] });
  });

  it("omits context entirely when the dictionary is empty", () => {
    assert.equal(buildConfigMessage({ apiKey: "k", keyterms: [] }).context, undefined);
    assert.equal(buildConfigMessage({ apiKey: "k" }).context, undefined);
  });

  it("builds language_hints from the base code of language alone when there are no extras", () => {
    assert.deepEqual(buildConfigMessage({ apiKey: "k", language: "pl" }).language_hints, ["pl"]);
  });

  it("builds language_hints with the main language first, then extras in order", () => {
    assert.deepEqual(
      buildConfigMessage({ apiKey: "k", language: "pl", extraLanguages: ["en-US", "de"] })
        .language_hints,
      ["pl", "en", "de"]
    );
  });

  it("dedupes an extra that collapses to the same base as another extra or the main language", () => {
    assert.deepEqual(
      buildConfigMessage({
        apiKey: "k",
        language: "en",
        extraLanguages: ["en-US", "de", "de-DE"],
      }).language_hints,
      ["en", "de"]
    );
  });

  it("drops 'auto' and missing languages from language_hints", () => {
    assert.deepEqual(buildConfigMessage({ apiKey: "k", language: "auto" }).language_hints, []);
    assert.deepEqual(buildConfigMessage({ apiKey: "k" }).language_hints, []);
  });

  // Matches the old secondaryLanguage behavior: toBaseLanguage(null) is null,
  // so a missing main language doesn't block extras from becoming hints.
  it("still hints from extras when the main language is unset", () => {
    assert.deepEqual(
      buildConfigMessage({ apiKey: "k", extraLanguages: ["pl", "auto"] }).language_hints,
      ["pl"]
    );
  });

  it("takes sample_rate from options, defaulting to 16000", () => {
    assert.equal(buildConfigMessage({ apiKey: "k" }).sample_rate, 16000);
    assert.equal(buildConfigMessage({ apiKey: "k", sampleRate: 8000 }).sample_rate, 8000);
  });

  it("defaults the model to stt-rt-v5", () => {
    assert.equal(buildConfigMessage({ apiKey: "k" }).model, DEFAULT_MODEL);
  });

  // Guards against a stale model imported from another provider (or a retired
  // Soniox model id) — same rule resolveByokModel applies in transcriptionRoute.ts.
  it("falls back to DEFAULT_MODEL when the model isn't a Soniox realtime model", () => {
    assert.equal(buildConfigMessage({ apiKey: "k", model: "whisper-1" }).model, DEFAULT_MODEL);
    assert.equal(buildConfigMessage({ apiKey: "k", model: "" }).model, DEFAULT_MODEL);
    assert.equal(buildConfigMessage({ apiKey: "k", model: "stt-rt-v4" }).model, "stt-rt-v4");
  });

  it("dedupes language_hints when an extra resolves to the same base as the primary", () => {
    assert.deepEqual(
      buildConfigMessage({ apiKey: "k", language: "en", extraLanguages: ["en-US"] }).language_hints,
      ["en"]
    );
  });
});

describe("buildWebSocketUrl", () => {
  it("resolves the US endpoint by default", () => {
    const streaming = new SonioxStreaming();
    assert.equal(streaming.buildWebSocketUrl({}), "wss://stt-rt.soniox.com/transcribe-websocket");
  });

  it("resolves the EU endpoint for region eu", () => {
    const streaming = new SonioxStreaming();
    assert.equal(
      streaming.buildWebSocketUrl({ region: "eu" }),
      "wss://stt-rt.eu.soniox.com/transcribe-websocket"
    );
  });

  it("resolves the Japan endpoint for region jp", () => {
    const streaming = new SonioxStreaming();
    assert.equal(
      streaming.buildWebSocketUrl({ region: "jp" }),
      "wss://stt-rt.jp.soniox.com/transcribe-websocket"
    );
  });

  it("resolves the India endpoint for region in", () => {
    const streaming = new SonioxStreaming();
    assert.equal(
      streaming.buildWebSocketUrl({ region: "in" }),
      "wss://stt-rt.in.soniox.com/transcribe-websocket"
    );
  });

  it("falls back to the US endpoint for an unknown region", () => {
    const streaming = new SonioxStreaming();
    assert.equal(
      streaming.buildWebSocketUrl({ region: "xx" }),
      "wss://stt-rt.soniox.com/transcribe-websocket"
    );
  });

  it("treats an Object.prototype key as an unknown region, not a host", () => {
    const streaming = new SonioxStreaming();
    assert.equal(
      streaming.buildWebSocketUrl({ region: "constructor" }),
      "wss://stt-rt.soniox.com/transcribe-websocket"
    );
  });

  it("SONIOX_WS_URL overrides the region select entirely", () => {
    const streaming = new SonioxStreaming();
    const prev = process.env.SONIOX_WS_URL;
    process.env.SONIOX_WS_URL = "wss://proxy.internal/ws";
    try {
      assert.equal(streaming.buildWebSocketUrl({ region: "eu" }), "wss://proxy.internal/ws");
      assert.equal(streaming.buildWebSocketUrl({}), "wss://proxy.internal/ws");
    } finally {
      if (prev === undefined) delete process.env.SONIOX_WS_URL;
      else process.env.SONIOX_WS_URL = prev;
    }
  });

  // wss: is accepted for any host; ws: only for a host that never leaves the
  // machine or the LAN; credentials in the URL are refused regardless of
  // scheme; an unparseable value is refused the same way. Every refusal falls
  // back to the region host and logs exactly one warning (host only, never
  // the URL, which could carry the credentials it was refused for).
  const wsUrlCases = [
    { value: "ws://203.0.113.5/x", accepted: false, reason: "public host over ws:" },
    { value: "ws://127.0.0.1:1234/x", accepted: true, reason: "loopback host over ws:" },
    { value: "ws://10.0.0.7/x", accepted: true, reason: "private host over ws:" },
    { value: "wss://u:p@host/x", accepted: false, reason: "credentials in the URL" },
    { value: "not a url", accepted: false, reason: "unparseable value" },
  ];

  for (const { value, accepted, reason } of wsUrlCases) {
    it(`${accepted ? "accepts" : "falls back to the region host for"}: ${reason}`, () => {
      const streaming = new SonioxStreaming();
      const prevUrl = process.env.SONIOX_WS_URL;
      process.env.SONIOX_WS_URL = value;
      const warnMock = mock.method(debugLogger, "warn", () => {});
      try {
        const url = streaming.buildWebSocketUrl({});
        if (accepted) {
          assert.equal(url, value);
          assert.equal(warnMock.mock.callCount(), 0);
        } else {
          assert.equal(url, "wss://stt-rt.soniox.com/transcribe-websocket");
          assert.equal(warnMock.mock.callCount(), 1);
        }
      } finally {
        warnMock.mock.restore();
        if (prevUrl === undefined) delete process.env.SONIOX_WS_URL;
        else process.env.SONIOX_WS_URL = prevUrl;
      }
    });
  }
});

// Loopback Soniox: connect()/warmup() resolve on the socket opening, so the
// server doesn't need to reply for either to settle. Each accepted connection
// is recorded with the messages it received and whether it was later closed.
async function withSonioxServer(run) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  const url = `ws://127.0.0.1:${server.address().port}/transcribe-websocket`;
  const connections = [];
  server.on("connection", (socket) => {
    const entry = { socket, messages: [], closed: false };
    socket.on("message", (data) => entry.messages.push(data.toString()));
    socket.on("close", () => {
      entry.closed = true;
    });
    connections.push(entry);
  });

  try {
    await run(url, connections, server);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe("warm connection promotion (loopback)", () => {
  it("reuses the warm socket when identity matches: one socket, config sent once", async () => {
    await withSonioxServer(async (url, connections) => {
      const streaming = new SonioxStreaming();
      streaming.buildWebSocketUrl = () => url;
      // A non-default model: currentModel starts at DEFAULT_MODEL, so only a
      // different id proves the promoted session recorded what was sent.
      const options = { apiKey: "k", mode: "byok", model: "stt-rt-v4", region: "us" };
      try {
        await streaming.warmup(options);
        await streaming.connect(options);
        await wait(20);

        assert.equal(connections.length, 1, "the warm socket was reused, not a second one opened");
        assert.equal(connections[0].messages.length, 1, "config was sent once, during warmup");
        assert.equal(JSON.parse(connections[0].messages[0]).model, "stt-rt-v4");
        assert.equal(streaming.isConnected, true);
        assert.equal(streaming.currentModel, "stt-rt-v4");
      } finally {
        streaming.cleanupAll();
      }
    });
  });

  it("cold-starts and closes the warm socket when identity differs (region)", async () => {
    await withSonioxServer(async (url, connections) => {
      const streaming = new SonioxStreaming();
      streaming.buildWebSocketUrl = () => url;
      try {
        await streaming.warmup({ apiKey: "k", mode: "byok", region: "us" });
        await streaming.connect({ apiKey: "k", mode: "byok", region: "eu" });
        await wait(20);

        assert.equal(connections.length, 2, "a second, cold socket was opened");
        assert.equal(connections[0].closed, true, "the mismatched warm socket was closed");
        assert.equal(streaming.isConnected, true);
        assert.equal(streaming.hasWarmConnection(), false);
      } finally {
        streaming.cleanupAll();
      }
    });
  });

  it("reuses the warm socket when region is undefined and the session requests us (same normalized region)", async () => {
    await withSonioxServer(async (url, connections) => {
      const streaming = new SonioxStreaming();
      streaming.buildWebSocketUrl = () => url;
      try {
        await streaming.warmup({ apiKey: "k", mode: "byok" });
        await streaming.connect({ apiKey: "k", mode: "byok", region: "us" });
        await wait(20);

        assert.equal(connections.length, 1, "the warm socket was reused, not a second one opened");
        assert.equal(streaming.isConnected, true);
      } finally {
        streaming.cleanupAll();
      }
    });
  });

  it("cold-starts when region is undefined but the session requests jp (different normalized region)", async () => {
    await withSonioxServer(async (url, connections) => {
      const streaming = new SonioxStreaming();
      streaming.buildWebSocketUrl = () => url;
      try {
        await streaming.warmup({ apiKey: "k", mode: "byok" });
        await streaming.connect({ apiKey: "k", mode: "byok", region: "jp" });
        await wait(20);

        assert.equal(connections.length, 2, "a second, cold socket was opened");
        assert.equal(connections[0].closed, true, "the mismatched warm socket was closed");
        assert.equal(streaming.isConnected, true);
        assert.equal(streaming.hasWarmConnection(), false);
      } finally {
        streaming.cleanupAll();
      }
    });
  });

  it("closes the warm socket after its idle timeout elapses unused", async () => {
    await withSonioxServer(async (url, connections) => {
      const streaming = new SonioxStreaming();
      streaming.buildWebSocketUrl = () => url;
      try {
        await streaming.warmup({ apiKey: "k", mode: "byok", idleTimeoutMs: 30 });
        assert.equal(streaming.hasWarmConnection(), true);

        await wait(80);

        assert.equal(streaming.hasWarmConnection(), false, "idle timeout closed the warm socket");
        assert.equal(connections[0].closed, true);
      } finally {
        streaming.cleanupAll();
      }
    });
  });

  it("cold-starts when the extra languages differ from the warmed-up set", async () => {
    await withSonioxServer(async (url, connections) => {
      const streaming = new SonioxStreaming();
      streaming.buildWebSocketUrl = () => url;
      try {
        await streaming.warmup({
          apiKey: "k",
          mode: "byok",
          language: "en",
          extraLanguages: ["pl"],
        });
        await streaming.connect({
          apiKey: "k",
          mode: "byok",
          language: "en",
          extraLanguages: ["de"],
        });
        await wait(20);

        assert.equal(connections.length, 2, "a second, cold socket was opened");
        assert.equal(connections[0].closed, true, "the mismatched warm socket was closed");
        assert.equal(streaming.isConnected, true);
      } finally {
        streaming.cleanupAll();
      }
    });
  });

  it("cold-starts when the filler-removal flag differs from the warmed-up session", async () => {
    await withSonioxServer(async (url, connections) => {
      const streaming = new SonioxStreaming();
      streaming.buildWebSocketUrl = () => url;
      try {
        await streaming.warmup({ apiKey: "k", mode: "byok", removeFillers: true });
        await streaming.connect({ apiKey: "k", mode: "byok", removeFillers: false });
        await wait(20);

        assert.equal(connections.length, 2, "a second, cold socket was opened");
        assert.equal(connections[0].closed, true, "the mismatched warm socket was closed");
        assert.equal(streaming.isConnected, true);
      } finally {
        streaming.cleanupAll();
      }
    });
  });
});

describe("message handling (loopback)", () => {
  it("routes an error_code message to onError and tears the session down once the socket closes", async () => {
    await withSonioxServer(async (url, connections) => {
      const streaming = new SonioxStreaming();
      streaming.buildWebSocketUrl = () => url;
      const errors = [];
      let sessionEnded = false;
      streaming.onError = (err) => errors.push(err);
      streaming.onSessionEnd = () => {
        sessionEnded = true;
      };
      try {
        await streaming.connect({ apiKey: "k", mode: "byok" });
        connections[0].socket.send(
          JSON.stringify({ error_code: 400, error_message: "bad request" })
        );
        await wait(20);

        assert.equal(errors.length, 1);
        assert.match(errors[0].message, /Soniox error 400: bad request/);
        assert.equal(streaming.isConnected, true, "an error alone doesn't end the session");

        connections[0].socket.close();
        await wait(20);

        assert.equal(
          streaming.isConnected,
          false,
          "the session was torn down once the socket closed"
        );
        assert.equal(sessionEnded, true);
      } finally {
        streaming.cleanupAll();
      }
    });
  });

  it("joins BPE sub-word tokens without losing intentional spaces, dropping <fin>/<end> markers", () => {
    const streaming = new SonioxStreaming();
    const finalTexts = [];
    streaming.onFinalTranscript = (text) => finalTexts.push(text);

    streaming.handleMessage(
      JSON.stringify({
        tokens: [
          { text: "Hel", is_final: true },
          { text: "lo", is_final: true },
          { text: " world", is_final: true },
          { text: "<fin>", is_final: true },
          { text: "<end>", is_final: true },
        ],
      })
    );

    assert.equal(streaming.getFullTranscript(), "Hello world");
    assert.equal(finalTexts.at(-1), "Hello world");
  });

  it("reports the <fin> marker after the finals it closes", () => {
    const streaming = new SonioxStreaming();
    const events = [];
    streaming.onFinalTranscript = (text) => events.push(["final", text]);
    streaming.onFinalized = () => events.push(["finalized"]);

    streaming.handleMessage(JSON.stringify({ tokens: [{ text: "Hi", is_final: true }] }));
    streaming.handleMessage(
      JSON.stringify({
        tokens: [
          { text: " there", is_final: true },
          { text: "<fin>", is_final: true },
        ],
      })
    );

    assert.deepEqual(events, [["final", "Hi"], ["final", "Hi there"], ["finalized"]]);
  });

  it("emits the committed text as final and only the non-final tail as partial", () => {
    const streaming = new SonioxStreaming();
    const events = [];
    streaming.onPartialTranscript = (text) => events.push(["partial", text]);
    streaming.onFinalTranscript = (text) => events.push(["final", text]);

    streaming.handleMessage(
      JSON.stringify({
        tokens: [
          { text: "Hello", is_final: false },
          { text: " wor", is_final: false },
        ],
      })
    );
    streaming.handleMessage(
      JSON.stringify({
        tokens: [
          { text: "Hello", is_final: true },
          { text: " world", is_final: false },
          { text: " how", is_final: false },
        ],
      })
    );

    // The consumer shows `final + " " + partial`; a partial that repeated the
    // committed text would render "Hello Hello world how" in the live preview.
    assert.deepEqual(events, [
      ["partial", "Hello wor"],
      ["final", "Hello"],
      ["partial", "world how"],
    ]);
  });

  it("strips fillers from final and partial text by default", () => {
    const streaming = new SonioxStreaming();
    const events = [];
    streaming.onFinalTranscript = (text) => events.push(["final", text]);
    streaming.onPartialTranscript = (text) => events.push(["partial", text]);

    streaming.handleMessage(JSON.stringify({ tokens: [{ text: "Um, hello", is_final: true }] }));
    streaming.handleMessage(JSON.stringify({ tokens: [{ text: "um there", is_final: false }] }));

    assert.deepEqual(events, [
      ["final", "Hello"],
      ["partial", ""],
      ["partial", "There"],
    ]);
  });

  it("leaves fillers untouched in final and partial text when removeFillers is disabled", () => {
    const streaming = new SonioxStreaming();
    streaming.removeFillersEnabled = false;
    const events = [];
    streaming.onFinalTranscript = (text) => events.push(["final", text]);
    streaming.onPartialTranscript = (text) => events.push(["partial", text]);

    streaming.handleMessage(JSON.stringify({ tokens: [{ text: "Um, hello", is_final: true }] }));
    streaming.handleMessage(JSON.stringify({ tokens: [{ text: "um there", is_final: false }] }));

    assert.deepEqual(events, [
      ["final", "Um, hello"],
      ["partial", ""],
      ["partial", "um there"],
    ]);
  });

  it("finalize + drain returns a trimmed transcript", async () => {
    await withSonioxServer(async (url, connections) => {
      const streaming = new SonioxStreaming();
      streaming.buildWebSocketUrl = () => url;
      try {
        await streaming.connect({ apiKey: "k", mode: "byok" });
        const socket = connections[0].socket;
        socket.on("message", (data, isBinary) => {
          if (isBinary) return; // raw PCM audio frame, not a control message
          const text = data.toString();
          if (text === "") return; // end-of-audio marker; no reply needed
          const msg = JSON.parse(text);
          if (msg.type === "finalize") {
            socket.send(
              JSON.stringify({
                tokens: [
                  { text: "  Hello world  ", is_final: true },
                  { text: "<fin>", is_final: true },
                ],
              })
            );
          }
        });

        // disconnect() waits for <fin> through a wrapper around onFinalized;
        // the callback underneath (the IPC emit in production) must still fire
        // once and be restored, or the renderer's settle wait runs to its ceiling.
        let finalizedCalls = 0;
        const onFinalized = () => finalizedCalls++;
        streaming.onFinalized = onFinalized;

        streaming.sendAudio(Buffer.alloc(10));
        const result = await streaming.disconnect(true);
        assert.equal(result.text, "Hello world");
        assert.equal(finalizedCalls, 1);
        assert.equal(streaming.onFinalized, onFinalized);
      } finally {
        streaming.cleanupAll();
      }
    });
  });

  it("a clean server close mid-session notifies onSessionEnd then onError once, and sendAudio then returns false", async () => {
    await withSonioxServer(async (url, connections) => {
      const streaming = new SonioxStreaming();
      streaming.buildWebSocketUrl = () => url;
      const events = [];
      streaming.onSessionEnd = () => events.push("sessionEnd");
      streaming.onError = () => events.push("error");
      try {
        await streaming.connect({ apiKey: "k", mode: "byok" });
        const clientWs = streaming.ws;
        const closed = new Promise((resolve) => clientWs.once("close", resolve));
        connections[0].socket.close(1000);
        await closed;

        assert.deepEqual(events, ["sessionEnd", "error"]);
        assert.equal(streaming.sendAudio(Buffer.from("x")), false);

        // A stray error on the now-superseded socket must not notify again —
        // the stale guard in attachSessionHandlers (backed by
        // connectionLossNotified) drops it.
        clientWs.emit("error", new Error("late, stale error"));
        assert.deepEqual(events, ["sessionEnd", "error"]);
      } finally {
        streaming.cleanupAll();
      }
    });
  });

  it("<fin>-only reply lets disconnect(true) return promptly without waiting for finished", async () => {
    await withSonioxServer(async (url, connections) => {
      const streaming = new SonioxStreaming();
      streaming.buildWebSocketUrl = () => url;
      try {
        await streaming.connect({ apiKey: "k", mode: "byok" });
        const socket = connections[0].socket;
        // disconnect() sends the end-of-audio marker and closes without
        // waiting for the server to acknowledge it, so the assertions below
        // wait for the server to actually observe it rather than trusting
        // that disconnect() having resolved means the frame has arrived.
        const markerReceived = new Promise((resolve) => {
          socket.on("message", (data, isBinary) => {
            if (isBinary) return;
            const text = data.toString();
            if (text === "") {
              resolve();
              return; // end-of-audio marker; the server never answers with "finished"
            }
            const msg = JSON.parse(text);
            if (msg.type === "finalize") {
              socket.send(
                JSON.stringify({
                  tokens: [
                    { text: "hello", is_final: true },
                    { text: "<fin>", is_final: true },
                  ],
                })
              );
            }
          });
        });

        streaming.sendAudio(Buffer.alloc(10));
        streaming.finalize();
        const start = Date.now();
        const result = await streaming.disconnect(true);
        const elapsed = Date.now() - start;
        await markerReceived;

        assert.ok(elapsed < 1000, `expected well under DISCONNECT_TIMEOUT_MS, took ${elapsed}ms`);
        assert.equal(result.text, "hello");
        const textFrames = connections[0].messages.filter((m) => {
          if (m === "") return true;
          try {
            JSON.parse(m);
            return true;
          } catch {
            return false;
          }
        });
        assert.equal(textFrames.length, 3, "config, finalize, and the end-of-audio marker only");
        assert.equal(textFrames[2], "");
      } finally {
        streaming.cleanupAll();
      }
    });
  });

  it("disconnect(true) sends finalize itself, waits for <fin>, then the end-of-audio marker, when the caller never called finalize()", async () => {
    await withSonioxServer(async (url, connections) => {
      const streaming = new SonioxStreaming();
      streaming.buildWebSocketUrl = () => url;
      try {
        await streaming.connect({ apiKey: "k", mode: "byok" });
        const socket = connections[0].socket;
        // connections[0].messages (populated by withSonioxServer's own
        // listener, attached at connection time) is used for the assertions
        // below instead of a listener added here: the config message can
        // still be in flight to the server when this test's setup runs, and
        // a listener added late could race that delivery.
        const markerReceived = new Promise((resolve) => {
          socket.on("message", (data, isBinary) => {
            if (isBinary) return;
            const text = data.toString();
            if (text === "") {
              resolve();
              return;
            }
            const msg = JSON.parse(text);
            if (msg.type === "finalize") {
              socket.send(
                JSON.stringify({
                  tokens: [
                    { text: "done", is_final: true },
                    { text: "<fin>", is_final: true },
                  ],
                })
              );
            }
          });
        });

        streaming.sendAudio(Buffer.alloc(10));
        const result = await streaming.disconnect(true);
        await markerReceived;

        const textFrames = connections[0].messages.filter((m) => {
          if (m === "") return true;
          try {
            JSON.parse(m);
            return true;
          } catch {
            return false;
          }
        });
        assert.equal(textFrames.length, 3, "config, finalize, and the end-of-audio marker only");
        assert.equal(JSON.parse(textFrames[1]).type, "finalize");
        assert.equal(textFrames[2], "");
        assert.equal(result.text, "done");
      } finally {
        streaming.cleanupAll();
      }
    });
  });

  it("closes on the keep-alive idle timeout: onSessionEnd then onError", async () => {
    await withSonioxServer(async (url) => {
      const streaming = new SonioxStreaming();
      streaming.buildWebSocketUrl = () => url;
      const events = [];
      streaming.onSessionEnd = () => events.push("sessionEnd");
      streaming.onError = () => events.push("error");
      mock.timers.enable({ apis: ["setInterval", "Date"] });
      try {
        await streaming.connect({ apiKey: "k", mode: "byok" });
        mock.timers.tick(KEEPALIVE_IDLE_LIMIT_MS_FOR_TEST + KEEPALIVE_INTERVAL_MS_FOR_TEST);
        assert.deepEqual(events, ["sessionEnd", "error"]);
      } finally {
        mock.timers.reset();
        streaming.cleanupAll();
      }
    });
  });
});

describe("connect lifecycle (loopback)", () => {
  it("disconnect() while CONNECTING rejects connect() and leaves no timer running", async () => {
    // A raw TCP server that accepts the connection but never completes the
    // WebSocket upgrade, so the client socket stays in CONNECTING.
    const server = net.createServer((socket) => {
      socket.on("error", () => {});
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    const streaming = new SonioxStreaming();
    streaming.buildWebSocketUrl = () => `ws://127.0.0.1:${port}/transcribe-websocket`;
    try {
      const connectPromise = streaming.connect({ apiKey: "k", mode: "byok" });
      assert.equal(streaming.ws?.readyState, WebSocket.CONNECTING);

      const disconnectPromise = streaming.disconnect(true);
      await assert.rejects(connectPromise);
      await disconnectPromise;

      assert.equal(streaming.connectionTimeout, null);
    } finally {
      streaming.cleanupAll();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("two connect() calls before open share one socket and both promises resolve", async () => {
    await withSonioxServer(async (url, connections) => {
      const streaming = new SonioxStreaming();
      streaming.buildWebSocketUrl = () => url;
      try {
        const p1 = streaming.connect({ apiKey: "k", mode: "byok" });
        const p2 = streaming.connect({ apiKey: "k", mode: "byok" });
        const [r1, r2] = await Promise.all([p1, p2]);

        assert.deepEqual(r1, { promoted: false });
        assert.deepEqual(r2, { promoted: false });
        assert.equal(connections.length, 1, "only one socket was opened");
        assert.equal(streaming.isConnected, true);
      } finally {
        streaming.cleanupAll();
      }
    });
  });

  it("connect() reports whether it promoted a warm socket", async () => {
    await withSonioxServer(async (url) => {
      const streaming = new SonioxStreaming();
      streaming.buildWebSocketUrl = () => url;
      const options = { apiKey: "k", mode: "byok" };
      try {
        const cold = await streaming.connect(options);
        assert.deepEqual(cold, { promoted: false });
        await streaming.disconnect(false);

        await streaming.warmup(options);
        const warm = await streaming.connect(options);
        assert.deepEqual(warm, { promoted: true });
      } finally {
        streaming.cleanupAll();
      }
    });
  });
});

describe("finalize", () => {
  it("returns false when there is no open socket", () => {
    const streaming = new SonioxStreaming();
    assert.equal(streaming.finalize(), false);
  });
});

// Mirrors sonioxStreaming.js's own COLD_START_BUFFER_MAX (not exported: it's
// an internal cap, not part of the module's public contract).
const COLD_START_BUFFER_MAX_FOR_TEST = 3 * 16000 * 2;

describe("audio buffering while a connection is imminent (loopback)", () => {
  it("buffers frames sent between warmup() and connect(), flushing them in order after warm promotion", async () => {
    await withSonioxServer(async (url, connections) => {
      const streaming = new SonioxStreaming();
      streaming.buildWebSocketUrl = () => url;
      const options = { apiKey: "k", mode: "byok" };
      try {
        await streaming.warmup(options);

        // this.ws is still null here — only the warm socket is open — so this
        // is exactly the gap sendAudio must buffer rather than drop.
        assert.equal(streaming.sendAudio(Buffer.from("frame-1")), true);
        assert.equal(streaming.sendAudio(Buffer.from("frame-2")), true);

        await streaming.connect(options);
        await wait(20);

        assert.equal(
          connections.length,
          1,
          "the warm socket was promoted, not a second one opened"
        );
        assert.deepEqual(
          connections[0].messages.slice(1),
          ["frame-1", "frame-2"],
          "buffered frames arrive in order, after the config message warmup already sent"
        );
        assert.equal(streaming.isConnected, true);
      } finally {
        streaming.cleanupAll();
      }
    });
  });

  it("buffers frames sent during a cold-start handshake, flushing them after config", async () => {
    await withSonioxServer(async (url, connections) => {
      const streaming = new SonioxStreaming();
      streaming.buildWebSocketUrl = () => url;
      try {
        const connectPromise = streaming.connect({ apiKey: "k", mode: "byok" });

        // The socket is CONNECTING at this point (assigned synchronously by
        // `new WebSocket()` before connect()'s first await).
        assert.equal(streaming.sendAudio(Buffer.from("frame-1")), true);

        await connectPromise;
        await wait(20);

        assert.equal(connections.length, 1);
        assert.equal(connections[0].messages.length, 2, "config, then the buffered frame");
        assert.doesNotThrow(() => JSON.parse(connections[0].messages[0]));
        assert.equal(connections[0].messages[1], "frame-1");
      } finally {
        streaming.cleanupAll();
      }
    });
  });

  it("keeps frames buffered before connect() when the warm socket's identity does not match", async () => {
    await withSonioxServer(async (url, connections) => {
      const streaming = new SonioxStreaming();
      streaming.buildWebSocketUrl = () => url;
      try {
        await streaming.warmup({ apiKey: "k", mode: "byok", region: "us" });
        assert.equal(streaming.sendAudio(Buffer.from("frame-1")), true);

        await streaming.connect({ apiKey: "k", mode: "byok", region: "eu" });
        await wait(20);

        assert.equal(connections.length, 2, "identity mismatch opened a cold socket");
        assert.equal(connections[1].messages.length, 2, "config, then the buffered frame");
        assert.equal(connections[1].messages[1], "frame-1");
      } finally {
        streaming.cleanupAll();
      }
    });
  });

  // After the server ends a session, the renderer keeps sending for a moment
  // before it notices; with a warm socket ready those frames get buffered. The
  // stop that always follows must discard them so they never open the next
  // session as stale audio.
  it("drops frames buffered after an abnormal session end once the renderer stops", async () => {
    await withSonioxServer(async (url, connections) => {
      const streaming = new SonioxStreaming();
      streaming.buildWebSocketUrl = () => url;
      const options = { apiKey: "k", mode: "byok" };
      try {
        await streaming.connect(options);
        connections[0].socket.close();
        await wait(20);
        assert.equal(streaming.isConnected, false);

        await streaming.warmup(options);
        assert.equal(streaming.sendAudio(Buffer.from("stale")), true);
        await streaming.disconnect(true);

        assert.equal(streaming.sendAudio(Buffer.from("fresh")), true);
        await streaming.connect(options);
        await wait(20);

        assert.deepEqual(connections[1].messages.slice(1), ["fresh"]);
      } finally {
        streaming.cleanupAll();
      }
    });
  });

  // A cold connect that errors or times out ends in cleanup() without a stop;
  // frames buffered for it must not wait there for the next session.
  it("cleanup() discards frames buffered for a session that never opened", async () => {
    await withSonioxServer(async (url) => {
      const streaming = new SonioxStreaming();
      streaming.buildWebSocketUrl = () => url;
      streaming.connect({ apiKey: "k", mode: "byok" }).catch(() => {});
      assert.equal(streaming.sendAudio(Buffer.from("frame-1")), true);
      assert.ok(streaming.coldStartBufferSize > 0);

      streaming.cleanup();

      assert.equal(streaming.coldStartBufferSize, 0);
      assert.deepEqual(streaming.coldStartBuffer, []);
    });
  });

  it("returns false with no socket and no connect in progress (a real drop)", () => {
    const streaming = new SonioxStreaming();
    assert.equal(streaming.sendAudio(Buffer.from("frame")), false);
  });

  it("stops buffering once COLD_START_BUFFER_MAX is exceeded: false, and the buffer does not keep growing", async () => {
    await withSonioxServer(async (url) => {
      const streaming = new SonioxStreaming();
      streaming.buildWebSocketUrl = () => url;
      try {
        const connectPromise = streaming.connect({ apiKey: "k", mode: "byok" });

        const chunk = Buffer.alloc(20000);
        let accepted = true;
        while (accepted) {
          accepted = streaming.sendAudio(chunk);
        }

        // The last accepted chunk can push the total slightly past the cap
        // (the check runs before the push, same as before this slice) —
        // what matters is that it stopped, not the exact byte count.
        assert.ok(
          streaming.coldStartBufferSize >= COLD_START_BUFFER_MAX_FOR_TEST,
          "buffered up to the cap before refusing"
        );
        const sizeAtCap = streaming.coldStartBufferSize;

        assert.equal(streaming.sendAudio(chunk), false, "further frames are real drops once full");
        assert.equal(
          streaming.coldStartBufferSize,
          sizeAtCap,
          "the buffer does not grow past the cap"
        );

        await connectPromise;
      } finally {
        streaming.cleanupAll();
      }
    });
  });
});

describe("connect", () => {
  it("rejects a non-byok mode (Soniox has no managed credential path)", async () => {
    const streaming = new SonioxStreaming();
    await assert.rejects(
      streaming.connect({ apiKey: "k", mode: "openwhispr" }),
      /Soniox is available only with your own API key/
    );
  });

  it("requires an API key", async () => {
    const streaming = new SonioxStreaming();
    await assert.rejects(streaming.connect({ mode: "byok" }), /Soniox API key is required/);
  });

  // The start handler runs disconnect(false) straight into connect(): the old
  // socket's close event lands a round-trip later, while the new one is still
  // in its handshake, and must not reject or tear that one down.
  it("survives a stale socket closing during the next connect (loopback)", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise((resolve) => server.once("listening", resolve));
    const url = `ws://127.0.0.1:${server.address().port}/transcribe-websocket`;
    const streaming = new SonioxStreaming();
    streaming.buildWebSocketUrl = () => url;
    const options = { apiKey: "k", mode: "byok" };
    try {
      await streaming.connect(options);
      await streaming.disconnect(false);
      await streaming.connect(options);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(streaming.isConnected, true);
      assert.equal(server.clients.size, 1, "only the new session socket is open");
    } finally {
      streaming.cleanupAll();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
