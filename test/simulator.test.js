import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { applyAction, getActiveDisplay, getTiles, isValidState } from "../engine.js";
import { completesMoveTutorialStep, createShowcaseState, createSimulatorState, getMoveTutorialTip, getShortcutAction,
  moveTutorialSteps, shortcutGroups, showcaseSteps } from "../simulator.js";
import { describeWindow, getDemoWindowId } from "../window-previews.js";

test("the simulator starts with four displays and the lower-right one is empty", () => {
  const state = createSimulatorState();
  const position = ({ x, y }) => [x, y];
  assert.deepEqual(state.displays.map(position), [[0, 0], [1280, 0], [0, 800], [1280, 800]]);
  assert.deepEqual(state.displays.map(({ mode }) => mode), ["binary", "horizontal", "columns", "binary"]);
  const rectangles = state.displays.map((display) => getTiles(display)
    .map(({ windowId, x, y, width, height }) => [describeWindow(windowId).title, x, y, width, height]));
  assert.deepEqual(rectangles, [
    [["Code Editor", 0, 0, 0.75, 0.6], ["Terminal", 0, 0.6, 0.75, 0.4], ["Music Player", 0.75, 0, 0.25, 1]],
    [["File Manager", 0, 0, 1, 0.5], ["Spreadsheet", 0, 0.5, 1, 0.5]],
    [["Chrome", 0, 0, 0.5, 1], ["Image Editor", 0.5, 0, 0.5, 1]],
    [],
  ]);
  assert.equal(state.displays[3].activeWindowId, null);
  assert.equal(state.spreadResize, true);
  assert.ok(isValidState(state));
});

test("a new simulator session starts fresh regardless of an earlier session's changes", () => {
  const session = createSimulatorState();
  const initial = structuredClone(session);
  const image = getDemoWindowId("image");
  let changed = applyAction(session, { type: "select-window", id: image });
  changed = applyAction(changed, { type: "move", direction: "right" });
  assert.equal(changed.activeDisplayId, 4);
  assert.deepEqual(getActiveDisplay(changed).windows, [image]);
  changed = applyAction(changed, { type: "resize-boundary", id: 1, boundaryId: "root:0", position: 0.5 });
  assert.deepEqual(changed.displays.map(({ id }) => id), [1, 2, 3, 4]);
  assert.equal(changed.displays[0].layout.weights[0], 0.5);
  assert.deepEqual(createSimulatorState(), initial);
});

test("the homepage moves and swaps Terminal in a loop without a layout reset", () => {
  const before = createShowcaseState();
  const terminal = getDemoWindowId("terminal");
  assert.deepEqual(before.displays.map(({ x, y }) => [x, y]), [[0, 0], [0, 640]]);
  assert.deepEqual(before.displays.map(({ windows }) => windows.length), [2, 2]);
  assert.deepEqual(showcaseSteps.map(({ keys }) => keys), ["Alt+Shift+S", "Alt+Shift+A", "Alt+Shift+D",
    "Alt+Shift+W", "Alt+Shift+A", "Alt+Shift+D"]);
  let state = before;
  for (const [index, { action }] of showcaseSteps.entries()) {
    assert.ok(isValidState(state));
    const previous = state.displays.flatMap((display) => getTiles(display));
    state = applyAction(state, action);
    assert.notDeepEqual(state.displays.flatMap((display) => getTiles(display)), previous);
    assert.equal(state.activeDisplayId, index < 3 ? 2 : 1);
    assert.equal(getActiveDisplay(state).activeWindowId, terminal);
  }
  assert.deepEqual(state.displays, before.displays);
  assert.ok(isValidState(state));
});

test("fake apps have distinct names and keep their identity when rotated or transferred", () => {
  const state = createSimulatorState();
  const initial = new Map(state.displays.flatMap(({ windows }) => windows.map((id) => [id, describeWindow(id)])));
  const names = new Set([...initial.values()].map(({ title }) => title));
  assert.equal(names.size, 7);
  const files = getDemoWindowId("files");
  let next = applyAction(state, { type: "rotate", clockwise: true });
  assert.notDeepEqual(next.displays[0].windows, state.displays[0].windows);
  assert.deepEqual(next.displays[0].layout, state.displays[0].layout);
  next = applyAction(next, { type: "select-window", id: files });
  next = applyAction(next, { type: "move", direction: "left" });
  assert.ok(next.displays[0].windows.includes(files));
  for (const display of JSON.parse(JSON.stringify(next)).displays) {
    for (const id of display.windows) assert.deepEqual(describeWindow(id), initial.get(id));
  }
  assert.equal(describeWindow(11).kind, describeWindow(1).kind);
  assert.equal(describeWindow(11).title, "Terminal 2");
});

