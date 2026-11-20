import test from "node:test";
import assert from "node:assert/strict";
import { applyAction, createState, getActiveDisplay, getBoundaries, getTiles, isValidState } from "../engine.js";

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);
const rects = (display) => getTiles(display).map(({ x, y, width, height }) => [x, y, width, height]);
function fixture(mode = "binary", count = 4, spreadResize = false) {
  const state = createState();
  state.spreadResize = spreadResize;
  state.displays = [{
    id: 1, x: 0, y: 0, width: 1280, height: 800, mode,
    windows: Array.from({ length: count }, (_, i) => i + 1),
    activeWindowId: count ? 1 : null,
  }];
  state.nextWindowId = count + 1;
  return state;
}
const resize = (state, boundaryId, position, options = {}) =>
  applyAction(state, { type: "resize-boundary", boundaryId, position, ...options });

function assertPartition(display) {
  const tiles = getTiles(display);
  near(tiles.reduce((sum, tile) => sum + tile.width * tile.height, 0), tiles.length ? 1 : 0);
  for (const tile of tiles) {
    assert.ok(tile.width > 0 && tile.height > 0);
    assert.ok(tile.x >= -1e-9 && tile.y >= -1e-9);
    assert.ok(tile.x + tile.width <= 1 + 1e-9 && tile.y + tile.height <= 1 + 1e-9);
    for (const other of tiles) {
      if (other.index <= tile.index) continue;
      const x = Math.min(tile.x + tile.width, other.x + other.width) - Math.max(tile.x, other.x);
      const y = Math.min(tile.y + tile.height, other.y + other.height) - Math.max(tile.y, other.y);
      assert.ok(x < 1e-9 || y < 1e-9, "Tiles overlap");
    }
  }
}

test("only internal boundaries are exposed; empty and single-window screens have none", () => {
  for (const mode of ["binary", "columns", "horizontal"]) {
    for (let count = 0; count < 20; count++) {
      const boundaries = getBoundaries(fixture(mode, count).displays[0]);
      assert.equal(boundaries.length, Math.max(count - 1, 0));
      assert.equal(new Set(boundaries.map((item) => item.id)).size, boundaries.length);
      assert.ok(boundaries.every((item) => item.position > 0 && item.position < 1));
    }
  }
});

test("a binary ancestor divider resizes both entire branches without changing window identity", () => {
  const state = fixture();
  const original = structuredClone(state);
  const next = resize(state, "root:0", 0.7);
  assert.deepEqual(rects(next.displays[0]), [
    [0, 0, 0.7, 0.5], [0, 0.5, 0.7, 0.5],
    [0.7, 0, 0.30000000000000004, 0.5], [0.7, 0.5, 0.30000000000000004, 0.5],
  ]);
  assert.deepEqual(state, original);
  assert.deepEqual(next.displays[0].windows, state.displays[0].windows);
  assert.equal(next.displays[0].activeWindowId, 1);
  assertPartition(next.displays[0]);
});

test("a nested binary divider affects only its branch and stays relative to ancestor resizes", () => {
  let state = resize(fixture(), "root/0:0", 0.3);
  const before = rects(state.displays[0]);
  assert.deepEqual(before.slice(2), [[0.5, 0, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]]);
  state = resize(state, "root:0", 0.6);
  const tiles = getTiles(state.displays[0]);
  near(tiles[0].height, 0.3);
  near(tiles[1].height, 0.7);
  near(tiles[0].width, 0.6);
  assertPartition(state.displays[0]);
});

test("row and column dividers resize only the two adjacent slots", () => {
  for (const mode of ["columns", "horizontal"]) {
    const state = resize(fixture(mode), "root:1", 0.6);
    const tiles = getTiles(state.displays[0]);
    const size = mode === "columns" ? "width" : "height";
    near(tiles[0][size], 0.25);
    near(tiles[1][size], 0.35);
    near(tiles[2][size], 0.15);
    near(tiles[3][size], 0.25);
    assertPartition(state.displays[0]);
  }
});

