//! Запуск и остановка ядра sing-box (sidecar), сбор его логов.

use crate::config::{self, CoreParams};
use crate::i18n::tr;
use crate::links;
use crate::settings::{Mode, Settings};
use crate::system;
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const MAX_LOG_LINES: usize = 500;

/// Тег сервера в конфиге sing-box.
pub fn server_tag(id: &str) -> String {
    format!("srv-{id}")
}

/// Ядро, запущенное от root (TUN на macOS): сам процесс osascript и папка с его файлами.
/// Убить root-процесс отсюда нельзя - его просят выключиться файлом tun.stop.
struct RootCore {
    child: std::process::Child,
    dir: PathBuf,
}

pub struct Core {
    child: Mutex<Option<CommandChild>>,
    root: Mutex<Option<RootCore>>,
    /// Номер запуска: чтобы событие «процесс завершился» от старого запуска
    /// не сбросило состояние нового (при переподключении).
    generation: AtomicU64,
    mode: Mutex<Option<Mode>>,
    proxy_set: AtomicBool,
    /// Когда в последний раз остановился TUN: Windows нужно время, чтобы удалить адаптер.
    tun_stopped_at: Mutex<Option<Instant>>,
    logs: Mutex<VecDeque<String>>,
    pub api_port: u16,
    pub secret: String,
}

impl Core {
    pub fn new() -> Self {
        use rand::Rng;
        let secret: String = rand::thread_rng()
            .sample_iter(&rand::distributions::Alphanumeric)
            .take(24)
            .map(char::from)
            .collect();
        Self {
            child: Mutex::new(None),
            root: Mutex::new(None),
            generation: AtomicU64::new(0),
            mode: Mutex::new(None),
            proxy_set: AtomicBool::new(false),
            tun_stopped_at: Mutex::new(None),
            logs: Mutex::new(VecDeque::new()),
            api_port: 9097,
            secret,
        }
    }

    pub fn running_mode(&self) -> Option<Mode> {
        *self.mode.lock().unwrap()
    }

    /// Номер текущего запуска ядра: растёт при каждом старте и остановке.
    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    pub fn is_running(&self) -> bool {
        self.child.lock().unwrap().is_some() || self.root.lock().unwrap().is_some()
    }

    pub fn logs(&self) -> Vec<String> {
        self.logs.lock().unwrap().iter().cloned().collect()
    }

    fn push_log(&self, line: String) {
        let mut logs = self.logs.lock().unwrap();
        if logs.len() >= MAX_LOG_LINES {
            logs.pop_front();
        }
        logs.push_back(line);
    }

    pub fn write_config(&self, settings: &Settings, data_dir: &Path) -> Result<String, String> {
        let server = settings
            .selected_server()
            .ok_or(tr("Сначала добавь сервер или подписку", "Add a server or a subscription first"))?;
        // В конфиг идут все серверы: так их можно переключать и пинговать без перезапуска.
        // Сломанная ссылка у невыбранного сервера просто пропускается.
        let mut outbounds = vec![];
        for srv in &settings.servers {
            match links::parse(&srv.link) {
                Ok(p) => outbounds.push((server_tag(&srv.id), p.outbound)),
                Err(e) if srv.id == server.id => return Err(e),
                Err(_) => {}
            }
        }
        let cfg = config::build(
            settings,
            &outbounds,
            &server_tag(&server.id),
            &CoreParams { api_port: self.api_port, secret: self.secret.clone() },
        );
        std::fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
        let path = data_dir.join("config.json");
        let text = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
        std::fs::write(&path, &text).map_err(|e| e.to_string())?;
        Ok(text)
    }

