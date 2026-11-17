import { applyAction, createState, getActiveDisplay, getBoundaries, getTiles, isValidState } from "./engine.js";

const STORAGE_KEY = "kdetiler-simulator-v1";
const $ = (selector) => document.querySelector(selector);
const workspace = $("#workspace");
const displays = $("#displays");
const geometry = $("#geometry");
const modeNames = { binary: "Binary", columns: "Columns", horizontal: "Horizontal" };
let state = loadState();
let drag = null;
let layout = null;
let renderedActiveDisplayId = null;

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved?.version === 1 && isValidState(saved.state)) {
      return { ...saved.state, spreadResize: saved.state.spreadResize ?? true };
    }
  } catch { /* Storage is optional. */ }
  return createState();
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, state }));
  } catch { /* Private browsing and storage limits must not break the simulator. */ }
}

function dispatch(action, { focus = false, save = true } = {}) {
  state = applyAction(state, action);
  if (focus) workspace.focus({ preventScroll: true });
  render();
  if (save) saveState();
}

function fitLayout() {
  const { width, height } = workspace.getBoundingClientRect();
  const minX = Math.min(...state.displays.map((display) => display.x));
  const minY = Math.min(...state.displays.map((display) => display.y));
  const maxX = Math.max(...state.displays.map((display) => display.x + display.width));
  const maxY = Math.max(...state.displays.map((display) => display.y + display.height));
  const scale = Math.max(0.001, Math.min(
    Math.max(width - 64, 1) / (maxX - minX),
    Math.max(height - 108, 1) / (maxY - minY),
    1,
  ));
  return {
    minX, minY, scale,
    offsetX: (width - (maxX - minX) * scale) / 2,
    offsetY: 34 + (height - 34 - (maxY - minY) * scale) / 2,
  };
}

function render() {
  const active = getActiveDisplay(state);
  if (!drag) layout = fitLayout();
  const fragment = document.createDocumentFragment();

  state.displays.forEach((display, index) => {
    const container = document.createElement("section");
    container.className = `display${display.id === state.activeDisplayId ? " active" : ""}${drag?.type === "display" && drag.id === display.id ? " dragging" : ""}`;
    container.dataset.displayId = display.id;
    container.setAttribute("aria-label", `Display ${index + 1}`);
    Object.assign(container.style, {
      left: `${layout.offsetX + (display.x - layout.minX) * layout.scale}px`,
      top: `${layout.offsetY + (display.y - layout.minY) * layout.scale}px`,
      width: `${display.width * layout.scale}px`,
      height: `${display.height * layout.scale}px`,
    });

    const title = document.createElement("button");
    title.type = "button";
    title.className = "display-title";
    title.title = `Activate display ${index + 1} · Drag to move`;
    title.setAttribute("aria-label", `Activate display ${index + 1}`);
    title.innerHTML = `<span class="display-number">${index + 1}</span><span class="display-mode">${modeNames[display.mode]}</span>`;
    container.append(title);

    const screen = document.createElement("div");
    screen.className = "screen";
    for (const tile of getTiles(display)) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `window${display.activeWindowId === tile.windowId ? " selected" : ""}`;
      button.dataset.windowId = tile.windowId;
      button.textContent = `${tile.windowId}`;
      button.setAttribute("aria-label", `Window ${tile.windowId}`);
      button.setAttribute("aria-pressed", String(display.activeWindowId === tile.windowId));
      button.title = `Window ${tile.windowId}`;
      Object.assign(button.style, {
        left: `${tile.x * 100}%`,
        top: `${tile.y * 100}%`,
        width: `${tile.width * 100}%`,
        height: `${tile.height * 100}%`,
      });
      button.style.setProperty("--hue", (tile.windowId * 47) % 360);
      screen.append(button);
    }
    for (const boundary of getBoundaries(display, { spreadResize: state.spreadResize ?? true })) {
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
    container.append(screen);
    fragment.append(container);
  });
  displays.replaceChildren(fragment);

  $("#active-label").textContent = `Display ${state.displays.indexOf(active) + 1}`;
  for (const key of ["x", "y", "width", "height"]) {
    if (drag || renderedActiveDisplayId !== active.id || document.activeElement !== geometry.elements[key]) {
      geometry.elements[key].value = active[key];
    }
  }
  renderedActiveDisplayId = active.id;
  document.querySelectorAll("[data-mode]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.mode === active.mode));
  });
  $("#remove-display").disabled = state.displays.length === 1;
  $("#remove-window").disabled = active.windows.length === 0;
  $("#spread-resize").checked = state.spreadResize ?? true;
  $("#spread-resize").disabled = active.mode === "binary";
  $("#rotate-cw").disabled = $("#rotate-ccw").disabled = active.windows.length < 2;
  document.querySelectorAll("[data-direction]").forEach((button) => {
    button.disabled = active.windows.length === 0;
  });
  $("#status").textContent = state.message;
}

