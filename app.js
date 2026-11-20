import { applyAction, getActiveDisplay, getBoundaries, getTiles } from "./engine.js";
import { createSimulatorState, getDisplayBounds, getShortcutAction, shortcutGroups } from "./simulator.js";
import { populateWindow } from "./window-previews.js";

const $ = (selector) => document.querySelector(selector);
const workspace = $("#workspace");
const displays = $("#displays");
const modeNames = { binary: "Binary", columns: "Columns", horizontal: "Rows" };
let state = createSimulatorState();
let drag = null;
let layout = null;

function dispatch(action, { focus = false } = {}) {
  state = applyAction(state, action);
  if (focus) workspace.focus({ preventScroll: true });
  render();
}

function fitLayout() {
  const { width, height } = workspace.getBoundingClientRect();
  const { minX, minY, maxX, maxY } = getDisplayBounds(state.displays);
  const scale = Math.max(0.001, Math.min(
    Math.max(width - 12, 1) / (maxX - minX),
    Math.max(height - 12, 1) / (maxY - minY),
    1,
  ));
  return {
    minX, minY, scale,
    offsetX: (width - (maxX - minX) * scale) / 2,
    offsetY: (height - (maxY - minY) * scale) / 2,
  };
}

function positionDisplay(element, { x, y, width, height }) {
  Object.assign(element.style, {
    left: `${layout.offsetX + (x - layout.minX) * layout.scale}px`,
    top: `${layout.offsetY + (y - layout.minY) * layout.scale}px`,
    width: `${width * layout.scale}px`,
    height: `${height * layout.scale}px`,
  });
}

function render() {
  const active = getActiveDisplay(state);
  if (!drag) layout = fitLayout();
  const fragment = document.createDocumentFragment();

  state.displays.forEach((display, index) => {
    const container = document.createElement("div");
    container.className = "display-slot";
    container.classList.toggle("active-slot", display === active);
    container.classList.toggle("dragging", drag?.type === "display" && drag.id === display.id);
    container.dataset.displayId = display.id;
    positionDisplay(container, display);
    const card = document.createElement("section");
    card.className = `display${display === active ? " active" : ""}`;
    card.setAttribute("aria-label", `Display ${index + 1}`);
    const header = document.createElement("div");
    header.className = "display-header";

    const title = document.createElement("button");
    title.type = "button";
    title.className = "display-title";
    title.title = `Activate display ${index + 1} · Drag to move`;
    title.setAttribute("aria-label", `Activate display ${index + 1}`);
    title.setAttribute("aria-current", String(display === active));
    title.innerHTML = `<span class="display-number">${index + 1}</span><span class="display-mode">${modeNames[display.mode]}</span>`;
    header.append(title);
    card.append(header);

    const screen = document.createElement("div");
    screen.className = "screen";
    for (const tile of getTiles(display)) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `window${display.activeWindowId === tile.windowId ? " selected" : ""}`;
      button.dataset.windowId = tile.windowId;
      button.setAttribute("aria-pressed", String(display.activeWindowId === tile.windowId));
      populateWindow(button, tile.windowId);
      Object.assign(button.style, {
        left: `${tile.x * 100}%`,
        top: `${tile.y * 100}%`,
        width: `${tile.width * 100}%`,
        height: `${tile.height * 100}%`,
      });
      screen.append(button);
    }
    for (const boundary of getBoundaries(display, { spreadResize: true })) {
      const handle = document.createElement("div");
      handle.className = `divider divider-${boundary.axis}`;
      if (drag?.type === "boundary" && drag.id === display.id && drag.boundaryId === boundary.id) {
        handle.classList.add("resizing");
      }
      handle.dataset.boundaryId = boundary.id;
      handle.dataset.axis = boundary.axis;
      handle.tabIndex = 0;
      handle.setAttribute("role", "separator");
      handle.setAttribute("aria-label", `Resize ${boundary.axis === "x" ? "vertical" : "horizontal"} boundary on display ${index + 1}`);
      handle.setAttribute("aria-orientation", boundary.axis === "x" ? "vertical" : "horizontal");
      for (const [key, value] of [["now", boundary.position], ["min", boundary.min], ["max", boundary.max]]) {
        handle.setAttribute(`aria-value${key}`, String(Math.round(value * 100)));
      }
      handle.title = "Drag to resize neighboring tiles";
      Object.assign(handle.style, {
        left: boundary.axis === "x" ? `calc(${boundary.x * 100}% - 4px)` : `${boundary.x * 100}%`,
        top: boundary.axis === "y" ? `calc(${boundary.y * 100}% - 4px)` : `${boundary.y * 100}%`,
        width: boundary.axis === "x" ? "8px" : `${boundary.width * 100}%`,
        height: boundary.axis === "y" ? "8px" : `${boundary.height * 100}%`,
      });
      screen.append(handle);
    }
    if (!display.windows.length) {
      const empty = document.createElement("span");
      empty.className = "empty";
      empty.textContent = "Empty";
      screen.append(empty);
    }
    card.append(screen);
    container.append(card);
    fragment.append(container);
  });
  displays.replaceChildren(fragment);

  document.querySelectorAll("[data-mode]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.mode === active.mode));
  });
  $("#status").textContent = state.message;
}