test("the tutorial recommends transfers, teaches keyboard focus, and ignores swaps", () => {
  let state = createSimulatorState();
  const first = moveTutorialSteps[0];
  const swap = { type: "move", direction: "down" };
  const codeSelected = applyAction(state, { type: "select-window", id: getDemoWindowId("code") });
  const swapped = applyAction(codeSelected, swap);
  assert.notDeepEqual(swapped.displays[0].windows, codeSelected.displays[0].windows);
  assert.equal(completesMoveTutorialStep(codeSelected, swapped, swap, first), false);
  assert.deepEqual(getMoveTutorialTip(state, first), {
    id: getDemoWindowId("terminal"), keys: "Alt+Shift+S", selected: true,
  });

  const shortcuts = [];
  const destinations = [];
  for (const step of moveTutorialSteps) {
    const tip = getMoveTutorialTip(state, step);
    const action = getShortcutAction({ key: tip.keys.at(-1), altKey: true, shiftKey: tip.keys.includes("Shift") });
    const click = { type: "select-window", id: tip.id };
    const clicked = applyAction(state, click);
    if (step.type === "focus") {
      assert.equal(tip.id, getDemoWindowId("image"));
      assert.equal(getActiveDisplay(state).activeWindowId, getDemoWindowId("terminal"));
      assert.equal(completesMoveTutorialStep(state, clicked, click, step), true);
      assert.equal(getMoveTutorialTip(clicked, step), null);
    } else {
      assert.equal(completesMoveTutorialStep(state, clicked, click, step), false);
      if (!tip.selected) state = clicked;
      assert.equal(getMoveTutorialTip(state, step).selected, true);
    }
    const next = applyAction(state, action);
    assert.equal(completesMoveTutorialStep(state, next, action, step), true);
    assert.equal(getActiveDisplay(next).activeWindowId, tip.id);
    if (step.type === "focus") assert.deepEqual(next.displays.map(d => d.windows), state.displays.map(d => d.windows));
    shortcuts.push(tip.keys);
    destinations.push(next.activeDisplayId);
    state = next;
  }
  assert.deepEqual(shortcuts, ["Alt+Shift+S", "Alt+D", "Alt+Shift+D", "Alt+Shift+S"]);
  assert.deepEqual(destinations, [3, 3, 4, 4]);
  assert.equal(getMoveTutorialTip(state, undefined), null);
  state.displays[0].windows = [];
  assert.equal(getMoveTutorialTip(state, first), null);
});

test("the sidebar and browser match the physical keys for KWin's factory shortcuts", async () => {
  const source = await readFile(new URL("../kwin/contents/code/bindings.js", import.meta.url), "utf8");
  const desktop = JSON.parse(vm.runInNewContext(`${source}\nJSON.stringify(shortcutBindings())`));
  const browser = shortcutGroups.flatMap(({ bindings }) => bindings);
  assert.equal(browser.length, 13);
  const nativeLayoutKeys = { "Alt+Shift+1": "Alt+!", "Alt+Shift+2": "Alt+@", "Alt+Shift+3": "Alt+#" };
  for (const { keys, action } of browser) {
    const native = nativeLayoutKeys[keys] ?? keys;
    assert.deepEqual(desktop.find(({ fallback }) => fallback === native)?.action, action);
    for (const key of [keys.at(-1).toLowerCase(), keys.at(-1).toUpperCase()]) {
      assert.deepEqual(getShortcutAction({ key, altKey: true, shiftKey: keys.includes("+Shift+") }), action);
    }
  }
  for (const [key, code, mode] of [["!", "Digit1", "binary"], ["@", "Digit2", "columns"], ["#", "Digit3", "horizontal"]]) {
    assert.deepEqual(getShortcutAction({ key, code, altKey: true, shiftKey: true }), { type: "set-layout", mode });
    assert.equal(getShortcutAction({ key, code, altKey: true, shiftKey: false }), undefined);
  }
  for (const key of ["ArrowRight", "ArrowLeft", "v", "h", "=", "+", "1", "2", "3", "b", "\\", "-", "r", "e", "|"]) {
    assert.equal(getShortcutAction({ key, altKey: true }), undefined, key);
  }
  for (const modifiers of [{ altKey: false }, { ctrlKey: true }, { metaKey: true },
    { isComposing: true }, { getModifierState: (name) => name === "AltGraph" }]) {
    assert.equal(getShortcutAction({ key: "d", altKey: true, ...modifiers }), undefined);
  }
  assert.equal(getShortcutAction({ key: "B", altKey: true, shiftKey: true }), undefined);
});
