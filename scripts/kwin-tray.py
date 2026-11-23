"""Optional Plasma StatusNotifierItem, embedded in the terminal installer."""

import os
from pathlib import Path
import subprocess
import sys
import tempfile

try:
    from gi.repository import Gio, GLib
except (ImportError, ValueError):
    sys.exit("The tray icon needs Python 3 with PyGObject and the Gio typelib.")


SERVICE = "org.ktiler.Tray"
TRAY_PATH = "/org/ktiler/Tray"
ITEM = "org.kde.StatusNotifierItem"
ITEM_PATH = "/StatusNotifierItem"
WATCHER = "org.kde.StatusNotifierWatcher"
KWIN = "org.kde.KWin"
ACCEL = "org.kde.kglobalaccel"
APP = "Desktop Entry"
LIVE = ("running", "paused")
DESCRIPTIONS = {
    "running": "Tiling is on · Click to pause",
    "paused": "Tiling is paused · Click to resume",
    "disabled": "KWin script is disabled · Click to open KWin Scripts",
    "waiting": "Waiting for ktiler · Click to open KWin Scripts",
}

INTERFACES = Gio.DBusNodeInfo.new_for_xml(f"""<node>
  <interface name="{ITEM}">
    <property name="Id" type="s" access="read"/>
    <property name="Title" type="s" access="read"/>
    <property name="Category" type="s" access="read"/>
    <property name="Status" type="s" access="read"/>
    <property name="ItemIsMenu" type="b" access="read"/>
    <property name="IconName" type="s" access="read"/>
    <property name="IconPixmap" type="a(iiay)" access="read"/>
    <property name="ToolTip" type="(sa(iiay)ss)" access="read"/>
    <method name="Activate"><arg type="i" direction="in"/><arg type="i" direction="in"/></method>
    <method name="ProvideXdgActivationToken"><arg type="s" direction="in"/></method>
    <signal name="NewIcon"/>
    <signal name="NewToolTip"/>
  </interface>
  <interface name="{SERVICE}">
    <method name="SetTilingEnabled"><arg type="b" direction="in"/></method>
  </interface>
</node>""")


def xdg_home(variable, default):
    value = Path(os.environ.get(variable, ""))
    return value if value.is_absolute() else Path.home() / default


def data_home():
    return xdg_home("XDG_DATA_HOME", ".local/share")


def icon_pixmaps(state):
    # A small version of the ktiler grid, with a pause or disabled badge.
    edge = b"\xff\x30\x4b\x69" if state == "running" else b"\xff\x46\x50\x5f"
    tile = b"\xff\x9a\xc4\xee" if state == "running" else b"\xff\x97\x9e\xa7"
    white = b"\xff\xff\xff\xff"
    for scale in (1, 2):
        size = 22 * scale
        pixels = bytearray(size * size * 4)

        def fill(x, y, width, height, color):
            start = x * scale
            for row in range(y * scale, (y + height) * scale):
                at = (row * size + start) * 4
                pixels[at:at + width * scale * 4] = color * (width * scale)

        fill(2, 2, 18, 18, edge)
        for x, y, width, height in [(3, 3, 7, 7), (11, 3, 8, 7), (3, 11, 3, 3),
                                    (7, 11, 3, 3), (3, 15, 7, 4), (11, 11, 8, 8)]:
            fill(x, y, width, height, tile)
        if state != "running":
            fill(12, 12, 10, 10, edge)
            if state == "paused":
                for x in (14, 18):
                    fill(x, 14, 2, 6, white)
            else:
                for x in range(14, 20):
                    fill(x, 33 - x, 1, 2, white)
        # StatusNotifierItem uses A,R,G,B bytes in network order.
        yield size, size, bytes(pixels)


