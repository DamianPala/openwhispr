const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Stub electron's globalShortcut so HotkeyManager runs outside Electron.
const registered = new Map();
require.cache[require.resolve("electron")] = {
  exports: {
    globalShortcut: {
      register(accelerator, callback) {
        if (registered.has(accelerator)) return false;
        registered.set(accelerator, callback);
        return true;
      },
      unregister(accelerator) {
        registered.delete(accelerator);
      },
      isRegistered(accelerator) {
        return registered.has(accelerator);
      },
      unregisterAll() {
        registered.clear();
      },
    },
    BrowserWindow: class {},
  },
};

const HotkeyManager = require("../../src/helpers/hotkeyManager.js");
const KDEShortcutManager = require("../../src/helpers/kdeShortcut.js");
const { startGuard } = require("../../src/helpers/kdeShortcutGuard.js");

const CANCEL_ID = ["openwhispr", "cancel", "OpenWhispr", "OpenWhispr cancel"];

// One shared, ordered log of everything that touches KGlobalAccel or the guard.
// `asyncDbus` answers every call one macrotask later, like the real bus does;
// the effect on `state.grabbed` (KWin grabbing the key) happens when the call is made.
function createHarness({
  dbusSend = true,
  spawnThrows = false,
  guardDiesAfterSpawn = false,
  asyncDbus = false,
  keyAvailable = true, // isGlobalShortcutAvailable's answer (false: another component owns the key)
  invokeFails = false,
  setShortcutAnswer = null, // keys setShortcut reports back instead of the requested ones
} = {}) {
  const events = [];
  const messages = [];
  const destroyed = [];
  // unRegisterFails: the in-process D-Bus connection drops the call (the guard, a separate process, still works).
  const state = { grabbed: false, unRegisterFails: false, holdNextUnRegister: false, held: null };
  const answer = (callback, ...args) => {
    if (asyncDbus) setImmediate(() => callback(...args));
    else callback(...args);
  };
  const component = new EventEmitter();
  let nextPid = 4000;

  const spawn = (command, args, options) => {
    if (spawnThrows) throw new Error("spawn EAGAIN");
    const child = new EventEmitter();
    child.pid = nextPid++;
    child.stdin = Object.assign(new EventEmitter(), {
      destroy() {
        destroyed.push(child.pid);
      },
    });
    events.push({ type: "spawn", command, args, options, pid: child.pid });
    // A real child reports its exit asynchronously, after spawn() has returned.
    if (guardDiesAfterSpawn) queueMicrotask(() => child.emit("exit", 1));
    return child;
  };
  const kill = (pid, signal) => events.push({ type: "kill", pid, signal });

  const manager = new KDEShortcutManager({
    guardDeps: { spawn, kill, hasDbusSend: () => dbusSend },
  });
  manager.bus = {
    invoke(message, callback) {
      messages.push(message);
      if (invokeFails)
        return answer(callback, new Error("org.freedesktop.DBus.Error.UnknownMethod"));
      answer(callback, null, keyAvailable);
    },
    getService() {
      return {
        getInterface(_path, _interface, callback) {
          answer(callback, null, component);
        },
      };
    },
  };
  manager.kglobalaccel = {
    unRegister(actionId, callback) {
      events.push({ type: "unRegister", actionId });
      if (state.unRegisterFails) return answer(callback, new Error("connection lost"));
      state.grabbed = false;
      if (state.holdNextUnRegister) {
        // The call took effect; its answer is delivered later, by state.held().
        state.holdNextUnRegister = false;
        state.held = () => answer(callback, null);
        return;
      }
      answer(callback, null);
    },
    doRegister(actionId, callback) {
      events.push({ type: "doRegister", actionId });
      answer(callback, null);
    },
    setShortcut(actionId, keys, _flags, callback) {
      events.push({ type: "setShortcut", actionId });
      state.grabbed = true;
      answer(callback, null, setShortcutAnswer ?? keys);
    },
  };
  const kinds = () => events.map((e) => e.type);
  const spawnedPids = () => events.filter((e) => e.type === "spawn").map((e) => e.pid);
  const killedPids = () => events.filter((e) => e.type === "kill").map((e) => -e.pid);
  // Guards whose pipe was closed without a kill: they unregister the key themselves.
  const firedPids = () => [...new Set(destroyed)].filter((pid) => !killedPids().includes(pid));
  return { manager, events, kinds, state, spawnedPids, killedPids, firedPids, messages };
}

