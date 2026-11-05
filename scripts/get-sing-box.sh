#!/usr/bin/env bash
# Скачивает ядро sing-box той версии, что записана в sing-box.pin, сверяет SHA256
# и кладёт его под именем, которое ждёт Tauri.
#   bash scripts/get-sing-box.sh darwin-arm64 aarch64-apple-darwin
set -euo pipefail

ASSET_SUFFIX="$1"   # окончание имени архива в релизе sing-box, например darwin-arm64
TRIPLE="$2"         # целевая платформа Rust, например aarch64-apple-darwin

cd "$(dirname "$0")/.."

pin() { sed -n "s/^$1=\([^[:space:]]*\).*/\1/p" scripts/sing-box.pin; }
version=$(pin version)
expected=$(pin "$ASSET_SUFFIX")
[ -n "$expected" ] || { echo "В sing-box.pin нет SHA256 для $ASSET_SUFFIX" >&2; exit 1; }

name="sing-box-$version-$ASSET_SUFFIX.tar.gz"
tmp=$(mktemp -d)
echo "Скачиваю $name"
curl -fsSL "https://github.com/SagerNet/sing-box/releases/download/v$version/$name" -o "$tmp/sing-box.tar.gz"

if command -v sha256sum >/dev/null; then
  actual=$(sha256sum "$tmp/sing-box.tar.gz" | cut -d' ' -f1)
else
  actual=$(shasum -a 256 "$tmp/sing-box.tar.gz" | cut -d' ' -f1)
fi
if [ "$actual" != "$expected" ]; then
  echo "SHA256 архива sing-box не совпадает с sing-box.pin: ждали $expected, получили $actual" >&2
  exit 1
fi

tar -xzf "$tmp/sing-box.tar.gz" -C "$tmp"
mkdir -p src-tauri/binaries
bin=$(find "$tmp" -type f -name sing-box | head -n 1)
cp "$bin" "src-tauri/binaries/sing-box-$TRIPLE"
chmod +x "src-tauri/binaries/sing-box-$TRIPLE"
echo "Готово: sing-box $version, SHA256 совпал"
