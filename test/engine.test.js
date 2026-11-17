import test from "node:test";
import assert from "node:assert/strict";
import { applyAction, createState, getActiveDisplay, getTiles, isValidState } from "../engine.js";

function fixture(configs) {
  const displays = configs.map((config, i) => ({
    id: i + 1, x: i * 1000, y: 0, width: 1000, height: 800,
    mode: "binary", windows: [], activeWindowId: null,
    ...config,
  }));
  for (const display of displays) display.activeWindowId ??= display.windows[0] ?? null;
  return {
    displays, activeDisplayId: displays[0].id,
    nextDisplayId: Math.max(...displays.map((display) => display.id)) + 1,
    nextWindowId: Math.max(0, ...displays.flatMap((display) => display.windows)) + 1,
    message: "",
  };
}

const move = (state, direction) => applyAction(state, { type: "move", direction });
const focus = (state, direction) => applyAction(state, { type: "focus", direction });
const select = (state, id) => applyAction(state, { type: "select-window", id });
const rotate = (state, clockwise = true) => applyAction(state, { type: "rotate", clockwise });
const windows = (state) => getActiveDisplay(state).windows;

test("default state is valid and actions do not mutate their input", () => {
  const state = createState();
  const original = structuredClone(state);
  const next = move(state, "right");
  assert.ok(isValidState(state));
  assert.ok(isValidState(next));
  assert.deepEqual(state, original);
  assert.notDeepEqual(next, state);
});

for (const mode of ["binary", "columns", "horizontal"]) {
  test(`${mode}: slots cover the display exactly without overlap for 0–40 windows`, () => {
    for (let count = 0; count <= 40; count++) {
      const display = fixture([{ mode, windows: Array.from({ length: count }, (_, i) => i + 1) }]).displays[0];
      const tiles = getTiles(display);
      assert.equal(tiles.length, count);
      const area = tiles.reduce((sum, tile) => sum + tile.width * tile.height, 0);
      assert.ok(Math.abs(area - (count ? 1 : 0)) < 1e-9);
      for (const tile of tiles) {
        assert.ok(tile.x >= 0 && tile.y >= 0 && tile.width > 0 && tile.height > 0);
        assert.ok(tile.x + tile.width <= 1 + 1e-9 && tile.y + tile.height <= 1 + 1e-9);
        for (const other of tiles) {
          if (tile.index >= other.index) continue;
          const overlapX = Math.min(tile.x + tile.width, other.x + other.width) - Math.max(tile.x, other.x);
          const overlapY = Math.min(tile.y + tile.height, other.y + other.height) - Math.max(tile.y, other.y);
          assert.ok(overlapX < 1e-9 || overlapY < 1e-9);
        }
      }
    }
  });
}

test("binary uses alternating 50/50 splits", () => {
  const tiles = getTiles(fixture([{ windows: [1, 2, 3, 4] }]).displays[0]);
  assert.deepEqual(tiles.map(({ x, y, width, height }) => [x, y, width, height]), [
    [0, 0, 0.5, 0.5], [0, 0.5, 0.5, 0.5],
    [0.5, 0, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5],
  ]);
});

test("directional actions swap locally before considering other displays", () => {
  const state = fixture([{ windows: [1, 2, 3, 4] }, { windows: [5] }]);
  const right = move(state, "right");
  assert.deepEqual(windows(right), [3, 2, 1, 4]);
  assert.equal(right.activeDisplayId, 1);
  assert.equal(getActiveDisplay(right).activeWindowId, 1);
  assert.deepEqual(windows(move(state, "down")), [2, 1, 3, 4]);
});

test("left and up swap with their actual spatial neighbors", () => {
  const state = select(fixture([{ windows: [1, 2, 3, 4] }]), 4);
  assert.deepEqual(windows(move(state, "left")), [1, 4, 3, 2]);
  assert.deepEqual(windows(move(state, "up")), [1, 2, 4, 3]);
});

test("uneven binary neighbors use largest shared edge and deterministic ties", () => {
  const state = select(fixture([{ windows: [1, 2, 3] }]), 3);
  assert.deepEqual(windows(move(state, "left")), [3, 2, 1]);
});

test("directional selection changes focus in all four directions without moving windows", () => {
  const state = fixture([{ windows: [1, 2, 3, 4] }, { windows: [5] }]);
  for (const [id, direction, expected] of [
    [1, "right", 3], [1, "down", 2], [4, "left", 2], [4, "up", 3],
  ]) {
    const before = select(state, id);
    const next = focus(before, direction);
    assert.equal(next.activeDisplayId, 1);
    assert.equal(getActiveDisplay(next).activeWindowId, expected);
    const expectedState = structuredClone(before.displays);
    expectedState[0].activeWindowId = expected;
    assert.deepEqual(next.displays, expectedState);
    assert.ok(isValidState(next));
  }
});

