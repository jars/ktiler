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
    spreadResize: true,
    message: "",
  };
}

export function getActiveDisplay(state) {
  return state.displays.find((display) => display.id === state.activeDisplayId);
}

// Leaves are slots, not windows: swapping identities never changes proportions.
function buildLayout(count, mode, previous = null, depth = 0) {
  if (count <= 1) return null;
  if (mode !== "binary") {
    const axis = mode === "columns" ? "x" : "y";
    const weights = previous?.axis === axis ? [...previous.weights] : [];
    if (!weights.length) weights.push(1);
    while (weights.length < count) {
      const factor = weights.length / (weights.length + 1);
      for (let i = 0; i < weights.length; i++) weights[i] *= factor;
      weights.push(1 / (weights.length + 1));
    }
    while (weights.length > count) {
      const last = weights.pop();
      weights[weights.length - 1] += last;
    }
    return { axis, weights, children: Array(count).fill(null) };
  }
  const axis = depth % 2 === 0 ? "x" : "y";
  const old = previous?.axis === axis && previous.children.length === 2 ? previous : null;
  const first = Math.ceil(count / 2);
  return {
    axis,
    weights: old ? [...old.weights] : [0.5, 0.5],
    children: [
      buildLayout(first, mode, old?.children[0], depth + 1),
      buildLayout(count - first, mode, old?.children[1], depth + 1),
    ],
  };
}

function syncLayout(display, removedIndex) {
  if (display.layout === undefined) return; // Old saved states need no migration.
  if (removedIndex !== undefined && display.mode !== "binary" && display.layout) {
    const weights = [...display.layout.weights];
    const [removed] = weights.splice(removedIndex, 1);
    if (weights.length) weights[Math.min(removedIndex, weights.length - 1)] += removed;
    display.layout = weights.length > 1
      ? { axis: display.layout.axis, weights, children: weights.map(() => null) }
      : null;
  }
  display.layout = buildLayout(display.windows.length, display.mode, display.layout);
}

// Virtual minimum tile size; scale it down when too many windows make it impossible.
function minimumSize(node) {
  if (!node) return { width: 96, height: 64 };
  const sizes = node.children.map(minimumSize);
  return {
    width: node.axis === "x"
      ? Math.max(...sizes.map((size, index) => size.width / node.weights[index]))
      : Math.max(...sizes.map((size) => size.width)),
    height: node.axis === "y"
      ? Math.max(...sizes.map((size, index) => size.height / node.weights[index]))
      : Math.max(...sizes.map((size) => size.height)),
  };
}

function layoutGeometry(display) {
  const tiles = [];
  const boundaries = [];
  if (!display.windows.length) return { tiles, boundaries };
  const root = buildLayout(display.windows.length, display.mode, display.layout);
  const minimum = minimumSize(root);
  const scaleX = Math.min(1, display.width / minimum.width) / display.width;
  const scaleY = Math.min(1, display.height / minimum.height) / display.height;

  function visit(node, x, y, width, height, path) {
    if (!node) {
      const index = tiles.length;
      tiles.push({ index, windowId: display.windows[index], x, y, width, height });
      return;
    }
    const horizontal = node.axis === "x";
    const start = horizontal ? x : y;
    const extent = horizontal ? width : height;
    const edges = [start];
    let position = start;
    node.children.forEach((child, index) => {
      const end = index === node.children.length - 1
        ? start + extent : position + extent * node.weights[index];
      if (horizontal) visit(child, position, y, end - position, height, `${path}/${index}`);
      else visit(child, x, position, width, end - position, `${path}/${index}`);
      position = end;
      edges.push(end);
    });
    // Ancestor dividers are last, so they win hit testing at T-junctions.
    for (let index = 0; index < node.children.length - 1; index++) {
      const first = minimumSize(node.children[index]);
      const second = minimumSize(node.children[index + 1]);
      const min = edges[index] + (horizontal ? first.width * scaleX : first.height * scaleY);
      const max = edges[index + 2] - (horizontal ? second.width * scaleX : second.height * scaleY);
      boundaries.push({
        id: `${path}:${index}`, path, index, axis: node.axis, extent,
        position: edges[index + 1],
        x: horizontal ? edges[index + 1] : x,
        y: horizontal ? y : edges[index + 1],
        width: horizontal ? 0 : width,
        height: horizontal ? height : 0,
        min: min <= max ? min : edges[index + 1],
        max: min <= max ? max : edges[index + 1],
      });
    }
  }
  visit(root, 0, 0, 1, 1, "root");
  return { tiles, boundaries };
}

