// Tests the same UI loader and settings manager as KWin's generic script KCM.
#include <KAboutData>
#include <KConfigDialogManager>
#include <KConfigGroup>
#include <KConfigLoader>
#include <KLocalizedTranslator>
#include <KPluginMetaData>
#include <KSharedConfig>
#include <QApplication>
#include <QCheckBox>
#include <QComboBox>
#include <QDialog>
#include <QDialogButtonBox>
#include <QDir>
#include <QFile>
#include <QIcon>
#include <QLabel>
#include <QRegularExpression>
#include <QSignalSpy>
#include <QTextDocument>
#include <QUiLoader>
#include <QVBoxLayout>
#include <memory>
#include <stdexcept>

static void check(bool value, const char *message)
{
    if (!value) throw std::runtime_error(message);
}

template<typename T> static T *child(QWidget *form, const char *name)
{
    auto *result = form->findChild<T *>(QString::fromLatin1(name));
    check(result != nullptr, name);
    return result;
}

static std::unique_ptr<QWidget> loadForm(const QString &package)
{
    QFile file(package + "/contents/ui/config.ui");
    check(file.open(QIODevice::ReadOnly), "Cannot open packaged config.ui");
    QUiLoader ui;
    auto *form = ui.load(&file);
    if (!form) throw std::runtime_error(ui.errorString().toStdString());
    return std::unique_ptr<QWidget>(form);
}

// KWin's generic script KCM loads the form through this exact sequence, including a
// retranslation pass: see GenericScriptedConfig::createUi() in
// kwin/src/kcms/common/genericscriptedconfig.cpp.
static void testKWinLoading(const QString &package, const QString &directory)
{
    const auto metadata = KPluginMetaData::fromJsonFile(package + "/metadata.json");
    KLocalizedTranslator translator;
    QCoreApplication::installTranslator(&translator);
    translator.setTranslationDomain(metadata.value("X-KWin-Config-TranslationDomain"));

    QUiLoader uiLoader;
    uiLoader.setLanguageChangeEnabled(true);
    QFile file(package + "/contents/ui/config.ui");
    check(file.open(QIODevice::ReadOnly), "Cannot open packaged config.ui");
    auto *form = uiLoader.load(&file);
    if (!form) throw std::runtime_error(uiLoader.errorString().toStdString());
    translator.addContextToMonitor(form->objectName());
    QEvent languageChange(QEvent::LanguageChange);
    QCoreApplication::sendEvent(form, &languageChange);
    QApplication::processEvents();

    for (QComboBox *combo : form->findChildren<QComboBox *>()) {
        check(combo->count() > 0, "Combo box lost its items");
        for (int index = 0; index < combo->count(); ++index) {
            check(!combo->itemText(index).isEmpty(), "KWin's loading sequence blanked a combo item");
        }
        check(combo->currentIndex() >= 0, "KWin's loading sequence cleared a combo selection");
    }

    const auto fileName = directory + "/kwin-loading";
    auto config = KSharedConfig::openConfig(fileName, KConfig::SimpleConfig);
    KConfigGroup group(config, "Script-ktiler");
    group.writeEntry("Modifier", "Meta");
    group.writeEntry("DefaultLayout", "columns");
    group.sync();
    QFile schema(package + "/contents/config/main.xml");
    KConfigLoader settings(group, &schema);
    KConfigDialogManager manager(form, &settings);
    manager.updateWidgets();
    QApplication::processEvents();
    auto *modifier = form->findChild<QComboBox *>("kcfg_Modifier");
    auto *canonical = form->findChild<QComboBox *>("kcfg_DefaultLayout");
    check(modifier->currentText() == "Meta" && canonical->currentText() == "columns",
        "Existing settings did not load through KWin's loading sequence");
    modifier->setCurrentText("Alt");
    manager.updateSettings();
    config->reparseConfiguration();
    // KConfig skeletons remove entries that equal their defaults; absent means the default applies.
    check(!group.hasKey("Modifier") || group.readEntry("Modifier", QString()) == "Alt",
        "Wrong Modifier saved through KWin-style form");
    check(group.readEntry("DefaultLayout", QString("binary")) == "columns", "Wrong layout saved through KWin-style form");
    QCoreApplication::removeTranslator(&translator);
    // KWin keeps this form alive for the dialog's lifetime; delete the same way.
    form->deleteLater();
    QApplication::processEvents();
}

