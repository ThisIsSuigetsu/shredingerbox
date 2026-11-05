import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
import { mascot, type Mood } from "./mascot";
import { inline, parseItems, releaseNotes, releasesBetween, type Release } from "./changelog";
import { t, setLang, resolveLang, locale, type LangSetting } from "./i18n";

// ---------- типы (зеркало Rust-структур) ----------

type Mode = "tun" | "proxy";
type Theme = "system" | "dark" | "light";
type FinalRoute = "proxy" | "direct";
interface Server { id: string; name: string; link: string; subscription: string | null }
interface AppRule { name: string; exe: string }
interface SubInfo { upload: number; download: number; total: number; expire: number | null }
interface Subscription { url: string; name: string; updated: number | null; info: SubInfo | null }
interface Advanced {
  enabled: boolean; mixed_port: number; allow_lan: boolean; log_level: string;
  remote_dns: string; remote_dns_type: string; direct_dns: string; dns_strategy: string;
  tun_stack: string; tun_mtu: number; tun_strict_route: boolean; tun_ipv6: boolean;
  sniff: boolean; bypass_lan: boolean; block_quic: boolean; proxy_ips: string[]; direct_ips: string[];
  subs_refresh_hours: number; sub_user_agent: string;
}
interface Settings {
  mode: Mode;
  servers: Server[];
  subscriptions: Subscription[];
  selected: string | null;
  auto_server: boolean;
  rules: { final_route: FinalRoute; proxy_apps: AppRule[]; direct_apps: AppRule[]; proxy_domains: string[]; direct_domains: string[]; presets: string[] };
  advanced: Advanced;
  reminder: { enabled: boolean; last_shown: string | null; day: number; note: string; mode: "day" | "expire" };
  general: { autoconnect: boolean; close_to_tray: boolean; clipboard_offer: boolean; check_updates: boolean; theme: Theme; language: LangSetting };
  seen_version: string | null;
}
interface Status { running: boolean; mode: Mode; server: string | null; api_port: number; secret: string; elevated: boolean; windows: boolean; tun: boolean; portable: boolean; auto: boolean }
interface Preset { id: string; title: string; domains: string[] }
interface Ping { id: string; ms: number | null; udp: boolean; via_vpn: boolean }
interface Proc { name: string; exe: string }
interface ServiceCheck { name: string; ok: boolean; ms: number | null; detail: string }
type View = "main" | "servers" | "rules" | "settings";
type AdvTab = "main" | "dns" | "tun" | "routing" | "subs";
type AppList = "proxy_apps" | "direct_apps";
type SiteList = "proxy_domains" | "direct_domains";
interface Usage { up: number; down: number }
type Modal =
  | { kind: "add-server"; busy: boolean; error: string }
  | { kind: "add-app"; list: AppList; tab: "running" | "manual"; text: string; loading: boolean; procs: Proc[]; picked: Set<string>; manual: Proc[] }
  | { kind: "add-sites"; list: SiteList; text: string }
  | { kind: "list"; list: AppList | SiteList; filter: string }
  | { kind: "admin" }
  | { kind: "reminder" }
  | { kind: "clipboard"; text: string; busy: boolean; error: string }
  | { kind: "update"; version: string; current: string; notes: string; busy: boolean; progress: number; error: string }
  | { kind: "whatsnew"; releases: Release[] }
  | { kind: "services"; busy: boolean; viaVpn: boolean; results: ServiceCheck[] }
  | { kind: "text"; title: string; text: string; live: boolean };

// ---------- состояние ----------

const st = {
  view: "main" as View,
  advTab: "main" as AdvTab,
  settings: null as Settings | null,
  status: null as Status | null,
  presets: [] as Preset[],
  defaults: null as Advanced | null,
  busy: false,
  pings: {} as Record<string, Ping>,
  connectedAt: 0,
  traffic: { up: 0, down: 0 },
  modal: null as Modal | null,
  toast: null as { text: string; error: boolean } | null,
  logs: [] as string[],
  autostart: false,
  autostartBusy: false,
  siteTab: "proxy_domains" as SiteList,
  /** Какой сервер сейчас выбрало «Авто» (id), пока VPN включён. */
  autoNow: null as string | null,
  /** Расход трафика по серверам за текущий месяц. */
  usage: { month: "", servers: {} as Record<string, Usage> },
};

/** Сколько строк показывать в списках правил - остальное в окне «Показать все». */
const LIST_LIMIT = 10;
const listTitle = (list: AppList | SiteList) => ({
  proxy_apps: t("Приложения через VPN"),
  direct_apps: t("Приложения напрямую"),
  proxy_domains: t("Сайты через VPN"),
  direct_domains: t("Сайты напрямую"),
})[list];

const root = document.getElementById("app")!;
/** Версия из package.json - Vite подставляет её при сборке. */
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
  down: () => `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" style="color:var(--accent-ink)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="${t("Загрузка")}"><path d="M12 5v14M6 13l6 6 6-6"/></svg>`,
  up: () => `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" style="color:var(--blue)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="${t("Отдача")}"><path d="M12 19V5M6 11l6-6 6 6"/></svg>`,
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
  if (p.udp) return `<span class="ping muted" title="${t("Hysteria2 работает по UDP - TCP-пинг не меряется")}">UDP</span>`;
  if (p.ms == null) return `<span class="ping" style="color:var(--danger)">${t("нет ответа")}</span>`;
  const good = p.via_vpn ? 300 : 120;
  const color = p.ms <= good ? "var(--accent-ink)" : p.ms <= good * 2.5 ? "var(--amber)" : "var(--danger)";
  const title = p.via_vpn ? t("Реальная задержка через VPN") : t("TCP-подключение к серверу");
  return `<span class="ping" style="color:${color}" title="${title}">${t("{n} мс", { n: p.ms })}</span>`;
}

const num = (n: number) => n.toLocaleString(locale(), { maximumFractionDigits: 1 });

function speed(bytes: number): string {
  if (bytes >= 1024 * 1024) return t("{n} МБ/с", { n: num(bytes / 1024 / 1024) });
  return t("{n} КБ/с", { n: num(bytes / 1024) });
}

function bytes(n: number): string {
  if (n >= 1024 ** 3) return t("{n} ГБ", { n: num(n / 1024 ** 3) });
  if (n >= 1024 ** 2) return t("{n} МБ", { n: num(n / 1024 ** 2) });
  return t("{n} КБ", { n: num(n / 1024) });
}

/** «2026-11» → «ноябрь» / «November» */
function monthName(month: string): string {
  const m = Number(month.slice(5, 7));
  if (!m) return t("месяц");
  return new Date(2000, m - 1, 1).toLocaleString(locale(), { month: "long" });
}

/** Расход сервера за месяц: короткий текст и подсказка с разбивкой. Пусто, если трафика не было. */
function usageOf(id: string): { short: string; title: string } {
  const u = st.usage.servers[id];
  if (!u || u.up + u.down === 0) return { short: "", title: "" };
  return { short: bytes(u.up + u.down), title: t("За {m}: ↓ {down} · ↑ {up}", { m: monthName(st.usage.month), down: bytes(u.down), up: bytes(u.up) }) };
}

function usageView(id: string): string {
  const u = usageOf(id);
  return `<span class="usage" data-usage-id="${esc(id)}" title="${esc(u.title)}">${esc(u.short)}</span>`;
}

const usageLong = (short: string) => (short ? t(" · {v} за {m}", { v: short, m: monthName(st.usage.month) }) : "");

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

/** Сервер, через который сейчас идёт трафик: при «Авто» - выбранный ядром. */
function activeServer(): Server | undefined {
  const s = st.settings!;
  if (s.auto_server) return s.servers.find((x) => x.id === st.autoNow);
  return selected();
}

/** «20 декабря» (год - только если не текущий). */
function dateText(sec: number): string {
  const d = new Date(sec * 1000);
  const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "long" };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString(locale(), opts);
}

/** «осталось 120 ГБ из 200 ГБ · до 20 декабря» - из заголовка subscription-userinfo. */
function subInfoText(info: SubInfo | null): string {
  if (!info) return "";
  const parts: string[] = [];
  const used = info.upload + info.download;
  if (info.total > 0) parts.push(t("осталось {left} из {total}", { left: bytes(Math.max(0, info.total - used)), total: bytes(info.total) }));
  else if (used > 0) parts.push(t("потрачено {used}", { used: bytes(used) }));
  if (info.expire) parts.push(info.expire * 1000 < Date.now() ? t("истекла {date}", { date: dateText(info.expire) }) : t("до {date}", { date: dateText(info.expire) }));
  return parts.join(" · ");
}

/** Ближайший конец подписки среди всех подписок. */
function nearestExpire(): number | null {
  const list = st.settings!.subscriptions.map((x) => x.info?.expire).filter((x): x is number => !!x);
  return list.length ? Math.min(...list) : null;
}

/** Имя подписки: стандартное «Подписка» показываем на языке интерфейса. */
const subName = (sub: Subscription) => (sub.name === "Подписка" || sub.name === "Subscription" ? t("Подписка") : sub.name);

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

/** «https://www.Discord.com/app», «*.discord.com» → «discord.com». Кириллица остаётся как есть,
 *  в punycode её переводит Rust при сборке конфига. */
