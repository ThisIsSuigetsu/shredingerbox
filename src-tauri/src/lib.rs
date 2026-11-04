mod config;
mod core;
mod i18n;
mod links;
mod presets;
mod settings;
mod system;
mod traffic;

use serde::Serialize;
use i18n::tr;
use settings::{Mode, Server, Settings, Subscription};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent, Wry};

/// Как запустили клиент: из автозапуска Windows и/или с просьбой сразу подключиться.
#[derive(Clone, Serialize)]
pub struct Launch {
    autostart: bool,
    autoconnect: bool,
}

pub struct AppState {
    pub settings: Mutex<Settings>,
    pub core: core::Core,
    pub data_dir: PathBuf,
    pub launch: Launch,
    /// Найденное, но ещё не установленное обновление.
    pub update: Mutex<Option<tauri_plugin_updater::Update>>,
    /// Расход трафика по серверам за каждый месяц.
    pub traffic: traffic::Traffic,
    /// Portable-версия: данные рядом с программой, обновление - скачать новый zip.
    pub portable: bool,
}

const RELEASES_URL: &str = "https://github.com/ThisIsSuigetsu/shredingerbox/releases/latest";

/// Рядом с exe лежит portable.txt - значит, это portable-версия, и все данные
/// хранятся в папке data рядом с программой, а не в %APPDATA%.
fn portable_data_dir() -> Option<PathBuf> {
    let dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    dir.join("portable.txt").exists().then(|| dir.join("data"))
}

#[derive(Serialize)]
struct MonthTraffic {
    /// «2026-11»
    month: String,
    /// id сервера → сколько прошло за месяц.
    servers: std::collections::HashMap<String, traffic::Usage>,
}

#[derive(Serialize)]
struct UpdateInfo {
    version: String,
    current: String,
    notes: Option<String>,
}

/// Пункты меню трея: их текст меняется при подключении и смене языка.
struct TrayItems {
    show: MenuItem<Wry>,
    toggle: MenuItem<Wry>,
    quit: MenuItem<Wry>,
}

/// Секунды Unix - когда обновили подписку.
fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

const PENDING_CONNECT: &str = "pending-connect";


impl AppState {
    fn snapshot(&self) -> Settings {
        self.settings.lock().unwrap().clone()
    }

    fn store(&self, s: Settings) -> Result<(), String> {
        s.save(&self.data_dir.join("settings.json"))?;
        *self.settings.lock().unwrap() = s;
        Ok(())
    }

    fn status(&self) -> Status {
        let s = self.settings.lock().unwrap();
        Status {
            running: self.core.is_running(),
            mode: self.core.running_mode().unwrap_or(s.mode),
            server: s.selected_server().map(|srv| srv.id.clone()),
            api_port: self.core.api_port,
            secret: self.core.secret.clone(),
            elevated: system::is_elevated(),
            windows: cfg!(windows),
            tun: settings::TUN_AVAILABLE,
            portable: self.portable,
        }
    }
}

#[derive(Serialize)]
struct Status {
    running: bool,
    mode: Mode,
    server: Option<String>,
    api_port: u16,
    secret: String,
    elevated: bool,
    /// Права администратора и автозапуск пока есть только в Windows.
    windows: bool,
    /// Можно ли включить TUN (Windows, macOS).
    tun: bool,
    portable: bool,
}

#[derive(Serialize)]
struct FullState {
    settings: Settings,
    status: Status,
    presets: Vec<presets::Preset>,
    /// Стандартные значения продвинутого режима - для кнопки «Сбросить».
    defaults: settings::Advanced,
}

#[derive(Serialize)]
struct ServiceCheck {
    name: &'static str,
    ok: bool,
    ms: Option<u64>,
    /// HTTP-код ответа или текст ошибки соединения.
    detail: String,
}

/// Сервисы для проверки «открывается ли через текущее подключение».
/// Для API ChatGPT и Claude ответ 401 значит «доступно», 403 - «недоступно в этой стране».
const SERVICES: &[(&str, &str)] = &[
    ("YouTube", "https://www.youtube.com/generate_204"),
    ("Discord", "https://discord.com/api/v9/gateway"),
    ("ChatGPT", "https://api.openai.com/v1/models"),
    ("Claude", "https://api.anthropic.com/v1/models"),
    ("Instagram", "https://www.instagram.com/"),
    ("X / Twitter", "https://x.com/"),
    ("Spotify", "https://open.spotify.com/"),
    ("Telegram", "https://web.telegram.org/"),
];

