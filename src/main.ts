import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { mascot, type Mood } from "./mascot";

// ---------- типы (зеркало Rust-структур) ----------

type Mode = "tun" | "proxy";
type FinalRoute = "proxy" | "direct";
interface Server { id: string; name: string; link: string; subscription: string | null }
interface AppRule { name: string; exe: string }
interface Settings {
  mode: Mode;
  servers: Server[];
  subscriptions: { url: string; name: string }[];
  selected: string | null;
  rules: { final_route: FinalRoute; proxy_apps: AppRule[]; direct_apps: AppRule[]; proxy_domains: string[]; presets: string[] };
  advanced: { enabled: boolean; mixed_port: number; allow_lan: boolean; log_level: string; remote_dns: string };
  reminder: { enabled: boolean; last_shown: string | null };
  general: { autoconnect: boolean; close_to_tray: boolean; clipboard_offer: boolean; check_updates: boolean };
}
interface Status { running: boolean; mode: Mode; server: string | null; api_port: number; secret: string; elevated: boolean }
interface Preset { id: string; title: string; domains: string[] }
interface Ping { id: string; ms: number | null; udp: boolean; via_vpn: boolean }
interface Proc { name: string; exe: string }
type View = "main" | "servers" | "rules" | "settings";
type AppList = "proxy_apps" | "direct_apps";
type Modal =
  | { kind: "add-server"; busy: boolean; error: string }
  | { kind: "add-app"; list: AppList; tab: "running" | "manual"; text: string; loading: boolean; procs: Proc[]; picked: Set<string>; manual: Proc[] }
  | { kind: "admin" }
  | { kind: "reminder" }
  | { kind: "clipboard"; text: string; busy: boolean; error: string }
  | { kind: "update"; version: string; current: string; notes: string; busy: boolean; progress: number; error: string }
  | { kind: "text"; title: string; text: string; live: boolean };

// ---------- состояние ----------

const st = {
  view: "main" as View,
  settings: null as Settings | null,
  status: null as Status | null,
  presets: [] as Preset[],
  busy: false,
  pings: {} as Record<string, Ping>,
  connectedAt: 0,
  traffic: { up: 0, down: 0 },
  modal: null as Modal | null,
  toast: null as { text: string; error: boolean } | null,
  logs: [] as string[],
  autostart: false,
  autostartBusy: false,
};

const root = document.getElementById("app")!;
/** Версия из package.json — Vite подставляет её при сборке. */
declare const __APP_VERSION__: string;
const APP_VERSION = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";
let toastTimer = 0;
let ws: WebSocket | null = null;
/** Автоповторы, если Windows не успела пересоздать TUN-адаптер. */
let tunRetries = 0;

// ---------- помощники ----------

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const icon = {
  power: (s = 20) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 3v9"/><path d="M17.66 6.34a8 8 0 1 1-11.32 0"/></svg>`,
  rules: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h10M4 12h16M4 18h7"/><circle cx="17" cy="6" r="2"/><circle cx="14" cy="18" r="2"/></svg>`,
  globe: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z"/></svg>`,
  gear: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1L7 17M17 7l2.1-2.1"/></svg>`,
  plus: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>`,
  x: (s = 14) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>`,
  refresh: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.6-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.6 4.5L20 16M20 20v-4h-4"/></svg>`,
  info: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" style="flex-shrink:0;margin-top:1px"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>`,
  down: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3DDC97" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="Загрузка"><path d="M12 5v14M6 13l6 6 6-6"/></svg>`,
  up: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#8FB8FF" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="Отдача"><path d="M12 19V5M6 11l6-6 6 6"/></svg>`,
};

/** «🇳🇱 Нидерланды» → { code: "NL", name: "Нидерланды" } */
function splitFlag(name: string): { code: string; name: string } {
  const chars = Array.from(name.trim());
  const isRI = (c?: string) => !!c && c.codePointAt(0)! >= 0x1f1e6 && c.codePointAt(0)! <= 0x1f1ff;
  if (isRI(chars[0]) && isRI(chars[1])) {
    const code = String.fromCharCode(chars[0].codePointAt(0)! - 0x1f1e6 + 65, chars[1].codePointAt(0)! - 0x1f1e6 + 65);
    return { code, name: chars.slice(2).join("").trim() || code };
  }
  const letters = name.replace(/[^\p{L}]/gu, "");
  return { code: (letters.slice(0, 2) || "??").toUpperCase(), name };
}

function pingView(id: string): string {
  const p = st.pings[id];
  if (!p) return "";
  if (p.udp) return `<span class="ping muted" title="Hysteria2 работает по UDP — TCP-пинг не меряется">UDP</span>`;
  if (p.ms == null) return `<span class="ping" style="color:var(--danger)">нет ответа</span>`;
  const good = p.via_vpn ? 300 : 120;
  const color = p.ms <= good ? "var(--accent)" : p.ms <= good * 2.5 ? "var(--amber)" : "var(--danger)";
  const title = p.via_vpn ? "Реальная задержка через VPN" : "TCP-подключение к серверу";
  return `<span class="ping" style="color:${color}" title="${title}">${p.ms} мс</span>`;
}

function speed(bytes: number): string {
  const f = (n: number) => n.toLocaleString("ru-RU", { maximumFractionDigits: 1 });
  if (bytes >= 1024 * 1024) return `${f(bytes / 1024 / 1024)} МБ/с`;
  return `${f(bytes / 1024)} КБ/с`;
}