static void testSettings(const QString &package, const QString &directory, const QString &mode)
{
    const auto fileName = directory + "/roundtrip-" + mode;
    auto config = KSharedConfig::openConfig(fileName, KConfig::SimpleConfig);
    KConfigGroup group(config, "Script-ktiler");
    group.writeEntry("Modifier", "Meta");
    group.writeEntry("DefaultLayout", mode);
    group.writeEntry("SpreadResize", false);
    group.writeEntry("RegisterShortcuts", false);
    group.writeEntry("UnrelatedFutureSetting", "keep");
    group.sync();

    QFile schema(package + "/contents/config/main.xml");
    KConfigLoader settings(group, &schema);
    auto form = loadForm(package);
    KConfigDialogManager manager(form.get(), &settings);
    manager.updateWidgets();
    QApplication::processEvents();
    auto *modifier = child<QComboBox>(form.get(), "kcfg_Modifier");
    auto *canonical = child<QComboBox>(form.get(), "kcfg_DefaultLayout");
    auto *choice = child<QComboBox>(form.get(), "layoutChoice");
    auto *spread = child<QCheckBox>(form.get(), "kcfg_SpreadResize");
    check(!modifier->isEditable() && !choice->isEditable(), "Dropdowns must not accept free text");
    check(modifier->currentText() == "Meta", "Existing modifier did not load");
    check(canonical->currentText() == mode, "Existing lowercase layout did not load");
    check(choice->currentIndex() == canonical->currentIndex(), "Friendly label did not synchronize on load");
    check(!spread->isChecked() && !manager.hasChanged(), "Opening settings marked them dirty");
    QSignalSpy modified(&manager, &KConfigDialogManager::widgetModified);

    // Exercise every visible choice, dirty tracking, and canonical String save.
    for (int index = 0; index < choice->count(); ++index) {
        const auto previousSignals = modified.size();
        const auto previousIndex = choice->currentIndex();
        choice->setCurrentIndex(index);
        check(canonical->currentIndex() == index, "Visible layout did not update canonical value");
        if (previousIndex != index) {
            check(modified.size() > previousSignals && manager.hasChanged(), "Layout change did not notify KDE");
        }
        manager.updateSettings();
        config->reparseConfiguration();
        check(group.readEntry("DefaultLayout", QString("binary")) == canonical->itemText(index), "Saved layout is not canonical");
        check(!manager.hasChanged(), "Apply did not clear dirty state");
    }
    const auto beforeModifier = modified.size();
    modifier->setCurrentText("Alt");
    check(modified.size() > beforeModifier && manager.hasChanged(), "Modifier change did not notify KDE");
    manager.updateSettings();
    config->reparseConfiguration();
    check(group.readEntry("Modifier", QString("Alt")) == "Alt", "Modifier saved as an index instead of a String");
    spread->setChecked(true);
    check(manager.hasChanged(), "Checkbox change did not mark dirty");
    manager.updateSettings();
    config->reparseConfiguration();
    check(group.readEntry("SpreadResize", true), "Checkbox did not save");

    choice->setCurrentIndex(0);
    modifier->setCurrentText("Meta");
    manager.updateWidgets(); // Reset/cancel path: restore last applied values.
    check(choice->currentIndex() == 2 && modifier->currentText() == "Alt" && !manager.hasChanged(), "Reset failed");
    manager.updateWidgetsDefault();
    check(choice->currentIndex() == 0 && canonical->currentText() == "binary", "Defaults did not synchronize labels");
    check(modifier->currentText() == "Alt" && spread->isChecked() && manager.isDefault(), "Wrong factory defaults");
    check(manager.hasChanged(), "Defaults did not enable Apply");
    config->reparseConfiguration();
    check(group.readEntry("DefaultLayout", QString()) == "horizontal", "Defaults saved before Apply");
    manager.updateWidgets(); // Cancel the Defaults action.
    check(choice->currentIndex() == 2 && !manager.hasChanged(), "Reset after Defaults failed");
    manager.updateWidgetsDefault();
    manager.updateSettings();
    config->reparseConfiguration();
    check(group.readEntry("DefaultLayout", QString("binary")) == "binary", "Applying Defaults failed");
    check(!group.readEntry("RegisterShortcuts", true), "Hidden existing setting was overwritten");
    check(group.readEntry("UnrelatedFutureSetting", QString()) == "keep", "Unrelated setting was overwritten");
}

static void screenshot(const QString &package, const QString &directory, bool dark)
{
    if (dark) {
        auto palette = QApplication::palette();
        palette.setColor(QPalette::Window, QColor("#24262b"));
        palette.setColor(QPalette::WindowText, QColor("#eff0f1"));
        palette.setColor(QPalette::Base, QColor("#1b1d21"));
        palette.setColor(QPalette::AlternateBase, QColor("#303238"));
        palette.setColor(QPalette::Text, QColor("#eff0f1"));
        palette.setColor(QPalette::Button, QColor("#303238"));
        palette.setColor(QPalette::ButtonText, QColor("#eff0f1"));
        palette.setColor(QPalette::Link, QColor("#70b7ff"));
        QApplication::setPalette(palette);
    }
    QDialog dialog;
    dialog.setWindowTitle("Configure ktiler");
    auto *layout = new QVBoxLayout(&dialog);
    QFile schema(package + "/contents/config/main.xml");
    KConfigLoader settings(directory + "/preview-settings", &schema);
    auto form = loadForm(package);
    KConfigDialogManager manager(form.get(), &settings);
    manager.updateWidgets();
    auto *canonical = child<QComboBox>(form.get(), "kcfg_DefaultLayout");
    layout->addWidget(form.release());
    auto *buttons = new QDialogButtonBox(QDialogButtonBox::Help | QDialogButtonBox::Reset |
        QDialogButtonBox::RestoreDefaults | QDialogButtonBox::Ok | QDialogButtonBox::Apply | QDialogButtonBox::Cancel);
    layout->addWidget(buttons);
    dialog.adjustSize();
    dialog.show();
    QApplication::processEvents();
    check(!canonical->isVisible(), "Canonical value control must remain hidden");
    check(dialog.width() < 800 && dialog.height() < 700, "Configure dialog is too large");
    check(dialog.grab().save(directory + (dark ? "/configure-dark.png" : "/configure-light.png")), "Screenshot failed");
}

