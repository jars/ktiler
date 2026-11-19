import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { mkdtemp, readFile } from "node:fs/promises";
import { createController } from "../kwin/adapter.js";
import { getActiveDisplay, isValidState } from "../engine.js";
import { buildKWin } from "../scripts/build-kwin.mjs";

function signal() {
  const callbacks = [];
  return { connect: (callback) => callbacks.push(callback), emit: (...args) => callbacks.forEach((callback) => callback(...args)) };
}
function setup(initial = 4, configuration = {}, hostOverrides = {}) {
  const jobs = [];
  const warnings = [];
  const desktop = { id: "desktop-1" };
  const screens = [
    { name: "DP-1", geometry: { x: 0, y: 0, width: 1280, height: 800 }, geometryChanged: signal() },
    { name: "DP-2", geometry: { x: 1280, y: 0, width: 1280, height: 800 }, geometryChanged: signal() },
  ];
  const windows = [];
  const workspace = {
    screens, currentDesktop: desktop, currentActivity: "", activeWindow: null,
    get screenOrder() { return this.screens; },
    windowList: () => windows,
    clientArea: (_, output) => output.workArea || output.geometry,
    raiseWindow: () => {},
  };
  for (const name of ["windowAdded", "windowRemoved", "windowActivated", "screensChanged", "screenOrderChanged",
    "virtualScreenGeometryChanged", "currentDesktopChanged", "currentActivityChanged"]) workspace[name] = signal();
  function add(overrides = {}, notify = true) {
    let geometry = { x: 50, y: 60, width: 420, height: 300 };
    const window = {
      internalId: `window-${windows.length + 1}`, caption: `Test ${windows.length + 1}`,
      normalWindow: true, managed: true, resizeable: true, moveable: true,
      minimized: false, fullScreen: false, deleted: false, desktops: [desktop], activities: [],
      tile: null, maximizeMode: 0, resize: false,
      minSize: { width: 80, height: 60 }, maxSize: { width: 100000, height: 100000 },
      get frameGeometry() { return { ...geometry }; },
      set frameGeometry(value) { geometry = { ...value }; this.frameGeometryChanged.emit(); },
      get clientGeometry() { return { ...geometry, height: geometry.height - (this.decorationHeight ?? 0) }; },
      get output() {
        return workspace.screens.find((output) =>
           geometry.x + geometry.width / 2 >= output.geometry.x
          && geometry.x + geometry.width / 2 < output.geometry.x + output.geometry.width
          && geometry.y + geometry.height / 2 >= output.geometry.y
          && geometry.y + geometry.height / 2 < output.geometry.y + output.geometry.height) || workspace.screens[0];
      },
      get active() { return workspace.activeWindow === this; },
      setMaximize() { assert.fail("ktiler must not change native maximization"); },
    };
    for (const name of ["minimizedChanged", "fullScreenChanged", "desktopsChanged", "activitiesChanged",
      "maximizedAboutToChange", "maximizedChanged", "maximizeableChanged", "windowClassChanged", "tileChanged",
      "outputChanged", "frameGeometryChanged",
      "interactiveMoveResizeStarted", "interactiveMoveResizeStepped", "interactiveMoveResizeFinished"]) window[name] = signal();
    Object.assign(window, overrides);
    windows.push(window);
    if (notify) workspace.windowAdded.emit(window);
    return window;
  }
  for (const overrides of Array.isArray(initial) ? initial : Array.from({ length: initial }, () => ({}))) add(overrides, false);
  workspace.activeWindow = windows[0] || null;
  const host = { workspace, maximizeArea: 2, defer: (job) => jobs.push(job),
    config: (key, fallback) => configuration[key] ?? fallback, log: (message) => warnings.push(message),
    ...hostOverrides };
  const controller = createController(host);
  function flush() {
    let steps = 0;
    while (jobs.length) {
      assert.ok(++steps < 100, "Geometry reconciliation loop");
      jobs.shift()();
    }
  }
  function activate(window) { workspace.activeWindow = window; workspace.windowActivated.emit(window); }
  return { host, workspace, windows, controller, jobs, warnings, add, flush, activate };
}
function assertCovered(environment) {
  const { controller } = environment;
  assert.ok(isValidState(controller.getState()));
  const state = controller.getEffectiveState();
  const records = controller.inspect();
  for (const display of state.displays) {
    const frames = display.windows.map((id) => records.find((window) => window.id === id).geometry);
    if (!frames.length) continue;
    assert.equal(frames.reduce((sum, frame) => sum + frame.width * frame.height, 0), display.width * display.height);
    for (const frame of frames) {
      assert.ok(frame.x >= display.x && frame.y >= display.y);
      assert.ok(frame.x + frame.width <= display.x + display.width && frame.y + frame.height <= display.y + display.height);
    }
    for (let i = 0; i < frames.length; i++) for (let j = i + 1; j < frames.length; j++) {
      const a = frames[i], b = frames[j];
      assert.ok(Math.min(a.x + a.width, b.x + b.width) <= Math.max(a.x, b.x)
        || Math.min(a.y + a.height, b.y + b.height) <= Math.max(a.y, b.y), "Windows overlap");
    }
  }
}

