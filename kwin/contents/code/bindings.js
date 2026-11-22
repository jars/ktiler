// Shared by the JavaScript controller and the QML owner of the global keys.
function shortcutBindings() {
  const result = [];
  const bind = (name, text, fallback, action) => {
    const setting = `Shortcut${name.replace(/-(\w)/g, (_, letter) => letter.toUpperCase())}`;
    result.push({ name: `ktiler-${name}`, setting, text: `ktiler: ${text}`, fallback, action });
  };
  // KWin registers the shifted symbols, not Shift plus the top-row digits.
  for (const [key, mode, label] of [["!", "binary", "Binary layout"], ["@", "columns", "Columns layout"],
    ["#", "horizontal", "Rows layout"]]) {
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
  bind("Pause", "Pause / resume tiling", "Alt+Shift+K", { type: "pause" });
  return result;
}
