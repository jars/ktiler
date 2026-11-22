#!/bin/sh
# Generated for ktiler.org by npm run build:kwin. Run as your regular desktop user.
set -eu

fail() {
    printf 'ktiler: %s\n' "$*" >&2
    exit 1
}

need() {
    command -v "$1" >/dev/null 2>&1 || fail "Required command not found: $1. Use Install from File in KWin Scripts instead."
}

check_session() {
    requirement='Requires KDE Plasma 6.3 or newer in a Wayland session.'
    [ "${XDG_SESSION_TYPE:-}" = wayland ] ||
        fail "$requirement Session type: ${XDG_SESSION_TYPE:-unknown}."
    case ":${XDG_CURRENT_DESKTOP:-}:" in
        *:KDE:*) ;;
        *) fail "$requirement Current desktop: ${XDG_CURRENT_DESKTOP:-unknown}." ;;
    esac
    command -v plasmashell >/dev/null 2>&1 || fail "$requirement Could not find plasmashell."
    plasma_version=$(plasmashell --version 2>/dev/null) ||
        fail "$requirement Could not read the Plasma version."
    case $plasma_version in
        plasmashell\ *.*) plasma_version=${plasma_version#plasmashell } ;;
        *) fail "$requirement Could not read the Plasma version." ;;
    esac
    major=${plasma_version%%.*}
    minor=${plasma_version#*.}
    minor=${minor%%.*}
    case "$major:$minor" in
        :*|*:|*:*:*|*[!0-9:]*) fail "$requirement Could not read the Plasma version." ;;
    esac
    if [ "$major" -gt 6 ] || { [ "$major" -eq 6 ] && [ "$minor" -ge 3 ]; }; then
        return
    fi
    fail "$requirement Detected Plasma $plasma_version."
}