function normalizeDomain(raw: string): string | null {
  const s = raw.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/[/?#].*$/, "").replace(/:\d+$/, "")
    .replace(/^\*?\./, "").replace(/^www\./, "");
  if (!s || !s.includes(".")) return null;
  try {
    const host = new URL(`http://${s}`).hostname;
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? s : null;
  } catch { return null; }
}

/** Что добавится из поля сайтов: без дубликатов и без уже добавленных в этот список. */
function siteStats(m: { list: SiteList; text: string }): { add: string[]; dup: number } {
  const existing = new Set(st.settings!.rules[m.list]);
  const seen = new Set<string>();
  const add: string[] = [];
  let dup = 0;
  for (const part of m.text.split(/[\s,;]+/)) {
    const d = normalizeDomain(part);
    if (!d) continue;
    if (seen.has(d) || existing.has(d)) { dup++; continue; }
    seen.add(d);
    add.push(d);
  }
  return { add, dup };
}

function statsText(x: { add: string[]; dup: number }): string {
  if (!x.add.length && !x.dup) return t("Список пуст");
  return t("Будет добавлено: {n}", { n: x.add.length }) + (x.dup ? t(" · дубликатов пропущено: {n}", { n: x.dup }) : "");
}

const addLabel = (n: number) => t("Добавить") + (n ? " · " + n : "");

// ---------- язык ----------

/** Язык из настроек («как в системе» - по языку Windows / macOS), и Rust переводит ошибки и трей. */
function applyLanguage() {
  const lang = resolveLang(st.settings?.general.language ?? "system");
  setLang(lang);
  invoke("set_language", { english: lang === "en" }).catch(() => {});
}

// ---------- обновления ----------

interface UpdateInfo { version: string; current: string; notes: string | null }
/** Версия, от которой пользователь отказался «Позже», - до перезапуска больше не предлагаем. */
let updateSnoozed = "";

async function checkUpdate(manual = false) {
  if (!manual && (!st.settings?.general.check_updates || st.modal)) return;
  try {
    const info = await invoke<UpdateInfo | null>("check_update");
    if (!info) { if (manual) toast(t("У тебя последняя версия")); return; }
    if (!manual && info.version === updateSnoozed) return;
    if (st.modal && !manual) return;
    st.modal = { kind: "update", version: info.version, current: info.current, notes: info.notes ?? "", busy: false, progress: 0, error: "" };
    render();
  } catch (e) {
    if (manual) toast(errText(e), true);
  }
}

// ---------- буфер обмена ----------

/** Текст из буфера, который пользователь уже отклонил, - второй раз не предлагаем. */
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
  } catch { /* буфер недоступен - молча пропускаем */ }
  clipboardChecking = false;
}

/** «2 ключа» / «подписка с panel.example.org» - коротко, без самих секретов. */
function clipboardSummary(text: string): string {
  if (/^https?:\/\//i.test(text)) {
    try { return t("подписка с {host}", { host: `<span class="mono">${esc(new URL(text).host)}</span>` }); } catch { return t("подписка"); }
  }
  const lines = text.split("\n").filter(Boolean);
  const names = lines.slice(0, 3).map((l) => {
    const hash = l.indexOf("#");
    const name = hash >= 0 ? decodeURIComponent(l.slice(hash + 1)) : l.split("://")[0] + "://…";
    return `<li>${esc(name)}</li>`;
  }).join("");
  const more = lines.length > 3 ? `<li class="muted">${t("и ещё {n}", { n: lines.length - 3 })}</li>` : "";
  return `${lines.length === 1 ? t("ключ") : t("ключи ({n})", { n: lines.length })}:<ul style="margin:6px 0 0;padding-left:18px">${names}${more}</ul>`;
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

/** После ошибки ядро могло остановиться - берём настоящее состояние у Rust. */
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
  refreshUsage();
  // Пинг выбранного сервера сразу через туннель
  if (st.status?.running) setTimeout(pingAll, 1500);
}

/** После обновления один раз показывает «Что нового». На свежей установке (серверов ещё нет) - молчит. */
async function showWhatsNew() {
  const s = st.settings!;
  if (APP_VERSION === "dev" || s.seen_version === APP_VERSION) return;
  // До 0.6.1 версия не запоминалась - старому пользователю показываем только текущую.
  const releases = s.seen_version
    ? releasesBetween(s.seen_version, APP_VERSION)
    : s.servers.length ? releasesBetween("0", APP_VERSION).slice(0, 1) : [];
  await saveSettings((x) => { x.seen_version = APP_VERSION; });
  if (releases.length && !st.modal) { st.modal = { kind: "whatsnew", releases }; render(); }
}

/** Берёт у Rust расход за месяц и обновляет цифры на месте, без полной перерисовки. */
async function refreshUsage() {
  try { st.usage = await invoke<typeof st.usage>("get_traffic"); } catch { return; }
  document.querySelectorAll<HTMLElement>("[data-usage-id]").forEach((el) => {
    const u = usageOf(el.dataset.usageId!);
    el.textContent = u.short;
    el.title = u.title;
  });
  document.querySelectorAll<HTMLElement>("[data-usage-long]").forEach((el) => {
    const u = usageOf(el.dataset.usageLong!);
    el.textContent = usageLong(u.short);
    el.title = u.title;
  });
}

/** Трей и панель задач Rust обновляет сам, а тут - на всякий случай, по настоящему состоянию ядра. */
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
    // Ядро могло ещё не поднять API - пробуем пару раз.
    if (attempt < 5 && st.status?.running) setTimeout(() => startTraffic(attempt + 1), 700);
  };
}

function stopTraffic() {
  if (ws) { ws.onerror = null; ws.close(); ws = null; }
  st.traffic = { up: 0, down: 0 };
}

/** Узнать у ядра, какой сервер выбрало «Авто». */
async function refreshAuto() {
  if (!st.settings?.auto_server || !st.status?.running) { st.autoNow = null; return; }
  st.autoNow = await invoke<string | null>("auto_current").catch(() => null);
}

async function pingAll() {
  try {
    const list = await invoke<Ping[]>("ping_servers");
    st.pings = Object.fromEntries(list.map((p: Ping) => [p.id, p]));
    await refreshAuto();
    render();
  } catch (e) {
    toast(errText(e), true);
  }
}

async function checkServices() {
  st.modal = { kind: "services", busy: true, viaVpn: !!st.status?.running, results: st.modal?.kind === "services" ? st.modal.results : [] };
  render();
  try {
    const results = await invoke<ServiceCheck[]>("check_services");
    if (st.modal?.kind === "services") { st.modal.results = results; st.modal.busy = false; }
  } catch (e) {
    if (st.modal?.kind === "services") st.modal.busy = false;
    toast(errText(e), true);
  }
  render();
}

/** Автообновление подписок раз в N часов и при запуске клиента (продвинутый режим → «Подписки»).
 *  Ошибки молчат - попробуем в следующий раз. */
let subsUpdating = false;
async function autoUpdateSubs(atStart = false) {
  const s = st.settings;
  const hours = s?.advanced.subs_refresh_hours ?? 0;
  if (!s || !hours || !s.subscriptions.length || subsUpdating) return;
  const now = Date.now() / 1000;
  if (!atStart && !s.subscriptions.some((sub) => !sub.updated || now - sub.updated >= hours * 3600)) return;
  subsUpdating = true;
  try { st.settings = await invoke<Settings>("refresh_subscriptions"); render(); } catch { /* попробуем позже */ }
  subsUpdating = false;
}

// ---------- отрисовка ----------

function sidebar(): string {
  const s = st.settings!;
  const nav = (v: View, label: string, ic: string) =>
    `<button class="nav-btn ${st.view === v ? "active" : ""}" data-action="nav" data-view="${v}">${ic}${label}</button>`;
  const exp = nearestExpire();
  const sub = s.subscriptions.length
    ? `<div class="sub-card"><div class="t"><b>${t("Подписка")}</b><span>${t("{n} серв.", { n: s.servers.filter((x) => x.subscription).length })}${exp ? " · " + esc(t("до {date}", { date: dateText(exp) })) : ""}</span></div>
       <button class="x-btn" data-action="refresh-subs" aria-label="${t("Обновить подписку")}" title="${t("Обновить подписку")}">${icon.refresh}</button></div>`
    : "";
  return `<nav class="side" aria-label="${t("Разделы")}">
    <div class="brand">${mascot(36, mood())}<span>ShredingerBox</span></div>
    ${nav("main", t("Главная"), icon.power())}
    ${nav("servers", t("Серверы"), icon.globe)}
    ${nav("rules", t("Правила"), icon.rules)}
    ${nav("settings", t("Настройки"), icon.gear)}
    <div class="spacer"></div>
    ${sub}
    <span class="version">v${APP_VERSION}</span>
  </nav>`;
}

function titlebar(): string {
  return `<div class="titlebar" data-tauri-drag-region>
    <button class="win-btn" data-action="win-min" aria-label="${t("Свернуть")}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M4 12h16"/></svg></button>
    <button class="win-btn" data-action="win-max" aria-label="${t("Развернуть")}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="2"/></svg></button>
    <button class="win-btn close" data-action="win-close" aria-label="${t("Закрыть")}">${icon.x(12)}</button>
  </div>`;
}

const keysHint = () => t("Серверов пока нет. Вставь ключ {a}, {b} или ссылку на подписку.", { a: `<span class="mono">vless://</span>`, b: `<span class="mono">hy2://</span>` });

