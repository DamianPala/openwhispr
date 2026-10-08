const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

const modulePath = require.resolve("../../src/helpers/linuxAtspiServer");
const logged = [];

function loadModule() {
  const originalLoad = Module._load;
  const cachedModule = require.cache[modulePath];
  delete require.cache[modulePath];
  Module._load = function loadWithLogger(request, parent, isMain) {
    if (request === "./debugLogger") {
      const log = (level) => (message, meta) => logged.push({ level, message, meta });
      return { debug: log("debug"), info: log("info"), warn: log("warn") };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
    if (cachedModule) require.cache[modulePath] = cachedModule;
    else delete require.cache[modulePath];
  }
}

const { createLinuxAtspiServer } = loadModule();

// The child process is the boundary the client talks across; everything else in
// the client runs for real.
function createHarness(t, { binary = "/app/linux-fast-paste", mockTimers = false } = {}) {
  if (mockTimers) t.mock.timers.enable({ apis: ["setTimeout"] });
  logged.length = 0;
  const processes = [];
  let spawnError = null;
  let clock = 1000;
  const spawnProcess = (command, args, options) => {
    if (spawnError) throw spawnError;
    const child = new EventEmitter();
    child.pid = 4000 + processes.length;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.killSignals = [];
    child.kill = (signal) => {
      child.killSignals.push(signal);
      return true;
    };
    child.requests = [];
    let received = "";
    child.stdin.on("data", (chunk) => {
      received += chunk;
      let newline;
      while ((newline = received.indexOf("\n")) >= 0) {
        child.requests.push(received.slice(0, newline));
        received = received.slice(newline + 1);
      }
    });
    child.stdinEnded = false;
    child.stdin.on("end", () => {
      child.stdinEnded = true;
    });
    child.say = (text) => child.stdout.write(text);
    child.exit = (code = 1) => child.emit("close", code);
    processes.push({ command, args, options, child });
    return child;
  };
  const server = createLinuxAtspiServer({
    resolveBinary: () => binary,
    spawnProcess,
    now: () => clock,
  });
  t.after(() => {
    for (const { child } of processes) {
      child.stdin.destroy();
      child.stdout.destroy();
    }
  });
  return {
    server,
    processes,
    advance: (ms) => {
      clock += ms;
    },
    failSpawn: (error) => {
      spawnError = error;
    },
  };
}

// Lets the write reach the fake process and its output reach the client.
const settle = () => new Promise((resolve) => setImmediate(resolve));

const warnings = () => logged.filter((entry) => entry.level === "warn").map((e) => e.message);

test("starts lazily with the old-binary safeguard and answers like the one-shot helper's stdout", async (t) => {
  const { server, processes } = createHarness(t);
  assert.equal(processes.length, 0);

  const answer = server.request("TARGET", 2000);
  await settle();

  // An older binary recognises --capabilities and exits instead of falling
  // through to its default paste on the unknown server flag.
  assert.equal(processes.length, 1);
  assert.deepEqual(processes[0].args, ["--capabilities", "--atspi-server"]);
  assert.equal(processes[0].command, "/app/linux-fast-paste");
  assert.deepEqual(processes[0].child.requests, ["1 TARGET"]);

  processes[0].child.say("1 TARGET ATSPI 4242\n");
  assert.deepEqual(await answer, {
    success: true,
    timedOut: false,
    stdout: "TARGET ATSPI 4242\n",
    stderr: "",
  });
  assert.deepEqual(
    logged.filter((entry) => entry.level === "info").map((entry) => entry.message),
    ["AT-SPI server started"]
  );
});

test("overlapping requests get their own answers whatever the order", async (t) => {
  const { server, processes } = createHarness(t);
  const target = server.request("TARGET", 2000);
  const selection = server.request("SELECTION", 2000);
  await settle();
  assert.deepEqual(processes[0].child.requests, ["1 TARGET", "2 SELECTION"]);
  assert.equal(processes.length, 1);

  processes[0].child.say("2 ATSPI_SELECTED 77 aGVsbG8=\n1 TARGET ATSPI 77\n");
  assert.equal((await selection).stdout, "ATSPI_SELECTED 77 aGVsbG8=\n");
  assert.equal((await target).stdout, "TARGET ATSPI 77\n");
});

test("an answer line split across reads, however long, is assembled before it is parsed", async (t) => {
  const { server, processes } = createHarness(t);
  const answer = server.request("SELECTION", 2000);
  await settle();
  const payload = "QUJD".repeat(200_000);
  const line = `1 ATSPI_SELECTED 9 ${payload}\n`;
  for (let at = 0; at < line.length; at += 65_536) {
    processes[0].child.say(line.slice(at, at + 65_536));
  }
  assert.equal((await answer).stdout, `ATSPI_SELECTED 9 ${payload}\n`);
});

test("a late answer is dropped by id and never reaches the next request", async (t) => {
  const { server, processes } = createHarness(t, { mockTimers: true });
  const first = server.request("TARGET", 2000);
  await settle();
  t.mock.timers.tick(2000);
  assert.deepEqual(await first, { success: false, timedOut: true, stdout: "", stderr: "" });

  const second = server.request("TARGET", 2000);
  await settle();
  // The answer to request 1 arrives after the server caught up with the queue.
  processes[0].child.say("1 TARGET ATSPI 11\n");
  await settle();
  processes[0].child.say("2 TARGET ATSPI 22\n");
  assert.equal((await second).stdout, "TARGET ATSPI 22\n");
  assert.equal(processes.length, 1, "one timeout must not restart the server");
  assert.deepEqual(processes[0].child.killSignals, []);
});

// Time moves in two places: the mocked timers that fire request timeouts and the
// clock the client reads to tell how long the server has been silent.
function elapser(t, advance) {
  return (ms) => {
    advance(ms);
    t.mock.timers.tick(ms);
  };
}

// One request that times out unanswered after 2 s.
async function silentRequest(server, elapse, command = "TARGET") {
  const answer = server.request(command, 2000);
  await settle();
  elapse(2000);
  assert.equal((await answer).timedOut, true);
}

test("a server that answers nothing for 15 s is replaced, and that never counts as a failure", async (t) => {
  const { server, processes, advance } = createHarness(t, { mockTimers: true });
  const elapse = elapser(t, advance);

  // Four wedged servers in a row: three failures would have retired the session.
  for (let wedged = 0; wedged < 4; wedged++) {
    for (let silent = 0; silent < 7; silent++) {
      await silentRequest(server, elapse);
    }
    assert.equal(processes.length, wedged + 1, "14 s of silence is still waiting");
    assert.deepEqual(processes[wedged].child.killSignals, []);
    await silentRequest(server, elapse);
    assert.deepEqual(processes[wedged].child.killSignals, ["SIGKILL"], "16 s of silence");
  }

  const next = server.request("TARGET", 2000);
  await settle();
  assert.equal(processes.length, 5, "the next request starts a new server at once");
  processes[4].child.say(`${processes[4].child.requests[0].split(" ")[0]} TARGET ATSPI 5\n`);
  assert.equal((await next).stdout, "TARGET ATSPI 5\n");
  // The old process reporting its death must not fail the new one's requests.
  const after = server.request("TARGET", 2000);
  processes[0].child.exit(null);
  await settle();
  processes[4].child.say(`${processes[4].child.requests[1].split(" ")[0]} TARGET ATSPI 6\n`);
  assert.equal((await after).success, true);

  const complaints = warnings().filter(
    (message) =>
      message === "AT-SPI server failed" || message.startsWith("AT-SPI server unavailable")
  );
  assert.deepEqual(complaints, []);
});

test("a slow server that keeps answering after each request timed out is never replaced", async (t) => {
  const { server, processes, advance } = createHarness(t, { mockTimers: true });
  const elapse = elapser(t, advance);
  const sent = [];
  const send = async () => {
    sent.push(server.request("TARGET", 2000));
    await settle();
    return processes[0].child.requests.length;
  };

  // Chrome walking for a couple of seconds: there is always a request in the
  // queue, every one of them times out, and the answers arrive just after.
  let waiting = await send();
  for (let step = 0; step < 10; step++) {
    elapse(1500);
    const following = await send();
    elapse(500);
    processes[0].child.say(`${waiting} TARGET ATSPI 3\n`);
    await settle();
    waiting = following;
  }
  processes[0].child.say(`${waiting} TARGET ATSPI 3\n`);
  await settle();

  assert.equal(processes.length, 1);
  assert.deepEqual(processes[0].child.killSignals, []);
  assert.equal(warnings().length, 0);
  assert.equal((await Promise.all(sent)).filter((result) => result.success).length, 1);
});

test("a long-idle server is not replaced for being slow on its first request", async (t) => {
  const { server, processes, advance } = createHarness(t, { mockTimers: true });
  const elapse = elapser(t, advance);
  const first = server.request("TARGET", 2000);
  await settle();
  processes[0].child.say("1 TARGET ATSPI 1\n");
  assert.equal((await first).success, true);

  advance(3 * 60 * 60 * 1000);
  await silentRequest(server, elapse);
  assert.deepEqual(processes[0].child.killSignals, []);
  processes[0].child.say("2 TARGET ATSPI 1\n");
  const again = server.request("TARGET", 2000);
  await settle();
  processes[0].child.say("3 TARGET ATSPI 2\n");
  assert.equal((await again).stdout, "TARGET ATSPI 2\n");
  assert.equal(processes.length, 1);
});

test("error and unavailable answers fail the request without touching the server", async (t) => {
  const { server, processes } = createHarness(t);
  const missing = server.request("TARGET", 2000);
  const broken = server.request("SELECTION", 2000);
  await settle();
  processes[0].child.say("1 UNAVAILABLE\n2 ERROR unknown-command nope\n");
  assert.deepEqual(await missing, { success: false, timedOut: false, stdout: "", stderr: "" });
  assert.deepEqual(await broken, {
    success: false,
    timedOut: false,
    stdout: "",
    stderr: "nope",
    errorCode: "unknown-command",
  });
  assert.deepEqual(processes[0].child.killSignals, []);
});

test("a server whose AT-SPI init failed is replaced so the next request tries again", async (t) => {
  const { server, processes } = createHarness(t);
  const first = server.request("TARGET", 2000);
  await settle();
  processes[0].child.say("1 ERROR atspi-init-failed 2\n");
  assert.equal((await first).errorCode, "atspi-init-failed");
  assert.deepEqual(processes[0].child.killSignals, ["SIGKILL"]);

  const second = server.request("TARGET", 2000);
  await settle();
  assert.equal(processes.length, 2);
  processes[1].child.say("2 TARGET ATSPI 8\n");
  assert.equal((await second).stdout, "TARGET ATSPI 8\n");
});

test("a crash fails what was waiting and the next request restarts the server", async (t) => {
  const { server, processes } = createHarness(t);
  const waiting = server.request("TARGET", 2000);
  await settle();
  processes[0].child.exit(139);
  assert.deepEqual(await waiting, {
    success: false,
    timedOut: false,
    stdout: "",
    stderr: "AT-SPI server exited",
  });

  const next = server.request("TARGET", 2000);
  await settle();
  assert.equal(processes.length, 2);
  processes[1].child.say("2 TARGET ATSPI 3\n");
  assert.equal((await next).stdout, "TARGET ATSPI 3\n");
  assert.deepEqual(
    logged.filter((entry) => entry.level === "info").map((entry) => entry.message),
    ["AT-SPI server started", "AT-SPI server restarted"]
  );
});

test("repeated crashes in a short time end in one-shot helpers for the rest of the session", async (t) => {
  const { server, processes, advance } = createHarness(t);
  for (let crash = 1; crash <= 3; crash++) {
    const answer = server.request("TARGET", 2000);
    await settle();
    assert.equal(processes.length, crash);
    processes[crash - 1].child.exit(139);
    assert.equal((await answer).success, false);
    advance(1000);
  }

  assert.equal(await server.request("TARGET", 2000), null);
  assert.equal(await server.request("SELECTION", 2000), null);
  assert.equal(processes.length, 3, "no fourth start");
  assert.equal(
    warnings().filter((message) => message.startsWith("AT-SPI server unavailable")).length,
    1,
    "the switch is logged once"
  );
});

test("crashes spread over more than the window never retire the server", async (t) => {
  const { server, processes, advance } = createHarness(t);
  for (let crash = 1; crash <= 4; crash++) {
    const answer = server.request("TARGET", 2000);
    await settle();
    processes[crash - 1].child.exit(139);
    await answer;
    advance(61_000);
  }
  const answer = server.request("TARGET", 2000);
  await settle();
  assert.equal(processes.length, 5);
  processes[4].child.say("5 TARGET ATSPI 1\n");
  assert.equal((await answer).success, true);
});

test("a binary without atspi-server-v1 hands the request to the one-shot helper, once", async (t) => {
  const { server, processes } = createHarness(t);
  const answer = server.request("TARGET", 2000);
  await settle();
  // What an older linux-fast-paste prints for --capabilities before it exits.
  processes[0].child.say("paste-v1 selection-copy-v1 target-window-v1 atspi-selection-v1\n");
  processes[0].child.exit(0);
  assert.equal(await answer, null);

  assert.equal(await server.request("SELECTION", 2000), null);
  assert.equal(processes.length, 1, "the old binary is not started again");
  assert.equal(
    warnings().filter((message) => message.startsWith("AT-SPI server unavailable")).length,
    1
  );
});

test("a spawn that fails hands the request to the one-shot helper", async (t) => {
  const failing = createHarness(t);
  failing.failSpawn(new Error("EACCES"));
  assert.equal(await failing.server.request("TARGET", 2000), null);
  assert.equal(await failing.server.request("TARGET", 2000), null);

  const missing = createHarness(t);
  const answer = missing.server.request("TARGET", 2000);
  const { child } = missing.processes[0];
  child.pid = undefined;
  child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
  assert.equal(await answer, null);
  assert.equal(await missing.server.request("TARGET", 2000), null);
  assert.equal(missing.processes.length, 1);

  const none = createHarness(t, { binary: null });
  assert.equal(await none.server.request("TARGET", 2000), null);
  assert.equal(none.processes.length, 0);
});

test("the queue is bounded: a stuck server is not given more than it can hold", async (t) => {
  const { server, processes } = createHarness(t, { mockTimers: true });
  const queued = Array.from({ length: 8 }, () => server.request("TARGET", 5000));
  await settle();
  assert.equal(processes[0].child.requests.length, 8);

  const refused = await server.request("TARGET", 5000);
  assert.equal(refused.success, false);
  assert.equal(refused.stderr, "AT-SPI server busy");
  assert.equal(processes[0].child.requests.length, 8, "nothing more is written");

  processes[0].child.say("1 TARGET ATSPI 1\n");
  assert.equal((await queued[0]).success, true);
  const room = server.request("TARGET", 5000);
  await settle();
  assert.equal(processes[0].child.requests.at(-1), "9 TARGET");
  t.mock.timers.tick(5000);
  await room;
});

test("stop closes the server's stdin, waits for it to leave and refuses later requests", async (t) => {
  const { server, processes } = createHarness(t);
  const waiting = server.request("TARGET", 2000);
  await settle();

  const stopping = server.stop();
  assert.equal((await waiting).stderr, "AT-SPI server stopped");
  await settle();
  assert.equal(processes[0].child.stdinEnded, true, "EOF is how the server learns to leave");
  assert.deepEqual(processes[0].child.killSignals, []);
  processes[0].child.exit(0);
  await stopping;

  const later = await server.request("TARGET", 2000);
  assert.equal(later.success, false);
  assert.equal(processes.length, 1, "a stopped client does not start a server");
});

test("stop kills a server that ignores the closed stdin", async (t) => {
  const { server, processes } = createHarness(t, { mockTimers: true });
  server.request("TARGET", 2000);
  await settle();
  const stopping = server.stop();
  t.mock.timers.tick(500);
  assert.deepEqual(processes[0].child.killSignals, ["SIGKILL"]);
  processes[0].child.exit(null);
  await stopping;
});

test("stop without a running server does nothing", async (t) => {
  const { server, processes } = createHarness(t);
  await server.stop();
  assert.equal(processes.length, 0);
});

test("the terminal answer is 1 or 0 whenever the server walked the tree", async (t) => {
  const { server, processes } = createHarness(t);
  for (const [reply, expected] of [
    ["TERMINAL 1", "1"],
    ["TERMINAL 0", "0"],
    // No active window: the helper's own walk would end in the X11 check, as "0" does.
    ["TERMINAL UNKNOWN", "0"],
    ["UNAVAILABLE", null],
    // Last, since it retires the server.
    ["ERROR atspi-init-failed 2", null],
  ]) {
    const id = processes[0] ? processes[0].child.requests.length + 1 : 1;
    const answer = server.queryTerminal();
    await settle();
    assert.equal(processes[0].child.requests.at(-1), `${id} TERMINAL`);
    processes[0].child.say(`${id} ${reply}\n`);
    assert.equal(await answer, expected, reply);
    if (reply.startsWith("ERROR")) break;
  }
});

test("a terminal query that times out costs one budget, then waits out a cooldown", async (t) => {
  const { server, processes, advance } = createHarness(t, { mockTimers: true });
  const first = server.queryTerminal();
  await settle();
  t.mock.timers.tick(300);
  assert.equal(await first, null);
  assert.ok(warnings().includes("AT-SPI terminal query timed out"));

  advance(1999);
  assert.equal(await server.queryTerminal(), null);
  assert.equal(processes[0].child.requests.length, 1, "nothing is asked during the cooldown");

  advance(1);
  const again = server.queryTerminal();
  await settle();
  assert.equal(processes[0].child.requests.length, 2);
  processes[0].child.say("2 TERMINAL 1\n");
  assert.equal(await again, "1");
});

test("without a server the terminal query has no answer", async (t) => {
  const { server } = createHarness(t, { binary: null });
  assert.equal(await server.queryTerminal(), null);
});
