import { applyAction, getActiveDisplay, getBoundaries, getTiles } from "./engine.js";
import { createSimulatorState, getShortcutAction, shortcutGroups } from "./simulator.js";
import { createMoveTutorial } from "./move-tutorial.js";
import { createDisplayView } from "./display-view.js";
import { createKeycap, createKeyChord } from "./keycaps.js";

const $ = (selector) => document.querySelector(selector);
const workspace = $("#workspace");
const displays = $("#displays");
const view = createDisplayView(workspace, displays, {
  interactive: true, alignTop: true, onMotionFrame: () => tutorial.reposition(),
});
const tutorial = createMoveTutorial(workspace, displays, $("#move-tip"), view.getWindowRect);
let state = createSimulatorState();
let drag = null;
let pointerFocusedWindow;
const animatedActions = new Set(["move", "rotate", "set-layout"]);
const shortcutPresses = new Map();

function clearPointerFocus() {
  pointerFocusedWindow?.classList.remove("pointer-focused");
  pointerFocusedWindow = undefined;
}

function dispatch(action, { shortcut = false } = {}) {
  shortcutPresses.get(action)?.();
  const previous = state;
  state = applyAction(state, action);
  tutorial.onAction(previous, state, action, shortcut);
  render(drag || action.type === "resize-boundary" ? "snap"
    : animatedActions.has(action.type) ? "animate" : "keep");
}

function render(motion) {
  const active = getActiveDisplay(state);
  const focused = document.activeElement;
  view.render(state, { motion, drag });
  // Moving a tile within the DOM can blur its button even though it still exists.
  if (focused !== document.activeElement && displays.contains(focused)) focused.focus({ preventScroll: true });
  document.querySelectorAll("[data-mode]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.mode === active.mode));
  });
  $("#status").textContent = state.message;
  tutorial.render(state);
}

function renderShortcuts() {
  const list = $("#shortcut-list");
  const directions = document.createElement("div");
  directions.className = "direction-shortcuts";
  list.append(directions);
  for (const { title, bindings } of shortcutGroups) {
    const heading = document.createElement("h3");
    heading.textContent = title;
    const group = document.createElement("ul");
    const directional = bindings.every(({ action }) => action.direction);
    group.className = directional ? "wasd-keys" : "shortcut-actions";
    for (const { keys, label, action } of bindings) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "shortcut-button";
      if (action.mode) button.dataset.mode = action.mode;
      button.setAttribute("aria-label", `${title}: ${label}`);
      button.setAttribute("aria-keyshortcuts", keys);
      const chord = keys.split("+");
      if (directional) {
        item.dataset.direction = action.direction;
        button.append(createKeycap(chord.at(-1)));
      } else {
        const text = document.createElement("span");
        text.textContent = label;
        button.append(text, createKeyChord(chord));
      }
      let releaseTimer;
      shortcutPresses.set(action, () => {
        clearTimeout(releaseTimer);
        button.setAttribute("data-tapped", "");
        releaseTimer = setTimeout(() => button.removeAttribute("data-tapped"), 120);
      });
      button.addEventListener("click", () => dispatch(action));
      item.append(button);
      group.append(item);
    }
    if (directional) {
      const section = document.createElement("div");
      const titleRow = document.createElement("div");
      titleRow.className = "direction-heading";
      titleRow.append(heading, createKeyChord(bindings[0].keys.split("+").slice(0, -1)));
      section.append(titleRow, group);
      directions.append(section);
    } else {
      list.append(heading, group);
    }
  }
}
renderShortcuts();

workspace.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  clearPointerFocus();
  // Chromium can match :focus-visible on a clicked button after a modifier press.
  pointerFocusedWindow = event.target.closest("button.window");
  pointerFocusedWindow?.classList.add("pointer-focused");
});

document.addEventListener("focusin", (event) => {
  if (event.target !== pointerFocusedWindow) clearPointerFocus();
});

workspace.addEventListener("click", (event) => {
  const window = event.target.closest("[data-window-id]");
  const display = event.target.closest("[data-display-id]");
  if (window) dispatch({ type: "select-window", id: Number(window.dataset.windowId) });
  else if (display) dispatch({ type: "select-display", id: Number(display.dataset.displayId) });
});

displays.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || drag) return;
  const handle = event.target.closest("[data-boundary-id]");
  if (!handle) return;
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
    id, pointerId: event.pointerId,
    boundaryId: boundary.id, axis: boundary.axis, position: boundary.position,
    startX: event.clientX, startY: event.clientY,
    width: bounds.width, height: bounds.height,
    anchorWindowId, initialWeights,
  };
  document.body.dataset.resizeAxis = boundary.axis;
  // Capture on the stable workspace so rerendering cannot interrupt a drag.
  workspace.setPointerCapture(event.pointerId);
  dispatch(anchorWindowId === undefined
    ? { type: "select-display", id } : { type: "select-window", id: anchorWindowId });
  event.preventDefault();
});

workspace.addEventListener("pointermove", (event) => {
  if (!drag || event.pointerId !== drag.pointerId) return;
  const delta = drag.axis === "x"
    ? (event.clientX - drag.startX) / drag.width : (event.clientY - drag.startY) / drag.height;
  dispatch({
    type: "resize-boundary", id: drag.id, boundaryId: drag.boundaryId,
    position: drag.position + delta,
    anchorWindowId: drag.anchorWindowId, initialWeights: drag.initialWeights,
  });
});

function finishDrag(event) {
  if (!drag || event.pointerId !== drag.pointerId) return;
  drag = null;
  delete document.body.dataset.resizeAxis;
  if (workspace.hasPointerCapture(event.pointerId)) workspace.releasePointerCapture(event.pointerId);
  render();
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
  if (event.key === "Tab") clearPointerFocus();
  if (drag || event.defaultPrevented || event.target.closest("input, select, textarea, [contenteditable]")) return;
  const action = getShortcutAction(event);
  if (action) {
    event.preventDefault();
    dispatch(action, { shortcut: !event.repeat });
  }
});

new ResizeObserver(() => { if (!drag) render(); }).observe(workspace);
render();
