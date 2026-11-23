import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildKWinRelease } from "./build-kwin.mjs";
import { siteFiles } from "../site-files.mjs";

const temporary = await mkdtemp(path.resolve(tmpdir(), "ktiler-web-install-test-"));
console.log(`Private installer test directory: ${temporary}`);
const buildStarted = new Date();
const release = await buildKWinRelease(path.join(temporary, "dist"));
const buildFinished = new Date();
const home = path.join(temporary, "home");
const bin = path.join(temporary, "bin");
const data = path.join(temporary, "custom data");
const config = path.join(home, ".config");
const systemData = path.join(temporary, "system data");
const env = {
  ...process.env, HOME: home, XDG_SESSION_TYPE: "wayland", XDG_CURRENT_DESKTOP: "KDE",
  XDG_DATA_HOME: data, XDG_DATA_DIRS: `${systemData}:${process.env.XDG_DATA_DIRS || "/usr/local/share:/usr/share"}`,
  XDG_CONFIG_HOME: "invalid-relative", XDG_CONFIG_DIRS: config,
  XDG_STATE_HOME: "also-relative", XDG_CACHE_HOME: path.join(temporary, "cache"),
  XDG_RUNTIME_DIR: path.join(temporary, "runtime"), TMPDIR: temporary,
  DBUS_SESSION_BUS_ADDRESS: `unix:path=${temporary}/no-session-bus`,
  PATH: `${bin}:${process.env.PATH}`, KTILER_TEST_ARCHIVE: release.brandedArchive,
  KTILER_TEST_DOWNLOAD_LOG: path.join(temporary, "downloaded"), KTILER_TEST_PLASMA_VERSION: "6.10.0",
  KTILER_TEST_BUS_STATE: path.join(temporary, "bus.json"),
};
delete env.DISPLAY;
delete env.WAYLAND_DISPLAY;
for (const directory of [config, bin, env.XDG_RUNTIME_DIR]) await mkdir(directory, { recursive: true, mode: 0o700 });

function run(command, args, extra = {}, errorPattern) {
  const result = spawnSync(command, args, { env: { ...env, ...extra }, encoding: "utf8", timeout: 30000 });
  if (result.error) throw result.error;
  const output = `${result.stdout}${result.stderr}`;
  if (errorPattern) {
    assert.notEqual(result.status, 0, output);
    assert.match(output, errorPattern);
  } else {
    assert.equal(result.status, 0, output);
  }
  return output;
}
const script = await readFile(release.installer, "utf8");
const version = script.match(/^    version='([^']+)'$/m)[1];
const [header] = script.split("\n#\n", 1);
const [shebang, ...bannerRows] = header.split("\n");
const title = `ktiler ${version}`;
const tagline = "make room for what's next";
assert.equal(shebang, "#!/bin/sh");
assert.ok(bannerRows.every((row) => row.startsWith("# ")));
assert.ok(bannerRows[0].startsWith("# ┌"));
assert.deepEqual(bannerRows.slice(3, 5).map((row) => row.split("   ")[1]), [title, tagline]);
assert.ok([buildStarted, buildFinished].some((built) =>
  header.includes(`© ${built.getFullYear()} Jordan Arsenault`) &&
  header.includes(`Built ${built.toLocaleDateString("en-US", { dateStyle: "long" })}`)), header);
assert.match(header, /   ktiler\.org$/m);
const bannerText = bannerRows.map((row) => row.slice(2));
const [firstArtRow] = bannerText;
const bannerLabels = bannerText.flatMap((row) => row.split("   ").slice(1));
const archiveData = await readFile(release.brandedArchive);
const digest = createHash("sha256").update(archiveData).digest("hex");
const archiveUrl = script.match(/download_url='([^']+)'/)[1];
assert.ok(siteFiles.has(new URL(archiveUrl).pathname));
assert.equal(siteFiles.get("/install.sh").source, "dist/install.sh");
assert.ok(script.includes(`archive_sha256='${digest}'`));
run("sh", ["-n", release.installer]);

