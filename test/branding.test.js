import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildKWin } from "../scripts/build-kwin.mjs";
import { assertSafeUpgrade, installKWin, installPaths, planInstallation } from "../scripts/install-kwin.mjs";
import { reloadKWin } from "../scripts/dev-reload-kwin.mjs";

async function fixture() {
  const temporary = await mkdtemp("/tmp/opencode/ktiler-install-test-");
  const directory = path.join(temporary, "package");
  await buildKWin(directory);
  const paths = {
    packageRoot: path.join(temporary, "data/kwin/scripts"),
    icon: path.join(temporary, "data/icons/hicolor/256x256/apps/ktiler.png"),
    configHome: path.join(temporary, "config"), stateHome: path.join(temporary, "state"),
  };
  return { directory, paths };
}

test("branding package preserves identity and includes original artwork and MIT license", async () => {
  const { directory, paths } = await fixture();
  const metadata = JSON.parse(await readFile(path.join(directory, "metadata.json"), "utf8"));
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
  assert.equal(metadata.KPlugin.Id, "ktiler");
  assert.equal(metadata.KPlugin.Version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[""].version, pkg.version);
  assert.equal(metadata.KPlugin.License, "MIT");
  assert.equal(metadata.KPlugin.EnabledByDefault, false);
  assert.deepEqual(metadata.KPlugin.Authors, [{ Name: "Jordan Arsenault", Website: "https://jordanarseno.com" }]);
  for (const name of ["ktiler-icon.png", "ktiler-logo-w-text.png"]) {
    assert.deepEqual(await readFile(path.join(directory, "contents/images", name)), await readFile(new URL(`../${name}`, import.meta.url)));
  }
  assert.deepEqual(await readFile(path.join(directory, "LICENSE.md")), await readFile(new URL("../LICENSE.md", import.meta.url)));
  const ui = await readFile(path.join(directory, "contents/ui/config.ui"), "utf8");
  assert.ok(!ui.includes("@@KTILER_WORDMARK_DATA@@"));
  assert.ok(ui.includes((await readFile(new URL("../ktiler-logo-w-text.png", import.meta.url))).toString("base64")));
  for (const link of ["https://ktiler.org/help#shortcuts", "https://ktiler.org/help#layouts", "https://ktiler.org/help#spread-resize",
    "https://ktiler.org/help", "https://ktiler.org", "https://github.com/jars/ktiler"]) assert.ok(ui.includes(link), link);
  assert.ok(ui.includes("GitHub: PRs &amp;amp; Issues"), "GitHub link label");
  assert.ok(!ui.includes("&gt;Learn more&lt;"), "Learn more link labels should be replaced by ? links");
  assert.equal((await planInstallation(directory, paths)).upgrade, false);
});

test("installer recognizes a branding-only upgrade and detects runtime/configuration changes", async () => {
  const { directory, paths } = await fixture();
  const installed = path.join(paths.packageRoot, "ktiler");
  await cp(directory, installed, { recursive: true });
  const metadata = JSON.parse(await readFile(path.join(installed, "metadata.json"), "utf8"));
  metadata.KPlugin.Version = "0.1.0";
  metadata.KPlugin.Description = "Previous branding";
  await writeFile(path.join(installed, "metadata.json"), JSON.stringify(metadata));
  await writeFile(path.join(installed, "contents/ui/config.ui"), "<ui/>");
  let plan = await planInstallation(directory, paths);
  assert.equal(plan.upgrade, true);
  assert.equal(plan.runtimeChanged, false);
  assert.doesNotThrow(() => assertSafeUpgrade(plan, { enabled: true, loaded: true }));
  await writeFile(path.join(installed, "contents/code/main.js"), "// Different running code\n");
  plan = await planInstallation(directory, paths);
  assert.equal(plan.runtimeChanged, true);
  for (const state of [{ enabled: true, loaded: true }, { enabled: false, loaded: true }, { enabled: true, loaded: false }, { enabled: false, loaded: null }]) {
    assert.throws(() => assertSafeUpgrade(plan, state), /disable/);
  }
  assert.doesNotThrow(() => assertSafeUpgrade(plan, { enabled: false, loaded: false }));
  await cp(path.join(directory, "contents/code/main.js"), path.join(installed, "contents/code/main.js"));
  await writeFile(path.join(installed, "contents/config/main.xml"), "<kcfg/>");
  assert.equal((await planInstallation(directory, paths)).runtimeChanged, true);
});

