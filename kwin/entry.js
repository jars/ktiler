/* This file is bundled with the shared simulator engine and adapter. */
const debugLogging = readConfig("DebugLogging", false) === true;
function notify(summary, body) {
  // Debug diagnostics only; a failed notification must never disturb tiling.
  try {
    callDBus("org.freedesktop.Notifications", "/org/freedesktop/Notifications",
      "org.freedesktop.Notifications", "Notify",
      "ktiler", 0, "ktiler", summary, body, [], {}, 6000);
  } catch (error) { console.warn(`[ktiler] Could not show a notification: ${error}`); }
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
  toast: notify,
  defer: (callback) => {
    deferred.push(callback);
    if (!scheduler.active) scheduler.start();
  },
});

if (readConfig("RegisterShortcuts", true)) {
  const modifier = readConfig("Modifier", "Alt") === "Meta" ? "Meta" : "Alt";
  const bind = (name, text, keys, action) =>
    registerShortcut(`ktiler-${name}`, `ktiler: ${text}`, keys, () => ktiler.perform(action));
  for (const [key, mode] of [["B", "binary"], ["V", "columns"], ["H", "horizontal"]]) {
    bind(`Layout-${mode}`, `${mode} layout`, `${modifier}+${key}`, { type: "set-layout", mode });
  }
  for (const direction of ["Left", "Right", "Up", "Down"]) {
    bind(`Focus-${direction}`, `Select ${direction.toLowerCase()}`, `${modifier}+${direction}`,
      { type: "focus", direction: direction.toLowerCase() });
    bind(`Move-${direction}`, `Move ${direction.toLowerCase()}`, `${modifier}+Shift+${direction}`,
      { type: "move", direction: direction.toLowerCase() });
  }
  bind("RotateClockwise", "Rotate clockwise", `${modifier}+Shift+R`, { type: "rotate", clockwise: true });
  bind("RotateCounterclockwise", "Rotate counterclockwise", `${modifier}+Shift+E`, { type: "rotate", clockwise: false });
  for (let index = 0; index < 10; index++) {
    bind(`Monitor-${index + 1}`, `Activate monitor ${index + 1}`, `${modifier}+${(index + 1) % 10}`,
      { type: "select-monitor", index });
  }
  bind("Pause", "Pause / resume tiling", "Meta+Ctrl+Alt+P", { type: "pause" });
  bind("Restore", "Restore original geometry and pause", "Meta+Ctrl+Alt+R", { type: "restore" });
  bind("SpreadResize", "Toggle Spread resize (this session)", "", { type: "toggle-spread" });
}
registerUserActionsMenu(() => ({
  text: "ktiler",
  items: [
    { text: "Pause / resume tiling", triggered: () => ktiler.perform({ type: "pause" }) },
    { text: "Restore original geometry and pause", triggered: () => ktiler.restore() },
    { text: "Toggle Spread resize", triggered: () => ktiler.perform({ type: "toggle-spread" }) },
  ],
}));
console.log("[ktiler] Prototype loaded. Restore: Meta+Ctrl+Alt+R. Pause: Meta+Ctrl+Alt+P.");