test("spread resize grows only the target and shares compensation beyond its edge", () => {
  for (const mode of ["columns", "horizontal"]) {
    const state = fixture(mode, 4, true);
    state.displays[0].activeWindowId = 2;
    const dimension = mode === "columns" ? 1280 : 800;
    const size = mode === "columns" ? "width" : "height";
    const next = resize(state, "root:1", 0.5 + 60 / dimension);
    const tiles = getTiles(next.displays[0]);
    near(tiles[0][size] * dimension, dimension / 4);
    near(tiles[1][size] * dimension, dimension / 4 + 60);
    near(tiles[2][size] * dimension, dimension / 4 - 30);
    near(tiles[3][size] * dimension, dimension / 4 - 30);
    assertPartition(next.displays[0]);
    assert.equal(next.displays[0].activeWindowId, 2);
  }
});

test("reversing a drag keeps its anchor and fixed side, rather than switching targets", () => {
  for (const mode of ["columns", "horizontal"]) {
    const state = fixture(mode, 4, true);
    state.displays[0].activeWindowId = 2;
    const options = { anchorWindowId: 2, initialWeights: [0.25, 0.25, 0.25, 0.25] };
    let next = resize(state, "root:1", 0.65, options);
    next = resize(next, "root:1", 0.4, options);
    const size = mode === "columns" ? "width" : "height";
    const tiles = getTiles(next.displays[0]);
    near(tiles[0][size], 0.25);
    near(tiles[1][size], 0.15);
    near(tiles[2][size], 0.3);
    near(tiles[3][size], 0.3);
    next = resize(next, "root:1", 0.5, options);
    rects(next.displays[0]).forEach((rect, index) => {
      rect.forEach((value, dimension) => near(value, rects(state.displays[0])[index][dimension]));
    });
  }
});

test("a target's left/top edge distributes only toward the start of the display", () => {
  for (const mode of ["columns", "horizontal"]) {
    const state = fixture(mode, 4, true);
    state.displays[0].activeWindowId = 3;
    const size = mode === "columns" ? "width" : "height";
    let next = resize(state, "root:1", 0.4);
    let tiles = getTiles(next.displays[0]);
    [0.2, 0.2, 0.35, 0.25].forEach((expected, index) => near(tiles[index][size], expected));
    next = resize(next, "root:1", 0.6);
    tiles = getTiles(next.displays[0]);
    [0.3, 0.3, 0.15, 0.25].forEach((expected, index) => near(tiles[index][size], expected));
    assertPartition(next.displays[0]);
  }
});

test("minimum-sized peers stop shrinking and the rest share the remaining change", () => {
  const state = fixture("columns", 4, true);
  state.displays[0].activeWindowId = 2;
  const weights = [0.25, 0.25, 0.09, 0.41];
  state.displays[0].layout = { axis: "x", weights, children: Array(4).fill(null) };
  const options = { anchorWindowId: 2, initialWeights: weights };
  let next = resize(state, "root:1", 0.5 + 100 / 1280, options);
  let tiles = getTiles(next.displays[0]);
  [320, 420, 96, 444].forEach((expected, index) => near(tiles[index].width * 1280, expected));
  next = resize(next, "root:1", 100, options);
  tiles = getTiles(next.displays[0]);
  [0.25, 0.6, 0.075, 0.075].forEach((expected, index) => near(tiles[index].width, expected));
  next = resize(next, "root:1", 0.5, options);
  assert.deepEqual(next.displays[0].layout.weights, weights);
  assertPartition(next.displays[0]);
});

test("spread limits use the whole compensating side and the target's own minimum", () => {
  const state = fixture("columns", 4, true);
  state.displays[0].activeWindowId = 2;
  const boundary = getBoundaries(state.displays[0], { spreadResize: true }).find((item) => item.id === "root:1");
  near(boundary.min, 0.25 + 96 / 1280);
  near(boundary.max, 1 - 2 * 96 / 1280);
  const next = resize(state, "root:1", -100);
  near(getTiles(next.displays[0])[0].width, 0.25);
  near(getTiles(next.displays[0])[1].width * 1280, 96);
  assert.ok(isValidState(next));
});

