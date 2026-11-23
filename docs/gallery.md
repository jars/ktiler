# Regenerate the README demo

Install Bun and FFmpeg, then run from the repository root:

```sh
npm ci
npx playwright-core install --only-shell chromium
bun run generate:gallery
```

For matching typography, install Noto Sans before capturing. On Linux, if
Chromium reports missing system libraries, run `npx playwright-core install-deps chromium`.

The command replaces `ktiler-gallery-color.gif` (light) and
`ktiler-gallery-dark.gif` (dark). Both GIFs capture the same loop from
`showcase.js`. The canvas and bezel styles in `scripts/generate-gallery.mjs`
are only used for the README exports.