#[derive(Serialize)]
struct Ping {
    id: String,
    ms: Option<u64>,
    /// UDP-протокол (Hysteria2) - TCP-пинг не меряется.
    udp: bool,
    /// Задержка измерена через само ядро (реальный запрос через VPN).
    via_vpn: bool,
}

fn api_client() -> Option<reqwest::Client> {
    reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(8))
        .build()
        .ok()
}

/// Реальная задержка через конкретный сервер: ядро делает запрос к generate_204.
async fn url_test(api_port: u16, secret: &str, tag: &str) -> Option<u64> {
    let url = format!(
        "http://127.0.0.1:{api_port}/proxies/{tag}/delay?url=https%3A%2F%2Fwww.gstatic.com%2Fgenerate_204&timeout=5000"
    );
    let text = api_client()?.get(url).bearer_auth(secret).send().await.ok()?.text().await.ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value["delay"].as_u64()
}

/// Переключить сервер в работающем ядре без перезапуска.
async fn clash_select(api_port: u16, secret: &str, tag: &str) -> bool {
    let Some(client) = api_client() else { return false };
    client
        .put(format!("http://127.0.0.1:{api_port}/proxies/proxy"))
        .bearer_auth(secret)
        .header("Content-Type", "application/json")
        .body(serde_json::json!({ "name": tag }).to_string())
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn new_id() -> String {
    use rand::Rng;
    format!("{:08x}", rand::thread_rng().gen::<u32>())
}

async fn restart_if_running(app: &AppHandle, state: &AppState) -> Result<(), String> {
    if state.core.is_running() {
        let s = state.snapshot();
        state.core.start(app, &s, &state.data_dir).await?;
    }
    Ok(())
}

async fn fetch_subscription(url: &str, user_agent: &str) -> Result<Vec<String>, String> {
    let ua = if user_agent.trim().is_empty() {
        format!("ShredingerBox/{}", env!("CARGO_PKG_VERSION"))
    } else {
        user_agent.trim().to_string()
    };
    let client = reqwest::Client::builder()
        .user_agent(ua)
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let body = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("{}: {e}", tr("Подписка не загрузилась", "Subscription failed to load")))?
        .error_for_status()
        .map_err(|e| format!("{}: {e}", tr("Сервер подписки ответил ошибкой", "Subscription server returned an error")))?
        .text()
        .await
        .map_err(|e| e.to_string())?;
    let links = links::parse_subscription_body(&body);
    if links.is_empty() {
        return Err(tr(
            "В подписке не нашлось ни одного поддерживаемого сервера",
            "The subscription has no supported servers",
        )
        .into());
    }
    Ok(links)
}

/// Заменить серверы одной подписки свежим списком.
/// Сервер с тем же ключом сохраняет id - на нём держится счётчик трафика за месяц.
fn merge_subscription(s: &mut Settings, url: &str, links_list: Vec<String>) {
    let old_selected_link = s.selected_server().map(|srv| srv.link.clone());
    let mut old_ids: std::collections::HashMap<String, String> = s
        .servers
        .iter()
        .filter(|srv| srv.subscription.as_deref() == Some(url))
        .map(|srv| (srv.link.clone(), srv.id.clone()))
        .collect();
    s.servers.retain(|srv| srv.subscription.as_deref() != Some(url));
    for link in links_list {
        if let Ok(p) = links::parse(&link) {
            s.servers.push(Server {
                id: old_ids.remove(&link).unwrap_or_else(new_id),
                name: p.name,
                link,
                subscription: Some(url.to_string()),
            });
        }
    }
    if let Some(link) = old_selected_link {
        if let Some(srv) = s.servers.iter().find(|srv| srv.link == link) {
            s.selected = Some(srv.id.clone());
        }
    }
    if s.selected_server().is_some() && s.selected.is_none() {
        s.selected = s.servers.first().map(|srv| srv.id.clone());
    }
}

// ---------- команды для интерфейса ----------

