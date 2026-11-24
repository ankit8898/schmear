#!/bin/sh
# Installs schmear-tray for this user from the directory holding this script: an extracted release archive or a staged build.
set -eu
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
bin="$HOME/.local/bin"
# The XDG spec ignores relative values.
data="${XDG_DATA_HOME:-}"
case "$data" in /*) ;; *) data="$HOME/.local/share" ;; esac
config="${XDG_CONFIG_HOME:-}"
case "$config" in /*) ;; *) config="$HOME/.config" ;; esac
# Without these, Exec="…" needs no escaping; Open at Login refuses the same set.
case "$bin" in
*[\"\\\$\`%[:cntrl:]]*)
	printf 'install.sh: %s must not contain quotes, backslashes, $, backticks, %% or control characters\n' "$bin" >&2
	exit 1
	;;
esac
# A missing Qt runtime would otherwise only show up as a launcher that does nothing.
if missing=$(ldd "$here/schmear-tray" 2>&1 | grep 'not found'); then
	printf 'install.sh: schmear-tray needs libraries this system lacks:\n%s\n' "$missing" >&2
	echo "Install the runtime packages for your distribution: https://github.com/kevin1chun/schmear#linux-tray-app" >&2
	exit 1
fi
mkdir -p "$bin" "$data/applications" "$data/icons/hicolor/scalable/apps"
# Copy then rename, so a running schmear-tray is replaced rather than written over.
cp "$here/schmear-tray" "$bin/.schmear-tray.new"
chmod 755 "$bin/.schmear-tray.new"
mv -f "$bin/.schmear-tray.new" "$bin/schmear-tray"
cp "$here/schmear-tray.svg" "$data/icons/hicolor/scalable/apps/schmear-tray.svg"
# GTK trusts an icon cache only while the theme directory is older than it, as xdg-icon-resource relies on.
touch "$data/icons/hicolor"
cat >"$data/applications/schmear-tray.desktop" <<ENTRY
[Desktop Entry]
Type=Application
Name=schmear
Comment=Subscription pools, pace and delegations from the schmear CLI
Exec="$bin/schmear-tray"
Icon=schmear-tray
Terminal=false
StartupWMClass=schmear-tray
Categories=Utility;
ENTRY
# Open at Login may have been turned on from another copy, such as the extracted archive; point it here.
autostart="$config/autostart/schmear-tray.desktop"
if [ -f "$autostart" ]; then
	awk -v exec="Exec=\"$bin/schmear-tray\"" '/^Exec=/ { print exec; next } { print }' "$autostart" >"$autostart.new"
	mv -f "$autostart.new" "$autostart"
fi
echo "Installed $bin/schmear-tray; start it from your app menu."
if pgrep -x schmear-tray >/dev/null 2>&1; then
	echo "schmear-tray is running: quit it from its tray menu and start it again to use this version."
fi
