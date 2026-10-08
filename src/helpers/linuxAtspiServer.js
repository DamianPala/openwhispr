const { spawn } = require("child_process");
const debugLogger = require("./debugLogger");

// at-spi2-core before 2.62 never releases a direct D-Bus connection after its peer
// is gone, so every short-lived `linux-fast-paste --atspi-*` process leaves a dead
// pidfd and a main-loop source in each accessible application it walked (Chrome
// after a few days of dictation: 1,500 of them). One process that lives as long as
// the app opens each connection once. Its restarts leave the same residue, which is
// why it is never stopped for being idle.

const SERVER_CAPABILITY = "atspi-server-v1";
// Requests the server has not answered yet. It works through them in order, so
// more than this means it is stuck, not busy.
const MAX_PENDING = 8;
// A selection comes back as one base64 line.
const MAX_LINE_BYTES = 16 * 1024 * 1024;
// Failures (crash, init failure, process error) within the window that retire the
// server for the rest of the session. A wedge is not one of them: it is replaced
// without counting, so a slow application can't use up the budget.
const FAILURE_LIMIT = 3;
const FAILURE_WINDOW_MS = 60 * 1000;
// A server that has answered nothing for this long, while something is waiting
// for an answer, is wedged inside a D-Bus call. A slow one (Chrome walks for
// seconds) still answers within it, even when every request times out first.
const WEDGED_AFTER_MS = 15 * 1000;
const STOP_GRACE_MS = 500;
// The terminal answer is wanted right before a paste. A healthy server needs the
// round trips for the applications' windows and their states, a few milliseconds;
// one hung peer costs a full 500 ms libatspi call. Past this the paste goes ahead
// and the helper asks AT-SPI itself, as it did before the server existed.
const TERMINAL_TIMEOUT_MS = 300;
const TERMINAL_COOLDOWN_MS = 2000;

function failure(stderr, extra = {}) {
  return { success: false, timedOut: false, stdout: "", stderr, ...extra };
}

// Maps one answer line (without its id) to the shape runSpawn() gives for the
// one-shot helper, so callers parse the same stdout either way.
function toResult(payload) {
  if (payload === "UNAVAILABLE") return failure("");
  const error = payload.match(/^ERROR (\S+)(?: (.*))?$/);
  if (error) return failure(error[2] || error[1], { errorCode: error[1] });
  return { success: true, timedOut: false, stdout: `${payload}\n`, stderr: "" };
}

