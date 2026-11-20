import { getActiveDisplay, getBoundaries, getTiles } from "./engine.js";
import { getDisplayBounds } from "./simulator.js";
import { populateWindow } from "./window-previews.js";

const modeNames = { binary: "Binary", columns: "Columns", horizontal: "Rows" };
const modeIcons = {
  binary: "M8 2v12M2 8h6",
  columns: "M6 2v12M10 2v12",
  horizontal: "M2 6h12M2 10h12",
};

function createElement(tag, className) {
  const element = document.createElement(tag);
  element.className = className;
  if (tag === "button") element.type = "button";
  return element;
}

function displayElements(display, index, interactive) {
  const name = `Display ${index + 1}`;
  const slot = createElement("div", "display-slot");
  slot.dataset.displayId = display.id;
  const card = createElement("section", "display");
  card.setAttribute("aria-label", name);
  const bezel = createElement(interactive ? "button" : "div", "display-bezel");
  if (interactive) bezel.setAttribute("aria-label", `Activate display ${index + 1}`);
  bezel.innerHTML = `<svg class="display-mode-icon" width="14" height="14" viewBox="0 0 16 16"
      fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
      <rect x="2" y="2" width="12" height="12" rx="1.4"/><path/>
    </svg><span class="display-name">${name}</span><span class="display-controls" aria-hidden="true"></span>`;
  const screen = createElement("div", "screen");
  const dividers = createElement("div", "display-dividers");
  const empty = createElement("span", "empty");
  empty.textContent = "Empty";
  screen.append(empty, dividers);
  card.append(screen, bezel);
  slot.append(card);
  return {
    slot, card, bezel, name, screen, dividers, empty, modeIcon: bezel.querySelector("path"),
  };
}

function renderDividers(view, display, index, drag) {
  const before = new Map([...view.dividers.children].map((handle) => [handle.dataset.boundaryId, handle]));
  for (const boundary of getBoundaries(display, { spreadResize: true })) {
    const old = before.get(boundary.id);
    const handle = old ?? createElement("div", "divider");
    before.delete(boundary.id);
    handle.className = `divider divider-${boundary.axis}`;
    handle.classList.toggle("resizing", drag?.id === display.id && drag.boundaryId === boundary.id);
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
    if (!old) view.dividers.append(handle);
  }
  for (const handle of before.values()) handle.remove();
}

function fitLayout(workspace, displays, alignTop) {
  const { width, height } = workspace.getBoundingClientRect();
  const { minX, minY, maxX, maxY } = getDisplayBounds(displays);
  const scale = Math.max(0.001, Math.min(
    Math.max(width - 12, 1) / (maxX - minX),
    Math.max(height - 12, 1) / (maxY - minY),
    1,
  ));
  return {
    minX, minY, scale,
    offsetX: (width - (maxX - minX) * scale) / 2,
    offsetY: alignTop ? 0 : (height - (maxY - minY) * scale) / 2,
  };
}

const coordinates = ["left", "top", "width", "height"];
const sameRect = (first, second) => coordinates.every((key) => Math.abs(first[key] - second[key]) < 0.1);
const relativeRect = (rect, workspace) => ({
  left: `${rect.left - workspace.left}px`, top: `${rect.top - workspace.top}px`,
  width: `${rect.width}px`, height: `${rect.height}px`,
});