test("KWin adapter tiles windows using usable output areas and leaves built-in tile layouts alone", () => {
  const environment = setup();
  assertCovered(environment);
  environment.workspace.screens[0].workArea = { x: 0, y: 30, width: 1280, height: 770 };
  environment.workspace.screens[0].geometryChanged.emit();
  environment.flush();
  assertCovered(environment);
  assert.equal(environment.controller.getState().displays[0].y, 30);
});

test("KWin adapter filters dialogs, fixed-size windows, fullscreen and unrelated desktops", () => {
  const environment = setup(0);
  environment.add({ dialog: true });
  environment.add({ resizeable: false });
  environment.add({ fullScreen: true });
  environment.add({ desktops: [{ id: "another-desktop" }] });
  environment.add({ activities: ["another-activity"] });
  environment.add();
  environment.flush();
  assert.equal(environment.controller.getState().displays[0].windows.length, 1);
  assertCovered(environment);
});

test("newly activated windows are selected even when activation arrives before reconciliation", () => {
  const environment = setup(2);
  const window = environment.add();
  environment.activate(window);
  environment.flush();
  const active = getActiveDisplay(environment.controller.getState());
  const id = environment.controller.inspect().find((record) => record.caption === window.caption).id;
  assert.equal(active.activeWindowId, id);
  assertCovered(environment);
});

test("KWin adapter reflows on close, minimize, restore and fullscreen changes", () => {
  const environment = setup();
  const { windows, workspace, controller, flush } = environment;
  windows[0].minimized = true;
  windows[0].minimizedChanged.emit();
  flush();
  assert.equal(controller.getState().displays[0].windows.length, 3);
  assertCovered(environment);
  windows[0].minimized = false;
  windows[0].minimizedChanged.emit();
  flush();
  windows[1].fullScreen = true;
  windows[1].fullScreenChanged.emit();
  flush();
  assert.equal(controller.getState().displays[0].windows.length, 3);
  windows[1].fullScreen = false;
  windows[1].fullScreenChanged.emit();
  flush();
  windows.pop().deleted = true;
  workspace.windowRemoved.emit();
  flush();
  assert.equal(controller.getState().displays[0].windows.length, 3);
  assertCovered(environment);
});

test("KWin adapter uses shared focus, swapping, rotation and cross-output transfer rules", () => {
  const environment = setup();
  const { controller } = environment;
  controller.perform({ type: "focus", direction: "right" });
  assert.equal(getActiveDisplay(controller.getState()).activeWindowId, 3);
  controller.perform({ type: "move", direction: "right" });
  const state = controller.getState();
  assert.equal(state.activeDisplayId, 2);
  assert.deepEqual(state.displays[1].windows, [3]);
  controller.perform({ type: "rotate" });
  assertCovered(environment);
  controller.perform({ type: "select-display", id: 1 });
  assert.equal(controller.getState().activeDisplayId, 1);
});

test("selecting an empty output remains locked to it until another explicit action", () => {
  const { controller } = setup();
  controller.perform({ type: "select-display", id: 2 });
  controller.reconcile();
  assert.equal(controller.getState().activeDisplayId, 2);
  controller.perform({ type: "set-layout", mode: "horizontal" });
  assert.equal(controller.getState().displays[1].mode, "horizontal");
  assert.equal(controller.getState().displays[0].mode, "binary");
});

