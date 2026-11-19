import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { installKWin, installPaths, planInstallation } from "./install-kwin.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const runCommand = (command, args) => execFileSync(command, args, { encoding: "utf8", timeout: 30000 }).trim();

export async function reloadKWin(directory, { paths = installPaths(), run = runCommand } = {}) {
  // Validate the package and the live session before changing any settings.
  const plan = await planInstallation(directory, paths);
  if (!plan.upgrade) throw new Error("Install ktiler normally before using the developer reload command.");
  const scripting = (method, ...args) =>
    run("qdbus6", ["org.kde.KWin", "/Scripting", `org.kde.kwin.Scripting.${method}`, ...args]);
  function isLoaded() {
    const status = scripting("isScriptLoaded", "ktiler");
    if (status !== "true" && status !== "false") throw new Error("Could not determine whether ktiler is loaded.");
    return status === "true";
  }
  async function setEnabled(enabled) {
    run("kwriteconfig6", ["--file", path.join(paths.configHome, "kwinrc"),
      "--group", "Plugins", "--key", "ktilerEnabled", "--type", "bool", String(enabled)]);
    scripting("start"); // Same D-Bus call used by Apply in KWin Scripts.
    for (let i = 0; i < 50; i++) {
      if (isLoaded() === enabled) return;
      await delay(100);
    }
    throw new Error(`Timed out waiting for KWin to ${enabled ? "load" : "unload"} ktiler.`);
  }

  isLoaded();
  await setEnabled(false);
  try {
    await installKWin(plan, { run });
  } catch (error) {
    throw new Error(`Install failed; ktiler was left disabled. ${error.message}`, { cause: error });
  }
  try {
    await setEnabled(true);
  } catch (error) {
    throw new Error(`Installed ktiler, but could not verify it loaded. Check KWin Scripts. ${error.message}`, { cause: error });
  }
  console.log(`ktiler ${plan.version} reloaded.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === "--help") {
      console.log("npm run dev:reload-kwin  Rebuild and upgrade ktiler on your running Plasma Wayland desktop.");
    } else {
      if (args.length) throw new Error("Usage: npm run dev:reload-kwin");
      if (process.getuid?.() === 0 || process.env.XDG_SESSION_TYPE !== "wayland") {
        throw new Error("Run this as your normal user from a Plasma Wayland session, without sudo.");
      }
      execFileSync(process.execPath, [path.join(root, "scripts/build-kwin.mjs")], { stdio: "inherit", timeout: 30000 });
      await reloadKWin(path.join(root, "dist/ktiler"));
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
