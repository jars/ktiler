import assert from "node:assert/strict";
import { spawn, execFile, execFileSync } from "node:child_process";
import { cp, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildKWin } from "./build-kwin.mjs";
import { installKWin, planInstallation } from "./install-kwin.mjs";
import { reloadKWin } from "./dev-reload-kwin.mjs";
import { getTiles } from "../engine.js";

if (process.env.KTILER_ISOLATED !== "1" || !process.env.KTILER_TEST_ROOT
  || !process.env.XDG_RUNTIME_DIR.startsWith(`${process.env.KTILER_TEST_ROOT}/`)) {
  throw new Error("Refusing to test on the desktop session");
}
const directory = process.env.KTILER_TEST_ROOT;
const exec = promisify(execFile);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const dbus = async (service, object, ...args) =>
  (await exec("qdbus6", [service, object, ...args], { timeout: 4000 })).stdout.trim();
const run = (command, args) => execFileSync(command, args, { encoding: "utf8", timeout: 10000 }).trim();
const built = await buildKWin(path.join(directory, "package"));
// Seed an older installation before KWin discovers its installed scripts.
const previous = path.join(directory, "previous-package");
await cp(built.directory, previous, { recursive: true });
const previousMetadata = path.join(previous, "metadata.json");
const metadata = JSON.parse(await readFile(previousMetadata, "utf8"));
metadata.KPlugin.Version = "0.1.0";
await writeFile(previousMetadata, JSON.stringify(metadata));
await writeFile(path.join(previous, "contents/code/main.js"), 'console.log("[ktiler dev test] old script loaded");');
await installKWin(await planInstallation(previous), { run });
const kwin = spawn("kwin_wayland", [
  "--virtual", "--no-lockscreen", "--no-kactivities",
  "--socket", "ktiler-test", "--width", "1280", "--height", "800", "--output-count", "2",
], {
  stdio: ["ignore", "pipe", "pipe"],
  // Only this private virtual compositor exposes the test input protocol.
  env: { ...process.env, QT_LOGGING_RULES: "kwin_scripting.debug=true", KWIN_WAYLAND_NO_PERMISSION_CHECKS: "1" },
});
let kwinLog = "";
kwin.stdout.on("data", (chunk) => { kwinLog += chunk; });
kwin.stderr.on("data", (chunk) => { kwinLog += chunk; });
let harness;
let sequence = 0;
const reports = new Map();
async function waitFor(callback, message, timeout = 12000) {
  const until = Date.now() + timeout;
  let last;
  while (Date.now() < until) {
    try { const value = await callback(); if (value) return value; } catch (error) { last = error; }
    await delay(50);
  }
  throw new Error(`${message}${last ? `: ${last.message}` : ""}`);
}
async function request(action = { type: "snapshot" }) {
  const id = ++sequence;
  await dbus("org.ktiler.Test", "/Test", "enqueue", JSON.stringify({ id, action }));
  return waitFor(() => {
    if (!reports.has(id)) return null;
    const report = reports.get(id);
    reports.delete(id);
    if (report.error) throw new Error(report.error);
    return report;
  }, `No test response for ${JSON.stringify(action)}`, 5000);
}
function partition(report) {
  for (const display of report.state.displays) {
    if (!display.windows.length) continue;
    const frames = display.windows.map((id) => report.windows.find((window) => window.id === id).geometry);
    for (const tile of getTiles(display)) {
      const frame = report.windows.find((window) => window.id === tile.windowId).geometry;
      const expected = {
        x: Math.round(display.x + tile.x * display.width),
        y: Math.round(display.y + tile.y * display.height),
      };
      expected.width = Math.round(display.x + (tile.x + tile.width) * display.width) - expected.x;
      expected.height = Math.round(display.y + (tile.y + tile.height) * display.height) - expected.y;
      for (const key of ["x", "y", "width", "height"]) assert.ok(Math.abs(frame[key] - expected[key]) < 0.1, `Unsettled ${key}`);
    }
    const area = frames.reduce((sum, frame) => sum + frame.width * frame.height, 0);
    assert.ok(Math.abs(area - display.width * display.height) < 10, `Output not filled: ${area}`);
    for (const frame of frames) {
      assert.ok(frame.x >= display.x - 1 && frame.y >= display.y - 1);
      assert.ok(frame.x + frame.width <= display.x + display.width + 1);
      assert.ok(frame.y + frame.height <= display.y + display.height + 1);
    }
    for (let i = 0; i < frames.length; i++) for (let j = i + 1; j < frames.length; j++) {
      const a = frames[i], b = frames[j];
      assert.ok(Math.min(a.x + a.width, b.x + b.width) <= Math.max(a.x, b.x)
        || Math.min(a.y + a.height, b.y + b.height) <= Math.max(a.y, b.y), "Real windows overlap");
    }
  }
}
async function settled(ready = () => true) {
  return waitFor(async () => {
    const report = await request();
    if (!ready(report)) return null;
    partition(report);
    return report;
  }, "Real window geometry did not settle into a full partition");
}