int main(int argc, char **argv)
{
    QApplication app(argc, argv);
    try {
        check(argc == 3, "Usage: branding PACKAGE TEMPORARY_DIRECTORY");
        check(qEnvironmentVariable("KTILER_ISOLATED") == "1", "Refusing to run outside isolated settings");
        const QString package = QString::fromLocal8Bit(argv[1]);
        const QString directory = QString::fromLocal8Bit(argv[2]);
        testKWinLoading(package, directory);
        for (const auto &mode : {"binary", "columns", "horizontal"}) testSettings(package, directory, mode);
        {
            QFile schema(package + "/contents/config/main.xml");
            KConfigLoader defaults(directory + "/fresh-settings", &schema);
            auto form = loadForm(package);
            KConfigDialogManager manager(form.get(), &defaults);
            manager.updateWidgets();
            check(manager.isDefault() && !manager.hasChanged(), "Fresh installation has incorrect defaults");
            check(child<QComboBox>(form.get(), "layoutChoice")->currentIndex() == 0, "Fresh layout is not Binary");
            check(!child<QCheckBox>(form.get(), "kcfg_DebugLogging")->isChecked(), "Debug logging must default off");
        }

        const auto metadata = KPluginMetaData::fromJsonFile(package + "/metadata.json");
        check(metadata.isValid() && metadata.pluginId() == "ktiler", "Plugin identity changed");
        check(metadata.iconName() == "ktiler", "Wrong icon metadata");
        check(metadata.version() == "0.1.3", "Wrong branded version");
        check(metadata.description() == "Keyboard-driven window tiling for KDE, with flexible layouts and seamless resizing.", "Wrong description");
        check(metadata.copyrightText() == QString::fromUtf8("© 2026 Jordan Arsenault"), "Wrong copyright");
        check(metadata.authors().size() == 1, "Missing author");
        check(metadata.authors().first().name() == "Jordan Arsenault", "Wrong author");
        check(metadata.authors().first().webAddress() == "https://jordanarseno.com", "Wrong author website");
        check(metadata.website() == "https://ktiler.org", "Wrong project website");
        check(metadata.bugReportUrl() == "https://github.com/jars/ktiler/issues", "Wrong bug report URL");
        check(metadata.license() == "MIT" && metadata.licenseText().contains("Permission is hereby granted"), "KDE MIT license viewer unavailable");
        QIcon::setThemeName("hicolor");
        qInfo() << "Icon theme search paths:" << QIcon::themeSearchPaths();
        check(QIcon::hasThemeIcon("ktiler"), "Installed themed icon is not discoverable");
        const auto icon = QIcon::fromTheme(metadata.iconName());
        check(!icon.pixmap(24, 24).isNull() && !icon.pixmap(64, 64).isNull(), "List/About icon failed to render");
        check(icon.pixmap(64, 64).save(directory + "/about-icon.png"), "Icon screenshot failed");

        auto form = loadForm(package);
        const auto *header = child<QLabel>(form.get(), "brandHeader");
        const auto match = QRegularExpression("src=\"([^\"]+)\"").match(header->text());
        check(match.hasMatch() && match.captured(1).startsWith("data:image/png;base64,"), "Wordmark is not portable");
        QTextDocument document;
        document.setHtml(header->text());
        const auto resource = document.resource(QTextDocument::ImageResource, QUrl(match.captured(1)));
        check(!resource.isNull(), "Qt could not decode embedded wordmark");
        for (const auto *name : {"shortcutHelp", "layoutHelp", "spreadHelp", "projectLinks"}) {
            check(child<QLabel>(form.get(), name)->openExternalLinks(), "Help link cannot open a browser");
        }
        screenshot(package, directory, false);
        screenshot(package, directory, true);
        qInfo("PASS: KDE configuration round-trips, dirty tracking, Reset/Defaults, metadata, MIT viewer, themed icon, and embedded wordmark.");
    } catch (const std::exception &error) {
        qCritical("%s", error.what());
        return 1;
    }
    return 0;
}
