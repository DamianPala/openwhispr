const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const { createInterface } = require("node:readline");

const ROOT = path.resolve(__dirname, "../..");
const HELPER_SOURCE = path.join(ROOT, "resources/linux-fast-paste.c");
const X11_LIBRARIES = ["-lX11", "-lXtst", "-lXext", "-lm"];

// libatspi connects to AT_SPI_BUS_ADDRESS directly when it is set, so pointing it
// at a socket nobody listens on makes atspi_init() fail at once, whatever session
// the test runs in.
const NO_BUS_ENV = {
  AT_SPI_BUS_ADDRESS: "unix:path=/nonexistent",
  DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent",
};

function atspiFlags() {
  const cflags = spawnSync("pkg-config", ["--cflags", "atspi-2"], { encoding: "utf8" });
  const libs = spawnSync("pkg-config", ["--libs", "atspi-2"], { encoding: "utf8" });
  if (cflags.status !== 0 || libs.status !== 0) return null;
  // atspi-2.pc lists gobject-2.0 under Requires.private, as the build script notes.
  return [...cflags.stdout.split(/\s+/), ...libs.stdout.split(/\s+/), "-lgobject-2.0"].filter(
    Boolean
  );
}

// Compiles the helper twice (with and without AT-SPI) in a temporary directory.
// Returns null once the test is skipped because a compiler or library is missing.
function buildHelpers(t) {
  if (process.platform !== "linux") {
    t.skip("Linux only");
    return null;
  }
  const flags = atspiFlags();
  if (!flags) {
    t.skip("AT-SPI2 development headers not found (pkg-config --exists atspi-2)");
    return null;
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-atspi-server-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const compile = (source, name, extra) => {
    const output = path.join(directory, name);
    const compiled = spawnSync("gcc", [source, "-o", output, ...extra, ...X11_LIBRARIES], {
      encoding: "utf8",
      timeout: 60_000,
    });
    if (compiled.error?.code === "ENOENT") return { missing: "gcc is not installed" };
    assert.ifError(compiled.error);
    if (compiled.status !== 0 && /X11\/|Xlib|XTest|shape\.h/.test(compiled.stderr)) {
      return { missing: "X11, Xtst or Xext development libraries unavailable" };
    }
    assert.equal(compiled.status, 0, compiled.stderr);
    return { output };
  };

  const withAtspi = compile(HELPER_SOURCE, "linux-fast-paste-atspi", ["-DHAVE_ATSPI", ...flags]);
  const reason = withAtspi.missing;
  if (reason) {
    t.skip(reason);
    return null;
  }
  const without = compile(HELPER_SOURCE, "linux-fast-paste-plain", []);
  return { directory, flags, compile, atspi: withAtspi.output, plain: without.output };
}

async function runServer(binary, input) {
  const child = spawn(binary, ["--capabilities", "--atspi-server"], {
    env: { ...process.env, ...NO_BUS_ENV },
    stdio: ["pipe", "pipe", "ignore"],
  });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stdin.end(input);
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 8000);
  const [code, signal] = await once(child, "close");
  clearTimeout(watchdog);
  return { code, signal, stdout };
}

test(
  "server mode answers every request with its id and leaves when stdin closes",
  { timeout: 120_000 },
  async (t) => {
    const built = buildHelpers(t);
    if (!built) return;

    // atspi_init() fails here, which the server reports per request instead of
    // exiting: the client decides whether to start a new process.
    const answered = await runServer(
      built.atspi,
      [
        "1 TARGET",
        "2 TERMINAL",
        "3 SELECTION",
        "4 BOGUS",
        "garbage",
        "",
        "5 TARGET extra",
        "",
      ].join("\n")
    );
    assert.equal(answered.signal, null);
    assert.equal(answered.code, 0);
    const lines = answered.stdout.split("\n");
    assert.equal(lines.pop(), "", "every answer ends in a newline");
    assert.match(lines[0], /^1 ERROR atspi-init-failed \d+$/);
    assert.match(lines[1], /^2 ERROR atspi-init-failed \d+$/);
    assert.match(lines[2], /^3 ERROR atspi-init-failed \d+$/);
    assert.deepEqual(lines.slice(3), [
      "4 ERROR unknown-command BOGUS",
      "- ERROR malformed-request",
      "- ERROR malformed-request",
      "5 ERROR unknown-command TARGET extra",
    ]);

    const idle = await runServer(built.atspi, "");
    assert.deepEqual(idle, { code: 0, signal: null, stdout: "" });
  }
);

