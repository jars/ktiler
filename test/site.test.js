import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import test from "node:test";

test("the website serves a scripted preview, simulator, and Help with shared navigation", async (t) => {
  const server = spawn(process.execPath, [new URL("../server.mjs", import.meta.url).pathname], {
    env: { ...process.env, HOST: "127.0.0.1", PORT: "0" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  t.after(async () => {
    if (server.exitCode !== null || server.signalCode !== null) return;
    const exited = once(server, "exit");
    server.kill();
    await exited;
  });

  const stdout = createInterface({ input: server.stdout });
  const [message] = await Promise.race([
    once(stdout, "line", { signal: AbortSignal.timeout(5000) }),
    once(server, "exit").then(() => assert.fail("Preview server exited before listening")),
  ]);
  const origin = message.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  assert.ok(origin, message);

  const get = (path, options) => fetch(`${origin}${path}`, options);
  assert.equal((await get("/keycaps")).status, 404);
  const keycaps = await get("/keycaps.css");
  assert.equal(keycaps.status, 200);
  assert.match(keycaps.headers.get("content-type"), /^text\/css/);
  assert.match(await keycaps.text(), /Copyright \(c\) 2013 Peiwen Lu[\s\S]*Permission is hereby granted/);
  const home = await (await get("/")).text();
  assert.match(home, /Automatic window tiling for KDE Plasma/);
  assert.match(home, /Make room for what’s next\./);
  assert.match(home, /href="\/simulator\/"/);
  const install = home.match(/<section class="install-section" id="install"[\s\S]*?<\/section>/)?.[0];
  assert.ok(install);
  assert.match(install, /Requires KDE Plasma 6\.3 or newer in a Wayland session/);
  const [primary, file] = install.split('<div class="install-file">');
  assert.match(primary, /Install from a terminal[\s\S]*Recommended/);
  assert.match(primary, /backs up existing settings[\s\S]*app launcher[\s\S]*shortcut conflicts before enabling ktiler/);
  assert.match(primary, /adds a <strong>system tray toggle<\/strong>[\s\S]*click to switch/);
  assert.match(primary, /rearrange your open windows[\s\S]*without <code>sudo<\/code>/);
  assert.match(primary, /<code>curl -fsSL https:\/\/ktiler\.org\/install\.sh <span[^>]*>\| sh<\/span><\/code>[\s\S]*href="\/install\.sh"/);
  assert.match(primary, /<span>Terminal<\/span>\s*<svg class="install-terminal-controls"[^>]*aria-hidden="true"/);
  assert.doesNotMatch(primary, /install-terminal-tab/);
  assert.match(primary, /class="install-terminal-pane"[\s\S]*<button class="install-terminal-copy" type="button" disabled>[\s\S]*?Copy command\s*<\/button>/);
  assert.match(primary, /<noscript>Select the command to copy it manually\.<\/noscript>/);
  assert.match(primary, /role="status"/);
  assert.doesNotMatch(primary, /Updating|href="\/ktiler\.kwinscript"/);
  assert.match(file, /Install from File[\s\S]*href="\/ktiler\.kwinscript" download[\s\S]*Tick <strong>ktiler<\/strong> and click <strong>Apply<\/strong>/);
  assert.match(file, /without the tray toggle/);
  assert.match(file, /Updating from a file\?[\s\S]*untick it in <strong>KWin Scripts<\/strong> and click <strong>Apply<\/strong>/);
  assert.doesNotMatch(install, /Setup not finished\?/);
  assert.match(home, /src="\/showcase\.js"/);
  assert.match(home, /src="\/install-terminal\.js"/);
  assert.match(home, /href="\/keycaps\.css"/);
  assert.doesNotMatch(home, /<kbd(?! class="keycap")/);
  const monitorShortcuts = home.match(/<section[^>]*aria-labelledby="monitors-title"[\s\S]*?<\/section>/)?.[0];
  assert.ok(monitorShortcuts);
  assert.deepEqual([...monitorShortcuts.matchAll(/<span class="keycap-face">([^<]+)<\/span>/g)].map((match) => match[1]),
    ["Alt", "Shift", "W", "A", "S", "D"]);
  assert.match(home, /Install <strong>ktiler<\/strong>/);
  assert.match(home, /<nav aria-label="Main">\s*<a href="\/" aria-current="page">Home<\/a>\s*<a href="#install">Install<\/a>/);
  assert.match(home, /class="tiling-tip showcase-keypress" hidden/);
  assert.match(home, /href="\/window-apps\.css"/);
  assert.doesNotMatch(home, /showcase-controls|Play demo|Pause animation/);
  assert.doesNotMatch(home, /src="\/app\.js"/);
  assert.doesNotMatch(home, /desktop-(?:before|after)/);
  const header = (page) => page.match(/<header class="site-header page-width">[\s\S]*?<\/header>/)?.[0]
    ?.replace(' aria-current="page"', "").replace('href="#install"', 'href="/#install"');
  assert.ok(header(home));
  const simulator = await (await get("/simulator/")).text();
  for (const page of [simulator, await (await get("/simulator")).text()]) {
    assert.match(page, /<main class="simulator page-width"/);
    assert.match(page, /id="workspace"/);
    assert.match(page, /href="\/keycaps\.css"/);
    assert.match(page, /href="\/window-apps\.css"/);
    assert.doesNotMatch(page.match(/<[^>]+id="workspace"[^>]*>/)[0], /\btabindex\b/i);
    assert.match(page, /src="\/app\.js"/);
    assert.match(page, /href="\/simulator\/" aria-current="page"/);
    assert.equal(header(page), header(home));
    assert.doesNotMatch(page, /class="footer-credit"/);
  }
  const help = await (await get("/help/")).text();
  assert.equal(header(help), header(home));
  assert.match(help, /href="\/keycaps\.css"/);
  const shortcuts = help.match(/<section id="shortcuts"[\s\S]*?<\/section>/)?.[0];
  assert.ok(shortcuts);
  assert.match(shortcuts, /aria-label="Direction keys: W up, A left, S down, D right"/);
  assert.deepEqual([...shortcuts.matchAll(/data-direction="(\w+)"[^>]*><span class="keycap-face">([WASD])<\/span>/g)]
    .map(([, direction, legend]) => [direction, legend]), [["up", "W"], ["left", "A"], ["down", "S"], ["right", "D"]]);
  assert.doesNotMatch(help, /<kbd(?! class="keycap")/);
  const independentShortcuts = [...shortcuts.matchAll(/<dt>([^<]+)<\/dt>\s*<dd>([\s\S]*?)<\/dd>/g)]
    .map(([, label, chord]) => [label, [...chord.matchAll(/<span class="keycap-face">([^<]+)<\/span>/g)]
      .map((match) => match[1]).join("+")]);
  assert.deepEqual(independentShortcuts.slice(2), [
    ["Binary layout", "Alt+Shift+1"], ["Columns layout", "Alt+Shift+2"], ["Rows layout", "Alt+Shift+3"],
    ["Rotate right", "Alt+Shift+R"], ["Rotate left", "Alt+Shift+E"],
    ["Pause / resume tiling", "Alt+Shift+K"],
  ]);
  for (const page of [home, help]) {
    const footer = page.match(/<footer class="site-footer page-width">[\s\S]*?<\/footer>/)?.[0];
    assert.ok(footer);
    assert.match(footer, /class="brand"[\s\S]*?<p class="footer-credit">[\s\S]*?<nav aria-label="Footer">/);
    assert.match(footer, /© 2026 <a href="https:\/\/jordanarseno\.com">Jordan Arsenault<\/a>/);
    assert.match(footer, /href="\/LICENSE\.md">MIT License<\/a>/);
  }
  for (const id of ["compatibility", "setup", "shortcuts", "layouts", "spread-resize"]) {
    assert.ok(help.includes(`id="${id}"`), `Missing help section: ${id}`);
  }
  assert.match(help, /To enable manually:[\s\S]*tick <strong>ktiler<\/strong>[\s\S]*close and reopen System Settings/);
  const compatibility = help.match(/<section id="compatibility"[\s\S]*?<\/section>/)?.[0];
  assert.ok(compatibility);
  assert.match(compatibility, /Kubuntu 26\.04 LTS[\s\S]*Fedora KDE Plasma Desktop[\s\S]*KDE neon[\s\S]*openSUSE Leap 16\.0[\s\S]*Debian 13/);
  assert.match(compatibility, /About this System[\s\S]*Graphics Platform: Wayland/);
  assert.match(compatibility, /plasmashell --version[\s\S]*XDG_SESSION_TYPE/);
  for (const name of ["showcase", "display-view", "window-previews", "keycaps", "install-terminal"]) {
    const module = await get(`/${name}.js`, { method: "HEAD" });
    assert.equal(module.status, 200);
    assert.match(module.headers.get("content-type"), /^text\/javascript/);
  }
  const previews = await (await get("/window-previews.js")).text();
  assert.match(previews, /class="browser-address">https:\/\/ktiler\.org</);
  const browserTabs = previews.match(/class="browser-tabs">([\s\S]*?)<span class="app-bar browser-toolbar"/)?.[1];
  assert.ok(browserTabs, "Chrome has a tab strip above the toolbar");
  assert.match(browserTabs, /class="browser-tab browser-tab-active">\s*<img [^>]*src="\/ktiler-icon\.png"/);
  assert.match(browserTabs, /ktiler<span class="browser-tab-context"[\s\S]*?"browser-tab-close"/);
  assert.match(browserTabs, /Window Shopping[\s\S]*?How to Exit Vim[\s\S]*?"browser-tab-add"/);
  assert.match(previews, /class="browser-home-monitors"/);
  const artwork = previews.match(/class="image-canvas">\s*(<svg\b[\s\S]*?<\/svg>)/)?.[1];
  assert.ok(artwork, "The Image Editor has an SVG artboard");
  assert.match(artwork, /preserveAspectRatio="xMidYMid meet"/);
  assert.match(artwork, /class="image-ridge"[\s\S]*?<circle\b[\s\S]*?class="image-guides"/);
  const logo = await get("/kde-icon.png", { method: "HEAD" });
  assert.equal(logo.status, 200);
  assert.equal(logo.headers.get("content-type"), "image/png");
  const credits = await (await get("/THIRD-PARTY.md")).text();
  assert.match(credits, /KDE Press Kit/);
  assert.match(credits, /Peiwen Lu’s[\s\S]*https:\/\/codepen\.io\/P233\/pen\/nqrawW[\s\S]*MIT/);
  assert.match(await (await get("/licenses/LGPL-2.1.txt")).text(), /GNU LESSER GENERAL PUBLIC LICENSE/);
  const logoSource = await get("/licenses/kde-logo-blue-transparent-source.svg", { method: "HEAD" });
  assert.equal(logoSource.status, 200);
  assert.equal(logoSource.headers.get("content-type"), "image/svg+xml");
  const errorPage = await (await get("/404.html")).text();
  assert.match(errorPage, /<h1>Page not found<\/h1>/);
  assert.match(errorPage, /<meta name="robots" content="noindex">/);
  assert.equal((await get("/package.json")).status, 404);

  await t.test("crawler files and structured data agree on the canonical pages", async () => {
    const site = "https://ktiler.org";
    const pages = [
      ["/", home, ["WebSite", "WebPage", "SoftwareApplication", "SoftwareSourceCode"]],
      ["/simulator/", simulator, ["WebPage", "WebApplication"]],
      ["/help/", help, ["TechArticle"]],
    ];
    const byId = new Map();
    for (const [path, html, types] of pages) {
      assert.equal(html.match(/<link rel="canonical" href="([^"]+)">/)?.[1], site + path);
      assert.match(html, /<link rel="describedby" href="\/llms\.txt">/);
      assert.match(html, /<meta name="description" content="[^"]+">/);
      assert.doesNotMatch(html, /href="\/(?:help|simulator)(?=["#])/);
      const schema = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1]);
      assert.equal(schema["@context"], "https://schema.org");
      const nodes = schema["@graph"] ?? [schema];
      assert.deepEqual(nodes.map((node) => node["@type"]), types);
      for (const node of nodes) {
        if (node["@type"] !== "SoftwareSourceCode") assert.equal(node.url, site + path);
        assert.ok(node["@id"].startsWith(`${site}${path}#`));
        assert.ok(!byId.has(node["@id"]));
        byId.set(node["@id"], node);
      }
    }

    const desktop = byId.get(`${site}/#ktiler`);
    const demo = byId.get(`${site}/simulator/#demo`);
    const guide = byId.get(`${site}/help/#guide`);
    const source = byId.get(`${site}/#source`);
    assert.equal(desktop.softwareHelp["@id"], guide["@id"]);
    assert.equal(desktop.installUrl, `${site}/#install`);
    assert.equal(desktop.downloadUrl, undefined);
    assert.deepEqual(desktop.author, {
      "@type": "Person",
      "@id": `${site}/#jordan-arsenault`,
      name: "Jordan Arsenault",
      url: "https://jordanarseno.com",
    });
    assert.deepEqual(guide.author, desktop.author);
    assert.equal(source.codeRepository, "https://github.com/jars/ktiler");
    assert.equal(source.targetProduct["@id"], desktop["@id"]);
    assert.equal(demo.about["@id"], desktop["@id"]);
    assert.equal(guide.about["@id"], desktop["@id"]);
    assert.equal(demo.softwareRequirements, undefined);

    const robots = await get("/robots.txt");
    assert.equal(robots.status, 200);
    assert.match(robots.headers.get("content-type"), /^text\/plain\b/);
    assert.match(await robots.text(), /^User-agent: \*\nAllow: \/\n\nSitemap: https:\/\/ktiler\.org\/sitemap\.xml\s*$/);

    const sitemap = await get("/sitemap.xml");
    assert.equal(sitemap.status, 200);
    assert.match(sitemap.headers.get("content-type"), /^application\/xml\b/);
    const xml = await sitemap.text();
    assert.match(xml, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
    assert.deepEqual([...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(([, url]) => url),
      pages.map(([path]) => site + path));

    const llms = await get("/llms.txt");
    assert.equal(llms.status, 200);
    assert.match(llms.headers.get("content-type"), /^text\/plain\b/);
    const text = await llms.text();
    assert.match(text, /^# ktiler\n\n> /);
    assert.match(text, /KDE Plasma 6\.3 or newer in a Wayland session/);
    for (const path of ["/#install", "/simulator/", "/help/", "/help/#compatibility"]) {
      assert.ok(text.includes(`](${site}${path})`), `Missing llms.txt link to ${path}`);
    }
  });
});
