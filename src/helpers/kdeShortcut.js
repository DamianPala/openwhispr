const debugLogger = require("./debugLogger");
const { startGuard: startGuardProcess } = require("./kdeShortcutGuard");

let dbus = null;

function getDBus() {
  if (dbus) return dbus;
  try {
    dbus = require("@homebridge/dbus-native");
    return dbus;
  } catch (err) {
    debugLogger.log("[KDEShortcut] Failed to load dbus-native:", err.message);
    return null;
  }
}

// Qt::Key and Qt::KeyboardModifier values for KGlobalAccel
const QT_MODIFIERS = {
  control: 0x04000000,
  ctrl: 0x04000000,
  alt: 0x08000000,
  shift: 0x02000000,
  super: 0x10000000,
  meta: 0x10000000,
  commandorcontrol: 0x04000000,
};

const QT_KEYS = {
  a: 0x41,
  b: 0x42,
  c: 0x43,
  d: 0x44,
  e: 0x45,
  f: 0x46,
  g: 0x47,
  h: 0x48,
  i: 0x49,
  j: 0x4a,
  k: 0x4b,
  l: 0x4c,
  m: 0x4d,
  n: 0x4e,
  o: 0x4f,
  p: 0x50,
  q: 0x51,
  r: 0x52,
  s: 0x53,
  t: 0x54,
  u: 0x55,
  v: 0x56,
  w: 0x57,
  x: 0x58,
  y: 0x59,
  z: 0x5a,
  0: 0x30,
  1: 0x31,
  2: 0x32,
  3: 0x33,
  4: 0x34,
  5: 0x35,
  6: 0x36,
  7: 0x37,
  8: 0x38,
  9: 0x39,
  f1: 0x01000030,
  f2: 0x01000031,
  f3: 0x01000032,
  f4: 0x01000033,
  f5: 0x01000034,
  f6: 0x01000035,
  f7: 0x01000036,
  f8: 0x01000037,
  f9: 0x01000038,
  f10: 0x01000039,
  f11: 0x0100003a,
  f12: 0x0100003b,
  space: 0x20,
  tab: 0x01000001,
  escape: 0x01000000,
  backspace: 0x01000003,
  enter: 0x01000005,
  return: 0x01000004,
  insert: 0x01000006,
  delete: 0x01000007,
  home: 0x01000010,
  end: 0x01000011,
  pageup: 0x01000016,
  pagedown: 0x01000017,
  up: 0x01000013,
  down: 0x01000015,
  left: 0x01000012,
  right: 0x01000014,
  "`": 0x60,
  grave: 0x60,
  // Unshifted punctuation (Qt::Key_*). Same set GNOME maps to X11 keysyms.
  ",": 0x2c,
  ".": 0x2e,
  "/": 0x2f,
  "-": 0x2d,
  "=": 0x3d,
  ";": 0x3b,
  "'": 0x27,
  "\\": 0x5c,
  "[": 0x5b,
  "]": 0x5d,
  plus: 0x2b,
  print: 0x01000009,
  scrolllock: 0x01000026,
  pause: 0x01000008,
};

const COMPONENT_NAME = "openwhispr";

// Temporary slots that grab a key other apps need (Escape). KGlobalAccel keeps
// a shortcut active after its owner process is gone, so these are registered
// only while a guard process is alive to unregister them if the app dies.
const GUARDED_SLOTS = new Set(["cancel"]);

function actionIdFor(slotName) {
  // [componentUnique, actionUnique, componentFriendly, actionFriendly]
  return [COMPONENT_NAME, slotName, "OpenWhispr", `OpenWhispr ${slotName}`];
}

class KDEShortcutManager {
  // `guardDeps` ({ spawn, hasDbusSend, kill }) is a test seam for the guard process.
  constructor({ guardDeps = {} } = {}) {
    this.bus = null;
    this.kglobalaccel = null;
    this.componentProxy = null;
    this.callbacks = new Map();
    this.registeredSlots = new Set();
    this.guards = new Map();
    // slot -> token of the guarded registration allowed to complete (see registerKeybinding)
    this.registrationTokens = new Map();
    this.pendingRegistrations = new Set();
    this._guardDeps = guardDeps;
  }

  static isGuardedSlot(slotName) {
    return GUARDED_SLOTS.has(slotName);
  }