// Substitute the transport, Plasma version, and KWin's loaded-state reply. Use
// real KPackage and KConfig tools, private XDG directories, and no session bus or network.
await writeFile(path.join(bin, "curl"), `#!/bin/sh
set -eu
: > "$KTILER_TEST_DOWNLOAD_LOG"
while [ "$1" != -o ]; do shift; done
[ "$3" = '${archiveUrl}' ]
cp -- "$KTILER_TEST_ARCHIVE" "$2"
`, { mode: 0o700 });
await writeFile(path.join(bin, "plasmashell"), `#!/bin/sh
[ "$*" = --version ] || exit 1
printf 'plasmashell %s\\n' "$KTILER_TEST_PLASMA_VERSION"
`, { mode: 0o700 });
await writeFile(path.join(bin, "qdbus6"), `#!/bin/sh
[ "$*" = 'org.kde.KWin /Scripting org.kde.kwin.Scripting.isScriptLoaded ktiler' ] || exit 1
printf '%s\\n' "\${KTILER_TEST_LOADED:-false}"
`, { mode: 0o700 });
await writeFile(path.join(bin, "busctl"), `#!/usr/bin/env python3
import json, os, subprocess, sys
from pathlib import Path
state_path = Path(os.environ["KTILER_TEST_BUS_STATE"])
state = json.loads(state_path.read_text())
_, op, service, path, interface, method, *args = sys.argv[4:]
def output(type_, data):
    print(json.dumps({"type": type_, "data": data}))
def setting(key, default):
    return subprocess.check_output(["kreadconfig6", "--file", "kwinrc", "--group", "Plugins",
                                    "--key", key, "--default", default], text=True).strip()
if os.environ.get("KTILER_TEST_BUS_OFFLINE") == "1":
    sys.exit(1)
if method == "isScriptLoaded":
    output("b", [state["loaded"] if args[-1] == "ktiler" else False])
elif method == "loadedEffects":
    output("as", ["tileseditor"])
elif method == "start":
    state["starts"] += 1
    state["loaded"] = setting("ktilerEnabled", "false") == "true" and os.environ.get("KTILER_TEST_ACTIVATION_FAIL") != "1"
    state_path.write_text(json.dumps(state))
elif method == "globalShortcutsByKey":
    key = int(args[2])
    sequences = state["foreign"]
    action, description, app, friendly = state.get("owner", ["ExampleAction", "Example behavior", "test-app", "Example App"])
    entries = [[action, description, app, friendly, "default", "Default", [key], []]]
    output("a(ssssssaiai)", [entries if args[-1] == "0" and [key, 0, 0, 0] in sequences else []])
elif method == "shortcutKeys":
    if args[2] != "kwin|default":
        sequences = state["foreign"]
    else:
        sequences = [[state["own"][args[3]], 0, 0, 0]] if state["loaded"] and args[3] in state["own"] else []
    output("a(ai)", [[[sequence] for sequence in sequences]])
elif method == "setForeignShortcutKeys":
    assert args[2:4] == ["test-app|default", "ExampleAction"]
    rest = args[7:]
    sequences = []
    while rest:
        size = int(rest[0])
        sequences.append(list(map(int, rest[1:1+size])))
        rest = rest[size+1:]
    assert len(sequences) == int(args[6])
    state["foreign"] = sequences
    state_path.write_text(json.dumps(state))
else:
    sys.exit(2)
`, { mode: 0o700 });
await writeFile(path.join(bin, "kcmshell6"), `#!/bin/sh
printf '%s\\n' "$$" > "$KTILER_TEST_BUS_STATE.settings"
exec sleep 20
`, { mode: 0o700 });

