import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSite, publicFiles } from "./build-site.mjs";
import { brandedArchive } from "../site-files.mjs";

const project = "ktiler";
const domain = "ktiler.org";
const wranglerVersion = "4.166.0";

export async function verifySite(directory) {
  const expected = new Set(publicFiles.keys());
  async function visit(relative = "") {
    for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
      const name = path.posix.join(relative, entry.name);
      if (entry.isDirectory() && [...expected].some((file) => file.startsWith(`${name}/`))) {
        await visit(name);
      } else if (!entry.isFile() || !expected.delete(name)) {
        throw new Error(`Unexpected site output: ${name}`);
      }
    }
  }
  await visit();
  if (expected.size) throw new Error(`Missing site output: ${[...expected].join(", ")}`);

  const installer = await readFile(path.join(directory, "install.sh"), "utf8");
  const download = installer.match(/^ +download_url='([^']+)'$/m)?.[1];
  const checksum = installer.match(/^ +archive_sha256='([a-f0-9]{64})'$/m)?.[1];
  const digest = createHash("sha256").update(await readFile(path.join(directory, brandedArchive))).digest("hex");
  if (download !== `https://${domain}/${brandedArchive}` || checksum !== digest) {
    throw new Error("The installer URL or checksum does not match the staged archive.");
  }
}

function runWrangler(args, { capture, ...options }) {
  return execFileSync("npx", ["--yes", `wrangler@${wranglerVersion}`, ...args], {
    ...options, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
}

export async function deploySite({
  dryRun = false, env = process.env, build = buildSite, wrangler = runWrangler,
} = {}) {
  const accountId = env.KTILER_CLOUDFLARE_ACCOUNT_ID;
  if (!dryRun && !/^[a-f0-9]{32}$/i.test(accountId ?? "")) {
    throw new Error("Set KTILER_CLOUDFLARE_ACCOUNT_ID to the Account ID from ktiler.org’s Cloudflare Overview.");
  }

  const temporary = await mkdtemp(path.join(await realpath(tmpdir()), "ktiler-deploy-"));
  try {
    const destination = path.join(temporary, "site");
    await build({ destination, releaseDirectory: path.join(temporary, "release") });
    await verifySite(destination);
    console.log(`Verified ${publicFiles.size} public files and the installer checksum.`);
    if (dryRun) {
      console.log("Dry run: no authentication or upload attempted.");
      return;
    }

    // Use the user's Wrangler OAuth login, never an ambient Cloudflare token,
    // Wrangler override, repository env file, or inferred Git branch.
    const wranglerEnv = Object.fromEntries(Object.entries(env).filter(([key]) =>
      !/^(CF_|CLOUDFLARE_|WRANGLER_|GIT_|KTILER_CLOUDFLARE_)/i.test(key)));
    Object.assign(wranglerEnv, {
      CLOUDFLARE_ACCOUNT_ID: accountId,
      WRANGLER_SEND_METRICS: "false",
      GIT_CEILING_DIRECTORIES: path.dirname(temporary),
      CI: "true",
    });
    const envFile = path.join(temporary, "wrangler.env");
    await writeFile(envFile, "");
    const options = { cwd: temporary, env: wranglerEnv };
    const projects = JSON.parse(wrangler(["pages", "project", "list", "--json", "--env-file", envFile],
      { ...options, capture: true }));
    if (!Array.isArray(projects) || !projects.some((entry) => entry?.["Project Name"] === project
      && typeof entry["Project Domains"] === "string"
      && entry["Project Domains"].split(",").some((name) => name.trim().toLowerCase() === domain))) {
      throw new Error(`Refusing to deploy: the selected account has no ${project} Pages project serving ${domain}.`);
    }

    // Outside the Git checkout, Wrangler sends no branch and Pages uses the
    // project's configured production branch.
    console.log(`Deploying to Cloudflare Pages project ${project} (https://${domain}).`);
    wrangler(["pages", "deploy", destination, "--project-name", project, "--env-file", envFile], options);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    if (args.length > 1 || args.some((arg) => !["--dry-run", "--help"].includes(arg))) {
      throw new Error("Usage: bun run site:deploy [--dry-run]");
    }
    if (args.includes("--help")) console.log("Usage: bun run site:deploy [--dry-run] (see docs/deploy.md)");
    else await deploySite({ dryRun: args.includes("--dry-run") });
  } catch (error) {
    console.error(`Site deploy: ${error.message}`);
    process.exitCode = 1;
  }
}