  static isKDE() {
    const desktop = (process.env.XDG_CURRENT_DESKTOP || "").toLowerCase();
    return desktop.includes("kde");
  }

  static isWayland() {
    return process.env.XDG_SESSION_TYPE === "wayland";
  }

  static convertToQtKeyCode(electronHotkey) {
    const parts = electronHotkey.split("+");
    let qtKey = 0;

    for (const part of parts) {
      const lower = part.toLowerCase().trim();
      if (QT_MODIFIERS[lower]) {
        qtKey |= QT_MODIFIERS[lower];
      } else {
        const key = QT_KEYS[lower] || QT_KEYS[lower.replace("arrow", "")];
        if (key) {
          qtKey |= key;
        } else {
          debugLogger.log(`[KDEShortcut] Unknown key: "${part}"`);
          return null;
        }
      }
    }

    return qtKey;
  }

  async init() {
    const dbusModule = getDBus();
    if (!dbusModule) return false;

    try {
      this.bus = dbusModule.sessionBus();
      // Without a listener, async socket errors (e.g. a stale
      // DBUS_SESSION_BUS_ADDRESS) crash the process as an unhandled
      // "error" event — sessionBus() returns before connecting.
      this.bus.connection.on("error", (err) => {
        debugLogger.log("[KDEShortcut] D-Bus connection error:", err.message);
      });
      this.kglobalaccel = await new Promise((resolve, reject) => {
        this.bus
          .getService("org.kde.kglobalaccel")
          .getInterface("/kglobalaccel", "org.kde.KGlobalAccel", (err, iface) => {
            if (err) return reject(err);
            resolve(iface);
          });
      });

      debugLogger.log("[KDEShortcut] Connected to KGlobalAccel D-Bus");
      return true;
    } catch (err) {
      debugLogger.log("[KDEShortcut] Failed to connect:", err.message);
      this.bus = null;
      this.kglobalaccel = null;
      return false;
    }
  }

  async _listenForComponent() {
    if (this.componentProxy) return true;

    try {
      const componentPath = `/component/${COMPONENT_NAME}`;
      const iface = await new Promise((resolve, reject) => {
        this.bus
          .getService("org.kde.kglobalaccel")
          .getInterface(componentPath, "org.kde.kglobalaccel.Component", (err, ifc) => {
            if (err) return reject(err);
            resolve(ifc);
          });
      });

      iface.on("globalShortcutPressed", (componentUnique, shortcutUnique, timestamp) => {
        debugLogger.log("[KDEShortcut] Shortcut pressed", { componentUnique, shortcutUnique });
        // KGlobalAccel signal sends the actionUnique value as shortcutUnique.
        // Direct callback lookup by slotName should match. Fallback maps
        // actionFriendly names for compatibility.
        const callback =
          this.callbacks.get(shortcutUnique) || this._findCallbackByFriendlyName(shortcutUnique);
        if (callback) {
          callback(undefined, "down");
        } else {
          debugLogger.log("[KDEShortcut] No callback found for", {
            shortcutUnique,
            registered: [...this.callbacks.keys()],
          });
        }
      });
      iface.on("globalShortcutReleased", (componentUnique, shortcutUnique) => {
        debugLogger.log("[KDEShortcut] Shortcut released", { componentUnique, shortcutUnique });
        const slotName = this.callbacks.has(shortcutUnique)
          ? shortcutUnique
          : this._findSlotByFriendlyName(shortcutUnique);
        if (slotName !== "dictation") return;
        this.callbacks.get(slotName)?.(undefined, "up");
      });

      this.componentProxy = iface;
      debugLogger.log("[KDEShortcut] Listening for globalShortcutPressed on", componentPath);
      return true;
    } catch (err) {
      debugLogger.log("[KDEShortcut] Failed to listen on component:", err.message);
      return false;
    }
  }

  _findCallbackByFriendlyName(name) {
    const slotName = this._findSlotByFriendlyName(name);
    return slotName ? this.callbacks.get(slotName) : null;
  }

  _findSlotByFriendlyName(name) {
    // Map friendly names back to slot names
    const friendlyToSlot = {};
    for (const slotName of this.registeredSlots) {
      friendlyToSlot[`OpenWhispr ${slotName}`] = slotName;
      friendlyToSlot[`OpenWhispr`] = "dictation"; // legacy compat
    }
    return friendlyToSlot[name] || null;
  }