test("installer backs up package/configuration/icon without changing settings or controlling KWin", async () => {
  const { directory, paths } = await fixture();
  await cp(directory, path.join(paths.packageRoot, "ktiler"), { recursive: true });
  const metadataFile = path.join(paths.packageRoot, "ktiler/metadata.json");
  const metadata = JSON.parse(await readFile(metadataFile, "utf8"));
  metadata.KPlugin.Version = "0.1.0";
  await writeFile(metadataFile, JSON.stringify(metadata));
  await mkdir(paths.configHome, { recursive: true });
  await mkdir(path.dirname(paths.icon), { recursive: true });
  const settings = "[Plugins]\nktilerEnabled=true\n[Script-ktiler]\nModifier=Meta\nDefaultLayout=columns\n";
  const shortcuts = "[kwin]\nktiler-Layout-columns=Meta+V,Alt+V,ktiler\n";
  await writeFile(path.join(paths.configHome, "kwinrc"), settings);
  await writeFile(path.join(paths.configHome, "kglobalshortcutsrc"), shortcuts);
  await writeFile(paths.icon, "old icon");
  const commands = [];
  const { backup } = await installKWin(await planInstallation(directory, paths), {
    run(command, args) { commands.push([command, args]); return ""; },
  });
  assert.deepEqual(commands.map(([command]) => command), ["kpackagetool6"]);
  assert.ok(commands[0][1].includes("--upgrade"));
  assert.equal(await readFile(path.join(paths.configHome, "kwinrc"), "utf8"), settings);
  assert.equal(await readFile(path.join(paths.configHome, "kglobalshortcutsrc"), "utf8"), shortcuts);
  assert.equal(await readFile(path.join(backup, "kwinrc"), "utf8"), settings);
  assert.equal(await readFile(path.join(backup, "kglobalshortcutsrc"), "utf8"), shortcuts);
  assert.equal(await readFile(path.join(backup, "ktiler.png"), "utf8"), "old icon");
  assert.deepEqual(await readFile(path.join(backup, "installed-ktiler/contents/code/main.js")), await readFile(path.join(directory, "contents/code/main.js")));
  assert.deepEqual(await readFile(paths.icon), await readFile(path.join(directory, "contents/images/ktiler-icon.png")));
});

test("reinstalling an identical package can repair its icon without a KPackage upgrade", async () => {
  const { directory, paths } = await fixture();
  await cp(directory, path.join(paths.packageRoot, "ktiler"), { recursive: true });
  const plan = await planInstallation(directory, paths);
  assert.equal(plan.packageUnchanged, true);
  await installKWin(plan, { run() { assert.fail("Identical package must not trigger a package upgrade or D-Bus calls"); } });
  assert.deepEqual(await readFile(paths.icon), await readFile(path.join(directory, "contents/images/ktiler-icon.png")));
});

test("installer refuses active runtime upgrades before backing up or running package tools", async () => {
  const { directory, paths } = await fixture();
  await cp(directory, path.join(paths.packageRoot, "ktiler"), { recursive: true });
  await writeFile(path.join(paths.packageRoot, "ktiler/contents/code/main.js"), "// changed");
  const commands = [];
  await assert.rejects(installKWin(await planInstallation(directory, paths), {
    run(command) { commands.push(command); return "true"; },
  }), /disable/);
  assert.deepEqual(commands, ["kreadconfig6", "qdbus6"]);
});

test("developer reload leaves ktiler disabled if installation fails", async () => {
  const { directory, paths } = await fixture();
  const installed = path.join(paths.packageRoot, "ktiler");
  await cp(directory, installed, { recursive: true });
  await writeFile(path.join(installed, "contents/code/main.js"), "// Older script\n");
  const writes = [];
  let enabled = true;
  let loaded = true;
  await assert.rejects(reloadKWin(directory, {
    paths,
    run(command, args) {
      if (command === "kwriteconfig6") {
        writes.push(args.at(-1));
        enabled = args.at(-1) === "true";
      } else if (command === "qdbus6" && args.at(-1) === "org.kde.kwin.Scripting.start") {
        loaded = enabled;
      } else if (command === "qdbus6") {
        return String(loaded);
      } else if (command === "kreadconfig6") {
        return String(enabled);
      } else if (command === "kpackagetool6") {
        assert.equal(loaded, false);
        throw new Error("package installation failed");
      } else {
        assert.fail(`Unexpected command: ${command}`);
      }
    },
  }), /left disabled.*package installation failed/);
  assert.deepEqual(writes, ["false"]);
  assert.equal(loaded, false);
});

test("installer respects absolute XDG paths and ignores invalid relative overrides", () => {
  const paths = installPaths({ XDG_DATA_HOME: "/tmp/opencode/private-data", XDG_CONFIG_HOME: "/tmp/opencode/private-config", XDG_STATE_HOME: "/tmp/opencode/private-state" });
  assert.equal(paths.packageRoot, "/tmp/opencode/private-data/kwin/scripts");
  assert.equal(paths.configHome, "/tmp/opencode/private-config");
  assert.equal(paths.stateHome, "/tmp/opencode/private-state");
  assert.ok(path.isAbsolute(installPaths({ XDG_DATA_HOME: "relative" }).packageRoot));
});