function mainView(): string {
  const s = st.settings!;
  const running = !!st.status?.running;
  const srv = activeServer();
  const flag = srv ? splitFlag(srv.name) : null;
  const powerCls = st.busy ? "busy" : running ? "on" : "";
  const title = st.busy ? (running ? t("Отключаемся…") : t("Подключаемся…")) : running
    ? `${t("Подключено")} <span class="timer" id="timer">· ${elapsed()}</span>`
    : t("Не подключено");
  const month = srv ? usageOf(srv.id) : null;
  const autoMark = s.auto_server ? `<span class="flag">${t("АВТО")}</span>` : "";
  const sub = srv
    ? `${autoMark}<span class="flag">${esc(flag!.code)}</span>${esc(flag!.name)}${st.pings[srv.id] ? " · " + pingView(srv.id) : ""}
       <span data-usage-long="${esc(srv.id)}" title="${esc(month!.title)}">${esc(usageLong(month!.short))}</span>`
    : s.auto_server && s.servers.length ? `${autoMark}${t("Лучший сервер выберется при подключении")}`
    : t("Добавь сервер, чтобы подключиться");

  const servers = s.servers.length
    ? autoRow() + s.servers.map((x) => {
        const f = splitFlag(x.name);
        return `<div class="server ${!s.auto_server && x.id === srv?.id ? "on" : ""}" role="button" tabindex="0" data-action="select-server" data-id="${x.id}">
          <span class="flag">${esc(f.code)}</span><span class="name" title="${esc(x.name)}">${esc(f.name)}</span>${pingView(x.id)}
          <button class="del" data-action="remove-server" data-id="${x.id}" aria-label="${t("Удалить сервер")}">${icon.x(13)}</button>
        </div>`;
      }).join("")
    : `<div class="empty">${keysHint()}</div>`;

  const windows = st.status?.windows ?? true;
  const modeOpt = (m: Mode, title: string, d: string, off = false) =>
    `<button class="mode-opt ${s.mode === m ? "on" : ""}" data-action="set-mode" data-mode="${m}" aria-pressed="${s.mode === m}" ${off ? "disabled" : ""}>
      <span class="radio"></span><span><b>${title}</b><span>${d}</span></span></button>`;

  return `<div class="home">
    <div class="home-center">
      <button class="power ${powerCls}" data-action="toggle-connect" aria-label="${running ? t("Отключиться") : t("Подключиться")}">
        <span class="inner">${icon.power(68)}</span>
      </button>
      <div style="display:flex;flex-direction:column;gap:10px">
        <div class="status-title">${title}</div>
        <div class="status-sub">${sub}</div>
      </div>
      ${running ? `<div class="speeds">
        <div class="speed">${icon.down()}<span id="spd-down">${speed(st.traffic.down)}</span></div>
        <div class="speed">${icon.up()}<span id="spd-up">${speed(st.traffic.up)}</span></div>
      </div>` : ""}
    </div>
    <div class="home-side">
      <section class="card">
        <h2>${t("Режим")}</h2>
        ${!(st.status?.tun ?? true) ? modeOpt("tun", "TUN", t("Пока недоступно на этой системе"), true)
          : windows ? modeOpt("tun", "TUN", t("Весь трафик системы по правилам"))
          : modeOpt("tun", "TUN", t("Весь трафик · пароль администратора при подключении"))}
        ${modeOpt("proxy", t("Прокси"), t("Только программы с системным прокси"))}
      </section>
      <section class="card servers">
        <div class="card-head"><h2>${t("Серверы")}</h2>${s.servers.length ? `<div style="display:flex;gap:12px">
          <button class="link-btn" data-action="check-services">${t("Сервисы")}</button>
          <button class="link-btn" data-action="ping">${t("Проверить пинг")}</button></div>` : ""}</div>
        <div class="server-list">${servers}</div>
        <button class="dashed" data-action="open-add-server">${icon.plus}${t("Добавить подписку или ключ")}</button>
      </section>
    </div>
  </div>`;
}

/** Строка «Авто»: ядро само выбирает сервер с наименьшей задержкой. */
function autoRow(): string {
  const on = st.settings!.auto_server;
  const now = on ? st.settings!.servers.find((x) => x.id === st.autoNow) : undefined;
  return `<div class="server ${on ? "on" : ""}" role="button" tabindex="0" data-action="select-server" data-id="auto" title="${t("Ядро само выбирает сервер с наименьшей задержкой и уходит с упавшего")}">
    <span class="flag">${t("АВТО")}</span><span class="name">${now ? esc(t("Авто · {name}", { name: splitFlag(now.name).name })) : t("Лучший сервер")}</span></div>`;
}

function serverRow(x: Server, current: Server | undefined): string {
  const f = splitFlag(x.name);
  return `<div class="server ${!st.settings!.auto_server && x.id === current?.id ? "on" : ""}" role="button" tabindex="0" data-action="select-server" data-id="${x.id}">
    <span class="flag">${esc(f.code)}</span><span class="name" title="${esc(x.name)}">${esc(f.name)}</span>${usageView(x.id)}${pingView(x.id)}
    <button class="del" data-action="remove-server" data-id="${x.id}" aria-label="${t("Удалить сервер")}">${icon.x(13)}</button>
  </div>`;
}

const host = (url: string) => { try { return new URL(url).host; } catch { return url; } };

function serversView(): string {
  const s = st.settings!;
  const current = selected();
  const groups = s.subscriptions.map((sub) => {
    const list = s.servers.filter((x) => x.subscription === sub.url);
    return `<section class="card">
      <div class="card-head">
        <div style="display:flex;flex-direction:column;gap:2px;min-width:0">
          <h2>${esc(subName(sub))} <span class="count">· ${list.length}</span></h2>
          <span class="muted mono" style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(host(sub.url))}</span>
          ${sub.info ? `<span class="muted" style="font-size:12px">${esc(subInfoText(sub.info))}</span>` : ""}
        </div>
        <div style="display:flex;gap:4px">
          <button class="x-btn" data-action="refresh-subs" aria-label="${t("Обновить подписку")}" title="${t("Обновить")}">${icon.refresh}</button>
          <button class="x-btn" data-action="remove-sub" data-url="${esc(sub.url)}" aria-label="${t("Удалить подписку")}" title="${t("Удалить подписку")}">${icon.x()}</button>
        </div>
      </div>
      <div class="server-list" style="max-height:none">${list.map((x) => serverRow(x, current)).join("") || `<div class="empty">${t("В подписке нет серверов")}</div>`}</div>
    </section>`;
  }).join("");
  const manual = s.servers.filter((x) => !x.subscription);
  const manualCard = manual.length
    ? `<section class="card"><div class="card-head"><h2>${t("Добавленные вручную")} <span class="count">· ${manual.length}</span></h2></div>
        <div class="server-list" style="max-height:none">${manual.map((x) => serverRow(x, current)).join("")}</div></section>`
    : "";
  const empty = !s.servers.length
    ? `<section class="card"><div class="empty">${t("Серверов пока нет. Вставь ключ или ссылку на подписку.")}</div></section>`
    : "";
  return `<div class="page-head">
      <div><h1>${t("Серверы")}</h1><p>${t("Подписки и ключи. Пока VPN включён, пинг каждого сервера меряется через туннель, а переключение мгновенное.")}
        ${t("Рядом с сервером - расход трафика за {m}, наведи, чтобы увидеть загрузку и отдачу.", { m: monthName(st.usage.month || "0000-00") })}</p></div>
      <div style="display:flex;gap:8px">
        ${s.servers.length ? `<button class="btn-ghost" data-action="ping">${t("Проверить пинг")}</button>` : ""}
        <button class="btn-light" data-action="open-add-server">${t("Добавить")}</button>
      </div>
    </div>
    <div class="settings" style="max-width:none">${s.servers.length > 1 ? `<section class="card"><div class="server-list" style="max-height:none">${autoRow()}</div></section>` : ""}${empty}${groups}${manualCard}</div>`;
}

const isAppList = (list: AppList | SiteList): list is AppList => list === "proxy_apps" || list === "direct_apps";

/** Строки списка правил: приложения или сайты, с кнопкой «убрать». */
function ruleRows(list: AppList | SiteList, filter = "", limit = Infinity): string {
  const q = filter.trim().toLowerCase();
  const rows = isAppList(list)
    ? st.settings!.rules[list]
        .filter((a) => !q || a.name.toLowerCase().includes(q) || a.exe.toLowerCase().includes(q))
        .map((a) => `<div class="app-row"><div class="app-icon">${esc(a.name.charAt(0).toUpperCase())}</div>
          <span class="n">${esc(a.name)} <small>· ${esc(a.exe)}</small></span>
          <button class="x-btn" data-action="remove-app" data-list="${list}" data-exe="${esc(a.exe)}" aria-label="${esc(t("Убрать {name} из списка", { name: a.name }))}">${icon.x()}</button></div>`)
    : st.settings!.rules[list]
        .filter((d) => !q || d.includes(q))
        .map((d) => `<div class="app-row"><div class="app-icon">${esc(d.charAt(0).toUpperCase())}</div>
          <span class="n">${esc(d)}</span>
          <button class="x-btn" data-action="remove-domain" data-list="${list}" data-domain="${esc(d)}" aria-label="${esc(t("Убрать {name} из списка", { name: d }))}">${icon.x()}</button></div>`);
  if (!rows.length) return `<div class="empty" style="padding:6px 0">${q ? t("Ничего не нашлось") : t("Пока пусто")}</div>`;
  return rows.slice(0, limit).join("");
}