const ticks = async (n) => {
  for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve));
};

test.beforeEach(() => {
  registered.clear();
});

test("KDE cancel registers through KGlobalAccel with a guard spawned before setShortcut", async () => {
  const { manager, events, kinds } = createHarness();
  const callback = () => {};

  assert.equal(await manager.registerKeybinding("Escape", "cancel", callback), true);

  const spawnAt = kinds().indexOf("spawn");
  assert.ok(spawnAt >= 0, "guard spawned");
  assert.ok(spawnAt < kinds().indexOf("doRegister"));
  assert.ok(spawnAt < kinds().indexOf("setShortcut"));
  assert.deepEqual(events.find((e) => e.type === "setShortcut").actionId, CANCEL_ID);

  const spawned = events[spawnAt];
  assert.equal(spawned.options.detached, true);
  assert.deepEqual(spawned.options.stdio, ["pipe", "ignore", "ignore"]);
  assert.equal(spawned.args.at(-1), CANCEL_ID.join(","));
  assert.match(spawned.args[1], /cat >\/dev\/null; exec dbus-send .*KGlobalAccel\.unRegister/);
  assert.equal(manager.callbacks.get("cancel"), callback);
});

test("clean unregister stops the guard group once unRegister succeeded", async () => {
  const { manager, events, kinds } = createHarness();
  await manager.registerKeybinding("Escape", "cancel", () => {});
  const before = events.length;

  await manager.unregisterKeybinding("cancel");

  const after = events.slice(before);
  assert.deepEqual(
    after.map((e) => e.type),
    ["unRegister", "kill"]
  );
  assert.equal(after[1].pid, -events[kinds().indexOf("spawn")].pid);
  assert.equal(after[1].signal, "SIGKILL");
  assert.deepEqual(after[0].actionId, CANCEL_ID);
});

test("re-registering for the next recording spawns a fresh guard and stops the old one", async () => {
  const { manager, events } = createHarness();
  await manager.registerKeybinding("Escape", "cancel", () => {});
  await manager.unregisterKeybinding("cancel");
  await manager.registerKeybinding("Escape", "cancel", () => {});

  const spawns = events.filter((e) => e.type === "spawn");
  assert.equal(spawns.length, 2);
  assert.notEqual(spawns[0].pid, spawns[1].pid);
  assert.equal(manager.guards.size, 1);
  assert.ok(manager.registeredSlots.has("cancel"));
});

test("an unregister in flight does not drop the callback of a newer registration", async () => {
  const { manager } = createHarness();
  await manager.registerKeybinding("Escape", "cancel", () => {});
  const pendingUnregister = manager.unregisterKeybinding("cancel");
  const next = () => {};
  await manager.registerKeybinding("Escape", "cancel", next);
  await pendingUnregister;

  assert.equal(manager.callbacks.get("cancel"), next);
  assert.ok(manager.registeredSlots.has("cancel"));
});

test("without dbus-send nothing is registered in KGlobalAccel", async () => {
  const { manager, events } = createHarness({ dbusSend: false });

  assert.equal(await manager.registerKeybinding("Escape", "cancel", () => {}), "no-guard");

  assert.deepEqual(events, []);
  assert.equal(manager.registeredSlots.has("cancel"), false);
});

test("a failed guard spawn leaves KGlobalAccel untouched", async () => {
  const { manager, events } = createHarness({ spawnThrows: true });

  assert.equal(await manager.registerKeybinding("Escape", "cancel", () => {}), "no-guard");

  assert.deepEqual(events, []);
});

test("a guard that died before setShortcut aborts the registration", async () => {
  const { manager, kinds } = createHarness({ guardDiesAfterSpawn: true });

  assert.equal(await manager.registerKeybinding("Escape", "cancel", () => {}), "no-guard");

  assert.equal(kinds().includes("setShortcut"), false);
  assert.equal(manager.registeredSlots.has("cancel"), false);
});