export function createDisplayView(workspace, displays, { interactive = false, alignTop = false, onMotionFrame } = {}) {
  const screens = new Map();
  const windows = new Map();
  const inFlight = new Map();
  const preference = matchMedia("(prefers-reduced-motion: no-preference)");
  const layer = createElement("div", "window-motion");
  layer.inert = true;
  layer.setAttribute("aria-hidden", "true");
  workspace.append(layer);
  let layout;
  let frame;

  function getWindowRect(id) {
    return (inFlight.get(id)?.preview ?? windows.get(id))?.getBoundingClientRect();
  }

  function tick() {
    frame = undefined;
    onMotionFrame();
    if (inFlight.size) frame = requestAnimationFrame(tick);
  }

  function stop(id) {
    const flight = inFlight.get(id);
    if (!flight) return;
    inFlight.delete(id);
    flight.animation.cancel();
    flight.preview.remove();
    windows.get(id)?.classList.remove("in-motion");
  }

  preference.addEventListener("change", () => {
    if (!preference.matches) for (const id of inFlight.keys()) stop(id);
    onMotionFrame?.();
  });

  function animateWindow(id, window, current, destination, canvas) {
    if (current && sameRect(current.rect, destination)) return;
    // A visual copy can cross the gap between clipped screens. The real tile is
    // already in its destination; clicks, keyboard focus and state never wait.
    const preview = window.cloneNode(true);
    delete preview.dataset.windowId;
    preview.removeAttribute("aria-describedby");
    preview.removeAttribute("title");
    const end = relativeRect(destination, canvas);
    Object.assign(preview.style, end);
    layer.append(preview);
    window.classList.add("in-motion");
    const animation = preview.animate([
      { ...relativeRect(current?.rect ?? destination, canvas), opacity: current?.opacity ?? 0 },
      { ...end, opacity: 1 },
    ], { duration: 210, easing: "cubic-bezier(.2,.7,.25,1)", fill: "both" });
    inFlight.set(id, { preview, animation });
    animation.onfinish = () => {
      if (inFlight.get(id)?.animation !== animation) return;
      stop(id);
      onMotionFrame?.();
    };
    if (onMotionFrame && frame === undefined) frame = requestAnimationFrame(tick);
  }

  function render(state, { motion = "snap", drag } = {}) {
    const animate = motion === "animate" && preference.matches;
    const previous = new Map();
    if (animate) {
      for (const [id, window] of windows) {
        const preview = inFlight.get(id)?.preview;
        const target = window.getBoundingClientRect();
        previous.set(id, {
          target, rect: preview?.getBoundingClientRect() ?? target,
          opacity: preview ? Number(getComputedStyle(preview).opacity) : 1,
        });
      }
    } else if (motion !== "keep" || !preference.matches) {
      for (const id of inFlight.keys()) stop(id);
    }

    const active = getActiveDisplay(state);
    if (!drag || !layout) layout = fitLayout(workspace, state.displays, alignTop);
    const seenDisplays = new Set();
    const seenWindows = new Set();
    state.displays.forEach((display, index) => {
      seenDisplays.add(display.id);
      let screen = screens.get(display.id);
      if (!screen) {
        screen = displayElements(display, index, interactive);
        screens.set(display.id, screen);
        displays.append(screen.slot);
      }
      const isActive = display === active;
      screen.slot.classList.toggle("active-slot", isActive);
      screen.card.classList.toggle("active", isActive);
      if (interactive) {
        screen.bezel.setAttribute("aria-current", String(isActive));
      }
      if (screen.modeIcon.dataset.mode !== display.mode) {
        const description = `${modeNames[display.mode]} layout`;
        screen.bezel.title = `${screen.name} — ${description}`;
        if (interactive) screen.bezel.setAttribute("aria-description", description);
        screen.modeIcon.setAttribute("d", modeIcons[display.mode]);
        screen.modeIcon.dataset.mode = display.mode;
      }
      screen.empty.hidden = display.windows.length > 0;
      Object.assign(screen.slot.style, {
        left: `${layout.offsetX + (display.x - layout.minX) * layout.scale}px`,
        top: `${layout.offsetY + (display.y - layout.minY) * layout.scale}px`,
        width: `${display.width * layout.scale}px`,
        height: `${display.height * layout.scale}px`,
      });

      // Keep DOM order aligned with tile order for keyboard navigation.
      let previousTile = screen.empty;
      for (const { windowId: id, x, y, width, height } of getTiles(display)) {
        seenWindows.add(id);
        let window = windows.get(id);
        if (!window) {
          window = createElement(interactive ? "button" : "div", "window");
          window.dataset.windowId = id;
          populateWindow(window, id);
          windows.set(id, window);
        }
        const selected = display.activeWindowId === id;
        window.classList.toggle("selected", selected);
        window.classList.toggle("is-focused", selected && isActive);
        inFlight.get(id)?.preview.classList.toggle("is-focused", selected && isActive);
        if (interactive) window.setAttribute("aria-pressed", String(selected));
        Object.assign(window.style, {
          left: `${x * 100}%`, top: `${y * 100}%`, width: `${width * 100}%`, height: `${height * 100}%`,
        });
        if (previousTile.nextElementSibling !== window) previousTile.after(window);
        previousTile = window;
      }
      if (interactive) renderDividers(screen, display, index, drag);
    });
    for (const [id, window] of windows) {
      if (seenWindows.has(id)) continue;
      stop(id);
      window.remove();
      windows.delete(id);
    }
    for (const [id, screen] of screens) {
      if (seenDisplays.has(id)) continue;
      screen.slot.remove();
      screens.delete(id);
    }
    if (animate) {
      const canvas = workspace.getBoundingClientRect();
      for (const [id, window] of windows) {
        const old = previous.get(id);
        const target = window.getBoundingClientRect();
        if (old && sameRect(old.target, target)) continue;
        stop(id);
        animateWindow(id, window, old, target, canvas);
      }
    }
  }

  return { render, getWindowRect };
}