    pub async fn start(&self, app: &AppHandle, settings: &Settings, data_dir: &Path) -> Result<(), String> {
        self.stop();

        if settings.mode == Mode::Tun && !crate::settings::TUN_AVAILABLE {
            return Err(tr("Режим TUN недоступен на этой системе - включи «Прокси»", "TUN mode is not available on this system - switch to Proxy").into());
        }
        if settings.mode == Mode::Tun && !system::is_elevated() {
            return Err("NEED_ADMIN".into());
        }

        // Если TUN только что остановился, ждём, пока Windows удалит старый адаптер,
        // иначе новый не создастся («configure tun interface: file not found»).
        if settings.mode == Mode::Tun {
            let stopped_at = *self.tun_stopped_at.lock().unwrap();
            if let Some(t) = stopped_at {
                let wait = Duration::from_millis(2000).saturating_sub(t.elapsed());
                if !wait.is_zero() {
                    tokio::time::sleep(wait).await;
                }
            }
        }

        self.write_config(settings, data_dir)?;
        let cfg_path = data_dir.join("config.json").to_string_lossy().to_string();
        let dir = data_dir.to_string_lossy().to_string();

        // Сначала просим ядро проверить конфиг - так ошибка будет понятной.
        let check = app
            .shell()
            .sidecar("sing-box")
            .map_err(|e| format!("{}: {e}", tr("Не найдено ядро sing-box", "sing-box core not found")))?
            .args(["check", "--disable-color", "-c", cfg_path.as_str(), "-D", dir.as_str()])
            .output()
            .await
            .map_err(|e| format!("{}: {e}", tr("Не удалось запустить ядро", "Could not start the core")))?;
        if !check.status.success() {
            let err = String::from_utf8_lossy(&check.stderr);
            return Err(format!("{}: {}", tr("Ядро отклонило конфиг", "The core rejected the config"), err.trim()));
        }

        // macOS: TUN требует root - запускаем ядро через системное окно пароля.
        #[cfg(target_os = "macos")]
        if settings.mode == Mode::Tun {
            let child = mac_tun::spawn(&cfg_path, data_dir).await?;
            let gen = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
            *self.root.lock().unwrap() = Some(RootCore { child, dir: data_dir.to_path_buf() });
            *self.mode.lock().unwrap() = Some(settings.mode);
            mac_tun::watch(app.clone(), gen, data_dir.to_path_buf());
            crate::traffic::spawn_counter(app.clone(), gen, self.api_port, self.secret.clone());
            return Ok(());
        }

        let (mut rx, child) = app
            .shell()
            .sidecar("sing-box")
            .map_err(|e| format!("{}: {e}", tr("Не найдено ядро sing-box", "sing-box core not found")))?
            .args(["run", "--disable-color", "-c", cfg_path.as_str(), "-D", dir.as_str()])
            .spawn()
            .map_err(|e| format!("{}: {e}", tr("Не удалось запустить ядро", "Could not start the core")))?;

        let gen = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        *self.child.lock().unwrap() = Some(child);
        *self.mode.lock().unwrap() = Some(settings.mode);

        if settings.mode == Mode::Proxy {
            // Без системного прокси трафик в ядро не пойдёт - тогда и ядро не держим.
            if let Err(e) = system::set_system_proxy(settings.advanced.mixed_port) {
                self.stop();
                return Err(e);
            }
            self.proxy_set.store(true, Ordering::SeqCst);
        }

        let app2 = app.clone();
        tauri::async_runtime::spawn(async move {
            let mut last_line = String::new();
            while let Some(ev) = rx.recv().await {
                match ev {
                    CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => {
                        let text = String::from_utf8_lossy(&bytes).to_string();
                        for line in text.lines().filter(|l| !l.trim().is_empty()) {
                            last_line = line.to_string();
                            let state = app2.state::<crate::AppState>();
                            state.core.push_log(line.to_string());
                            let _ = app2.emit("core-log", line.to_string());
                        }
                    }
                    CommandEvent::Terminated(payload) => {
                        let state = app2.state::<crate::AppState>();
                        if state.core.generation.load(Ordering::SeqCst) == gen {
                            state.core.mark_stopped();
                            // Ядро упало само - иконки меняем сразу, даже если окно спрятано.
                            crate::update_indicators(&app2);
                            let _ = app2.emit(
                                "core-exit",
                                serde_json::json!({ "code": payload.code, "last": last_line }),
                            );
                        }
                        break;
                    }
                    _ => {}
                }
            }
        });
        crate::traffic::spawn_counter(app.clone(), gen, self.api_port, self.secret.clone());

        Ok(())
    }

    /// Сбросить состояние после остановки процесса (без убийства - он уже мёртв).
    fn mark_stopped(&self) {
        self.child.lock().unwrap().take();
        self.root.lock().unwrap().take();
        let was_tun = self.mode.lock().unwrap().take() == Some(Mode::Tun);
        if was_tun {
            *self.tun_stopped_at.lock().unwrap() = Some(Instant::now());
        }
        if self.proxy_set.swap(false, Ordering::SeqCst) {
            let _ = system::clear_system_proxy();
        }
    }

