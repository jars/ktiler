#!/usr/bin/env python3
"""Transfer only this project's legacy shortcuts through KDE's live D-Bus API."""
import argparse
import datetime
import json
import os
from pathlib import Path
import shutil
import sys

SUFFIXES = (
    ["Layout-binary", "Layout-columns", "Layout-horizontal"]
    + [f"{action}-{direction}" for action in ("Focus", "Move") for direction in ("Left", "Right", "Up", "Down")]
    + [f"Monitor-{number}" for number in range(1, 11)]
    + ["RotateClockwise", "RotateCounterclockwise", "Pause", "Restore", "SpreadResize"]
)


def normalize(keys):
    """Ignore KDE's zero-filled representation of an unbound shortcut."""
    return tuple(tuple(int(code) for code in key) for key in keys if any(int(code) for code in key))


def plan_transfer(api):
    actions = {action[1]: action for action in api.actions()}
    plan = []
    for suffix in SUFFIXES:
        old, new = f"KDETiler-{suffix}", f"ktiler-{suffix}"
        if old not in actions or new not in actions:
            raise RuntimeError(f"Missing registered action: {old} or {new}; enable ktiler first.")
        source, target = normalize(api.keys(actions[old])), normalize(api.keys(actions[new]))
        if not source:
            continue  # Preserve intentionally unbound actions and already-migrated targets.
        if target and target != source:
            raise RuntimeError(f"{new} already has a different binding; refusing to overwrite it.")
        for key in source:
            owner = api.owner(key)
            if owner and (owner[0] != "kwin" or owner[1] not in (old, new)):
                raise RuntimeError(f"{old}'s shortcut belongs to another action: {owner}")
        plan.append((actions[old], actions[new], source))
    return plan


def transfer(api, plan):
    """Preflight first; restore targeted bindings on failure; never clean an entire component."""
    before = {tuple(action): normalize(api.keys(action)) for action in api.actions()}
    targeted = {tuple(action) for old, new, _ in plan for action in (old, new)}
    for old, new, keys in plan:
        if before[tuple(old)] != keys or before[tuple(new)] not in ((), keys):
            raise RuntimeError("Bindings changed since preflight; run the inspection again.")
    try:
        # Release old reservations before assigning anything, including safety shortcuts.
        for old, _, _ in plan:
            api.set_keys(old, ())
        for old, new, keys in plan:
            api.set_keys(new, keys)
            if normalize(api.keys(old)) or normalize(api.keys(new)) != keys:
                raise RuntimeError(f"KDE did not accept the transfer to {new[1]}.")
            for key in keys:
                owner = api.owner(key)
                if not owner or owner[:2] != new[:2]:
                    raise RuntimeError(f"KDE did not give {new[1]} ownership of its shortcut.")
        for action, keys in before.items():
            if action not in targeted and normalize(api.keys(action)) != keys:
                raise RuntimeError(f"An unrelated binding changed: {action[1]}")
    except Exception:
        for action in targeted:
            api.set_keys(action, ())
        for action in targeted:
            api.set_keys(action, before[action])
        raise


class KDE:
    def __init__(self):
        import dbus
        self.dbus = dbus
        self.bus = dbus.SessionBus()
        self.api = dbus.Interface(
            self.bus.get_object("org.kde.kglobalaccel", "/kglobalaccel"), "org.kde.KGlobalAccel"
        )

    def action_id(self, action):
        return self.dbus.Array(action, signature="s")

    def packed(self, keys):
        return self.dbus.Array(
            [self.dbus.Struct((self.dbus.Array(key, signature="i"),)) for key in keys], signature="(ai)"
        )

    def actions(self):
        return [tuple(map(str, action)) for action in self.api.allActionsForComponent(
            self.action_id(("kwin", "", "", ""))
        )]

    def keys(self, action):
        return [tuple(int(code) for code in sequence[0])
                for sequence in self.api.shortcutKeys(self.action_id(action))]

    def set_keys(self, action, keys):
        self.api.setForeignShortcutKeys(self.action_id(action), self.packed(keys))

    def owner(self, key):
        packed = self.packed((key,))
        return tuple(map(str, self.api.actionList(packed[0])))

    def old_loaded(self):
        scripting = self.bus.get_object("org.kde.KWin", "/Scripting")
        return bool(scripting.isScriptLoaded("kdetiler"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Apply the scoped migration; otherwise only inspect it.")
    args = parser.parse_args()
    api = KDE()
    if api.old_loaded():
        raise RuntimeError("Disable the old KDETiler script and Apply before migrating shortcuts.")
    plan = plan_transfer(api)
    if not plan:
        print("No bound legacy actions remain to transfer. Existing ktiler bindings were left unchanged.")
        return
    print(f"{len(plan)} bound actions can be transferred; unrelated shortcuts will be verified unchanged.")
    if not args.apply:
        print("Dry run only. Pass --apply to back up settings and transfer the bindings.")
        return
    backup = Path("/tmp/opencode") / (
        "ktiler-shortcut-backup-" + datetime.datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    )
    backup.mkdir(parents=True)
    configuration = Path(os.environ.get("XDG_CONFIG_HOME", str(Path.home() / ".config")))
    for filename in ("kglobalshortcutsrc", "kwinrc"):
        source = configuration / filename
        if source.exists():
            shutil.copy2(source, backup / filename)
    snapshot = [{"action": action, "keys": normalize(api.keys(action))} for action in api.actions()]
    (backup / "bindings-before.json").write_text(json.dumps(snapshot, indent=2) + "\n")
    print(f"Backup: {backup}", flush=True)
    transfer(api, plan)
    (backup / "bindings-after.json").write_text(json.dumps(
        [{"action": action, "keys": normalize(api.keys(action))} for action in api.actions()], indent=2
    ) + "\n")
    print(f"Transferred and verified {len(plan)} bindings, including pause/restore.")
    print("All unrelated KWin bindings are unchanged. The old package was not removed.")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Migration stopped: {error}", file=sys.stderr)
        sys.exit(1)
