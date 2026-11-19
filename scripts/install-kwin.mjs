import { cp, lstat, mkdir, mkdtemp, readFile, readdir, utimes, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const launcherName = "org.ktiler.Settings.desktop";
const launcherSource = `contents/ui/${launcherName}`;
const runCommand = (command, args) => execFileSync(command, args, { encoding: "utf8", timeout: 30000 }).trim();
async function exists(file) {
  try { await lstat(file); return true; } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
async function manifest(directory) {
  const result = {};
  async function visit(relative = "") {
    for (const entry of (await readdir(path.join(directory, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile()) result[name] = createHash("sha256").update(await readFile(path.join(directory, name))).digest("hex");
      else throw new Error(`Refusing non-regular package entry: ${path.join(directory, name)}`);
    }
  }
  await visit();
  return result;
}

export function installPaths(environment = process.env) {
  const xdg = (variable, fallback) => path.isAbsolute(environment[variable] || "") ? environment[variable] : path.join(homedir(), fallback);
  const data = xdg("XDG_DATA_HOME", ".local/share");
  return {
    packageRoot: path.join(data, "kwin/scripts"),
    icon: path.join(data, "icons/hicolor/256x256/apps/ktiler.png"),
    launcher: path.join(data, "applications", launcherName),
    configHome: xdg("XDG_CONFIG_HOME", ".config"),
    stateHome: xdg("XDG_STATE_HOME", ".local/state"),
  };
}

export async function planInstallation(directory, paths = installPaths()) {
  const metadata = JSON.parse(await readFile(path.join(directory, "metadata.json"), "utf8"));
  if (metadata.KPlugin?.Id !== "ktiler" || metadata.KPlugin?.Icon !== "ktiler"
      || metadata.KPlugin?.EnabledByDefault !== false || metadata["X-Plasma-MainScript"] !== "code/main.js"
      || metadata.KPackageStructure !== "KWin/Script") {
    throw new Error("Unexpected package identity or defaults; build ktiler first.");
  }
  const source = await manifest(directory);
  for (const required of ["contents/code/main.js", "contents/code/bindings.js", "contents/code/SettingsWorker.qml",
    "contents/code/SettingsWatcher.qml", "contents/config/main.xml", "contents/ui/config.ui",
    "contents/images/ktiler-icon.png", "contents/images/ktiler-logo-w-text.png", launcherSource, "LICENSE.md"]) {
    if (!source[required]) throw new Error(`Incomplete package: ${required}; run npm run build:kwin.`);
  }
  const ui = await readFile(path.join(directory, "contents/ui/config.ui"), "utf8");
  if (ui.includes("@@KTILER_WORDMARK_DATA@@") || !ui.includes("data:image/png;base64,")) {
    throw new Error("Wordmark has not been embedded; run npm run build:kwin.");
  }
  const installed = path.join(paths.packageRoot, "ktiler");
  const upgrade = await exists(installed);
  let runtimeChanged = false;
  let packageUnchanged = false;
  if (upgrade) {
    if (!(await lstat(installed)).isDirectory()) throw new Error(`Refusing non-directory installation: ${installed}`);
    const previous = await manifest(installed);
    packageUnchanged = JSON.stringify(source) === JSON.stringify(previous);
    const oldMetadata = JSON.parse(await readFile(path.join(installed, "metadata.json"), "utf8"));
    if (oldMetadata.KPlugin?.Id !== "ktiler") throw new Error("Installed plugin has an unexpected identity.");
    // Only presentation metadata, images, and UI may change while the instance is running.
    const runtime = (files) => Object.fromEntries(Object.entries(files).filter(([name]) =>
      name.startsWith("contents/") && !name.startsWith("contents/images/") && !name.startsWith("contents/ui/")));
    const runtimeMetadata = ({ KPlugin, ...rest }) => ({ ...rest, Id: KPlugin.Id, EnabledByDefault: KPlugin.EnabledByDefault });
    runtimeChanged = JSON.stringify(runtime(source)) !== JSON.stringify(runtime(previous))
      || JSON.stringify(runtimeMetadata(metadata)) !== JSON.stringify(runtimeMetadata(oldMetadata));
  }
  return { directory, installed, upgrade, runtimeChanged, packageUnchanged, version: metadata.KPlugin.Version, ...paths };
}

export function assertSafeUpgrade(plan, { enabled, loaded }) {
  if (plan.upgrade && plan.runtimeChanged && (enabled !== false || loaded !== false)) {
    throw new Error("Runtime code/configuration changed. Restore/pause ktiler, disable it in KWin Scripts and Apply first. "
      + "The installer will not stop your running script or restart KWin.");
  }
}

export async function installKWin(plan, { run = runCommand } = {}) {
  if (plan.runtimeChanged) {
    const enabledResponse = run("kreadconfig6", ["--file", path.join(plan.configHome, "kwinrc"), "--group", "Plugins",
      "--key", "ktilerEnabled", "--default", "false"]);
    const enabled = ["true", "false"].includes(enabledResponse) ? enabledResponse === "true" : null;
    let loaded = null;
    try {
      const response = run("qdbus6", ["org.kde.KWin", "/Scripting", "isScriptLoaded", "ktiler"]);
      if (response === "true" || response === "false") loaded = response === "true";
    } catch { /* Unknown state fails closed for runtime-changing upgrades. */ }
    assertSafeUpgrade(plan, { enabled, loaded });
  }
  const backupRoot = path.join(plan.stateHome, "ktiler/backups");
  await mkdir(backupRoot, { recursive: true });
  const backup = await mkdtemp(path.join(backupRoot, `${new Date().toISOString().replaceAll(":", "-")}-`));
  for (const [source, name] of [
    [plan.installed, "installed-ktiler"], [plan.icon, "ktiler.png"],
    [plan.launcher, launcherName],
    [path.join(plan.configHome, "kwinrc"), "kwinrc"],
    [path.join(plan.configHome, "kglobalshortcutsrc"), "kglobalshortcutsrc"],
  ]) {
    if (await exists(source)) await cp(source, path.join(backup, name), { recursive: true });
  }
  await writeFile(path.join(backup, "installation.json"), JSON.stringify(plan, null, 2) + "\n");
  console.log(`Backup: ${backup}`);
  await mkdir(plan.packageRoot, { recursive: true });
  if (!plan.packageUnchanged) {
    run("kpackagetool6", ["--type=KWin/Script", "--packageroot", plan.packageRoot,
      plan.upgrade ? "--upgrade" : "--install", plan.directory]);
  }
  await mkdir(path.dirname(plan.icon), { recursive: true });
  await cp(path.join(plan.directory, "contents/images/ktiler-icon.png"), plan.icon);
  await mkdir(path.dirname(plan.launcher), { recursive: true });
  await cp(path.join(plan.directory, launcherSource), plan.launcher);
  // Qt/KDE watch theme-directory timestamps; no global theme/index files are modified.
  const now = new Date();
  await utimes(path.resolve(path.dirname(plan.icon), "../.."), now, now);
  console.log(`Installed ktiler ${plan.version} and its themed icon. Search the Application Launcher for "ktiler Settings".`);
  console.log("Plugin enablement, settings, shortcuts, and the running instance were not changed.");
  return { backup };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.some((argument) => !["--apply", "--help"].includes(argument))) throw new Error("Use --help or --apply.");
    if (args.includes("--help")) {
      console.log("npm run install:kwin             Preview installation (no changes)\n"
        + "npm run install:kwin -- --apply  Install/upgrade the built package, icon, and settings launcher, with backups\n"
        + "Build and test first. Never enables, disables, or reloads ktiler.");
    } else {
      const plan = await planInstallation(path.join(root, "dist/ktiler"));
      console.log(`${plan.upgrade ? "Upgrade" : "Install"} ktiler ${plan.version}: ${plan.installed}\nIcon: ${plan.icon}\n`
        + `Settings launcher: ${plan.launcher}\n`
        + (plan.upgrade ? `Runtime code/configuration: ${plan.runtimeChanged ? "changed; script must be disabled and unloaded" : "unchanged; no reload needed"}\n` : ""));
      if (args.includes("--apply")) await installKWin(plan);
      else console.log("Preview only. Run npm run install:kwin -- --apply after testing.");
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
