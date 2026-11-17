import { mkdtemp, mkdir, writeFile, chmod } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp("/tmp/opencode/kdetiler-native-");
for (const name of ["runtime", "config", "data", "cache", "state"]) {
  await mkdir(path.join(temporary, name));
}
await chmod(path.join(temporary, "runtime"), 0o700);
const libexec = execFileSync("pkg-config", ["--variable=libexecdir", "Qt6Core"], { encoding: "utf8" }).trim();
const flags = execFileSync("pkg-config", ["--cflags", "--libs", "Qt6Widgets", "Qt6DBus", "wayland-client"], { encoding: "utf8" }).trim().split(/\s+/);
execFileSync(path.join(libexec, "moc"), [path.join(root, "test/native/harness.cpp"), "-o", path.join(temporary, "harness.moc")]);
execFileSync("g++", ["-std=c++17", "-fPIC", `-I${temporary}`, path.join(root, "test/native/harness.cpp"), "-o", path.join(temporary, "harness"), ...flags]);
await writeFile(path.join(temporary, "config/kwinrc"),
  "[Script-kdetiler-test]\nRegisterShortcuts=true\n[Plugins]\nplasmazonesEnabled=false\nkwin_effect_plasmazonesEnabled=false\n"
  + "[org.kde.kdecoration3]\nlibrary=org.kde.breeze\n");
const environment = {
  ...process.env, KDETILER_ISOLATED: "1", KDETILER_TEST_ROOT: temporary,
  XDG_RUNTIME_DIR: path.join(temporary, "runtime"),
  XDG_CONFIG_HOME: path.join(temporary, "config"), XDG_DATA_HOME: path.join(temporary, "data"),
  XDG_CACHE_HOME: path.join(temporary, "cache"), XDG_STATE_HOME: path.join(temporary, "state"),
  XDG_CONFIG_DIRS: path.join(temporary, "config"),
  QT_QPA_PLATFORMTHEME: "", QT_STYLE_OVERRIDE: "Fusion", QT_NO_XDG_DESKTOP_PORTAL: "1",
  XDG_CURRENT_DESKTOP: "",
};
delete environment.DBUS_SESSION_BUS_ADDRESS;
delete environment.DISPLAY;
delete environment.WAYLAND_DISPLAY;
console.log(`Private KWin test directory: ${temporary}`);
const child = spawn("dbus-run-session", ["--", process.execPath, path.join(root, "scripts/nested-session.mjs")], {
  env: environment, stdio: "inherit",
});
child.on("exit", (code) => { process.exitCode = code ?? 1; });
