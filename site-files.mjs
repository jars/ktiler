import { extname } from "node:path";
import { readFileSync } from "node:fs";

const { KPlugin: { Version: version } } = JSON.parse(readFileSync(new URL("./kwin/metadata.json", import.meta.url)));
export const brandedArchive = `releases/${version}/ktiler.kwinscript`;

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".kwinscript": "application/zip",
  ".sh": "text/plain; charset=utf-8",
};

export const siteFiles = new Map([
  "index.html",
  "404.html",
  "help/index.html",
  "simulator/index.html",
  "site.css",
  "style.css",
  "display.css",
  "display-view.js",
  "showcase.js",
  "window-apps.css",
  "app.js",
  "simulator.js",
  "move-tutorial.js",
  "window-previews.js",
  "engine.js",
  "ktiler-icon.png",
  "ktiler-logo-w-text.png",
  "kde-icon.png",
  "LICENSE.md",
  "THIRD-PARTY.md",
  "licenses/LGPL-2.1.txt",
  "licenses/kde-logo-blue-transparent-source.svg",
  ["install.sh", "dist/install.sh"],
  ["ktiler.kwinscript", "dist/ktiler.kwinscript"],
  [brandedArchive, `dist/${brandedArchive}`],
].map((file) => {
  const [output, source = output] = Array.isArray(file) ? file : [file];
  return [`/${output}`, { source, mime: mime[extname(output)] }];
}));