test(
  "the helper advertises the server only when it can run one",
  { timeout: 120_000 },
  async (t) => {
    const built = buildHelpers(t);
    if (!built) return;

    const capabilities = (binary, args) =>
      spawnSync(binary, args, { encoding: "utf8", input: "", timeout: 8000 });

    const withAtspi = capabilities(built.atspi, ["--capabilities"]);
    assert.equal(withAtspi.status, 0);
    assert.match(withAtspi.stdout, /^paste-v1 .*\batspi-server-v1\b/m);

    // A binary without AT-SPI (or an older one) prints its capabilities and exits for
    // the client's `--capabilities --atspi-server`, which is how the client learns that
    // it has to use the one-shot helpers.
    for (const args of [["--capabilities"], ["--capabilities", "--atspi-server"]]) {
      const plain = capabilities(built.plain, args);
      assert.equal(plain.status, 0, plain.stderr);
      assert.match(plain.stdout, /^paste-v1 /m);
      assert.doesNotMatch(plain.stdout, /atspi-server-v1/);
    }
  }
);

function readLines(stream) {
  const lines = [];
  const waiting = [];
  const rl = createInterface({ input: stream });
  rl.on("line", (line) => {
    const next = waiting.shift();
    if (next) next(line);
    else lines.push(line);
  });
  return {
    next: (timeoutMs = 5000) =>
      new Promise((resolve, reject) => {
        if (lines.length > 0) return resolve(lines.shift());
        const timer = setTimeout(
          () => reject(new Error("timed out waiting for a line")),
          timeoutMs
        );
        waiting.push((line) => {
          clearTimeout(timer);
          resolve(line);
        });
      }),
    close: () => rl.close(),
  };
}

function privateBusPrerequisites() {
  const daemon = spawnSync("dbus-daemon", ["--version"], { encoding: "utf8" });
  if (daemon.error?.code === "ENOENT") return "dbus-daemon is not installed";
  const gi = spawnSync(
    "python3",
    ["-I", "-c", "import gi; gi.require_version('Gio', '2.0'); from gi.repository import Gio"],
    { encoding: "utf8" }
  );
  if (gi.status !== 0) return "python3 with PyGObject (gi) is not installed";
  return null;
}

