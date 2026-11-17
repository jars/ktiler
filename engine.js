const MODES = ["binary", "columns", "horizontal"];
const DIRECTIONS = ["left", "right", "up", "down"];
const EPSILON = 0.000001;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const center = (start, size) => start + size / 2;
const overlap = (a, sizeA, b, sizeB) =>
  Math.max(0, Math.min(a + sizeA, b + sizeB) - Math.max(a, b));

export function createState() {
  return {
    displays: [
      {
        id: 1, x: 0, y: 0, width: 1280, height: 800,
        mode: "binary", windows: [1, 2, 3, 4], activeWindowId: 1,
      },
      {
        id: 2, x: 1280, y: 0, width: 1280, height: 800,
        mode: "binary", windows: [5, 6, 7], activeWindowId: 5,
      },
    ],
    activeDisplayId: 1,
    nextDisplayId: 3,
    nextWindowId: 8,
    message: "",
  };
}

export function getActiveDisplay(state) {
  return state.displays.find((display) => display.id === state.activeDisplayId);
}

/** Slots are normalized to their display. Window identity never determines geometry. */
export function getTiles(display) {
  const tiles = [];
  const count = display.windows.length;
  if (!count) return tiles;

  const add = (index, x, y, width, height) =>
    tiles.push({ index, windowId: display.windows[index], x, y, width, height });

  if (display.mode === "columns" || display.mode === "horizontal") {
    for (let i = 0; i < count; i++) {
      if (display.mode === "columns") add(i, i / count, 0, 1 / count, 1);
      else add(i, 0, i / count, 1, 1 / count);
    }
    return tiles;
  }

  function split(start, length, x, y, width, height, depth) {
    if (length === 1) return add(start, x, y, width, height);
    const first = Math.ceil(length / 2);
    if (depth % 2 === 0) {
      split(start, first, x, y, width / 2, height, depth + 1);
      split(start + first, length - first, x + width / 2, y, width / 2, height, depth + 1);
    } else {
      split(start, first, x, y, width, height / 2, depth + 1);
      split(start + first, length - first, x, y + height / 2, width, height / 2, depth + 1);
    }
  }

  split(0, count, 0, 0, 1, 1, 0);
  return tiles;
}

function neighbor(display, active, direction) {
  const horizontal = direction === "left" || direction === "right";
  const candidates = getTiles(display).flatMap((tile) => {
    if (tile.index === active.index) return [];
    const edgeMatches = {
      left: Math.abs(tile.x + tile.width - active.x) < EPSILON,
      right: Math.abs(active.x + active.width - tile.x) < EPSILON,
      up: Math.abs(tile.y + tile.height - active.y) < EPSILON,
      down: Math.abs(active.y + active.height - tile.y) < EPSILON,
    }[direction];
    const shared = horizontal
      ? overlap(tile.y, tile.height, active.y, active.height)
      : overlap(tile.x, tile.width, active.x, active.width);
    if (!edgeMatches || shared < EPSILON) return [];
    const offset = horizontal
      ? Math.abs(center(tile.y, tile.height) - center(active.y, active.height))
      : Math.abs(center(tile.x, tile.width) - center(active.x, active.width));
    return [{ tile, shared, offset }];
  });
  candidates.sort((a, b) =>
    b.shared - a.shared || a.offset - b.offset || a.tile.index - b.tile.index);
  return candidates[0]?.tile;
}

function neighboringDisplay(state, source, tile, direction) {
  const horizontal = direction === "left" || direction === "right";
  const exit = horizontal
    ? source.y + center(tile.y, tile.height) * source.height
    : source.x + center(tile.x, tile.width) * source.width;

  const candidates = state.displays.flatMap((display) => {
    if (display.id === source.id) return [];
    const gap = {
      left: source.x - (display.x + display.width),
      right: display.x - (source.x + source.width),
      up: source.y - (display.y + display.height),
      down: display.y - (source.y + source.height),
    }[direction];
    if (gap < -EPSILON) return [];
    const start = horizontal ? display.y : display.x;
    const size = horizontal ? display.height : display.width;
    const perpendicularGap = Math.max(start - exit, exit - (start + size), 0);
    return [{
      display,
      distance: gap ** 2 + perpendicularGap ** 2,
      alignment: Math.abs(center(start, size) - exit),
    }];
  });
  candidates.sort((a, b) =>
    a.distance - b.distance || a.alignment - b.alignment || a.display.id - b.display.id);
  return candidates[0]?.display;
}

