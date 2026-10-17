const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const debugLogger = require("./debugLogger");

// A KGlobalAccel shortcut outlives the process that registered it: KWin keeps
// grabbing the key after the owner crashed. The guard is a tiny detached shell
// that blocks on a pipe from the app and, on EOF (the app died in any way, the
// kernel closes the pipe), unregisters the action over D-Bus.
const GUARD_SCRIPT =
  "cat >/dev/null; exec dbus-send --session --type=method_call --dest=org.kde.kglobalaccel " +
  '/kglobalaccel org.kde.KGlobalAccel.unRegister "array:string:$1"';

function isExecutableOnPath(name, envPath = process.env.PATH || "") {
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    try {
      fs.accessSync(path.join(dir, name), fs.constants.X_OK);
      return true;
    } catch {
      // not in this directory
    }
  }
  return false;
}

// `array:string:` takes a comma-separated list, so a comma inside an element
// would split it.
function assertNoCommas(actionId) {
  for (const part of actionId) {
    if (part.includes(",")) {
      throw new Error(`KGlobalAccel action id element contains a comma: "${part}"`);
    }
  }
}

/**
 * Spawns the guard for `actionId`. Throws when dbus-send is missing, an element
 * has a comma, or the spawn fails; the caller must then not register the shortcut.
 */
function startGuard(
  actionId,
  {
    spawn = childProcess.spawn,
    hasDbusSend = isExecutableOnPath,
    kill = (pid, signal) => process.kill(pid, signal),
  } = {}
) {
  assertNoCommas(actionId);
  if (!hasDbusSend("dbus-send")) throw new Error("dbus-send is not on PATH");

  const child = spawn("/bin/sh", ["-c", GUARD_SCRIPT, "sh", actionId.join(",")], {
    detached: true,
    stdio: ["pipe", "ignore", "ignore"],
  });
  let alive = true;
  // Attached before the pid check: a failed spawn emits "error" on the next
  // tick, and without a listener that would be an uncaught exception.
  child?.on("error", (err) => {
    alive = false;
    debugLogger.log("[KDEShortcutGuard] Guard process error:", err.message);
  });
  if (!child || typeof child.pid !== "number" || !child.stdin) {
    throw new Error("guard process did not start");
  }

  child.on("exit", () => {
    alive = false;
  });
  // An EPIPE on the pipe must not become an uncaught exception.
  child.stdin.on?.("error", () => {});

  return {
    // The guard is only worth anything while it is alive and holds the pipe.
    isAlive: () => alive,
    // Let the guard do its job now: closing the pipe without a kill makes it
    // unregister the action over D-Bus. Used when the in-process unRegister
    // failed and the key may still be grabbed.
    fire() {
      alive = false;
      try {
        child.stdin.destroy();
      } catch {
        // already closed
      }
    },
    // Kill the whole process group first, so a late unRegister cannot run after
    // a later re-registration; closing stdin alone would let it fire.
    stop() {
      alive = false;
      try {
        // Once the leader has exited and been reaped its pid can be reused.
        if (child.exitCode == null && child.signalCode == null) kill(-child.pid, "SIGKILL");
      } catch {
        // group already gone
      }
      try {
        child.stdin.destroy();
      } catch {
        // already closed
      }
    },
  };
}

module.exports = { startGuard, isExecutableOnPath };