test("live native resize signals preserve the fixed side and reverse from the same baseline", () => {
  for (const mode of ["columns", "horizontal"]) {
    const environment = setup(4, { DefaultLayout: mode });
    const { controller, windows } = environment;
    const window = windows[1];
    window.resize = true;
    window.interactiveMoveResizeStarted.emit();
    const before = window.frameGeometry;
    const requested = (delta) => ({ ...before,
      width: before.width + (mode === "columns" ? delta : 0),
      height: before.height + (mode === "horizontal" ? delta : 0) });
    window.interactiveMoveResizeStepped.emit(requested(60));
    const dimension = mode === "columns" ? "width" : "height";
    const original = mode === "columns" ? 320 : 200;
    assert.deepEqual(windows.map((item) => item.frameGeometry[dimension]), [original, original + 60, original - 30, original - 30]);
    window.interactiveMoveResizeStepped.emit(requested(-40));
    assert.deepEqual(windows.map((item) => item.frameGeometry[dimension]), [original, original - 40, original + 20, original + 20]);
    window.resize = false;
    window.interactiveMoveResizeFinished.emit();
    environment.flush();
    assertCovered(environment);
    assert.equal(controller.diagnostics().interacting, false);
  }
});

test("application minimum sizes constrain resizing before a neighbor becomes too small", () => {
  const environment = setup(4, { DefaultLayout: "columns" });
  const { windows } = environment;
  windows[2].minSize = { width: 280, height: 60 };
  windows[3].minSize = { width: 280, height: 60 };
  windows[1].resize = true;
  windows[1].interactiveMoveResizeStarted.emit();
  windows[1].interactiveMoveResizeStepped.emit({ ...windows[1].frameGeometry, width: 900 });
  assert.ok(windows[2].frameGeometry.width >= 280);
  assert.ok(windows[3].frameGeometry.width >= 280);
  assertCovered(environment);
});

test("a terminal can transfer up into the System Settings column without squeezing its client below 650px", () => {
  const environment = setup(0);
  const { workspace, controller, add, flush, activate } = environment;
  workspace.screens[0].geometry = { x: 0, y: 0, width: 1920, height: 1080 };
  workspace.screens[1].geometry = { x: 0, y: 1080, width: 1920, height: 1080 };
  const settings = add({ minSize: { width: 930, height: 650 }, decorationHeight: 28 });
  const chrome = add({ minSize: { width: 500, height: 121 } });
  const terminal = add({ frameGeometry: { x: 50, y: 1100, width: 420, height: 300 },
    minSize: { width: 150, height: 150 } });
  flush();
  const chromeBefore = chrome.frameGeometry;
  const requests = [];
  const accessor = Object.getOwnPropertyDescriptor(settings, "frameGeometry");
  Object.defineProperty(settings, "frameGeometry", {
    ...accessor,
    set(value) { requests.push(value.height); accessor.set.call(this, value); },
  });
  activate(terminal);
  controller.perform({ type: "move", direction: "up" });
  flush();
  assert.equal(controller.getState().displays[0].mode, "binary");
  assert.deepEqual(settings.frameGeometry, { x: 0, y: 0, width: 960, height: 678 });
  assert.deepEqual(terminal.frameGeometry, { x: 0, y: 678, width: 960, height: 402 });
  assert.deepEqual(chrome.frameGeometry, chromeBefore);
  assert.deepEqual(requests, [678], "must not ask the app to try an undersized tile");
  assert.deepEqual(environment.warnings, []);
  assertCovered(environment);
});

test("columns distribute spare space around both minimums and maximums and restore equal splits when limits relax", () => {
  const environment = setup(4, { DefaultLayout: "columns" });
  const { controller, windows, flush } = environment;
  windows[0].minSize.width = 500;
  windows[1].maxSize.width = 200;
  controller.reconcile();
  assert.equal(controller.getState().displays[0].mode, "columns");
  assert.deepEqual(windows.map((window) => window.frameGeometry.width), [500, 200, 290, 290]);
  assertCovered(environment);
  windows[0].minSize.width = 80;
  windows[1].maxSize.width = 100000;
  windows[1].maximizeableChanged.emit();
  flush();
  assert.deepEqual(windows.map((window) => window.frameGeometry.width), [320, 320, 320, 320]);
  assertCovered(environment);
});

