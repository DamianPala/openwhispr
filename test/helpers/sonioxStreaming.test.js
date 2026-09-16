const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { WebSocketServer } = require("ws");
const SonioxStreaming = require("../../src/helpers/sonioxStreaming");

const { removeFillers, buildConfigMessage, DEFAULT_MODEL } = SonioxStreaming;

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

  it("builds language_hints from the base codes of language and secondaryLanguage", () => {
    assert.deepEqual(
      buildConfigMessage({ apiKey: "k", language: "pl", secondaryLanguage: "en-US" })
        .language_hints,
      ["pl", "en"]
    );
  });

  it("drops 'auto' and missing languages from language_hints", () => {
    assert.deepEqual(buildConfigMessage({ apiKey: "k", language: "auto" }).language_hints, []);
    assert.deepEqual(buildConfigMessage({ apiKey: "k" }).language_hints, []);
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

  it("dedupes language_hints when the secondary language resolves to the same base as the primary", () => {
    assert.deepEqual(
      buildConfigMessage({ apiKey: "k", language: "en", secondaryLanguage: "en-US" })
        .language_hints,
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
          if (text === "") {
            socket.send(JSON.stringify({ finished: true }));
            return;
          }
          const msg = JSON.parse(text);
          if (msg.type === "finalize") {
            socket.send(JSON.stringify({ tokens: [{ text: "  Hello world  ", is_final: true }] }));
          }
        });

        streaming.sendAudio(Buffer.alloc(10));
        await wait(20);

        const result = await streaming.disconnect(true);
        assert.equal(result.text, "Hello world");
      } finally {
        streaming.cleanupAll();
      }
    });
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