const install = (extra, errorPattern) => run("sh", [release.installer], extra, errorPattern);
const backupRoot = path.join(home, ".local/state/ktiler/backups");
const installed = path.join(data, "kwin/scripts/ktiler");
const icon = path.join(data, "icons/hicolor/256x256/apps/ktiler.png");
const launcher = path.join(data, "applications/org.ktiler.Settings.desktop");
const kwinrc = path.join(config, "kwinrc");
const shortcuts = path.join(config, "kglobalshortcutsrc");
const shortcutConfig = "[kwin]\nktiler-Layout-columns=Meta+X,Alt+X,ktiler\n";
const disabled = "[Plugins]\nktilerEnabled=false\n[Script-ktiler]\nDefaultLayout=columns\n";
const enabled = disabled.replace("Enabled=false", "Enabled=true");
const pause = 0x0a00004b;
const defaults = { "ktiler-Pause": pause, "ktiler-Layout-binary": 0x08000021,
  "ktiler-Layout-columns": 0x08000040, "ktiler-Layout-horizontal": 0x08000023,
  "ktiler-RotateClockwise": 0x0a000052, "ktiler-RotateCounterclockwise": 0x0a000045 };
for (const [direction, letter] of [["Up", "W"], ["Down", "S"], ["Left", "A"], ["Right", "D"]]) {
  defaults[`ktiler-Focus-${direction}`] = 0x08000000 | letter.charCodeAt(0);
  defaults[`ktiler-Move-${direction}`] = 0x0a000000 | letter.charCodeAt(0);
}
const alternate = [0x0800005a, 0x08000058, 0, 0];
const writeBus = (override = {}) =>
  writeFile(env.KTILER_TEST_BUS_STATE, JSON.stringify({ loaded: false, starts: 0, foreign: [], own: defaults, ...override }));
const busState = async () => JSON.parse(await readFile(env.KTILER_TEST_BUS_STATE, "utf8"));
const withTerminal = (steps, extra = {}) =>
  run("python3", [fileURLToPath(new URL("../test/native/installer-pty.py", import.meta.url)), JSON.stringify(steps),
    "sh", "-c", 'cat "$1" | sh', "installer-pipe", release.installer],
  { TERM: "xterm", COLUMNS: "80", NO_COLOR: "", PYTHONIOENCODING: "utf-8", ...extra }).replaceAll("\r", "");
await writeFile(kwinrc, disabled);
await writeFile(shortcuts, shortcutConfig);
await writeBus();
const metadata = async (directory) => JSON.parse(await readFile(path.join(directory, "metadata.json"), "utf8"));

install({ XDG_SESSION_TYPE: "x11" }, /Requires KDE Plasma 6\.3 or newer.*Session type: x11/);
install({ XDG_SESSION_TYPE: "" }, /Session type: unknown/);
install({ XDG_CURRENT_DESKTOP: "GNOME" }, /Current desktop: GNOME/);
install({ KTILER_TEST_PLASMA_VERSION: "5.27.12" }, /Detected Plasma 5\.27\.12/);
install({ KTILER_TEST_PLASMA_VERSION: "6.2.5" }, /Detected Plasma 6\.2\.5/);
install({ KTILER_TEST_PLASMA_VERSION: "unknown" }, /Could not read the Plasma version/);
await assert.rejects(readFile(env.KTILER_TEST_DOWNLOAD_LOG), { code: "ENOENT" });

install({ KTILER_TEST_PLASMA_VERSION: "6.3.0", KTILER_TEST_ARCHIVE: release.archive }, /checksum mismatch/);
await assert.rejects(readdir(backupRoot), { code: "ENOENT" });
await assert.rejects(metadata(installed), { code: "ENOENT" });

run("kpackagetool6", ["--type=KWin/Script", "--install", release.archive]);
const direct = await metadata(installed);
assert.equal(direct.KPlugin.Icon, "preferences-desktop-virtual");
assert.equal(direct.KPlugin.EnabledByDefault, false);
await assert.rejects(readFile(icon), { code: "ENOENT" });
await assert.rejects(readFile(launcher), { code: "ENOENT" });

await writeFile(kwinrc, enabled);
install({}, /untick it/);
await writeFile(kwinrc, disabled);
install({ KTILER_TEST_LOADED: "true" }, /untick it/);
install({ KTILER_TEST_LOADED: "unknown" }, /Could not verify/);
await assert.rejects(readdir(backupRoot), { code: "ENOENT" });
assert.deepEqual(await metadata(installed), direct);