test("custom proportions survive automatic fitting, and dragging starts at the visible boundary", () => {
  const environment = setup(4);
  const { controller, windows, flush } = environment;
  const drag = (window, width, height) => {
    window.resize = true;
    window.interactiveMoveResizeStarted.emit();
    window.interactiveMoveResizeStepped.emit({ ...window.frameGeometry,
      width: window.frameGeometry.width + width, height: window.frameGeometry.height + height });
    window.interactiveMoveResizeFinished.emit();
    window.resize = false;
    flush();
  };
  drag(windows[0], 0, 50);
  assert.equal(windows[0].frameGeometry.height, 450);
  windows[0].minSize.height = 540;
  controller.reconcile();
  assert.equal(windows[0].frameGeometry.height, 540);

  // Enlarge the left column using its top window; do not save the unrelated
  // vertical adjustment made automatically to honor that window's minimum.
  drag(windows[0], 50, 0);
  assert.equal(windows[0].frameGeometry.width, 690);
  assert.equal(windows[0].frameGeometry.height, 540);
  // Drag away from the constrained boundary using the bottom tile's top edge.
  windows[1].resize = true;
  windows[1].interactiveMoveResizeStarted.emit();
  const below = windows[1].frameGeometry;
  windows[1].interactiveMoveResizeStepped.emit({ ...below, y: below.y + 30, height: below.height - 30 });
  assert.equal(windows[0].frameGeometry.height, 570);
  windows[1].interactiveMoveResizeStepped.emit(below);
  windows[1].interactiveMoveResizeFinished.emit();
  flush();
  windows[0].minSize.height = 60;
  controller.reconcile();
  assert.equal(windows[0].frameGeometry.width, 690);
  assert.equal(windows[0].frameGeometry.height, 450);
  assertCovered(environment);
});

test("an unsatisfiable layout falls back to a fitting layout automatically", () => {
  // The minima sum to 1400px in columns; binary can stack two 700px windows.
  const environment = setup(3, { DefaultLayout: "columns" });
  environment.windows[0].minSize.width = 700;
  environment.windows[1].minSize.width = 620;
  environment.controller.reconcile();
  const display = environment.controller.getState().displays.find((item) => item.windows.length === 3);
  assert.equal(display.mode, "binary");
  assertCovered(environment);
  const switched = environment.warnings.find((message) => message.includes("switched from columns to binary"));
  assert.ok(switched, "missing automatic fallback diagnostic");
  assert.ok(!environment.warnings.join("\n").includes("Test 1"), "window caption leaked into default diagnostics");
});

test("debug mode appends captions and size limits but automatic layout fallback gives no user feedback", () => {
  const feedback = [];
  const environment = setup(3, { DefaultLayout: "columns" }, { debug: true, feedback: (...args) => feedback.push(args) });
  environment.windows[0].minSize.width = 700;
  environment.windows[1].minSize.width = 620;
  environment.controller.reconcile();
  const debugLine = environment.warnings.find((message) => message.includes("switched from columns to binary"));
  assert.ok(debugLine?.includes('"Test 1" needs 700×60'), "debug diagnostic lacks caption/constraints");
  assert.deepEqual(feedback, []);
});

test("when no layout can fit, windows keep their geometry and the diagnostic stays caption-free", () => {  const environment = setup(2, { DefaultLayout: "columns" });
  const before = environment.windows.map((window) => window.frameGeometry);
  environment.windows[0].minSize = { width: 2000, height: 60 };
  environment.controller.reconcile();
  const display = environment.controller.getState().displays.find((item) => item.windows.length === 2);
  assert.equal(display.mode, "columns", "mode must not change when nothing fits");
  assert.deepEqual(environment.windows.map((window) => window.frameGeometry), before);
  assert.ok(environment.warnings.some((message) => message.includes("Cannot tile output")), "missing cannot-tile diagnostic");
  assert.ok(!environment.warnings.join("\n").includes('"Test'), "caption leaked into default diagnostics");
});

test("outer-edge resize attempts and free dragging cannot leave unused desktop space", () => {
  const environment = setup(4, { DefaultLayout: "columns" });
  const window = environment.windows[0];
  const before = window.frameGeometry;
  window.resize = true;
  window.interactiveMoveResizeStarted.emit();
  window.interactiveMoveResizeStepped.emit({ ...before, x: before.x + 100, width: before.width - 100 });
  assert.deepEqual(window.frameGeometry, before);
  window.interactiveMoveResizeFinished.emit();
  window.resize = false;
  window.interactiveMoveResizeStarted.emit();
  window.interactiveMoveResizeStepped.emit({ ...before, x: before.x + 200 });
  window.interactiveMoveResizeFinished.emit();
  environment.flush();
  assertCovered(environment);
});

test("layout state is isolated per virtual desktop and survives switching back", () => {
  const environment = setup();
  const { workspace, controller } = environment;
  controller.perform({ type: "set-layout", mode: "columns" });
  const original = controller.getState().displays;
  workspace.currentDesktop = { id: "desktop-2" };
  workspace.currentDesktopChanged.emit();
  environment.flush();
  environment.add({ desktops: [workspace.currentDesktop] });
  environment.flush();
  controller.perform({ type: "set-layout", mode: "horizontal" });
  assert.equal(controller.getState().displays[0].mode, "horizontal");
  workspace.currentDesktop = { id: "desktop-1" };
  workspace.currentDesktopChanged.emit();
  environment.flush();
  assert.deepEqual(controller.getState().displays, original);
  assertCovered(environment);
});

