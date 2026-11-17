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
function setup(count = 4, configuration = {}) {
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
      get clientGeometry() { return { ...geometry }; },
      get output() {
        return workspace.screens.find((output) =>
          geometry.x + geometry.width / 2 >= output.geometry.x
          && geometry.x + geometry.width / 2 < output.geometry.x + output.geometry.width) || workspace.screens[0];
      },
      get active() { return workspace.activeWindow === this; },
      setMaximize(vertical, horizontal) { this.maximizeMode = (vertical ? 1 : 0) | (horizontal ? 2 : 0); this.maximizedChanged.emit(); },
    };
    for (const name of ["minimizedChanged", "fullScreenChanged", "desktopsChanged", "activitiesChanged",
      "maximizedChanged", "windowClassChanged", "tileChanged", "outputChanged", "frameGeometryChanged",
      "interactiveMoveResizeStarted", "interactiveMoveResizeStepped", "interactiveMoveResizeFinished"]) window[name] = signal();
    Object.assign(window, overrides);
    windows.push(window);
    if (notify) workspace.windowAdded.emit(window);
    return window;
  }
  for (let i = 0; i < count; i++) add({}, false);
  workspace.activeWindow = windows[0] || null;
  const host = { workspace, maximizeArea: 2, defer: (job) => jobs.push(job),
    config: (key, fallback) => configuration[key] ?? fallback, log: (message) => warnings.push(message) };
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
  const state = controller.getState();
  assert.ok(isValidState(state));
  const records = controller.inspect();
  for (const display of state.displays) {
    const frames = display.windows.map((id) => records.find((window) => window.id === id).geometry);
    if (!frames.length) continue;
    assert.equal(frames.reduce((sum, frame) => sum + frame.width * frame.height, 0), display.width * display.height);
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
  controller.perform({ type: "select-monitor", index: 0 });
  assert.equal(controller.getState().activeDisplayId, 1);
});

test("selecting an empty output remains locked to it until another explicit action", () => {
  const { controller } = setup();
  controller.perform({ type: "select-monitor", index: 1 });
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
  assert.ok(windows[2].frameGeometry.width >= 279);
  assert.ok(windows[3].frameGeometry.width >= 279);
  assertCovered(environment);
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

test("pause stops enforcement; restore returns original geometry and maximization without closing apps", () => {
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

test("restore preserves vertical-only and horizontal-only original maximization", () => {
  for (const maximizeMode of [1, 2, 3]) {
    const environment = setup(0);
    const window = environment.add({ maximizeMode });
    environment.flush();
    assert.equal(window.maximizeMode, 0);
    environment.controller.restore();
    assert.equal(window.maximizeMode, maximizeMode);
  }
});

test("generated KWin package bundles the same engine, registers current keys and omits mock add/remove", async () => {
  const directory = await mkdtemp("/tmp/opencode/kdetiler-package-");
  const { bundle } = await buildKWin(directory);
  const environment = setup();
  const shortcuts = new Map();
  let menu;
  class Timer {
    timeout = signal();
    start() { this.active = true; }
    stop() { this.active = false; }
  }
  const sandbox = {
    workspace: environment.workspace, KWin: { MaximizeArea: 2 }, QTimer: Timer,
    readConfig: (_, fallback) => fallback,
    registerShortcut: (id, text, keys, callback) => shortcuts.set(keys, { id, text, callback }),
    registerUserActionsMenu: (callback) => { menu = callback; },
    console: { log() {}, warn() {} },
  };
  vm.runInNewContext(bundle, sandbox);
  assert.equal(sandbox.KDETiler.isEnabled(), true);
  for (const key of ["Alt+B", "Alt+V", "Alt+H", "Alt+Left", "Alt+Shift+Left", "Alt+Shift+R",
    "Alt+Shift+E", "Alt+1", "Alt+0", "Meta+Ctrl+Alt+R", "Meta+Ctrl+Alt+P"]) assert.ok(shortcuts.has(key), key);
  assert.equal(shortcuts.has("Alt+R"), false);
  assert.equal(shortcuts.has("Alt+C"), false);
  assert.equal(shortcuts.has("Alt++"), false);
  assert.equal(shortcuts.has("Alt+-"), false);
  shortcuts.get("Alt+V").callback();
  assert.equal(sandbox.KDETiler.getState().displays[0].mode, "columns");
  assert.equal(menu().text, "KDETiler");
  const metadata = JSON.parse(await readFile(`${directory}/metadata.json`, "utf8"));
  assert.equal(metadata.KPlugin.EnabledByDefault, false);
});
