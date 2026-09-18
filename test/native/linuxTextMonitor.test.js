const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");

const { getPkgConfigFlags } = require("../../scripts/build-linux-text-monitor");

// libatspi connects to AT_SPI_BUS_ADDRESS directly when it is set, so pointing
// it at a socket nobody listens on fails atspi_init() at once (the "no desktop
// session" case CI runs under, test a) without consulting the session bus or
// the X11 root window. Test c points it at a socket this test listens on and
// never answers: libdbus then sits in the auth handshake for as long as the
// caller lets it, which holds the process inside atspi_init() until its alarm
// fires, with no network involved.
const NO_BUS_ENV = {
  AT_SPI_BUS_ADDRESS: "unix:path=/nonexistent",
  DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent",
};

function listenAndNeverAnswer(socketPath) {
  const held = new Set();
  const server = net.createServer((socket) => {
    held.add(socket);
    socket.on("close", () => held.delete(socket));
  });
  server.listen(socketPath);
  return {
    ready: once(server, "listening"),
    close() {
      for (const socket of held) socket.destroy();
      server.close();
    },
  };
}

test("linux-text-monitor: bounded search and lifetime cap", async (t) => {
  const pkgFlags = getPkgConfigFlags();
  if (!pkgFlags)
    return t.skip("AT-SPI2 development headers not found (pkg-config --exists atspi-2)");

  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-text-monitor-"));
  t.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));

  const root = path.resolve(__dirname, "../..");
  const cSource = path.join(root, "resources", "linux-text-monitor.c");

  function compile(outputName, extraFlags = []) {
    const outputPath = path.join(temporaryDirectory, outputName);
    const compiled = spawnSync(
      "gcc",
      ["-O2", cSource, "-o", outputPath, ...extraFlags, ...pkgFlags],
      { encoding: "utf8", timeout: 15_000 }
    );
    assert.ifError(compiled.error);
    assert.equal(compiled.status, 0, compiled.stderr);
    return outputPath;
  }

  await t.test("probe mode with no session bus prints NO_ELEMENT and exits 1", async () => {
    const binary = compile("linux-text-monitor-default");
    const start = Date.now();
    const result = spawnSync(binary, ["--probe-editable"], {
      input: "",
      env: { ...process.env, ...NO_BUS_ENV },
      encoding: "utf8",
      timeout: 4000,
    });
    assert.ifError(result.error);
    assert.ok(Date.now() - start < 4000, "expected the process to exit well under the 4 s budget");
    assert.equal(result.status, 1);
    assert.equal(result.stdout.split("\n")[0], "NO_ELEMENT");
  });

  await t.test("SIGTERM interrupts a blocked read and exits within 100 ms", async () => {
    const binary = compile("linux-text-monitor-sigterm");
    // Monitor mode blocks on fgets(stdin) before it ever touches AT-SPI, so
    // this reproduces "still inside a blocking call" without depending on a
    // real accessibility tree or bus being present.
    const child = spawn(binary, [], { stdio: ["pipe", "ignore", "ignore"] });
    let termSentAt = 0;
    setTimeout(() => {
      termSentAt = Date.now();
      child.kill("SIGTERM");
    }, 250);
    const [code, signal] = await once(child, "exit");
    const elapsedSinceTerm = Date.now() - termSentAt;
    assert.ok(
      elapsedSinceTerm < 100,
      `expected exit within 100 ms of SIGTERM, took ${elapsedSinceTerm} ms`
    );
    assert.equal(code, 0);
    assert.equal(signal, null);
  });

  await t.test("alarm() ends a hung probe via SIGALRM at the configured lifetime", async () => {
    const binary = compile("linux-text-monitor-alarm", [
      "-DPROBE_LIFETIME_SECONDS=1",
      "-DSEARCH_BUDGET_MS=600000",
    ]);
    const muteBusPath = path.join(temporaryDirectory, "mute-bus.sock");
    const muteBus = listenAndNeverAnswer(muteBusPath);
    t.after(() => muteBus.close());
    await muteBus.ready;

    const start = Date.now();
    const result = spawnSync(binary, ["--probe-editable"], {
      input: "",
      env: { ...process.env, ...NO_BUS_ENV, AT_SPI_BUS_ADDRESS: `unix:path=${muteBusPath}` },
      encoding: "utf8",
      timeout: 5000,
    });
    const elapsedMs = Date.now() - start;
    assert.ifError(result.error);
    assert.equal(result.signal, "SIGALRM");
    assert.ok(
      elapsedMs >= 900 && elapsedMs < 3000,
      `expected termination around 1 s, took ${elapsedMs} ms`
    );
    assert.equal(result.stdout, "");
  });
});
