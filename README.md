# KDE tiling simulator

The native **KWin 6 Wayland prototype** is now available separately.
See [`kwin/README.md`](kwin/README.md) for build, isolated testing, safety controls,
limitations, and optional installation. It is not installed or enabled by building.

```sh
npm start
```

Open <http://localhost:5173>. No installation or build step is required (Node 20+).

Click a display or window to activate it. Drag a display's title to reposition it;
nearby edges snap together. X/Y/W/H edit the active display's virtual geometry.
Select a window, then drag its shared edge to resize it. Outer screen edges
stay fixed, with no unused space between windows. Focused dividers also respond to
arrow keys (Shift for larger steps).
**Spread resize** (on by default) shares compensation equally across all windows
beyond the dragged edge in rows/columns, leaving windows on the other side of the
resized window unchanged. Turn it off to resize just the two adjacent windows.
The preference is saved across reloads and kept when resetting the arrangement.
State is saved locally in the browser; **Reset** restores the starting arrangement.

| Shortcut | Action |
| --- | --- |
| Alt++ / Alt+= | Add a window to the active display |
| Alt+- | Remove the selected window |
| Alt+B | Binary splits |
| Alt+V | Vertical columns (initially equal width) |
| Alt+H | Horizontal rows (initially equal height) |
| Alt+Shift+R | Cycle windows clockwise |
| Alt+Shift+E | Cycle windows counterclockwise |
| Alt+arrows | Select a neighboring window, crossing displays at an edge |
| Alt+Shift+arrows | Swap with a neighbor, or transfer to another display at an edge |
| Alt+1–9 / Alt+0 | Activate display 1–9 / 10 |

KDE and browser shortcuts cannot reliably be overridden by a web page. All actions
have buttons. **Alt** is the default modifier; select **Keys → Meta** to switch back.
Shortcuts do not run while editing a geometry field.
Alt+R is unbound.

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