  async registerKeybinding(electronHotkey, slotName = "dictation", callback, isPushToTalk = false) {
    const registration = this._registerKeybinding(electronHotkey, slotName, callback, isPushToTalk);
    // close() waits for registrations in flight, so one that was superseded can
    // still release its key on a connection that is not closed yet.
    const tracked = GUARDED_SLOTS.has(slotName);
    if (tracked) this.pendingRegistrations.add(registration);
    try {
      return await registration;
    } finally {
      this.pendingRegistrations.delete(registration);
    }
  }

  async _registerKeybinding(electronHotkey, slotName, callback, isPushToTalk) {
    if (!this.kglobalaccel) return false;

    const qtKey = KDEShortcutManager.convertToQtKeyCode(electronHotkey);
    if (qtKey === null) {
      debugLogger.log(`[KDEShortcut] Could not convert "${electronHotkey}" to Qt key code`);
      return false;
    }

    // Modifier-only shortcuts (e.g. Control+Super) don't work on X11.
    // KWin accepts them on Wayland, but emits press and release together after
    // the first modifier is released, so they cannot represent push-to-talk.
    const QT_MODIFIER_MASK = 0xfe000000;
    const isModifierOnly = (qtKey & ~QT_MODIFIER_MASK) === 0;
    const modifierOnlyUnsupported =
      isModifierOnly &&
      (!KDEShortcutManager.isWayland() || (slotName === "dictation" && isPushToTalk));
    if (modifierOnlyUnsupported) {
      debugLogger.log("[KDEShortcut] Modifier-only shortcut not supported in this mode", {
        slot: slotName,
        hotkey: electronHotkey,
        isPushToTalk,
        qtKey: `0x${qtKey.toString(16)}`,
      });
      return "modifier-only";
    }

    const actionId = actionIdFor(slotName);
    const guarded = GUARDED_SLOTS.has(slotName);
    // A guarded registration spans several D-Bus round trips and is not tracked
    // by the caller yet, so an unregister (recording ended) or close() can
    // arrive in the middle. They delete the token; the registration notices
    // after every await and undoes whatever it already did. A newer registration
    // replaces the token and owns the action from then on. An invalidated slot
    // holds null (or nothing, after close()).
    const token = guarded ? {} : null;
    if (guarded) this.registrationTokens.set(slotName, token);
    const superseded = () => guarded && this.registrationTokens.get(slotName) !== token;
    let guard = null;

    try {
      // Pre-registration conflict check. isGlobalShortcutAvailable(int key, string
      // component) takes plain values and answers false when the key belongs to
      // another component. Do not use globalShortcutsByKey here: its QKeySequence
      // argument is a struct, and a malformed one aborts KWin.
      try {
        let available = await this._isKeyAvailable(qtKey);
        // The check also answers false for a key held by this component's own
        // action, and KGlobalAccel keeps the action of a killed instance active.
        // A slot this process has not registered yet can only be held by such
        // a leftover, so clear it and ask once more. Guarded slots have their
        // guard (and the startup cleanup) for that and touch nothing before it.
        if (available === false && !guarded && !this.registeredSlots.has(slotName)) {
          await this._unRegisterAction(actionId);
          if (superseded()) return "superseded";
          available = await this._isKeyAvailable(qtKey);
          if (available !== false) {
            debugLogger.log("[KDEShortcut] Cleared a leftover registration of this slot", {
              slot: slotName,
              hotkey: electronHotkey,
            });
          }
        }
        if (available === false) {
          debugLogger.log("[KDEShortcut] Shortcut conflict — key owned by another component", {
            slot: slotName,
            hotkey: electronHotkey,
          });
          return "conflict";
        }
      } catch (checkErr) {
        // Not fatal: the check after setShortcut still catches a conflict.
        debugLogger.log(
          "[KDEShortcut] Could not check for conflicts, proceeding:",
          checkErr.message
        );
      }

      if (superseded()) return "superseded";

      // The guard goes up before anything is registered, so there is no moment
      // at which the key is grabbed and nothing would release it after a crash.
      if (guarded) {
        guard = this._spawnGuard(slotName, actionId);
        if (!guard) return "no-guard";
      }

      // Clear stale registration, then register with flag 0x02 (SetPresent).
      // Flag 0x02 overwrites any saved binding; flag 0 preserves stale values.
      try {
        await new Promise((resolve, reject) => {
          this.kglobalaccel.unRegister(actionId, (err) => {
            if (err) return reject(err);
            resolve();
          });
        });
      } catch {}
      if (superseded()) return this._abandonRegistration(slotName, actionId, guard);
      await new Promise((resolve, reject) => {
        this.kglobalaccel.doRegister(actionId, (err) => {
          if (err) return reject(err);
          resolve();
        });
      });
      if (superseded()) return this._abandonRegistration(slotName, actionId, guard);
      if (guarded && !guard.isAlive()) {
        debugLogger.log(`[KDEShortcut] Guard for "${slotName}" died before registration`);
        this._settleGuard(slotName, guard, await this._unRegisterAction(actionId));
        return "no-guard";
      }
      const result = await new Promise((resolve, reject) => {
        this.kglobalaccel.setShortcut(actionId, [qtKey], 0x02, (err, res) => {
          if (err) return reject(err);
          resolve(res);
        });
      });

      if (superseded()) return this._abandonRegistration(slotName, actionId, guard);

      // Post-registration conflict check: if setShortcut assigned a different key,
      // another component owns it.
      const assignedKey = Array.isArray(result) && result.length > 0 ? result[0] : null;
      if (assignedKey !== null && assignedKey !== qtKey) {
        debugLogger.log("[KDEShortcut] Shortcut conflict — setShortcut assigned different key", {
          slot: slotName,
          requested: `0x${qtKey.toString(16)}`,
          assigned: `0x${assignedKey.toString(16)}`,
        });
        this._settleGuard(slotName, guard, await this._unRegisterAction(actionId));
        return "conflict";
      }

      if (callback) this.callbacks.set(slotName, callback);
      this.registeredSlots.add(slotName);

      // Start listening for press events on the component
      const listening = await this._listenForComponent();
      if (superseded()) return this._abandonRegistration(slotName, actionId, guard);
      if (!listening) {
        debugLogger.log(
          `[KDEShortcut] Keybinding registered but listener failed for "${slotName}", unregistering`
        );
        this._settleGuard(slotName, guard, await this._unRegisterAction(actionId));
        return false;
      }

      debugLogger.log("[KDEShortcut] Registered", {
        slot: slotName,
        hotkey: electronHotkey,
        qtKey: `0x${qtKey.toString(16)}`,
      });
      return true;
    } catch (err) {
      debugLogger.log(`[KDEShortcut] Registration failed for "${slotName}":`, err.message);
      if (superseded()) return this._abandonRegistration(slotName, actionId, guard);
      if (guarded) this._settleGuard(slotName, guard, await this._unRegisterAction(actionId));
      return false;
    }
  }