function incomingTile(source, destination, active, direction) {
  const horizontal = direction === "left" || direction === "right";
  const position = horizontal
    ? (source.y + center(active.y, active.height) * source.height - destination.y) / destination.height
    : (source.x + center(active.x, active.width) * source.width - destination.x) / destination.width;
  const point = clamp(position, 0, 1);
  const incoming = getTiles(destination)
    .filter((tile) => ({
      right: tile.x < EPSILON,
      left: Math.abs(tile.x + tile.width - 1) < EPSILON,
      down: tile.y < EPSILON,
      up: Math.abs(tile.y + tile.height - 1) < EPSILON,
    })[direction])
    .map((tile) => {
      const start = horizontal ? tile.y : tile.x;
      const size = horizontal ? tile.height : tile.width;
      return {
        tile,
        distance: Math.max(start - point, point - (start + size), 0),
        alignment: Math.abs(center(start, size) - point),
      };
    });
  incoming.sort((a, b) =>
    a.distance - b.distance || a.alignment - b.alignment || a.tile.index - b.tile.index);
  return incoming[0]?.tile;
}

function rotationOrder(display) {
  const tiles = getTiles(display);
  // Collinear slots have no meaningful polar order: use their reading order.
  if (display.mode !== "binary" || tiles.length <= 2) return tiles.map((tile) => tile.index);
  const angle = (tile) =>
    (Math.atan2(center(tile.y, tile.height) - 0.5, center(tile.x, tile.width) - 0.5)
      + Math.PI * 2.5) % (Math.PI * 2);
  const radius = (tile) =>
    (center(tile.x, tile.width) - 0.5) ** 2 + (center(tile.y, tile.height) - 0.5) ** 2;
  return tiles
    .sort((a, b) => angle(a) - angle(b) || radius(a) - radius(b) || a.index - b.index)
    .map((tile) => tile.index);
}

function displayName(state, display) {
  return `Display ${state.displays.findIndex((item) => item.id === display.id) + 1}`;
}