test("the toggle defaults on, persists, does not reflow, and survives arrangement reset", () => {
  assert.equal(createState().spreadResize, true);
  const state = fixture("columns", 4, true);
  state.displays[0].activeWindowId = 2;
  const custom = resize(state, "root:1", 0.6);
  const off = applyAction(custom, { type: "set-spread-resize", enabled: false });
  assert.deepEqual(off.displays, custom.displays);
  assert.equal(JSON.parse(JSON.stringify(off)).spreadResize, false);
  assert.equal(applyAction(off, { type: "reset" }).spreadResize, false);
  const old = fixture("columns");
  delete old.spreadResize;
  old.displays[0].activeWindowId = 2;
  near(getTiles(resize(old, "root:1", 0.6).displays[0])[3].width, 0.2);
  assert.equal(isValidState({ ...state, spreadResize: "yes" }), false);
  assert.deepEqual(applyAction(state, { type: "set-spread-resize", enabled: "yes" }), state);
});

test("spread resize has no effect on binary layouts", () => {
  const on = fixture("binary", 8, true);
  const off = { ...on, spreadResize: false };
  for (const boundary of getBoundaries(on.displays[0])) {
    assert.deepEqual(resize(on, boundary.id, 0.6).displays, resize(off, boundary.id, 0.6).displays);
  }
});

test("invalid drag snapshots and nonadjacent anchors are ignored", () => {
  const state = fixture("columns", 4, true);
  for (const options of [
    { initialWeights: [1, 0, 0, 0] }, { initialWeights: [0.5, 0.5] },
    { initialWeights: [0.1, 0.1, 0.1, 0.1] }, { anchorWindowId: 4 },
  ]) assert.deepEqual(resize(state, "root:1", 0.6, options), state);
});

test("dragging past the screen limits clamps the boundary to subtree minimum sizes", () => {
  for (const mode of ["binary", "columns", "horizontal"]) {
    let state = fixture(mode, 8);
    for (const boundary of getBoundaries(state.displays[0])) {
      state = resize(state, boundary.id, -100);
      state = resize(state, boundary.id, 100);
      assert.ok(isValidState(state));
      assertPartition(state.displays[0]);
    }
    for (const tile of getTiles(state.displays[0])) {
      assert.ok(tile.width * 1280 >= 96 - 1e-8);
      assert.ok(tile.height * 800 >= 64 - 1e-8);
    }
  }
});

test("crowded small displays relax the minimum instead of creating negative or missing tiles", () => {
  for (const mode of ["binary", "columns", "horizontal"]) {
    let state = fixture(mode, 40);
    state = applyAction(state, { type: "set-geometry", width: 320, height: 240 });
    for (const boundary of getBoundaries(state.displays[0])) {
      state = resize(state, boundary.id, 0.99);
      assertPartition(state.displays[0]);
      assert.ok(isValidState(state));
    }
  }
});

test("selection, swapping and rotation preserve custom slot geometry", () => {
  for (const mode of ["binary", "columns", "horizontal"]) {
    const state = resize(fixture(mode), "root:0", 0.4);
    const before = rects(state.displays[0]);
    for (const action of [
      { type: "select-window", id: 3 },
      { type: "focus", direction: "right" },
      { type: "move", direction: "right" },
      { type: "rotate", clockwise: true },
      { type: "rotate", clockwise: false },
    ]) {
      assert.deepEqual(rects(applyAction(state, action).displays[0]), before);
    }
  }
});

test("resizing is independent per display and persists in a JSON round trip", () => {
  const state = createState();
  const next = resize(state, "root:0", 0.65);
  assert.deepEqual(next.displays[1], state.displays[1]);
  const restored = JSON.parse(JSON.stringify(next));
  assert.ok(isValidState(restored));
  assert.deepEqual(rects(restored.displays[0]), rects(next.displays[0]));
});

