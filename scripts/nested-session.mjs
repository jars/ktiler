import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildKWin } from "./build-kwin.mjs";
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
async function settled() {
  return waitFor(async () => {
    const report = await request();
    try { partition(report); return report; } catch { return null; }
  }, "Real window geometry did not settle into a full partition");
}

try {
  await waitFor(() => dbus("org.kde.KWin", "/Scripting"), "Isolated KWin did not start");
  harness = spawn(path.join(directory, "harness"), [], {
    env: { ...process.env, WAYLAND_DISPLAY: "ktiler-test", QT_QPA_PLATFORM: "wayland" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let lines = "";
  let ready = false;
  harness.stdout.on("data", (chunk) => {
    lines += chunk;
    const split = lines.split("\n");
    lines = split.pop();
    for (const line of split) {
      if (line === "HARNESS_READY") ready = true;
      if (line.startsWith("REPORT ")) {
        const report = JSON.parse(line.slice(7));
        reports.set(report.id, report);
      }
    }
  });
  harness.stderr.on("data", (chunk) => { kwinLog += `[client] ${chunk}`; });
  await waitFor(() => ready, "Test application did not start");
  await dbus("org.ktiler.Test", "/Test", "createWindows", "4");
  await delay(500);
  const built = await buildKWin(path.join(directory, "package"));
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
    } else if (action.type === "native-probe") {
      const root = workspace.rootTile(workspace.screens[0], workspace.currentDesktop);
      console.log("[ktiler probe] split=" + typeof root.split + ", resizeByPixels=" + typeof root.resizeByPixels);
    } else if (action.type !== "snapshot") ktiler.perform(action);
    callDBus("org.ktiler.Test", "/Test", "org.ktiler.Test", "report", JSON.stringify({
      id: message.id, state: ktiler.getState(), windows: ktiler.inspect(),
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
  let report = await settled();
  assert.equal(report.windows.filter((window) => window.caption.startsWith("ktiler Test")).length, 4);
  assert.equal(report.state.displays.length, 2);
  await request({ type: "native-probe" });
  console.log("PASS: package runs in KWin's real QJSEngine; four real Wayland windows fill their output");

  const display = report.state.displays.find((item) => item.windows.length === 4);
  await request({ type: "select-display", id: display.id });
  // Real keys go only to the private compositor through its private test socket.
  async function keys(codes) {
    for (const key of codes) await dbus("org.ktiler.Test", "/Test", "key", String(key), "1");
    for (const key of [...codes].reverse()) await dbus("org.ktiler.Test", "/Test", "key", String(key), "0");
    await delay(100);
  }
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
  await delay(150);
  await settled();
  await dbus("org.ktiler.Test", "/Test", "minimize", "0", "false");
  await delay(150);
  await settled();
  await dbus("org.ktiler.Test", "/Test", "createWindows", "1");
  await delay(150);
  await settled();
  await dbus("org.ktiler.Test", "/Test", "closeWindow", "4");
  await delay(150);
  await settled();
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
  await keys([125, 29, 56, 25]); // Meta+Ctrl+Alt+P
  report = await request();
  assert.equal(report.diagnostics.enabled, false);
  await keys([125, 29, 56, 25]);
  await settled();
  await keys([125, 29, 56, 19]); // Meta+Ctrl+Alt+R
  report = await request();
  assert.equal(report.diagnostics.enabled, false);
  console.log("PASS: restore action pauses management; no script was installed on the desktop");
} catch (error) {
  console.error(error);
  console.error(kwinLog);
  process.exitCode = 1;
} finally {
  await writeFile(path.join(directory, "kwin.log"), kwinLog);
  harness?.kill("SIGTERM");
  kwin.kill("SIGTERM");
}