test("other slots get no guard", async () => {
  const { manager, kinds } = createHarness();

  assert.equal(await manager.registerKeybinding("F8", "dictation", () => {}), true);

  assert.equal(kinds().includes("spawn"), false);
  await manager.unregisterKeybinding("dictation");
  assert.equal(kinds().includes("kill"), false);
});

test("close() stops the guard after the final unRegister", async () => {
  const { manager, events } = createHarness({ asyncDbus: true });
  await manager.registerKeybinding("Escape", "cancel", () => {});
  const before = events.length;

  manager.close();
  assert.deepEqual(
    events.slice(before).map((e) => e.type),
    ["unRegister"],
    "guard still alive while the unRegister is in flight"
  );
  await ticks(3);

  assert.deepEqual(
    events.slice(before).map((e) => e.type),
    ["unRegister", "kill"]
  );
});

test("init unregisters a stale cancel action", async () => {
  const { manager, events } = createHarness();

  await manager.removeStaleGuardedKeybindings();

  assert.deepEqual(events, [{ type: "unRegister", actionId: CANCEL_ID }]);
});

test("the guard refuses action ids with commas and a missing dbus-send", () => {
  const deps = { spawn: () => assert.fail("must not spawn"), hasDbusSend: () => true };
  assert.throws(
    () => startGuard(["openwhispr", "can,cel", "OpenWhispr", "OpenWhispr cancel"], deps),
    /comma/
  );
  assert.throws(
    () => startGuard(CANCEL_ID, { ...deps, hasDbusSend: () => false }),
    /dbus-send is not on PATH/
  );
});

function kdeHotkeyManager(harness) {
  const hotkeys = new HotkeyManager();
  hotkeys.useKDE = true;
  hotkeys.kdeManager = harness.manager;
  return hotkeys;
}

test("HotkeyManager routes cancel through KGlobalAccel on KDE and releases it there", async () => {
  const harness = createHarness();
  const hotkeys = kdeHotkeyManager(harness);

  const result = await hotkeys.registerSlot("cancel", "Escape", () => {});
  assert.deepEqual(result, { success: true, hotkey: "Escape" });
  assert.equal(registered.size, 0, "no globalShortcut grab");
  assert.ok(harness.kinds().includes("setShortcut"));

  const before = harness.events.length;
  hotkeys.unregisterSlot("cancel");
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    harness.events.slice(before).map((e) => e.type),
    ["unRegister", "kill"]
  );
  assert.deepEqual(hotkeys.getSlotHotkeys("cancel"), []);
});

test("HotkeyManager falls back to globalShortcut for cancel when no guard can run", async () => {
  const harness = createHarness({ dbusSend: false });
  const hotkeys = kdeHotkeyManager(harness);

  const result = await hotkeys.registerSlot("cancel", "Escape", () => {});

  assert.equal(result.success, true);
  assert.deepEqual([...registered.keys()], ["Escape"]);
  assert.deepEqual(harness.events, []);

  hotkeys.unregisterSlot("cancel");
  assert.equal(registered.size, 0, "fallback is released through globalShortcut");
  assert.deepEqual(harness.events, [], "KGlobalAccel never touched");
});

test("outside KDE cancel stays on globalShortcut", async () => {
  const hotkeys = new HotkeyManager();

  const result = await hotkeys.registerSlot("cancel", "Escape", () => {});

  assert.equal(result.success, true);
  assert.deepEqual([...registered.keys()], ["Escape"]);
});

test("HotkeyManager init removes a stale cancel action", async (t) => {
  const harness = createHarness();
  const originalInit = KDEShortcutManager.prototype.init;
  const originalIsKDE = KDEShortcutManager.isKDE;
  KDEShortcutManager.prototype.init = async function init() {
    this.kglobalaccel = harness.manager.kglobalaccel;
    return true;
  };
  KDEShortcutManager.isKDE = () => true;
  t.after(() => {
    KDEShortcutManager.prototype.init = originalInit;
    KDEShortcutManager.isKDE = originalIsKDE;
  });
  const hotkeys = new HotkeyManager();
  if (process.platform !== "linux") return t.skip("KDE init is Linux only");

  assert.equal(await hotkeys.initializeKDEShortcuts(() => {}), true);

  const unregistered = harness.events
    .filter((e) => e.type === "unRegister")
    .map((e) => e.actionId[1]);
  assert.ok(unregistered.includes("cancel"));
});

