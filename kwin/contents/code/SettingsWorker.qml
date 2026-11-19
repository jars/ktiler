import QtQml
import QtCore
import org.kde.kwin 3.0 as KWin
import "bindings.js" as Keys

QtObject {
    id: root
    readonly property string workerName: "ktiler-settings-worker"
    readonly property url configFolder: StandardPaths.writableLocation(StandardPaths.ConfigLocation)
    readonly property var bindings: Keys.shortcutBindings()
    property var shortcuts: ({})
    property var activeKeys: ({})
    property string observed: ""
    property bool busy: false
    property bool queued: false
    property bool initialized: false
    property var watcher: null

    // Read only ktiler's keys. QSettings reads an unescaped comma as a list;
    // joining it preserves Qt shortcut strings such as "Alt+,".
    property Settings config: Settings {
        location: root.configFolder + "/kwinrc"
        category: "Script-ktiler"
    }

    property KWin.DBusCall invoke: KWin.DBusCall {
        service: "org.kde.kglobalaccel"
        path: "/component/kwin"
        dbusInterface: "org.kde.kglobalaccel.Component"
        method: "invokeShortcut"
    }
    property KWin.DBusCall start: KWin.DBusCall {
        service: "org.kde.KWin"
        path: "/Scripting"
        dbusInterface: "org.kde.kwin.Scripting"
        method: "start"
        onFinished: {
            root.forward("ktiler-internal-applied")
            root.replaceKeys(root.readKeys())
        }
        onFailed: {
            root.observed = ""
            root.finished()
        }
    }
    property KWin.DBusCall checkController: KWin.DBusCall {
        service: "org.kde.KWin"
        path: "/Scripting"
        dbusInterface: "org.kde.kwin.Scripting"
        method: "isScriptLoaded"
        arguments: ["ktiler"]
        onFinished: result => { if (!result[0]) root.stop.call() }
    }
    property KWin.DBusCall checkBeforeReload: KWin.DBusCall {
        service: "org.kde.KWin"
        path: "/Scripting"
        dbusInterface: "org.kde.kwin.Scripting"
        method: "isScriptLoaded"
        arguments: ["ktiler"]
        onFinished: result => {
            if (result[0]) root.start.call()
            else root.stop.call()
        }
        onFailed: {
            root.observed = ""
            root.finished()
        }
    }
    property KWin.DBusCall stop: KWin.DBusCall {
        service: "org.kde.KWin"
        path: "/Scripting"
        dbusInterface: "org.kde.kwin.Scripting"
        method: "unloadScript"
        arguments: [root.workerName]
    }

    property KWin.ShortcutHandler reloadShortcut: KWin.ShortcutHandler {
        name: "ktiler-internal-reload"
        text: "ktiler: internal reload request"
        sequence: ""
        onActivated: root.reload(true)
    }
    property KWin.ShortcutHandler handshake: KWin.ShortcutHandler {
        name: "ktiler-internal-handshake"
        text: "ktiler: internal settings handshake"
        sequence: ""
        onActivated: root.forward("ktiler-internal-ready")
    }
    property Timer controllerLifetime: Timer {
        interval: 2000
        running: true
        repeat: true
        onTriggered: root.checkController.call()
    }

    property Component unregisterCall: Component {
        KWin.DBusCall {
            service: "org.kde.kglobalaccel"
            path: "/kglobalaccel"
            dbusInterface: "org.kde.KGlobalAccel"
            method: "unregister"
        }
    }
    property Component handler: Component {
        KWin.ShortcutHandler {
            required property string relay
            onActivated: root.forward(relay)
        }
    }

    function forward(name) {
        invoke.arguments = [name]
        invoke.call()
    }

    function readKeys() {
        config.sync()
        const enabled = String(config.value("RegisterShortcuts", true)) === "true"
        return bindings.map(({ setting, fallback }) => enabled ? String(config.value(setting, fallback)).trim() : "")
    }

    function reload(force) {
        const next = JSON.stringify([readKeys(), config.value("DefaultLayout", "binary"),
            config.value("SpreadResize", true), config.value("DebugLogging", false)])
        if (!force && (!initialized || observed === next)) return
        if (busy) {
            queued = true
            return
        }
        initialized = true
        observed = next
        busy = true
        checkBeforeReload.call()
    }

    function finished() {
        busy = false
        if (queued) {
            queued = false
            reload(true)
        }
    }

    function replaceKeys(keys) {
        const changed = bindings.map((binding, i) => ({ name: binding.name, text: binding.text, keys: keys[i] }))
            .filter(binding => activeKeys[binding.name] !== binding.keys)
        let remaining = changed.length
        let failed = false
        if (!remaining) {
            finished()
            return
        }
        function released() {
            if (--remaining) return
            // Release all changed bindings before grabbing any keys so swaps
            // work. Wait for the old QActions to be deleted before releasing.
            for (const binding of changed) {
                if (failed) {
                    delete activeKeys[binding.name]
                    continue
                }
                if (binding.keys) {
                    shortcuts[binding.name] = handler.createObject(root, {
                        name: binding.name, text: binding.text, sequence: binding.keys, relay: binding.name + "-relay"
                    })
                }
                activeKeys[binding.name] = binding.keys
            }
            if (failed) observed = ""
            finished()
        }
        for (const binding of changed) {
            const old = shortcuts[binding.name]
            if (old) {
                old.destroy()
                delete shortcuts[binding.name]
            }
        }
        // destroy() is deferred by Qt; a timer gives its DeferredDelete
        // events a turn before we unregister their names and reuse them.
        releaseOld.release = () => {
            for (const binding of changed) {
                const request = unregisterCall.createObject(root, { arguments: ["kwin", binding.name] })
                request.finished.connect(() => { request.destroy(); released() })
                request.failed.connect(() => { failed = true; request.destroy(); released() })
                request.call()
            }
        }
        releaseOld.start()
    }
    property Timer releaseOld: Timer {
        property var release
        interval: 25
        onTriggered: {
            const callback = release
            release = null
            callback()
        }
    }

    function attachWatcher(component) {
        if (component.status === Component.Ready) {
            watcher = component.createObject(root, { folder: configFolder })
            if (watcher) watcher.changed.connect(() => root.reload(false))
        } else if (component.status === Component.Loading) {
            component.statusChanged.connect(() => root.attachWatcher(component))
            return
        }
        if (!watcher) console.log("[ktiler] Automatic settings detection unavailable; use the Reload settings window menu item.")
    }

    Component.onCompleted: {
        attachWatcher(Qt.createComponent("SettingsWatcher.qml"))
        root.forward("ktiler-internal-ready")
    }
}