function createLinuxAtspiServer({ resolveBinary, spawnProcess = spawn, now = Date.now }) {
  // The server process in use. Each carries its own pending requests, so a
  // process that is on its way out can't fail the requests of its successor.
  let current = null;
  let nextId = 0;
  let disabled = null;
  let stopped = false;
  let starts = 0;
  let failures = [];
  let terminalCooldownUntil = 0;

  const settleAll = (target, result) => {
    for (const entry of target.pending.values()) {
      clearTimeout(entry.timer);
      entry.resolve(result);
    }
    target.pending.clear();
  };

  const disable = (reason, meta = {}) => {
    if (disabled) return;
    disabled = reason;
    debugLogger.warn("AT-SPI server unavailable, using one-shot helpers", { reason, ...meta });
  };

  const recordFailure = (reason) => {
    const at = now();
    failures = failures.filter((time) => at - time < FAILURE_WINDOW_MS);
    failures.push(at);
    debugLogger.warn("AT-SPI server failed", { reason, recent: failures.length });
    if (failures.length >= FAILURE_LIMIT) disable("repeated failures");
  };

  // Ends a server process on purpose. The next request starts a new one, which is
  // why this can't wait for the old process to report that it is gone.
  const retire = (target, reason, { counted = true } = {}) => {
    if (target.retired) return;
    target.retired = true;
    if (current === target) current = null;
    if (counted) recordFailure(reason);
    settleAll(target, failure(reason));
    target.child.kill("SIGKILL");
  };

  const onLine = (target, line) => {
    const match = line.match(/^(\d+) (.*)$/s);
    if (!match) {
      if (target.unparsed.length < 1024) target.unparsed += `${line}\n`;
      return;
    }
    const id = Number(match[1]);
    // The server works through its queue in order, so an answer also closes
    // every request sent before it.
    target.lastProgressAt = now();
    for (const open of target.unanswered) {
      if (open <= id) target.unanswered.delete(open);
    }
    const entry = target.pending.get(id);
    if (!entry) {
      debugLogger.debug("AT-SPI server answer arrived after its request gave up", { id });
      return;
    }
    clearTimeout(entry.timer);
    target.pending.delete(id);
    const result = toResult(match[2]);
    entry.resolve(result);
    if (result.errorCode === "atspi-init-failed") {
      // atspi_init() runs once per process. A server that started before the
      // accessibility bus existed would never see it, so the next request gets a
      // new process, as every request did when each had its own.
      retire(target, "AT-SPI init failed");
    }
  };

  const onData = (target, chunk) => {
    target.buffer += chunk;
    let newline;
    while ((newline = target.buffer.indexOf("\n")) >= 0) {
      const line = target.buffer.slice(0, newline);
      target.buffer = target.buffer.slice(newline + 1);
      onLine(target, line);
    }
    if (target.buffer.length > MAX_LINE_BYTES) retire(target, "answer line too long");
  };

  const onClose = (target) => {
    if (target.closed) return;
    target.closed = true;
    if (current === target) current = null;
    // An older binary reads --atspi-server as an unknown flag, prints its
    // capabilities because of the --capabilities that comes with it, and exits.
    const capabilities = target.unparsed.match(/^paste-v1 .*$/m)?.[0];
    if (capabilities && !capabilities.split(" ").includes(SERVER_CAPABILITY)) {
      disable("binary has no atspi-server-v1", { capabilities });
      settleAll(target, null);
      return;
    }
    settleAll(target, failure("AT-SPI server exited"));
    if (!target.retired && !stopped) recordFailure("exited");
  };

  const start = () => {
    const binary = resolveBinary();
    if (!binary) return false;
    // --capabilities comes first so a binary that does not know the server flag
    // prints its capabilities and exits instead of falling through to a paste.
    let child;
    try {
      child = spawnProcess(binary, ["--capabilities", "--atspi-server"], {
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch (error) {
      disable("spawn failed", { error: error.message });
      return false;
    }
    const target = {
      child,
      pending: new Map(),
      buffer: "",
      unparsed: "",
      // Ids sent and not answered yet, timed-out ones included: the server still
      // has them in its queue. Empty means it was idle.
      unanswered: new Set(),
      lastProgressAt: now(),
      retired: false,
      closed: false,
    };
    current = target;
    starts += 1;
    debugLogger.info(starts === 1 ? "AT-SPI server started" : "AT-SPI server restarted", {
      pid: child.pid,
      starts,
    });
    child.on("error", (error) => {
      if (target.closed) return;
      if (child.pid) return retire(target, `process error: ${error.message}`);
      // The process never started (binary missing or not executable).
      target.closed = true;
      if (current === target) current = null;
      disable("spawn failed", { error: error.message });
      settleAll(target, null);
    });
    child.on("close", () => onClose(target));
    child.stdin.on("error", () => {});
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => onData(target, chunk));
    child.stdout.on("error", () => {});
    return true;
  };

  const onTimeout = (target, id) => {
    if (!target.pending.delete(id)) return;
    const silentMs = now() - target.lastProgressAt;
    if (silentMs < WEDGED_AFTER_MS) return;
    debugLogger.warn("AT-SPI server answers nothing, replacing it", { silentMs });
    retire(target, "no answer to any request", { counted: false });
  };

  // Resolves like runSpawn() does for the one-shot helper ({ success, timedOut,
  // stdout, stderr }), or null when there is no server and the caller should run
  // the one-shot helper instead. A request that times out stays in the server's
  // queue, which works through it before the next; its late answer is dropped by id.
  const request = (command, timeoutMs) => {
    if (stopped) return Promise.resolve(failure("AT-SPI server stopped"));
    if (disabled) return Promise.resolve(null);
    if (!current && !start()) return Promise.resolve(null);
    const target = current;
    if (target.pending.size >= MAX_PENDING) return Promise.resolve(failure("AT-SPI server busy"));

    const id = ++nextId;
    // Silence counts from the moment the server has something to answer, not from
    // its last answer, which may be hours old.
    if (target.unanswered.size === 0) target.lastProgressAt = now();
    target.unanswered.add(id);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        onTimeout(target, id);
        resolve({ success: false, timedOut: true, stdout: "", stderr: "" });
      }, timeoutMs);
      target.pending.set(id, { resolve, timer });
      try {
        target.child.stdin.write(`${id} ${command}\n`);
      } catch (error) {
        clearTimeout(timer);
        target.pending.delete(id);
        target.unanswered.delete(id);
        resolve(failure(error.message));
      }
    });
  };

  // "1" or "0" when the server says whether the active window is a terminal,
  // null when it did not answer in time. Callers hand that to linux-fast-paste as
  // --atspi-terminal and leave the flag off on null. No active window is "0": the
  // helper's own walk would find none either and go on to the X11 class check,
  // which "0" leads to as well, without opening its own connections.
  const queryTerminal = async () => {
    if (now() < terminalCooldownUntil) return null;
    const result = await request("TERMINAL", TERMINAL_TIMEOUT_MS);
    if (result?.timedOut) {
      terminalCooldownUntil = now() + TERMINAL_COOLDOWN_MS;
      debugLogger.warn("AT-SPI terminal query timed out", { cooldownMs: TERMINAL_COOLDOWN_MS });
    }
    const answer = result?.stdout.match(/^TERMINAL ([01]|UNKNOWN)$/m)?.[1];
    if (!answer) return null;
    return answer === "UNKNOWN" ? "0" : answer;
  };

  // The server leaves when its stdin closes, which also covers the app dying.
  const stop = () => {
    stopped = true;
    const target = current;
    if (!target) return Promise.resolve();
    settleAll(target, failure("AT-SPI server stopped"));
    return new Promise((resolve) => {
      target.retired = true;
      const timer = setTimeout(() => target.child.kill("SIGKILL"), STOP_GRACE_MS);
      target.child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      target.child.stdin.end();
    });
  };

  return { request, queryTerminal, stop };
}

module.exports = { createLinuxAtspiServer, SERVER_CAPABILITY };
