import { execFileSync } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { siteFiles } from "../site-files.mjs";

const root = new URL("../", import.meta.url);
const destination = new URL("dist/site/", root);
execFileSync(process.execPath, [fileURLToPath(new URL("scripts/build-kwin.mjs", root))], { stdio: "inherit" });

await Promise.all([...siteFiles].map(async ([pathname, { source }]) => {
  const output = new URL(pathname.slice(1), destination);
  await mkdir(new URL(".", output), { recursive: true });
  await copyFile(new URL(source, root), output);
}));
await copyFile(new URL("_headers", root), new URL("_headers", destination));

console.log(`Static website: ${fileURLToPath(destination)}`);