test("selection and swaps resolve the same local neighbor in every layout", () => {
  for (const mode of ["binary", "columns", "horizontal"]) {
    for (let count = 2; count <= 15; count++) {
      const state = fixture([{ mode, windows: Array.from({ length: count }, (_, i) => i + 1) }]);
      for (const id of windows(state)) {
        const before = select(state, id);
        for (const direction of ["left", "right", "up", "down"]) {
          const next = focus(before, direction);
          const moved = move(before, direction);
          assert.equal(getActiveDisplay(next).activeWindowId, windows(moved)[id - 1]);
          assert.deepEqual(windows(next), windows(before));
          assert.equal(getActiveDisplay(next).mode, mode);
        }
      }
    }
  }
});

test("selection crosses displays using existing incoming-edge slots without retiling", () => {
  const state = select(fixture([
    { windows: [1, 2, 3, 4] },
    { windows: [5, 6, 7, 8], mode: "binary" },
  ]), 4);
  const next = focus(state, "right");
  assert.equal(next.activeDisplayId, 2);
  assert.equal(getActiveDisplay(next).activeWindowId, 6);
  assert.deepEqual(next.displays[0], state.displays[0]);
  assert.deepEqual(next.displays[1], { ...state.displays[1], activeWindowId: 6 });
  assert.equal(getActiveDisplay(focus(next, "left")).activeWindowId, 4);
});

test("vertical cross-display selection chooses the incoming top or bottom edge", () => {
  const state = fixture([
    { windows: [1, 2, 3], x: 0, y: 0, mode: "horizontal", activeWindowId: 3 },
    { windows: [4, 5, 6], x: 0, y: 800, mode: "horizontal", activeWindowId: 6 },
  ]);
  const down = focus(state, "down");
  assert.equal(down.activeDisplayId, 2);
  assert.equal(getActiveDisplay(down).activeWindowId, 4);
  const up = focus(down, "up");
  assert.equal(up.activeDisplayId, 1);
  assert.equal(getActiveDisplay(up).activeWindowId, 3);
  assert.deepEqual(up.displays.map((display) => display.windows), [[1, 2, 3], [4, 5, 6]]);
});

test("cross-display selection accounts for offsets, resolutions and multiple targets", () => {
  const state = select(fixture([
    { windows: [1, 2, 3, 4] },
    { windows: [5, 6, 7, 8], x: 1000, y: -400, height: 800 },
    { windows: [9, 10, 11, 12], x: 1000, y: 400, height: 1000 },
  ]), 4);
  const next = focus(state, "right");
  assert.equal(next.activeDisplayId, 3);
  assert.equal(getActiveDisplay(next).activeWindowId, 9);
  assert.equal(focus(select(state, 3), "right").activeDisplayId, 2);
});

test("selection enters and leaves empty displays without creating or moving windows", () => {
  const state = fixture([{ windows: [1, 2] }, {}]);
  const empty = focus(select(state, 2), "right");
  assert.equal(empty.activeDisplayId, 2);
  assert.equal(getActiveDisplay(empty).activeWindowId, null);
  assert.ok(isValidState(empty));
  const back = focus(empty, "left");
  assert.equal(back.activeDisplayId, 1);
  assert.equal(getActiveDisplay(back).activeWindowId, 2);
  assert.deepEqual(back.displays, state.displays.map((display) =>
    display.id === 1 ? { ...display, activeWindowId: 2 } : display));
  assert.ok(isValidState(back));
});

test("selection does not wrap or alter selection when no directional neighbor exists", () => {
  const state = fixture([{ windows: [1, 2] }]);
  assert.deepEqual(focus(state, "left").displays, state.displays);
  const empty = fixture([{}]);
  assert.deepEqual(focus(empty, "up").displays, empty.displays);
});

test("an outer edge with no neighboring display is a no-op", () => {
  const state = fixture([{ windows: [1, 2] }]);
  const next = move(state, "left");
  assert.deepEqual(next.displays, state.displays);
  assert.match(next.message, /No display/);
});

