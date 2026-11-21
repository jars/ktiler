import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { publicFiles } from "../scripts/build-site.mjs";
import { deploySite } from "../scripts/deploy-site.mjs";
import { brandedArchive } from "../site-files.mjs";

const accountId = "a".repeat(32);
const archive = "test archive";
const checksum = createHash("sha256").update(archive).digest("hex");

async function buildFixture({ destination }) {
  for (const name of publicFiles.keys()) {
    const file = path.join(destination, name);
    await mkdir(path.dirname(file), { recursive: true });
    const contents = name === "install.sh"
      ? `    download_url='https://ktiler.org/${brandedArchive}'\n    archive_sha256='${checksum}'\n`
      : archive;
    await writeFile(file, contents);
  }
}

const unexpectedCLI = () => assert.fail("Wrangler must not run");

test("site deploy dry run builds and checks the site without an account or Wrangler", async () => {
  let staged;
  await deploySite({
    dryRun: true,
    env: {},
    build: async (options) => {
      staged = options.destination;
      await buildFixture(options);
      assert.equal((await stat(path.dirname(staged))).mode & 0o777, 0o700);
    },
    wrangler: unexpectedCLI,
  });
  await assert.rejects(stat(staged), { code: "ENOENT" });
});

test("site deploy rejects missing account, extra files and a bad installer checksum before upload", async () => {
  await assert.rejects(deploySite({ env: {}, build: unexpectedCLI, wrangler: unexpectedCLI }), /Set KTILER_CLOUDFLARE_ACCOUNT_ID/);
  for (const [name, error] of [[".env", /Unexpected site output: \.env/], [brandedArchive, /checksum does not match/]]) {
    await assert.rejects(deploySite({
      dryRun: true,
      env: {},
      build: async (options) => {
        await buildFixture(options);
        await writeFile(path.join(options.destination, name), "not part of the verified build");
      },
      wrangler: unexpectedCLI,
    }), error);
  }
});

test("site deploy refuses a project without the exact ktiler.org domain", async () => {
  await assert.rejects(deploySite({
    env: { KTILER_CLOUDFLARE_ACCOUNT_ID: accountId },
    build: buildFixture,
    wrangler: (args) => {
      assert.deepEqual(args.slice(0, 4), ["pages", "project", "list", "--json"]);
      return JSON.stringify([{ "Project Name": "ktiler", "Project Domains": "ktiler.pages.dev, www.ktiler.org" }]);
    },
  }), /Refusing to deploy/);
});

test("site deploy scopes Wrangler to the configured account and stages outside the upload folder", async () => {
  const calls = [];
  await deploySite({
    env: {
      HOME: "/home/example",
      KTILER_CLOUDFLARE_ACCOUNT_ID: accountId,
      CLOUDFLARE_API_TOKEN: "not-used",
      CLOUDFLARE_API_BASE_URL: "https://example.invalid",
      CF_API_KEY: "not-used",
      CLOUDFLARE_ACCOUNT_ID: "other-account",
      WRANGLER_LOG: "debug",
      GIT_DIR: "/unrelated/.git",
    },
    build: buildFixture,
    wrangler: (args, options) => {
      calls.push({ args, options });
      return JSON.stringify([{ "Project Name": "ktiler", "Project Domains": "ktiler.pages.dev, ktiler.org" }]);
    },
  });
  assert.equal(calls.length, 2);
  const [lookup, upload] = calls;
  const { cwd, env } = upload.options;
  assert.deepEqual(lookup.args, ["pages", "project", "list", "--json", "--env-file", path.join(cwd, "wrangler.env")]);
  assert.equal(lookup.options.capture, true);
  assert.deepEqual(upload.args, ["pages", "deploy", path.join(cwd, "site"), "--project-name", "ktiler", "--env-file", path.join(cwd, "wrangler.env")]);
  assert.deepEqual(env, {
    HOME: "/home/example", CLOUDFLARE_ACCOUNT_ID: accountId, WRANGLER_SEND_METRICS: "false",
    GIT_CEILING_DIRECTORIES: path.dirname(cwd), CI: "true",
  });
  await assert.rejects(readFile(path.join(cwd, "wrangler.env")), { code: "ENOENT" });
});