#[tauri::command]
fn get_state(state: State<AppState>) -> FullState {
    FullState {
        settings: state.snapshot(),
        status: state.status(),
        presets: presets::PRESETS.to_vec(),
        defaults: settings::Advanced { enabled: true, ..Default::default() },
    }
}

/// Язык интерфейса: Rust переводит ошибки и меню трея.
#[tauri::command]
fn set_language(app: AppHandle, english: bool) {
    i18n::set_english(english);
    update_indicators(&app);
}

/// Сохранить все настройки (серверы, подписки, правила) в файл.
#[tauri::command]
fn export_settings(state: State<AppState>, path: String) -> Result<(), String> {
    let mut s = state.snapshot();
    s.seen_version = None;
    let json = serde_json::to_string_pretty(&s).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| format!("{}: {e}", tr("Не удалось сохранить файл", "Could not save the file")))
}

/// Загрузить настройки из файла экспорта и сразу применить их.
#[tauri::command]
async fn import_settings(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<Settings, String> {
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("{}: {e}", tr("Не удалось прочитать файл", "Could not read the file")))?;
    let value: serde_json::Value = serde_json::from_str(&text)
        .map_err(|_| tr("Это не файл настроек ShredingerBox", "This is not a ShredingerBox settings file").to_string())?;
    if value.get("servers").is_none() || value.get("rules").is_none() {
        return Err(tr("Это не файл настроек ShredingerBox", "This is not a ShredingerBox settings file").into());
    }
    let mut s: Settings = serde_json::from_value(value)
        .map_err(|e| format!("{}: {e}", tr("Файл настроек повреждён", "The settings file is damaged")))?;
    s.seen_version = state.snapshot().seen_version;
    if !settings::TUN_AVAILABLE {
        s.mode = Mode::Proxy;
    }
    state.store(s.clone())?;
    let restarted = restart_if_running(&app, &state).await;
    update_indicators(&app);
    restarted?;
    Ok(s)
}

/// Открываются ли популярные сервисы. Пока VPN включён - через локальный прокси ядра,
/// то есть по тем же правилам, что и браузер; без VPN - напрямую.
#[tauri::command]
async fn check_services(state: State<'_, AppState>) -> Result<Vec<ServiceCheck>, String> {
    let port = state.snapshot().advanced.mixed_port;
    let mut builder = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (ShredingerBox)")
        .timeout(Duration::from_secs(8));
    builder = if state.core.is_running() {
        builder.proxy(reqwest::Proxy::all(format!("http://127.0.0.1:{port}")).map_err(|e| e.to_string())?)
    } else {
        builder.no_proxy()
    };
    let client = builder.build().map_err(|e| e.to_string())?;
    let mut tasks = vec![];
    for &(name, url) in SERVICES {
        let client = client.clone();
        tasks.push(tauri::async_runtime::spawn(async move {
            let started = Instant::now();
            match client.get(url).send().await {
                Ok(r) => {
                    let code = r.status().as_u16();
                    ServiceCheck {
                        name,
                        ok: code < 500 && code != 403 && code != 451,
                        ms: Some(started.elapsed().as_millis() as u64),
                        detail: format!("HTTP {code}"),
                    }
                }
                Err(e) => ServiceCheck {
                    name,
                    ok: false,
                    ms: None,
                    detail: if e.is_timeout() {
                        tr("нет ответа", "no response").to_string()
                    } else {
                        tr("не открывается", "can't connect").to_string()
                    },
                },
            }
        }));
    }
    let mut out = vec![];
    for t in tasks {
        if let Ok(c) = t.await {
            out.push(c);
        }
    }
    Ok(out)
}

#[tauri::command]
async fn save_settings(app: AppHandle, state: State<'_, AppState>, settings: Settings) -> Result<Status, String> {
    state.store(settings)?;
    // Перезапуск сначала гасит ядро - если он не удался, VPN уже выключен.
    let restarted = restart_if_running(&app, &state).await;
    update_indicators(&app);
    restarted?;
    Ok(state.status())
}

