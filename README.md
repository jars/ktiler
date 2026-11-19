# ktiler

The ktiler desktop script targets **KDE Plasma 6 on Wayland**. It is
architecture-independent and requires no native plugin or compiler to install.
See [`kwin/README.md`](kwin/README.md) for build, isolated testing, safety controls,
limitations, and optional installation. It is not installed or enabled by building.

Project: [ktiler.org](https://ktiler.org) · [Help](https://ktiler.org/help) ·
[GitHub](https://github.com/jars/ktiler) ·
[Releases](https://github.com/jars/ktiler/releases) ·
[Pull requests](https://github.com/jars/ktiler/pulls) ·
[Issues](https://github.com/jars/ktiler/issues)

Copyright © 2026 [Jordan Arsenault](https://jordanarseno.com).
Licensed under [MIT](LICENSE.md).

## Browser simulator

The simulator starts with three displays and uses the same factory shortcuts
as [ktiler on KWin](kwin/README.md#controls-and-safety).

```sh
bun run dev
```

Open <http://localhost:5173>. You can also run `npm start` with Node 20+.

Click a display or window to activate it. Drag a display's title to reposition it;
nearby edges snap together. Use **Add Display** to add an empty display, or **×**
on a display header to move its windows to the nearest remaining display and
remove it. The arrangement is saved locally in the browser.
Select a window, then drag its shared edge to resize it. Outer screen edges
stay fixed, with no unused space between windows. Focused dividers also respond to
arrow keys (Shift for larger steps). The simulator always uses **Spread Resize**
for rows and columns, sharing the adjustment among tiles beyond the dragged edge.

| Shortcut | Action |
| --- | --- |
| Alt+W/A/S/D | Focus up/left/down/right, crossing displays at an edge |
| Alt+Shift+W/A/S/D | Swap with a neighbor, or move to another display at an edge |
| Alt+B | Binary splits |
| `Alt+\` | Vertical columns (initially equal width) |
| Alt+- | Horizontal rows (initially equal height) |
| Alt+Shift+R | Cycle windows clockwise |
| Alt+Shift+E | Cycle windows counterclockwise |

If KDE or the browser intercepts a shortcut, click the action in the **Shortcuts**
panel instead.

## Rules

- Each display remembers its own mode and selected window.
- Binary layouts initially divide space 50/50, alternating vertical and
  horizontal splits. The first branch gets the extra window for odd counts.
- Shared dividers adjust persistent layout proportions, never individual window
  rectangles. A binary divider resizes both entire branches, unaffected by Spread
  resize. In rows/columns, a selected window touching the divider is the resize
  target; otherwise, the grabbed side determines the target. The target remains
  fixed throughout the drag, including when reversing direction.
- With Spread resize on, the target grows/shrinks and every window beyond its
  dragged edge shares the opposite change equally. Windows at their minimum stop
  shrinking; remaining windows share the rest. A drag stops when the shrinking
  side has no space left. Each drag uses its original proportions, so reversing
  the mouse restores them even after reaching a minimum-size limit.
- With Spread resize off, only the two slots touching the divider change.
  Swaps and rotation preserve the resulting proportions in either mode.
- New windows share the available space, and removal expands remaining slots.
  Existing binary split ratios survive where the balanced tree retains a branch.
  Row/column removal gives the deleted slot's space to its next neighbor (or the
  previous neighbor at the end). Changing layout mode starts an equal layout;
  selecting the current mode again keeps its proportions.
- Resizing is clamped to a simulated 96 × 64 minimum per tile, relaxed on crowded
  displays where that minimum is impossible. Fully occupied displays remain covered
  without gaps or overlaps. Proportions are saved with the display arrangement.
- Directional selection and swaps use shared tile edges. Where several neighbors share an
  edge, the largest shared edge wins, then the closest center.
- Selection never rearranges windows. At a display edge it activates the neighboring
  display and selects an existing window on its incoming edge, aligned with the source
  window's physical position. Empty displays can be activated and navigated away from;
  navigation from an empty display uses its center.
- At a display edge, movement chooses the nearest display lying beyond that
  edge, measured from the active window's exit point. There is no wraparound.
  A diagonally offset screen can be reached if it lies beyond that edge;
  overlapping screens are not directional neighbors along the overlapping axis.
- Transfers insert at the destination's incoming edge, aligned to the window's
  physical perpendicular position. Both displays retile; the destination and
  transferred window become active.
- Rotation keeps the layout fixed and the selected window selected. Binary
  slots cycle clockwise around the display center. Columns cycle left to right;
  horizontal rows cycle top to bottom. Counterclockwise reverses that order.
- Removing a display moves its windows to the nearest remaining display and
  preserves that display's mode. The last display cannot be removed.

`engine.js` contains the browser-independent layout and action logic.
The native adapter in `kwin/adapter.js` uses this same engine.

```sh
npm ci
npm test
```

The browser simulator does not change KDE settings or control OS windows.
Only the separately installed/enabled KWin package controls real windows.