test("selecting the same mode keeps proportions; switching mode starts an equal layout", () => {
  const state = resize(fixture(), "root:0", 0.65);
  assert.deepEqual(applyAction(state, { type: "set-layout", mode: "binary" }).displays, state.displays);
  const next = applyAction(state, { type: "set-layout", mode: "columns" });
  assert.deepEqual(rects(next.displays[0]), rects(fixture("columns").displays[0]));
});

test("adding and removing windows preserves available proportions and fills deleted slots", () => {
  for (const mode of ["binary", "columns", "horizontal"]) {
    let state = resize(fixture(mode), "root:0", 0.4);
    state = applyAction(state, { type: "add-window" });
    assert.ok(isValidState(state));
    assertPartition(state.displays[0]);
    if (mode === "binary") near(state.displays[0].layout.weights[0], 0.4);
    while (getActiveDisplay(state).windows.length) {
      state = applyAction(state, { type: "remove-window" });
      assert.ok(isValidState(state));
      assertPartition(state.displays[0]);
    }
    assert.equal(getBoundaries(state.displays[0]).length, 0);
    state = applyAction(state, { type: "add-window" });
    state = applyAction(state, { type: "add-window" });
    assert.ok(isValidState(state));
    assertPartition(state.displays[0]);
  }
  let state = resize(fixture("columns"), "root:0", 0.4);
  state = applyAction(state, { type: "select-window", id: 2 });
  state = applyAction(state, { type: "remove-window" });
  const tiles = getTiles(state.displays[0]);
  near(tiles[0].width, 0.4);
  near(tiles[1].width, 0.35);
  near(tiles[2].width, 0.25);
});

test("cross-display transfers preserve valid, fully occupied custom layouts", () => {
  for (const mode of ["binary", "columns", "horizontal"]) {
    let state = createState();
    state.displays.forEach((display) => { display.mode = mode; });
    state = resize(state, "root:0", 0.4);
    state = applyAction(state, { type: "resize-boundary", id: 2, boundaryId: "root:0", position: 0.6 });
    state = applyAction(state, { type: "select-display", id: 1 });
    for (let i = 0; i < 4; i++) state = applyAction(state, { type: "move", direction: "right" });
    assert.ok(isValidState(state));
    state.displays.forEach(assertPartition);
  }
});

test("bad boundaries, nonfinite positions and malformed stored layouts are rejected", () => {
  const state = fixture();
  for (const action of [
    { type: "resize-boundary", boundaryId: "unknown", position: 0.5 },
    { type: "resize-boundary", boundaryId: "root:0", position: Infinity },
    { type: "resize-boundary", boundaryId: "root:0", position: NaN },
    { type: "resize-boundary", id: 999, boundaryId: "root:0", position: 0.4 },
  ]) assert.deepEqual(applyAction(state, action), state);
  for (const layout of [
    null, {}, { axis: "x", weights: [1, 0], children: [null, null] },
    { axis: "x", weights: [0.4, 0.4], children: [null, null] },
  ]) {
    const invalid = structuredClone(state);
    invalid.displays[0].layout = layout;
    assert.equal(isValidState(invalid), false);
  }
});

test("mixed resizing, window lifecycle and layout changes always preserve a full partition", () => {
  let state = fixture();
  let seed = 429;
  const random = (max) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % max;
  };
  for (let i = 0; i < 1500; i++) {
    const display = getActiveDisplay(state);
    const boundaries = getBoundaries(display);
    const actions = [
      { type: "rotate" }, { type: "focus", direction: "left" },
      { type: "set-layout", mode: ["binary", "columns", "horizontal"][random(3)] },
      { type: "remove-window" },
      { type: "set-spread-resize", enabled: random(2) === 0 },
      { type: "set-geometry", width: 320 + random(1500), height: 240 + random(1000) },
    ];
    if (display.windows.length < 30) actions.push({ type: "add-window" });
    if (boundaries.length) actions.push({
      type: "resize-boundary", boundaryId: boundaries[random(boundaries.length)].id,
      position: random(160) / 100 - 0.3,
    });
    state = applyAction(state, actions[random(actions.length)]);
    assert.ok(isValidState(state), `Invalid state after step ${i}`);
    assertPartition(getActiveDisplay(state));
  }
});