function renderShortcuts() {
  const list = $("#shortcut-list");
  for (const { title, bindings } of shortcutGroups) {
    const heading = document.createElement("h3");
    heading.textContent = title;
    const group = document.createElement("ul");
    for (const { keys, label, action } of bindings) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      if (action.mode) button.dataset.mode = action.mode;
      button.setAttribute("aria-label", `${title}: ${label}`);
      button.setAttribute("aria-keyshortcuts", keys);
      const text = document.createElement("span");
      text.textContent = label;
      const chord = document.createElement("kbd");
      chord.textContent = keys;
      button.append(text, chord);
      button.addEventListener("click", () => dispatch(action));
      item.append(button);
      group.append(item);
    }
    list.append(heading, group);
  }
}
renderShortcuts();

workspace.addEventListener("click", (event) => {
  const window = event.target.closest("[data-window-id]");
  const display = event.target.closest("[data-display-id]");
  if (window) dispatch({ type: "select-window", id: Number(window.dataset.windowId) }, { focus: true });
  else if (display) dispatch({ type: "select-display", id: Number(display.dataset.displayId) }, { focus: true });
});

function snapPosition(id, x, y, scale) {
  const moving = state.displays.find((display) => display.id === id);
  const threshold = 10 / scale;
  let bestX = threshold;
  let bestY = threshold;
  let snappedX = x;
  let snappedY = y;
  for (const other of state.displays) {
    if (other.id === id) continue;
    for (const edge of [other.x, other.x + other.width]) {
      for (const offset of [0, moving.width]) {
        const delta = edge - (x + offset);
        if (Math.abs(delta) < bestX) {
          bestX = Math.abs(delta);
          snappedX = x + delta;
        }
      }
    }
    for (const edge of [other.y, other.y + other.height]) {
      for (const offset of [0, moving.height]) {
        const delta = edge - (y + offset);
        if (Math.abs(delta) < bestY) {
          bestY = Math.abs(delta);
          snappedY = y + delta;
        }
      }
    }
  }
  return { x: Math.round(snappedX), y: Math.round(snappedY) };
}

