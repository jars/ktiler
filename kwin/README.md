# ktiler: KWin script

Existing installation under the former name? Follow [`MIGRATION.md`](MIGRATION.md)
instead of enabling both versions or renaming installed directories manually.

ktiler targets **KDE Plasma 6 on Wayland**, using the same layout engine as the
browser simulator. The `.kwinscript` is architecture-independent: no native
plugin, compiler, or Node.js is needed to install or run the built package.
Node.js is only needed to build or run tests from source. Plasma 5 and Plasma
X11 sessions are not supported targets. Full maximize handling, including windows
already maximized at startup, requires Plasma 6.3 or newer.

Automatic settings updates are verified on **Plasma 6.6.6 Wayland**. If your
Plasma installation lacks Qt's optional `FolderListModel` QML module, no extra
package is required: save, then choose **Alt+F3 → ktiler → Reload settings** on
a normal window.

**Building or testing does not install or enable it on your desktop.**

## Build

```sh
npm ci
npm test
npm run test:branding
npm run build:kwin
```

Output: `dist/ktiler.kwinscript`, `dist/org.ktiler.Settings.desktop`, and the
unpacked package in `dist/ktiler/`.
The build transpiles shared JavaScript to Qt-compatible syntax and includes a
plain-data clone implementation; the browser and KWin do not maintain separate
copies of the layout rules.

The package also includes the original icon, wordmark, and MIT license. About
metadata supplies the author/website, copyright, project website, and KDE's
standard MIT license viewer.

## Isolated branding/configuration test

```sh
npm run test:branding
```

Requires CMake, a C++ compiler, Qt 6 Widgets/UiTools/Test development files, KDE
Frameworks 6 Config/ConfigWidgets/CoreAddons/I18n development files, Plasma's KDE Qt
platform theme, `dbus-run-session`, and `kpackagetool6`.

This installs/upgrades a disposable package and its icon in private XDG directories
under `/tmp/opencode/`, then loads the generated form using the same `QUiLoader`,
`KConfigLoader`, `KConfigDialogManager`, `KLocalizedTranslator`, and language-change
sequence used by KWin's generic script configuration module. It tests existing String
settings, friendly layout labels/canonical values, change notifications,
Apply/Reset/Defaults, metadata, the MIT license text, icon/logo loading, and that
KWin's loading sequence does not blank dropdown items.
Light/dark Configure previews are retained in the printed test directory.
It does not open a dialog on, or change settings in, the running desktop.

## Isolated native test

```sh
npm run test:kwin
```

Requires Linux, KWin Wayland 6.3 or newer, `qdbus6`, `dbus-run-session`, `kpackagetool6`, a C++
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

The suite also tests live settings updates. To exercise **Apply**, **OK**, and
**Cancel** in KWin's stock Configure dialog instead of using `kwriteconfig6`,
run `KTILER_TEST_STOCK_DIALOG=1 npm run test:kwin`. This additionally requires the
branding test dependencies and the KDE Frameworks 6 KCMUtils development files.
Run `KTILER_TEST_NO_WATCHER=1 npm run test:kwin` to test **Reload settings** with
the file watcher unavailable.

## Controlled desktop trial — only after explicit approval

Save your work. Disable other tiling scripts/effects and resolve shortcut conflicts
first. The script manages existing eligible windows immediately when enabled.

Preview the already-built package installation, without `sudo`:

```sh
npm run install:kwin
```

After testing and reviewing the preview:

```sh
npm run install:kwin -- --apply
```

Then open **System Settings → Window Management → KWin Scripts** and enable
**ktiler**. It is disabled by default. Installation alone does not
enable it. Once enabled in settings it can load in subsequent sessions.

To configure it, search KDE's Application Launcher for **ktiler Settings**.
This opens the same Shortcuts and General tabs as the KWin Scripts Configure
button. The launcher can open the settings even when ktiler is disabled.

The installer handles both installation and upgrades. It backs up the previous
package, icon, settings launcher, `kwinrc`, and `kglobalshortcutsrc` under
`$XDG_STATE_HOME/ktiler/backups/` (normally `~/.local/state/ktiler/backups/`).
It does not modify configuration, shortcut registrations, or plugin enablement.

If runtime code/configuration differs, restore/pause and **disable the old script
and Apply** first. The installer refuses to perform that upgrade while ktiler is
enabled, loaded, or its loaded state cannot be checked. Enable it again afterward.
Branding-only upgrades with identical runtime files can leave the running instance
untouched. Do not restart or replace the live Wayland compositor.

