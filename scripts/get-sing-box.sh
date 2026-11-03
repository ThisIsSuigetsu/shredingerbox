#!/usr/bin/env bash
# Скачивает последнее ядро sing-box для macOS/Linux и кладёт его под именем, которое ждёт Tauri.
#   bash scripts/get-sing-box.sh darwin-arm64 aarch64-apple-darwin
set -euo pipefail

ASSET_SUFFIX="$1"   # окончание имени архива в релизе sing-box, например darwin-arm64
TRIPLE="$2"         # целевая платформа Rust, например aarch64-apple-darwin

cd "$(dirname "$0")/.."

api="https://api.github.com/repos/SagerNet/sing-box/releases/latest"
if [ -n "${GITHUB_TOKEN:-}" ]; then
  release_json=$(curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" "$api")
else
  release_json=$(curl -fsSL "$api")
fi

url=$(printf '%s' "$release_json" | python3 -c "
import json, sys
data = json.load(sys.stdin)
suffix = '-' + sys.argv[1] + '.tar.gz'
print(next(a['browser_download_url'] for a in data['assets'] if a['name'].endswith(suffix)))
" "$ASSET_SUFFIX")

tmp=$(mktemp -d)
echo "Скачиваю $url"
curl -fsSL "$url" -o "$tmp/sing-box.tar.gz"
tar -xzf "$tmp/sing-box.tar.gz" -C "$tmp"

mkdir -p src-tauri/binaries
bin=$(find "$tmp" -type f -name sing-box | head -n 1)
cp "$bin" "src-tauri/binaries/sing-box-$TRIPLE"
chmod +x "src-tauri/binaries/sing-box-$TRIPLE"
echo "Готово: src-tauri/binaries/sing-box-$TRIPLE"
