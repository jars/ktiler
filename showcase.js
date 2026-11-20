import { createDisplayView } from "./display-view.js";
import { applyAction, getActiveDisplay } from "./engine.js";
import { createShowcaseState, showcaseSteps } from "./simulator.js";

const workspace = document.querySelector("#showcase");
const callout = workspace.querySelector(".showcase-keypress");
const keycaps = callout.querySelector(".tiling-tip-keys");
const view = createDisplayView(workspace, workspace.querySelector(".tiling-displays"), { onMotionFrame: positionCallout });
const motion = matchMedia("(prefers-reduced-motion: no-preference)");
let state = createShowcaseState();
let stepIndex = 0;
let onScreen = false;
let timer;
let anchor;

const fadeIn = 100;
const lead = 400;
const hold = 720;
const fade = 160;
const interval = 2300;

function positionCallout() {
  if (anchor === undefined) return;
  const tile = view.getWindowRect(anchor);
  if (!tile) return;
  const canvas = workspace.getBoundingClientRect();
  callout.style.left = `${tile.left - canvas.left + tile.width / 2}px`;
  callout.style.top = `${tile.top - canvas.top + tile.height / 2}px`;
}

function hideCallout() {
  callout.hidden = true;
  anchor = undefined;
  for (const animation of callout.getAnimations()) animation.cancel();
}

function schedule(callback, delay) {
  timer = setTimeout(() => {
    timer = undefined;
    if (canPlay()) callback();
  }, delay);
}

function playStep() {
  const { keys, action } = showcaseSteps[stepIndex];
  anchor = getActiveDisplay(state).activeWindowId;
  keycaps.replaceChildren(...keys.split("+").map((key) => {
    const cap = document.createElement("kbd");
    cap.textContent = key;
    return cap;
  }));
  callout.hidden = false;
  positionCallout();
  callout.animate([{ opacity: 0 }, { opacity: 1 }], { duration: fadeIn });
  schedule(() => {
    state = applyAction(state, action);
    stepIndex = (stepIndex + 1) % showcaseSteps.length;
    view.render(state, { motion: "animate" });
    positionCallout();
    schedule(() => {
      callout.animate([{ opacity: 1 }, { opacity: 0 }], { duration: fade, fill: "forwards" });
      schedule(() => {
        hideCallout();
        schedule(playStep, interval - lead - hold - fade);
      }, fade);
    }, hold);
  }, lead);
}

const canPlay = () => motion.matches && onScreen && !document.hidden;
function updatePlayback() {
  if (canPlay()) {
    if (timer === undefined) schedule(playStep, 650);
    return;
  }
  clearTimeout(timer);
  timer = undefined;
  hideCallout();
  view.render(state);
}

view.render(state);
new ResizeObserver(() => {
  view.render(state);
  positionCallout();
}).observe(workspace);
new IntersectionObserver(([entry]) => {
  onScreen = entry.intersectionRatio >= 0.2;
  updatePlayback();
}, { threshold: 0.2 }).observe(workspace);
motion.addEventListener("change", updatePlayback);
document.addEventListener("visibilitychange", updatePlayback);
