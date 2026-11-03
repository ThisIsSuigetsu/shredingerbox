//! Запуск и остановка ядра sing-box (sidecar), сбор его логов.

use crate::config::{self, CoreParams};
use crate::links;
use crate::settings::{Mode, Settings};
use crate::system;
use std::collections::VecDeque;
use std::path::Path;
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

pub struct Core {
    child: Mutex<Option<CommandChild>>,
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
        self.child.lock().unwrap().is_some()
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
            .ok_or("Сначала добавь сервер или подписку")?;
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
            return Err("Режим TUN пока есть только в Windows - включи «Прокси»".into());
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
            .map_err(|e| format!("Не найдено ядро sing-box: {e}"))?
            .args(["check", "--disable-color", "-c", cfg_path.as_str(), "-D", dir.as_str()])
            .output()
            .await
            .map_err(|e| format!("Не удалось запустить ядро: {e}"))?;
        if !check.status.success() {
            let err = String::from_utf8_lossy(&check.stderr);
            return Err(format!("Ядро отклонило конфиг: {}", err.trim()));
        }

        let (mut rx, child) = app
            .shell()
            .sidecar("sing-box")
            .map_err(|e| format!("Не найдено ядро sing-box: {e}"))?
            .args(["run", "--disable-color", "-c", cfg_path.as_str(), "-D", dir.as_str()])
            .spawn()
            .map_err(|e| format!("Не удалось запустить ядро: {e}"))?;

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
        self.mark_stopped();
    }
}
