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
  const home = await (await get("/")).text();
  assert.match(home, /Automatic window tiling for KDE Plasma/);
  assert.match(home, /Make room for what’s next\./);
  assert.match(home, /href="\/simulator"/);
  assert.match(home, /href="\/ktiler\.kwinscript" download/);
  const install = home.match(/<section class="install-section" id="install"[\s\S]*?<\/section>/)?.[0];
  assert.ok(install);
  assert.match(install, /Install from a terminal[\s\S]*<code>curl -fsSL https:\/\/ktiler\.org\/install\.sh \| sh<\/code>[\s\S]*href="\/install\.sh"/);
  assert.match(install, /Install from File/);
  assert.match(install, /After either install:[\s\S]*tick <strong>ktiler<\/strong>[\s\S]*<strong>Apply<\/strong>/);
  assert.match(home, /src="\/showcase\.js"/);
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
  for (const path of ["/simulator", "/simulator/"]) {
    const page = await (await get(path)).text();
    assert.match(page, /<main class="simulator page-width"/);
    assert.match(page, /id="workspace"/);
    assert.match(page, /href="\/window-apps\.css"/);
    assert.doesNotMatch(page.match(/<[^>]+id="workspace"[^>]*>/)[0], /\btabindex\b/i);
    assert.match(page, /src="\/app\.js"/);
    assert.match(page, /href="\/simulator" aria-current="page"/);
    assert.equal(header(page), header(home));
    assert.doesNotMatch(page, /class="footer-credit"/);
  }
  const help = await (await get("/help")).text();
  assert.equal(header(help), header(home));
  for (const page of [home, help]) {
    const footer = page.match(/<footer class="site-footer page-width">[\s\S]*?<\/footer>/)?.[0];
    assert.ok(footer);
    assert.match(footer, /class="brand"[\s\S]*?<p class="footer-credit">[\s\S]*?<nav aria-label="Footer">/);
    assert.match(footer, /© 2026 <a href="https:\/\/jordanarseno\.com">Jordan Arsenault<\/a>/);
    assert.match(footer, /href="\/LICENSE\.md">MIT License<\/a>/);
  }
  for (const id of ["compatibility", "shortcuts", "layouts", "spread-resize"]) {
    assert.ok(help.includes(`id="${id}"`), `Missing help section: ${id}`);
  }
  for (const name of ["showcase", "display-view", "window-previews"]) {
    const module = await get(`/${name}.js`, { method: "HEAD" });
    assert.equal(module.status, 200);
    assert.match(module.headers.get("content-type"), /^text\/javascript/);
  }
  const previews = await (await get("/window-previews.js")).text();
  assert.match(previews, /class="browser-address">https:\/\/ktiler\.org</);
  assert.match(previews, /Window Shopping[\s\S]*?How to Exit Vim/);
  assert.match(previews, /class="browser-home-monitors"/);
  const logo = await get("/kde-icon.png", { method: "HEAD" });
  assert.equal(logo.status, 200);
  assert.equal(logo.headers.get("content-type"), "image/png");
  assert.match(await (await get("/THIRD-PARTY.md")).text(), /KDE Press Kit/);
  assert.match(await (await get("/licenses/LGPL-2.1.txt")).text(), /GNU LESSER GENERAL PUBLIC LICENSE/);
  const logoSource = await get("/licenses/kde-logo-blue-transparent-source.svg", { method: "HEAD" });
  assert.equal(logoSource.status, 200);
  assert.equal(logoSource.headers.get("content-type"), "image/svg+xml");
  assert.match(await (await get("/404.html")).text(), /<h1>Page not found<\/h1>/);
  assert.equal((await get("/package.json")).status, 404);
});
