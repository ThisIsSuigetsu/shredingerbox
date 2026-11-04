//! Настройки клиента: что хранится в settings.json в папке данных приложения.

use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Tun,
    Proxy,
}

/// TUN есть в Windows и macOS. На macOS ядро для него запускается от root через окно
/// пароля при каждом подключении, поэтому там по умолчанию «Прокси».
pub const TUN_AVAILABLE: bool = cfg!(any(windows, target_os = "macos"));

impl Default for Mode {
    fn default() -> Self {
        if cfg!(windows) {
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
    /// Когда подписку последний раз обновили (секунды Unix) - для автообновления.
    #[serde(default)]
    pub updated: Option<u64>,
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
    /// DNS-сервер, через который резолвятся домены, идущие в VPN.
    pub remote_dns: String,
    /// Протокол этого DNS: «https», «tls» или «udp».
    pub remote_dns_type: String,
    /// DNS для сайтов напрямую: пусто - системный, иначе адрес UDP-сервера.
    pub direct_dns: String,
    /// «prefer_ipv4», «prefer_ipv6», «ipv4_only» или «ipv6_only».
    pub dns_strategy: String,
    /// Сетевой стек TUN: «mixed», «system» или «gvisor».
    pub tun_stack: String,
    pub tun_mtu: u32,
    /// Весь трафик строго через TUN - другие программы не обойдут VPN.
    pub tun_strict_route: bool,
    pub tun_ipv6: bool,
    /// Узнавать домен по содержимому соединения - нужно для правил по сайтам.
    pub sniff: bool,
    /// Локальная сеть (роутер, принтер, NAS) всегда напрямую.
    pub bypass_lan: bool,
    /// Запрет QUIC (UDP 443): браузеры переходят на TCP, который часто работает быстрее через VPN.
    pub block_quic: bool,
    /// IP-адреса и подсети (CIDR) через VPN и напрямую.
    pub proxy_ips: Vec<String>,
    pub direct_ips: Vec<String>,
    /// Автообновление подписок раз в столько часов, 0 - выключено.
    pub sub_update_hours: u32,
    /// User-Agent при загрузке подписки; пусто - «ShredingerBox/версия».
    pub sub_user_agent: String,
}

impl Default for Advanced {
    fn default() -> Self {
        Self {
            enabled: false,
            mixed_port: 2080,
            allow_lan: false,
            log_level: "warn".into(),
            remote_dns: "1.1.1.1".into(),
            remote_dns_type: "https".into(),
            direct_dns: String::new(),
            dns_strategy: "prefer_ipv4".into(),
            tun_stack: "mixed".into(),
            tun_mtu: 9000,
            tun_strict_route: true,
            tun_ipv6: true,
            sniff: true,
            bypass_lan: true,
            block_quic: false,
            proxy_ips: vec![],
            direct_ips: vec![],
            sub_update_hours: 0,
            sub_user_agent: String::new(),
        }
    }
}

/// Напоминание о продлении подписки раз в месяц.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Reminder {
    pub enabled: bool,
    /// Месяц последнего показа, например «2026-11», - чтобы напоминать раз в месяц.
    pub last_shown: Option<String>,
    /// С какого числа месяца напоминать (1-28).
    pub day: u8,
    /// Свой текст напоминания; пусто - общий «Пора продлить подписку».
    #[serde(default = "legacy_note")]
    pub note: String,
}

/// До 0.8.0 напоминание было только для друзей: у них остаётся прежний текст.
fn legacy_note() -> String {
    "Напиши Suigetsu в Telegram, чтобы продлить подписку на VPN.".into()
}

impl Default for Reminder {
    fn default() -> Self {
        Self { enabled: false, last_shown: None, day: 20, note: String::new() }
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
    /// «system», «dark» или «light».
    pub theme: String,
    /// «system», «ru» или «en».
    pub language: String,
}

impl Default for General {
    fn default() -> Self {
        Self {
            autoconnect: true,
            close_to_tray: true,
            clipboard_offer: true,
            check_updates: true,
            theme: "system".into(),
            language: "system".into(),
        }
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
        // TUN, сохранённый на системе, где его нет, - на «Прокси».
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_reminder_keeps_friends_text_new_install_is_off() {
        let old: Settings = serde_json::from_str(r#"{"reminder":{"enabled":true,"last_shown":null}}"#).unwrap();
        assert!(old.reminder.enabled);
        assert_eq!(old.reminder.day, 20);
        assert!(old.reminder.note.contains("Suigetsu"));
        let fresh = Settings::default();
        assert!(!fresh.reminder.enabled);
        assert!(fresh.reminder.note.is_empty());
        assert_eq!(fresh.general.language, "system");
        let old_adv: Settings = serde_json::from_str(r#"{"advanced":{"enabled":true,"mixed_port":3000}}"#).unwrap();
        assert_eq!(old_adv.advanced.mixed_port, 3000);
        assert!(old_adv.advanced.sniff && old_adv.advanced.bypass_lan);
    }
}