# ktiler: native KWin prototype

Existing installation under the former name? Follow [`MIGRATION.md`](MIGRATION.md)
instead of enabling both versions or renaming installed directories manually.

An experimental **KWin 6 Wayland script**, using the same layout engine as the
browser simulator. It is not PlasmaZones, a replacement compositor, or a daemon.
Node.js is only needed to build/test it, not to run the installed script.

**Building or testing does not install or enable it on your desktop.**

## Build

```sh
npm ci
npm test
npm run build:kwin
```

Output: `dist/ktiler.kwinscript`, plus the unpacked package in `dist/ktiler/`.
The build transpiles shared JavaScript to Qt-compatible syntax and includes a
plain-data clone implementation; the browser and KWin do not maintain separate
copies of the layout rules.

## Isolated native test

```sh
npm run test:kwin
```

Requires Linux, KWin Wayland, `qdbus6`, `dbus-run-session`, `kpackagetool6`, a C++
compiler, `pkg-config`, and Qt 6 Widgets/DBus and Wayland-client development files.
`zip` is needed to build the archive.

The test launches a **virtual, headless KWin session**, real disposable Qt Wayland
windows, and its own D-Bus session. Runtime/config/data/cache/state directories
are private temporary directories under `/tmp/opencode/`. Nothing is loaded into
the existing compositor. KPackage installation validation also uses a temporary
package root, not the user's script directory.

Synthetic keyboard/pointer events are sent only to the private Wayland socket.
The input harness refuses to run outside this test environment. Only the private
compositor is started with `KWIN_WAYLAND_NO_PERMISSION_CHECKS=1` to expose the
testing input protocol. **Never apply that environment setting to your desktop.**
The shipped package contains neither the test bridge nor the input harness.

Logs and the generated test script are kept in the printed temporary directory.

## Controlled desktop trial — only after explicit approval

Save your work. Disable other tiling scripts/effects and resolve shortcut conflicts
first. The script manages existing eligible windows immediately when enabled.

Install the already-built archive, without `sudo`:

```sh
kpackagetool6 --type=KWin/Script --install dist/ktiler.kwinscript
```

Then open **System Settings → Window Management → KWin Scripts** and enable
**ktiler**. It is disabled by default. Installation alone does not
enable it. Once enabled in settings it can load in subsequent sessions.

For updates, restore/pause and disable the old script first, then:

```sh
kpackagetool6 --type=KWin/Script --upgrade dist/ktiler.kwinscript
```

Enable it again afterward. Do not restart or replace the live Wayland compositor.

## Controls and safety

| Shortcut | Action |
| --- | --- |
| Alt+B / Alt+V / Alt+H | Binary / columns / horizontal rows |
| Alt+arrows | Select a neighboring window; cross outputs at an edge |
| Alt+Shift+arrows | Swap, or transfer to the neighboring output |
| Alt+Shift+R / Alt+Shift+E | Rotate clockwise / counterclockwise |
| Alt+1–9 / Alt+0 | Activate monitor 1–9 / 10, in KDE's configured output order |
| **Meta+Ctrl+Alt+P** | **Pause / resume management** |
| **Meta+Ctrl+Alt+R** | **Restore original geometry and pause** |

Alt+R and Alt+C remain unassigned. The simulator's add/remove-window shortcuts
are deliberately **not** registered: open and close applications normally.
No shortcut closes or kills an application.

The window menu (`Alt+F3`) also contains a **ktiler** submenu for pause, restore,
and toggling Spread resize. The runtime spread toggle affects this session.

The script's configuration button provides persistent defaults for:

- **Spread resize**, on by default.
- Shortcut modifier: `Alt` or `Meta`.
- Initial mode: `binary`, `columns`, or `horizontal`.

Apply configuration changes with the script disabled, then enable it again.
Individual actions are also configurable in KDE's global shortcut settings.

### Stop or remove

Prefer **Restore original geometry and pause**, then disable the script in KWin
Scripts. Restore is best-effort: windows opened later have their first-managed
geometry, and disconnected outputs cannot be restored exactly.

An emergency terminal stop, if the shortcuts are unavailable:

```sh
qdbus6 org.kde.KWin /Scripting unloadScript ktiler
```

That stops management but **does not restore geometry or disable future startup**.
Also uncheck the script in settings. After disabling/unloading it, removal is:

```sh
kpackagetool6 --type=KWin/Script --remove ktiler
```

## Prototype behavior and limits

- Normal movable/resizable application windows are managed. Dialogs, transient
  windows, panels, menus, fixed-size windows, and fullscreen windows are excluded.
- Minimizing, restoring, opening and closing windows reflows the active layout.
  Maximization is replaced by tiling while management is active.
- Modes, ordering and proportions are maintained per output, virtual desktop and
  activity **during this KWin session**. Proportions/order are not yet saved across
  logout or script reload. Persistent defaults are saved through the config UI.
- Shared-edge drags use native interactive resize events, including corner
  resizing. Spread resize keeps its target and original baseline throughout a
  drag, including reversals. Outside edges stay fixed.
- Window movement is via the configured shortcuts. Free dragging is snapped back;
  drag-to-reorder is not implemented.
- Window frames include decorations; available areas exclude panels. Adjacent
  edges are rounded together so ordinary integer-coordinate layouts have no holes.
- Actual application minimum/maximum sizes constrain interactive resizing. If an
  entire layout cannot fit those limits, the script logs a diagnostic rather than
  endlessly fighting applications. It does **not** yet implement a stacked/tabbed
  fallback for impossible layouts. Strict gap-free coverage cannot be promised
  for apps that refuse requested sizes or enforce incompatible aspect/increment
  constraints.
- Existing built-in KWin tile-editor layouts are **not rewritten**. Managed
  windows are detached from their original tiles; restore tries to reattach them
  if those original tile objects still exist.
- Monitor hotplug and desktop/activity changes are handled by the adapter, but
  mixed-DPI hardware, sleep/wake, XWayland applications, and unusual window rules
  still need a controlled real-desktop trial.

This is a tested prototype, **not yet a daily-driver release**.
