import { completesMoveTutorialStep, getMoveTutorialTip, moveTutorialSteps } from "./simulator.js";
import { createKeyChord } from "./keycaps.js";

export function createMoveTutorial(workspace, displays, callout, getWindowRect) {
  const message = callout.querySelector(".move-tip-message");
  const keys = callout.querySelector(".tiling-tip-keys");
  const motion = matchMedia("(prefers-reduced-motion: no-preference)");
  let stepIndex = 0;
  let fading = false;
  let latestState;
  let shownStep;
  let anchor;

  function reposition() {
    if (!anchor) return;
    const tile = getWindowRect(anchor.id);
    if (tile) position(callout, tile, workspace, anchor.direction);
  }

  function render(state) {
    latestState = state;
    if (fading) {
      reposition();
      return;
    }
    anchor?.window.removeAttribute("aria-describedby");
    anchor = undefined;
    let step = moveTutorialSteps[stepIndex];
    let tip = getMoveTutorialTip(state, step);
    // Free exploration can empty a source display or make the exercise inapplicable.
    while (step && !tip) {
      step = moveTutorialSteps[++stepIndex];
      tip = getMoveTutorialTip(state, step);
    }
    if (!tip) {
      callout.hidden = true;
      return;
    }

    const window = displays.querySelector(`[data-window-id="${tip.id}"]`);
    anchor = { id: tip.id, window, direction: step.direction };
    window.setAttribute("aria-describedby", callout.id);
    let text;
    if (step.type === "focus") text = `Focus ${window.title} to the ${step.direction}.`;
    else if (tip.selected) text = `Move ${window.title} ${step.direction} to Display ${step.to}.`;
    else text = `Select ${window.title}, then move it ${step.direction} to Display ${step.to}.`;
    if (message.textContent !== text) message.textContent = text;
    if (shownStep !== step) {
      keys.replaceChildren(createKeyChord(tip.keys.split("+")));
    }
    callout.hidden = false;
    reposition();
    if (shownStep !== step && motion.matches) callout.animate([{ opacity: 0 }, { opacity: 1 }], 160);
    shownStep = step;
  }

  function onAction(before, after, action, shortcut) {
    const step = moveTutorialSteps[stepIndex];
    if ((!shortcut && step?.type !== "focus") || !completesMoveTutorialStep(before, after, action, step)) return;
    stepIndex++;
    if (fading || !motion.matches) return;
    fading = true;
    const fade = callout.animate([{ opacity: getComputedStyle(callout).opacity }, { opacity: 0 }],
      { duration: 180, fill: "forwards" });
    fade.finished.then(() => {
      callout.hidden = true;
      fade.cancel();
      fading = false;
      render(latestState);
    });
  }

  return { render, onAction, reposition };
}

function position(callout, tile, workspace, direction) {
  const gap = 8;
  const edge = 6;
  const canvas = workspace.getBoundingClientRect();
  const { width, height } = callout.getBoundingClientRect();
  const x = tile.left - canvas.left;
  const y = tile.top - canvas.top;
  const centerX = x + tile.width / 2;
  const centerY = y + tile.height / 2;
  const placements = {
    right: [x + tile.width + gap, centerY - height / 2],
    bottom: [centerX - width / 2, y + tile.height + gap],
    left: [x - width - gap, centerY - height / 2],
    top: [centerX - width / 2, y - height - gap],
  };
  const sideOrder = direction === "right" ? ["right", "left", "bottom", "top"] : ["bottom", "top", "right", "left"];
  const horizontal = (side) => side === "right" || side === "left";
  const side = sideOrder.find((side) => {
    const [left, top] = placements[side];
    return horizontal(side) ? left >= edge && left + width <= canvas.width - edge
      : top >= edge && top + height <= canvas.height - edge;
  }) ?? sideOrder[0];
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const left = clamp(placements[side][0], edge, canvas.width - width - edge);
  const top = clamp(placements[side][1], edge, canvas.height - height - edge);
  const pointer = horizontal(side)
    ? clamp(centerY - top, 12, height - 12)
    : clamp(centerX - left, 12, width - 12);
  callout.dataset.side = side;
  callout.style.left = `${left}px`;
  callout.style.top = `${top}px`;
  callout.style.setProperty("--pointer", `${pointer}px`);
}
