import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import test from "node:test";

test("the website serves the homepage, Help, and the unchanged simulator separately", async (t) => {
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
  assert.doesNotMatch(home, /src="\/app\.js"/);
  for (const path of ["/simulator", "/simulator/"]) {
    const page = await (await get(path)).text();
    assert.match(page, /id="workspace"/);
    assert.match(page, /src="\/app\.js"/);
  }
  const help = await (await get("/help")).text();
  for (const id of ["compatibility", "shortcuts", "layouts", "spread-resize"]) {
    assert.ok(help.includes(`id="${id}"`), `Missing help section: ${id}`);
  }
  for (const name of ["desktop-before", "desktop-after"]) {
    const image = await get(`/site-images/${name}.webp`, { method: "HEAD" });
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/webp");
  }
  assert.equal((await get("/package.json")).status, 404);
});
