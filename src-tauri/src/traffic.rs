//! Расход трафика по каждому серверу за календарный месяц (traffic.json в папке данных).
//! Пока ядро работает, раз в секунду спрашиваем у Clash API список соединений и прибавляем
//! прирост байтов к серверу, через который идёт соединение.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager};

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Usage {
    pub up: u64,
    pub down: u64,
}

/// Месяц «2026-11» → id сервера → сколько прошло.
type Book = BTreeMap<String, HashMap<String, Usage>>;

pub struct Traffic {
    path: PathBuf,
    book: Mutex<Book>,
}

/// Текущий месяц по местному времени: счётчик обнуляется 1-го числа.
pub fn current_month() -> String {
    chrono::Local::now().format("%Y-%m").to_string()
}

impl Traffic {
    pub fn load(path: PathBuf) -> Self {
        let book = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Self { path, book: Mutex::new(book) }
    }

    pub fn save(&self) {
        let text = serde_json::to_string_pretty(&*self.book.lock().unwrap()).unwrap_or_default();
        let _ = std::fs::write(&self.path, text);
    }

    fn add(&self, month: &str, server: &str, up: u64, down: u64) {
        if up == 0 && down == 0 {
            return;
        }
        let mut book = self.book.lock().unwrap();
        let usage = book.entry(month.to_string()).or_default().entry(server.to_string()).or_default();
        usage.up += up;
        usage.down += down;
    }

    /// Расход за месяц по всем серверам.
    pub fn month(&self, month: &str) -> HashMap<String, Usage> {
        self.book.lock().unwrap().get(month).cloned().unwrap_or_default()
    }
}

#[derive(Deserialize)]
struct Connections {
    #[serde(default)]
    connections: Vec<Connection>,
}

#[derive(Deserialize)]
struct Connection {
    id: String,
    upload: u64,
    download: u64,
    /// Цепочка outbound'ов: первым идёт сам сервер (`srv-<id>`), за ним селектор `proxy`.
    #[serde(default)]
    chains: Vec<String>,
}

/// Сколько байтов прибавилось у каждого сервера с прошлого опроса.
/// `last` — что мы видели у каждого соединения в прошлый раз; закрытые соединения из него убираются.
fn deltas(conns: &[Connection], last: &mut HashMap<String, (u64, u64)>) -> HashMap<String, Usage> {
    let mut out: HashMap<String, Usage> = HashMap::new();
    let mut seen = HashMap::with_capacity(conns.len());
    for c in conns {
        let (prev_up, prev_down) = last.get(&c.id).copied().unwrap_or((0, 0));
        seen.insert(c.id.clone(), (c.upload, c.download));
        let Some(server) = c.chains.first().and_then(|t| t.strip_prefix("srv-")) else { continue };
        let usage = out.entry(server.to_string()).or_default();
        usage.up += c.upload.saturating_sub(prev_up);
        usage.down += c.download.saturating_sub(prev_down);
    }
    *last = seen;
    out
}

/// Считать трафик, пока работает запуск ядра с номером `generation`.
pub fn spawn_counter(app: AppHandle, generation: u64, api_port: u16, secret: String) {
    tauri::async_runtime::spawn(async move {
        let Ok(client) = reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(3)).build() else {
            return;
        };
        let url = format!("http://127.0.0.1:{api_port}/connections");
        let mut last = HashMap::new();
        let mut ticks = 0u32;
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            let state = app.state::<crate::AppState>();
            if state.core.generation() != generation {
                break;
            }
            let Ok(resp) = client.get(&url).bearer_auth(&secret).send().await else { continue };
            let Ok(text) = resp.text().await else { continue };
            let Ok(conns) = serde_json::from_str::<Connections>(&text) else { continue };
            let month = current_month();
            for (server, u) in deltas(&conns.connections, &mut last) {
                state.traffic.add(&month, &server, u.up, u.down);
            }
            ticks += 1;
            if ticks % 30 == 0 {
                state.traffic.save();
            }
        }
        app.state::<crate::AppState>().traffic.save();
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn(id: &str, up: u64, down: u64, chain: &str) -> Connection {
        Connection { id: id.into(), upload: up, download: down, chains: vec![chain.into(), "proxy".into()] }
    }

    #[test]
    fn counts_growth_per_server_and_skips_direct() {
        let mut last = HashMap::new();
        let first = deltas(&[conn("a", 10, 100, "srv-x"), conn("b", 5, 50, "direct")], &mut last);
        assert_eq!(first["x"], Usage { up: 10, down: 100 });
        assert!(!first.contains_key("direct"));
        // «a» выросло, «c» новое на том же сервере, «b» закрылось.
        let second = deltas(&[conn("a", 15, 400, "srv-x"), conn("c", 1, 2, "srv-x")], &mut last);
        assert_eq!(second["x"], Usage { up: 6, down: 302 });
        assert!(!last.contains_key("b"));
    }

    #[test]
    fn book_adds_up_by_month() {
        let dir = std::env::temp_dir().join(format!("sbx-traffic-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("traffic.json");
        let t = Traffic::load(path.clone());
        t.add("2026-11", "x", 1, 2);
        t.add("2026-11", "x", 3, 4);
        t.add("2026-12", "x", 5, 5);
        t.save();
        let again = Traffic::load(path);
        assert_eq!(again.month("2026-11")["x"], Usage { up: 4, down: 6 });
        assert_eq!(again.month("2026-12")["x"], Usage { up: 5, down: 5 });
        assert!(again.month("2027-01").is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }
}