/** Первые 10 строк и кнопка «Показать все», если их больше. */
function ruleList(list: AppList | SiteList): string {
  const total = st.settings!.rules[list].length;
  const more = total > LIST_LIMIT
    ? `<button class="link-btn more" data-action="show-list" data-list="${list}">${t("Показать все ({n})", { n: total })}</button>`
    : "";
  return ruleRows(list, "", LIST_LIMIT) + more;
}

function appCard(list: AppList, hollow: boolean): string {
  return `<section class="card" style="gap:2px">
    <div class="card-head" style="padding-bottom:6px"><div style="display:flex;align-items:center;gap:10px"><span class="dot ${hollow ? "hollow" : ""}"></span><h2>${listTitle(list)}</h2></div><span class="count">${st.settings!.rules[list].length}</span></div>
    ${ruleList(list)}
    <button class="dashed" style="margin-top:6px" data-action="open-add-app" data-list="${list}">${icon.plus}${t("Добавить приложение")}</button>
  </section>`;
}

function rulesView(): string {
  const r = st.settings!.rules;
  const tab = st.siteTab;
  const siteTab = (list: SiteList, label: string) =>
    `<button role="tab" aria-selected="${tab === list}" class="${tab === list ? "on" : ""}" data-action="site-tab" data-list="${list}">${label} · ${r[list].length}</button>`;
  const presets = st.presets.map((p) => {
    const on = r.presets.includes(p.id);
    return `<button class="preset ${on ? "on" : ""}" data-action="toggle-preset" data-id="${p.id}" aria-pressed="${on}" title="${esc(p.domains.join(", "))}">${on ? "✓ " : ""}${esc(p.title)}</button>`;
  }).join("");
  return `<div class="page-head">
      <div><h1>${t("Правила")}</h1><p>${t("Что идёт через VPN, а что напрямую")}</p></div>
      <div style="display:flex;align-items:center;gap:12px"><span class="muted" style="font-size:13px">${t("Остальной трафик")}</span>
        <div class="seg" role="group" aria-label="${t("Остальной трафик")}">
          <button class="${r.final_route === "proxy" ? "on" : ""}" data-action="set-final" data-value="proxy">${t("Через VPN")}</button>
          <button class="${r.final_route === "direct" ? "on" : ""}" data-action="set-final" data-value="direct">${t("Напрямую")}</button>
        </div></div>
    </div>
    <div class="rules-grid">
      <div class="col">${appCard("proxy_apps", false)}${appCard("direct_apps", true)}</div>
      <div class="col"><section class="card" style="gap:2px">
        <div class="card-head" style="padding-bottom:8px"><div style="display:flex;align-items:center;gap:10px"><span class="dot ${tab === "direct_domains" ? "hollow" : ""}"></span><h2>${t("Сайты")}</h2></div>
          <div class="seg inset" role="tablist" aria-label="${t("Какие сайты")}">${siteTab("proxy_domains", t("Через VPN"))}${siteTab("direct_domains", t("Напрямую"))}</div></div>
        ${ruleList(tab)}
        <button class="dashed" style="margin-top:6px" data-action="open-add-sites">${icon.plus}${t("Добавить сайты")}</button>
        ${tab === "proxy_domains"
          ? `<div class="sep" style="margin:12px 0"></div>
            <span class="muted" style="font-size:12px;padding-bottom:8px">${t("Готовые наборы - нажми, чтобы включить")}</span>
            <div class="chips">${presets}</div>`
          : `<div class="hint" style="margin-top:12px">${icon.info}<span>${t("Эти сайты всегда идут напрямую - даже из приложений «через VPN» и готовых наборов. Удобно для банков и госуслуг.")}</span></div>`}
        <div class="hint" style="margin-top:12px">${icon.info}<span>${t("В режиме «Прокси» правила для приложений работают только у программ, которые используют системный прокси. В режиме TUN - у всех.")}</span></div>
      </section></div>
    </div>`;
}

// ---------- настройки ----------

const sw = (on: boolean, action: string, label: string, busy = false) =>
  `<button class="switch ${on ? "on" : ""}" role="switch" aria-checked="${on}" aria-label="${esc(label)}" data-action="${action}" ${busy ? "disabled" : ""}><span></span></button>`;

/** Строка настройки: заголовок, пояснение и элемент управления справа. */
const row = (title: string, desc: string, control: string, forId = "") =>
  `<div class="set-row"><div class="t">${forId ? `<label for="${forId}"><b>${title}</b></label>` : `<b>${title}</b>`}<span>${desc}</span></div>${control}</div>`;

/** Переключатель продвинутого режима: data-adv - имя поля в settings.advanced. */
const advSwitch = (field: keyof Advanced, title: string, desc: string) => {
  const on = !!st.settings!.advanced[field];
  return row(title, desc, `<button class="switch ${on ? "on" : ""}" role="switch" aria-checked="${on}" aria-label="${esc(title)}" data-action="adv-toggle" data-field="${field}"><span></span></button>`);
};

