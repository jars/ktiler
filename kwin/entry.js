/* This file is bundled with the shared simulator engine and adapter. */
function settingsSnapshot() {
  return {
    debug: readConfig("DebugLogging", false) === true,
    layout: readConfig("DefaultLayout", "binary"),
    spread: readConfig("SpreadResize", true) !== false,
  };
}
let settings = settingsSnapshot();
function showToast(message) {
  try {
    callDBus("org.kde.plasmashell", "/org/kde/osdService",
      "org.kde.osdService", "showText", "ktiler", message);
  } catch (error) { /* Feedback must never disturb tiling. */ }
}
const deferred = [];
const scheduler = new QTimer();
scheduler.singleShot = true;
scheduler.interval = 30;
scheduler.timeout.connect(() => {
  const callbacks = deferred.splice(0);
  for (const callback of callbacks) callback();
});
function defer(callback) {
  deferred.push(callback);
  if (!scheduler.active) scheduler.start();
}
var ktiler = createController({
  workspace,
  maximizeArea: KWin.MaximizeArea,
  config: (key, fallback) => readConfig(key, fallback),
  log: (message) => console.warn(`[ktiler] ${message}`),
  debug: settings.debug,
  feedback: showToast,
  defer,
});

function performShortcut(action) {
  ktiler.perform(action);
  if (action.type === "pause") showToast(ktiler.isEnabled() ? "ktiler resumed" : "ktiler paused");
}

function refreshControllerSettings() {
  const next = settingsSnapshot();
  const changed = {};
  for (const key of Object.keys(next)) if (settings[key] !== next[key]) changed[key] = next[key];
  settings = next;
  ktiler.updateSettings(changed);
}

const scripting = (method, ...args) =>
  callDBus("org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting", method, ...args);
const unbind = (name, done) =>
  callDBus("org.kde.kglobalaccel", "/kglobalaccel", "org.kde.KGlobalAccel", "unregister", "kwin", name, done);
const invoke = (name) =>
  callDBus("org.kde.kglobalaccel", "/component/kwin", "org.kde.kglobalaccel.Component", "invokeShortcut", name);
const settingsWorker = "ktiler-settings-worker";
const reloadAction = "ktiler-internal-reload";
const bindings = shortcutBindings();

// On normal installs the optional worker owns the visible key bindings. Only
// it can dispose of and recreate KWin shortcut objects; registerShortcut()
// retains each QAction until its JavaScript script unloads. Keyless actions
// forward to the live controller without replacing it or routing any keystrokes.
const fileUrl = new Error().fileName || "";
const packageEntry = /^file:\/\/(\/.*\/kwin(?:-wayland)?\/scripts\/ktiler\/contents)\/code\/main\.js$/.exec(fileUrl);
let workerReady = false;
let fixedShortcuts = false;
const workerDeadline = new QTimer();
workerDeadline.singleShot = true;
workerDeadline.interval = 2500;
workerDeadline.timeout.connect(() => {
  // A failed QML load can still leave an entry in KWin's script list.
  console.warn("[ktiler] Settings worker did not start; shortcut changes require reloading ktiler.");
  scripting("unloadScript", settingsWorker);
  registerFixedShortcuts();
});

function registerFixedShortcuts() {
  if (workerReady || fixedShortcuts) return;
  fixedShortcuts = true;
  let remaining = bindings.length;
  for (const { name } of bindings) {
    unbind(name, () => {
      if (--remaining !== 0 || !readConfig("RegisterShortcuts", true)) return;
      for (const { name, text, setting, fallback, action } of bindings) {
        const keys = readConfig(setting, fallback).trim();
        if (keys) registerShortcut(name, text, keys, () => performShortcut(action));
      }
    });
  }
}

function loadSettingsWorker(workerPath) {
  scripting("isScriptLoaded", settingsWorker, (loaded) => {
    if (fixedShortcuts) return;
    if (loaded) {
      // A quick disable/enable can happen before the old worker's lifetime
      // check. Wait for its deferred deletion instead of reusing its keys.
      scripting("unloadScript", settingsWorker, () => defer(() => loadSettingsWorker(workerPath)));
      return;
    }
    scripting("loadDeclarativeScript", workerPath, settingsWorker, (id) => {
      if (id < 0 || fixedShortcuts) return;
      // KWin can reuse numeric script paths. Start without addressing a path.
      scripting("start");
    });
  });
}

if (packageEntry) {
  registerShortcut("ktiler-internal-ready", "ktiler: internal settings ready", "", () => {
    if (fixedShortcuts) {
      scripting("unloadScript", settingsWorker);
      return;
    }
    workerReady = true;
    workerDeadline.stop();
    invoke(reloadAction);
  });
  registerShortcut("ktiler-internal-applied", "ktiler: internal settings update", "", refreshControllerSettings);
  for (const { name, text, action } of bindings) {
    registerShortcut(`${name}-relay`, `${text} (internal)`, "", () => performShortcut(action));
  }
  workerDeadline.start();
  try {
    loadSettingsWorker(`${decodeURIComponent(packageEntry[1])}/${settingsWorkerPath}`);
  } catch (error) {
    console.warn(`[ktiler] Could not load settings worker: ${error}`);
    registerFixedShortcuts();
  }
} else {
  registerFixedShortcuts();
}

// Only ktiler's own retired registrations are released.
for (const name of ["Restore", "SpreadResize", ...Array.from({ length: 10 }, (_, i) => `Monitor-${i + 1}`)]) {
  unbind(`ktiler-${name}`, () => {});
}
registerUserActionsMenu(() => ({
  text: "ktiler",
  items: [
    { text: "Pause / resume tiling", triggered: () => ktiler.perform({ type: "pause" }) },
    { text: "Restore original geometry and pause", triggered: () => ktiler.perform({ type: "restore" }) },
    { text: "Toggle Spread resize", triggered: () => ktiler.perform({ type: "toggle-spread" }) },
    { text: "Reload settings", triggered: () => {
      if (workerReady) invoke(reloadAction);
      else scripting("start", refreshControllerSettings);
    } },
  ],
}));
console.log("[ktiler] Loaded.");