test("output removal redistributes windows rather than losing their identities", () => {
  const environment = setup();
  environment.controller.perform({ type: "focus", direction: "right" });
  environment.controller.perform({ type: "move", direction: "right" });
  environment.workspace.screens = environment.workspace.screens.slice(0, 1);
  environment.workspace.screensChanged.emit();
  environment.flush();
  assert.equal(environment.controller.getState().displays.length, 1);
  assert.equal(environment.controller.getState().displays[0].windows.length, 4);
  assertCovered(environment);
});

test("pause stops enforcement; restore returns tiled windows to their original geometry", () => {
  const environment = setup(2);
  const { controller, windows } = environment;
  controller.perform({ type: "pause" });
  windows[0].frameGeometry = { x: 100, y: 200, width: 350, height: 250 };
  environment.flush();
  assert.equal(windows[0].frameGeometry.width, 350);
  controller.perform({ type: "pause" });
  assertCovered(environment);
  controller.restore();
  environment.flush();
  assert.equal(controller.isEnabled(), false);
  windows.forEach((window) => assert.deepEqual(window.frameGeometry, { x: 50, y: 60, width: 420, height: 300 }));
  assert.equal(windows.length, 2);
});

test("a constraint-incompatible layout emits a diagnostic instead of fighting the application", () => {
  const environment = setup();
  environment.windows[0].minSize = { width: 5000, height: 60 };
  environment.controller.reconcile();
  assert.match(environment.warnings[0], /size limits/);
  assert.equal(environment.controller.isEnabled(), true);
});

test("a transfer that no destination layout can fit is rejected without changing anything", () => {
  const feedback = [];
  const environment = setup(3, {}, { feedback: (...args) => feedback.push(args) });
  const { windows } = environment;
  windows[0].minSize = { width: 700, height: 450 };
  environment.activate(windows[2]);
  environment.controller.perform({ type: "move", direction: "right" });
  environment.flush();
  windows[2].minSize = { width: 700, height: 450 };
  environment.controller.reconcile();
  const before = environment.controller.getState();
  const frames = windows.map((window) => window.frameGeometry);
  // Both windows fit alone, but cannot share 1280×800 side by side or stacked.
  environment.activate(windows[2]);
  environment.controller.perform({ type: "move", direction: "left" });
  environment.flush();
  const after = environment.controller.getState();
  assert.deepEqual(after.displays.map((display) => display.windows),
    before.displays.map((display) => display.windows), "state must stay exactly as it was");
  assert.deepEqual(windows.map((window) => window.frameGeometry), frames);
  assert.ok(environment.warnings.some((message) => message.includes("Cannot complete that move")),
    "missing move rejection diagnostic");
  assert.ok(!environment.warnings.join("\n").includes('"Test'), "caption leaked into default diagnostics");
  assert.deepEqual(feedback, [["ktiler: move blocked because a window has dimension constraints."]]);
  environment.controller.perform({ type: "move", direction: "left" });
  assert.equal(feedback.length, 1, "repeated key presses should not spam feedback");
});

test("a move that a window persistently refuses is rolled back to the previous arrangement", () => {
  const feedback = [];
  const environment = setup(3, {}, { feedback: (...args) => feedback.push(args) });
  const { windows, jobs } = environment;
  environment.activate(windows[2]);
  environment.controller.perform({ type: "move", direction: "right" });
  environment.flush();
  // Window 1 refuses every geometry change from now on, staying at its current tile.
  const fixed = { ...windows[0].frameGeometry };
  Object.defineProperty(windows[0], "frameGeometry", {
    configurable: true,
    get: () => ({ ...fixed }),
    set() { jobs.push(() => windows[0].frameGeometryChanged.emit()); },
  });
  environment.activate(windows[2]);
  environment.controller.perform({ type: "move", direction: "left" });
  environment.flush();
  const state = environment.controller.getState();
  assert.equal(state.displays.find((display) => display.windows.length === 1).windows.length, 1,
    "the refused move was not rolled back");
  assert.deepEqual(windows[0].frameGeometry, fixed, "the refusing window must not be fought");
  assert.ok(environment.warnings.some((message) => message.includes("undone")), "missing undo diagnostic");
  assert.deepEqual(feedback, [["Move undone: a window didn't accept its new size."]]);
  assertCovered(environment);
});