/** Slots exactly partition the display; all coordinates are normalized. */
export function getTiles(display) {
  return layoutGeometry(display).tiles;
}

// Round shared edges, not the widths/heights of individual tiles.
export function tilePixels(display, tile) {
  const x = Math.round(display.x + tile.x * display.width);
  const y = Math.round(display.y + tile.y * display.height);
  return {
    x, y,
    width: Math.round(display.x + (tile.x + tile.width) * display.width) - x,
    height: Math.round(display.y + (tile.y + tile.height) * display.height) - y,
  };
}

const defaultLimits = { minWidth: 1, minHeight: 1, maxWidth: Infinity, maxHeight: Infinity };
const sizeKeys = ["Width", "Height"];

export function layoutFits(display, limits) {
  return getTiles(display).every((tile) => {
    const bounds = limits.get(tile.windowId) ?? defaultLimits;
    const pixels = tilePixels(display, tile);
    return sizeKeys.every((key) => {
      const size = key === "Width" ? pixels.width : pixels.height;
      return size >= bounds[`min${key}`] && size <= bounds[`max${key}`];
    });
  });
}

// Start from the preferred sizes and give each unclamped child the same
// adjustment. Solve on numbers only; no app is asked to try a candidate size.
function distribute(size, weights, ranges) {
  const desired = weights.map((weight) => size * weight);
  let preferredEdge = 0;
  const preferred = desired.map((value) => {
    const next = preferredEdge + value;
    const extent = Math.round(next) - Math.round(preferredEdge);
    preferredEdge = next;
    return extent;
  });
  if (preferred.every((extent, i) => extent >= ranges[i][0] && extent <= ranges[i][1])) return preferred;
  const adjusted = (i, shift) => clamp(desired[i] + shift, ranges[i][0], ranges[i][1]);
  let low = -size;
  let high = size;
  for (let i = 0; i < 40; i++) {
    const shift = (low + high) / 2;
    const total = desired.reduce((sum, _, index) => sum + adjusted(index, shift), 0);
    if (total < size) low = shift;
    else high = shift;
  }

  // Snap shared edges to whole pixels, reserving a feasible remainder.
  const suffix = Array(ranges.length + 1);
  suffix[ranges.length] = [0, 0];
  for (let i = ranges.length - 1; i >= 0; i--) {
    suffix[i] = [ranges[i][0] + suffix[i + 1][0], ranges[i][1] + suffix[i + 1][1]];
  }
  let idealEdge = 0;
  let edge = 0;
  return ranges.map(([min, max], i) => {
    idealEdge += adjusted(i, (low + high) / 2);
    const nextEdge = clamp(Math.round(idealEdge),
      Math.max(edge + min, size - suffix[i + 1][1]),
      Math.min(edge + max, size - suffix[i + 1][0]));
    const extent = nextEdge - edge;
    edge = nextEdge;
    return extent;
  });
}