### Developer-only: rebuild and reload

Once ktiler is installed, run `npm run dev:reload-kwin` from a source checkout
in your Plasma Wayland session. It builds, disables and unloads ktiler, installs
the build with the usual backups,
then enable it again. This changes your running desktop session and can re-tile
open windows. Save your work before running it. No `sudo`, logout, or compositor
restart is needed. If the install fails, ktiler stays disabled.

For user-facing changes, bump the patch version in `package.json`,
`package-lock.json`, and `kwin/metadata.json` together.

### First-run checklist

- [ ] **Avoid conflicts.** Before enabling ktiler, disable other tiling scripts
  or effects and check for conflicting shortcuts in KDE System Settings.
- [ ] **Test your monitor arrangement.** Verify the monitor positions in KDE
  Display Configuration. If you have multiple monitors, focus a window at the
  edge of one monitor and try **Alt+Shift+W/A/S/D** toward the next one.
- [ ] **Check for a 1-pixel strip at a monitor seam.** Breeze can draw its window
  outline outside the frame, so a correctly tiled window can show a thin line
  on the monitor below. If it bothers you, open **Window Decorations → Breeze
  settings → Shadows and Outline** and uncheck **Draw window outline**. This is
  optional and does not change tile geometry.
- [ ] **Check app size limits if a move is rejected.** A shortcut can work for
  one window but be rejected for another if no available layout can fit every
  window's size limits, even with uneven splits. Try freeing up space on the
  destination monitor. Turning off the Breeze outline won't affect this.
- [ ] **Know the recovery menu.** Open the window menu (**Alt+F3**) and choose
  **ktiler** to pause/resume or restore the original geometry and pause.

### Application Launcher and icon

The script ID remains `ktiler`; no migration is needed for a branding upgrade.

The installer copies the supplied square PNG to
`$XDG_DATA_HOME/icons/hicolor/256x256/apps/ktiler.png` (normally under
`~/.local/share/`). KDE scales the original 244-pixel image for the scripts list
and stock About dialog. Plasma also uses it in the on-screen message when a move
is rejected. Reopen System Settings if it has cached the old metadata.
The built `.kwinscript` includes the artwork, but KDE's **Install from File**
does not register themed icons. The message still works; for the branded icon,
use the installer or manually copy `contents/images/ktiler-icon.png` from the
installed package to the themed-icon location above.

The installer also registers **ktiler Settings** in
`$XDG_DATA_HOME/applications/` (normally `~/.local/share/applications/`). If you
use KDE's **Install from File**, the script works without the launcher. To add
the menu entry, download `org.ktiler.Settings.desktop` alongside the script,
then copy it from your download directory:

```sh
applications="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
mkdir -p "$applications"
cp org.ktiler.Settings.desktop "$applications/"
```

The launcher uses KDE's `kcmshell6`. It does not install another app or enable
ktiler. Plasma normally picks up the new entry automatically; if it doesn't
appear, run `kbuildsycoca6` to refresh KDE's application cache.

Configure embeds the wordmark as a PNG data URI, so it does not depend on the
source checkout or relative image-path resolution. A light header keeps its dark
lettering readable on both light and dark themes. The dialog uses native Qt/KDE
controls. KDE controls the stock About dialog's layout.

Option help links point to `https://ktiler.org/help#shortcuts`, `#layouts`, and
`#spread-resize` as subtle `?` links; concise tooltips also work offline. Configure
links to the project website and a single GitHub (PRs & Issues) entry. The URLs are
reserved for the upcoming showcase/help site; packaging tests do not require them to
be live.

## Controls and safety

