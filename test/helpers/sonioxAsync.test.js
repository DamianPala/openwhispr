const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const {
  transcribeRecording,
  settleCleanups,
  asyncDeadlineMs,
  SONIOX_API_HOSTS,
  ASYNC_MODEL,
  MAX_TERMS_CHARS,
} = require("../../src/helpers/sonioxAsync");
const { VOICE_COMMAND_TERMS } = require("../../src/helpers/sonioxStreaming");

const FILE_ID = "11111111-1111-1111-1111-111111111111";
const JOB_ID = "22222222-2222-2222-2222-222222222222";
const AUDIO = Buffer.from("fake-webm-bytes");

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

// A Soniox stand-in on loopback. `script` answers per "METHOD path"; anything it
// leaves out answers the happy path. Every request is recorded.
async function withSoniox(script, run) {
  const requests = [];
  const statuses = script.statuses ? [...script.statuses] : ["queued", "processing", "completed"];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const key = `${req.method} ${req.url}`;
      requests.push({ key, headers: req.headers, body });
      const custom = script[key];
      if (custom) return custom(res, body);
      if (key === "POST /v1/files") return json(res, 201, { id: FILE_ID, size: body.length });
      if (key === "POST /v1/transcriptions") return json(res, 201, { id: JOB_ID });
      if (key === `GET /v1/transcriptions/${JOB_ID}`) {
        const status = statuses.length > 1 ? statuses.shift() : statuses[0];
        return json(res, 200, { id: JOB_ID, status, audio_duration_ms: 4200 });
      }
      if (key === `GET /v1/transcriptions/${JOB_ID}/transcript`) {
        return json(res, 200, {
          tokens: [{ text: "Hel" }, { text: "lo" }, { text: " uh" }, { text: " world" }],
        });
      }
      if (req.method === "DELETE") return json(res, 204, {});
      return json(res, 404, { error_type: "not_found" });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await run({ baseUrl, requests });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

const keys = (requests) => requests.map((r) => r.key);
const base = {
  apiKey: "secret-key",
  audio: AUDIO,
  mimeType: "audio/webm",
  pollIntervalMs: 5,
  cleanupRetryMs: 5,
  cleanupMaxMs: 60,
};

describe("transcribeRecording", () => {
  it("uploads, transcribes, reads the tokens and deletes both resources", async () => {
    await withSoniox({}, async ({ baseUrl, requests }) => {
      const result = await transcribeRecording({
        ...base,
        baseUrl,
        language: "en-US",
        extraLanguages: ["pl"],
        keyterms: ["Soniox", "OpenWhispr"],
      });

      assert.equal(result.text, "Hello world", "fillers are removed like the stream's text");
      assert.equal(result.transcriptionId, JOB_ID);
      assert.equal(result.audioDurationMs, 4200);
      assert.equal(result.model, ASYNC_MODEL);
      await settleCleanups();

      const order = keys(requests);
      assert.deepEqual(order.slice(0, 2), ["POST /v1/files", "POST /v1/transcriptions"]);
      assert.equal(order.filter((k) => k === `GET /v1/transcriptions/${JOB_ID}`).length, 3);
      assert.deepEqual(order.slice(-3), [
        `GET /v1/transcriptions/${JOB_ID}/transcript`,
        `DELETE /v1/transcriptions/${JOB_ID}`,
        `DELETE /v1/files/${FILE_ID}`,
      ]);

      for (const request of requests) {
        assert.equal(request.headers.authorization, "Bearer secret-key");
      }
      const upload = requests[0];
      assert.match(upload.headers["content-type"], /^multipart\/form-data/);
      assert.match(upload.body.toString("latin1"), /name="file"; filename="recording\.webm"/);
      assert.ok(upload.body.includes(AUDIO), "the recording is sent as it is");

      const create = JSON.parse(requests[1].body.toString());
      assert.deepEqual(create, {
        model: "stt-async-v5",
        file_id: FILE_ID,
        language_hints: ["en", "pl"],
        context: { terms: ["Soniox", "OpenWhispr"] },
      });
    });
  });

  it("keeps the fillers when told to", async () => {
    await withSoniox({}, async ({ baseUrl }) => {
      const result = await transcribeRecording({ ...base, baseUrl, removeFillers: false });
      assert.equal(result.text, "Hello uh world");
    });
  });

  describe("voice commands", () => {
    const transcriptPath = `GET /v1/transcriptions/${JOB_ID}/transcript`;
    const spoken = {
      tokens: [
        { text: "one", start_ms: 0, end_ms: 200 },
        { text: " two", start_ms: 250, end_ms: 450 },
        { text: " three", start_ms: 500, end_ms: 700 },
        { text: " CTRL", start_ms: 1700, end_ms: 1900 },
        { text: ",", start_ms: 1900, end_ms: 1950 },
        { text: " delete", start_ms: 2000, end_ms: 2200 },
        { text: " word", start_ms: 2250, end_ms: 2450 },
        { text: ".", start_ms: 2450, end_ms: 2500 },
        { text: " Four", start_ms: 2600, end_ms: 2800 },
      ],
    };
    const script = { [transcriptPath]: (res) => json(res, 200, spoken) };

    it("applies the commands to the transcript tokens when switched on", async () => {
      await withSoniox(script, async ({ baseUrl, requests }) => {
        const result = await transcribeRecording({
          ...base,
          baseUrl,
          language: "en",
          voiceCommands: true,
        });
        assert.equal(result.text, "one two four");
        const create = JSON.parse(requests[1].body.toString());
        assert.deepEqual(create.context, { terms: VOICE_COMMAND_TERMS });
      });
    });

    it("keeps the spoken command in the text when switched off", async () => {
      await withSoniox(script, async ({ baseUrl, requests }) => {
        const result = await transcribeRecording({ ...base, baseUrl, language: "en" });
        assert.equal(result.text, "one two three CTRL, delete word. Four");
        const create = JSON.parse(requests[1].body.toString());
        assert.equal("context" in create, false);
      });
    });

    it("runs the commands before the filler removal, on a reply without timing", async () => {
      const untimed = {
        tokens: [{ text: "Hello" }, { text: " uh" }, { text: " world." }, { text: " CTRL" }].concat(
          [{ text: " delete" }, { text: " word" }, { text: "." }]
        ),
      };
      await withSoniox({ [transcriptPath]: (res) => json(res, 200, untimed) }, async (server) => {
        const result = await transcribeRecording({
          ...base,
          baseUrl: server.baseUrl,
          voiceCommands: true,
        });
        assert.equal(result.text, "Hello", "the command goes, then the filler");
      });
    });

    it("reads a reply that carries only text", async () => {
      const textOnly = { text: "Hello world. CTRL, delete word." };
      await withSoniox({ [transcriptPath]: (res) => json(res, 200, textOnly) }, async (server) => {
        const result = await transcribeRecording({
          ...base,
          baseUrl: server.baseUrl,
          voiceCommands: true,
        });
        assert.equal(result.text, "Hello");
      });
    });
  });

  it("sends no hints that were not asked for", async () => {
    await withSoniox({}, async ({ baseUrl, requests }) => {
      await transcribeRecording({ ...base, baseUrl, language: "auto" });
      const create = JSON.parse(requests[1].body.toString());
      assert.deepEqual(create.language_hints, []);
      assert.equal("context" in create, false);
    });
  });

  it("cuts the dictionary to what the context limit allows", async () => {
    await withSoniox({}, async ({ baseUrl, requests }) => {
      const keyterms = Array.from({ length: 400 }, (_, i) => `term-${String(i).padStart(25, "0")}`);
      await transcribeRecording({ ...base, baseUrl, keyterms });
      const { terms } = JSON.parse(requests[1].body.toString()).context;
      assert.ok(terms.length > 0 && terms.length < keyterms.length);
      assert.ok(terms.join("").length <= MAX_TERMS_CHARS);
      assert.deepEqual(terms, keyterms.slice(0, terms.length), "the first terms are the ones kept");
    });
  });

  it("goes to the regional host the realtime client would use", async () => {
    const seen = [];
    const fetchImpl = async (url) => {
      seen.push(new URL(url).host);
      throw new Error("stop here");
    };
    for (const region of ["us", "eu", "jp", "in", "mars", undefined]) {
      await assert.rejects(transcribeRecording({ ...base, region, fetchImpl }));
    }
    assert.deepEqual(seen, [
      "api.soniox.com",
      "api.eu.soniox.com",
      "api.jp.soniox.com",
      "api.in.soniox.com",
      "api.soniox.com",
      "api.soniox.com",
    ]);
    assert.equal(SONIOX_API_HOSTS.eu, "api.eu.soniox.com");
  });

  it("retries a poll that hit a server error", async () => {
    let polls = 0;
    await withSoniox(
      {
        [`GET /v1/transcriptions/${JOB_ID}`]: (res) => {
          polls += 1;
          if (polls === 1) return json(res, 503, { error_type: "service_unavailable" });
          return json(res, 200, { status: "completed" });
        },
      },
      async ({ baseUrl }) => {
        const result = await transcribeRecording({ ...base, baseUrl });
        assert.equal(result.text, "Hello world");
        assert.equal(polls, 2);
      }
    );
  });

  it("reports a job that ends in error, and cleans up", async () => {
    await withSoniox({ statuses: ["processing", "error"] }, async ({ baseUrl, requests }) => {
      await assert.rejects(transcribeRecording({ ...base, baseUrl }), (error) => {
        assert.equal(error.code, "PROVIDER_ERROR");
        assert.equal(error.technicalDetails.provider, "Soniox");
        return true;
      });
      await settleCleanups();
      assert.deepEqual(keys(requests).slice(-2), [
        `DELETE /v1/files/${FILE_ID}`,
        `DELETE /v1/transcriptions/${JOB_ID}`,
      ]);
    });
  });

  it("marks audio Soniox cannot read so the caller can send a WAV copy", async () => {
    const invalid = (res) => json(res, 400, { error_type: "invalid_audio_file", message: "x" });
    await withSoniox({ "POST /v1/transcriptions": invalid }, async ({ baseUrl, requests }) => {
      await assert.rejects(transcribeRecording({ ...base, baseUrl }), {
        code: "PROVIDER_INVALID_AUDIO",
      });
      await settleCleanups();
      assert.deepEqual(keys(requests).slice(-1), [`DELETE /v1/files/${FILE_ID}`]);
    });

    await withSoniox(
      {
        statuses: ["error"],
        [`GET /v1/transcriptions/${JOB_ID}`]: (res) =>
          json(res, 200, { status: "error", error_type: "invalid_audio_file" }),
      },
      async ({ baseUrl }) => {
        await assert.rejects(transcribeRecording({ ...base, baseUrl }), {
          code: "PROVIDER_INVALID_AUDIO",
        });
      }
    );
  });

  it("classifies a refused request and still deletes the uploaded file", async () => {
    const noBalance = (res) =>
      json(res, 402, { error_type: "organization_balance_exhausted", message: "x" });
    await withSoniox({ "POST /v1/transcriptions": noBalance }, async ({ baseUrl, requests }) => {
      await assert.rejects(transcribeRecording({ ...base, baseUrl }), (error) => {
        assert.equal(error.code, "PROVIDER_QUOTA_EXHAUSTED");
        assert.equal(error.settingsTarget, "speechToText");
        return true;
      });
      await settleCleanups();
      assert.deepEqual(keys(requests), [
        "POST /v1/files",
        "POST /v1/transcriptions",
        `DELETE /v1/files/${FILE_ID}`,
      ]);
    });
  });

  it("classifies a rejected key and has nothing to delete", async () => {
    const unauthenticated = (res) => json(res, 401, { error_type: "unauthenticated" });
    await withSoniox({ "POST /v1/files": unauthenticated }, async ({ baseUrl, requests }) => {
      await assert.rejects(transcribeRecording({ ...base, baseUrl }), {
        code: "PROVIDER_AUTH_FAILED",
      });
      assert.deepEqual(keys(requests), ["POST /v1/files"]);
    });
  });

  it("gives up at the deadline with a timeout error and cleans up", async () => {
    await withSoniox({ statuses: ["processing"] }, async ({ baseUrl, requests }) => {
      const started = Date.now();
      await assert.rejects(transcribeRecording({ ...base, baseUrl, deadlineMs: 150 }), {
        code: "PROVIDER_TIMEOUT",
      });
      assert.ok(Date.now() - started < 2000);
      await settleCleanups();
      const deletes = keys(requests).filter((k) => k.startsWith("DELETE"));
      assert.equal(deletes[0], `DELETE /v1/files/${FILE_ID}`, "the file goes first");
      assert.ok(deletes.includes(`DELETE /v1/transcriptions/${JOB_ID}`));
    });
  });

  it("stops on cancel without calling it a failure, and cleans up", async () => {
    await withSoniox({ statuses: ["processing"] }, async ({ baseUrl, requests }) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 60);
      await assert.rejects(
        transcribeRecording({ ...base, baseUrl, signal: controller.signal }),
        (error) => {
          assert.equal(error.name, "AbortError");
          assert.equal(error.code, undefined);
          return true;
        }
      );
      await settleCleanups();
      const deletes = keys(requests).filter((k) => k.startsWith("DELETE"));
      assert.equal(deletes[0], `DELETE /v1/files/${FILE_ID}`, "the file goes first");
      assert.ok(deletes.includes(`DELETE /v1/transcriptions/${JOB_ID}`));
    });
  });

  it("deletes an abandoned job once Soniox stops calling it busy", async () => {
    let refused = 0;
    const busyTwice = (res) => {
      refused += 1;
      if (refused <= 2) return json(res, 409, { error_type: "transcription_invalid_state" });
      return json(res, 204, {});
    };
    await withSoniox(
      { statuses: ["processing"], [`DELETE /v1/transcriptions/${JOB_ID}`]: busyTwice },
      async ({ baseUrl, requests }) => {
        await assert.rejects(transcribeRecording({ ...base, baseUrl, deadlineMs: 100 }), {
          code: "PROVIDER_TIMEOUT",
        });
        await settleCleanups();
        const deletes = keys(requests).filter((k) => k.startsWith("DELETE"));
        assert.deepEqual(deletes, [
          `DELETE /v1/files/${FILE_ID}`,
          ...Array(3).fill(`DELETE /v1/transcriptions/${JOB_ID}`),
        ]);
      }
    );
  });

  it("stops retrying a transcription that stays busy", async () => {
    const busy = (res) => json(res, 409, { error_type: "transcription_invalid_state" });
    await withSoniox(
      { statuses: ["processing"], [`DELETE /v1/transcriptions/${JOB_ID}`]: busy },
      async ({ baseUrl, requests }) => {
        await assert.rejects(transcribeRecording({ ...base, baseUrl, deadlineMs: 100 }), {
          code: "PROVIDER_TIMEOUT",
        });
        await settleCleanups();
        const attempts = keys(requests).filter((k) => k === `DELETE /v1/transcriptions/${JOB_ID}`);
        assert.ok(attempts.length > 1 && attempts.length <= 12, `${attempts.length} attempts`);
      }
    );
  });

  it("hands the transcript back without waiting for the deletes", async () => {
    const held = [];
    const hold = (res) => held.push(res);
    await withSoniox(
      {
        [`DELETE /v1/transcriptions/${JOB_ID}`]: hold,
        [`DELETE /v1/files/${FILE_ID}`]: (res) => json(res, 204, {}),
      },
      async ({ baseUrl, requests }) => {
        const result = await transcribeRecording({ ...base, baseUrl });
        assert.equal(result.text, "Hello world");
        for (let i = 0; i < 100 && held.length === 0; i++) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert.equal(held.length, 1, "the transcription delete is in flight, unanswered");
        assert.equal(keys(requests).includes(`DELETE /v1/files/${FILE_ID}`), false);
        json(held[0], 204, {});
        await settleCleanups();
        assert.equal(keys(requests).at(-1), `DELETE /v1/files/${FILE_ID}`);
      }
    );
  });

  it("reports an unreachable service as such", async () => {
    const fetchImpl = async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    };
    await assert.rejects(transcribeRecording({ ...base, fetchImpl }), {
      code: "PROVIDER_UNREACHABLE",
    });
  });

  it("does not let a failed cleanup hide the transcript", async () => {
    const refuse = (res) => json(res, 409, { error_type: "transcription_invalid_state" });
    await withSoniox(
      { [`DELETE /v1/transcriptions/${JOB_ID}`]: refuse },
      async ({ baseUrl, requests }) => {
        const result = await transcribeRecording({ ...base, baseUrl });
        assert.equal(result.text, "Hello world");
        await settleCleanups();
        assert.equal(keys(requests).at(-1), `DELETE /v1/files/${FILE_ID}`);
      }
    );
  });
});

describe("asyncDeadlineMs", () => {
  it("scales with the recording between a floor and a ceiling", () => {
    assert.equal(asyncDeadlineMs(0), 30000);
    assert.equal(asyncDeadlineMs(undefined), 30000);
    assert.equal(asyncDeadlineMs(60000), 90000);
    assert.equal(asyncDeadlineMs(3600000), 300000);
  });
});
