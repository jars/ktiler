"""Generated into install.sh; only the Python standard library is needed."""

import collections
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import time
import unicodedata


BINDINGS = []  # @@BINDINGS@@
KWIN = ("org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting")
EFFECTS = ("org.kde.KWin", "/Effects", "org.kde.kwin.Effects")
ACCEL = ("org.kde.kglobalaccel", "/kglobalaccel", "org.kde.KGlobalAccel")
TILERS = {
    "krohnkite": "Krohnkite",
    "polonium": "Polonium",
    "bismuth": "Bismuth",
    "grid-tiling": "Grid Tiling",
    "KLeftHandTiler": "KLeftHandTiler",
    "plasmazones": "PlasmaZones",
    "kwin_effect_plasmazones": "PlasmaZones",
}
QT_MODIFIERS = {"shift": 0x02000000, "ctrl": 0x04000000, "alt": 0x08000000,
                "meta": 0x10000000, "num": 0x20000000}
QT_KEYS = {name: 0x01000000 + offset for offset, name in enumerate(
    ["esc", "tab", "backtab", "backspace", "return", "enter", "ins", "del",
     "pause", "print", "sysreq", "clear"], 0)}
QT_KEYS.update({name: 0x01000000 + offset for offset, name in enumerate(
    ["home", "end", "left", "up", "right", "down", "pgup", "pgdown"], 0x10)})
QT_KEYS.update({"space": 32, "escape": QT_KEYS["esc"], "insert": QT_KEYS["ins"],
                "delete": QT_KEYS["del"], "pageup": QT_KEYS["pgup"], "pagedown": QT_KEYS["pgdown"],
                "menu": 0x01000055})
US_LAYOUT = {"Alt+!": "Alt+Shift+1", "Alt+@": "Alt+Shift+2", "Alt+#": "Alt+Shift+3"}


class SetupError(Exception):
    pass


def clean(text):
    return "".join(c if not unicodedata.category(c).startswith("C") else " " for c in text)


def run(*args):
    try:
        return subprocess.run(args, check=True, text=True, capture_output=True, timeout=5).stdout
    except (OSError, subprocess.SubprocessError) as error:
        raise SetupError(f"Could not complete a KDE check ({args[0]}).") from error


def bus(operation, address, method, signature="", *args, reply=True):
    request = ["busctl", "--user", "--json=short", "--timeout=4s", "--", operation, *address, method]
    if signature:
        request.extend([signature, *map(str, args)])
    result = run(*request)
    if not reply:
        return
    try:
        data = json.loads(result)["data"]
        return data if operation == "get-property" else data[0]
    except (ValueError, KeyError, IndexError, TypeError) as error:
        raise SetupError("KDE returned an unexpected response.") from error


def call(address, method, signature="", *args, reply=True):
    return bus("call", address, method, signature, *args, reply=reply)


def setting(group, key, default):
    return run("kreadconfig6", "--file", "kwinrc", "--group", group, "--key", key, "--default", default).strip()


def enabled(group, key, default="false"):
    value = setting(group, key, default).lower()
    if value not in ("true", "false"):
        raise SetupError(f"Could not read the KDE setting {key}.")
    return value == "true"


def loaded(plugin="ktiler"):
    return call(KWIN, "isScriptLoaded", "s", plugin)


def configure(value):
    run("kwriteconfig6", "--file", "kwinrc", "--group", "Plugins",
        "--key", "ktilerEnabled", "--type", "bool", "true" if value else "false")
    # Same KWin scripting call used by Apply in KWin Scripts.
    call(KWIN, "start", reply=False)


def known_tilers():
    effects = set(bus("get-property", EFFECTS, "loadedEffects"))
    return list(dict.fromkeys(label for plugin, label in TILERS.items()
                              if plugin in effects or enabled("Plugins", plugin + "Enabled")
                              or loaded(plugin)))


def key_code(value):
    # Qt portable shortcut text. Fail closed for unsupported spellings or
    # multi-stroke custom bindings instead of guessing which global key to edit.
    flags = 0
    key = value
    while "+" in key:
        modifier, _, rest = key.partition("+")
        bit = QT_MODIFIERS.get(modifier.strip().lower(), 0)
        if not bit:
            break
        if flags & bit:
            return None
        flags |= bit
        key = rest.strip()
    upper = key.upper()
    if len(key) == 1 and len(upper) == 1 and key.isascii() and not key.isspace():
        return flags | ord(upper)
    if re.fullmatch(r"F([1-9]|[12][0-9]|3[0-5])", upper):
        return flags | (0x0100002F + int(upper[1:]))
    code = QT_KEYS.get(key.casefold())
    return flags | code if code else None


def bindings():
    register = enabled("Script-ktiler", "RegisterShortcuts", "true")
    result = []
    for name, key, label, fallback in BINDINGS:
        value = setting("Script-ktiler", key, fallback) if register else ""
        display = US_LAYOUT.get(value, value) if value == fallback else value
        result.append((name, label, value, display, key_code(value)))
    return result


