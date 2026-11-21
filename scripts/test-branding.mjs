import { mkdtemp, mkdir, cp, chmod, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildKWin } from "./build-kwin.mjs";
import { installPaths, installKWin, planInstallation } from "./install-kwin.mjs";
import assert from "node:assert/strict";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(path.resolve(tmpdir(), "ktiler-branding-test-"));
const environment = { ...process.env, KTILER_ISOLATED: "1" };
for (const [variable, name] of Object.entries({
  XDG_CONFIG_HOME: "config", XDG_DATA_HOME: "data", XDG_CACHE_HOME: "cache",
  XDG_STATE_HOME: "state", XDG_RUNTIME_DIR: "runtime",
})) {
  environment[variable] = path.join(temporary, name);
  await mkdir(environment[variable]);
}
await chmod(environment.XDG_RUNTIME_DIR, 0o700);
Object.assign(environment, {
  XDG_CONFIG_DIRS: environment.XDG_CONFIG_HOME, QT_QPA_PLATFORM: "offscreen",
  QT_QPA_PLATFORMTHEME: "kde", QT_STYLE_OVERRIDE: "Fusion", QT_NO_XDG_DESKTOP_PORTAL: "1",
  XDG_CURRENT_DESKTOP: "KDE",
});
for (const key of ["DBUS_SESSION_BUS_ADDRESS", "DISPLAY", "WAYLAND_DISPLAY"]) delete environment[key];
const { directory } = await buildKWin(path.join(temporary, "package"));
console.log(`Private branding test directory: ${temporary}`);
// Exercise real KPackage installation and upgrade without touching the live desktop.
const paths = installPaths(environment);
const previous = path.join(temporary, "previous");
await cp(directory, previous, { recursive: true });
const metadata = JSON.parse(await readFile(path.join(previous, "metadata.json"), "utf8"));
metadata.KPlugin.Version = "0.1.0";
await writeFile(path.join(previous, "metadata.json"), JSON.stringify(metadata));
const run = (command, args) => execFileSync("dbus-run-session", ["--", command, ...args], {
  env: environment, encoding: "utf8", timeout: 30000,
}).trim();
const config = "[Plugins]\nktilerEnabled=true\n[Script-ktiler]\nShortcutLayoutColumns=Meta+X\nDefaultLayout=columns\n";
await writeFile(path.join(environment.XDG_CONFIG_HOME, "kwinrc"), config);
await installKWin(await planInstallation(previous, paths), { run });
const upgrade = await planInstallation(directory, paths);
assert.equal(upgrade.runtimeChanged, false);
await installKWin(upgrade, { run });
const identical = await planInstallation(directory, paths);
assert.equal(identical.packageUnchanged, true);
await installKWin(identical, { run() { assert.fail("Identical packages should not invoke KPackage"); } });
assert.equal(await readFile(path.join(environment.XDG_CONFIG_HOME, "kwinrc"), "utf8"), config);
execFileSync("cmake", ["-S", path.join(root, "test/native"), "-B", path.join(temporary, "build")], { stdio: "inherit" });
execFileSync("cmake", ["--build", path.join(temporary, "build"), "--parallel", "2"], { stdio: "inherit" });
const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
execFileSync("dbus-run-session", ["--", path.join(temporary, "build/branding"), upgrade.installed, temporary, version], {
  env: environment, stdio: "inherit",
});
console.log(`Light/dark Configure previews: ${temporary}/{configure,shortcuts}-{light,dark}.png`);
