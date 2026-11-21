import { copyFile, mkdir, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildKWinRelease } from "./build-kwin.mjs";
import { siteFiles } from "../site-files.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

export const publicFiles = new Map([
  ...[...siteFiles].map(([pathname, { source }]) => [pathname.slice(1), source]),
  ["_headers", "_headers"],
]);

export async function buildSite({
  destination = path.join(root, "dist/site"),
  releaseDirectory = path.join(root, "dist"),
} = {}) {
  const release = await buildKWinRelease(releaseDirectory);
  const sourceRoot = await realpath(root);
  const releaseRoot = await realpath(releaseDirectory);
  for (const [pathname, source] of publicFiles) {
    const input = source.startsWith("dist/")
      ? path.join(releaseRoot, source.slice("dist/".length))
      : path.join(sourceRoot, source);
    if (await realpath(input) !== input) throw new Error(`Refusing a symlink in site input: ${source}`);
    const output = path.join(destination, pathname);
    await mkdir(path.dirname(output), { recursive: true });
    await copyFile(input, output);
  }
  return release;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { archive, brandedArchive, installer, launcher } = await buildSite();
  console.log(`Built ${archive}\nBranded archive: ${brandedArchive}\nInstaller: ${installer}\nLauncher: ${launcher}\nNot installed or enabled.`);
  console.log(`Static website: ${path.join(root, "dist/site")}/`);
}