// Real keys go only to the private compositor through its private test socket.
async function keys(codes) {
  for (const key of codes) await dbus("org.ktiler.Test", "/Test", "key", String(key), "1");
  for (const key of [...codes].reverse()) await dbus("org.ktiler.Test", "/Test", "key", String(key), "0");
  await delay(100);
}

try {
  await waitFor(() => dbus("org.kde.KWin", "/Scripting"), "Isolated KWin did not start");
  harness = spawn(path.join(directory, "harness"), [], {
    env: { ...process.env, WAYLAND_DISPLAY: "ktiler-test", QT_QPA_PLATFORM: "wayland" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let lines = "";
  let ready = false;
  const osdMessages = [];
  harness.stdout.on("data", (chunk) => {
    lines += chunk;
    const split = lines.split("\n");
    lines = split.pop();
    for (const line of split) {
      if (line === "HARNESS_READY") ready = true;
      if (line.startsWith("OSD ")) osdMessages.push(line.slice(4));
      if (line.startsWith("REPORT ")) {
        const report = JSON.parse(line.slice(7));
        reports.set(report.id, report);
      }
    }
  });
  harness.stderr.on("data", (chunk) => { kwinLog += `[client] ${chunk}`; });
  await waitFor(() => ready, "Test application did not start");
  await dbus("org.ktiler.Test", "/Test", "createWindows", "4");
  await dbus("org.ktiler.Test", "/Test", "maximize", "3", "true");
  await delay(500);
  await exec("kpackagetool6", [
    "--type=KWin/Script", "--packageroot", path.join(directory, "package-validation"),
    "--install", built.directory,
  ]);
  console.log("PASS: KPackage accepts the built package in a temporary validation directory");
  const footer = `
const testTimer = new QTimer();
testTimer.interval = 25;
testTimer.timeout.connect(() => callDBus("org.ktiler.Test", "/Test", "org.ktiler.Test", "next", (command) => {
  if (!command) return;
  const message = JSON.parse(command);
  try {
    const action = message.action;
    if (action.type === "begin-native-resize") {
      ktiler.perform({ type: "select-window", id: action.id });
      workspace.slotWindowResize();
    } else if (action.type === "restore-minimized") {
      const window = workspace.windowList().find((window) => window.caption === action.caption);
      if (window) window.minimized = false;
    } else if (action.type === "toggle-maximize") {
      if (action.vertical) workspace.slotWindowMaximizeVertical();
      else workspace.slotWindowMaximize();
    } else if (action.type === "native-probe") {
      const root = workspace.rootTile(workspace.screens[0], workspace.currentDesktop);
      console.log("[ktiler probe] split=" + typeof root.split + ", resizeByPixels=" + typeof root.resizeByPixels);
      for (const w of workspace.windowList()) {
        console.log("[ktiler probe] caption=" + w.caption + " minSize=" + JSON.stringify(w.minSize)
          + " width=" + (w.minSize && w.minSize.width) + " maxSize=" + JSON.stringify(w.maxSize));
      }
    } else if (action.type !== "snapshot") ktiler.perform(action);
    callDBus("org.ktiler.Test", "/Test", "org.ktiler.Test", "report", JSON.stringify({
      id: message.id, state: ktiler.getEffectiveState(), windows: ktiler.inspect(),
      diagnostics: ktiler.diagnostics(), cursor: { x: workspace.cursorPos.x, y: workspace.cursorPos.y }
    }));
  } catch (error) {
    callDBus("org.ktiler.Test", "/Test", "org.ktiler.Test", "report", JSON.stringify({ id: message.id, error: String(error.stack || error) }));
  }
}));
testTimer.start();
`;
  const script = path.join(directory, "test-script.js");
  await writeFile(script, built.bundle + footer);
  const id = await dbus("org.kde.KWin", "/Scripting", "loadScript", script, "ktiler-test");
  await dbus("org.kde.KWin", `/Scripting/Script${id}`, "run");
  const findMaximizeTarget = (report) => report.windows.find((window) => window.caption === "ktiler Test 4");
  const managedCount = (report) => report.state.displays.reduce((count, item) => count + item.windows.length, 0);
  const coversOutput = (window, display) => {
    const { x, y, width, height } = window.geometry;
    return display.x === x && display.y === y && display.width === width && display.height === height;
  };
  const maxSettled = (report) => {
    const window = findMaximizeTarget(report);
    if (window?.maximizeMode !== 3 || managedCount(report) !== 3) return false;
    return report.state.displays.some((display) => coversOutput(window, display) && !display.windows.includes(window.id));
  };
  const normalSettled = (report) => findMaximizeTarget(report)?.maximizeMode === 0 && managedCount(report) === 4;
  let report = await settled(maxSettled);
  await dbus("org.ktiler.Test", "/Test", "maximize", "3", "false");
  report = await settled(normalSettled);
  console.log("PASS: a window already maximized at startup stays maximized and joins tiling when restored");

  const maximizeId = findMaximizeTarget(report).id;
  const source = report.state.displays.find((display) => display.windows.includes(maximizeId));
  const destination = report.state.displays.find((display) => display.id !== source.id);
  const goingRight = destination.x > source.x;
  const outbound = [56, 42, goingRight ? 106 : 105];
  const inbound = [56, 42, goingRight ? 105 : 106];
  await request({ type: "select-window", id: maximizeId });
  await request({ type: "toggle-maximize" });
  report = await settled(maxSettled);
  assert.equal(findMaximizeTarget(report).active, true);
  const tilingWhileMaximized = report.state;
  await keys(outbound);
  const onDestination = (report) => maxSettled(report) && coversOutput(findMaximizeTarget(report), destination);
  report = await settled(onDestination);
  assert.deepEqual(report.state, tilingWhileMaximized, "a move while maximized changed the tiled layout");
  assert.equal(findMaximizeTarget(report).active, true);
  assert.deepEqual(osdMessages, [], "a successful move should stay quiet");

  await keys(outbound);
  await waitFor(() => osdMessages.length, "No Plasma OSD at the outer monitor edge");
  assert.deepEqual(osdMessages.splice(0), [`ktiler ktiler: no monitor to the ${goingRight ? "right" : "left"}.`]);
  report = await settled(onDestination);
  assert.deepEqual(report.state, tilingWhileMaximized);
  assert.equal(findMaximizeTarget(report).active, true);

  await request({ type: "toggle-maximize" });
  report = await settled(normalSettled);
  assert.equal(findMaximizeTarget(report).active, true);
  assert.equal(report.state.activeDisplayId, destination.id);
  assert.equal(report.state.displays.find((display) => display.id === destination.id).activeWindowId, maximizeId);
  console.log("PASS: Alt+Shift+arrow moves a maximized window, shows feedback at the edge, and restores into tiling on the destination");

  const verticalMaximize = { type: "toggle-maximize", vertical: true };
  const verticalOn = (report, display) => {
    const window = findMaximizeTarget(report);
    const { x, y, width, height } = window.geometry;
    return window.maximizeMode === 1 && managedCount(report) === 3 && !report.state.displays.some((item) => item.windows.includes(window.id))
      && x + width / 2 >= display.x && x + width / 2 < display.x + display.width && y === display.y && height === display.height;
  };
  await request(verticalMaximize);
  await settled((report) => verticalOn(report, destination));
  await keys(inbound);
  await settled((report) => verticalOn(report, source));
  await request(verticalMaximize);
  report = await settled(normalSettled);
  assert.equal(report.state.activeDisplayId, source.id);
  assert.ok(report.state.displays.find((display) => display.id === source.id).windows.includes(maximizeId));
  console.log("PASS: moving a vertically maximized window preserves its maximize mode and returns it to tiling on restore");

  assert.equal(report.windows.filter((window) => window.caption.startsWith("ktiler Test")).length, 4);
  assert.equal(report.state.displays.length, 2);
  await request({ type: "native-probe" });
  console.log("PASS: package runs in KWin's real QJSEngine; four real Wayland windows fill their output");

  // Start with a 50/50 split on a live output; a tall Wayland client needs an
  // uneven split, not a different layout. Place it in the last slot of five.
  const crowdedReady = (report) => report.state.displays.some((item) => item.windows.length === 5);
  await dbus("org.ktiler.Test", "/Test", "createConstrainedWindow", "300", "520");
  report = await settled(crowdedReady);
  const tall = report.windows.find((window) => window.caption === "ktiler Test 5");
  let crowded = report.state.displays.find((item) => item.windows.length === 5);
  assert.equal(crowded.mode, "binary");
  assert.ok(tall.geometry.height >= 520 && tall.geometry.height < 800);
  await request({ type: "select-window", id: tall.id });
  await keys([56, 42, 106]); // Move the tall window right, then back into the split.
  await settled((report) => report.state.displays.some((item) => item.id !== crowded.id && item.windows.includes(tall.id)));
  await keys([56, 42, 105]);
  report = await settled(crowdedReady);
  const returned = report.state.displays.find((item) => item.id === crowded.id);
  assert.equal(returned.mode, "binary");
  assert.ok(returned.windows.includes(tall.id));
  assert.equal(report.windows.find((window) => window.id === tall.id).geometry.height, tall.geometry.height);
  assert.equal(kwinLog.includes("would not accept its new size"), false);
  console.log("PASS: opening and transferring a real Wayland window get an uneven split without changing layout");
  await dbus("org.ktiler.Test", "/Test", "closeWindow", "4");
  await delay(150);
  await settled();

  // A window whose minimum size cannot fit even unequal columns must recover,
  // and default diagnostics must not name the window.
  await dbus("org.ktiler.Test", "/Test", "createConstrainedWindow", "850", "200");
  report = await settled(crowdedReady);
  assert.equal(report.windows.filter((window) => window.caption.startsWith("ktiler Test")).length, 5);
  await keys([56, 47]); // Alt+V requests columns; the five minimums total more than 1280px.
  report = await settled();
  crowded = report.state.displays.find((item) => item.windows.length === 5);
  assert.equal(crowded.mode, "binary", "did not fall back to binary for unsatisfiable columns");
  assert.ok(kwinLog.includes("switched from columns to binary"), "no automatic fallback diagnostic in the KWin log");
  assert.ok(!kwinLog.includes('"ktiler Test'), "window caption leaked into default KWin log");
  console.log("PASS: unsatisfiable layout falls back to binary automatically, without logging captions");
  await dbus("org.ktiler.Test", "/Test", "closeWindow", "5");
  await settled((report) => report.state.displays.some((item) => item.windows.length === 4));
  await keys([56, 47]); // Restore columns for the subsequent resize tests.
  report = await settled();

  const display = report.state.displays.find((item) => item.windows.length === 4);
  await request({ type: "select-display", id: display.id });
  await keys([56, 47]); // Alt+V
  report = await settled();
  assert.equal(report.state.displays.find((item) => item.id === display.id).mode, "columns");
  console.log("PASS: Alt+V is registered with KWin and works through real injected keyboard events");
  const ids = report.state.displays.find((item) => item.id === display.id).windows;
  await request({ type: "select-window", id: ids[1] });
  const before = report.windows.find((window) => window.id === ids[1]).geometry;
  assert.equal(await dbus("org.ktiler.Test", "/Test", "fakeInputAvailable"), "true");
  report = await request({ type: "begin-native-resize", id: ids[1] });
  assert.equal(report.diagnostics.interacting, true);
  assert.equal(report.windows.find((window) => window.id === ids[1]).resizing, true);
  await dbus("org.ktiler.Test", "/Test", "motion", String(report.cursor.x + 60), String(report.cursor.y));
  await delay(250);
  report = await settled();
  const widths = ids.map((windowId) => report.windows.find((window) => window.id === windowId).geometry.width);
  console.log(`Native resize widths: ${widths.join(", ")}`);
  assert.ok(widths[1] > before.width + 30, "Real pointer resize did not grow the selected window");
  assert.ok(Math.abs(widths[0] - before.width) <= 1, "Window on the fixed side changed");
  assert.ok(Math.abs(widths[2] - widths[3]) <= 1, "Spread compensation was not equal");
  await dbus("org.ktiler.Test", "/Test", "key", "28", "1");
  await dbus("org.ktiler.Test", "/Test", "key", "28", "0");
  await delay(200);
  console.log("PASS: real KWin interactive resizing continuously applies Spread resize without gaps");

  await keys([56, 42, 19]); // Alt+Shift+R
  report = await settled();
  let ordered = report.state.displays.find((item) => item.id === display.id).windows;
  assert.deepEqual(ordered.map((windowId) => report.windows.find((window) => window.id === windowId).geometry.width), widths);
  await request({ type: "select-window", id: ordered[ordered.length - 1] });
  await keys([56, 42, 106]); // Alt+Shift+Right: transfer at outer edge.
  report = await settled();
  assert.notEqual(report.state.activeDisplayId, display.id);
  assert.equal(report.state.displays.find((item) => item.id !== display.id).windows.length, 1);
  await keys([56, 42, 105]); // Transfer back from the destination.
  report = await settled();
  assert.equal(report.state.activeDisplayId, display.id);
  console.log("PASS: real rotation and cross-monitor movement shortcuts preserve coverage and focus");

  await keys([56, 35]); // Alt+H
  report = await settled();
  ordered = report.state.displays.find((item) => item.id === display.id).windows;
  const row = report.windows.find((window) => window.id === ordered[1]).geometry;
  report = await request({ type: "begin-native-resize", id: ordered[1] });
  await dbus("org.ktiler.Test", "/Test", "motion", String(report.cursor.x), String(report.cursor.y + 60));
  await delay(150);
  report = await settled();
  const heights = ordered.map((windowId) => report.windows.find((window) => window.id === windowId).geometry.height);
  // KWin's menu-initiated resize can begin with a decoration/cursor offset;
  // validate the compensation against the actual native resize request.
  const growth = heights[1] - row.height;
  assert.ok(growth > 20);
  assert.equal(heights[0], 200);
  assert.ok(Math.abs(heights[2] - (200 - growth / 2)) <= 1);
  assert.ok(Math.abs(heights[3] - (200 - growth / 2)) <= 1);
  await keys([28]);
  console.log("PASS: horizontal Spread resize works through real pointer motion");

  await request({ type: "toggle-spread" });
  await keys([56, 47]);
  report = await settled();
  ordered = report.state.displays.find((item) => item.id === display.id).windows;
  const column = report.windows.find((window) => window.id === ordered[1]).geometry;
  report = await request({ type: "begin-native-resize", id: ordered[1] });
  await dbus("org.ktiler.Test", "/Test", "motion", String(report.cursor.x + 60), String(report.cursor.y));
  await delay(150);
  report = await settled();
  const adjacentWidths = ordered.map((windowId) => report.windows.find((window) => window.id === windowId).geometry.width);
  const adjacentGrowth = adjacentWidths[1] - column.width;
  assert.ok(adjacentGrowth > 20);
  assert.deepEqual(adjacentWidths, [320, 320 + adjacentGrowth, 320 - adjacentGrowth, 320]);
  await keys([28]);
  console.log("PASS: turning Spread resize off restores adjacent-only native resizing");

  await keys([56, 48]); // Alt+B
  report = await settled();
  ordered = report.state.displays.find((item) => item.id === display.id).windows;
  const binaryBefore = report.windows.find((window) => window.id === ordered[0]).geometry;
  report = await request({ type: "begin-native-resize", id: ordered[0] });
  await dbus("org.ktiler.Test", "/Test", "motion", String(report.cursor.x + 60), String(report.cursor.y + 30));
  await delay(150);
  report = await settled();
  const binaryAfter = report.windows.find((window) => window.id === ordered[0]).geometry;
  assert.ok(binaryAfter.width > binaryBefore.width + 20);
  assert.ok(binaryAfter.height > binaryBefore.height + 5);
  await keys([28]);
  console.log("PASS: binary corner resizing updates both shared splits without holes or overlap");

  await dbus("org.ktiler.Test", "/Test", "minimize", "0", "true");
  await settled((report) => managedCount(report) === 3);
  // Wayland clients can't unminimize themselves by calling QWidget::showNormal().
  await request({ type: "restore-minimized", caption: "ktiler Test 1" });
  await settled((report) => managedCount(report) === 4);
  await dbus("org.ktiler.Test", "/Test", "createWindows", "1");
  await settled((report) => managedCount(report) === 5);
  await dbus("org.ktiler.Test", "/Test", "closeWindow", "6");
  await settled((report) => managedCount(report) === 4);
  console.log("PASS: minimize/restore and open/close reflow real windows");
  // Reproduce the real rename failure: legacy action IDs keep the same keys
  // while the new actions are present but unbound. Never run this on the desktop.
  const migrationPath = fileURLToPath(new URL("./migrate-shortcuts.py", import.meta.url));
  await exec("/usr/bin/python3", ["-c", `
import importlib.util
spec = importlib.util.spec_from_file_location("migration", ${JSON.stringify(migrationPath)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
api = m.KDE()
actions = {a[1]: a for a in api.actions()}
for suffix in m.SUFFIXES:
    new = actions["ktiler-" + suffix]
    keys = m.normalize(api.keys(new))
    old = ("kwin", "KDETiler-" + suffix, "KWin", "KDETiler: " + suffix)
    api.api.doRegister(api.action_id(old))
    api.set_keys(new, ())
    api.set_keys(old, keys)
plan = m.plan_transfer(api)
assert len(plan) == 25
`]);
  await exec("/usr/bin/python3", [migrationPath, "--apply"]);
  await keys([56, 47]); // Alt+V must work again without reloading the script.
  report = await settled();
  assert.equal(report.state.displays.find((item) => item.id === report.state.activeDisplayId).mode, "columns");
  console.log("PASS: legacy shortcut reservations migrate live; renamed shortcuts work without script reload");

  // Discover whether saved configuration changes apply to the RUNNING script:
  // KConfig's cross-process notification alone, or an explicit KWin reconfigure.
  await keys([56, 48]); // Alt+B → binary, so a later V-shortcut is observable.
  report = await settled();
  const activeId = report.state.activeDisplayId;
  const modeOf = (snapshot) => snapshot.state.displays.find((item) => item.id === activeId).mode;
  assert.equal(modeOf(report), "binary");
  await exec("kwriteconfig6", ["--file", "kwinrc", "--group", "Script-ktiler-test", "--key", "Modifier", "Meta", "--notify", ""]);
  await delay(600);
  await keys([125, 47]); // Meta+V: only registered if the script reloaded with the new modifier.
  report = await settled();
  const notificationReloads = modeOf(report) === "columns";
  console.log(`FINDING: KConfig notification alone ${notificationReloads ? "RELOADS" : "does not reload"} the running script`);
  if (!notificationReloads) {
    await keys([56, 47]); // Alt+V must still be the active binding.
    report = await settled();
    assert.equal(modeOf(report), "columns", "Neither Meta+V nor Alt+V worked after config notification");
    console.log("FINDING: the old modifier binding remains active until the script is loaded again");
    await keys([56, 48]);
    report = await settled();
  }
  await dbus("org.kde.KWin", "/KWin", "reconfigure");
  await delay(800);
  await keys([125, 47]);
  report = await settled();
  const reconfigureReloads = modeOf(report) === "columns";
  console.log(`FINDING: a KWin reconfigure ${reconfigureReloads ? "RELOADS" : "does not reload"} the running script`);
  await exec("kwriteconfig6", ["--file", "kwinrc", "--group", "Script-ktiler-test", "--key", "Modifier", "Alt", "--notify", ""]);
  if (reconfigureReloads) {
    await dbus("org.kde.KWin", "/KWin", "reconfigure");
    await delay(800);
  }
  await keys([56, 48]);
  report = await settled();
  await keys([56, 47]); // Restore the pre-probe state: Alt+V active, columns mode.
  report = await settled();
  assert.equal(modeOf(report), "columns", "Configuration probe did not restore Alt bindings");
  console.log("PASS: configuration-change behavior measured; isolated environment restored");

  // Reproduce the real-desktop bug: transferring a window into a display where
  // an application refuses its new size must undo the move, never leave the
  // transferred window hidden behind the refuser.
  await request({ type: "select-window", id: report.state.displays.find((item) => item.windows.length === 4).windows[3] });
  await request({ type: "move", direction: "right" }); // One window to the second output.
  await settled();
  const idsBefore = new Set((await request()).windows.map((window) => window.id));
  await dbus("org.ktiler.Test", "/Test", "createWindows", "1");
  report = await settled((report) => managedCount(report) === 5);
  const stubbornInfo = report.windows.find((window) => !idsBefore.has(window.id));
  assert.ok(stubbornInfo, "stubborn test window missing");
  // The harness numbers captions from one and takes zero-based creation indices.
  const stubbornIndex = String(Number(stubbornInfo.caption.split(" ").at(-1)) - 1);
  await dbus("org.ktiler.Test", "/Test", "holdSize", stubbornIndex);
  const beforeMove = await request();
  const sourceDisplay = beforeMove.state.displays.find((item) => item.windows.length === 1);
  await request({ type: "select-window", id: sourceDisplay.windows[0] });
  await request({ type: "move", direction: "left" }); // Would shrink the stubborn window's tile.
  // The refusal fight takes ~13 reconciliation cycles; wait for the undo itself.
  await waitFor(() => kwinLog.includes("Recent layout change undone"), "Refused transfer was not rolled back", 15000);
  report = await settled();
  const afterMove = report.state.displays.find((item) => item.windows.length === 1);
  assert.ok(afterMove, "the refused transfer was not rolled back");
  assert.deepEqual(afterMove.windows, sourceDisplay.windows, "rollback restored the wrong window");
  assert.ok(kwinLog.includes("Recent layout change undone"), "no undo diagnostic in the KWin log");
  assert.ok(!kwinLog.includes('"ktiler Test'), "window caption leaked into default KWin log");
  assert.deepEqual(report.windows.find((window) => window.id === stubbornInfo.id).geometry,
    stubbornInfo.geometry, "the stubborn window was fought despite refusing");
  await waitFor(() => osdMessages.length, "KWin did not send the rollback message to the Plasma OSD");
  assert.deepEqual(osdMessages, ["ktiler Move undone: a window didn't accept its new size."]);
  console.log("PASS: a transfer the destination window refuses is rolled back automatically");
  console.log("PASS: KWin sends branded move feedback to the Plasma OSD with debug logging off");
  await dbus("org.ktiler.Test", "/Test", "closeWindow", stubbornIndex);
  await settled();

  await keys([125, 29, 56, 25]); // Meta+Ctrl+Alt+P
  report = await request();
  assert.equal(report.diagnostics.enabled, false);
  await keys([125, 29, 56, 25]);
  await settled();
  await keys([125, 29, 56, 19]); // Meta+Ctrl+Alt+R
  report = await request();
  assert.equal(report.diagnostics.enabled, false);
  console.log("PASS: restore action pauses management");

  await dbus("org.kde.KWin", "/Scripting", "unloadScript", "ktiler-test");
  await waitFor(async () => await dbus("org.kde.KWin", "/Scripting", "isScriptLoaded", "ktiler-test") === "false",
    "Test script did not unload");
  await exec("kwriteconfig6", ["--file", "kwinrc", "--group", "Plugins", "--key", "ktilerEnabled", "true"]);
  await dbus("org.kde.KWin", "/Scripting", "start");
  await waitFor(() => kwinLog.includes("[ktiler dev test] old script loaded"), "Old installed script did not start");
  const starts = kwinLog.split("[ktiler] Prototype loaded").length;
  await reloadKWin(built.directory, { run });
  await waitFor(() => kwinLog.split("[ktiler] Prototype loaded").length > starts, "Upgraded script did not start");
  assert.equal(await dbus("org.kde.KWin", "/Scripting", "isScriptLoaded", "ktiler"), "true");
  assert.equal((await planInstallation(built.directory)).packageUnchanged, true);
  console.log("PASS: dev reload upgraded a running script via Apply in private KWin");
} catch (error) {
  console.error(error);
  console.error(kwinLog);
  process.exitCode = 1;
} finally {
  await writeFile(path.join(directory, "kwin.log"), kwinLog);
  harness?.kill("SIGTERM");
  kwin.kill("SIGTERM");
}