function elapsed(): string {
  const s = Math.max(0, Math.floor((Date.now() - st.connectedAt) / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

function toast(text: string, error = false) {
  st.toast = { text, error };
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { st.toast = null; render(); }, error ? 7000 : 3000);
  render();
}

const errText = (e: unknown) => (typeof e === "string" ? e : (e as Error)?.message ?? String(e));

function selected(): Server | undefined {
  const s = st.settings!;
  return s.servers.find((x) => x.id === s.selected) ?? s.servers[0];
}

/** «C:\\Games\\Steam\\steam» → «steam.exe»; мусор → null */
function normalizeExe(line: string): string | null {
  let s = line.trim().replace(/^["']+|["']+$/g, "");
  if (!s) return null;
  s = s.split(/[\\/]/).pop()!.trim();
  if (!s) return null;
  if (!/\.exe$/i.test(s)) s += ".exe";
  return /^[^<>:"|?*\s][^<>:"|?*]*\.exe$/i.test(s) ? s : null;
}

/** Что добавится из текстового поля: без дубликатов внутри списка и без уже добавленных. */
function manualStats(m: { list: AppList; text: string }): { add: string[]; dup: number } {
  const existing = new Set(st.settings!.rules[m.list].map((a) => a.exe.toLowerCase()));
  const seen = new Set<string>();
  const add: string[] = [];
  let dup = 0;
  for (const part of m.text.split(/[\r\n,;]+/)) {
    const exe = normalizeExe(part);
    if (!exe) continue;
    const key = exe.toLowerCase();
    if (seen.has(key) || existing.has(key)) { dup++; continue; }
    seen.add(key);
    add.push(exe);
  }
  return { add, dup };
}

function statsText(x: { add: string[]; dup: number }): string {
  if (!x.add.length && !x.dup) return "Список пуст";
  return `Будет добавлено: ${x.add.length}` + (x.dup ? ` · дубликатов пропущено: ${x.dup}` : "");
}

// ---------- обновления ----------

interface UpdateInfo { version: string; current: string; notes: string | null }
/** Версия, от которой пользователь отказался «Позже», — до перезапуска больше не предлагаем. */
let updateSnoozed = "";

async function checkUpdate(manual = false) {
  if (!manual && (!st.settings?.general.check_updates || st.modal)) return;
  try {
    const info = await invoke<UpdateInfo | null>("check_update");
    if (!info) { if (manual) toast("У тебя последняя версия"); return; }
    if (!manual && info.version === updateSnoozed) return;
    if (st.modal && !manual) return;
    st.modal = { kind: "update", version: info.version, current: info.current, notes: info.notes ?? "", busy: false, progress: 0, error: "" };
    render();
  } catch (e) {
    if (manual) toast(errText(e), true);
  }
}

// ---------- буфер обмена ----------

/** Текст из буфера, который пользователь уже отклонил, — второй раз не предлагаем. */
let clipboardDismissed = "";
let clipboardChecking = false;

async function checkClipboard() {
  if (!st.settings?.general.clipboard_offer || st.modal || clipboardChecking) return;
  clipboardChecking = true;
  try {
    const text = await invoke<string | null>("clipboard_candidate");
    if (text && text !== clipboardDismissed && !st.modal) {
      st.modal = { kind: "clipboard", text, busy: false, error: "" };
      render();
    }
  } catch { /* буфер недоступен — молча пропускаем */ }
  clipboardChecking = false;
}

/** «2 ключа» / «подписка с panel.example.org» — коротко, без самих секретов. */
function clipboardSummary(text: string): string {
  if (/^https?:\/\//i.test(text)) {
    try { return `подписка с <span class="mono">${esc(new URL(text).host)}</span>`; } catch { return "подписка"; }
  }
  const lines = text.split("\n").filter(Boolean);
  const names = lines.slice(0, 3).map((l) => {
    const hash = l.indexOf("#");
    const name = hash >= 0 ? decodeURIComponent(l.slice(hash + 1)) : l.split("://")[0] + "://…";
    return `<li>${esc(name)}</li>`;
  }).join("");
  const more = lines.length > 3 ? `<li class="muted">и ещё ${lines.length - 3}</li>` : "";
  return `${lines.length === 1 ? "ключ" : `ключи (${lines.length})`}:<ul style="margin:6px 0 0;padding-left:18px">${names}${more}</ul>`;
}

// ---------- работа с Rust ----------

async function saveSettings(change: (s: Settings) => void, okText?: string) {
  const s: Settings = structuredClone(st.settings!);
  change(s);
  st.settings = s;
  render();
  try {
    const status = await invoke<Status>("save_settings", { settings: s });
    st.status = status;
    if (status.running && okText) toast(okText);
  } catch (e) {
    toast(errText(e), true);
    await refreshStatus();
  }
  render();
}

/** После ошибки ядро могло остановиться — берём настоящее состояние у Rust. */
async function refreshStatus() {
  try { st.status = await invoke<Status>("get_status"); } catch { return; }
  if (!st.status.running) stopTraffic();
}

async function toggleConnect() {
  if (st.busy || !st.settings) return;
  if (!st.status?.running && st.settings.servers.length === 0) {
    st.modal = { kind: "add-server", busy: false, error: "" };
    return render();
  }
  st.busy = true;
  render();
  try {
    if (st.status?.running) {
      st.status = await invoke<Status>("disconnect");
      stopTraffic();
    } else {
      st.status = await invoke<Status>("connect");
      st.connectedAt = Date.now();
      startTraffic();
    }
  } catch (e) {
    if (errText(e) === "NEED_ADMIN") st.modal = { kind: "admin" };
    else toast(errText(e), true);
  }
  st.busy = false;
  syncIndicators();
  render();
  // Пинг выбранного сервера сразу через туннель
  if (st.status?.running) setTimeout(pingAll, 1500);
}

/** Трей и панель задач Rust обновляет сам, а тут — на всякий случай, по настоящему состоянию ядра. */
function syncIndicators() {
  invoke("sync_indicators").catch(() => {});
}

function mood(): Mood {
  return st.busy ? "wink" : st.status?.running ? "peek" : "sleep";
}

function startTraffic(attempt = 0) {
  stopTraffic();
  const s = st.status;
  if (!s) return;
  ws = new WebSocket(`ws://127.0.0.1:${s.api_port}/traffic?token=${encodeURIComponent(s.secret)}`);
  ws.onmessage = (ev) => {
    try {
      const d = JSON.parse(ev.data);
      st.traffic = { up: d.up ?? 0, down: d.down ?? 0 };
      const down = document.getElementById("spd-down");
      const up = document.getElementById("spd-up");
      if (down) down.textContent = speed(st.traffic.down);
      if (up) up.textContent = speed(st.traffic.up);
    } catch { /* пропускаем битые сообщения */ }
  };
  ws.onerror = () => {
    // Ядро могло ещё не поднять API — пробуем пару раз.
    if (attempt < 5 && st.status?.running) setTimeout(() => startTraffic(attempt + 1), 700);
  };
}

function stopTraffic() {
  if (ws) { ws.onerror = null; ws.close(); ws = null; }
  st.traffic = { up: 0, down: 0 };
}

async function pingAll() {
  try {
    const list = await invoke<Ping[]>("ping_servers");
    st.pings = Object.fromEntries(list.map((p: Ping) => [p.id, p]));
    render();
  } catch (e) {
    toast(errText(e), true);
  }
}

// ---------- отрисовка ----------

function sidebar(): string {
  const s = st.settings!;
  const nav = (v: View, label: string, ic: string) =>
    `<button class="nav-btn ${st.view === v ? "active" : ""}" data-action="nav" data-view="${v}">${ic}${label}</button>`;
  const sub = s.subscriptions.length
    ? `<div class="sub-card"><div class="t"><b>Подписка</b><span>${s.servers.filter((x) => x.subscription).length} серв.</span></div>
       <button class="x-btn" data-action="refresh-subs" aria-label="Обновить подписку" title="Обновить подписку">${icon.refresh}</button></div>`
    : "";
  return `<nav class="side" aria-label="Разделы">
    <div class="brand">${mascot(36, mood())}<span>ShredingerBox</span></div>
    ${nav("main", "Главная", icon.power())}
    ${nav("servers", "Серверы", icon.globe)}
    ${nav("rules", "Правила", icon.rules)}
    ${nav("settings", "Настройки", icon.gear)}
    <div class="spacer"></div>
    ${sub}
    <span class="version">v${APP_VERSION}</span>
  </nav>`;
}

function titlebar(): string {
  return `<div class="titlebar" data-tauri-drag-region>
    <button class="win-btn" data-action="win-min" aria-label="Свернуть"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M4 12h16"/></svg></button>
    <button class="win-btn" data-action="win-max" aria-label="Развернуть"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="2"/></svg></button>
    <button class="win-btn close" data-action="win-close" aria-label="Закрыть">${icon.x(12)}</button>
  </div>`;
}

function mainView(): string {
  const s = st.settings!;
  const running = !!st.status?.running;
  const srv = selected();
  const flag = srv ? splitFlag(srv.name) : null;
  const powerCls = st.busy ? "busy" : running ? "on" : "";
  const title = st.busy ? (running ? "Отключаемся…" : "Подключаемся…") : running
    ? `Подключено <span class="timer" id="timer">· ${elapsed()}</span>`
    : "Не подключено";
  const sub = srv
    ? `<span class="flag">${esc(flag!.code)}</span>${esc(flag!.name)}${st.pings[srv.id] ? " · " + pingView(srv.id) : ""}`
    : `Добавь сервер, чтобы подключиться`;

  const servers = s.servers.length
    ? s.servers.map((x) => {
        const f = splitFlag(x.name);
        return `<div class="server ${x.id === srv?.id ? "on" : ""}" role="button" tabindex="0" data-action="select-server" data-id="${x.id}">
          <span class="flag">${esc(f.code)}</span><span class="name" title="${esc(x.name)}">${esc(f.name)}</span>${pingView(x.id)}
          <button class="del" data-action="remove-server" data-id="${x.id}" aria-label="Удалить сервер">${icon.x(13)}</button>
        </div>`;
      }).join("")
    : `<div class="empty">Серверов пока нет. Вставь ключ <span class="mono">vless://</span>, <span class="mono">hy2://</span> или ссылку на подписку.</div>`;

  const modeOpt = (m: Mode, t: string, d: string) =>
    `<button class="mode-opt ${s.mode === m ? "on" : ""}" data-action="set-mode" data-mode="${m}" aria-pressed="${s.mode === m}">
      <span class="radio"></span><span><b>${t}</b><span>${d}</span></span></button>`;

  return `<div class="home">
    <div class="home-center">
      <button class="power ${powerCls}" data-action="toggle-connect" aria-label="${running ? "Отключиться" : "Подключиться"}">
        <span class="inner">${icon.power(68)}</span>
      </button>
      <div style="display:flex;flex-direction:column;gap:10px">
        <div class="status-title">${title}</div>
        <div class="status-sub">${sub}</div>
      </div>
      ${running ? `<div class="speeds">
        <div class="speed">${icon.down}<span id="spd-down">${speed(st.traffic.down)}</span></div>
        <div class="speed">${icon.up}<span id="spd-up">${speed(st.traffic.up)}</span></div>
      </div>` : ""}
    </div>
    <div class="home-side">
      <section class="card">
        <h2>Режим</h2>
        ${modeOpt("tun", "TUN", "Весь трафик системы по правилам")}
        ${modeOpt("proxy", "Прокси", "Только программы с системным прокси")}
      </section>
      <section class="card servers">
        <div class="card-head"><h2>Серверы</h2>${s.servers.length ? `<button class="link-btn" data-action="ping">Проверить пинг</button>` : ""}</div>
        <div class="server-list">${servers}</div>
        <button class="dashed" data-action="open-add-server">${icon.plus}Добавить подписку или ключ</button>
      </section>
    </div>
  </div>`;
}

function serverRow(x: Server, current: Server | undefined): string {
  const f = splitFlag(x.name);
  return `<div class="server ${x.id === current?.id ? "on" : ""}" role="button" tabindex="0" data-action="select-server" data-id="${x.id}">
    <span class="flag">${esc(f.code)}</span><span class="name" title="${esc(x.name)}">${esc(f.name)}</span>${pingView(x.id)}
    <button class="del" data-action="remove-server" data-id="${x.id}" aria-label="Удалить сервер">${icon.x(13)}</button>
  </div>`;
}

function serversView(): string {
  const s = st.settings!;
  const current = selected();
  const host = (url: string) => { try { return new URL(url).host; } catch { return url; } };
  const groups = s.subscriptions.map((sub) => {
    const list = s.servers.filter((x) => x.subscription === sub.url);
    return `<section class="card">
      <div class="card-head">
        <div style="display:flex;flex-direction:column;gap:2px;min-width:0">
          <h2>${esc(sub.name)} <span class="count">· ${list.length}</span></h2>
          <span class="muted mono" style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(host(sub.url))}</span>
        </div>
        <div style="display:flex;gap:4px">
          <button class="x-btn" data-action="refresh-subs" aria-label="Обновить подписку" title="Обновить">${icon.refresh}</button>
          <button class="x-btn" data-action="remove-sub" data-url="${esc(sub.url)}" aria-label="Удалить подписку" title="Удалить подписку">${icon.x()}</button>
        </div>
      </div>
      <div class="server-list" style="max-height:none">${list.map((x) => serverRow(x, current)).join("") || `<div class="empty">В подписке нет серверов</div>`}</div>
    </section>`;
  }).join("");
  const manual = s.servers.filter((x) => !x.subscription);
  const manualCard = manual.length
    ? `<section class="card"><div class="card-head"><h2>Добавленные вручную <span class="count">· ${manual.length}</span></h2></div>
        <div class="server-list" style="max-height:none">${manual.map((x) => serverRow(x, current)).join("")}</div></section>`
    : "";
  const empty = !s.servers.length
    ? `<section class="card"><div class="empty">Серверов пока нет. Вставь ключ или ссылку на подписку.</div></section>`
    : "";
  return `<div class="page-head">
      <div><h1>Серверы</h1><p>Подписки и ключи. Пока VPN включён, пинг каждого сервера меряется через туннель, а переключение мгновенное.</p></div>
      <div style="display:flex;gap:8px">
        ${s.servers.length ? `<button class="btn-ghost" data-action="ping">Проверить пинг</button>` : ""}
        <button class="btn-light" data-action="open-add-server">Добавить</button>
      </div>
    </div>
    <div class="settings" style="max-width:none">${empty}${groups}${manualCard}</div>`;
}

function appCard(list: AppList, title: string, hollow: boolean): string {
  const apps = st.settings!.rules[list];
  const rows = apps.length
    ? apps.map((a) => `<div class="app-row"><div class="app-icon">${esc(a.name.charAt(0).toUpperCase())}</div>
        <span class="n">${esc(a.name)} <small>· ${esc(a.exe)}</small></span>
        <button class="x-btn" data-action="remove-app" data-list="${list}" data-exe="${esc(a.exe)}" aria-label="Убрать из списка">${icon.x()}</button></div>`).join("")
    : `<div class="empty" style="padding:6px 0">Пока пусто</div>`;
  return `<section class="card" style="gap:2px">
    <div class="card-head" style="padding-bottom:6px"><div style="display:flex;align-items:center;gap:10px"><span class="dot ${hollow ? "hollow" : ""}"></span><h2>${title}</h2></div><span class="count">${apps.length}</span></div>
    ${rows}
    <button class="dashed" style="margin-top:6px" data-action="open-add-app" data-list="${list}">${icon.plus}Добавить приложение</button>
  </section>`;
}

function rulesView(): string {
  const r = st.settings!.rules;
  const chips = r.proxy_domains.map((d) =>
    `<span class="chip">${esc(d)}<button data-action="remove-domain" data-domain="${esc(d)}" aria-label="Убрать домен">${icon.x(11)}</button></span>`).join("");
  const presets = st.presets.map((p) => {
    const on = r.presets.includes(p.id);
    return `<button class="preset ${on ? "on" : ""}" data-action="toggle-preset" data-id="${p.id}" aria-pressed="${on}" title="${esc(p.domains.join(", "))}">${on ? "✓ " : ""}${esc(p.title)}</button>`;
  }).join("");
  return `<div class="page-head">
      <div><h1>Правила</h1><p>Что идёт через VPN, а что напрямую</p></div>
      <div style="display:flex;align-items:center;gap:12px"><span class="muted" style="font-size:13px">Остальной трафик</span>
        <div class="seg" role="group" aria-label="Остальной трафик">
          <button class="${r.final_route === "proxy" ? "on" : ""}" data-action="set-final" data-value="proxy">Через VPN</button>
          <button class="${r.final_route === "direct" ? "on" : ""}" data-action="set-final" data-value="direct">Напрямую</button>
        </div></div>
    </div>
    <div class="rules-grid">
      <div class="col">${appCard("proxy_apps", "Приложения через VPN", false)}${appCard("direct_apps", "Приложения напрямую", true)}</div>
      <div class="col"><section class="card" style="gap:12px">
        <div class="card-head"><div style="display:flex;align-items:center;gap:10px"><span class="dot"></span><h2>Сайты через VPN</h2></div><span class="count">${r.proxy_domains.length}</span></div>
        <form class="row-form" data-form="add-domain">
          <label for="domain" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Домен</label>
          <input id="domain" class="field" name="domain" placeholder="например, discord.com" autocomplete="off" />
          <button class="btn-light" type="submit">Добавить</button>
        </form>
        ${chips ? `<div class="chips">${chips}</div>` : ""}
        <div class="sep"></div>
        <span class="muted" style="font-size:12px">Готовые наборы — нажми, чтобы включить</span>
        <div class="chips">${presets}</div>
        <div class="hint">${icon.info}<span>В режиме «Прокси» правила для приложений работают только у программ, которые используют системный прокси. В режиме TUN — у всех.</span></div>
      </section></div>
    </div>`;
}

function settingsView(): string {
  const a = st.settings!.advanced;
  const head = `<div class="page-head"><h1>Настройки</h1>
    <div class="adv-toggle">Продвинутый режим
      <button class="switch ${a.enabled ? "on" : ""}" role="switch" aria-checked="${a.enabled}" aria-label="Продвинутый режим" data-action="toggle-advanced"><span></span></button>
    </div></div>`;
  const g = st.settings!.general;
  const sw = (on: boolean, action: string, label: string, busy = false) =>
    `<button class="switch ${on ? "on" : ""}" role="switch" aria-checked="${on}" aria-label="${label}" data-action="${action}" ${busy ? "disabled" : ""}><span></span></button>`;
  const behaviour = `<section class="card" style="gap:0;padding:6px 16px">
      <div class="set-row"><div class="t"><b>Запускать вместе с Windows</b><span>Сразу с правами администратора — TUN без окна UAC</span></div>
        ${sw(st.autostart, "toggle-autostart", "Запускать вместе с Windows", st.autostartBusy)}</div>
      <div class="set-row"><div class="t"><b>Подключаться при автозапуске</b><span>Клиент стартует в трее и сразу включает VPN</span></div>
        ${sw(g.autoconnect, "toggle-autoconnect", "Подключаться при автозапуске")}</div>
      <div class="set-row"><div class="t"><b>Проверять обновления</b><span>Версия ${esc(APP_VERSION)} · новые версии приходят с GitHub</span></div>
        <button class="btn-ghost" data-action="check-update-now" style="height:36px">Проверить</button>
        ${sw(g.check_updates, "toggle-updates", "Проверять обновления")}</div>
      <div class="set-row"><div class="t"><b>Предлагать ключи из буфера обмена</b><span>Скопировал ключ или подписку — открыл клиент — он предложит добавить</span></div>
        ${sw(g.clipboard_offer, "toggle-clipboard", "Предлагать ключи из буфера обмена")}</div>
      <div class="set-row"><div class="t"><b>Сворачивать в трей при закрытии</b><span>Крестик прячет окно, VPN продолжает работать</span></div>
        ${sw(g.close_to_tray, "toggle-tray", "Сворачивать в трей при закрытии")}</div>
    </section>`;
  const basic = behaviour + `<section class="card" style="gap:0;padding:6px 16px">
      <div class="set-row"><div class="t"><b>Права администратора</b><span>Нужны для режима TUN</span></div>
        ${st.status?.elevated ? `<span style="color:var(--accent);font-size:13px;font-weight:600">Есть</span>` : `<button class="btn-ghost" data-action="restart-admin">Перезапустить с правами</button>`}</div>
      <div class="set-row"><div class="t"><b>Папка данных</b><span>Настройки, конфиг и кэш ядра</span></div>
        <button class="btn-ghost" data-action="open-data-dir">Открыть</button></div>
      <div class="set-row"><div class="t"><b>Напоминание о продлении подписки</b><span>Каждое 20-е число — написать Suigetsu в Telegram</span></div>
        <button class="switch ${st.settings!.reminder.enabled ? "on" : ""}" role="switch" aria-checked="${st.settings!.reminder.enabled}" aria-label="Напоминание о продлении подписки" data-action="toggle-reminder"><span></span></button></div>
    </section>`;
  if (!a.enabled) return `<div class="settings">${head}${basic}</div>`;
  return `<div class="settings">${head}
    <section class="card">
      <h2>Ядро</h2>
      <div class="core on" style="cursor:default"><b>sing-box</b><span>Встроенное ядро: VLESS (Reality, Vision, ws, grpc), Hysteria2, Trojan, Shadowsocks · TUN и правила</span></div>
    </section>
    <section class="card" style="gap:0;padding:6px 16px">
      <div class="set-row"><div class="t"><label for="port"><b>Локальный порт прокси</b></label><span>HTTP + SOCKS5 на одном порту</span></div>
        <input id="port" class="field mono" data-change="port" type="number" min="1024" max="65535" value="${a.mixed_port}" /></div>
      <div class="set-row"><div class="t"><b>Подключения из локальной сети</b><span>Чтобы телефон или ТВ ходили через этот ПК</span></div>
        <button class="switch ${a.allow_lan ? "on" : ""}" role="switch" aria-checked="${a.allow_lan}" aria-label="Подключения из локальной сети" data-action="toggle-lan"><span></span></button></div>
      <div class="set-row"><div class="t"><label for="dns"><b>DNS для VPN-трафика</b></label><span>DNS-over-HTTPS, адрес сервера</span></div>
        <input id="dns" class="field mono" data-change="dns" value="${esc(a.remote_dns)}" /></div>
      <div class="set-row"><div class="t"><label for="log"><b>Уровень логов</b></label><span>Подробные логи пригодятся, когда что-то сломалось</span></div>
        <select id="log" class="field" data-change="log">${["error", "warn", "info", "debug"].map((l) => `<option ${l === a.log_level ? "selected" : ""}>${l}</option>`).join("")}</select></div>
    </section>
    ${basic}
    <div class="actions">
      <button class="btn-ghost" data-action="show-config">Открыть итоговый конфиг</button>
      <button class="btn-ghost" data-action="show-logs">Открыть логи</button>
      <span style="flex-grow:1"></span>
      <button class="btn-ghost btn-danger" data-action="reset-advanced">Сбросить к стандартным</button>
    </div>
  </div>`;
}

function modalView(): string {
  const m = st.modal;
  if (!m) return "";
  const head = (t: string) => `<div class="modal-head"><h1>${t}</h1><button class="x-btn" data-action="close-modal" aria-label="Закрыть">${icon.x(16)}</button></div>`;
  let body = "";
  if (m.kind === "add-server") {
    body = `<form class="modal" data-form="add-server">${head("Добавить сервер")}
      <div class="modal-body">
        <label for="link" class="muted" style="font-size:13px">Ключ (vless://, hy2://, trojan://, ss://) или ссылка на подписку. Можно несколько строк.</label>
        <textarea id="link" class="field mono" name="link" placeholder="vless://… или https://…/sub/…" autofocus></textarea>
        ${m.error ? `<div class="hint" style="color:var(--danger)">${esc(m.error)}</div>` : ""}
      </div>
      <div class="modal-foot"><span class="grow"></span><button class="btn-accent" type="submit" ${m.busy ? "disabled" : ""}>${m.busy ? "Загружаю…" : "Добавить"}</button></div>
    </form>`;
  } else if (m.kind === "add-app") {
    const existing = new Set(st.settings!.rules[m.list].map((a) => a.exe.toLowerCase()));
    const tabs = `<div class="seg inset" role="tablist" aria-label="Способ добавления" style="align-self:flex-start">
        <button role="tab" aria-selected="${m.tab === "running"}" class="${m.tab === "running" ? "on" : ""}" data-action="app-tab" data-tab="running">Запущенные</button>
        <button role="tab" aria-selected="${m.tab === "manual"}" class="${m.tab === "manual" ? "on" : ""}" data-action="app-tab" data-tab="manual">Вписать вручную</button>
      </div>`;
    let content: string;
    if (m.tab === "manual") {
      content = `<label for="exe-list" class="muted" style="font-size:13px;line-height:1.5">По одному на строку: <span class="mono">Discord.exe</span>, просто <span class="mono">discord</span> или полный путь к файлу. Можно вставить сразу целый список.</label>
        <textarea id="exe-list" class="field mono" style="height:180px" data-input="exe-list" placeholder="Discord.exe&#10;Telegram.exe&#10;chrome" spellcheck="false">${esc(m.text)}</textarea>
        <div class="muted" style="font-size:12px" id="exe-stats">${statsText(manualStats(m))}</div>`;
    } else {
      const all = [...m.manual, ...m.procs.filter((p) => !m.manual.some((x) => x.exe === p.exe))];
      const rows = m.loading
        ? `<div class="empty">Ищу запущенные программы…</div>`
        : all.length
          ? all.map((p, i) => {
              const added = existing.has(p.exe.toLowerCase());
              return `<label class="proc" for="p${i}"><div class="app-icon">${esc(p.name.charAt(0).toUpperCase())}</div>
                <span class="n">${esc(p.name)} <small>· ${esc(p.exe)}${added ? " · уже в списке" : ""}</small></span>
                <input id="p${i}" type="checkbox" data-change="pick" data-exe="${esc(p.exe)}" ${added || m.picked.has(p.exe) ? "checked" : ""} ${added ? "disabled" : ""} /></label>`;
            }).join("")
          : `<div class="empty">Не нашлось программ с открытыми окнами. Выбери .exe или впиши вручную.</div>`;
      content = `<div style="display:flex;flex-direction:column;max-height:44vh;overflow:auto">${rows}</div>`;
    }
    const count = m.tab === "manual" ? manualStats(m).add.length : m.picked.size;
    body = `<div class="modal" role="dialog" aria-label="Добавить приложение">${head("Добавить приложение")}
      <div class="modal-body">${tabs}${content}</div>
      <div class="modal-foot">
        ${m.tab === "running" ? `<button class="btn-ghost" data-action="pick-exe">Выбрать .exe…</button>` : ""}
        <div class="seg inset" role="group" aria-label="Куда добавить">
          <button class="${m.list === "proxy_apps" ? "on" : ""}" data-action="set-app-list" data-list="proxy_apps">Через VPN</button>
          <button class="${m.list === "direct_apps" ? "on" : ""}" data-action="set-app-list" data-list="direct_apps">Напрямую</button>
        </div>
        <span class="grow"></span>
        <button class="btn-accent" id="add-app-btn" data-action="confirm-add-app" ${count ? "" : "disabled"}>Добавить${count ? " · " + count : ""}</button>
      </div></div>`;
  } else if (m.kind === "update") {
    body = `<div class="modal" role="dialog" aria-label="Доступно обновление">${head(`Доступна версия ${esc(m.version)}`)}
      <div class="modal-body">
        <p class="muted" style="margin:0;font-size:13px">Сейчас установлена ${esc(m.current)}. Во время обновления VPN ненадолго отключится, потом клиент перезапустится сам.</p>
        ${m.notes ? `<pre class="code" style="max-height:200px">${esc(m.notes)}</pre>` : ""}
        ${m.busy ? `<div style="height:6px;border-radius:3px;background:var(--chip);overflow:hidden"><div id="upd-bar" style="height:100%;width:${m.progress}%;background:var(--accent)"></div></div>` : ""}
        ${m.error ? `<div class="hint" style="color:var(--danger)">${esc(m.error)}</div>` : ""}
      </div>
      <div class="modal-foot"><button class="btn-ghost" data-action="snooze-update" ${m.busy ? "disabled" : ""}>Позже</button><span class="grow"></span>
        <button class="btn-accent" data-action="install-update" ${m.busy ? "disabled" : ""}>${m.busy ? "Обновляю…" : "Обновить"}</button></div></div>`;
  } else if (m.kind === "clipboard") {
    body = `<div class="modal" role="dialog" aria-label="Добавить из буфера обмена">${head("Добавить из буфера обмена?")}
      <div class="modal-body">
        <div style="line-height:1.55">В буфере обмена есть ${clipboardSummary(m.text)}</div>
        ${m.error ? `<div class="hint" style="color:var(--danger)">${esc(m.error)}</div>` : ""}
      </div>
      <div class="modal-foot"><button class="btn-ghost" data-action="dismiss-clipboard">Не сейчас</button><span class="grow"></span>
        <button class="btn-accent" data-action="accept-clipboard" ${m.busy ? "disabled" : ""}>${m.busy ? "Добавляю…" : "Добавить"}</button></div></div>`;
  } else if (m.kind === "reminder") {
    body = `<div class="modal" role="dialog" aria-label="Пора продлить подписку">${head("Пора продлить подписку")}
      <div class="modal-body" style="flex-direction:row;align-items:center;gap:16px">
        <div style="flex-shrink:0">${mascot(72, mood())}</div>
        <p style="margin:0;line-height:1.55">Сегодня 20-е — напиши <b>Suigetsu</b> в Telegram, чтобы продлить подписку на VPN.</p>
      </div>
      <div class="modal-foot"><button class="btn-ghost" data-action="reminder-disable">Больше не напоминать</button><span class="grow"></span>
        <button class="btn-accent" data-action="close-modal">Понятно</button></div></div>`;
  } else if (m.kind === "admin") {
    body = `<div class="modal" role="dialog" aria-label="Нужны права администратора">${head("Нужны права администратора")}
      <div class="modal-body"><p style="margin:0;line-height:1.55">Режим TUN перехватывает весь трафик системы, поэтому Windows требует права администратора. ShredingerBox перезапустится и сразу подключится.</p>
      <p class="muted" style="margin:0;font-size:13px">Или переключись на режим «Прокси» — ему права не нужны.</p></div>
      <div class="modal-foot"><button class="btn-ghost" data-action="use-proxy-mode">Включить «Прокси»</button><span class="grow"></span>
        <button class="btn-accent" data-action="restart-admin">Перезапустить</button></div></div>`;
  } else if (m.kind === "text") {
    body = `<div class="modal wide" role="dialog" aria-label="${esc(m.title)}">${head(esc(m.title))}
      <div class="modal-body"><pre class="code" id="text-pre">${esc(m.text || "Пусто")}</pre></div></div>`;
  }
  return `<div class="overlay" data-action="overlay">${body}</div>`;
}

function render() {
  if (!st.settings) {
    root.innerHTML = `<div class="app" style="align-items:center;justify-content:center">${mascot(72)}</div>`;
    return;
  }
  const view = st.view === "main" ? mainView() : st.view === "servers" ? serversView() : st.view === "rules" ? rulesView() : settingsView();
  const focusedId = (document.activeElement as HTMLElement | null)?.id;
  root.innerHTML = `<div class="app">${sidebar()}<div class="content">${titlebar()}<main class="view">${view}</main></div></div>
    ${modalView()}
    ${st.toast ? `<div class="toast ${st.toast.error ? "error" : ""}" role="status">${esc(st.toast.text)}</div>` : ""}`;
  if (focusedId) document.getElementById(focusedId)?.focus();
  const pre = document.getElementById("text-pre");
  if (pre) pre.scrollTop = pre.scrollHeight;
}

// ---------- напоминание о продлении ----------

/** Раз в месяц, начиная с 20-го числа, выводит окно на передний план с напоминанием. */
async function checkReminder() {
  const s = st.settings;
  if (!s || !s.reminder.enabled || st.modal) return;
  const now = new Date();
  if (now.getDate() < 20) return;
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  if (s.reminder.last_shown === month) return;
  st.modal = { kind: "reminder" };
  await saveSettings((x) => { x.reminder.last_shown = month; });
  const win = getCurrentWindow();
  try { await win.unminimize(); await win.show(); await win.setFocus(); } catch { /* окно и так на экране */ }
}

// ---------- обработчики ----------

async function onAction(action: string, el: HTMLElement, ev: Event) {
  const s = st.settings!;
  const win = getCurrentWindow();
  switch (action) {
    case "nav": st.view = el.dataset.view as View; return render();
    case "win-min": return win.minimize();
    case "win-max": return win.toggleMaximize();
    case "win-close": return win.close();
    case "toggle-connect": tunRetries = 0; return toggleConnect();
    case "set-mode": {
      const mode = el.dataset.mode as Mode;
      if (mode === s.mode) return;
      return saveSettings((x) => { x.mode = mode; }, "Режим переключён");
    }
    case "select-server": {
      const id = el.dataset.id!;
      if (id === st.settings!.selected) return;
      st.settings = { ...st.settings!, selected: id };
      render();
      try {
        st.status = await invoke<Status>("select_server", { id });
        if (st.status.running) { toast("Сервер переключён"); pingAll(); }
      } catch (e) { toast(errText(e), true); await refreshStatus(); }
      return render();
    }
    case "remove-server": {
      ev.stopPropagation();
      try { st.settings = await invoke<Settings>("remove_server", { id: el.dataset.id }); } catch (e) { toast(errText(e), true); }
      return render();
    }
    case "ping": return pingAll();
    case "open-add-server": st.modal = { kind: "add-server", busy: false, error: "" }; return render();
    case "refresh-subs": {
      try { st.settings = await invoke<Settings>("refresh_subscriptions"); toast("Подписка обновлена"); } catch (e) { toast(errText(e), true); }
      return render();
    }
    case "set-final": return saveSettings((x) => { x.rules.final_route = el.dataset.value as FinalRoute; }, "Правила применены");
    case "remove-app": {
      const list = el.dataset.list as AppList;
      return saveSettings((x) => { x.rules[list] = x.rules[list].filter((a) => a.exe !== el.dataset.exe); }, "Правила применены");
    }
    case "remove-domain": return saveSettings((x) => { x.rules.proxy_domains = x.rules.proxy_domains.filter((d) => d !== el.dataset.domain); }, "Правила применены");
    case "toggle-preset": {
      const id = el.dataset.id!;
      return saveSettings((x) => {
        x.rules.presets = x.rules.presets.includes(id) ? x.rules.presets.filter((p) => p !== id) : [...x.rules.presets, id];
      }, "Правила применены");
    }
    case "open-add-app": {
      const list = el.dataset.list as AppList;
      st.modal = { kind: "add-app", list, tab: "running", text: "", loading: true, procs: [], picked: new Set(), manual: [] };
      render();
      const procs = await invoke<Proc[]>("list_processes").catch(() => [] as Proc[]);
      if (st.modal?.kind === "add-app") { st.modal.procs = procs; st.modal.loading = false; render(); }
      return;
    }
    case "app-tab": if (st.modal?.kind === "add-app") { st.modal.tab = el.dataset.tab as "running" | "manual"; render(); document.getElementById("exe-list")?.focus(); } return;
    case "set-app-list": if (st.modal?.kind === "add-app") { st.modal.list = el.dataset.list as AppList; render(); } return;
    case "pick-exe": {
      const file = await open({ multiple: false, filters: [{ name: "Программы", extensions: ["exe"] }] });
      if (typeof file === "string" && st.modal?.kind === "add-app") {
        const exe = file.split(/[\\/]/).pop()!;
        const name = exe.replace(/\.exe$/i, "");
        st.modal.manual.push({ name, exe });
        st.modal.picked.add(exe);
        render();
      }
      return;
    }
    case "confirm-add-app": {
      const m = st.modal;
      if (m?.kind !== "add-app") return;
      let add: Proc[];
      let skipped = 0;
      if (m.tab === "manual") {
        const stats = manualStats(m);
        add = stats.add.map((exe) => ({ name: exe.replace(/\.exe$/i, ""), exe }));
        skipped = stats.dup;
      } else {
        const pool = [...m.manual, ...m.procs];
        add = [...m.picked].map((exe) => pool.find((p) => p.exe === exe)!).filter(Boolean);
      }
      if (!add.length) return toast("Нечего добавлять: всё уже есть в списке", true);
      const other: AppList = m.list === "proxy_apps" ? "direct_apps" : "proxy_apps";
      st.modal = null;
      await saveSettings((x) => {
        for (const p of add) {
          // приложение не может быть одновременно в обоих списках
          x.rules[other] = x.rules[other].filter((a) => a.exe.toLowerCase() !== p.exe.toLowerCase());
          if (!x.rules[m.list].some((a) => a.exe.toLowerCase() === p.exe.toLowerCase())) x.rules[m.list].push({ name: p.name, exe: p.exe });
        }
      }, "Правила применены");
      if (skipped) toast(`Добавлено: ${add.length}, дубликатов пропущено: ${skipped}`);
      return;
    }
    case "toggle-advanced": return saveSettings((x) => { x.advanced.enabled = !x.advanced.enabled; });
    case "toggle-lan": return saveSettings((x) => { x.advanced.allow_lan = !x.advanced.allow_lan; }, "Настройки применены");
    case "reset-advanced": return saveSettings((x) => {
      x.advanced = { enabled: true, mixed_port: 2080, allow_lan: false, log_level: "warn", remote_dns: "1.1.1.1" };
    }, "Настройки сброшены");
    case "show-config": {
      try {
        const text = await invoke<string>("preview_config");
        st.modal = { kind: "text", title: "Итоговый конфиг sing-box", text, live: false };
      } catch (e) { toast(errText(e), true); }
      return render();
    }
    case "show-logs": {
      st.logs = await invoke<string[]>("get_logs");
      st.modal = { kind: "text", title: "Логи ядра", text: st.logs.join("\n"), live: true };
      return render();
    }
    case "open-data-dir": return invoke("open_data_dir").catch((e: unknown) => toast(errText(e), true));
    case "restart-admin": return invoke("restart_as_admin").catch((e: unknown) => toast(errText(e), true));
    case "use-proxy-mode": st.modal = null; await saveSettings((x) => { x.mode = "proxy"; }); return toggleConnect();
    case "toggle-autostart": {
      st.autostartBusy = true;
      render();
      try {
        st.autostart = await invoke<boolean>("set_autostart", { enabled: !st.autostart });
        toast(st.autostart ? "Автозапуск включён" : "Автозапуск выключен");
      } catch (e) { toast(errText(e), true); }
      st.autostartBusy = false;
      return render();
    }
    case "toggle-autoconnect": return saveSettings((x) => { x.general.autoconnect = !x.general.autoconnect; });
    case "toggle-tray": return saveSettings((x) => { x.general.close_to_tray = !x.general.close_to_tray; });
    case "remove-sub": {
      try { st.settings = await invoke<Settings>("remove_subscription", { url: el.dataset.url }); toast("Подписка удалена"); } catch (e) { toast(errText(e), true); }
      return render();
    }
    case "toggle-updates": return saveSettings((x) => { x.general.check_updates = !x.general.check_updates; });
    case "check-update-now": return checkUpdate(true);
    case "snooze-update":
      if (st.modal?.kind === "update") updateSnoozed = st.modal.version;
      st.modal = null;
      return render();
    case "install-update": {
      const m = st.modal;
      if (m?.kind !== "update") return;
      m.busy = true; m.error = ""; render();
      try {
        await invoke("install_update"); // при успехе клиент перезапустится сам
      } catch (e) {
        if (st.modal?.kind === "update") { st.modal.busy = false; st.modal.error = errText(e); }
        render();
      }
      return;
    }
    case "toggle-clipboard": return saveSettings((x) => { x.general.clipboard_offer = !x.general.clipboard_offer; });
    case "dismiss-clipboard":
      if (st.modal?.kind === "clipboard") clipboardDismissed = st.modal.text;
      st.modal = null;
      return render();
    case "accept-clipboard": {
      const m = st.modal;
      if (m?.kind !== "clipboard") return;
      m.busy = true; m.error = ""; render();
      try {
        st.settings = await invoke<Settings>("add_from_text", { text: m.text });
        clipboardDismissed = m.text;
        st.modal = null;
        toast("Добавлено — можно подключаться");
        pingAll();
      } catch (e) {
        if (st.modal?.kind === "clipboard") { st.modal.busy = false; st.modal.error = errText(e); }
      }
      return render();
    }
    case "toggle-reminder": return saveSettings((x) => { x.reminder.enabled = !x.reminder.enabled; });
    case "reminder-disable":
      st.modal = null;
      await saveSettings((x) => { x.reminder.enabled = false; });
      return toast("Напоминание выключено — включить можно в настройках");
    case "close-modal": st.modal = null; return render();
    case "overlay": if (ev.target === el) { st.modal = null; render(); } return;
  }
}

document.addEventListener("click", (ev) => {
  const el = (ev.target as HTMLElement).closest<HTMLElement>("[data-action]");
  if (!el || !st.settings) return;
  // Нажатие на крестик внутри строки сервера не должно выбирать сервер.
  if (el.dataset.action === "select-server" && (ev.target as HTMLElement).closest("[data-action='remove-server']")) return;
  onAction(el.dataset.action!, el, ev);
});

document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && st.modal) { st.modal = null; render(); }
  const el = ev.target as HTMLElement;
  if ((ev.key === "Enter" || ev.key === " ") && el.dataset?.action === "select-server") { ev.preventDefault(); onAction("select-server", el, ev); }
});

document.addEventListener("input", (ev) => {
  const el = ev.target as HTMLTextAreaElement;
  if (el.dataset.input !== "exe-list" || st.modal?.kind !== "add-app") return;
  st.modal.text = el.value;
  const stats = manualStats(st.modal);
  const info = document.getElementById("exe-stats");
  const btn = document.getElementById("add-app-btn") as HTMLButtonElement | null;
  if (info) info.textContent = statsText(stats);
  if (btn) {
    btn.disabled = stats.add.length === 0;
    btn.textContent = `Добавить${stats.add.length ? " · " + stats.add.length : ""}`;
  }
});

document.addEventListener("change", (ev) => {
  const el = ev.target as HTMLInputElement;
  const kind = el.dataset.change;
  if (!kind) return;
  if (kind === "pick" && st.modal?.kind === "add-app") {
    const exe = el.dataset.exe!;
    el.checked ? st.modal.picked.add(exe) : st.modal.picked.delete(exe);
    return render();
  }
  if (kind === "port") {
    const port = Number(el.value);
    if (port >= 1024 && port <= 65535) saveSettings((x) => { x.advanced.mixed_port = port; }, "Настройки применены");
    else toast("Порт должен быть от 1024 до 65535", true);
  }
  if (kind === "dns") saveSettings((x) => { x.advanced.remote_dns = el.value.trim() || "1.1.1.1"; }, "Настройки применены");
  if (kind === "log") saveSettings((x) => { x.advanced.log_level = el.value; }, "Настройки применены");

});

document.addEventListener("submit", async (ev) => {
  const form = ev.target as HTMLFormElement;
  ev.preventDefault();
  if (form.dataset.form === "add-domain") {
    const input = form.elements.namedItem("domain") as HTMLInputElement;
    const domain = input.value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^\*\./, "");
    if (!domain || !domain.includes(".")) return toast("Введи домен, например discord.com", true);
    if (st.settings!.rules.proxy_domains.includes(domain)) return;
    return saveSettings((x) => { x.rules.proxy_domains.push(domain); }, "Правила применены");
  }
  if (form.dataset.form === "add-server" && st.modal?.kind === "add-server") {
    const text = (form.elements.namedItem("link") as HTMLTextAreaElement).value;
    st.modal.busy = true; st.modal.error = "";
    render();
    try {
      st.settings = await invoke<Settings>("add_from_text", { text });
      st.modal = null;
      toast("Сервер добавлен");
      pingAll();
    } catch (e) {
      if (st.modal?.kind === "add-server") { st.modal.busy = false; st.modal.error = errText(e); }
    }
    render();
  }
});