def matches(code, mode=0):
    return call(ACCEL, "globalShortcutsByKey", "(ai)(i)", 4, code, 0, 0, 0, mode)


def owner(binding, item):
    return item[0] == binding[0] and item[2] == "kwin" and item[4] == "default"


def conflicts(desired):
    count = collections.Counter(code for *_, code in desired if code)
    rows, targets = [], set()
    can_unbind = True
    for binding in desired:
        _, label, raw, display, code = binding
        if not raw:
            continue
        if code is None:
            rows.append((display, label, "Unsupported shortcut spelling; change it in ktiler Settings"))
            can_unbind = False
            continue
        if count[code] > 1:
            rows.append((display, label, "Another ktiler action uses this key"))
            can_unbind = False
        for match_type in (0, 2):  # KGlobalAccel::Equal and ::Shadowed.
            for entry in matches(code, match_type):
                if owner(binding, entry) or (match_type == 2 and code in entry[6]):
                    continue
                action, description, app, friendly, context = entry[:5]
                text = f"{friendly or app}: {description or action}"
                if match_type == 2:
                    text += " (part of a longer shortcut; resolve manually)"
                    can_unbind = False
                else:
                    targets.add((app, action, context, code))
                rows.append((display, label, text))
    return sorted(rows), sorted(targets), can_unbind


def action_keys(action_id):
    reply = call(ACCEL, "shortcutKeys", "as", 4, *action_id)
    try:
        sequences = {tuple(sequence) for (sequence,) in reply}
    except (ValueError, TypeError) as error:
        raise SetupError("KDE returned an invalid shortcut list.") from error
    if any(len(item) != 4 or not all(isinstance(key, int) for key in item) for item in sequences):
        raise SetupError("KDE returned an invalid shortcut sequence.")
    return sequences


def set_keys(action_id, sequences):
    keys = sorted(sequences)
    encoded = [value for seq in keys for value in (len(seq), *seq)]
    # setForeignShortcutKeys keeps the action, defaults, and other keys intact
    # and notifies the owning application, as KDE's own Shortcuts module does.
    call(ACCEL, "setForeignShortcutKeys", "asa(ai)", 4, *action_id, len(keys), *encoded, reply=False)
    if action_keys(action_id) != sequences:
        raise SetupError("KDE did not confirm the requested shortcut change.")


def unbind(targets, backup, undo):
    removals = collections.defaultdict(set)
    for app, action, context, code in targets:
        removals[(app + "|" + context, action, "", "")].add((code, 0, 0, 0))
    changes = []
    for action_id, drop in removals.items():
        before = action_keys(action_id)
        if not drop <= before:
            raise SetupError("A conflicting shortcut changed. No new keys were removed.")
        changes.append((action_id, before, before - drop))
    # The installer already backed up kglobalshortcutsrc. Also record the
    # live assignments so there is a backup even if KDE hadn't flushed it yet.
    number = 1 + len(list(backup.glob("live-shortcuts-*.json")))
    with (backup / f"live-shortcuts-{number}.json").open("x", encoding="utf-8") as log:
        json.dump([{"action": action_id[:2], "before": sorted(before), "after": sorted(after)}
                   for action_id, before, after in changes], log, indent=2)
    for action_id, before, after in changes:
        if action_keys(action_id) != before:
            raise SetupError("A shortcut changed during setup.")
        undo.append((action_id, before, after))
        set_keys(action_id, after)


def restore_keys(undo):
    warnings = []
    for action_id, before, after in reversed(undo):
        try:
            current = action_keys(action_id)
            if current == after:
                set_keys(action_id, before)
            elif current != before:
                warnings.append(action_id[1])
        except SetupError:
            warnings.append(action_id[1])
    if warnings:
        print("Could not safely restore these actions: " + clean(", ".join(warnings)) + ". See the backup above.")


def table(headers, rows):
    rows = [headers, *(tuple(clean(cell) for cell in row) for row in rows)]
    widths = [max(map(len, column)) for column in zip(*rows)]
    for index, row in enumerate(rows):
        print(" | ".join(cell.ljust(width) for cell, width in zip(row, widths)).rstrip())
        if not index:
            print("-+-".join("-" * width for width in widths))


def warn(message, disabled=True):
    status = ("⚠ SETUP NOT FINISHED — ktiler is installed but disabled." if disabled else
              "⚠ SETUP NOT FINISHED — ktiler is installed, but its activation could not be verified.")
    if sys.stdout.isatty() and os.environ.get("TERM") not in ("", "dumb", None) and "NO_COLOR" not in os.environ:
        status = "\033[33m" + status + "\033[0m"
    print(f"\n{status}\n{message}\n"
          "To enable manually: System Settings → KWin Scripts → tick ktiler → Apply.\n"
          "To edit bindings first, open ktiler Settings → Shortcuts.")


def terminal():
    if sys.stdout.isatty():
        try:
            tty = open("/dev/tty", encoding="utf-8", errors="replace")
            if os.tcgetpgrp(tty.fileno()) == os.getpgrp():
                return tty
            tty.close()
        except OSError:
            pass
    return None