test("fully and partially maximized windows at startup are untouched until unmaximized", () => {
  for (const maximizeMode of [1, 2, 3]) {
    const environment = setup([{ maximizeMode }, {}]);
    const { controller, windows: [window], flush } = environment;
    const [maximized] = controller.inspect();
    assert.equal(window.maximizeMode, maximizeMode);
    assert.deepEqual(window.frameGeometry, { x: 50, y: 60, width: 420, height: 300 });
    assert.equal(controller.getState().displays[0].windows.length, 1);
    assert.ok(!controller.getState().displays[0].windows.includes(maximized.id));
    assertCovered(environment);

    window.maximizeMode = 0;
    window.maximizedChanged.emit();
    flush();
    assert.equal(controller.getState().displays[0].activeWindowId, maximized.id);
    assert.equal(controller.getState().displays[0].windows.length, 2);
    assertCovered(environment);
  }
});

test("maximize yields before the Wayland commit and restores to tiling only after the unmaximize commit", () => {
  const environment = setup(3);
  const { controller, workspace, windows, activate, flush } = environment;
  const window = windows[1];
  const id = controller.inspect().find((record) => record.caption === window.caption).id;
  activate(window);
  const tiled = window.frameGeometry;
  window.interactiveMoveResizeStarted.emit();
  assert.equal(controller.diagnostics().interacting, true);

  window.maximizedAboutToChange.emit(3);
  flush();
  assert.equal(controller.diagnostics().interacting, false, "a drag must not block the maximize reflow");
  assert.equal(window.maximizeMode, 0);
  assert.deepEqual(window.frameGeometry, tiled, "pending maximization must not receive new geometry");
  assert.equal(controller.getState().displays[0].windows.length, 2);
  assertCovered(environment);

  window.maximizeMode = 3;
  window.frameGeometry = workspace.screens[0].geometry;
  window.maximizedChanged.emit();
  flush();
  const withoutMaximized = controller.getState();

  window.maximizedAboutToChange.emit(0);
  flush();
  assert.deepEqual(controller.getState(), withoutMaximized);
  assert.deepEqual(window.frameGeometry, workspace.screens[0].geometry);
  window.frameGeometry = { ...tiled, x: tiled.x + 1280 };
  window.maximizeMode = 0;
  window.maximizedChanged.emit();
  flush();
  assert.deepEqual(controller.getState().displays[1].windows, [id], "rejoin on the actual monitor");
  assert.equal(getActiveDisplay(controller.getState()).activeWindowId, id);
  assert.equal(workspace.activeWindow, window);
  assertCovered(environment);
});

test("a focused maximized window moves from its actual monitor without moving any tiles", () => {
  const feedback = [];
  const environment = setup([{ maximizeMode: 1 }, {}, {}], {}, { feedback: (message) => feedback.push(message) });
  const { controller, workspace, windows: [window, ...tiles], activate, flush } = environment;
  activate(tiles[1]);
  controller.perform({ type: "move", direction: "right" });
  activate(window);
  flush();
  const before = controller.getState();
  assert.equal(before.activeDisplayId, before.displays[1].id, "tile selection remains on the other monitor");
  const frames = tiles.map((tile) => tile.frameGeometry);
  const transfers = [];
  workspace.sendClientToScreen = (target, output) => {
    transfers.push([target, output]);
    target.frameGeometry = { ...target.frameGeometry, x: output.geometry.x };
  };

  controller.perform({ type: "move", direction: "right" });
  flush();
  assert.deepEqual(transfers, [[window, workspace.screens[1]]]);
  assert.equal(window.maximizeMode, 1);
  assert.equal(workspace.activeWindow, window);
  assert.equal(window.output, workspace.screens[1]);
  assert.deepEqual(tiles.map((tile) => tile.frameGeometry), frames);
  assert.deepEqual(controller.getState(), before);
  assert.deepEqual(feedback, []);

  controller.perform({ type: "move", direction: "right" });
  controller.perform({ type: "move", direction: "right" });
  assert.equal(transfers.length, 1, "do not wrap across outputs");
  assert.deepEqual(feedback, ["ktiler: no monitor to the right."]);
  assert.equal(workspace.activeWindow, window);
  assert.deepEqual(controller.getState(), before);
});

