import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { siteFiles } from "../site-files.mjs";

const root = new URL("../", import.meta.url);
const size = 800;
const viewportSize = 660;
const frameStep = 40;
const themes = { light: "ktiler-gallery-color.gif", dark: "ktiler-gallery-dark.gif" };
const origin = "http://gallery.test";
const capturePage = `<!doctype html>
<html lang="en" data-gallery-theme="light">
<meta charset="utf-8">
<link rel="stylesheet" href="/site.css">
<link rel="stylesheet" href="/keycaps.css">
<link rel="stylesheet" href="/display.css">
<link rel="stylesheet" href="/window-apps.css">
<style>
  :root { background: #ffffff; scrollbar-gutter: auto; }
  :root[data-gallery-theme="dark"] { background: #0d1117; }
  [data-gallery-theme="dark"] .display {
    --bezel: #a6b2be;
    border-color: #8f9ba9;
    box-shadow: none;
  }
  [data-gallery-theme="dark"] .display-bezel { color: #26313d; }
  [data-gallery-theme="dark"] .display.active .display-bezel { color: #102d49; }
  [data-gallery-theme="dark"] .display-controls::before {
    background: #526170;
    box-shadow: 8px 0 #526170, 16px 0 #526170;
  }
</style>
<div id="showcase" class="tiling-workspace hero-displays">
  <div class="tiling-displays"></div>
  <div class="tiling-tip showcase-keypress" hidden><div class="tiling-tip-keys"></div></div>
</div>
</html>`;

async function captureFrames(directory) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: viewportSize, height: viewportSize },
      deviceScaleFactor: size / viewportSize,
      reducedMotion: "no-preference",
    });
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (url.pathname === "/") {
        return route.fulfill({ contentType: "text/html", body: capturePage });
      }
      const file = siteFiles.get(url.pathname);
      return file
        ? route.fulfill({ path: fileURLToPath(new URL(file.source, root)), contentType: file.mime })
        : route.fulfill({ status: 404 });
    });
    const clockStart = Date.UTC(2026, 0, 1);
    await page.clock.install({ time: clockStart });
    await page.clock.pauseAt(clockStart + 60_000);
    await page.goto(origin);

    const { duration, startDelay } = await page.evaluate(async () => {
      // Playwright controls JS timers, but Chromium runs Web Animations on its own
      // clock. Pause and seek them so both themes are sampled at the same instant.
      const animate = Element.prototype.animate;
      const animations = new Map();
      Element.prototype.animate = function (...args) {
        const animation = animate.apply(this, args);
        animation.pause();
        animation.currentTime = 0;
        animations.set(animation, performance.now());
        return animation;
      };
      const { positionCallout, showcaseLoopDuration, showcaseStartDelay } = await import("/showcase.js");
      window.seekGalleryFrame = (elapsed) => {
        for (const [animation, start] of animations) {
          const time = performance.now() - start;
          if (animation.currentTime === null) animations.delete(animation);
          else if (time >= animation.effect.getComputedTiming().endTime) {
            animation.finish();
            animations.delete(animation);
          } else animation.currentTime = time;
        }
        // Pause the terminal caret blink too; it is a CSS animation.
        for (const animation of document.getAnimations()) {
          if (!(animation instanceof CSSAnimation)) continue;
          animation.pause();
          animation.currentTime = elapsed;
        }
        positionCallout();
      };

      // Run only after the showcase's observer has scheduled its first keypress.
      await new Promise((resolve) => {
        const observer = new IntersectionObserver(([entry]) => {
          if (entry.intersectionRatio < 0.2) return;
          observer.disconnect();
          resolve();
        }, { threshold: 0.2 });
        observer.observe(document.querySelector("#showcase"));
      });
      await document.fonts.ready;
      return { duration: showcaseLoopDuration, startDelay: showcaseStartDelay };
    });

    // Leave the starting layout visible for 300 ms before the first keypress.
    await page.clock.runFor(Math.max(0, startDelay - 300));
    for (let elapsed = 0, frame = 0; elapsed < duration; elapsed += frameStep, frame++) {
      if (frame > 0) await page.clock.runFor(frameStep);
      await page.evaluate((time) => window.seekGalleryFrame(time), elapsed);
      for (const theme of Object.keys(themes)) {
        await page.evaluate((theme) => { document.documentElement.dataset.galleryTheme = theme; }, theme);
        await page.screenshot({ path: path.join(directory, theme, `${frame}.png`) });
      }
    }
    return (duration - (Math.ceil(duration / frameStep) - 1) * frameStep) / 10;
  } finally {
    await browser.close();
  }
}

const ffmpeg = (args) => promisify(execFile)("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args]);

async function encodeGif(directory, lastDelay) {
  const frames = ["-framerate", String(1000 / frameStep), "-i", path.join(directory, "%d.png")];
  const palette = path.join(directory, "palette.png");
  await ffmpeg([...frames, "-vf", "palettegen", "-frames:v", "1", "-update", "1", palette]);
  await ffmpeg([
    ...frames, "-i", palette, "-lavfi", "paletteuse=diff_mode=rectangle",
    "-loop", "0", "-final_delay", String(lastDelay), path.join(directory, "gallery.gif"),
  ]);
}

const directory = await mkdtemp(path.join(tmpdir(), "ktiler-gallery-"));
try {
  await ffmpeg(["-version"]);
  for (const theme of Object.keys(themes)) await mkdir(path.join(directory, theme));
  console.log("Capturing the light and dark showcase…");
  const lastDelay = await captureFrames(directory);
  for (const theme of Object.keys(themes)) await encodeGif(path.join(directory, theme), lastDelay);
  for (const [theme, filename] of Object.entries(themes)) {
    await copyFile(path.join(directory, theme, "gallery.gif"), new URL(filename, root));
    console.log(`Wrote ${filename}`);
  }
} catch (error) {
  console.error(error.code === "ENOENT" && error.path === "ffmpeg" ? "Install FFmpeg and make sure it is on your PATH." : error.message);
  process.exitCode = 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