#[tauri::command]
async fn add_from_text(app: AppHandle, state: State<'_, AppState>, text: String) -> Result<Settings, String> {
    let text = text.trim().to_string();
    let mut s = state.snapshot();
    if text.starts_with("http://") || text.starts_with("https://") {
        let list = fetch_subscription(&text, &s.advanced.sub_user_agent).await?;
        match s.subscriptions.iter_mut().find(|sub| sub.url == text) {
            Some(sub) => sub.updated = Some(now_secs()),
            None => s.subscriptions.push(Subscription {
                url: text.clone(),
                name: tr("Подписка", "Subscription").into(),
                updated: Some(now_secs()),
            }),
        }
        merge_subscription(&mut s, &text, list);
    } else {
        let mut added = 0;
        let mut first_err = None;
        for line in text.lines().map(str::trim).filter(|l| !l.is_empty()) {
            match links::parse(line) {
                Ok(p) => {
                    let id = new_id();
                    if s.selected.is_none() {
                        s.selected = Some(id.clone());
                    }
                    s.servers.push(Server { id, name: p.name, link: line.to_string(), subscription: None });
                    added += 1;
                }
                Err(e) => {
                    first_err.get_or_insert(e);
                }
            }
        }
        if added == 0 {
            return Err(first_err.unwrap_or_else(|| tr("Вставь ключ или ссылку на подписку", "Paste a key or a subscription link").into()));
        }
    }
    if s.selected.is_none() {
        s.selected = s.servers.first().map(|srv| srv.id.clone());
    }
    state.store(s.clone())?;
    let _ = app;
    Ok(s)
}

#[tauri::command]
async fn refresh_subscriptions(state: State<'_, AppState>) -> Result<Settings, String> {
    let mut s = state.snapshot();
    let urls: Vec<String> = s.subscriptions.iter().map(|sub| sub.url.clone()).collect();
    for url in urls {
        let list = fetch_subscription(&url, &s.advanced.sub_user_agent).await?;
        merge_subscription(&mut s, &url, list);
        if let Some(sub) = s.subscriptions.iter_mut().find(|sub| sub.url == url) {
            sub.updated = Some(now_secs());
        }
    }
    state.store(s.clone())?;
    Ok(s)
}

#[tauri::command]
fn remove_server(state: State<AppState>, id: String) -> Result<Settings, String> {
    let mut s = state.snapshot();
    s.servers.retain(|srv| srv.id != id);
    if s.selected.as_deref() == Some(id.as_str()) {
        s.selected = s.servers.first().map(|srv| srv.id.clone());
    }
    state.store(s.clone())?;
    Ok(s)
}

#[tauri::command]
async fn connect(app: AppHandle, state: State<'_, AppState>) -> Result<Status, String> {
    let s = state.snapshot();
    let started = state.core.start(&app, &s, &state.data_dir).await;
    update_indicators(&app);
    started?;
    Ok(state.status())
}

#[tauri::command]
fn disconnect(app: AppHandle, state: State<AppState>) -> Status {
    state.core.stop();
    update_indicators(&app);
    state.status()
}

#[tauri::command]
fn get_status(state: State<AppState>) -> Status {
    state.status()
}

#[tauri::command]
fn get_traffic(state: State<AppState>) -> MonthTraffic {
    let month = traffic::current_month();
    MonthTraffic { servers: state.traffic.month(&month), month }
}

/// Пинг серверов. Пока VPN включён, каждый сервер проверяется реальным запросом
/// через ядро (Hysteria2 тоже); без VPN - TCP-подключением (у Hysteria2 это UDP - не меряем).
#[tauri::command]
async fn ping_servers(state: State<'_, AppState>) -> Result<Vec<Ping>, String> {
    let snapshot = state.snapshot();
    let running = state.core.is_running();
    let api_port = state.core.api_port;
    let secret = state.core.secret.clone();
    let mut tasks = vec![];
    for srv in snapshot.servers {
        let secret = secret.clone();
        tasks.push(tauri::async_runtime::spawn(async move {
            if running {
                let ms = url_test(api_port, &secret, &core::server_tag(&srv.id)).await;
                return Ping { id: srv.id, ms, udp: false, via_vpn: true };
            }
            let mut udp = false;
            let ms = match links::parse(&srv.link) {
                Ok(p) if !p.udp_only => {
                    let started = Instant::now();
                    match tokio::time::timeout(
                        Duration::from_secs(3),
                        tokio::net::TcpStream::connect((p.host.as_str(), p.port)),
                    )
                    .await
                    {
                        Ok(Ok(_)) => Some(started.elapsed().as_millis() as u64),
                        _ => None,
                    }
                }
                Ok(_) => {
                    udp = true;
                    None
                }
                Err(_) => None,
            };
            Ping { id: srv.id, ms, udp, via_vpn: false }
        }));
    }
    let mut result = vec![];
    for t in tasks {
        if let Ok(p) = t.await {
            result.push(p);
        }
    }
    Ok(result)
}

