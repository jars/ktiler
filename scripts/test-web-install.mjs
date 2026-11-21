import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildKWinRelease } from "./build-kwin.mjs";
import { siteFiles } from "../site-files.mjs";

const temporary = await mkdtemp("/tmp/opencode/ktiler-web-install-");
console.log(`Private installer test directory: ${temporary}`);
const release = await buildKWinRelease(path.join(temporary, "dist"));
const home = path.join(temporary, "home");
const bin = path.join(temporary, "bin");
const data = path.join(temporary, "custom data");
const config = path.join(home, ".config");
const systemData = path.join(temporary, "system data");
const env = {
  ...process.env, HOME: home, XDG_SESSION_TYPE: "wayland",
  XDG_DATA_HOME: data, XDG_DATA_DIRS: `${systemData}:${process.env.XDG_DATA_DIRS || "/usr/local/share:/usr/share"}`,
  XDG_CONFIG_HOME: "invalid-relative", XDG_CONFIG_DIRS: config,
  XDG_STATE_HOME: "also-relative", XDG_CACHE_HOME: path.join(temporary, "cache"),
  XDG_RUNTIME_DIR: path.join(temporary, "runtime"), TMPDIR: temporary,
  DBUS_SESSION_BUS_ADDRESS: `unix:path=${temporary}/no-session-bus`,
  PATH: `${bin}:${process.env.PATH}`, KTILER_TEST_ARCHIVE: release.brandedArchive,
};
delete env.DISPLAY;
delete env.WAYLAND_DISPLAY;
for (const directory of [config, bin, env.XDG_RUNTIME_DIR]) await mkdir(directory, { recursive: true, mode: 0o700 });

function run(command, args, extra = {}, errorPattern) {
  const result = spawnSync(command, args, { env: { ...env, ...extra }, encoding: "utf8", timeout: 15000 });
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
const archiveData = await readFile(release.brandedArchive);
const digest = createHash("sha256").update(archiveData).digest("hex");
const archiveUrl = script.match(/download_url='([^']+)'/)[1];
assert.ok(siteFiles.has(new URL(archiveUrl).pathname));
assert.equal(siteFiles.get("/install.sh").source, "dist/install.sh");
assert.ok(script.includes(`archive_sha256='${digest}'`));
run("sh", ["-n", release.installer]);

// Substitute only the transport and KWin's loaded-state reply. Use real KPackage
// and KConfig tools, private XDG directories, and no session bus or network.
await writeFile(path.join(bin, "curl"), `#!/bin/sh
set -eu
while [ "$1" != -o ]; do shift; done
[ "$3" = '${archiveUrl}' ]
cp -- "$KTILER_TEST_ARCHIVE" "$2"
`, { mode: 0o700 });
await writeFile(path.join(bin, "qdbus6"), `#!/bin/sh
[ "$*" = 'org.kde.KWin /Scripting org.kde.kwin.Scripting.isScriptLoaded ktiler' ] || exit 1
printf '%s\\n' "\${KTILER_TEST_LOADED:-false}"
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
await writeFile(kwinrc, disabled);
await writeFile(shortcuts, shortcutConfig);
const metadata = async (directory) => JSON.parse(await readFile(path.join(directory, "metadata.json"), "utf8"));

install({ KTILER_TEST_ARCHIVE: release.archive }, /checksum mismatch/);
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
await rm(icon);
await rm(launcher);
install({ KTILER_TEST_LOADED: "true" });
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
install({ XDG_DATA_HOME: "invalid-relative" });
assert.deepEqual(await metadata(path.join(freshData, "kwin/scripts/ktiler")), branded);
assert.deepEqual(await readFile(path.join(freshData, "icons/hicolor/256x256/apps/ktiler.png")), await readFile(icon));
console.log("Verified both archive variants, checksum rejection, guarded upgrade, and icon/launcher repair.");