test("crossing right retiles both displays, uses the incoming edge and changes focus", () => {
  const state = select(fixture([
    { windows: [1, 2, 3, 4] },
    { windows: [5, 6], mode: "columns" },
  ]), 3);
  const next = move(state, "right");
  assert.deepEqual(next.displays[0].windows, [1, 2, 4]);
  assert.deepEqual(next.displays[1].windows, [3, 5, 6]);
  assert.equal(next.activeDisplayId, 2);
  assert.equal(getActiveDisplay(next).activeWindowId, 3);
  assert.equal(next.displays[0].mode, "binary");
  assert.equal(next.displays[1].mode, "columns");
  assert.ok(isValidState(next));
});

test("crossing left inserts on the destination's right edge", () => {
  let state = fixture([
    { windows: [1, 2], mode: "columns" },
    { windows: [3], mode: "horizontal" },
  ]);
  state = select(state, 3);
  const next = move(state, "left");
  assert.deepEqual(windows(next), [1, 2, 3]);
  assert.equal(next.activeDisplayId, 1);
  assert.equal(next.displays[1].activeWindowId, null);
});

test("crossing down inserts at the top and crossing up inserts at the bottom", () => {
  const state = fixture([
    { windows: [1], x: 0, y: 0, mode: "horizontal" },
    { windows: [2, 3], x: 0, y: 800, mode: "horizontal" },
  ]);
  const down = move(state, "down");
  assert.deepEqual(windows(down), [1, 2, 3]);
  assert.equal(down.activeDisplayId, 2);
  const up = move(down, "up");
  assert.deepEqual(windows(up), [1]);
  assert.equal(up.activeDisplayId, 1);
  assert.deepEqual(up.displays[1].windows, [2, 3]);
});

test("transferring the last window into an empty display remains valid", () => {
  const next = move(fixture([{ windows: [1] }, {}]), "right");
  assert.deepEqual(next.displays[0].windows, []);
  assert.equal(next.displays[0].activeWindowId, null);
  assert.deepEqual(next.displays[1].windows, [1]);
  assert.equal(next.displays[1].activeWindowId, 1);
  assert.ok(isValidState(next));
});

test("cross-display placement respects physical offsets and different resolutions", () => {
  const state = select(fixture([
    { windows: [1, 2, 3, 4], height: 800 },
    { windows: [5, 6, 7], y: 300, height: 1000 },
  ]), 4);
  const next = move(state, "right");
  const tile = getTiles(next.displays[1]).find((item) => item.windowId === 4);
  assert.equal(tile.x, 0);
  assert.equal(tile.y, 0); // Source center Y=600; destination-relative Y=0.3.
});

test("multiple displays in one direction are chosen from the window's exit point", () => {
  const state = select(fixture([
    { windows: [1, 2, 3, 4] },
    { windows: [5], x: 1000, y: -400, height: 800 },
    { windows: [6], x: 1000, y: 400, height: 800 },
  ]), 4);
  assert.equal(move(state, "right").activeDisplayId, 3);
  assert.equal(move(select(state, 3), "right").activeDisplayId, 2);
});

test("diagonally offset displays can be reached; movement does not wrap", () => {
  const state = fixture([
    { windows: [1] },
    { windows: [2], x: 1200, y: 1000 },
  ]);
  assert.equal(move(state, "right").activeDisplayId, 2);
  assert.equal(move(state, "down").activeDisplayId, 2);
  assert.equal(move(state, "left").activeDisplayId, 1);
});

test("rotation follows clockwise positions in a 2×2 binary layout", () => {
  const state = fixture([{ windows: [1, 2, 3, 4] }, { windows: [5, 6] }]);
  const next = rotate(state);
  assert.deepEqual(windows(next), [2, 4, 1, 3]);
  assert.equal(getActiveDisplay(next).activeWindowId, 1);
  assert.deepEqual(next.displays[1], state.displays[1]);
});

test("column and horizontal rotations cycle reading order", () => {
  for (const mode of ["columns", "horizontal"]) {
    const state = fixture([{ windows: [1, 2, 3], mode }]);
    assert.deepEqual(windows(rotate(state)), [3, 1, 2]);
    assert.deepEqual(windows(rotate(state, false)), [2, 3, 1]);
  }
});

test("rotation is invertible and preserves slot geometry for all modes and counts", () => {
  for (const mode of ["binary", "columns", "horizontal"]) {
    for (let count = 0; count <= 30; count++) {
      const state = fixture([{ mode, windows: Array.from({ length: count }, (_, i) => i + 1) }]);
      const next = rotate(state);
      assert.deepEqual(rotate(next, false).displays, state.displays);
      const rects = (value) => getTiles(value.displays[0]).map(({ x, y, width, height }) => [x, y, width, height]);
      assert.deepEqual(rects(next), rects(state));
      assert.ok(isValidState(next));
    }
  }
});