const select = (id: string, change: string, value: string, options: [string, string][], field = "") =>
  `<select id="${id}" class="field" data-change="${change}" ${field ? `data-field="${field}"` : ""}>${options.map(([v, l]) => `<option value="${esc(v)}" ${v === value ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;

function advancedTab(): string {
  const a = st.settings!.advanced;
  const card = (body: string) => `<section class="card" style="gap:0;padding:6px 16px">${body}</section>`;
  const hint = (text: string) => `<div class="hint">${icon.info}<span>${text}</span></div>`;
  switch (st.advTab) {
    case "dns":
      return card(
        row(t("DNS для VPN-трафика"), t("Через него узнаются адреса сайтов, которые идут через VPN"),
          `<div style="display:flex;gap:8px">${select("dns-type", "adv-dns-type", a.remote_dns_type, [["https", "DoH"], ["tls", "DoT"], ["udp", "UDP"]])}
           <input id="dns" class="field mono" data-change="adv-text" data-field="remote_dns" value="${esc(a.remote_dns)}" placeholder="1.1.1.1" /></div>`, "dns")
        + row(t("DNS для сайтов напрямую"), t("Пусто - системный DNS. Можно указать свой, например 77.88.8.8"),
          `<input id="direct-dns" class="field mono" data-change="adv-text" data-field="direct_dns" value="${esc(a.direct_dns)}" placeholder="${t("системный")}" />`, "direct-dns")
        + row(t("IPv4 и IPv6"), t("Какие адреса просить у DNS"),
          select("dns-strategy", "adv-select", a.dns_strategy, [["prefer_ipv4", t("Сначала IPv4")], ["prefer_ipv6", t("Сначала IPv6")], ["ipv4_only", t("Только IPv4")], ["ipv6_only", t("Только IPv6")]], "dns_strategy"), "dns-strategy"),
      ) + hint(t("Адрес можно указать со схемой: {a}, {b} или {c}.", { a: `<span class="mono">https://dns.google/dns-query</span>`, b: `<span class="mono">tls://1.1.1.1</span>`, c: `<span class="mono">8.8.8.8:53</span>` }));
    case "tun":
      return card(
        row(t("Сетевой стек"), t("«mixed» подходит почти всем. «system» быстрее, «gvisor» совместимее"),
          select("tun-stack", "adv-select", a.tun_stack, [["mixed", "mixed"], ["system", "system"], ["gvisor", "gvisor"]], "tun_stack"), "tun-stack")
        + row("MTU", t("Размер пакета. Стандарт - 9000, при проблемах попробуй 1500"),
          `<input id="tun-mtu" class="field mono" type="number" min="1280" max="65535" data-change="adv-number" data-field="tun_mtu" value="${a.tun_mtu}" />`, "tun-mtu")
        + advSwitch("tun_strict_route", t("Строгая маршрутизация"), t("Программы не смогут обойти VPN. Выключи, если не работает локальная сеть или другой VPN"))
        + advSwitch("tun_ipv6", "IPv6", t("Пускать IPv6-трафик через TUN")),
      ) + hint(t("Настройки TUN применяются в режиме TUN. Если VPN включён, он переподключится сам."));
    case "routing":
      return card(
        advSwitch("sniff", t("Определять сайт по соединению"), t("Нужно для правил по сайтам и наборов. Выключай, только если что-то ломается"))
        + advSwitch("bypass_lan", t("Локальная сеть напрямую"), t("Роутер, принтер, NAS и другие устройства дома - мимо VPN"))
        + advSwitch("block_quic", t("Блокировать QUIC"), t("Браузеры перейдут на обычный HTTPS - через VPN он часто быстрее, например в YouTube")),
      ) + `<section class="card">
        <h2>${t("IP-адреса и подсети")}</h2>
        <p class="muted" style="margin:0;font-size:13px;line-height:1.5">${t("По одному на строку: {a} или {b}. Работает для программ, которые подключаются по IP.", { a: `<span class="mono">1.2.3.4</span>`, b: `<span class="mono">10.0.0.0/8</span>` })}</p>
        <div class="rules-grid" style="gap:12px">
          <div class="col"><label for="proxy-ips" class="muted" style="font-size:13px">${t("Через VPN")}</label>
            <textarea id="proxy-ips" class="field mono" style="height:120px" data-change="adv-list" data-field="proxy_ips" spellcheck="false">${esc(a.proxy_ips.join("\n"))}</textarea></div>
          <div class="col"><label for="direct-ips" class="muted" style="font-size:13px">${t("Напрямую")}</label>
            <textarea id="direct-ips" class="field mono" style="height:120px" data-change="adv-list" data-field="direct_ips" spellcheck="false">${esc(a.direct_ips.join("\n"))}</textarea></div>
        </div>
      </section>`;
    case "subs": {
      const s = st.settings!;
      const fmt = (sec: number | null) => (sec ? new Date(sec * 1000).toLocaleString(locale(), { dateStyle: "short", timeStyle: "short" }) : t("ещё не обновлялась"));
      const subs = s.subscriptions.map((sub, i) => `<div class="set-row"><div class="t" style="min-width:0">
          <input id="sub-${i}" class="field" style="width:100%;max-width:260px" data-change="sub-name" data-url="${esc(sub.url)}" value="${esc(subName(sub))}" aria-label="${t("Название подписки")}" />
          <span class="mono" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(host(sub.url))} · ${esc(fmt(sub.updated))}</span>
          ${sub.info ? `<span>${esc(subInfoText(sub.info))}</span>` : ""}</div>
          <button class="x-btn" data-action="refresh-subs" aria-label="${t("Обновить подписку")}" title="${t("Обновить")}">${icon.refresh}</button></div>`).join("");
      return card(
        row(t("Обновлять подписки"), t("Список серверов подтягивается сам, пока клиент запущен"),
          select("sub-hours", "adv-number", String(a.subs_refresh_hours), [["0", t("Вручную")], ["1", t("Каждый час")], ["6", t("Каждые 6 часов")], ["12", t("Каждые 12 часов")], ["24", t("Раз в сутки")]], "subs_refresh_hours"), "sub-hours")
        + row("User-Agent", t("Некоторые панели отдают разный список для разных клиентов. Пусто - «ShredingerBox/версия»"),
          `<input id="sub-ua" class="field mono" data-change="adv-text" data-field="sub_user_agent" value="${esc(a.sub_user_agent)}" placeholder="ShredingerBox/${esc(APP_VERSION)}" />`, "sub-ua"),
      ) + (subs ? card(subs) : `<section class="card"><div class="empty">${t("Подписок пока нет")}</div></section>`);
    }
    default:
      return `<section class="card">
        <h2>${t("Ядро")}</h2>
        <div class="core on" style="cursor:default"><b>sing-box</b><span>${t("Встроенное ядро: VLESS (Reality, Vision, ws, grpc), Hysteria2, Trojan, Shadowsocks · TUN и правила")}</span></div>
      </section>` + card(
        row(t("Локальный порт прокси"), t("HTTP + SOCKS5 на одном порту"),
          `<input id="port" class="field mono" data-change="port" type="number" min="1024" max="65535" value="${a.mixed_port}" />`, "port")
        + row(t("Подключения из локальной сети"), t("Чтобы телефон или ТВ ходили через этот ПК"), sw(a.allow_lan, "toggle-lan", t("Подключения из локальной сети")))
        + row(t("Уровень логов"), t("Подробные логи пригодятся, когда что-то сломалось"),
          `<select id="log" class="field" data-change="log">${["error", "warn", "info", "debug"].map((l) => `<option ${l === a.log_level ? "selected" : ""}>${l}</option>`).join("")}</select>`, "log"),
      );
  }
}

function settingsView(): string {
  const s = st.settings!;
  const a = s.advanced;
  const g = s.general;
  const windows = st.status?.windows ?? true;
  const head = `<div class="page-head"><h1>${t("Настройки")}</h1>
    <div class="adv-toggle">${t("Продвинутый режим")}${sw(a.enabled, "toggle-advanced", t("Продвинутый режим"))}</div></div>`;
  const seg = (label: string, action: string, value: string, options: [string, string][]) =>
    `<div class="seg inset" role="group" aria-label="${esc(label)}">${options
      .map(([v, l]) => `<button class="${value === v ? "on" : ""}" aria-pressed="${value === v}" data-action="${action}" data-value="${v}">${l}</button>`).join("")}</div>`;
  const behaviour = `<section class="card" style="gap:0;padding:6px 16px">
      ${windows ? row(t("Запускать вместе с Windows"), t("Сразу с правами администратора - TUN без окна UAC"), sw(st.autostart, "toggle-autostart", t("Запускать вместе с Windows"), st.autostartBusy))
        + row(t("Подключаться при автозапуске"), t("Клиент стартует в трее и сразу включает VPN"), sw(g.autoconnect, "toggle-autoconnect", t("Подключаться при автозапуске"))) : ""}
      ${row(t("Проверять обновления"), t("Версия {v} · новые версии приходят с GitHub", { v: esc(APP_VERSION) + (st.status?.portable ? " · portable" : "") }),
        `<button class="btn-ghost" data-action="check-update-now" style="height:36px">${t("Проверить")}</button>${sw(g.check_updates, "toggle-updates", t("Проверять обновления"))}`)}
      ${row(t("Предлагать ключи из буфера обмена"), t("Скопировал ключ или подписку - открыл клиент - он предложит добавить"), sw(g.clipboard_offer, "toggle-clipboard", t("Предлагать ключи из буфера обмена")))}
      ${row(t("Язык"), t("«Как в системе» - по языку {os}", { os: windows ? "Windows" : "macOS" }),
        seg(t("Язык"), "set-language", g.language, [["system", t("Как в системе")], ["ru", "Русский"], ["en", "English"]]))}
      ${row(t("Тема"), t("«Как в системе» - светлая или тёмная вслед за {os}", { os: windows ? "Windows" : "macOS" }),
        seg(t("Тема"), "set-theme", g.theme, [["system", t("Как в системе")], ["dark", t("Тёмная")], ["light", t("Светлая")]]))}
      ${row(t("Сворачивать в трей при закрытии"), t("Крестик прячет окно, VPN продолжает работать"), sw(g.close_to_tray, "toggle-tray", t("Сворачивать в трей при закрытии")))}
    </section>`;
  const r = s.reminder;
  const exp = nearestExpire();
  const reminder = `<section class="card" style="gap:0;padding:6px 16px">
      ${row(t("Напоминание о продлении подписки"), t("Покажет окно, чтобы не забыть продлить VPN"), sw(r.enabled, "toggle-reminder", t("Напоминание о продлении подписки")))}
      ${r.enabled ? row(t("Когда напоминать"), r.mode === "expire"
          ? (exp ? t("Подписка действует до {date}", { date: dateText(exp) }) : t("Панель не сообщает срок подписки - напоминание сработает, когда он появится"))
          : t("Раз в месяц, в выбранный день"),
          seg(t("Когда напоминать"), "set-reminder-mode", r.mode, [["day", t("В день месяца")], ["expire", t("За 3 дня до конца")]])) : ""}
      ${r.enabled && r.mode === "day" ? row(t("С какого числа"), t("Окно появится в этот день или позже, если компьютер был выключен"),
          `<select id="rem-day" class="field" data-change="reminder-day">${Array.from({ length: 28 }, (_, i) => i + 1).map((d) => `<option value="${d}" ${d === r.day ? "selected" : ""}>${d}</option>`).join("")}</select>`, "rem-day") : ""}
      ${r.enabled ? ""
        + row(t("Текст напоминания"), t("Например, кому написать или где оплатить. Пусто - общий текст"),
          `<input id="rem-note" class="field" style="width:280px" data-change="reminder-note" value="${esc(r.note)}" placeholder="${t("Пора продлить подписку на VPN.")}" />`, "rem-note") : ""}
    </section>`;
  const system = `<section class="card" style="gap:0;padding:6px 16px">
      ${windows ? row(t("Права администратора"), t("Нужны для режима TUN"), st.status?.elevated
        ? `<span style="color:var(--accent-ink);font-size:13px;font-weight:600">${t("Есть")}</span>`
        : `<button class="btn-ghost" data-action="restart-admin">${t("Перезапустить с правами")}</button>`) : ""}
      ${row(t("Перенос настроек"), t("Серверы, подписки и правила в одном файле. В нём твои ключи - не выкладывай его"),
        `<div style="display:flex;gap:8px"><button class="btn-ghost" data-action="export-settings">${t("Экспорт")}</button><button class="btn-ghost" data-action="import-settings">${t("Импорт")}</button></div>`)}
      ${row(t("Папка данных"), t("Настройки, конфиг и кэш ядра"), `<button class="btn-ghost" data-action="open-data-dir">${t("Открыть")}</button>`)}
    </section>`;
  const basic = behaviour + reminder + system;
  if (!a.enabled) return `<div class="settings">${head}${basic}</div>`;
  const tab = (v: AdvTab, label: string) =>
    `<button role="tab" aria-selected="${st.advTab === v}" class="${st.advTab === v ? "on" : ""}" data-action="adv-tab" data-tab="${v}">${label}</button>`;
  return `<div class="settings">${head}
    <div class="seg inset" role="tablist" aria-label="${t("Разделы продвинутого режима")}" style="align-self:flex-start">
      ${tab("main", t("Основное"))}${tab("dns", "DNS")}${tab("tun", "TUN")}${tab("routing", t("Маршрутизация"))}${tab("subs", t("Подписки"))}
    </div>
    ${advancedTab()}
    <div class="actions">
      <button class="btn-ghost" data-action="show-config">${t("Открыть итоговый конфиг")}</button>
      <button class="btn-ghost" data-action="show-logs">${t("Открыть логи")}</button>
      <span style="flex-grow:1"></span>
      <button class="btn-ghost btn-danger" data-action="reset-advanced">${t("Сбросить к стандартным")}</button>
    </div>
    <div class="sep"></div>
    ${basic}
  </div>`;
}

// ---------- окна ----------

function modalView(): string {
  const m = st.modal;
  if (!m) return "";
  const head = (title: string) => `<div class="modal-head"><h1>${title}</h1><button class="x-btn" data-action="close-modal" aria-label="${t("Закрыть")}">${icon.x(16)}</button></div>`;
  const segTo = (action: string, current: string, a: string, b: string) => `<div class="seg inset" role="group" aria-label="${t("Куда добавить")}">
      <button class="${current === a ? "on" : ""}" data-action="${action}" data-list="${a}">${t("Через VPN")}</button>
      <button class="${current === b ? "on" : ""}" data-action="${action}" data-list="${b}">${t("Напрямую")}</button>
    </div>`;
  let body = "";
  if (m.kind === "add-server") {
    body = `<form class="modal" data-form="add-server">${head(t("Добавить сервер"))}
      <div class="modal-body">
        <label for="link" class="muted" style="font-size:13px">${t("Ключ (vless://, hy2://, trojan://, ss://) или ссылка на подписку. Можно несколько строк.")}</label>
        <textarea id="link" class="field mono" name="link" placeholder="vless://… ${t("или")} https://…/sub/…" autofocus></textarea>
        ${m.error ? `<div class="hint" style="color:var(--danger)">${esc(m.error)}</div>` : ""}
      </div>
      <div class="modal-foot"><span class="grow"></span><button class="btn-accent" type="submit" ${m.busy ? "disabled" : ""}>${m.busy ? t("Загружаю…") : t("Добавить")}</button></div>
    </form>`;
  } else if (m.kind === "add-app") {
    const existing = new Set(st.settings!.rules[m.list].map((a) => a.exe.toLowerCase()));
    const tabs = `<div class="seg inset" role="tablist" aria-label="${t("Способ добавления")}" style="align-self:flex-start">
        <button role="tab" aria-selected="${m.tab === "running"}" class="${m.tab === "running" ? "on" : ""}" data-action="app-tab" data-tab="running">${t("Запущенные")}</button>
        <button role="tab" aria-selected="${m.tab === "manual"}" class="${m.tab === "manual" ? "on" : ""}" data-action="app-tab" data-tab="manual">${t("Вписать вручную")}</button>
      </div>`;
    let content: string;
    if (m.tab === "manual") {
      content = `<label for="exe-list" class="muted" style="font-size:13px;line-height:1.5">${t("По одному на строку: {a}, просто {b} или полный путь к файлу. Можно вставить сразу целый список.", { a: `<span class="mono">Discord.exe</span>`, b: `<span class="mono">discord</span>` })}</label>
        <textarea id="exe-list" class="field mono" style="height:180px" data-input="exe-list" placeholder="Discord.exe&#10;Telegram.exe&#10;chrome" spellcheck="false">${esc(m.text)}</textarea>
        <div class="muted" style="font-size:12px" id="exe-stats">${statsText(manualStats(m))}</div>`;
    } else {
      const all = [...m.manual, ...m.procs.filter((p) => !m.manual.some((x) => x.exe === p.exe))];
      const rows = m.loading
        ? `<div class="empty">${t("Ищу запущенные программы…")}</div>`
        : all.length
          ? all.map((p, i) => {
              const added = existing.has(p.exe.toLowerCase());
              return `<label class="proc" for="p${i}"><div class="app-icon">${esc(p.name.charAt(0).toUpperCase())}</div>
                <span class="n">${esc(p.name)} <small>· ${esc(p.exe)}${added ? " · " + t("уже в списке") : ""}</small></span>
                <input id="p${i}" type="checkbox" data-change="pick" data-exe="${esc(p.exe)}" ${added || m.picked.has(p.exe) ? "checked" : ""} ${added ? "disabled" : ""} /></label>`;
            }).join("")
          : `<div class="empty">${t("Не нашлось программ с открытыми окнами. Выбери .exe или впиши вручную.")}</div>`;
      content = `<div style="display:flex;flex-direction:column;max-height:44vh;overflow:auto">${rows}</div>`;
    }
    const count = m.tab === "manual" ? manualStats(m).add.length : m.picked.size;
    body = `<div class="modal" role="dialog" aria-label="${t("Добавить приложение")}">${head(t("Добавить приложение"))}
      <div class="modal-body">${tabs}${content}</div>
      <div class="modal-foot">
        ${m.tab === "running" ? `<button class="btn-ghost" data-action="pick-exe">${t("Выбрать .exe…")}</button>` : ""}
        ${segTo("set-app-list", m.list, "proxy_apps", "direct_apps")}
        <span class="grow"></span>
        <button class="btn-accent" id="add-app-btn" data-action="confirm-add-app" ${count ? "" : "disabled"}>${addLabel(count)}</button>
      </div></div>`;
  } else if (m.kind === "add-sites") {
    const count = siteStats(m).add.length;
    body = `<div class="modal" role="dialog" aria-label="${t("Добавить сайты")}">${head(t("Добавить сайты"))}
      <div class="modal-body">
        <label for="site-list" class="muted" style="font-size:13px;line-height:1.5">${t("По одному на строку: {a}, ссылка целиком или {b}. Поддомены попадают в правило сами. Можно вставить сразу целый список.", { a: `<span class="mono">discord.com</span>`, b: `<span class="mono">*.example.com</span>` })}</label>
        <textarea id="site-list" class="field mono" style="height:180px" data-input="site-list" placeholder="discord.com&#10;https://www.youtube.com/&#10;*.example.com" spellcheck="false" autofocus>${esc(m.text)}</textarea>
        <div class="muted" style="font-size:12px" id="site-stats">${statsText(siteStats(m))}</div>
      </div>
      <div class="modal-foot">
        ${segTo("set-site-list", m.list, "proxy_domains", "direct_domains")}
        <span class="grow"></span>
        <button class="btn-accent" id="add-sites-btn" data-action="confirm-add-sites" ${count ? "" : "disabled"}>${addLabel(count)}</button>
      </div></div>`;
  } else if (m.kind === "list") {
    const total = st.settings!.rules[m.list].length;
    body = `<div class="modal" role="dialog" aria-label="${listTitle(m.list)}">${head(`${listTitle(m.list)} <span class="count">· ${total}</span>`)}
      <div class="modal-body">
        <label for="list-filter" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">${t("Поиск по списку")}</label>
        <input id="list-filter" class="field" data-input="list-filter" placeholder="${t("Поиск")}" value="${esc(m.filter)}" autocomplete="off" />
        <div id="full-list" style="display:flex;flex-direction:column;max-height:52vh;overflow:auto">${ruleRows(m.list, m.filter)}</div>
      </div></div>`;
  } else if (m.kind === "update") {
    const portable = !!st.status?.portable;
    const notes = parseItems(releaseNotes(m.notes));
    body = `<div class="modal" role="dialog" aria-label="${t("Доступно обновление")}">${head(t("Доступна версия {v}", { v: esc(m.version) }))}
      <div class="modal-body">
        <p class="muted" style="margin:0;font-size:13px">${t("Сейчас установлена {v}.", { v: esc(m.current) })} ${portable
          ? t("Это portable-версия: откроется страница загрузки - скачай zip и распакуй поверх папки с программой, папка data останется.")
          : t("Во время обновления VPN ненадолго отключится, потом клиент перезапустится сам.")}</p>
        ${notes.length ? `<b style="font-size:13px">${t("Что нового")}</b><ul class="news">${notes.map((n) => `<li>${inline(n, esc)}</li>`).join("")}</ul>` : ""}
        ${m.busy ? `<div style="height:6px;border-radius:3px;background:var(--chip);overflow:hidden"><div id="upd-bar" style="height:100%;width:${m.progress}%;background:var(--accent)"></div></div>` : ""}
        ${m.error ? `<div class="hint" style="color:var(--danger)">${esc(m.error)}</div>` : ""}
      </div>
      <div class="modal-foot"><button class="btn-ghost" data-action="snooze-update" ${m.busy ? "disabled" : ""}>${t("Позже")}</button><span class="grow"></span>
        <button class="btn-accent" data-action="install-update" ${m.busy ? "disabled" : ""}>${m.busy ? t("Обновляю…") : portable ? t("Скачать") : t("Обновить")}</button></div></div>`;
  } else if (m.kind === "whatsnew") {
    const sections = m.releases.map((r) => `<div style="display:flex;flex-direction:column;gap:6px">
        ${m.releases.length > 1 ? `<b style="font-size:13px">${t("Версия {v}", { v: esc(r.version) })}</b>` : ""}
        <ul class="news">${r.items.map((n) => `<li>${inline(n, esc)}</li>`).join("")}</ul></div>`).join("");
    body = `<div class="modal" role="dialog" aria-label="${t("Что нового")}">${head(t("Что нового в {v}", { v: esc(APP_VERSION) }))}
      <div class="modal-body" style="max-height:60vh">${sections}</div>
      <div class="modal-foot"><span class="grow"></span><button class="btn-accent" data-action="close-modal">${t("Понятно")}</button></div></div>`;
  } else if (m.kind === "services") {
    const rows = m.results.length
      ? m.results.map((r) => `<div class="app-row"><div class="app-icon" style="color:${r.ok ? "var(--accent-ink)" : "var(--danger)"}">${r.ok ? "✓" : "✕"}</div>
          <span class="n">${esc(r.name)}</span>
          <span class="ping" style="color:${r.ok ? "var(--accent-ink)" : "var(--danger)"}">${r.ok ? t("{n} мс", { n: r.ms ?? 0 }) : r.detail.startsWith("HTTP") ? t("недоступен") : esc(r.detail)}</span></div>`).join("")
      : `<div class="empty">${t("Проверяю…")}</div>`;
    body = `<div class="modal" role="dialog" aria-label="${t("Проверка сервисов")}">${head(t("Проверка сервисов"))}
      <div class="modal-body">
        <p class="muted" style="margin:0;font-size:13px;line-height:1.5">${m.viaVpn
          ? t("Через текущее подключение и твои правила - так же, как откроет браузер.")
          : t("VPN выключен - проверка идёт напрямую. Подключись, чтобы проверить через VPN.")}</p>
        <div style="display:flex;flex-direction:column">${rows}</div>
      </div>
      <div class="modal-foot"><span class="grow"></span>
        <button class="btn-accent" data-action="check-services" ${m.busy ? "disabled" : ""}>${m.busy ? t("Проверяю…") : t("Проверить снова")}</button></div></div>`;
  } else if (m.kind === "clipboard") {
    body = `<div class="modal" role="dialog" aria-label="${t("Добавить из буфера обмена")}">${head(t("Добавить из буфера обмена?"))}
      <div class="modal-body">
        <div style="line-height:1.55">${t("В буфере обмена есть {what}", { what: clipboardSummary(m.text) })}</div>
        ${m.error ? `<div class="hint" style="color:var(--danger)">${esc(m.error)}</div>` : ""}
      </div>
      <div class="modal-foot"><button class="btn-ghost" data-action="dismiss-clipboard">${t("Не сейчас")}</button><span class="grow"></span>
        <button class="btn-accent" data-action="accept-clipboard" ${m.busy ? "disabled" : ""}>${m.busy ? t("Добавляю…") : t("Добавить")}</button></div></div>`;
  } else if (m.kind === "reminder") {
    const r = st.settings!.reminder;
    const exp = nearestExpire();
    const generic = r.mode === "expire" && exp
      ? t("Подписка закончится {date}. Пора продлить.", { date: dateText(exp) })
      : t("Пора продлить подписку на VPN.");
    const note = r.note.trim() || generic;
    body = `<div class="modal" role="dialog" aria-label="${t("Пора продлить подписку")}">${head(t("Пора продлить подписку"))}
      <div class="modal-body" style="flex-direction:row;align-items:center;gap:16px">
        <div style="flex-shrink:0">${mascot(72, mood())}</div>
        <p style="margin:0;line-height:1.55">${esc(note)}</p>
      </div>
      <div class="modal-foot"><button class="btn-ghost" data-action="reminder-disable">${t("Больше не напоминать")}</button><span class="grow"></span>
        <button class="btn-accent" data-action="close-modal">${t("Понятно")}</button></div></div>`;
  } else if (m.kind === "admin") {
    body = `<div class="modal" role="dialog" aria-label="${t("Нужны права администратора")}">${head(t("Нужны права администратора"))}
      <div class="modal-body"><p style="margin:0;line-height:1.55">${t("Режим TUN перехватывает весь трафик системы, поэтому Windows требует права администратора. ShredingerBox перезапустится и сразу подключится.")}</p>
      <p class="muted" style="margin:0;font-size:13px">${t("Или переключись на режим «Прокси» - ему права не нужны.")}</p></div>
      <div class="modal-foot"><button class="btn-ghost" data-action="use-proxy-mode">${t("Включить «Прокси»")}</button><span class="grow"></span>
        <button class="btn-accent" data-action="restart-admin">${t("Перезапустить")}</button></div></div>`;
  } else if (m.kind === "text") {
    body = `<div class="modal wide" role="dialog" aria-label="${esc(m.title)}">${head(esc(m.title))}
      <div class="modal-body"><pre class="code" id="text-pre">${esc(m.text || t("Пусто"))}</pre></div></div>`;
  }
  return `<div class="overlay" data-action="overlay">${body}</div>`;
}

const lightQuery = window.matchMedia("(prefers-color-scheme: light)");
lightQuery.addEventListener("change", () => applyTheme());

/** Тема из настроек; «как в системе» - по светлой или тёмной теме Windows / macOS. */
function applyTheme() {
  const th = st.settings?.general.theme ?? "system";
  document.documentElement.dataset.theme = th === "system" ? (lightQuery.matches ? "light" : "dark") : th;
}

function render() {
  applyTheme();
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

/** Выводит окно на передний план с напоминанием: раз в месяц с выбранного числа или за 3 дня
 *  до конца подписки (по сроку от панели) - один раз на каждый срок. */
async function checkReminder() {
  const s = st.settings;
  if (!s || !s.reminder.enabled || st.modal) return;
  const now = new Date();
  let mark: string;
  if (s.reminder.mode === "expire") {
    const exp = nearestExpire();
    if (!exp || Date.now() < (exp - 3 * 86400) * 1000) return;
    mark = `exp-${exp}`;
  } else {
    if (now.getDate() < (s.reminder.day || 20)) return;
    mark = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  }
  if (s.reminder.last_shown === mark) return;
  st.modal = { kind: "reminder" };
  await saveSettings((x) => { x.reminder.last_shown = mark; });
  const win = getCurrentWindow();
  try { await win.unminimize(); await win.show(); await win.setFocus(); } catch { /* окно и так на экране */ }
}

// ---------- обработчики ----------

const applied = () => t("Настройки применены");
const rulesApplied = () => t("Правила применены");

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
      return saveSettings((x) => { x.mode = mode; }, t("Режим переключён"));
    }
    case "select-server": {
      const id = el.dataset.id!;
      const auto = id === "auto";
      if (auto ? s.auto_server : !s.auto_server && id === s.selected) return;
      st.settings = auto ? { ...s, auto_server: true } : { ...s, auto_server: false, selected: id };
      if (!auto) st.autoNow = null;
      render();
      try {
        st.status = await invoke<Status>("select_server", { id });
        if (st.status.running) { toast(auto ? t("Включён «Авто»: лучший сервер выбирает ядро") : t("Сервер переключён")); pingAll(); }
      } catch (e) { toast(errText(e), true); await refreshStatus(); }
      return render();
    }
    case "remove-server": {
      ev.stopPropagation();
      try { st.settings = await invoke<Settings>("remove_server", { id: el.dataset.id }); } catch (e) { toast(errText(e), true); }
      return render();
    }
    case "ping": return pingAll();
    case "check-services": return checkServices();
    case "open-add-server": st.modal = { kind: "add-server", busy: false, error: "" }; return render();
    case "refresh-subs": {
      try { st.settings = await invoke<Settings>("refresh_subscriptions"); toast(t("Подписка обновлена")); } catch (e) { toast(errText(e), true); }
      return render();
    }
    case "set-final": return saveSettings((x) => { x.rules.final_route = el.dataset.value as FinalRoute; }, rulesApplied());
    case "remove-app": {
      const list = el.dataset.list as AppList;
      return saveSettings((x) => { x.rules[list] = x.rules[list].filter((a) => a.exe !== el.dataset.exe); }, rulesApplied());
    }
    case "remove-domain": {
      const list = el.dataset.list as SiteList;
      return saveSettings((x) => { x.rules[list] = x.rules[list].filter((d) => d !== el.dataset.domain); }, rulesApplied());
    }
    case "site-tab": st.siteTab = el.dataset.list as SiteList; return render();
    case "show-list": st.modal = { kind: "list", list: el.dataset.list as AppList | SiteList, filter: "" }; render(); document.getElementById("list-filter")?.focus(); return;
    case "open-add-sites": st.modal = { kind: "add-sites", list: st.siteTab, text: "" }; render(); document.getElementById("site-list")?.focus(); return;
    case "set-site-list": if (st.modal?.kind === "add-sites") { st.modal.list = el.dataset.list as SiteList; render(); } return;
    case "confirm-add-sites": {
      const m = st.modal;
      if (m?.kind !== "add-sites") return;
      const { add, dup } = siteStats(m);
      if (!add.length) return toast(t("Нечего добавлять: всё уже есть в списке"), true);
      const other: SiteList = m.list === "proxy_domains" ? "direct_domains" : "proxy_domains";
      st.modal = null;
      st.siteTab = m.list;
      await saveSettings((x) => {
        // сайт не может быть одновременно в обоих списках
        x.rules[other] = x.rules[other].filter((d) => !add.includes(d));
        x.rules[m.list].push(...add);
      }, rulesApplied());
      if (dup) toast(t("Добавлено: {n}, дубликатов пропущено: {d}", { n: add.length, d: dup }));
      return;
    }
    case "toggle-preset": {
      const id = el.dataset.id!;
      return saveSettings((x) => {
        x.rules.presets = x.rules.presets.includes(id) ? x.rules.presets.filter((p) => p !== id) : [...x.rules.presets, id];
      }, rulesApplied());
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
      const file = await open({ multiple: false, filters: [{ name: t("Программы"), extensions: ["exe"] }] });
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
      if (!add.length) return toast(t("Нечего добавлять: всё уже есть в списке"), true);
      const other: AppList = m.list === "proxy_apps" ? "direct_apps" : "proxy_apps";
      st.modal = null;
      await saveSettings((x) => {
        for (const p of add) {
          // приложение не может быть одновременно в обоих списках
          x.rules[other] = x.rules[other].filter((a) => a.exe.toLowerCase() !== p.exe.toLowerCase());
          if (!x.rules[m.list].some((a) => a.exe.toLowerCase() === p.exe.toLowerCase())) x.rules[m.list].push({ name: p.name, exe: p.exe });
        }
      }, rulesApplied());
      if (skipped) toast(t("Добавлено: {n}, дубликатов пропущено: {d}", { n: add.length, d: skipped }));
      return;
    }
    case "toggle-advanced": return saveSettings((x) => { x.advanced.enabled = !x.advanced.enabled; });
    case "adv-tab": st.advTab = el.dataset.tab as AdvTab; return render();
    case "adv-toggle": {
      const field = el.dataset.field as keyof Advanced;
      return saveSettings((x) => { (x.advanced as unknown as Record<string, boolean>)[field] = !x.advanced[field]; }, applied());
    }
    case "toggle-lan": return saveSettings((x) => { x.advanced.allow_lan = !x.advanced.allow_lan; }, applied());
    case "reset-advanced": return saveSettings((x) => { x.advanced = structuredClone(st.defaults!); }, t("Настройки сброшены"));
    case "show-config": {
      try {
        const text = await invoke<string>("preview_config");
        st.modal = { kind: "text", title: t("Итоговый конфиг sing-box"), text, live: false };
      } catch (e) { toast(errText(e), true); }
      return render();
    }
    case "show-logs": {
      st.logs = await invoke<string[]>("get_logs");
      st.modal = { kind: "text", title: t("Логи ядра"), text: st.logs.join("\n"), live: true };
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
        toast(st.autostart ? t("Автозапуск включён") : t("Автозапуск выключен"));
      } catch (e) { toast(errText(e), true); }
      st.autostartBusy = false;
      return render();
    }
    case "toggle-autoconnect": return saveSettings((x) => { x.general.autoconnect = !x.general.autoconnect; });
    case "toggle-tray": return saveSettings((x) => { x.general.close_to_tray = !x.general.close_to_tray; });
    case "set-theme": return saveSettings((x) => { x.general.theme = el.dataset.value as Theme; });
    case "set-language": {
      // Язык меняем сразу, а сохраняем следом - не ждём ответа Rust.
      st.settings = { ...s, general: { ...s.general, language: el.dataset.value as LangSetting } };
      applyLanguage();
      return saveSettings(() => {});
    }
    case "export-settings": {
      const path = await save({ defaultPath: "shredingerbox-settings.json", filters: [{ name: "JSON", extensions: ["json"] }] });
      if (!path) return;
      try { await invoke("export_settings", { path }); toast(t("Настройки сохранены. В файле есть твои ключи - не выкладывай его")); } catch (e) { toast(errText(e), true); }
      return;
    }
    case "import-settings": {
      const path = await open({ multiple: false, filters: [{ name: "JSON", extensions: ["json"] }] });
      if (typeof path !== "string") return;
      try {
        st.settings = await invoke<Settings>("import_settings", { path });
        applyLanguage();
        await refreshStatus();
        toast(t("Настройки загружены"));
        pingAll();
      } catch (e) { toast(errText(e), true); }
      return render();
    }
    case "remove-sub": {
      try { st.settings = await invoke<Settings>("remove_subscription", { url: el.dataset.url }); toast(t("Подписка удалена")); } catch (e) { toast(errText(e), true); }
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
        if (st.status?.portable) { st.modal = null; render(); toast(t("Скачай zip и распакуй поверх папки с программой")); }
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
        toast(t("Добавлено - можно подключаться"));
        pingAll();
      } catch (e) {
        if (st.modal?.kind === "clipboard") { st.modal.busy = false; st.modal.error = errText(e); }
      }
      return render();
    }
    case "toggle-reminder": return saveSettings((x) => { x.reminder.enabled = !x.reminder.enabled; });
    case "set-reminder-mode": return saveSettings((x) => { x.reminder.mode = el.dataset.value as "day" | "expire"; x.reminder.last_shown = null; });
    case "reminder-disable":
      st.modal = null;
      await saveSettings((x) => { x.reminder.enabled = false; });
      return toast(t("Напоминание выключено - включить можно в настройках"));
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

