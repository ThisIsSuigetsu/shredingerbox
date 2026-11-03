//! Настройки клиента: что хранится в settings.json в папке данных приложения.

use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Tun,
    Proxy,
}

/// TUN пока сделан только для Windows: на macOS для него нужен root и свой помощник.
pub const TUN_AVAILABLE: bool = cfg!(windows);

impl Default for Mode {
    fn default() -> Self {
        if TUN_AVAILABLE {
            Mode::Tun
        } else {
            Mode::Proxy
        }
    }
}

/// Куда идёт трафик, который не попал ни в одно правило.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum FinalRoute {
    Proxy,
    #[default]
    Direct,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Server {
    pub id: String,
    pub name: String,
    pub link: String,
    /// URL подписки, из которой пришёл сервер (None - добавлен вручную).
    #[serde(default)]
    pub subscription: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Subscription {
    pub url: String,
    pub name: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct AppRule {
    /// Человеческое название («Discord»).
    pub name: String,
    /// Имя исполняемого файла («Discord.exe») - по нему sing-box и матчит процесс.
    pub exe: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Rules {
    pub final_route: FinalRoute,
    pub proxy_apps: Vec<AppRule>,
    pub direct_apps: Vec<AppRule>,
    pub proxy_domains: Vec<String>,
    /// Сайты, которые всегда идут напрямую, - даже из приложений «через VPN» и наборов.
    pub direct_domains: Vec<String>,
    /// Включённые готовые наборы (id из presets.rs).
    pub presets: Vec<String>,
}

impl Default for Rules {
    fn default() -> Self {
        Self {
            final_route: FinalRoute::Direct,
            proxy_apps: vec![],
            direct_apps: vec![],
            proxy_domains: vec![],
            direct_domains: vec![],
            presets: vec!["youtube".into(), "discord".into()],
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Advanced {
    pub enabled: bool,
    pub mixed_port: u16,
    pub allow_lan: bool,
    pub log_level: String,
    /// DNS-over-HTTPS сервер, через который резолвятся домены, идущие в VPN.
    pub remote_dns: String,
}

impl Default for Advanced {
    fn default() -> Self {
        Self {
            enabled: false,
            mixed_port: 2080,
            allow_lan: false,
            log_level: "warn".into(),
            remote_dns: "1.1.1.1".into(),
        }
    }
}

/// Напоминание о продлении подписки (20-го числа каждого месяца).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Reminder {
    pub enabled: bool,
    /// Месяц последнего показа, например «2026-11», - чтобы напоминать раз в месяц.
    pub last_shown: Option<String>,
}

impl Default for Reminder {
    fn default() -> Self {
        Self { enabled: true, last_shown: None }
    }
}

/// Поведение приложения: трей и подключение при запуске.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct General {
    /// Сразу подключаться, когда клиент запустился вместе с Windows.
    pub autoconnect: bool,
    /// Крестик прячет окно в трей, а не закрывает программу.
    pub close_to_tray: bool,
    /// Предлагать добавить ключ или подписку, найденные в буфере обмена.
    pub clipboard_offer: bool,
    /// Проверять обновления клиента на GitHub.
    pub check_updates: bool,
}

impl Default for General {
    fn default() -> Self {
        Self { autoconnect: true, close_to_tray: true, clipboard_offer: true, check_updates: true }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, Default, PartialEq)]
#[serde(default)]
pub struct Settings {
    pub mode: Mode,
    pub servers: Vec<Server>,
    pub subscriptions: Vec<Subscription>,
    pub selected: Option<String>,
    pub rules: Rules,
    pub advanced: Advanced,
    pub reminder: Reminder,
    pub general: General,
    /// Версия, для которой уже показали окно «Что нового».
    pub seen_version: Option<String>,
}

impl Settings {
    pub fn load(path: &Path) -> Self {
        let mut s: Self = std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        // Старые версии на Mac сохраняли TUN, который там не работает.
        if !TUN_AVAILABLE {
            s.mode = Mode::Proxy;
        }
        s
    }

    pub fn save(&self, path: &Path) -> Result<(), String> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        std::fs::write(path, json).map_err(|e| e.to_string())
    }

    /// Выбранный сервер, а если выбор потерялся - первый из списка.
    pub fn selected_server(&self) -> Option<&Server> {
        self.selected
            .as_ref()
            .and_then(|id| self.servers.iter().find(|s| &s.id == id))
            .or_else(|| self.servers.first())
    }
}
