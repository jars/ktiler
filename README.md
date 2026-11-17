# KDE tiling simulator

```sh
npm start
```

Open <http://localhost:5173>. No installation or build step is required (Node 20+).

Click a display or window to activate it. Drag a display's title to reposition it;
nearby edges snap together. X/Y/W/H edit the active display's virtual geometry.
State is saved locally in the browser; **Reset** restores the starting arrangement.

| Shortcut | Action |
| --- | --- |
| Alt++ / Alt+= | Add a window to the active display |
| Alt+- | Remove the selected window |
| Alt+B | Binary splits |
| Alt+V | Equal-width vertical columns |
| Alt+H | Equal-height horizontal rows |
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
- Binary layouts recursively divide space 50/50, alternating vertical and
  horizontal splits. The first branch gets the extra window for odd counts.
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

```sh
npm test
```

This is only a simulator: it does not change KDE settings or control OS windows.
