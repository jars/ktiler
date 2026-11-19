// Exercise the stock dialog's real Apply/OK/Cancel handlers in an isolated session.
#include <KCMultiDialog>
#include <KPluginMetaData>
#include <QApplication>
#include <QCheckBox>
#include <QDialogButtonBox>
#include <QLineEdit>
#include <QPushButton>
#include <QTest>

int main(int argc, char **argv)
{
    const auto root = qgetenv("KTILER_TEST_ROOT");
    if (qgetenv("KTILER_ISOLATED") != "1" || root.isEmpty()
        || !qgetenv("XDG_RUNTIME_DIR").startsWith(root + "/")
        || !qgetenv("XDG_CONFIG_HOME").startsWith(root + "/")) {
        qFatal("Refusing to run the stock dialog outside a private ktiler test session");
    }
    QApplication app(argc, argv);
    if (argc != 4) qFatal("Usage: stock-kcm apply|ok|cancel KEY VALUE");
    const auto action = QByteArray(argv[1]);
    const auto key = QStringLiteral("kcfg_") + QString::fromUtf8(argv[2]);
    const auto value = QString::fromUtf8(argv[3]);
    KCMultiDialog dialog;
    const KPluginMetaData module("kwin/effects/configs/kcm_kwin4_genericscripted");
    if (!dialog.addModule(module, {QStringLiteral("ktiler"), QStringLiteral("KWin/Script")})) qFatal("Failed to load the stock script module");
    dialog.show();
    QTest::qWait(50); // The stock dialog schedules its initial load.
    if (auto *field = dialog.findChild<QLineEdit *>(key)) field->setText(value);
    else if (auto *field = dialog.findChild<QCheckBox *>(key)) field->setChecked(value == "true");
    else qFatal("Settings field not found: %s", argv[2]);
    const auto role = action == "apply" ? QDialogButtonBox::Apply : action == "ok" ? QDialogButtonBox::Ok : QDialogButtonBox::Cancel;
    auto *buttons = dialog.findChild<QDialogButtonBox *>();
    auto *button = buttons ? buttons->button(role) : nullptr;
    if (!button || !button->isEnabled()) qFatal("Settings dialog action unavailable: %s", argv[1]);
    bool committed = false;
    QObject::connect(&dialog, &KCMultiDialog::configCommitted, &dialog, [&] { committed = true; });
    QTest::mouseClick(button, Qt::LeftButton);
    return committed == (action != "cancel") ? 0 : 1;
}
