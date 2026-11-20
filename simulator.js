import { applyAction, createState } from "./engine.js";
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
      activeApp: "terminal",
      layout: {
        axis: "x", weights: [0.75, 0.25],
        children: [{ axis: "y", weights: [0.6, 0.4], children: [null, null] }, null],
      },
    },
    { mode: "horizontal", apps: ["files", "sheet"] },
    { mode: "columns", apps: ["browser", "image"] },
    { mode: "binary", apps: [] },
  ].map(({ apps, activeApp = apps[0], ...layout }, index) => {
    const windows = apps.map(getDemoWindowId);
    return { ...slots[index], id: index + 1, ...layout, windows,
      activeWindowId: activeApp ? getDemoWindowId(activeApp) : null };
  });
  return {
    ...createState(),
    displays,
    nextDisplayId: displays.length + 1,
    nextWindowId: Math.max(...displays.flatMap(({ windows }) => windows)) + 1,
  };
}

export function createShowcaseState() {
  const state = createState();
  const windows = [["code", "terminal"], ["image", "browser"]];
  return {
    ...state,
    displays: state.displays.map(({ id, width }, index) => ({
      id, width, x: 0, y: 640 * index, height: 640, mode: index === 0 ? "columns" : "binary",
      windows: windows[index].map(getDemoWindowId),
      activeWindowId: getDemoWindowId(windows[index][1]),
      layout: { axis: "x", weights: [0.5, 0.5], children: [null, null] },
    })),
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

const bindings = shortcutGroups.flatMap((group) => group.bindings);
const actionsByKey = new Map(bindings.map(({ keys, action }) => [keys.toLowerCase(), action]));

// Each move is a real simulator action. The last one restores the initial layout.
export const showcaseSteps = ["down", "left", "right", "up", "left", "right"].map((direction) =>
  bindings.find(({ action }) => action.type === "move" && action.direction === direction));

export const moveTutorialSteps = [
  { type: "move", from: 1, to: 3, direction: "down" },
  { type: "focus", from: 3, to: 3, direction: "right", targetId: getDemoWindowId("image") },
  { type: "move", from: 3, to: 4, direction: "right" },
  { type: "move", from: 2, to: 4, direction: "down" },
];

export function getMoveTutorialTip(state, step) {
  if (!step) return null;
  const source = state.displays.find(({ id }) => id === step.from);
  if (!source?.windows.length) return null;
  const { keys, action } = bindings.find(({ action }) => action.type === step.type && action.direction === step.direction);
  if (step.type === "focus") {
    const next = applyAction(state, action);
    return completesMoveTutorialStep(state, next, action, step) ? { id: step.targetId, keys } : null;
  }
  // Prefer the current selection when eligible; otherwise point at a window
  // that transfers immediately, rather than a window the chord would swap.
  for (const id of new Set([source.activeWindowId, ...source.windows])) {
    const selected = applyAction(state, { type: "select-window", id });
    const next = applyAction(selected, action);
    if (completesMoveTutorialStep(selected, next, action, step)) {
      return { id, keys, selected: state.activeDisplayId === step.from && source.activeWindowId === id };
    }
  }
  return null;
}

export function completesMoveTutorialStep(before, after, action, step) {
  if (!step || before.activeDisplayId !== step.from || after.activeDisplayId !== step.to) return false;
  const source = before.displays.find(({ id }) => id === step.from);
  const destination = after.displays.find(({ id }) => id === step.to);
  const matchesShortcut = action.type === step.type && action.direction === step.direction;
  if (step.type === "focus") {
    return source?.activeWindowId !== step.targetId && destination?.activeWindowId === step.targetId
      && (matchesShortcut || action.type === "select-window");
  }
  return matchesShortcut && (destination?.windows.includes(source?.activeWindowId) ?? false);
}

export function getShortcutAction(event) {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.isComposing || event.getModifierState?.("AltGraph")) return;
  return actionsByKey.get(`alt+${event.shiftKey ? "shift+" : ""}${event.key.toLowerCase()}`);
}