/// Выбрать сервер. Если VPN включён - переключаем прямо в ядре, без перезапуска и пересоздания TUN.
#[tauri::command]
async fn select_server(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<Status, String> {
    let mut s = state.snapshot();
    if !s.servers.iter().any(|srv| srv.id == id) {
        return Err(tr("Сервер не найден", "Server not found").into());
    }
    s.selected = Some(id.clone());
    state.store(s)?;
    if state.core.is_running()
        && !clash_select(state.core.api_port, &state.core.secret, &core::server_tag(&id)).await
    {
        // Сервера нет в запущенном конфиге (добавлен после подключения) - перезапускаем.
        let restarted = restart_if_running(&app, &state).await;
        update_indicators(&app);
        restarted?;
    }
    Ok(state.status())
}

#[tauri::command]
fn remove_subscription(state: State<AppState>, url: String) -> Result<Settings, String> {
    let mut s = state.snapshot();
    s.subscriptions.retain(|sub| sub.url != url);
    s.servers.retain(|srv| srv.subscription.as_deref() != Some(url.as_str()));
    if s.selected_server().is_none() || !s.servers.iter().any(|srv| Some(&srv.id) == s.selected.as_ref()) {
        s.selected = s.servers.first().map(|srv| srv.id.clone());
    }
    state.store(s.clone())?;
    Ok(s)
}

#[tauri::command]
fn list_processes() -> Vec<system::ProcInfo> {
    system::list_processes()
}

#[tauri::command]
fn get_logs(state: State<AppState>) -> Vec<String> {
    state.core.logs()
}

#[tauri::command]
fn preview_config(state: State<AppState>) -> Result<String, String> {
    let s = state.snapshot();
    state.core.write_config(&s, &state.data_dir)
}

#[tauri::command]
fn open_data_dir(state: State<AppState>) -> Result<(), String> {
    system::open_folder(&state.data_dir)
}

/// Перезапуск с правами администратора. Если включён автозапуск - через его задачу,
/// без окна UAC; иначе - обычный запрос UAC.
#[tauri::command]
fn restart_as_admin(app: AppHandle, state: State<AppState>) -> Result<(), String> {
    if system::autostart_enabled() {
        let marker = state.data_dir.join(PENDING_CONNECT);
        std::fs::write(&marker, b"1").map_err(|e| e.to_string())?;
        if system::run_autostart_task() {
            app.exit(0);
            return Ok(());
        }
        let _ = std::fs::remove_file(&marker);
    }
    if system::restart_as_admin()? {
        app.exit(0);
        Ok(())
    } else {
        Err(tr("Права администратора не выданы", "Administrator rights were not granted").into())
    }
}

/// Переименовать подписку.
#[tauri::command]
fn rename_subscription(state: State<AppState>, url: String, name: String) -> Result<Settings, String> {
    let mut s = state.snapshot();
    let name = name.trim();
    if let Some(sub) = s.subscriptions.iter_mut().find(|sub| sub.url == url) {
        if !name.is_empty() {
            sub.name = name.chars().take(60).collect();
        }
    }
    state.store(s.clone())?;
    Ok(s)
}

#[tauri::command]
fn startup_flags(state: State<AppState>) -> Launch {
    state.launch.clone()
}

/// Ключ или ссылка подписки из буфера обмена - только если там именно это
/// и этого ещё нет в клиенте. Остальное содержимое буфера в интерфейс не попадает.
#[tauri::command]
fn clipboard_candidate(app: AppHandle, state: State<AppState>) -> Option<String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    let text = app.clipboard().read_text().ok()?;
    let candidate = links::clipboard_candidate(&text)?;
    let s = state.settings.lock().unwrap();
    let known = candidate.lines().all(|l| {
        s.servers.iter().any(|srv| srv.link == l) || s.subscriptions.iter().any(|sub| sub.url == l)
    });
    if known {
        None
    } else {
        Some(candidate)
    }
}

