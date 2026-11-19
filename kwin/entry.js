/* This file is bundled with the shared simulator engine and adapter. */
const debugLogging = readConfig("DebugLogging", false) === true;
function showMoveFeedback(reason) {
  callDBus("org.kde.plasmashell", "/org/kde/osdService",
    "org.kde.osdService", "showText", "ktiler", reason);
}
const deferred = [];
const scheduler = new QTimer();
scheduler.singleShot = true;
scheduler.interval = 30;
scheduler.timeout.connect(() => {
  const callbacks = deferred.splice(0);
  for (const callback of callbacks) callback();
});
var ktiler = createController({
  workspace,
  maximizeArea: KWin.MaximizeArea,
  config: (key, fallback) => readConfig(key, fallback),
  log: (message) => console.warn(`[ktiler] ${message}`),
  debug: debugLogging,
  feedback: showMoveFeedback,
  defer: (callback) => {
    deferred.push(callback);
    if (!scheduler.active) scheduler.start();
  },
});

function configureShortcuts() {
  const bindings = [];
  const bind = (name, text, fallback, action) => {
    const setting = `Shortcut${name.replace(/-(\w)/g, (_, letter) => letter.toUpperCase())}`;
    bindings.push({ name, text, keys: readConfig(setting, fallback).trim(), action });
  };
  for (const [key, mode, label] of [["B", "binary", "Binary layout"], ["\\", "columns", "Columns layout"],
    ["-", "horizontal", "Rows layout"]]) {
    bind(`Layout-${mode}`, label, `Alt+${key}`, { type: "set-layout", mode });
  }
  for (const [key, direction] of [["W", "Up"], ["A", "Left"], ["S", "Down"], ["D", "Right"]]) {
    bind(`Focus-${direction}`, `Focus ${direction.toLowerCase()}`, `Alt+${key}`,
      { type: "focus", direction: direction.toLowerCase() });
    bind(`Move-${direction}`, `Move ${direction.toLowerCase()}`, `Alt+Shift+${key}`,
      { type: "move", direction: direction.toLowerCase() });
  }
  bind("RotateClockwise", "Rotate clockwise", "Alt+Shift+R", { type: "rotate", clockwise: true });
  bind("RotateCounterclockwise", "Rotate counterclockwise", "Alt+Shift+E", { type: "rotate", clockwise: false });

  // registerShortcut() prefers KDE's saved key over its argument, even after
  // unloading. Release only our own reservations before registering new keys,
  // so clears and swaps work and removed actions don't reserve their old keys.
  const retired = ["Pause", "Restore", "SpreadResize", ...Array.from({ length: 10 }, (_, i) => `Monitor-${i + 1}`)];
  const names = [...bindings.map(({ name }) => name), ...retired];
  const enabled = readConfig("RegisterShortcuts", true);
  let remaining = names.length;
  for (const name of names) {
    callDBus("org.kde.kglobalaccel", "/kglobalaccel", "org.kde.KGlobalAccel", "unregister", "kwin", `ktiler-${name}`, () => {
      if (--remaining !== 0 || !enabled) return;
      for (const { name, text, keys, action } of bindings) {
        if (keys) registerShortcut(`ktiler-${name}`, `ktiler: ${text}`, keys, () => ktiler.perform(action));
      }
    });
  }
}
configureShortcuts();
registerUserActionsMenu(() => ({
  text: "ktiler",
  items: [
    { text: "Pause / resume tiling", triggered: () => ktiler.perform({ type: "pause" }) },
    { text: "Restore original geometry and pause", triggered: () => ktiler.perform({ type: "restore" }) },
    { text: "Toggle Spread resize", triggered: () => ktiler.perform({ type: "toggle-spread" }) },
  ],
}));
console.log("[ktiler] Loaded.");