class Tray:
    def __init__(self, connection, loop):
        self.connection = connection
        self.loop = loop
        self.package = data_home() / "kwin/scripts/ktiler/metadata.json"
        self.state = "waiting"
        self.kwin_owner = None
        self.watcher = None
        self.owns_name = False
        self.probing = False
        self.revision = 0
        self.activation = (None, "")
        register = getattr(connection, "register_object_with_closures2", connection.register_object)
        register(ITEM_PATH, INTERFACES.lookup_interface(ITEM), self.item_method, self.read_property)
        register(TRAY_PATH, INTERFACES.lookup_interface(SERVICE), self.receive_state)
        Gio.bus_watch_name_on_connection(connection, WATCHER, Gio.BusNameWatcherFlags.NONE,
                                         self.watcher_added, self.watcher_removed)
        Gio.bus_watch_name_on_connection(connection, KWIN, Gio.BusNameWatcherFlags.NONE,
                                         self.kwin_added, self.kwin_removed)
        Gio.bus_own_name_on_connection(connection, SERVICE,
                                       Gio.BusNameOwnerFlags.ALLOW_REPLACEMENT | Gio.BusNameOwnerFlags.REPLACE,
                                       self.name_acquired, lambda *_: loop.quit())
        connection.connect("closed", lambda *_: loop.quit())
        GLib.timeout_add_seconds(1, self.refresh)

    def call(self, name, path, interface, method, args, callback=None):
        self.connection.call(name, path, interface, method, args, None,
                             Gio.DBusCallFlags.NO_AUTO_START, 1500, None, callback)

    def name_acquired(self, *_):
        self.owns_name = True
        self.register_item()
        self.refresh()

    def watcher_added(self, _connection, _name, owner):
        self.watcher = owner
        self.register_item()

    def watcher_removed(self, *_):
        self.watcher = None

    def register_item(self):
        if self.watcher and self.owns_name:
            self.call(self.watcher, "/StatusNotifierWatcher", WATCHER, "RegisterStatusNotifierItem",
                      GLib.Variant("(s)", (ITEM_PATH,)))

    def kwin_added(self, _connection, _name, owner):
        self.kwin_owner = owner
        self.refresh()

    def kwin_removed(self, *_):
        self.kwin_owner = None
        self.set_state("disabled")

    def read_property(self, _connection, _sender, _path, _interface, name):
        if name == "IconPixmap":
            return GLib.Variant("a(iiay)", list(icon_pixmaps(self.state)))
        if name == "ToolTip":
            return GLib.Variant("(sa(iiay)ss)", ("", [], "ktiler", DESCRIPTIONS[self.state]))
        if name == "ItemIsMenu":
            return GLib.Variant("b", False)
        return GLib.Variant("s", {"Id": "ktiler", "Title": "ktiler", "Category": "ApplicationStatus",
                                  "Status": "Active", "IconName": ""}[name])

    def set_state(self, state):
        if self.state == state:
            return
        self.state = state
        for signal in ("NewIcon", "NewToolTip"):
            self.connection.emit_signal(None, ITEM_PATH, ITEM, signal, None)

    def receive_state(self, _connection, sender, _path, _interface, _method, params, invocation):
        if sender != self.kwin_owner:
            invocation.return_dbus_error("org.freedesktop.DBus.Error.AccessDenied", "Expected KWin")
            return
        self.revision += 1
        self.set_state("running" if params.unpack()[0] else "paused")
        invocation.return_value(None)

    def invoke(self, name):
        self.call(ACCEL, "/component/kwin", "org.kde.kglobalaccel.Component", "invokeShortcut",
                  GLib.Variant("(s)", (name,)))

    def refresh(self):
        if not self.package.is_file():
            self.loop.quit()
            return False
        if self.owns_name and self.kwin_owner and not self.probing:
            self.probing = True
            owner, revision = self.kwin_owner, self.revision

            def checked(connection, result):
                self.probing = False
                try:
                    loaded = connection.call_finish(result).unpack()[0]
                except GLib.Error:
                    return
                if (owner, revision) != (self.kwin_owner, self.revision):
                    return
                if not loaded:
                    self.set_state("disabled")
                elif self.state not in LIVE:
                    self.set_state("waiting")
                    self.invoke("ktiler-internal-tray-status")

            self.call(owner, "/Scripting", "org.kde.kwin.Scripting", "isScriptLoaded",
                      GLib.Variant("(s)", ("ktiler",)), checked)
        return True

    def item_method(self, _connection, sender, _path, _interface, method, params, invocation):
        if method == "ProvideXdgActivationToken":
            self.activation = (sender, params.unpack()[0])
        else:
            owner, token = self.activation
            self.activation = (None, "")
            if self.state in LIVE:
                self.invoke("ktiler-Pause-relay")
            else:
                env = {**os.environ, "XDG_ACTIVATION_TOKEN": token} if owner == sender and token else None
                try:
                    subprocess.Popen(["kcmshell6", "kcm_kwin_scripts"], env=env, stdin=subprocess.DEVNULL,
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
                except OSError:
                    pass
        invocation.return_value(None)


def write_file(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as temporary:
        pending = Path(temporary.name)
        try:
            temporary.write(data)
            temporary.close()
            pending.replace(path)
        finally:
            pending.unlink(missing_ok=True)


def install():
    tray = data_home() / "ktiler/tray.py"
    desktop = xdg_home("XDG_CONFIG_HOME", ".config") / "autostart" / f"{SERVICE}.desktop"
    entry = GLib.KeyFile()
    hidden = False
    if desktop.is_file():
        previous = GLib.KeyFile()
        try:
            previous.load_from_file(str(desktop), GLib.KeyFileFlags.NONE)
            hidden = previous.get_boolean(APP, "Hidden")
        except GLib.Error:
            pass
    # Desktop Exec has its own quoting rules, separate from key-file escaping.
    def argument(value):
        text = str(value).replace("%", "%%")
        return '"' + "".join("\\" + c if c in '"\\$`' else c for c in text) + '"'

    entry.set_string(APP, "Type", "Application")
    entry.set_string(APP, "Name", "ktiler Tray")
    entry.set_string(APP, "Icon", "ktiler")
    entry.set_string(APP, "Exec", f"/usr/bin/env python3 {argument(tray)}")
    entry.set_string_list(APP, "OnlyShowIn", ["KDE"])
    entry.set_boolean(APP, "Hidden", hidden)
    write_file(tray, Path(__file__).read_bytes())
    write_file(desktop, entry.to_data()[0].encode("utf-8"))
    if not hidden:
        subprocess.Popen([sys.executable, str(tray)], stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)


def main():
    if sys.argv[1:] == ["--install"]:
        try:
            install()
        except OSError as error:
            sys.exit(f"Could not install the tray icon: {error}")
    else:
        if not (data_home() / "kwin/scripts/ktiler/metadata.json").is_file():
            return
        try:
            connection = Gio.bus_get_sync(Gio.BusType.SESSION)
        except GLib.Error:
            return
        loop = GLib.MainLoop()
        Tray(connection, loop)
        loop.run()


if __name__ == "__main__":
    main()
