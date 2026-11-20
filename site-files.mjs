import { extname } from "node:path";

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".kwinscript": "application/zip",
};

export const siteFiles = new Map([
  "index.html",
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
  ["ktiler.kwinscript", "dist/ktiler.kwinscript"],
].map((file) => {
  const [output, source = output] = Array.isArray(file) ? file : [file];
  return [`/${output}`, { source, mime: mime[extname(output)] }];
}));