| Shortcut | Action |
| --- | --- |
| `Alt+B` / `Alt+\` / `Alt+-` | Binary / vertical columns / horizontal rows |
| Alt+W/A/S/D | Focus up/left/down/right; cross monitors at an edge |
| Alt+Shift+W/A/S/D | Swap tiles, or move to the neighboring monitor (also when maximized) |
| Alt+Shift+R / Alt+Shift+E | Rotate clockwise / counterclockwise |

For columns, use the backslash (pipe) key without Shift.

Numbered monitor jumps are not bound. Open and close applications normally;
no ktiler shortcut closes or kills an application.

The window menu (`Alt+F3`) also contains a **ktiler** submenu for pause, restore,
toggling Spread resize, and reloading settings. The runtime spread toggle affects
this session.

The script's configuration button provides persistent defaults for:

- **Spread resize**, on by default.
- Initial mode: `binary`, `columns`, or `horizontal`.
- **Debug logging**, off by default. When off, diagnostics never include window
  titles or other user content. When on, diagnostics additionally log window
  titles with their size limits. Rejected-move feedback never includes titles
  and works independently of this setting.

In **Configure ktiler → Shortcuts**, type or paste one key combination per field
(for example, `Alt+W`, `Alt+\`, or `Ctrl+Alt+J`). Do not press the keys together:
entering the shortcut as text lets you put back an active binding without
triggering it. Clear a field to leave the action unbound. **Reset** discards
unsaved edits; **Defaults** restores factory settings.

Click **Apply** or **OK**. Saved changes normally take effect without restarting
ktiler, moving windows, or losing custom split sizes. The initial layout setting
only applies to new displays or desktop contexts, not existing layouts. If
automatic updates are unavailable, use **ktiler → Reload settings** in the window
menu. Use distinct key combinations and avoid keys assigned to other global
shortcuts.

Starting with 0.1.9, Configure is the source of truth for ktiler's shortcuts. If
you previously customized them in KDE's global shortcut settings, note those
keys before upgrading and re-enter any you want to keep in Configure. ktiler
only replaces its own registrations, not shortcuts owned by other apps.

### Stop or remove

Prefer **Restore original geometry and pause**, then disable the script in KWin
Scripts. Restore is best-effort: windows opened later have their first-managed
geometry, currently maximized windows are left alone, and disconnected outputs
cannot be restored exactly.

An emergency terminal stop, if the shortcuts are unavailable:

```sh
qdbus6 org.kde.KWin /Scripting unloadScript ktiler
```

That stops management but **does not restore geometry or disable future startup**.
Also uncheck the script in settings. After disabling/unloading it, removal is:

```sh
kpackagetool6 --type=KWin/Script --remove ktiler
```

If you registered **ktiler Settings**, also remove
`${XDG_DATA_HOME:-$HOME/.local/share}/applications/org.ktiler.Settings.desktop`
to remove the Application Launcher entry.

## Prototype behavior and limits

- Normal movable/resizable application windows are managed. Dialogs, transient
  windows, panels, menus, fixed-size windows, and fullscreen windows are excluded.
- Minimizing, restoring, opening and closing windows reflows the active layout.
- Fully or partially maximized windows leave the tiled layout. The remaining
  tiles fill the space, and unmaximizing returns the window to the layout on its
  current monitor without reserving its old slot. The move shortcut sends a
  maximized window to the monitor in that direction without unmaximizing it or
  rearranging the tiles. If there's no monitor in that direction, Plasma shows
  a brief message instead of wrapping to the other side.
- Moving a tiled window onto a monitor showing a maximized window restores that
  window and tiles both. The incoming window keeps focus. If the windows can't
  fit, the move is blocked and the maximized window stays as it was.
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
- Actual application minimum/maximum sizes constrain tiling and interactive
  resizing. ktiler tries the preferred proportions first, then redistributes
  space within the same layout before moving or resizing any windows. For
  example, two windows can share a column unevenly when one needs more than
  half the height. Automatic adjustments don't overwrite the preferred
  proportions. If the layout still can't fit, ktiler tries the other layouts
  (binary first) and adopts the first one that fits, logging a diagnostic;
  preferred proportions reset on a mode switch, just as with an explicit
  layout change. If no layout fits, that output's windows are left unmanaged
  until something changes, rather than endlessly fighting applications. It does
  **not** yet implement a stacked/tabbed fallback for impossible layouts.
  Strict gap-free coverage cannot be promised for apps that refuse requested
  sizes or enforce incompatible aspect/increment constraints.
- Moves and swaps that no destination layout can satisfy are rejected up front,
  so window management state never silently diverges from the visible desktop.
  If an application persistently refuses the sizes of a freshly applied move,
  rotate, or layout change (within a few seconds), that change is automatically
  undone, restoring the previous arrangement instead of leaving transferred
  windows hidden behind the refusing window. Older refusals pause enforcement
  for that window only.
- Existing built-in KWin tile-editor layouts are **not rewritten**. Managed
  windows are detached from their original tiles; restore tries to reattach them
  if those original tile objects still exist.
- Monitor hotplug and desktop/activity changes are handled by the adapter, but
  mixed-DPI hardware, sleep/wake, XWayland applications, and unusual window rules
  still need a controlled real-desktop trial.

This is a tested prototype, **not yet a daily-driver release**.