def ask(tty, prompt, choices):
    if tty is None:
        return "e"
    while True:
        print(prompt, end=" ", flush=True)
        response = tty.readline()
        if not response:
            return "e"
        answer = response.strip().lower()
        if answer in choices:
            return answer


def open_settings():
    if shutil.which("kcmshell6"):
        try:
            subprocess.run(["kcmshell6", "--desktopfile", "org.ktiler.Settings",
                            "--caption", "ktiler Settings", "--icon", "ktiler", "--args",
                            "ktiler KWin/Script", "kwin/effects/configs/kcm_kwin4_genericscripted"],
                           stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, check=True)
            return
        except (OSError, subprocess.SubprocessError):
            pass
    print("Could not open settings. Search for ktiler Settings in the Application Launcher.")


def verified(binding):
    expected = (binding[4], 0, 0, 0) if binding[4] else None
    return expected is not None and expected in action_keys(("kwin|default", binding[0], "", ""))


def finish(tty):
    print("\n✓ ktiler is installed and enabled.")
    print("To change shortcuts or tiling preferences, open ktiler Settings in the Application Launcher.")
    if tty is not None and ask(tty, "Open ktiler Settings to change shortcuts now? [y/N]", {"y", "yes", "n", "no", "", "e"}) in ("y", "yes"):
        open_settings()
    print("\nShortcut cheat sheet")
    rows = []
    for binding in bindings():
        _, label, raw, display, _ = binding
        if raw:
            try:
                display += "" if verified(binding) else " (not registered)"
            except SetupError:
                display += " (not verified)"
        rows.append((display if raw else "Unbound", label))
    table(("Keystroke", "Action"), rows)
    if any(display in US_LAYOUT.values() for display, _ in rows):
        print("Number-row shortcuts are shown for a US keyboard.")


def setup(backup, tty):
    undo = []
    changed_enablement = False
    disabled = False
    try:
        is_enabled = enabled("Plugins", "ktilerEnabled")
        is_loaded = loaded()
        if is_enabled and is_loaded:
            finish(tty)
            return
        if is_enabled or is_loaded:
            raise SetupError("KWin's configured and running states differ. Check KWin Scripts before enabling.")
        disabled = True
        while True:
            tilers = known_tilers()
            if not tilers:
                break
            print("\nKnown auto-tilers enabled or running: " + ", ".join(tilers) + ".")
            print("Disable them in System Settings → KWin Scripts or Desktop Effects, then click Apply.")
            choice = ask(tty, "[Enter] Recheck   [S] Skip this check   [E] Exit setup:", {"", "s", "e"})
            if choice == "e":
                raise SetupError("Another tiler may still be active.")
            if choice == "s":
                print("Skipping the auto-tiler check only. Both tilers may try to arrange the same windows.")
                break

        while True:
            desired = bindings()
            report = conflicts(desired)
            rows, targets, can_unbind = report
            if not rows:
                break
            print("\nConflicting global shortcuts:")
            table(("Keystroke", "ktiler action", "Existing app and action"), rows)
            print(f"{len(rows)} conflict(s). Change bindings in ktiler Settings or System Settings → Shortcuts.")
            choices = {"", "e"}
            prompt = "[Enter] Recheck   [E] Exit setup:"
            if can_unbind and targets:
                choices.add("u")
                prompt = f"[U] Unbind the {len(targets)} listed assignment(s)   " + prompt
            if tty is None:
                raise SetupError("Shortcut conflicts need an interactive terminal or manual changes.")
            choice = ask(tty, prompt, choices)
            if choice == "e":
                raise SetupError("Shortcut conflicts were not resolved.")
            if choice == "u":
                fresh = bindings()
                if desired != fresh or report != conflicts(fresh):
                    print("Shortcuts changed while you were deciding. Review the updated list.")
                    continue
                unbind(targets, backup, undo)
                print("Removed the approved bindings. Checking KDE again.")

        changed_enablement = True
        disabled = False
        configure(True)
        deadline = time.monotonic() + 6
        while time.monotonic() < deadline:
            if loaded() and all(not binding[2] or verified(binding) for binding in desired):
                break
            time.sleep(0.2)
        else:
            raise SetupError("KWin did not load ktiler with all its expected shortcuts.")
    except (SetupError, OSError, KeyboardInterrupt) as error:
        if changed_enablement:
            try:
                configure(False)
                deadline = time.monotonic() + 3
                while loaded() and time.monotonic() < deadline:
                    time.sleep(0.2)
                disabled = not loaded() and not enabled("Plugins", "ktilerEnabled")
            except SetupError:
                pass
        if undo:
            restore_keys(undo)
        warn(clean(str(error)) or "Setup was cancelled.", disabled)
        return
    try:
        finish(tty)
    except (SetupError, KeyboardInterrupt):
        print("Open ktiler Settings → Shortcuts to see your bindings.")


if __name__ == "__main__":
    if not BINDINGS:
        sys.exit("Run the generated install.sh, not the setup template.")
    signal.signal(signal.SIGTERM, lambda *_: signal.default_int_handler(signal.SIGINT, None))
    setup(Path(sys.argv[1]), terminal())
