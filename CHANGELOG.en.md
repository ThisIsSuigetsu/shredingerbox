# Changelog

## 0.8.1

- Language and theme switch instantly. The VPN no longer reconnects when you change the language,
  theme, tray, reminder or subscription download settings.
- Minor fixes.

## 0.8.0

- English. The language follows the system by default; you can pick "Русский" or "English" in
  Settings. The interface, the tray menu and error messages are translated.
- Advanced mode is split into tabs: General, DNS, TUN, Routing and Subscriptions.
  - DNS: DoH, DoT or plain UDP for VPN traffic, your own DNS for direct sites, IPv4 and IPv6 choice.
  - TUN: network stack, MTU, strict routing, IPv6.
  - Routing: detecting the site from the connection, local network direct, blocking QUIC,
    lists of IP addresses and subnets via VPN and direct.
  - Subscriptions: scheduled auto-update, custom User-Agent, renaming subscriptions.
- Service check: the Services button on the home screen shows whether YouTube, Discord, ChatGPT,
  Claude and others open through the current connection and your rules.
- Settings export and import: servers, subscriptions and rules in one file - handy for moving
  to another computer.
- The subscription renewal reminder is now configurable: day of the month and your own text.

## 0.7.0

- Light theme. Settings let you choose System, Dark or Light. By default the theme follows
  Windows or macOS.
- macOS: TUN mode - all Mac traffic through the VPN, like on Windows. macOS asks for the
  administrator password when connecting; disconnecting doesn't. Proxy is still the default on Mac.

## 0.6.1

- Portable version for Windows: `ShredingerBox_…_x64-portable.zip` next to the installer in every
  release. Unpack it anywhere and run - all settings live in the `data` folder next to the program.
- The update window shows what changed in the new version, and after updating a "What's new"
  window appears once.
- Minor fixes.

## 0.6.0

- Sites work like apps: a list of rows and an "Add sites" window where you can paste a whole list,
  one per line. Links, `www.` and `*.` are cleaned up, duplicates are skipped, internationalized
  domains work.
- New "Sites direct" tab. These sites always bypass the VPN - even from "via VPN" apps and presets.
  A site can't be in both lists at once.
- Long app and site lists show the first 10 rows, the rest is in a "Show all" window with search.
- Monthly traffic per server: on the Servers screen next to each server and on the home screen for
  the current one. The tooltip shows download and upload. The counter resets on the 1st.
- Servers from a subscription keep their id when the subscription updates - selection and stats
  are no longer lost.
- macOS: the app is ad-hoc signed, so macOS no longer calls the downloaded DMG "damaged".
- macOS: the VPN finally works. Proxy is the default on Mac and the system proxy is really turned
  on and off on all active connections (Wi-Fi, Ethernet). Windows-only settings are hidden on Mac.
- If the system proxy can't be enabled, the core stops and a clear error is shown.

## 0.5.2

- The mascot shows the VPN state: it sleeps in the box when the VPN is off, peeks out when it's on,
  and winks while connecting.
- The taskbar icon changes too: a sleeping or peeking mascot, plus a mint dot when connected.
- The tray icon now always updates: after changing the mode or server, on a failed restart and when
  the core crashes, even if the window is hidden in the tray.

## 0.5.1

- Updated README and changelog. No changes in the app - this release tests auto-update from 0.5.0.

## 0.5.0

- Auto-update via GitHub Releases: the app finds a new version, stops the core, installs the update
  and restarts. Can be turned off in Settings.
- Windows and macOS builds in GitHub Actions on a `v*` tag.

## 0.4.0

- Paste from clipboard: copy a key or a subscription link, open the app, and it offers to add it.
  The clipboard is read in Rust; only keys and subscription links reach the interface.
- Per-user installer without administrator rights.

## 0.3.0

- Only one copy runs: starting it again shows the window of the running app.
- The tray icon shows the state: grey - VPN off, mint - on.
- All servers are loaded into the core at once: ping through the tunnel and instant switching
  without a restart.

## 0.2.0

- Tray: connect and quit from the menu, clicking the icon opens the window.
- The close button minimizes to tray (can be turned off).
- Autostart with Windows via Task Scheduler, as administrator - TUN without the UAC prompt.
- Auto-connect on autostart.
- Servers screen: groups by subscription, removing subscriptions, manual keys separately.
- Ping of the selected server with a real request through the VPN.
- Subscription renewal reminder.

## 0.1.0

- `vless://` (Reality, TLS, ws/grpc/httpupgrade), `hy2://` (Salamander, port ranges), `trojan://`,
  `ss://` keys.
- Subscriptions by `https://…` link (base64 or a list of links), updated with one click.
- TUN and Proxy modes.
- Rules for apps and sites, presets, choice for "other traffic".
- TCP ping, speed and session timer.
- Advanced mode: proxy port, LAN access, DNS, log level, generated config and core logs.