xdg_home() {
    case $1 in
        /*) printf '%s\n' "$1" ;;
        *) printf '%s\n' "$HOME/$2" ;;
    esac
}

script_loaded() {
    # The Qt D-Bus client has different executable names across distributions.
    for client in qdbus6 qdbus-qt6; do
        if command -v "$client" >/dev/null 2>&1; then
            loaded=$("$client" org.kde.KWin /Scripting org.kde.kwin.Scripting.isScriptLoaded ktiler 2>/dev/null) || loaded=
            case $loaded in true|false) printf '%s\n' "$loaded"; return ;; esac
        fi
    done
    if command -v gdbus >/dev/null 2>&1; then
        loaded=$(gdbus call --session --timeout 5 --dest org.kde.KWin --object-path /Scripting \
            --method org.kde.kwin.Scripting.isScriptLoaded ktiler 2>/dev/null) || loaded=
        case $loaded in '(false,)') printf 'false\n'; return ;; '(true,)') printf 'true\n'; return ;; esac
    fi
    if command -v busctl >/dev/null 2>&1; then
        loaded=$(busctl --user --timeout=5s call org.kde.KWin /Scripting \
            org.kde.kwin.Scripting isScriptLoaded s ktiler 2>/dev/null) || loaded=
        case $loaded in 'b false') printf 'false\n'; return ;; 'b true') printf 'true\n'; return ;; esac
    fi
    return 1
}

read_enablement() {
    need kreadconfig6
    kreadconfig6 --file kwinrc --group Plugins --key ktilerEnabled --default false
}

check_upgrade() {
    message='Before updating, restore/pause ktiler, then untick it in System Settings → KWin Scripts and click Apply.'
    enabled=$(read_enablement) || fail "Could not read ktiler’s enablement. $message"
    [ "$enabled" = false ] || fail "$message"
    loaded=$(script_loaded) || fail "Could not verify that ktiler is unloaded. Run this in your Plasma Wayland session. $message"
    [ "$loaded" = false ] || fail "$message"
}

prepare_fresh_install() {
    # KDE can keep the enable flag after uninstalling a script. Do not expose
    # its replacement to KWin until the wizard can run the checks.
    enabled=$(read_enablement) || fail "Could not read ktiler’s enablement."
    case "$enabled" in
        false) return ;;
        true) ;;
        *) fail "Could not read ktiler’s enablement." ;;
    esac
    loaded=$(script_loaded) || fail "Could not verify that ktiler is unloaded. Run this from your Plasma session."
    [ "$loaded" = false ] ||
        fail "KWin is still running the removed copy of ktiler. Log out and back in before reinstalling."
    need kwriteconfig6
    kwriteconfig6 --file kwinrc --group Plugins --key ktilerEnabled --type bool false ||
        fail "Could not clear ktiler’s leftover enable setting. See the backup above."
    [ "$(read_enablement)" = false ] || fail "Could not verify that ktiler is disabled. See the backup above."
    printf 'Cleared the enable setting left by the previous installation.\n'
}

has_system_package() (
    IFS=:
    set -f
    for data_dir in ${XDG_DATA_DIRS:-/usr/local/share:/usr/share}; do
        case $data_dir in /*) [ ! -f "$data_dir/kwin/scripts/ktiler/metadata.json" ] || exit 0 ;; esac
    done
    exit 1
)

setup_desktop() {
    for program in python3 busctl kreadconfig6 kwriteconfig6; do
        if ! command -v "$program" >/dev/null 2>&1; then
            warning='⚠ SETUP NOT FINISHED — ktiler is installed, but its activation could not be verified.'
            if [ -t 1 ] && [ -n "${TERM:-}" ] && [ "$TERM" != dumb ] && [ "${NO_COLOR+x}" != x ]; then
                printf '\n\033[33m%s\033[0m\n' "$warning"
            else
                printf '\n%s\n' "$warning"
            fi
            printf 'Automatic setup requires %s.\nTo enable manually: System Settings → KWin Scripts → tick ktiler → Apply.\n' "$program"
            return
        fi
    done
    python3 -u - "$1" <<'KTILER_SETUP'
@@SETUP@@
KTILER_SETUP
}

main() {
    [ "$(id -u)" -ne 0 ] || fail 'Run as your normal user, without sudo.'
    check_session
    for command in curl sha256sum kpackagetool6 diff; do need "$command"; done

    download_url='@@DOWNLOAD_URL@@'
    archive_sha256='@@ARCHIVE_SHA256@@'
    version='@@VERSION@@'
    case $download_url in https://ktiler.org/releases/*) ;; *) fail 'Use the generated installer from ktiler.org.' ;; esac

    XDG_DATA_HOME=$(xdg_home "${XDG_DATA_HOME:-}" .local/share)
    XDG_CONFIG_HOME=$(xdg_home "${XDG_CONFIG_HOME:-}" .config)
    XDG_STATE_HOME=$(xdg_home "${XDG_STATE_HOME:-}" .local/state)
    export XDG_DATA_HOME XDG_CONFIG_HOME XDG_STATE_HOME
    package_root=$XDG_DATA_HOME/kwin/scripts
    installed=$package_root/ktiler
    theme=$XDG_DATA_HOME/icons/hicolor
    icon=$theme/256x256/apps/ktiler.png
    launcher=$XDG_DATA_HOME/applications/org.ktiler.Settings.desktop

    temporary=$(mktemp -d) || fail 'Could not create a temporary directory.'
    trap 'rm -rf -- "$temporary"' EXIT
    trap 'exit 1' HUP INT TERM
    archive=$temporary/ktiler.kwinscript
    curl -qfsSL --proto '=https' --connect-timeout 15 --max-time 120 -o "$archive" "$download_url" ||
        fail 'Could not download the release archive. Try again from ktiler.org.'
    printf '%s  %s\n' "$archive_sha256" "$archive" | sha256sum --check --status ||
        fail 'Release checksum mismatch. Nothing was installed; try again from ktiler.org.'

    # Let KPackage unpack and validate the archive without touching the live package or session bus.
    staged_root=$temporary/staged
    mkdir -p -- "$staged_root"
    DBUS_SESSION_BUS_ADDRESS=unix:path="$temporary/no-session-bus" \
        kpackagetool6 --type=KWin/Script --packageroot "$staged_root" --install "$archive" >/dev/null ||
        fail 'KPackage could not unpack the release. Make sure KWin is installed.'
    candidate=$staged_root/ktiler
    [ -f "$candidate/contents/images/ktiler-icon.png" ] &&
        [ -f "$candidate/contents/ui/org.ktiler.Settings.desktop" ] || fail 'The release is missing its icon or launcher.'

    action=--install
    [ ! -L "$installed" ] || fail "Refusing to replace a symlink: $installed"
    if [ -e "$installed" ]; then
        [ -d "$installed" ] || fail "Not a package directory: $installed"
        if diff -qr --no-dereference -- "$installed" "$candidate" >/dev/null; then
            action=
        else
            [ "$?" -eq 1 ] || fail 'Could not compare the installed package with the release.'
            check_upgrade
            action=--upgrade
        fi
    elif has_system_package; then
        fail 'A system-wide ktiler package is already installed. Update it through the same package manager instead.'
    fi

    backup_root=$XDG_STATE_HOME/ktiler/backups
    mkdir -p -- "$backup_root"
    backup=$(mktemp -d "$backup_root/web-XXXXXXXX") || fail 'Could not create a backup directory.'
    for source in "$installed" "$icon" "$launcher" "$XDG_CONFIG_HOME/kwinrc" "$XDG_CONFIG_HOME/kglobalshortcutsrc"; do
        if [ -e "$source" ] || [ -L "$source" ]; then cp -pPR -- "$source" "$backup/"; fi
    done
    printf 'Backup: %s\n' "$backup"

    if [ "$action" = --install ]; then
        prepare_fresh_install
    fi
    if [ -n "$action" ]; then
        mkdir -p -- "$package_root"
        if ! kpackagetool6 --type=KWin/Script --packageroot "$package_root" "$action" "$candidate" >"$temporary/package.log" 2>&1; then
            cat "$temporary/package.log" >&2
            if [ "$action" = --upgrade ] && [ ! -e "$installed" ] && [ ! -L "$installed" ]; then
                if cp -pPR -- "$backup/ktiler" "$installed"; then
                    printf 'Restored the previous ktiler package.\n' >&2
                fi
            fi
            fail "KPackage failed. See backup: $backup"
        fi
    fi
    mkdir -p -- "$theme/256x256/apps" "$XDG_DATA_HOME/applications"
    install -m 644 -- "$candidate/contents/images/ktiler-icon.png" "$icon"
    install -m 644 -- "$candidate/contents/ui/org.ktiler.Settings.desktop" "$launcher"
    touch -- "$theme"
    printf 'Installed ktiler %s and its Settings launcher.\n' "$version"
    setup_desktop "$backup"
}

main "$@"
