import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { applyAction, getActiveDisplay, isValidState } from "../engine.js";
import { createSimulatorState, getAddDisplaySlot, getShortcutAction, shortcutGroups } from "../simulator.js";

test("the simulator starts with three displays and fills the vacant lower-right slot", () => {
  const state = createSimulatorState();
  const position = ({ x, y }) => [x, y];
  assert.deepEqual(state.displays.map(position), [[0, 0], [1280, 0], [0, 800]]);
  assert.ok(state.displays.every((display) => display.windows.length > 1));
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
