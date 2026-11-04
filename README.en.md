# ShredingerBox

[Русский](README.md) · **English**

A VPN client for Windows and macOS built on the [sing-box](https://github.com/SagerNet/sing-box) core.
Add a subscription, press one button, you're connected. Fine-tuning lives in advanced mode.

**[Download the latest version](https://github.com/ThisIsSuigetsu/shredingerbox/releases/latest)** ·
[Changelog](CHANGELOG.en.md)

## Features

**Connection**
- `vless://` (Reality, TLS, ws, grpc, httpupgrade), `hy2://` (Salamander, port ranges),
  `trojan://` and `ss://` keys.
- Subscriptions by `https://…` link - base64 or a list of keys, updated with one click or on a schedule.
- Copy a key or a subscription and the app offers to add it from the clipboard.
- Two modes: **TUN** - all computer traffic, **Proxy** - the system proxy, no administrator rights
  needed on Windows.

**Servers**
- Servers grouped by subscription, manual keys separately.
- Real ping of every server through the tunnel, switching without reconnecting.
- Download and upload speed, session timer, monthly traffic per server.

**Rules**
- Chosen apps go through the VPN or direct. Pick an app from running programs or point to an `.exe`.
- Chosen sites go through the VPN or direct; paste whole lists, one per line. "Sites direct" win over
  all other rules - handy for banking.
- Site presets: YouTube, Discord, Instagram, X, ChatGPT, Claude, Spotify.
- All other traffic goes through the VPN or direct, your choice.

**Convenience**
- Lives in the tray; the tray and taskbar icons show whether the VPN is on.
- Autostart with Windows and auto-connect; TUN works without the UAC prompt.
- Auto-update via GitHub Releases.
- Service check: do YouTube, Discord, ChatGPT and others open through the current connection.
- Settings export and import in one file.
- Russian and English, light and dark theme.

**Advanced mode** - tabs:
- General - proxy port, LAN access, log level;
- DNS - DoH, DoT or UDP for VPN traffic, your own DNS for direct sites, IPv4 and IPv6;
- TUN - network stack, MTU, strict routing, IPv6;
- Routing - site detection, local network direct, QUIC blocking, IP addresses and subnets
  via VPN and direct;
- Subscriptions - auto-update, User-Agent, subscription names.

Plus the generated sing-box config and core logs.

## Install

**Windows:** download `ShredingerBox_…_x64-setup.exe` from
[Releases](https://github.com/ThisIsSuigetsu/shredingerbox/releases/latest) and run it.
No administrator rights are needed to install. Windows SmartScreen may warn about an unknown
publisher - click "More info" → "Run anyway".

No install: `ShredingerBox_…_x64-portable.zip` - unpack anywhere and run `ShredingerBox.exe`.
While `portable.txt` sits next to it, settings are stored in the `data` folder next to the program.

**macOS** (Apple Silicon): `ShredingerBox_…_aarch64.dmg`. The app isn't signed with an Apple
certificate, so open it the first time with right click → Open. If macOS says the app is damaged,
run in Terminal:

```bash
xattr -dr com.apple.quarantine /Applications/ShredingerBox.app
```

On Mac, Proxy mode is the default; TUN asks for the administrator password on every connect.
Autostart isn't available on Mac yet.

## Development

You need [Node.js LTS](https://nodejs.org), [Rust](https://rustup.rs) with the MSVC toolchain and
[Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/).

```powershell
powershell -ExecutionPolicy Bypass -File scripts\get-sing-box.ps1
npm install
npm run tauri dev
```

Or just run `start-dev.bat` - it downloads the sing-box core, installs dependencies and starts the app.
TUN mode needs administrator rights, so run it as administrator to test TUN.

Tests for link parsing and config generation: `cd src-tauri && cargo test`.

Interface texts are written in Russian in the code; English translations are in `src/i18n.ts`
(the interface) and `src-tauri/src/i18n.rs` with `tr()` calls (errors and the tray menu).

## License

[GPL-3.0-or-later](LICENSE).