test("mode and selected window are remembered independently per display", () => {
  let state = select(createState(), 6);
  state = applyAction(state, { type: "set-layout", mode: "horizontal" });
  state = applyAction(state, { type: "select-display", id: 1 });
  assert.equal(getActiveDisplay(state).mode, "binary");
  state = applyAction(state, { type: "select-display", id: 2 });
  assert.equal(getActiveDisplay(state).mode, "horizontal");
  assert.equal(getActiveDisplay(state).activeWindowId, 6);
});

test("adding and removing windows maintains valid selection, including an empty screen", () => {
  let state = fixture([{ windows: [1, 2] }]);
  state = applyAction(state, { type: "add-window" });
  assert.deepEqual(windows(state), [1, 2, 3]);
  assert.equal(getActiveDisplay(state).activeWindowId, 3);
  for (let i = 0; i < 3; i++) state = applyAction(state, { type: "remove-window" });
  assert.deepEqual(windows(state), []);
  assert.equal(getActiveDisplay(state).activeWindowId, null);
  assert.ok(isValidState(state));
  assert.deepEqual(windows(move(state, "right")), []);
});

test("adding displays creates an empty active screen to the right", () => {
  const next = applyAction(createState(), { type: "add-display" });
  assert.equal(next.displays.length, 3);
  assert.equal(getActiveDisplay(next).x, 2560);
  assert.deepEqual(windows(next), []);
  assert.ok(isValidState(next));
});

test("removing a display preserves its windows on the nearest remaining display", () => {
  const state = fixture([
    { windows: [1, 2], x: 0 },
    { windows: [3], x: 1000, mode: "columns" },
    { windows: [4], x: 5000 },
  ]);
  const next = applyAction(state, { type: "remove-display" });
  assert.equal(next.displays.length, 2);
  assert.equal(next.activeDisplayId, 2);
  assert.deepEqual(windows(next), [3, 1, 2]);
  assert.equal(getActiveDisplay(next).mode, "columns");
  assert.equal(getActiveDisplay(next).activeWindowId, 1);
  assert.ok(isValidState(next));
  const single = fixture([{ windows: [1] }]);
  assert.deepEqual(applyAction(single, { type: "remove-display" }), single);
});

test("negative coordinates and geometry changes are supported", () => {
  const next = applyAction(createState(), {
    type: "set-geometry", id: 2, x: -1920, y: -300, width: 1920, height: 1080,
  });
  assert.equal(next.displays[1].x, -1920);
  assert.equal(next.displays[1].height, 1080);
  assert.ok(isValidState(next));
  const invalid = applyAction(next, { type: "set-geometry", width: 0 });
  assert.deepEqual(invalid.displays, next.displays);
});

test("invalid actions are ignored and corrupt saved states are rejected", () => {
  const state = createState();
  for (const action of [
    { type: "select-display", id: 999 }, { type: "select-window", id: 999 },
    { type: "set-layout", mode: "unknown" }, { type: "move", direction: "diagonal" },
    { type: "focus", direction: "diagonal" },
    { type: "set-geometry", x: NaN }, { type: "unknown" },
  ]) assert.deepEqual(applyAction(state, action), state);
  assert.equal(isValidState(null), false);
  assert.equal(isValidState({ ...state, displays: [] }), false);
  const duplicate = structuredClone(state);
  duplicate.displays[1].windows.push(1);
  assert.equal(isValidState(duplicate), false);
  assert.equal(isValidState({ ...state, activeDisplayId: 999 }), false);
});

test("a deterministic mixed-action stress test preserves all state invariants", () => {
  let state = createState();
  let seed = 137;
  const random = (max) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % max;
  };
  for (let i = 0; i < 2000; i++) {
    const choices = [
      { type: "move", direction: ["left", "right", "up", "down"][random(4)] },
      { type: "focus", direction: ["left", "right", "up", "down"][random(4)] },
      { type: "rotate", clockwise: random(2) === 0 },
      { type: "set-layout", mode: ["binary", "columns", "horizontal"][random(3)] },
      { type: "add-window" }, { type: "remove-window" },
      { type: "select-display", id: state.displays[random(state.displays.length)].id },
      { type: "set-geometry", x: random(5000) - 2500, y: random(3000) - 1500 },
    ];
    if (state.displays.length < 8) choices.push({ type: "add-display" });
    if (state.displays.length > 1) choices.push({ type: "remove-display" });
    state = applyAction(state, choices[random(choices.length)]);
    assert.ok(isValidState(state), `Invalid state at step ${i}`);
  }
});