displays.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || drag) return;
  const handle = event.target.closest("[data-boundary-id]");
  if (handle) {
    const id = Number(handle.closest("[data-display-id]").dataset.displayId);
    const display = state.displays.find((item) => item.id === id);
    const boundary = getBoundaries(display).find((item) => item.id === handle.dataset.boundaryId);
    const bounds = handle.closest(".screen").getBoundingClientRect();
    let anchorWindowId;
    let initialWeights;
    if (display.mode !== "binary") {
      const selected = display.windows.indexOf(display.activeWindowId);
      const point = boundary.axis === "x"
        ? (event.clientX - bounds.x) / bounds.width : (event.clientY - bounds.y) / bounds.height;
      const anchor = selected === boundary.index || selected === boundary.index + 1
        ? selected : boundary.index + (point > boundary.position + 0.000001 ? 1 : 0);
      anchorWindowId = display.windows[anchor];
      initialWeights = getTiles(display).map((tile) => display.mode === "columns" ? tile.width : tile.height);
    }
    drag = {
      type: "boundary", id, pointerId: event.pointerId,
      boundaryId: boundary.id, axis: boundary.axis, position: boundary.position,
      startX: event.clientX, startY: event.clientY,
      width: bounds.width, height: bounds.height,
      anchorWindowId, initialWeights,
    };
    document.body.dataset.resizeAxis = boundary.axis;
    workspace.setPointerCapture(event.pointerId);
    dispatch(anchorWindowId === undefined
      ? { type: "select-display", id } : { type: "select-window", id: anchorWindowId });
    event.preventDefault();
    return;
  }
  const title = event.target.closest(".display-title");
  if (!title) return;
  const id = Number(title.closest("[data-display-id]").dataset.displayId);
  const display = state.displays.find((item) => item.id === id);
  drag = {
    type: "display", id, pointerId: event.pointerId,
    startX: event.clientX, startY: event.clientY,
    x: display.x, y: display.y, scale: layout.scale, moved: false,
  };
  // Capture on the stable workspace so rerendering cannot interrupt a drag.
  workspace.setPointerCapture(event.pointerId);
  dispatch({ type: "select-display", id });
  event.preventDefault();
});

workspace.addEventListener("pointermove", (event) => {
  if (!drag || event.pointerId !== drag.pointerId) return;
  const dx = event.clientX - drag.startX;
  const dy = event.clientY - drag.startY;
  if (drag.type === "boundary") {
    const delta = drag.axis === "x" ? dx / drag.width : dy / drag.height;
    dispatch({
      type: "resize-boundary", id: drag.id, boundaryId: drag.boundaryId,
      position: drag.position + delta,
      anchorWindowId: drag.anchorWindowId, initialWeights: drag.initialWeights,
    });
    return;
  }
  if (!drag.moved && Math.hypot(dx, dy) < 3) return;
  drag.moved = true;
  const position = snapPosition(drag.id, drag.x + dx / drag.scale, drag.y + dy / drag.scale, drag.scale);
  dispatch({ type: "set-geometry", id: drag.id, ...position });
});

function finishDrag(event) {
  if (!drag || event.pointerId !== drag.pointerId) return;
  drag = null;
  delete document.body.dataset.resizeAxis;
  if (workspace.hasPointerCapture(event.pointerId)) workspace.releasePointerCapture(event.pointerId);
  render();
  workspace.focus({ preventScroll: true });
}
workspace.addEventListener("pointerup", finishDrag);
workspace.addEventListener("pointercancel", finishDrag);
workspace.addEventListener("lostpointercapture", finishDrag);

workspace.addEventListener("keydown", (event) => {
  const handle = event.target.closest("[data-boundary-id]");
  if (!handle || event.altKey || event.metaKey || event.ctrlKey) return;
  const step = event.shiftKey ? 0.05 : 0.01;
  const delta = handle.dataset.axis === "x"
    ? { ArrowLeft: -step, ArrowRight: step }[event.key]
    : { ArrowUp: -step, ArrowDown: step }[event.key];
  if (delta === undefined) return;
  const id = Number(handle.closest("[data-display-id]").dataset.displayId);
  const boundaryId = handle.dataset.boundaryId;
  const display = state.displays.find((item) => item.id === id);
  const boundary = getBoundaries(display, { spreadResize: true }).find((item) => item.id === boundaryId);
  event.preventDefault();
  dispatch({ type: "resize-boundary", id, boundaryId, position: boundary.position + delta });
  displays.querySelector(`[data-display-id="${id}"] [data-boundary-id="${boundaryId}"]`).focus({ preventScroll: true });
});

document.addEventListener("keydown", (event) => {
  if (drag || event.defaultPrevented || event.target.closest("input, select, textarea, [contenteditable]")) return;
  const action = getShortcutAction(event);
  if (action) {
    event.preventDefault();
    dispatch(action, { focus: true });
  }
});

new ResizeObserver(() => { if (!drag) render(); }).observe(workspace);
render();