test("transferring a tile restores the front maximized window and includes it with the other destination tiles", () => {
  const environment = setup([{ maximizeMode: 3 }, {}, {}, {}], { DefaultLayout: "columns" });
  const { controller, workspace, windows: [maximized, left, incoming, resident], activate, flush } = environment;
  maximized.frameGeometry = workspace.screens[1].geometry;
  activate(resident);
  controller.perform({ type: "move", direction: "right" });
  assert.equal(resident.output, workspace.screens[1]);

  workspace.stackingOrder = [resident, left, incoming, maximized];
  let requests = 0;
  maximized.setMaximize = (vertical, horizontal) => {
    assert.deepEqual([vertical, horizontal], [false, false]);
    requests++;
    maximized.maximizedAboutToChange.emit(0);
  };
  activate(incoming);
  controller.perform({ type: "move", direction: "right" });
  assert.equal(requests, 1);
  assert.equal(incoming.output, workspace.screens[0], "wait for KWin to finish unmaximizing");
  assert.equal(maximized.maximizeMode, 3);
  maximized.maximizeMode = 0;
  maximized.maximizedChanged.emit();
  flush();
  assert.equal(workspace.activeWindow, incoming);
  assert.equal(incoming.output, workspace.screens[1]);
  assert.equal(incoming.maximizeMode, 0);
  assert.equal(maximized.maximizeMode, 0);
  assert.equal(controller.getState().displays[1].windows.length, 3);
  assertCovered(environment);
});

test("a move that cannot fit with the maximized window leaves both windows alone", () => {
  const feedback = [];
  const environment = setup([{ maximizeMode: 3 }, {}], {}, { feedback: (message) => feedback.push(message) });
  const { controller, workspace, windows: [maximized, incoming], activate, flush } = environment;
  maximized.frameGeometry = workspace.screens[1].geometry;
  workspace.stackingOrder = [incoming, maximized];
  for (const window of [maximized, incoming]) window.minSize = { width: 700, height: 450 };
  activate(incoming);
  flush();
  const before = controller.getState();
  const frames = [maximized.frameGeometry, incoming.frameGeometry];

  controller.perform({ type: "move", direction: "right" });
  flush();
  assert.deepEqual(controller.getState(), before);
  assert.deepEqual([maximized.frameGeometry, incoming.frameGeometry], frames);
  assert.equal(maximized.maximizeMode, 3);
  assert.equal(workspace.activeWindow, incoming);
  assert.deepEqual(feedback, ["ktiler: move blocked because a window has dimension constraints."]);
});

test("if restored window limits rule out tiling, recover its original partial maximization", () => {
  const feedback = [];
  const environment = setup([{ maximizeMode: 1 }, {}], {}, { feedback: (message) => feedback.push(message) });
  const { controller, workspace, windows: [maximized, incoming], activate, flush } = environment;
  maximized.frameGeometry = { ...workspace.screens[1].geometry, width: 640 };
  workspace.stackingOrder = [incoming, maximized];
  incoming.minSize = { width: 700, height: 450 };
  const requests = [];
  maximized.setMaximize = (vertical, horizontal) => {
    requests.push([vertical, horizontal]);
    maximized.maximizeMode = (vertical ? 1 : 0) | (horizontal ? 2 : 0);
    maximized.minSize = { width: 700, height: 450 };
    maximized.maximizedChanged.emit();
  };
  activate(incoming);
  flush();
  const before = controller.getState();
  const frames = [maximized.frameGeometry, incoming.frameGeometry];
  controller.perform({ type: "move", direction: "right" });
  flush();

  assert.deepEqual(requests, [[false, false], [true, false]]);
  assert.deepEqual(controller.getState(), before);
  assert.deepEqual([maximized.frameGeometry, incoming.frameGeometry], frames);
  assert.equal(maximized.maximizeMode, 1);
  assert.equal(workspace.activeWindow, incoming);
  assert.deepEqual(feedback, ["ktiler: move blocked because a window has dimension constraints."]);
});

test("restore and pause leaves a currently maximized window alone", () => {
  const environment = setup(2);
  const { controller, workspace, windows: [window, other], flush } = environment;
  window.maximizedAboutToChange.emit(3);
  window.maximizeMode = 3;
  window.frameGeometry = workspace.screens[0].geometry;
  window.maximizedChanged.emit();
  flush();
  controller.restore();
  assert.equal(controller.isEnabled(), false);
  assert.equal(window.maximizeMode, 3);
  assert.deepEqual(window.frameGeometry, workspace.screens[0].geometry);
  assert.deepEqual(other.frameGeometry, { x: 50, y: 60, width: 420, height: 300 });
});