// Runs the server against libatspi talking to a registry on a private bus. The registry
// is a stand-in with two applications, so the answers are known. This pins that the
// refactored walk still answers from a live bus and follows the active window. It does
// not pin the cache drop before each request: libatspi 2.60 asks this stand-in again
// for every property on every walk, with or without it.
test(
  "server mode answers target and terminal questions from a live AT-SPI bus",
  { timeout: 120_000 },
  async (t) => {
    const unavailable = privateBusPrerequisites();
    if (unavailable) return t.skip(unavailable);
    const built = buildHelpers(t);
    if (!built) return;

    const daemon = spawn("dbus-daemon", ["--session", "--nofork", "--print-address=1"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    t.after(() => daemon.kill("SIGKILL"));
    const daemonLines = readLines(daemon.stdout);
    t.after(() => daemonLines.close());
    const address = (await daemonLines.next()).trim();
    assert.match(address, /^unix:/);
    const env = { ...process.env, AT_SPI_BUS_ADDRESS: address, DBUS_SESSION_BUS_ADDRESS: address };

    const registry = spawn(
      "python3",
      ["-I", path.join(ROOT, "test/native/fakeAtspiRegistry.py"), address],
      { env, stdio: ["pipe", "pipe", "ignore"] }
    );
    t.after(() => registry.kill("SIGKILL"));
    const registryLines = readLines(registry.stdout);
    t.after(() => registryLines.close());
    assert.equal(await registryLines.next(), "ready");

    const server = spawn(built.atspi, ["--capabilities", "--atspi-server"], {
      env,
      stdio: ["pipe", "pipe", "ignore"],
    });
    t.after(() => server.kill("SIGKILL"));
    const serverLines = readLines(server.stdout);
    t.after(() => serverLines.close());

    let id = 0;
    const ask = async (command) => {
      id += 1;
      server.stdin.write(`${id} ${command}\n`);
      const answer = await serverLines.next();
      assert.ok(answer.startsWith(`${id} `), `answer to ${id} ${command}: ${answer}`);
      return answer.slice(`${id} `.length);
    };
    const focus = async (verb, name) => {
      registry.stdin.write(`${verb} ${name}\n`);
      assert.equal(await registryLines.next(), "ok");
    };

    assert.equal(await ask("TERMINAL"), "TERMINAL 1");
    assert.equal(await ask("TARGET"), `TARGET ATSPI ${registry.pid}`);
    await focus("focus", "gedit");
    assert.equal(await ask("TERMINAL"), "TERMINAL 0");
    await focus("focus", "kitty");
    assert.equal(await ask("TERMINAL"), "TERMINAL 1");
    // An application that appeared after the server started is walked too.
    await focus("add", "xterm");
    assert.equal(await ask("TERMINAL"), "TERMINAL 1");
    await focus("focus", "gedit");
    assert.equal(await ask("TERMINAL"), "TERMINAL 0");

    server.stdin.end();
    const [code] = await once(server, "close");
    assert.equal(code, 0);
  }
);

function listenAndCount(socketPath) {
  const held = new Set();
  let connections = 0;
  const server = net.createServer((socket) => {
    connections += 1;
    held.add(socket);
    socket.on("close", () => held.delete(socket));
    socket.on("error", () => {});
  });
  server.listen(socketPath);
  return {
    ready: once(server, "listening"),
    connections: () => connections,
    close() {
      for (const socket of held) socket.destroy();
      server.close();
    },
  };
}

async function runFlagFixture(fixture, args, env, killAfterMs) {
  const child = spawn(fixture, args, { env, stdio: ["ignore", "pipe", "ignore"] });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  const killer = setTimeout(() => child.kill("SIGKILL"), killAfterMs);
  const startedAt = Date.now();
  const [code, signal] = await once(child, "close");
  clearTimeout(killer);
  return { code, signal, stdout: stdout.trim(), elapsedMs: Date.now() - startedAt };
}

// The paste picks Ctrl+Shift+V from the terminal answer the server already gave. A
// bus that accepts connections and never speaks makes any AT-SPI walk of its own
// visible, either as a connection or as a stall.
test(
  "an --atspi-terminal answer decides the paste chord without the helper walking AT-SPI",
  { timeout: 120_000 },
  async (t) => {
    const built = buildHelpers(t);
    if (!built) return;
    const compiled = built.compile(
      path.join(ROOT, "test/native/linuxAtspiTerminalFlag.c"),
      "linuxAtspiTerminalFlag",
      ["-DHAVE_ATSPI", ...built.flags]
    );
    assert.ok(compiled.output, compiled.missing);

    const muteBusPath = path.join(built.directory, "mute-bus.sock");
    const muteBus = listenAndCount(muteBusPath);
    t.after(() => muteBus.close());
    await muteBus.ready;
    // No display: when the AT-SPI answer is not decisive the X11 class check finds nothing.
    const env = {
      ...process.env,
      ...NO_BUS_ENV,
      AT_SPI_BUS_ADDRESS: `unix:path=${muteBusPath}`,
    };
    delete env.DISPLAY;
    delete env.WAYLAND_DISPLAY;

    const CTRL_V = "0";
    const CTRL_SHIFT_V = "1";
    const SHIFT_INSERT = "2";
    for (const [args, expected] of [
      [["0", "0", "1"], CTRL_SHIFT_V],
      [["0", "0", "0"], CTRL_V],
      [["1", "0", "0"], CTRL_SHIFT_V],
      [["0", "1", "1"], SHIFT_INSERT],
    ]) {
      const result = await runFlagFixture(compiled.output, args, env, 4000);
      assert.equal(result.signal, null, `${args.join(" ")} stalled`);
      assert.equal(result.stdout, expected, `force_terminal force_shift_insert flag = ${args}`);
      assert.ok(result.elapsedMs < 3000, `${args.join(" ")} took ${result.elapsedMs} ms`);
    }
    assert.equal(muteBus.connections(), 0, "no flag may reach the AT-SPI bus");

    // Control: without the flag the helper asks AT-SPI itself and reaches the bus,
    // then waits for an answer that never comes.
    const asked = await runFlagFixture(compiled.output, ["0", "0", "-1"], env, 1500);
    assert.equal(asked.signal, "SIGKILL", "without the flag the helper must wait on the bus");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(muteBus.connections() > 0, "without the flag the helper must connect to the bus");
  }
);