    pub fn stop(&self) {
        // Новый номер запуска: событие Terminated от убитого процесса будет проигнорировано.
        self.generation.fetch_add(1, Ordering::SeqCst);
        if let Some(child) = self.child.lock().unwrap().take() {
            let _ = child.kill();
        }
        if let Some(mut root) = self.root.lock().unwrap().take() {
            // Сторож в root-скрипте раз в секунду проверяет этот файл и гасит ядро.
            let _ = std::fs::write(root.dir.join("tun.stop"), b"");
            for _ in 0..40 {
                if matches!(root.child.try_wait(), Ok(Some(_))) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
        self.mark_stopped();
    }
}

/// TUN на macOS: ядро работает от root, пока жив клиент и нет файла tun.stop.
#[cfg(target_os = "macos")]
mod mac_tun {
    use std::io::{Read, Seek, SeekFrom};
    use std::path::{Path, PathBuf};
    use std::process::{Child, Command, Stdio};
    use std::time::Duration;
    use tauri::{AppHandle, Emitter, Manager};

    /// Строка в одинарных кавычках для sh.
    fn sh(s: &str) -> String {
        format!("'{}'", s.replace('\'', r"'\''"))
    }

    /// Строка для AppleScript в двойных кавычках.
    fn applescript(s: &str) -> String {
        format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
    }

    /// Показывает окно пароля администратора и запускает ядро от root.
    /// Возвращает, когда ядро стартовало, или ошибку, если пароль не ввели.
    pub async fn spawn(cfg: &str, data_dir: &Path) -> Result<Child, String> {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let sing_box = exe.parent().ok_or(crate::i18n::tr("Не найдена папка программы", "Program folder not found"))?.join("sing-box");
        // У ядра от root своя рабочая папка: его cache.db принадлежит root,
        // и ядро в режиме «Прокси» (от пользователя) не смогло бы его открыть.
        let work = data_dir.join("tun");
        let (log, pid, stop) = (data_dir.join("tun.log"), data_dir.join("tun.pid"), data_dir.join("tun.stop"));
        let _ = std::fs::remove_file(&stop);
        let _ = std::fs::remove_file(&pid);
        let p = |x: &Path| sh(&x.to_string_lossy());
        let script = format!(
            "mkdir -p {work}; {sb} run --disable-color -c {cfg} -D {work} > {log} 2>&1 & core=$!; echo $core > {pid}; \
             while kill -0 $core 2>/dev/null; do \
             if [ -e {stop} ] || ! kill -0 {app} 2>/dev/null; then kill $core; fi; sleep 1; done; \
             rm -f {pid} {stop}",
            work = p(&work),
            sb = p(&sing_box),
            cfg = sh(cfg),
            log = p(&log),
            pid = p(&pid),
            stop = p(&stop),
            app = std::process::id(),
        );
        let mut child = Command::new("/usr/bin/osascript")
            .arg("-e")
            .arg(format!("do shell script {} with administrator privileges", applescript(&script)))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("{}: {e}", crate::i18n::tr("Не удалось запросить права администратора", "Could not request administrator rights")))?;
        // Ждём, пока введут пароль и ядро запишет свой pid, или пока osascript не завершится.
        for _ in 0..1500 {
            if pid.exists() {
                return Ok(child);
            }
            if let Ok(Some(_)) = child.try_wait() {
                let mut err = String::new();
                if let Some(mut e) = child.stderr.take() {
                    let _ = e.read_to_string(&mut err);
                }
                if err.contains("-128") {
                    return Err(crate::i18n::tr(
                        "Подключение отменено: для TUN macOS спрашивает пароль администратора. Без пароля работает режим «Прокси».",
                        "Connection cancelled: macOS asks for the administrator password for TUN. Proxy mode works without it.",
                    )
                    .into());
                }
                let last = std::fs::read_to_string(&log).unwrap_or_default();
                let last = last.lines().last().unwrap_or(err.trim()).to_string();
                return Err(format!("{}: {last}", crate::i18n::tr("Ядро не запустилось", "The core did not start")));
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        Err(crate::i18n::tr(
            "Пароль администратора так и не ввели - подключение отменено",
            "The administrator password was not entered - connection cancelled",
        )
        .into())
    }

    /// Читает tun.log для окна логов и замечает, когда ядро остановилось само.
    pub fn watch(app: AppHandle, generation: u64, data_dir: PathBuf) {
        std::thread::spawn(move || {
            let log = data_dir.join("tun.log");
            let mut pos = 0u64;
            let mut last = String::new();
            loop {
                std::thread::sleep(Duration::from_millis(500));
                let state = app.state::<crate::AppState>();
                if let Ok(mut f) = std::fs::File::open(&log) {
                    let mut text = String::new();
                    if f.seek(SeekFrom::Start(pos)).is_ok() && f.read_to_string(&mut text).is_ok() {
                        pos += text.len() as u64;
                        for line in text.lines().filter(|l| !l.trim().is_empty()) {
                            last = line.to_string();
                            state.core.push_log(line.to_string());
                            let _ = app.emit("core-log", line.to_string());
                        }
                    }
                }
                if state.core.generation() != generation {
                    break;
                }
                let exited = state
                    .core
                    .root
                    .lock()
                    .unwrap()
                    .as_mut()
                    .map_or(true, |r| matches!(r.child.try_wait(), Ok(Some(_))));
                if exited {
                    if state.core.generation() == generation {
                        state.core.mark_stopped();
                        crate::update_indicators(&app);
                        let _ = app.emit("core-exit", serde_json::json!({ "code": null, "last": last }));
                    }
                    break;
                }
            }
        });
    }
}