/** All simulator actions pass through this reducer, independently of the browser. */
export function applyAction(previous, action) {
  if (action.type === "reset") return createState();
  const state = structuredClone(previous);
  const display = getActiveDisplay(state);
  state.message = "";

  switch (action.type) {
    case "select-display": {
      const target = state.displays.find((item) => item.id === action.id);
      if (!target) return previous;
      state.activeDisplayId = target.id;
      break;
    }
    case "select-window": {
      const target = state.displays.find((item) => item.windows.includes(action.id));
      if (!target) return previous;
      state.activeDisplayId = target.id;
      target.activeWindowId = action.id;
      break;
    }
    case "set-layout":
      if (!MODES.includes(action.mode)) return previous;
      display.mode = action.mode;
      break;
    case "add-window": {
      const id = state.nextWindowId++;
      display.windows.push(id);
      display.activeWindowId = id;
      break;
    }
    case "remove-window": {
      const index = display.windows.indexOf(display.activeWindowId);
      if (index < 0) return previous;
      display.windows.splice(index, 1);
      display.activeWindowId = display.windows[Math.min(index, display.windows.length - 1)] ?? null;
      break;
    }
    case "add-display": {
      const id = state.nextDisplayId++;
      const x = Math.max(...state.displays.map((item) => item.x + item.width));
      state.displays.push({
        id, x, y: display.y, width: display.width, height: display.height,
        mode: "binary", windows: [], activeWindowId: null,
      });
      state.activeDisplayId = id;
      break;
    }
    case "remove-display": {
      if (state.displays.length === 1) return previous;
      const nearest = state.displays.filter((item) => item.id !== display.id)
        .sort((a, b) => {
          const distance = (item) =>
            (center(item.x, item.width) - center(display.x, display.width)) ** 2
            + (center(item.y, item.height) - center(display.y, display.height)) ** 2;
          return distance(a) - distance(b) || a.id - b.id;
        })[0];
      nearest.windows.push(...display.windows);
      if (display.activeWindowId !== null) nearest.activeWindowId = display.activeWindowId;
      state.displays = state.displays.filter((item) => item.id !== display.id);
      state.activeDisplayId = nearest.id;
      state.message = `Windows moved to ${displayName(state, nearest).toLowerCase()}.`;
      break;
    }
    case "set-geometry": {
      const target = state.displays.find((item) => item.id === (action.id ?? display.id));
      if (!target) return previous;
      const geometry = {};
      for (const key of ["x", "y", "width", "height"]) {
        if (action[key] === undefined) continue;
        if (!Number.isFinite(action[key])) return previous;
        geometry[key] = Math.round(action[key]);
        if (!Number.isSafeInteger(geometry[key])) return previous;
      }
      if ((geometry.width !== undefined && geometry.width < 320)
        || (geometry.height !== undefined && geometry.height < 240)) {
        state.message = "Minimum display size: 320 × 240.";
        break;
      }
      Object.assign(target, geometry);
      break;
    }
    case "focus":
    case "move": {
      if (!DIRECTIONS.includes(action.direction)) return previous;
      const focusing = action.type === "focus";
      const active = getTiles(display).find((tile) => tile.windowId === display.activeWindowId)
        // Navigate from the center when the active display is empty.
        ?? (focusing ? { index: -1, x: 0, y: 0, width: 1, height: 1 } : null);
      if (!active) {
        state.message = "No active window.";
        break;
      }
      const adjacent = neighbor(display, active, action.direction);
      if (adjacent) {
        if (focusing) {
          display.activeWindowId = adjacent.windowId;
          state.message = `Selected window ${adjacent.windowId}.`;
          break;
        }
        [display.windows[active.index], display.windows[adjacent.index]]
          = [display.windows[adjacent.index], display.windows[active.index]];
        state.message = `Swapped windows ${active.windowId} and ${adjacent.windowId}.`;
        break;
      }
      const destination = neighboringDisplay(state, display, active, action.direction);
      if (!destination) {
        state.message = `No display to the ${action.direction}.`;
        break;
      }
      if (focusing) {
        const target = incomingTile(display, destination, active, action.direction);
        destination.activeWindowId = target?.windowId ?? null;
        state.activeDisplayId = destination.id;
        state.message = target
          ? `Selected window ${target.windowId}.`
          : `${displayName(state, destination)} is empty.`;
        break;
      }
      const index = incomingTile(display, {
        ...destination, windows: [...destination.windows, active.windowId],
      }, active, action.direction).index;
      display.windows.splice(active.index, 1);
      display.activeWindowId = display.windows[Math.min(active.index, display.windows.length - 1)] ?? null;
      destination.windows.splice(index, 0, active.windowId);
      destination.activeWindowId = active.windowId;
      state.activeDisplayId = destination.id;
      state.message = `Window ${active.windowId} → ${displayName(state, destination).toLowerCase()}.`;
      break;
    }
    case "rotate": {
      const order = rotationOrder(display);
      if (order.length < 2) break;
      const windows = [...display.windows];
      const step = action.clockwise === false ? -1 : 1;
      order.forEach((source, index) => {
        const target = order[(index + step + order.length) % order.length];
        display.windows[target] = windows[source];
      });
      state.message = action.clockwise === false ? "Rotated counterclockwise." : "Rotated clockwise.";
      break;
    }
    default:
      return previous;
  }
  return state;
}

export function isValidState(state) {
  if (!state || !Array.isArray(state.displays) || state.displays.length === 0) return false;
  const displayIds = new Set();
  const windowIds = new Set();
  for (const display of state.displays) {
    if (!display || !Number.isSafeInteger(display.id) || display.id < 1 || displayIds.has(display.id)
      || !MODES.includes(display.mode) || !Array.isArray(display.windows)
      || !["x", "y", "width", "height"].every((key) => Number.isSafeInteger(display[key]))
      || display.width < 320 || display.height < 240) return false;
    displayIds.add(display.id);
    for (const id of display.windows) {
      if (!Number.isSafeInteger(id) || id < 1 || windowIds.has(id)) return false;
      windowIds.add(id);
    }
    if (display.windows.length === 0 ? display.activeWindowId !== null
      : !display.windows.includes(display.activeWindowId)) return false;
  }
  return displayIds.has(state.activeDisplayId)
    && Number.isSafeInteger(state.nextDisplayId)
    && [...displayIds].every((id) => id < state.nextDisplayId)
    && Number.isSafeInteger(state.nextWindowId) && state.nextWindowId > 0
    && [...windowIds].every((id) => id < state.nextWindowId)
    && typeof state.message === "string";
}
