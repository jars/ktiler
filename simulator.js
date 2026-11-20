import { createState } from "./engine.js";
import { getDemoWindowId } from "./window-previews.js";

const slots = [
  { x: 0, y: 0 }, { x: 1280, y: 0 },
  { x: 0, y: 800 }, { x: 1280, y: 800 },
].map((position) => ({ ...position, width: 1280, height: 800 }));

export function createSimulatorState() {
  const displays = [
    {
      mode: "binary",
      apps: ["code", "terminal", "music"],
      layout: {
        axis: "x", weights: [0.75, 0.25],
        children: [{ axis: "y", weights: [0.6, 0.4], children: [null, null] }, null],
      },
    },
    { mode: "horizontal", apps: ["files", "sheet"] },
    { mode: "columns", apps: ["browser", "image"] },
  ].map(({ apps, ...layout }, index) => {
    const windows = apps.map(getDemoWindowId);
    return { ...slots[index], id: index + 1, ...layout, windows, activeWindowId: windows[0] };
  });
  return {
    ...createState(),
    displays,
    nextDisplayId: displays.length + 1,
    nextWindowId: Math.max(...displays.flatMap(({ windows }) => windows)) + 1,
  };
}

export function getDisplayBounds(displays) {
  return {
    minX: Math.min(...displays.map(({ x }) => x)),
    minY: Math.min(...displays.map(({ y }) => y)),
    maxX: Math.max(...displays.map(({ x, width }) => x + width)),
    maxY: Math.max(...displays.map(({ y, height }) => y + height)),
  };
}

export function getAddDisplaySlot(displays) {
  const { minX, minY, maxX, maxY } = getDisplayBounds(displays);
  // Use a vacant cell within the arrangement without shrinking the canvas to
  // make room for a placeholder. The fourth cell is the initial vacancy.
  return slots.find(({ x, y, width, height }) =>
    x >= minX && y >= minY && x + width <= maxX && y + height <= maxY
    && !displays.some((display) => x < display.x + display.width && x + width > display.x
      && y < display.y + display.height && y + height > display.y));
}

const directions = [["W", "up"], ["A", "left"], ["S", "down"], ["D", "right"]];

export const shortcutGroups = [
  ...["focus", "move"].map((type) => ({
    title: type === "focus" ? "Focus" : "Move",
    bindings: directions.map(([key, direction]) => ({
      keys: `Alt+${type === "move" ? "Shift+" : ""}${key}`,
      label: `${direction[0].toUpperCase()}${direction.slice(1)}`,
      action: { type, direction },
    })),
  })),
  {
    title: "Layout",
    bindings: [
      { keys: "Alt+B", label: "Binary", action: { type: "set-layout", mode: "binary" } },
      { keys: "Alt+\\", label: "Columns", action: { type: "set-layout", mode: "columns" } },
      { keys: "Alt+-", label: "Rows", action: { type: "set-layout", mode: "horizontal" } },
    ],
  },
  {
    title: "Rotate",
    bindings: [
      { keys: "Alt+Shift+R", label: "Clockwise", action: { type: "rotate", clockwise: true } },
      { keys: "Alt+Shift+E", label: "Counterclockwise", action: { type: "rotate", clockwise: false } },
    ],
  },
];

const actionsByKey = new Map(shortcutGroups.flatMap(({ bindings }) =>
  bindings.map(({ keys, action }) => [keys.toLowerCase(), action])));

export function getShortcutAction(event) {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.isComposing || event.getModifierState?.("AltGraph")) return;
  return actionsByKey.get(`alt+${event.shiftKey ? "shift+" : ""}${event.key.toLowerCase()}`);
}
