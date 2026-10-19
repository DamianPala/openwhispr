const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const KDEShortcutManager = require("../../src/helpers/kdeShortcut");

// KGlobalAccel stand-in: the key is held until `releasedBy` says otherwise.
function fakeManager({ heldUntilUnregister = false, heldForever = false } = {}) {
  const calls = [];
  let held = heldUntilUnregister || heldForever;
  const manager = new KDEShortcutManager();
  manager.bus = {
    invoke(message, callback) {
      calls.push(message.member);
      callback(null, !held);
    },
    getService() {
      return {
        getInterface(_path, _interface, callback) {
          callback(null, new EventEmitter());
        },
      };
    },
  };
  manager.kglobalaccel = {
    unRegister(_actionId, callback) {
      calls.push("unRegister");
      if (!heldForever) held = false;
      callback(null);
    },
    doRegister(_actionId, callback) {
      calls.push("doRegister");
      callback(null);
    },
    setShortcut(_actionId, keys, _flags, callback) {
      calls.push("setShortcut");
      callback(null, keys);
    },
  };
  return { manager, calls };
}

test("a key held by a killed instance's own action is cleared and registered", async () => {
  const { manager, calls } = fakeManager({ heldUntilUnregister: true });

  const result = await manager.registerKeybinding("Control+Shift+F11", "dictation", () => {});

  assert.equal(result, true);
  assert.deepEqual(calls.slice(0, 3), [
    "isGlobalShortcutAvailable",
    "unRegister",
    "isGlobalShortcutAvailable",
  ]);
  assert.ok(calls.includes("setShortcut"));
});

test("a key another component holds is still a conflict after one re-check", async () => {
  const { manager, calls } = fakeManager({ heldForever: true });

  const result = await manager.registerKeybinding("Control+Shift+F11", "dictation", () => {});

  assert.equal(result, "conflict");
  assert.equal(calls.filter((c) => c === "isGlobalShortcutAvailable").length, 2);
  assert.ok(!calls.includes("setShortcut"));
});

test("a slot this process already registered keeps its binding on a conflict", async () => {
  const { manager, calls } = fakeManager({ heldForever: true });
  manager.registeredSlots.add("dictation");

  const result = await manager.registerKeybinding("Control+Shift+F12", "dictation", () => {});

  assert.equal(result, "conflict");
  assert.deepEqual(calls, ["isGlobalShortcutAvailable"]);
});