const output = install();
assert.match(output, /✓ ktiler is installed and enabled\./);
assert.match(output, /YOUR SHORTCUTS[\s\S]*Alt\+Shift\+K.*Pause \/ resume tiling/);
assert.deepEqual([...output.matchAll(/^(Alt\+(?:Shift\+)?[WASD])\s*\|/gm)].map(([, keys]) => keys),
  ["Alt+W", "Alt+A", "Alt+S", "Alt+D", "Alt+Shift+W", "Alt+Shift+A", "Alt+Shift+S", "Alt+Shift+D"]);
const guide = output.split("YOUR SHORTCUTS\n")[1].split("\n\nChange shortcuts")[0];
assert.deepEqual(guide.split("\n\n").map((group) => [...group.matchAll(/^(Alt\+[^| ]+)/gm)].map(([, key]) => key)), [
  ["Alt+W", "Alt+A", "Alt+S", "Alt+D"],
  ["Alt+Shift+W", "Alt+Shift+A", "Alt+Shift+S", "Alt+Shift+D"],
  ["Alt+Shift+1", "Alt+Shift+2", "Alt+Shift+3"],
  ["Alt+Shift+R", "Alt+Shift+E"],
  ["Alt+Shift+K"],
]);
assert.doesNotMatch(guide, /US keyboard/);
assert.doesNotMatch(output, /Open ktiler Settings to change shortcuts now\?/);
assert.doesNotMatch(output, /┌|make room for what's next|© \d{4} Jordan Arsenault|Built [A-Z]|ktiler\.org/);
assert.equal((await busState()).starts, 1);
const backup = output.match(/^Backup: (.+)$/m)[1];
const branded = await metadata(installed);
assert.equal(branded.KPlugin.Icon, "ktiler");
assert.deepEqual({ ...branded, KPlugin: { ...branded.KPlugin, Icon: direct.KPlugin.Icon } }, direct);
assert.deepEqual(await metadata(path.join(backup, "ktiler")), direct);
assert.equal(await readFile(path.join(backup, "kwinrc"), "utf8"), disabled);
assert.equal(await readFile(path.join(backup, "kglobalshortcutsrc"), "utf8"), shortcutConfig);
assert.equal(run("diff", ["-qr", path.join(backup, "ktiler/contents"), path.join(installed, "contents")]), "");
assert.deepEqual(await readFile(icon), await readFile(new URL("../ktiler-icon.png", import.meta.url)));
assert.match(await readFile(launcher, "utf8"), /^Icon=ktiler$/m);

await writeFile(kwinrc, enabled);
await writeBus({ loaded: true });
await rm(icon);
await rm(launcher);
install({ KTILER_TEST_LOADED: "true" });
assert.equal((await busState()).starts, 0, "an identical repair must not restart ktiler");
assert.equal(await readFile(kwinrc, "utf8"), enabled);
assert.equal(await readFile(shortcuts, "utf8"), shortcutConfig);
assert.deepEqual(await readFile(icon), await readFile(new URL("../ktiler-icon.png", import.meta.url)));
assert.match(await readFile(launcher, "utf8"), /^Icon=ktiler$/m);

const freshData = path.join(home, ".local/share");
const systemPackage = path.join(systemData, "kwin/scripts/ktiler");
await mkdir(systemPackage, { recursive: true });
await writeFile(path.join(systemPackage, "metadata.json"), JSON.stringify(direct));
install({ XDG_DATA_HOME: "invalid-relative" }, /system-wide ktiler/);
await assert.rejects(metadata(path.join(freshData, "kwin/scripts/ktiler")), { code: "ENOENT" });
await rm(path.join(systemPackage, "metadata.json"));
await writeFile(kwinrc, disabled);
await writeBus();
install({ XDG_DATA_HOME: "invalid-relative" });
assert.deepEqual(await metadata(path.join(freshData, "kwin/scripts/ktiler")), branded);
assert.deepEqual(await readFile(path.join(freshData, "icons/hicolor/256x256/apps/ktiler.png")), await readFile(icon));

// Simulate removal through KDE leaving an enabled preference and a live
// Ghostty global shortcut. Never let the replacement package take the fast path.
const ghostty = ["new-window", "New Window", "com.mitchellh.ghostty.desktop", "Ghostty"];
const moveDown = defaults["ktiler-Move-Down"];
const ghosttyBinding = [[moveDown, 0, 0, 0]];
run("kpackagetool6", ["--type=KWin/Script", "--remove", "ktiler"]);
await assert.rejects(metadata(installed), { code: "ENOENT" });
await writeFile(kwinrc, enabled);
await writeBus({ owner: ghostty, foreign: ghosttyBinding });
const reinstall = withTerminal([["[U] Unbind", "e"]], { COLUMNS: "44" });
assert.match(reinstall, /Cleared the enable setting[\s\S]*Alt\+Shift\+S[\s\S]*Ghostty: New\s+Window[\s\S]*SETUP NOT FINISHED/);
for (const label of bannerLabels) assert.ok(reinstall.includes(`${label}\n`), reinstall);
assert.doesNotMatch(reinstall, /┌/);
assert.doesNotMatch(reinstall, /✓ ktiler is installed and enabled/);
assert.match(await readFile(kwinrc, "utf8"), /ktilerEnabled=false/);
assert.deepEqual((await busState()).foreign, ghosttyBinding);
assert.equal((await busState()).starts, 0, "a stale flag must not lead to activation before review");
const reinstallBackup = reinstall.match(/^Backup: (.+)$/m)[1];
assert.match(await readFile(path.join(reinstallBackup, "kwinrc"), "utf8"), /ktilerEnabled=true/);

await writeFile(kwinrc, enabled);
const { ["ktiler-Move-Down"]: ignored, ...partial } = defaults;
await writeBus({ loaded: true, owner: ghostty, foreign: ghosttyBinding, own: partial });
const alreadyRunning = install();
assert.match(alreadyRunning, /Ghostty: New Window[\s\S]*already running, but some shortcuts are unavailable/);
assert.match(alreadyRunning, /Alt\+Shift\+S \(not registered\)/);
assert.equal((await busState()).starts, 0);
assert.deepEqual((await busState()).foreign, ghosttyBinding);

await writeFile(kwinrc, disabled.replace("ktilerEnabled=false", "ktilerEnabled=false\nkrohnkiteEnabled=true"));
await writeBus({ foreign: [[pause, 0, 0, 0], alternate] });
const exitTiler = withTerminal([["[E] Exit setup:", "e"]], { NO_COLOR: undefined });
assert.match(exitTiler, /\x1b\[36m┌/);
assert.match(exitTiler, /Krohnkite[\s\S]*\x1b\[33m⚠ SETUP NOT FINISHED/);
assert.doesNotMatch(exitTiler, /Conflicting global shortcuts/);
assert.equal((await busState()).starts, 0);
const exitShortcut = withTerminal([["[S] Skip this check", ""], ["[S] Skip this check", "s"], ["[U] Unbind", "e"]],
  { NO_COLOR: "1", PYTHONIOENCODING: "ascii:replace" });
for (const label of bannerLabels) {
  assert.ok(exitShortcut.includes(`${label.replace(/^© /, "Copyright ")}\n`), exitShortcut);
}
assert.doesNotMatch(exitShortcut, /\?{10,}/);
assert.equal([...exitShortcut.matchAll(/Known auto-tilers enabled or running/g)].length, 2);
assert.match(exitShortcut, /Keystroke.*ktiler action.*Existing app and action[\s\S]*Alt\+Shift\+K.*Example App: Example behavior/);
assert.match(exitShortcut, /SETUP NOT FINISHED/);
assert.doesNotMatch(exitShortcut, /\x1b\[33m/);
assert.deepEqual((await busState()).foreign, [[pause, 0, 0, 0], alternate]);

await writeFile(kwinrc, disabled);
const noninteractive = install();
assert.match(noninteractive, /Shortcut conflicts need an interactive terminal/);
assert.equal((await busState()).starts, 0);
const confirmed = withTerminal([["[U] Unbind", "u"], ["Open ktiler Settings to change shortcuts now?", "y"]]);
assert.match(confirmed, /Removed the approved bindings[\s\S]*✓ ktiler is installed and enabled/);
assert.equal(version, branded.KPlugin.Version);
const confirmedLines = confirmed.split("\n");
const bannerStart = confirmedLines.findIndex((line) => line.trimStart() === firstArtRow);
assert.ok(bannerStart >= 0, confirmed);
const indent = confirmedLines[bannerStart].indexOf(firstArtRow);
const welcomeRows = confirmedLines.slice(bannerStart, bannerStart + bannerText.length).map((line) => line.slice(indent));
assert.deepEqual(welcomeRows, bannerText);
assert.match(confirmed, /YOUR SHORTCUTS[\s\S]*Alt\+Shift\+K[\s\S]*Open ktiler Settings to change shortcuts now\?/);
let settingsPid;
try {
  for (let i = 0; !settingsPid && i < 30; i++) {
    const marker = await readFile(`${env.KTILER_TEST_BUS_STATE}.settings`, "utf8").catch(() => "");
    settingsPid = Number(marker.trim());
    if (!settingsPid) await delay(20);
  }
  assert.ok(settingsPid, "Settings did not launch");
  process.kill(settingsPid, 0); // The installer has already exited; Settings is still running.
} finally {
  if (settingsPid) process.kill(settingsPid, "SIGTERM");
}
assert.deepEqual((await busState()).foreign, [alternate], "unbinding must preserve the action's other sequence");
const liveBackup = path.join(confirmed.match(/^Backup: (.+)$/m)[1], "live-shortcuts-1.json");
assert.match(await readFile(liveBackup, "utf8"), /test-app\|default/);

await writeFile(kwinrc, disabled);
await writeBus({ foreign: [[pause, 0, 0, 0], alternate] });
const fail = withTerminal([["[U] Unbind", "u"]], { KTILER_TEST_ACTIVATION_FAIL: "1" });
assert.match(fail, /SETUP NOT FINISHED[\s\S]*did not load ktiler/);
assert.match(await readFile(kwinrc, "utf8"), /ktilerEnabled=false/);
assert.deepEqual(new Set((await busState()).foreign.map(JSON.stringify)),
  new Set([[pause, 0, 0, 0], alternate].map(JSON.stringify)), "failed activation restores approved removals");
await writeBus();
assert.match(install({ KTILER_TEST_BUS_OFFLINE: "1" }), /activation could not be\s+verified/);

await writeFile(kwinrc, disabled.replace("ktilerEnabled=false", "ktilerEnabled=false\nkrohnkiteEnabled=true"));
assert.match(install(), /Krohnkite[\s\S]*SETUP NOT FINISHED/);
assert.equal((await busState()).starts, 0);
const skipTiler = withTerminal([["[S] Skip this check", "s"], ["Open ktiler Settings to change shortcuts now?", ""]]);
assert.match(skipTiler, /Both tilers may try to arrange the same windows[\s\S]*✓ ktiler is installed and enabled/);
assert.match(await readFile(kwinrc, "utf8"), /krohnkiteEnabled=true/);

await writeFile(kwinrc, disabled + "ShortcutPause=Meta+J\nShortcutLayoutHorizontal=\n");
await writeBus({ own: { ...defaults, "ktiler-Pause": 0x1000004a } });
const custom = install();
assert.match(custom, /Meta\+J.*Pause \/ resume tiling/);
assert.match(custom, /Unbound.*Rows layout/);
assert.doesNotMatch(custom, /Alt\+Shift\+K/);
console.log("Verified installer banners, guarded upgrades, automatic activation, prompts through a shell pipe, shortcut unbinding/rollback, and the final shortcut guide.");