// Real guard process against a stub dbus-send on PATH (never the real service).
function withStubDbusSend(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kde-guard-"));
  const out = path.join(dir, "args.txt");
  // Written to a temp file and renamed, so a poller never reads a half-written file.
  const script = `#!/bin/sh\nprintf '%s\\n' "$@" > "${out}.tmp" && mv "${out}.tmp" "${out}"\n`;
  fs.writeFileSync(path.join(dir, "dbus-send"), script, { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${previousPath}`;
  t.after(() => {
    process.env.PATH = previousPath;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return out;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("the real guard unregisters the action when its pipe closes", async (t) => {
  if (process.platform !== "linux") return t.skip("guard is a POSIX shell process");
  const out = withStubDbusSend(t);
  let child;
  const guard = startGuard(CANCEL_ID, {
    spawn: (...args) => (child = require("node:child_process").spawn(...args)),
  });
  // If an assertion fails before the pipe closes, the guard must not outlive the
  // stub directory and reach the real dbus-send when the test process exits.
  t.after(() => guard.stop());
  assert.equal(guard.isAlive(), true);

  child.stdin.end(); // what the kernel does when the app dies
  for (let i = 0; i < 50 && !fs.existsSync(out); i++) await sleep(20);

  const args = fs.readFileSync(out, "utf8").split("\n");
  assert.ok(args.includes("org.kde.KGlobalAccel.unRegister"));
  assert.ok(args.includes("array:string:openwhispr,cancel,OpenWhispr,OpenWhispr cancel"));
});

test("stopping the real guard kills it without an unRegister", async (t) => {
  if (process.platform !== "linux") return t.skip("guard is a POSIX shell process");
  const out = withStubDbusSend(t);
  const guard = startGuard(CANCEL_ID);

  guard.stop();
  await sleep(300);

  assert.equal(fs.existsSync(out), false);
  assert.equal(guard.isAlive(), false);
});

// Registration takes several D-Bus round trips. The renderer fires the register
// IPC without awaiting it, so a stop can arrive at any point in between.
for (let stopAfter = 0; stopAfter <= 7; stopAfter++) {
  test(`HotkeyManager: unregister ${stopAfter} ticks into a KDE cancel registration leaves nothing grabbed`, async () => {
    const harness = createHarness({ asyncDbus: true });
    const hotkeys = kdeHotkeyManager(harness);

    const pending = hotkeys.registerSlot("cancel", "Escape", () => {});
    await ticks(stopAfter);
    hotkeys.unregisterSlot("cancel");
    const result = await pending;
    await ticks(10);

    // Stopped before the registration finished, or right after it did: either
    // way no cancel hotkey may remain, in KGlobalAccel or in globalShortcut.
    assert.equal(harness.state.grabbed, false, "KWin must not grab Escape");
    assert.equal(registered.size, 0, "no globalShortcut fallback");
    assert.equal(harness.manager.guards.size, 0, "no guard left");
    assert.deepEqual(harness.killedPids().sort(), harness.spawnedPids().sort());
    assert.equal(harness.manager.registeredSlots.has("cancel"), false);
    assert.equal(harness.manager.callbacks.has("cancel"), false);
    assert.deepEqual(hotkeys.getSlotHotkeys("cancel"), []);
    assert.equal(result.success === true || result.superseded === true, true);
  });
}

test("HotkeyManager: stop then start again keeps only the newer cancel registration", async () => {
  const harness = createHarness({ asyncDbus: true });
  const hotkeys = kdeHotkeyManager(harness);
  const next = () => {};

  const first = hotkeys.registerSlot("cancel", "Escape", () => {});
  await ticks(2);
  hotkeys.unregisterSlot("cancel");
  const second = hotkeys.registerSlot("cancel", "Escape", next);
  const [firstResult, secondResult] = await Promise.all([first, second]);
  await ticks(10);

  assert.equal(firstResult.superseded, true);
  assert.equal(secondResult.success, true);
  assert.equal(harness.state.grabbed, true);
  assert.equal(harness.manager.guards.size, 1);
  assert.equal([...harness.manager.guards.values()][0].isAlive(), true);
  assert.equal(harness.manager.callbacks.get("cancel"), next);
  assert.equal(registered.size, 0);
});

test("close() during a KDE cancel registration releases the key and the guard", async () => {
  for (let closeAfter = 0; closeAfter <= 7; closeAfter++) {
    const harness = createHarness({ asyncDbus: true });
    const pending = harness.manager.registerKeybinding("Escape", "cancel", () => {});
    await ticks(closeAfter);

    harness.manager.close();
    const result = await pending;
    await ticks(10);

    assert.equal(harness.state.grabbed, false, `grabbed after close at tick ${closeAfter}`);
    assert.equal(harness.manager.guards.size, 0);
    assert.deepEqual(harness.killedPids().sort(), harness.spawnedPids().sort());
    assert.ok([true, "superseded"].includes(result), `result ${result} at tick ${closeAfter}`);
  }
});

// F2: the guard outlives the in-process unRegister and is only stopped once that
// succeeded; when it failed the guard must fire (pipe closed, no kill).
test("a failing unRegister on clean stop lets the guard fire instead of killing it", async () => {
  const harness = createHarness();
  await harness.manager.registerKeybinding("Escape", "cancel", () => {});
  harness.state.unRegisterFails = true;

  await harness.manager.unregisterKeybinding("cancel");

  assert.deepEqual(harness.killedPids(), []);
  assert.deepEqual(harness.firedPids(), harness.spawnedPids());
});

test("a failing unRegister in close() lets the guard fire instead of killing it", async () => {
  const harness = createHarness();
  await harness.manager.registerKeybinding("Escape", "cancel", () => {});
  harness.state.unRegisterFails = true;

  harness.manager.close();
  await ticks(2);

  assert.deepEqual(harness.killedPids(), []);
  assert.deepEqual(harness.firedPids(), harness.spawnedPids());
});

test("a registration abandoned with a failing unRegister lets its guard fire", async () => {
  const harness = createHarness({ asyncDbus: true });
  const pending = harness.manager.registerKeybinding("Escape", "cancel", () => {});
  await ticks(3);
  assert.equal(harness.spawnedPids().length, 1, "guard is up while registering");
  harness.state.unRegisterFails = true;
  harness.manager.unregisterKeybinding("cancel");

  assert.equal(await pending, "superseded");
  await ticks(5);

  assert.deepEqual(harness.killedPids(), []);
  assert.deepEqual(harness.firedPids(), harness.spawnedPids());
});

test("a newer registration's guard survives the older unregister finishing late", async () => {
  const harness = createHarness({ asyncDbus: true });
  await harness.manager.registerKeybinding("Escape", "cancel", () => {});
  const [first] = harness.spawnedPids();
  harness.state.holdNextUnRegister = true;
  const unregister = harness.manager.unregisterKeybinding("cancel");
  assert.equal(await harness.manager.registerKeybinding("Escape", "cancel", () => {}), true);
  harness.state.held(); // the old unRegister is answered after the new registration is up
  await unregister;
  await ticks(3);

  const [, second] = harness.spawnedPids();
  assert.deepEqual(harness.killedPids(), [first], "only the old guard was killed");
  assert.equal(harness.manager.guards.size, 1);
  assert.equal(harness.manager.guards.get("cancel").isAlive(), true);
  assert.equal(harness.state.grabbed, true);
  assert.ok(second);
});

test("a stopped guard never fires: SIGKILL goes out before its pipe is destroyed", async () => {
  const order = [];
  const child = new EventEmitter();
  child.pid = 5000;
  child.stdin = Object.assign(new EventEmitter(), { destroy: () => order.push("destroy") });
  const guard = startGuard(CANCEL_ID, {
    spawn: () => child,
    hasDbusSend: () => true,
    kill: () => order.push("kill"),
  });

  guard.stop();

  assert.deepEqual(order, ["kill", "destroy"]);
});

test("fire() closes the pipe without a kill", () => {
  const order = [];
  const child = new EventEmitter();
  child.pid = 5001;
  child.stdin = Object.assign(new EventEmitter(), { destroy: () => order.push("destroy") });
  const guard = startGuard(CANCEL_ID, {
    spawn: () => child,
    hasDbusSend: () => true,
    kill: () => order.push("kill"),
  });

  guard.fire();

  assert.deepEqual(order, ["destroy"]);
  assert.equal(guard.isAlive(), false);
});

test("the real guard fires its unRegister on fire()", async (t) => {
  if (process.platform !== "linux") return t.skip("guard is a POSIX shell process");
  const out = withStubDbusSend(t);
  const guard = startGuard(CANCEL_ID);
  t.after(() => guard.stop());

  guard.fire();
  for (let i = 0; i < 50 && !fs.existsSync(out); i++) await sleep(20);

  assert.ok(fs.readFileSync(out, "utf8").includes("org.kde.KGlobalAccel.unRegister"));
});

// F1: the conflict pre-check is isGlobalShortcutAvailable(int, string), never
// globalShortcutsByKey (a malformed QKeySequence struct aborts KWin).
test("the conflict pre-check calls isGlobalShortcutAvailable with plain values", async () => {
  const harness = createHarness();

  assert.equal(await harness.manager.registerKeybinding("Escape", "cancel", () => {}), true);

  assert.equal(harness.messages.length, 1);
  const [message] = harness.messages;
  assert.equal(message.member, "isGlobalShortcutAvailable");
  assert.equal(message.signature, "is");
  assert.deepEqual(message.body, [0x01000000, "openwhispr"]);
});

test("a key owned by another component is a conflict before any guard or registration", async () => {
  const harness = createHarness({ keyAvailable: false });

  assert.equal(await harness.manager.registerKeybinding("Escape", "cancel", () => {}), "conflict");

  assert.deepEqual(harness.events, []);
});

test("a failing conflict pre-check does not stop the registration", async () => {
  const harness = createHarness({ invokeFails: true });

  assert.equal(await harness.manager.registerKeybinding("Escape", "cancel", () => {}), true);

  assert.ok(harness.kinds().includes("setShortcut"));
});

// F3: conflict fallback end to end.
test("setShortcut assigning another key is a conflict: key released, guard stopped", async () => {
  const harness = createHarness({ setShortcutAnswer: [0] });

  assert.equal(await harness.manager.registerKeybinding("Escape", "cancel", () => {}), "conflict");

  assert.equal(harness.state.grabbed, false);
  assert.equal(harness.manager.guards.size, 0);
  assert.deepEqual(harness.killedPids(), harness.spawnedPids());
  assert.equal(harness.manager.registeredSlots.has("cancel"), false);
  assert.equal(harness.manager.callbacks.has("cancel"), false);
});

test("HotkeyManager falls back to globalShortcut when setShortcut reports a conflict", async () => {
  const harness = createHarness({ setShortcutAnswer: [0] });
  const hotkeys = kdeHotkeyManager(harness);

  const result = await hotkeys.registerSlot("cancel", "Escape", () => {});

  assert.equal(result.success, true);
  assert.deepEqual([...registered.keys()], ["Escape"]);
  assert.equal(harness.state.grabbed, false);
  assert.equal(harness.manager.guards.size, 0);

  const before = harness.events.length;
  hotkeys.unregisterSlot("cancel");
  assert.equal(registered.size, 0);
  assert.equal(harness.events.length, before, "fallback is released through globalShortcut only");
});

test("HotkeyManager falls back to globalShortcut when another component owns the key", async () => {
  const harness = createHarness({ keyAvailable: false });
  const hotkeys = kdeHotkeyManager(harness);

  const result = await hotkeys.registerSlot("cancel", "Escape", () => {});

  assert.equal(result.success, true);
  assert.deepEqual([...registered.keys()], ["Escape"]);
  assert.deepEqual(harness.events, [], "no guard, no KGlobalAccel registration");
});

test("only the cancel slot is guarded", () => {
  assert.equal(KDEShortcutManager.isGuardedSlot("cancel"), true);
  assert.equal(KDEShortcutManager.isGuardedSlot("dictation"), false);
});