/** Обновить счётчик и кнопку «Добавить» в окне добавления, не перерисовывая поле ввода. */
function updateAddButton(statsId: string, btnId: string, stats: { add: string[]; dup: number }) {
  const info = document.getElementById(statsId);
  const btn = document.getElementById(btnId) as HTMLButtonElement | null;
  if (info) info.textContent = statsText(stats);
  if (btn) {
    btn.disabled = stats.add.length === 0;
    btn.textContent = addLabel(stats.add.length);
  }
}

document.addEventListener("input", (ev) => {
  const el = ev.target as HTMLTextAreaElement;
  if (el.dataset.input === "list-filter" && st.modal?.kind === "list") {
    // Перерисовываем только список, чтобы не сбить курсор в поле поиска.
    st.modal.filter = el.value;
    const box = document.getElementById("full-list");
    if (box) box.innerHTML = ruleRows(st.modal.list, st.modal.filter);
    return;
  }
  if (el.dataset.input === "site-list" && st.modal?.kind === "add-sites") {
    st.modal.text = el.value;
    return updateAddButton("site-stats", "add-sites-btn", siteStats(st.modal));
  }
  if (el.dataset.input !== "exe-list" || st.modal?.kind !== "add-app") return;
  st.modal.text = el.value;
  updateAddButton("exe-stats", "add-app-btn", manualStats(st.modal));
});