  // A registration that lost its token (unregister, close() or a newer
  // registration) undoes what it did. Its in-flight doRegister/setShortcut may
  // have reached KGlobalAccel after the unRegister that superseded it, so the
  // key is released again here. With a newer registration the action and the
  // guard are the newer one's and are left alone.
  async _abandonRegistration(slotName, actionId, guard) {
    if (this.registrationTokens.get(slotName) == null) {
      this.callbacks.delete(slotName);
      this.registeredSlots.delete(slotName);
      this._settleGuard(slotName, guard, await this._unRegisterAction(actionId));
      debugLogger.log(`[KDEShortcut] Registration of "${slotName}" superseded, key released`);
    }
    return "superseded";
  }

  _isKeyAvailable(qtKey) {
    const dbusModule = getDBus();
    return new Promise((resolve, reject) => {
      this.bus.invoke(
        {
          type: dbusModule.messageType.methodCall,
          destination: "org.kde.kglobalaccel",
          path: "/kglobalaccel",
          interface: "org.kde.KGlobalAccel",
          member: "isGlobalShortcutAvailable",
          signature: "is",
          body: [qtKey, COMPONENT_NAME],
        },
        (err, result) => {
          if (err) return reject(err);
          resolve(result);
        }
      );
    });
  }

  async _unRegisterAction(actionId) {
    try {
      await new Promise((resolve, reject) => {
        this.kglobalaccel.unRegister(actionId, (err) => {
          if (err) return reject(err);
          resolve();
        });
      });
      return true;
    } catch {
      return false;
    }
  }