// ---------- запуск ----------

async function init() {
  render();
  const full: { settings: Settings; status: Status; presets: Preset[] } = await invoke("get_state");
  st.settings = full.settings;
  st.status = full.status;
  st.presets = full.presets;
  render();

  await listen<string>("core-log", (e: { payload: string }) => {
    if (st.modal?.kind === "text" && st.modal.live) {
      st.modal.text += (st.modal.text ? "\n" : "") + e.payload;
      const pre = document.getElementById("text-pre");
      if (pre) { pre.textContent = st.modal.text; pre.scrollTop = pre.scrollHeight; }
    }
  });
  await listen("tray-toggle", () => { tunRetries = 0; toggleConnect(); });
  await listen<{ code: number | null; last: string }>("core-exit", (e: { payload: { code: number | null; last: string } }) => {
    stopTraffic();
    if (st.status) st.status.running = false;
    syncIndicators();
    const last = e.payload.last || "";
    // Частая ошибка Windows при быстром перезапуске TUN — просто пробуем ещё раз.
    if (/configure tun interface/i.test(last) && tunRetries < 2 && Date.now() - st.connectedAt < 60000) {
      tunRetries++;
      st.busy = true;
      render();
      setTimeout(() => { st.busy = false; toggleConnect(); }, 2000);
      return;
    }
    toast(`Ядро остановилось${last ? ": " + last : ""}`, true);
  });

  setInterval(() => {
    const t = document.getElementById("timer");
    if (t && st.status?.running) t.textContent = `· ${elapsed()}`;
  }, 1000);

  checkReminder();
  setInterval(checkReminder, 30 * 60 * 1000);
  if (full.settings.servers.length) pingAll();
  st.autostart = await invoke<boolean>("get_autostart").catch(() => false);
  syncIndicators();
  render();
  const flags: { autostart: boolean; autoconnect: boolean } = await invoke("startup_flags");
  // Буфер проверяем при запуске и каждый раз, когда окно получает фокус.
  if (!flags.autostart) checkClipboard();
  window.addEventListener("focus", () => checkClipboard());
  await listen<number>("update-progress", (e: { payload: number }) => {
    if (st.modal?.kind === "update") {
      st.modal.progress = e.payload;
      const bar = document.getElementById("upd-bar");
      if (bar) bar.style.width = `${e.payload}%`;
    }
  });
  // Обновления: через 10 секунд после запуска и дальше раз в 6 часов.
  setTimeout(() => checkUpdate(), 10_000);
  setInterval(() => checkUpdate(), 6 * 60 * 60 * 1000);
  const shouldConnect = flags.autoconnect || (flags.autostart && full.settings.general.autoconnect);
  if (shouldConnect && !st.status?.running) toggleConnect();
}

init().catch((e) => {
  root.innerHTML = `<div style="padding:32px">Не удалось запустить интерфейс: ${esc(errText(e))}</div>`;
});