document.addEventListener("change", async (ev) => {
  const el = ev.target as HTMLInputElement;
  const kind = el.dataset.change;
  if (!kind) return;
  const field = el.dataset.field as keyof Advanced;
  const setAdv = (value: unknown) => saveSettings((x) => { (x.advanced as unknown as Record<string, unknown>)[field] = value; }, applied());
  switch (kind) {
    case "pick": {
      if (st.modal?.kind !== "add-app") return;
      const exe = el.dataset.exe!;
      el.checked ? st.modal.picked.add(exe) : st.modal.picked.delete(exe);
      return render();
    }
    case "port": {
      const port = Number(el.value);
      if (port >= 1024 && port <= 65535) saveSettings((x) => { x.advanced.mixed_port = port; }, applied());
      else toast(t("Порт должен быть от 1024 до 65535"), true);
      return;
    }
    case "log": return saveSettings((x) => { x.advanced.log_level = el.value; }, applied());
    case "adv-dns-type": return saveSettings((x) => { x.advanced.remote_dns_type = el.value; }, applied());
    case "adv-text": return setAdv(el.value.trim());
    case "adv-select": return setAdv(el.value);
    case "adv-number": {
      const n = Number(el.value);
      if (!Number.isFinite(n) || n < 0) return toast(t("Нужно число"), true);
      return setAdv(Math.round(n));
    }
    case "adv-list": return setAdv(el.value.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean));
    case "reminder-day": return saveSettings((x) => { x.reminder.day = Number(el.value) || 20; x.reminder.last_shown = null; });
    case "reminder-note": return saveSettings((x) => { x.reminder.note = el.value.trim(); });
    case "sub-name": {
      try { st.settings = await invoke<Settings>("rename_subscription", { url: el.dataset.url, name: el.value }); } catch (e) { toast(errText(e), true); }
      return render();
    }
  }
});