// Compute a feasible layout for these windows and this split tree, without
// changing preferred proportions. Return null when the tree cannot fit.
export function fitDisplay(display, limits) {
  if (layoutFits(display, limits)) return display;
  const root = buildLayout(display.windows.length, display.mode, display.layout);
  let index = 0;
  function measure(node) {
    if (!node) {
      const bounds = limits.get(display.windows[index++]) ?? defaultLimits;
      return { ranges: sizeKeys.map((key) => [bounds[`min${key}`], bounds[`max${key}`]]) };
    }
    const axis = node.axis === "x" ? 0 : 1;
    const children = node.children.map(measure);
    if (children.some((child) => !child)) return null;
    const ranges = sizeKeys.map((_, dimension) => {
      const alongSplit = dimension === axis;
      let min = 0;
      let max = alongSplit ? 0 : Infinity;
      for (const child of children) {
        const bounds = child.ranges[dimension];
        min = alongSplit ? min + bounds[0] : Math.max(min, bounds[0]);
        max = alongSplit ? max + bounds[1] : Math.min(max, bounds[1]);
      }
      return [min, max];
    });
    if (ranges.some(([min, max]) => min > max)) return null;
    return { axis, children, ranges };
  }
  const measured = measure(root);
  const area = tilePixels(display, { x: 0, y: 0, width: 1, height: 1 });
  const extent = [area.width, area.height];
  if (!measured || measured.ranges.some(([min, max], i) => extent[i] < min || extent[i] > max)) return null;

  function arrange(node, { axis, children }, space) {
    if (!node) return null;
    const sizes = distribute(space[axis], node.weights, children.map((child) => child.ranges[axis]));
    return {
      axis: node.axis,
      weights: sizes.map((size) => size / space[axis]),
      children: children.map((child, i) => {
        const available = [...space];
        available[axis] = sizes[i];
        return arrange(node.children[i], child, available);
      }),
    };
  }
  return { ...display, ...area, layout: arrange(root, measured, extent) };
}

// Save only splits the user actually resized, not unrelated automatic changes
// between the preferred layout and the visible drag baseline.
export function preferResizedSplits(preferred, visible, resized) {
  const tree = (display) => buildLayout(display.windows.length, display.mode, display.layout);
  function merge(wanted, before, after) {
    if (!wanted) return null;
    const weights = before.weights.some((weight, i) => Math.abs(weight - after.weights[i]) > EPSILON)
      ? after.weights : wanted.weights;
    const children = wanted.children.map((child, i) => merge(child, before.children[i], after.children[i]));
    if (weights === wanted.weights && children.every((child, i) => child === wanted.children[i])) return wanted;
    return {
      axis: wanted.axis,
      weights,
      children,
    };
  }
  const wanted = tree(preferred);
  const layout = merge(wanted, tree(visible), tree(resized));
  return layout === wanted ? preferred : { ...preferred, layout };
}

function spreadContext(display, boundary, anchorWindowId = display.activeWindowId) {
  const weights = buildLayout(display.windows.length, display.mode, display.layout).weights;
  const selected = display.windows.indexOf(anchorWindowId);
  const anchor = selected === boundary.index + 1 ? selected : boundary.index;
  const before = anchor === boundary.index;
  const peers = weights.map((_, index) => index)
    .filter((index) => before ? index > anchor : index < anchor);
  const minimum = Math.min(
    display.mode === "columns" ? 96 / display.width : 64 / display.height,
    ...weights,
  );
  const capacity = peers.reduce((sum, index) => sum + Math.max(0, weights[index] - minimum), 0);
  const shrink = Math.max(0, weights[anchor] - minimum);
  return {
    weights, anchor, peers, minimum, before,
    min: boundary.position - (before ? shrink : capacity),
    max: boundary.position + (before ? capacity : shrink),
  };
}

export function getBoundaries(display, { spreadResize = false, anchorWindowId } = {}) {
  const boundaries = layoutGeometry(display).boundaries;
  if (!spreadResize || display.mode === "binary") return boundaries;
  return boundaries.map((boundary) => {
    const { min, max } = spreadContext(display, boundary, anchorWindowId);
    return { ...boundary, min, max };
  });
}