/// Проверить, вышла ли новая версия на GitHub.
#[tauri::command]
async fn check_update(app: AppHandle, state: State<'_, AppState>) -> Result<Option<UpdateInfo>, String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| e.to_string())?;
    let found = updater
        .check()
        .await
        .map_err(|e| format!("{}: {e}", tr("Не удалось проверить обновления", "Could not check for updates")))?;
    let info = found.as_ref().map(|u| UpdateInfo {
        version: u.version.clone(),
        current: u.current_version.clone(),
        notes: u.body.clone(),
    });
    *state.update.lock().unwrap() = found;
    Ok(info)
}

/// Скачать и установить найденное обновление. Перед установкой гасим ядро:
/// установщик заменяет и sing-box.exe, а запущенный файл заменить нельзя.
#[tauri::command]
async fn install_update(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    // Установщик поставил бы обычную версию в другую папку - portable обновляют новым zip.
    if state.portable {
        return system::open_folder(RELEASES_URL);
    }
    let update = state
        .update
        .lock()
        .unwrap()
        .take()
        .ok_or(tr("Сначала проверь обновления", "Check for updates first"))?;
    state.core.stop();
    let _ = app.emit("update-progress", 0u64);
    let progress = app.clone();
    let mut downloaded: u64 = 0;
    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                if let Some(total) = total {
                    let _ = progress.emit("update-progress", downloaded * 100 / total.max(1));
                }
            },
            || {},
        )
        .await
        .map_err(|e| format!("{}: {e}", tr("Обновление не установилось", "The update failed to install")))?;
    app.restart();
}

#[tauri::command]
fn get_autostart() -> bool {
    system::autostart_enabled()
}

#[tauri::command]
async fn set_autostart(state: State<'_, AppState>, enabled: bool) -> Result<bool, String> {
    let dir = state.data_dir.clone();
    // schtasks и ожидание UAC - блокирующие, уводим их с потока интерфейса
    tauri::async_runtime::spawn_blocking(move || system::set_autostart(enabled, &dir))
        .await
        .map_err(|e| e.to_string())?
}

const TRAY_OFF: &[u8] = include_bytes!("../icons/tray-off.png");
const TRAY_ON: &[u8] = include_bytes!("../icons/tray-on.png");
// Иконка окна: маскот спит или выглядывает (рисунки - icons/state-*.svg).
const WINDOW_OFF: &[u8] = include_bytes!("../icons/state-sleep.png");
const WINDOW_ON: &[u8] = include_bytes!("../icons/state-peek.png");
// Мятная точка поверх кнопки на панели задач - видна, даже если ярлык закреплён.
const OVERLAY_ON: &[u8] = include_bytes!("../icons/overlay-on.png");

/// Трей, меню трея и панель задач - по тому, работает ли ядро на самом деле.
/// Вызывается после каждого подключения, отключения, перезапуска и падения ядра.
pub(crate) fn update_indicators(app: &AppHandle) {
    let connected = app
        .try_state::<AppState>()
        .map(|s| s.core.is_running())
        .unwrap_or(false);
    let image = |bytes: &[u8]| tauri::image::Image::from_bytes(bytes).ok();
    if let Some(tray) = app.tray_by_id("main") {
        if let Some(icon) = image(if connected { TRAY_ON } else { TRAY_OFF }) {
            let _ = tray.set_icon(Some(icon));
        }
        let _ = tray.set_tooltip(Some(if connected {
            tr("ShredingerBox - подключено", "ShredingerBox - connected")
        } else {
            tr("ShredingerBox - отключено", "ShredingerBox - disconnected")
        }));
    }
    if let Some(items) = app.try_state::<TrayItems>() {
        let _ = items.toggle.set_text(if connected {
            tr("Отключиться", "Disconnect")
        } else {
            tr("Подключиться", "Connect")
        });
        let _ = items.show.set_text(tr("Открыть ShredingerBox", "Open ShredingerBox"));
        let _ = items.quit.set_text(tr("Выход", "Quit"));
    }
    if let Some(window) = app.get_webview_window("main") {
        if let Some(icon) = image(if connected { WINDOW_ON } else { WINDOW_OFF }) {
            let _ = window.set_icon(icon);
        }
        #[cfg(windows)]
        let _ = window.set_overlay_icon(if connected { image(OVERLAY_ON) } else { None });
    }
}