document.addEventListener("submit", async (ev) => {
  const form = ev.target as HTMLFormElement;
  ev.preventDefault();
  if (form.dataset.form === "add-server" && st.modal?.kind === "add-server") {
    const text = (form.elements.namedItem("link") as HTMLTextAreaElement).value;
    st.modal.busy = true; st.modal.error = "";
    render();
    try {
      st.settings = await invoke<Settings>("add_from_text", { text });
      st.modal = null;
      toast(t("Сервер добавлен"));
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
  const full: { settings: Settings; status: Status; presets: Preset[]; defaults: Advanced } = await invoke("get_state");
  st.settings = full.settings;
  st.status = full.status;
  st.presets = full.presets;
  st.defaults = full.defaults;
  applyLanguage();
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
    // Частая ошибка Windows при быстром перезапуске TUN - просто пробуем ещё раз.
    if (/configure tun interface/i.test(last) && tunRetries < 2 && Date.now() - st.connectedAt < 60000) {
      tunRetries++;
      st.busy = true;
      render();
      setTimeout(() => { st.busy = false; toggleConnect(); }, 2000);
      return;
    }
    toast(t("Ядро остановилось") + (last ? ": " + last : ""), true);
  });

  setInterval(() => {
    const el = document.getElementById("timer");
    if (el && st.status?.running) el.textContent = `· ${elapsed()}`;
  }, 1000);
  await refreshUsage();
  render();
  setInterval(() => { if (st.status?.running) refreshUsage(); }, 5000);

  checkReminder();
  setInterval(checkReminder, 30 * 60 * 1000);
  autoUpdateSubs(true);
  setInterval(() => autoUpdateSubs(), 15 * 60 * 1000);
  if (full.settings.servers.length) pingAll();
  st.autostart = await invoke<boolean>("get_autostart").catch(() => false);
  syncIndicators();
  render();
  await showWhatsNew();
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
  root.innerHTML = `<div style="padding:32px">${t("Не удалось запустить интерфейс")}: ${esc(errText(e))}</div>`;
});

