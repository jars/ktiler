// Disposable test windows and fake input, ONLY for a private virtual KWin session.
#include <QApplication>
#include <QDBusConnection>
#include <QLabel>
#include <QPointer>
#include <QQueue>
#include <QTextStream>
#include <QTimer>
#include <QVBoxLayout>
#include <QWidget>
#include <wayland-client.h>
#include <algorithm>

static const wl_message fakeMethods[] = {
    {"authenticate", "ss", nullptr}, {"pointer_motion", "ff", nullptr},
    {"button", "uu", nullptr}, {"axis", "uf", nullptr},
    {"touch_down", "2uff", nullptr}, {"touch_motion", "2uff", nullptr},
    {"touch_up", "2u", nullptr}, {"touch_cancel", "2", nullptr},
    {"touch_frame", "2", nullptr}, {"pointer_motion_absolute", "3ff", nullptr},
    {"keyboard_key", "4uu", nullptr},
};
static const wl_interface fakeInterface = {"org_kde_kwin_fake_input", 4, 11, fakeMethods, 0, nullptr};

// The private session has no Plasma shell. Verify what KWin sends to its OSD.
class TestOsd : public QObject {
    Q_OBJECT
    Q_CLASSINFO("D-Bus Interface", "org.kde.osdService")
public slots:
    void showText(const QString &icon, const QString &text) {
        QTextStream(stdout) << "OSD " << icon << ' ' << text << Qt::endl;
    }
};

class Harness : public QObject {
    Q_OBJECT
    Q_CLASSINFO("D-Bus Interface", "org.ktiler.Test")
    wl_display *display = nullptr;
    wl_proxy *fake = nullptr;
    QQueue<QString> commands;
    QList<QPointer<QWidget>> windows;
    QPointer<QWidget> stubborn;
    QSize stubbornSize;
public:
    Harness() {
        display = wl_display_connect(nullptr);
        if (!display) qFatal("Could not connect to the isolated Wayland socket");
        auto registry = wl_display_get_registry(display);
        static const wl_registry_listener listener = {
            [](void *data, wl_registry *registry, uint32_t name, const char *interface, uint32_t version) {
                auto self = static_cast<Harness *>(data);
                if (QString::fromLatin1(interface) == QStringLiteral("org_kde_kwin_fake_input")) {
                    self->fake = static_cast<wl_proxy *>(wl_registry_bind(registry, name, &fakeInterface, std::min(version, 4u)));
                }
            },
            [](void *, wl_registry *, uint32_t) {},
        };
        wl_registry_add_listener(registry, &listener, this);
        wl_display_roundtrip(display);
        if (fake) {
            wl_proxy_marshal_flags(fake, 0, nullptr, wl_proxy_get_version(fake), 0, "ktiler isolated test", "Private virtual compositor only");
            wl_display_roundtrip(display);
        }
    }
public slots:
    void enqueue(const QString &command) { commands.enqueue(command); }
    QString next() { return commands.isEmpty() ? QString() : commands.dequeue(); }
    void report(const QString &result) { QTextStream(stdout) << "REPORT " << result << Qt::endl; }
    bool fakeInputAvailable() { return fake; }
    void createWindows(int count) {
        for (int i = 0; i < count; i++) {
            auto window = new QWidget;
            windows.append(window);
            window->setAttribute(Qt::WA_DeleteOnClose);
            window->setWindowTitle(QString("ktiler Test %1").arg(windows.size()));
            window->setMinimumSize(80, 60);
            window->resize(420, 300);
            auto layout = new QVBoxLayout(window);
            layout->addWidget(new QLabel(window->windowTitle(), window));
            window->show();
        }
    }
    void createConstrainedWindow(int width, int height) {
        // Qt sends xdg size hints when the window maps, not on later changes,
        // so the minimum must be set before show() for KWin to see it.
        auto window = new QWidget;
        windows.append(window);
        window->setAttribute(Qt::WA_DeleteOnClose);
        window->setWindowTitle(QString("ktiler Test %1").arg(windows.size()));
        window->setMinimumSize(width, height);
        window->resize(420, 300);
        auto layout = new QVBoxLayout(window);
        layout->addWidget(new QLabel(window->windowTitle(), window));
        window->show();
    }
    void minimize(int index, bool value) {
        if (index < 0 || index >= windows.size() || !windows[index]) return;
        if (value) windows[index]->showMinimized();
        else windows[index]->showNormal();
    }
    void closeWindow(int index) {
        if (index >= 0 && index < windows.size() && windows[index]) windows[index]->close();
    }
    // Emulates an application that refuses a tiler-requested resize: whenever
    // anything changes this window's size, it restores the held size. The lock
    // is the client size: scripted geometry sets the frame, decoration excluded.
    void holdSize(int index) {
        if (index < 0 || index >= windows.size() || !windows[index]) return;
        stubborn = windows[index];
        stubbornSize = stubborn->size();
        stubborn->installEventFilter(this);
    }
    void motion(double x, double y) {
        if (!fake) return;
        wl_proxy_marshal_flags(fake, 9, nullptr, wl_proxy_get_version(fake), 0, wl_fixed_from_double(x), wl_fixed_from_double(y));
        wl_display_roundtrip(display);
    }
    void key(uint32_t key, uint32_t state) {
        if (!fake) return;
        wl_proxy_marshal_flags(fake, 10, nullptr, wl_proxy_get_version(fake), 0, key, state);
        wl_display_roundtrip(display);
    }
protected:
    bool eventFilter(QObject *watched, QEvent *event) override {
        if (watched == stubborn && stubborn && event->type() == QEvent::Resize
            && stubborn->size() != stubbornSize) {
            QTimer::singleShot(0, stubborn, [this] { if (stubborn) stubborn->resize(stubbornSize); });
        }
        return QObject::eventFilter(watched, event);
    }
};

int main(int argc, char **argv) {
    const auto root = qgetenv("KTILER_TEST_ROOT");
    if (qgetenv("KTILER_ISOLATED") != "1" || root.isEmpty()
        || !qgetenv("XDG_RUNTIME_DIR").startsWith(root + "/")) {
        qFatal("Refusing to run input harness outside a private ktiler test session");
    }
    QApplication app(argc, argv);
    app.setQuitOnLastWindowClosed(false);
    Harness harness;
    TestOsd osd;
    auto bus = QDBusConnection::sessionBus();
    if (!bus.registerService("org.ktiler.Test") || !bus.registerObject("/Test", &harness, QDBusConnection::ExportAllSlots))
        qFatal("Could not register isolated test service");
    if (!bus.registerService("org.kde.plasmashell") || !bus.registerObject("/org/kde/osdService", &osd, QDBusConnection::ExportAllSlots))
        qFatal("Could not register isolated OSD");
    QTextStream(stdout) << "HARNESS_READY" << Qt::endl;
    return app.exec();
}
#include "harness.moc"