#[tauri::command]
fn sync_indicators(app: AppHandle) {
    update_indicators(&app);
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Открыть ShredingerBox", true, None::<&str>)?;
    let toggle = MenuItem::with_id(app, "toggle", "Подключиться", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &toggle, &separator, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("ShredingerBox - отключено")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main(app),
            // Подключение живёт в интерфейсе - просим его нажать «кнопку».
            "toggle" => {
                let _ = app.emit("tray-toggle", ());
            }
            "quit" => {
                if let Some(state) = app.try_state::<AppState>() {
                    state.core.stop();
                }
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    if let Ok(icon) = tauri::image::Image::from_bytes(TRAY_OFF) {
        builder = builder.icon(icon);
    } else if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    app.manage(TrayItems { show, toggle, quit });
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Только одна копия. При автозапуске и перезапуске с правами старая копия ещё
    // закрывается - ждём её до 8 секунд. При обычном повторном запуске просто
    // показываем окно уже работающей копии.
    let relaunch = std::env::args().any(|a| a == "--autostart" || a == "--autoconnect");
    if !system::acquire_single_instance(if relaunch { 8000 } else { 0 }) {
        if !relaunch {
            system::focus_existing_instance();
        }
        return;
    }

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let portable = portable_data_dir();
            let data_dir = portable.clone().unwrap_or_else(|| {
                app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from("."))
            });
            std::fs::create_dir_all(&data_dir).ok();
            let settings = Settings::load(&data_dir.join("settings.json"));
            // Точный язык «как в системе» пришлёт интерфейс, а явный выбор ставим сразу.
            i18n::set_english(settings.general.language == "en");

            // Метка «подключись после перезапуска» от restart_as_admin через задачу.
            let marker = data_dir.join(PENDING_CONNECT);
            let pending = marker.exists();
            if pending {
                let _ = std::fs::remove_file(&marker);
            }
            let args: Vec<String> = std::env::args().collect();
            let autostart = args.iter().any(|a| a == "--autostart") && !pending;
            let launch = Launch {
                autostart,
                autoconnect: pending || args.iter().any(|a| a == "--autoconnect"),
            };
            system::remove_legacy_url_scheme();

            app.manage(AppState {
                settings: Mutex::new(settings),
                core: core::Core::new(),
                traffic: traffic::Traffic::load(data_dir.join("traffic.json")),
                data_dir,
                launch,
                portable: portable.is_some(),
                update: Mutex::new(None),
            });

            build_tray(app)?;
            update_indicators(app.handle());

            if let Some(window) = app.get_webview_window("main") {
                // Из автозапуска стартуем тихо - сразу в трей.
                if autostart {
                    let _ = window.hide();
                }
                let handle = app.handle().clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        let to_tray = handle
                            .try_state::<AppState>()
                            .map(|s| s.settings.lock().unwrap().general.close_to_tray)
                            .unwrap_or(true);
                        if to_tray {
                            api.prevent_close();
                            if let Some(w) = handle.get_webview_window("main") {
                                let _ = w.hide();
                            }
                        }
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_state,
            save_settings,
            add_from_text,
            refresh_subscriptions,
            remove_server,
            select_server,
            remove_subscription,
            connect,
            disconnect,
            get_status,
            get_traffic,
            ping_servers,
            list_processes,
            get_logs,
            preview_config,
            open_data_dir,
            restart_as_admin,
            startup_flags,
            get_autostart,
            clipboard_candidate,
            check_update,
            install_update,
            set_autostart,
            sync_indicators,
            set_language,
            export_settings,
            import_settings,
            check_services,
            rename_subscription
        ])
        .build(tauri::generate_context!())
        .expect("не удалось запустить ShredingerBox");

    app.run(|handle, event| {
        // При выходе обязательно гасим ядро и возвращаем системный прокси.
        if let RunEvent::Exit = event {
            if let Some(state) = handle.try_state::<AppState>() {
                state.core.stop();
                state.traffic.save();
            }
        }
    });
}
