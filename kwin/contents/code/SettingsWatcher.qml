import QtQml
import Qt.labs.folderlistmodel

QtObject {
    id: root
    required property url folder
    signal changed

    // Watch the directory as well as the file: KDE saves via atomic replace.
    property FolderListModel files: FolderListModel {
        folder: root.folder
        nameFilters: ["kwinrc"]
        showDirs: false
        onStatusChanged: if (status === FolderListModel.Ready) debounce.restart()
        onDataChanged: debounce.restart()
        onCountChanged: debounce.restart()
    }
    property Timer debounce: Timer {
        interval: 150
        onTriggered: root.changed()
    }
}
