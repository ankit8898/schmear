#!/bin/sh
set -eu
arch=$(uname -m)
case "$arch" in x86_64|aarch64) ;; *) echo "Unsupported architecture: $arch" >&2; exit 1 ;; esac
f=schmear-tray-linux-$arch.tar.gz
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cd "$work"
url=https://github.com/kevin1chun/schmear/releases/latest/download
curl -fsSLO "$url/$f"
curl -fsSLO "$url/$f.sha256"
sha256sum -c "$f.sha256"
tar -xzf "$f"
sh "./${f%.tar.gz}/install.sh"