  // Returns null (with the reason logged) when no guard could be started; the
  // caller must then leave the key unregistered.
  _spawnGuard(slotName, actionId) {
    let guard;
    try {
      guard = startGuardProcess(actionId, this._guardDeps);
    } catch (err) {
      debugLogger.log(`[KDEShortcut] No guard for "${slotName}":`, err.message);
      return null;
    }
    const previous = this.guards.get(slotName);
    this.guards.set(slotName, guard);
    previous?.stop();
    return guard;
  }

  // Kills the guard's process group; a stopped guard never unregisters anything,
  // so it cannot race a later registration of the key. With `expected`, only
  // that guard is stopped: a newer registration may have replaced it (stopping
  // the old one when it spawned), and its guard must live.
  _stopGuard(slotName, expected) {
    const guard = this.guards.get(slotName);
    if (!guard || (expected && guard !== expected)) return;
    this.guards.delete(slotName);
    guard.stop();
  }

  // Called once the in-process unRegister has been answered. If it went through
  // the guard is no longer needed. If it did not (connection lost), the key may
  // still be grabbed, so the guard fires: its own dbus-send releases it. A fired
  // guard stays in the map until the next registration or close() stops it.
  _settleGuard(slotName, guard, released) {
    if (!guard) return;
    if (released) this._stopGuard(slotName, guard);
    else guard.fire();
  }

  async unregisterKeybinding(slotName = "dictation") {
    if (!this.kglobalaccel) return;

    const actionId = actionIdFor(slotName);

    // The guard outlives the in-process unRegister and is stopped only once it
    // succeeded (see _settleGuard). A newer registration stops it earlier, when
    // it spawns its own. The bookkeeping is dropped before the await so that a
    // registration for the next recording, made while this call is in flight,
    // is not undone by it.
    const guarded = GUARDED_SLOTS.has(slotName);
    const guard = guarded ? this.guards.get(slotName) : undefined;
    if (guarded) {
      this.registrationTokens.set(slotName, null);
      this.callbacks.delete(slotName);
      this.registeredSlots.delete(slotName);
    }

    let released = false;
    try {
      await new Promise((resolve, reject) => {
        this.kglobalaccel.unRegister(actionId, (err) => {
          if (err) return reject(err);
          resolve();
        });
      });
      released = true;
      if (!guarded) {
        this.callbacks.delete(slotName);
        this.registeredSlots.delete(slotName);
      }
      debugLogger.log("[KDEShortcut] Unregistered", { slot: slotName });
    } catch (err) {
      debugLogger.log(`[KDEShortcut] Unregister failed for "${slotName}":`, err.message);
    }
    this._settleGuard(slotName, guard, released);
  }

  async removeRetiredAgentKeybinding() {
    await this.unregisterKeybinding("agent");
  }

  // A guard that was itself killed (or an app killed before it could clean up)
  // leaves its action registered. Nothing is registered yet at init, so this
  // touches no live guard.
  async removeStaleGuardedKeybindings() {
    for (const slotName of GUARDED_SLOTS) {
      await this._unRegisterAction(actionIdFor(slotName));
    }
  }

  close() {
    // Best-effort cleanup on app shutdown. unRegister calls are async D-Bus
    // calls that may not complete before disconnect. KGlobalAccel does NOT
    // clean up the shortcuts of a dead process: KWin keeps grabbing the key.
    // Slots that grab keys other apps need (GUARDED_SLOTS) are therefore
    // covered by a guard process in case this cleanup never runs.
    this.registrationTokens.clear();
    const promises = [...this.pendingRegistrations];
    const released = new Set();
    for (const slotName of this.registeredSlots) {
      const actionId = actionIdFor(slotName);
      try {
        promises.push(
          new Promise((resolve, reject) => {
            this.kglobalaccel?.unRegister(actionId, (err) => {
              if (err) return reject(err);
              released.add(slotName);
              resolve();
            });
          })
        );
      } catch {}
    }

    Promise.allSettled(promises).finally(() => {
      // Guards go once the unRegisters are answered: one whose unRegister failed
      // fires and releases the key itself; if the process exits before this
      // point, every guard fires on its own when the pipe closes.
      for (const [slotName, guard] of [...this.guards]) {
        this._settleGuard(slotName, guard, released.has(slotName));
      }
      if (this.bus) {
        try {
          this.bus.connection.end();
        } catch {}
        this.bus = null;
        this.kglobalaccel = null;
        this.componentProxy = null;
      }
    });

    this.callbacks.clear();
    this.registeredSlots.clear();
  }
}

module.exports = KDEShortcutManager;
