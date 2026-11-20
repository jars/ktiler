import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { applyAction, getActiveDisplay, getTiles, isValidState } from "../engine.js";
import { createSimulatorState, getAddDisplaySlot, getShortcutAction, shortcutGroups } from "../simulator.js";
import { describeWindow, getDemoWindowId } from "../window-previews.js";

test("the simulator starts with three displays and fills the vacant lower-right slot", () => {
  const state = createSimulatorState();
  const position = ({ x, y }) => [x, y];
  assert.deepEqual(state.displays.map(position), [[0, 0], [1280, 0], [0, 800]]);
  assert.deepEqual(state.displays.map(({ mode }) => mode), ["binary", "horizontal", "columns"]);
  const rectangles = state.displays.map((display) => getTiles(display)
    .map(({ windowId, x, y, width, height }) => [describeWindow(windowId).title, x, y, width, height]));
  assert.deepEqual(rectangles, [
    [["Code Editor", 0, 0, 0.75, 0.6], ["Terminal", 0, 0.6, 0.75, 0.4], ["Music Player", 0.75, 0, 0.25, 1]],
    [["File Manager", 0, 0, 1, 0.5], ["Spreadsheet", 0, 0.5, 1, 0.5]],
    [["Chrome", 0, 0, 0.5, 1], ["Image Editor", 0.5, 0, 0.5, 1]],
  ]);
  assert.equal(state.spreadResize, true);
  assert.ok(isValidState(state));
  const slot = getAddDisplaySlot(state.displays);
  assert.deepEqual(slot, { x: 1280, y: 800, width: 1280, height: 800 });
  const withFourth = applyAction(state, { type: "add-display", geometry: slot });
  assert.deepEqual(withFourth.displays.slice(0, 3), state.displays);
  assert.deepEqual(position(getActiveDisplay(withFourth)), position(slot));
  assert.deepEqual(getActiveDisplay(withFourth).windows, []);
  assert.equal(getAddDisplaySlot(withFourth.displays), undefined);
  assert.ok(isValidState(withFourth));
  const overlappingSlot = applyAction(state, { type: "set-geometry", id: 2, y: 300 });
  assert.equal(getAddDisplaySlot(overlappingSlot.displays), undefined);
});

test("removing an inactive display targets its own windows without taking focus", () => {
  const state = createSimulatorState();
  const remove = state.displays[2];
  const selected = getActiveDisplay(state).activeWindowId;
  const next = applyAction(state, { type: "remove-display", id: remove.id });
  assert.deepEqual(next.displays.map(({ id }) => id), [1, 2]);
  assert.equal(next.activeDisplayId, state.activeDisplayId);
  assert.deepEqual(getActiveDisplay(next).windows, [...getActiveDisplay(state).windows, ...remove.windows]);
  assert.equal(getActiveDisplay(next).activeWindowId, selected);
  assert.ok(isValidState(next));
  assert.equal(applyAction(state, { type: "remove-display", id: 999 }), state);
});

test("a new simulator session starts fresh regardless of an earlier session's changes", () => {
  const session = createSimulatorState();
  const initial = structuredClone(session);
  let changed = applyAction(session, { type: "add-display", geometry: getAddDisplaySlot(session.displays) });
  const image = getDemoWindowId("image");
  changed = applyAction(changed, { type: "select-window", id: image });
  changed = applyAction(changed, { type: "move", direction: "right" });
  assert.deepEqual(getActiveDisplay(changed).windows, [image]);
  changed = applyAction(changed, { type: "remove-display", id: 2 });
  changed = applyAction(changed, { type: "resize-boundary", id: 1, boundaryId: "root:0", position: 0.5 });
  assert.deepEqual(changed.displays.map(({ id }) => id), [1, 3, 4]);
  assert.equal(changed.displays[0].layout.weights[0], 0.5);
  assert.deepEqual(createSimulatorState(), initial);
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

test("the sidebar and browser dispatch the exact KWin factory shortcuts", async () => {
  const source = await readFile(new URL("../kwin/contents/code/bindings.js", import.meta.url), "utf8");
  const desktop = JSON.parse(vm.runInNewContext(`${source}\nJSON.stringify(shortcutBindings())`));
  const browser = shortcutGroups.flatMap(({ bindings }) => bindings);
  assert.equal(browser.length, 13);
  for (const { keys, action } of browser) {
    assert.deepEqual(desktop.find(({ fallback }) => fallback === keys)?.action, action);
    for (const key of [keys.at(-1).toLowerCase(), keys.at(-1).toUpperCase()]) {
      assert.deepEqual(getShortcutAction({ key, altKey: true, shiftKey: keys.includes("+Shift+") }), action);
    }
  }
  for (const key of ["ArrowRight", "ArrowLeft", "v", "h", "=", "+", "1", "r", "e", "|"]) {
    assert.equal(getShortcutAction({ key, altKey: true }), undefined, key);
  }
  for (const modifiers of [{ altKey: false }, { ctrlKey: true }, { metaKey: true },
    { isComposing: true }, { getModifierState: (name) => name === "AltGraph" }]) {
    assert.equal(getShortcutAction({ key: "d", altKey: true, ...modifiers }), undefined);
  }
  assert.equal(getShortcutAction({ key: "B", altKey: true, shiftKey: true }), undefined);
});