function resizeSpread(display, boundary, position, anchorWindowId) {
  const { weights, anchor, peers, minimum, before } = spreadContext(display, boundary, anchorWindowId);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const growth = (position - boundary.position) * (before ? 1 : -1);
  if (growth <= 0) {
    for (const index of peers) weights[index] -= growth / peers.length;
  } else {
    // Equal reductions until a slot reaches its minimum; then share the rest
    // among the remaining slots. The anchor never changes during a drag.
    let remaining = growth;
    let available = [...peers];
    while (remaining > 1e-12 && available.length) {
      const share = remaining / available.length;
      let removed = 0;
      for (const index of available) {
        const take = Math.min(share, Math.max(0, weights[index] - minimum));
        weights[index] -= take;
        removed += take;
      }
      remaining -= removed;
      available = available.filter((index) => weights[index] > minimum + 1e-12);
      if (removed === 0) break;
    }
  }
  weights[anchor] = total - weights.reduce((sum, weight, index) => sum + (index === anchor ? 0 : weight), 0);
  display.layout.weights = weights;
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

export function neighboringDisplay(displays, source, direction, tile = { x: 0, y: 0, width: 1, height: 1 }) {
  if (!DIRECTIONS.includes(direction)) return undefined;
  const horizontal = direction === "left" || direction === "right";
  const exit = horizontal
    ? source.y + center(tile.y, tile.height) * source.height
    : source.x + center(tile.x, tile.width) * source.width;

  const candidates = displays.flatMap((display) => {
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
export function applyAction(previous, action, resolveLayout = (display) => display) {
  if (action.type === "reset") return { ...createState(), spreadResize: previous.spreadResize ?? true };
  const state = structuredClone(previous);
  const display = getActiveDisplay(state);
  state.message = "";

  switch (action.type) {
    case "set-spread-resize":
      if (typeof action.enabled !== "boolean") return previous;
      state.spreadResize = action.enabled;
      break;
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
    case "set-layout": {
      if (!MODES.includes(action.mode)) return previous;
      const target = state.displays.find((item) => item.id === (action.id ?? display.id));
      if (!target) return previous;
      if (target.mode !== action.mode) delete target.layout;
      target.mode = action.mode;
      break;
    }
    case "add-window": {
      const id = state.nextWindowId++;
      display.windows.push(id);
      syncLayout(display);
      display.activeWindowId = id;
      break;
    }
    case "remove-window": {
      const index = display.windows.indexOf(display.activeWindowId);
      if (index < 0) return previous;
      display.windows.splice(index, 1);
      syncLayout(display, index);
      display.activeWindowId = display.windows[Math.min(index, display.windows.length - 1)] ?? null;
      break;
    }
    case "add-display": {
      const geometry = action.geometry ?? {
        x: Math.max(...state.displays.map((item) => item.x + item.width)),
        y: display.y, width: display.width, height: display.height,
      };
      const { x, y, width, height } = geometry;
      if (![x, y, width, height].every(Number.isSafeInteger) || width < 320 || height < 240) return previous;
      const id = state.nextDisplayId++;
      state.displays.push({
        id, x, y, width, height,
        mode: "binary", windows: [], activeWindowId: null,
      });
      state.activeDisplayId = id;
      break;
    }
    case "remove-display": {
      if (state.displays.length === 1) return previous;
      const removed = state.displays.find((item) => item.id === (action.id ?? display.id));
      if (!removed) return previous;
      const nearest = state.displays.filter((item) => item.id !== removed.id)
        .sort((a, b) => {
          const distance = (item) =>
            (center(item.x, item.width) - center(removed.x, removed.width)) ** 2
            + (center(item.y, item.height) - center(removed.y, removed.height)) ** 2;
          return distance(a) - distance(b) || a.id - b.id;
        })[0];
      if (removed.windows.length) {
        nearest.windows.push(...removed.windows);
        syncLayout(nearest);
        if (removed.id === display.id || nearest.activeWindowId === null) nearest.activeWindowId = removed.activeWindowId;
      }
      state.displays = state.displays.filter((item) => item.id !== removed.id);
      if (removed.id === display.id) state.activeDisplayId = nearest.id;
      state.message = removed.windows.length ? `Windows moved to ${displayName(state, nearest).toLowerCase()}.` : "Display removed.";
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
    case "resize-boundary": {
      const target = state.displays.find((item) => item.id === (action.id ?? display.id));
      if (!target || !Number.isFinite(action.position)) return previous;
      let baseline = target;
      if (target.mode !== "binary" && action.initialWeights !== undefined) {
        const layout = {
          axis: target.mode === "columns" ? "x" : "y",
          weights: action.initialWeights,
          children: target.windows.map(() => null),
        };
        if (!isValidLayout(layout, target.mode, target.windows.length)) return previous;
        baseline = { ...target, layout };
      }
      const spreadResize = state.spreadResize ?? true;
      const boundary = getBoundaries(baseline, { spreadResize, anchorWindowId: action.anchorWindowId })
        .find((item) => item.id === action.boundaryId);
      if (!boundary) return previous;
      if (target.mode !== "binary" && action.anchorWindowId !== undefined
        && ![target.windows[boundary.index], target.windows[boundary.index + 1]].includes(action.anchorWindowId)) return previous;
      target.layout = buildLayout(target.windows.length, target.mode, baseline.layout);
      const position = clamp(action.position, boundary.min, boundary.max);
      if (target.mode !== "binary" && spreadResize) {
        resizeSpread(target, boundary, position, action.anchorWindowId);
        state.activeDisplayId = target.id;
        break;
      }
      let node = target.layout;
      for (const index of boundary.path.split("/").slice(1)) node = node.children[Number(index)];
      const delta = (position - boundary.position) / boundary.extent;
      node.weights[boundary.index] += delta;
      node.weights[boundary.index + 1] -= delta;
      state.activeDisplayId = target.id;
      break;
    }
    case "focus":
    case "move": {
      if (!DIRECTIONS.includes(action.direction)) return previous;
      const focusing = action.type === "focus";
      const visible = resolveLayout(display);
      const active = getTiles(visible).find((tile) => tile.windowId === display.activeWindowId)
        // Navigate from the center when the active display is empty.
        ?? (focusing ? { index: -1, x: 0, y: 0, width: 1, height: 1 } : null);
      if (!active) {
        state.message = "No active window.";
        break;
      }
      const adjacent = neighbor(visible, active, action.direction);
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
      const destination = neighboringDisplay(state.displays, display, action.direction, active);
      if (!destination) {
        state.message = `No display to the ${action.direction}.`;
        break;
      }
      if (focusing) {
        const target = incomingTile(display, resolveLayout(destination), active, action.direction);
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
      syncLayout(display, active.index);
      display.activeWindowId = display.windows[Math.min(active.index, display.windows.length - 1)] ?? null;
      destination.windows.splice(index, 0, active.windowId);
      syncLayout(destination);
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

function isValidLayout(node, mode, count, depth = 0) {
  if (count <= 1) return node === null;
  if (depth > 64 || !node || !Array.isArray(node.weights) || !Array.isArray(node.children)) return false;
  const binary = mode === "binary";
  const axis = binary ? (depth % 2 === 0 ? "x" : "y") : (mode === "columns" ? "x" : "y");
  const length = binary ? 2 : count;
  if (node.axis !== axis || node.weights.length !== length || node.children.length !== length
    || !node.weights.every((weight) => Number.isFinite(weight) && weight > 0)
    || Math.abs(node.weights.reduce((sum, weight) => sum + weight, 0) - 1) > 1e-8) return false;
  if (!binary) return node.children.every((child) => child === null);
  const first = Math.ceil(count / 2);
  return isValidLayout(node.children[0], mode, first, depth + 1)
    && isValidLayout(node.children[1], mode, count - first, depth + 1);
}

export function isValidState(state) {
  if (!state || !Array.isArray(state.displays) || state.displays.length === 0) return false;
  if (state.spreadResize !== undefined && typeof state.spreadResize !== "boolean") return false;
  const displayIds = new Set();
  const windowIds = new Set();
  for (const display of state.displays) {
    if (!display || !Number.isSafeInteger(display.id) || display.id < 1 || displayIds.has(display.id)
      || !MODES.includes(display.mode) || !Array.isArray(display.windows)
      || !["x", "y", "width", "height"].every((key) => Number.isSafeInteger(display[key]))
      || display.width < 320 || display.height < 240
      || (display.layout !== undefined && !isValidLayout(display.layout, display.mode, display.windows.length))) return false;
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