test("generated KWin package bundles the same engine, registers current keys and omits mock add/remove", async () => {
  const directory = await mkdtemp("/tmp/opencode/ktiler-package-");
  const { bundle } = await buildKWin(directory);
  const environment = setup();
  const shortcuts = new Map();
  const released = new Map();
  const popups = [];
  let menu;
  let config = {};
  class Timer {
    timeout = signal();
    start() { this.active = true; }
    stop() { this.active = false; }
  }
  const sandbox = {
    workspace: environment.workspace, KWin: { MaximizeArea: 2 }, QTimer: Timer,
    readConfig: (key, fallback) => config[key] ?? fallback,
    callDBus(service, object, iface, method, ...args) {
      if (method === "unregister") {
        assert.deepEqual([service, object, iface, args[0]],
          ["org.kde.kglobalaccel", "/kglobalaccel", "org.kde.KGlobalAccel", "kwin"]);
        released.set(args[1], args[2]);
      } else popups.push({ service, object, iface, method, args });
    },
    registerShortcut: (id, text, keys, callback) => shortcuts.set(keys, { id, text, callback }),
    registerUserActionsMenu: (callback) => { menu = callback; },
    console: { log() {}, warn() {} },
  };
  vm.runInNewContext(bundle, sandbox);
  assert.equal(shortcuts.size, 0, "wait for KDE to release all old shortcuts");
  for (const acknowledge of released.values()) acknowledge();
  assert.equal(sandbox.ktiler.isEnabled(), true);
  assert.deepEqual([...shortcuts.keys()].sort(), ["Alt+B", "Alt+\\", "Alt+-", "Alt+Shift+R", "Alt+Shift+E",
    ...["W", "A", "S", "D"].flatMap((key) => [`Alt+${key}`, `Alt+Shift+${key}`])].sort());
  for (const id of ["Monitor-1", "Monitor-10", "Pause", "Restore", "SpreadResize"]) assert.ok(released.has(`ktiler-${id}`));
  const schema = await readFile(`${directory}/contents/config/main.xml`, "utf8");
  for (const [keys, { id }] of shortcuts) {
    const setting = `Shortcut${id.slice(7).replace(/-(\w)/g, (_, letter) => letter.toUpperCase())}`;
    assert.ok(schema.includes(`<entry name="${setting}" type="String"><default>${keys}</default></entry>`), id);
  }
  shortcuts.get("Alt+\\").callback();
  assert.equal(sandbox.ktiler.getState().displays[0].mode, "columns");
  const windows = environment.windows;
  sandbox.ktiler.perform({ type: "select-window", id: 4 });
  shortcuts.get("Alt+Shift+D").callback();
  assert.deepEqual(popups, [], "successful move should stay quiet");
  environment.workspace.screens[1].workArea = { x: 1280, y: 0, width: 1500, height: 800 };
  windows[3].minSize.width = 1400;
  shortcuts.get("Alt+Shift+A").callback();
  assert.deepEqual(popups, [{ service: "org.kde.plasmashell", object: "/org/kde/osdService", iface: "org.kde.osdService",
    method: "showText", args: ["ktiler", "ktiler: move blocked because a window has dimension constraints."] }]);
  assert.equal(menu().text, "ktiler");
  menu().items[0].triggered();
  assert.equal(sandbox.ktiler.isEnabled(), false);
  menu().items[0].triggered();
  assert.equal(sandbox.ktiler.isEnabled(), true);
  menu().items[1].triggered();
  assert.equal(sandbox.ktiler.isEnabled(), false);

  config = { ShortcutFocusLeft: "Meta+J", ShortcutLayoutColumns: "", ShortcutRotateClockwise: "Ctrl+Alt+F8" };
  shortcuts.clear();
  released.clear();
  vm.runInNewContext(bundle, sandbox);
  for (const acknowledge of released.values()) acknowledge();
  assert.equal(shortcuts.get("Meta+J").id, "ktiler-Focus-Left");
  assert.equal(shortcuts.get("Ctrl+Alt+F8").id, "ktiler-RotateClockwise");
  for (const replaced of ["Alt+A", "Alt+\\", "Alt+Shift+R"]) assert.ok(!shortcuts.has(replaced), replaced);
  assert.equal(shortcuts.size, 12);
  const metadata = JSON.parse(await readFile(`${directory}/metadata.json`, "utf8"));
  assert.equal(metadata.KPlugin.EnabledByDefault, false);
});