for (const [id, type] of [
  ["add-display", "add-display"], ["remove-display", "remove-display"],
  ["add-window", "add-window"], ["remove-window", "remove-window"],
]) {
  $(`#${id}`).addEventListener("click", () => dispatch({ type }, { focus: true }));
}
document.querySelectorAll("[data-mode]").forEach((button) => {
  button.addEventListener("click", () => dispatch({ type: "set-layout", mode: button.dataset.mode }, { focus: true }));
});
document.querySelectorAll("[data-direction]").forEach((button) => {
  button.addEventListener("click", () => dispatch({ type: "move", direction: button.dataset.direction }, { focus: true }));
});
$("#rotate-cw").addEventListener("click", () => dispatch({ type: "rotate", clockwise: true }, { focus: true }));
$("#rotate-ccw").addEventListener("click", () => dispatch({ type: "rotate", clockwise: false }, { focus: true }));
$("#reset").addEventListener("click", () => dispatch({ type: "reset" }, { focus: true }));
$("#spread-resize").addEventListener("change", (event) => {
  dispatch({ type: "set-spread-resize", enabled: event.target.checked }, { focus: true });
});
$("#help-toggle").addEventListener("click", () => {
  $("#help").hidden = !$("#help").hidden;
  $("#help-toggle").setAttribute("aria-expanded", String(!$("#help").hidden));
});

function updateShortcutLabels() {
  const modifier = $("#modifier").value === "alt" ? "Alt" : "Meta";
  document.querySelectorAll("[data-shortcut]").forEach((element) => {
    element.title = `${modifier}+${element.dataset.shortcut}`;
  });
  document.querySelectorAll("[data-modifier]").forEach((element) => {
    element.textContent = modifier;
  });
}
$("#modifier").addEventListener("change", updateShortcutLabels);
updateShortcutLabels();

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
      ? { type: "select-display", id } : { type: "select-window", id: anchorWindowId }, { save: false });
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
  dispatch({ type: "select-display", id }, { save: false });
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
    }, { save: false });
    return;
  }
  if (!drag.moved && Math.hypot(dx, dy) < 3) return;
  drag.moved = true;
  const position = snapPosition(drag.id, drag.x + dx / drag.scale, drag.y + dy / drag.scale, drag.scale);
  dispatch({ type: "set-geometry", id: drag.id, ...position }, { save: false });
});

function finishDrag(event) {
  if (!drag || event.pointerId !== drag.pointerId) return;
  drag = null;
  delete document.body.dataset.resizeAxis;
  if (workspace.hasPointerCapture(event.pointerId)) workspace.releasePointerCapture(event.pointerId);
  render();
  saveState();
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
  const boundary = getBoundaries(display, { spreadResize: state.spreadResize ?? true })
    .find((item) => item.id === boundaryId);
  event.preventDefault();
  dispatch({ type: "resize-boundary", id, boundaryId, position: boundary.position + delta });
  displays.querySelector(`[data-display-id="${id}"] [data-boundary-id="${boundaryId}"]`).focus({ preventScroll: true });
});

geometry.addEventListener("submit", (event) => {
  event.preventDefault();
  document.activeElement.blur();
  workspace.focus({ preventScroll: true });
});
geometry.addEventListener("change", (event) => {
  const input = event.target;
  if (!["x", "y", "width", "height"].includes(input.name)) return;
  if (input.value !== "" && input.validity.valid) {
    dispatch({ type: "set-geometry", [input.name]: input.valueAsNumber });
  }
  input.value = getActiveDisplay(state)[input.name];
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    $("#help").hidden = true;
    $("#help-toggle").setAttribute("aria-expanded", "false");
    if (event.target.matches("input, select")) event.target.blur();
    return;
  }
  if (drag) return;
  const editing = event.target.closest("input, select, textarea, [contenteditable]");
  const modifier = $("#modifier").value === "meta" ? event.metaKey : event.altKey;
  if (editing || !modifier || event.ctrlKey || (event.altKey && event.metaKey)) return;
  const key = event.key.toLowerCase();
  let action;
  if (key === "+" || key === "=") {
    action = { type: "add-window" };
  } else if (key === "-") {
    action = { type: "remove-window" };
  } else if (["b", "v", "h"].includes(key) && !event.shiftKey) {
    action = { type: "set-layout", mode: { b: "binary", v: "columns", h: "horizontal" }[key] };
  } else if (event.shiftKey && (key === "r" || key === "e")) {
    action = { type: "rotate", clockwise: key === "r" };
  } else if (["arrowleft", "arrowright", "arrowup", "arrowdown"].includes(key)) {
    action = { type: event.shiftKey ? "move" : "focus", direction: key.slice(5) };
  } else if (/^[0-9]$/.test(key) && !event.shiftKey) {
    const display = state.displays[(Number(key) || 10) - 1];
    if (display) action = { type: "select-display", id: display.id };
  }
  if (action) {
    event.preventDefault();
    dispatch(action, { focus: true });
  }
});

new ResizeObserver(() => { if (!drag) render(); }).observe(workspace);
render();
