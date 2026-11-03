//! Разбор ссылок vless:// hy2:// trojan:// ss:// и подписок в outbound'ы sing-box.

use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD};
use base64::Engine;
use percent_encoding::percent_decode_str;
use serde_json::{json, Map, Value};
use std::collections::HashMap;

pub struct Parsed {
    pub name: String,
    pub outbound: Value,
    pub host: String,
    pub port: u16,
    /// Протокол по UDP (Hysteria2): TCP-пинг к нему не имеет смысла.
    pub udp_only: bool,
}

const SCHEMES: &[&str] = &["vless://", "hy2://", "hysteria2://", "trojan://", "ss://"];

pub fn is_link(s: &str) -> bool {
    let l = s.trim().to_ascii_lowercase();
    SCHEMES.iter().any(|p| l.starts_with(p))
}

pub fn parse(link: &str) -> Result<Parsed, String> {
    let link = link.trim();
    let lower = link.to_ascii_lowercase();
    if lower.starts_with("vless://") {
        parse_vless(&link[8..])
    } else if lower.starts_with("hy2://") {
        parse_hy2(&link[6..])
    } else if lower.starts_with("hysteria2://") {
        parse_hy2(&link[12..])
    } else if lower.starts_with("trojan://") {
        parse_trojan(&link[9..])
    } else if lower.starts_with("ss://") {
        parse_ss(&link[5..])
    } else {
        Err("Неизвестный формат ссылки. Поддерживаются vless://, hy2://, trojan://, ss://".into())
    }
}

/// Что из буфера обмена стоит предложить добавить: ключи (по строке) или одна ссылка подписки.
/// Всё остальное - None, чтобы не показывать пользователю его личный буфер.
pub fn clipboard_candidate(text: &str) -> Option<String> {
    let text = text.trim();
    if text.is_empty() || text.len() > 64 * 1024 {
        return None;
    }
    let keys: Vec<&str> = text.lines().map(str::trim).filter(|l| is_link(l)).collect();
    if !keys.is_empty() {
        return Some(keys.join("\n"));
    }
    let lower = text.to_ascii_lowercase();
    let is_url = (lower.starts_with("https://") || lower.starts_with("http://"))
        && !text.contains(char::is_whitespace);
    // Ссылки подписок 3x-ui и большинства панелей содержат «sub» в пути.
    let path = lower.splitn(4, '/').nth(3).unwrap_or("");
    if is_url && path.contains("sub") {
        return Some(text.to_string());
    }
    None
}

/// Тело подписки: base64 со списком ссылок или просто список ссылок по строке.
pub fn parse_subscription_body(body: &str) -> Vec<String> {
    let trimmed = body.trim();
    let text = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        decode_b64(trimmed).unwrap_or_default()
    };
    text.lines()
        .map(|l| l.trim().to_string())
        .filter(|l| is_link(l))
        .collect()
}

// ---------- общие помощники ----------

fn decode(s: &str) -> String {
    percent_decode_str(s).decode_utf8_lossy().into_owned()
}

fn decode_b64(s: &str) -> Option<String> {
    let clean: String = s.chars().filter(|c| !c.is_whitespace()).collect();
    for eng in [&STANDARD, &STANDARD_NO_PAD, &URL_SAFE, &URL_SAFE_NO_PAD] {
        if let Ok(bytes) = eng.decode(&clean) {
            if let Ok(text) = String::from_utf8(bytes) {
                return Some(text);
            }
        }
    }
    None
}

/// "user@host:port?query#name" → (user, host, port-строка, query, name)
struct Parts {
    user: Option<String>,
    host: String,
    port: String,
    query: HashMap<String, String>,
    name: Option<String>,
}

fn split(rest: &str) -> Result<Parts, String> {
    let (rest, name) = match rest.split_once('#') {
        Some((r, n)) => (r, Some(decode(n)).filter(|n| !n.is_empty())),
        None => (rest, None),
    };
    let (auth, query_str) = match rest.split_once('?') {
        Some((a, q)) => (a, q),
        None => (rest, ""),
    };
    let auth = auth.trim_end_matches('/');
    let (user, hostport) = match auth.rsplit_once('@') {
        Some((u, h)) => (Some(decode(u)), h),
        None => (None, auth),
    };
    let (host, port) = if let Some(stripped) = hostport.strip_prefix('[') {
        // IPv6: [2001:db8::1]:443
        let (h, p) = stripped
            .split_once("]:")
            .ok_or("Не удалось прочитать IPv6-адрес сервера")?;
        (h.to_string(), p.to_string())
    } else {
        let (h, p) = hostport
            .rsplit_once(':')
            .ok_or("В ссылке нет порта сервера")?;
        (h.to_string(), p.to_string())
    };
    if host.is_empty() {
        return Err("В ссылке нет адреса сервера".into());
    }
    let mut query = HashMap::new();
    for pair in query_str.split('&').filter(|p| !p.is_empty()) {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        query.insert(decode(k).to_ascii_lowercase(), decode(v));
    }
    Ok(Parts { user, host, port, query, name })
}

fn port_num(p: &str) -> Result<u16, String> {
    p.parse::<u16>()
        .map_err(|_| format!("Неверный порт сервера: {p}"))
}

fn q<'a>(parts: &'a Parts, key: &str) -> Option<&'a str> {
    parts.query.get(key).map(|s| s.as_str()).filter(|s| !s.is_empty())
}

fn truthy(v: Option<&str>) -> bool {
    matches!(v, Some("1") | Some("true") | Some("True"))
}

fn alpn(parts: &Parts) -> Option<Value> {
    q(parts, "alpn").map(|a| json!(a.split(',').map(str::trim).collect::<Vec<_>>()))
}

/// TLS-блок для vless/trojan по параметрам security/sni/fp/pbk/sid.
fn tls_block(parts: &Parts, default_tls: bool) -> Option<Value> {
    let security = q(parts, "security").unwrap_or(if default_tls { "tls" } else { "none" });
    if security == "none" {
        return None;
    }
    let mut tls = Map::new();
    tls.insert("enabled".into(), json!(true));
    tls.insert(
        "server_name".into(),
        json!(q(parts, "sni").or(q(parts, "peer")).unwrap_or(&parts.host)),
    );
    if truthy(q(parts, "allowinsecure")) || truthy(q(parts, "insecure")) {
        tls.insert("insecure".into(), json!(true));
    }
    if let Some(a) = alpn(parts) {
        tls.insert("alpn".into(), a);
    }
    let fp = q(parts, "fp");
    if security == "reality" {
        tls.insert(
            "utls".into(),
            json!({ "enabled": true, "fingerprint": fp.unwrap_or("chrome") }),
        );
        let mut reality = Map::new();
        reality.insert("enabled".into(), json!(true));
        reality.insert("public_key".into(), json!(q(parts, "pbk").unwrap_or("")));
        if let Some(sid) = q(parts, "sid") {
            reality.insert("short_id".into(), json!(sid));
        }
        tls.insert("reality".into(), Value::Object(reality));
    } else if let Some(fp) = fp {
        tls.insert("utls".into(), json!({ "enabled": true, "fingerprint": fp }));
    }
    Some(Value::Object(tls))
}

/// Транспорт по параметру type (tcp по умолчанию - без транспорта).
fn transport(parts: &Parts) -> Result<Option<Value>, String> {
    let host = q(parts, "host");
    let path = q(parts, "path").unwrap_or("/");
    match q(parts, "type").unwrap_or("tcp") {
        "tcp" | "raw" => Ok(None),
        "ws" => {
            let mut t = json!({ "type": "ws", "path": path });
            if let Some(h) = host {
                t["headers"] = json!({ "Host": h });
            }
            Ok(Some(t))
        }
        "grpc" => Ok(Some(json!({
            "type": "grpc",
            "service_name": q(parts, "servicename").unwrap_or("")
        }))),
        "httpupgrade" => {
            let mut t = json!({ "type": "httpupgrade", "path": path });
            if let Some(h) = host {
                t["host"] = json!(h);
            }
            Ok(Some(t))
        }
        "http" | "h2" => {
            let mut t = json!({ "type": "http", "path": path });
            if let Some(h) = host {
                t["host"] = json!([h]);
            }
            Ok(Some(t))
        }
        "xhttp" | "splithttp" => {
            Err("Транспорт xhttp не поддерживается ядром sing-box".into())
        }
        other => Err(format!("Неизвестный транспорт: {other}")),
    }
}

fn finish(parts: Parts, outbound: Value, port: u16, udp_only: bool) -> Parsed {
    Parsed {
        name: parts.name.clone().unwrap_or_else(|| parts.host.clone()),
        host: parts.host,
        port,
        outbound,
        udp_only,
    }
}

// ---------- протоколы ----------

fn parse_vless(rest: &str) -> Result<Parsed, String> {
    let parts = split(rest)?;
    let port = port_num(&parts.port)?;
    let uuid = parts.user.clone().ok_or("В ссылке vless нет UUID")?;
    let mut ob = json!({
        "type": "vless",
        "server": parts.host,
        "server_port": port,
        "uuid": uuid,
        "packet_encoding": "xudp"
    });
    if let Some(flow) = q(&parts, "flow") {
        ob["flow"] = json!(flow);
    }
    if let Some(tls) = tls_block(&parts, false) {
        ob["tls"] = tls;
    }
    if let Some(t) = transport(&parts)? {
        ob["transport"] = t;
    }
    Ok(finish(parts, ob, port, false))
}

fn parse_trojan(rest: &str) -> Result<Parsed, String> {
    let parts = split(rest)?;
    let port = port_num(&parts.port)?;
    let password = parts.user.clone().ok_or("В ссылке trojan нет пароля")?;
    let mut ob = json!({
        "type": "trojan",
        "server": parts.host,
        "server_port": port,
        "password": password
    });
    if let Some(tls) = tls_block(&parts, true) {
        ob["tls"] = tls;
    }
    if let Some(t) = transport(&parts)? {
        ob["transport"] = t;
    }
    Ok(finish(parts, ob, port, false))
}

fn parse_hy2(rest: &str) -> Result<Parsed, String> {
    let parts = split(rest)?;
    let password = parts.user.clone().unwrap_or_default();
    let mut ob = json!({
        "type": "hysteria2",
        "server": parts.host,
        "password": password
    });
    // Порт может быть диапазоном для port hopping: 20000-30000 или 443,20000-30000
    let port: u16;
    if parts.port.contains(['-', ',']) {
        let ranges: Vec<String> = parts
            .port
            .split(',')
            .map(|r| r.trim().replace('-', ":"))
            .collect();
        port = ranges
            .first()
            .and_then(|r| r.split(':').next())
            .and_then(|p| p.parse().ok())
            .ok_or("Неверный диапазон портов")?;
        ob["server_ports"] = json!(ranges
            .iter()
            .map(|r| if r.contains(':') { r.clone() } else { format!("{r}:{r}") })
            .collect::<Vec<_>>());
    } else {
        port = port_num(&parts.port)?;
        ob["server_port"] = json!(port);
    }
    let mut tls = json!({
        "enabled": true,
        "server_name": q(&parts, "sni").unwrap_or(&parts.host)
    });
    if truthy(q(&parts, "insecure")) {
        tls["insecure"] = json!(true);
    }
    if let Some(a) = alpn(&parts) {
        tls["alpn"] = a;
    }
    ob["tls"] = tls;
    if let Some(obfs) = q(&parts, "obfs") {
        if obfs != "none" {
            ob["obfs"] = json!({
                "type": obfs,
                "password": q(&parts, "obfs-password").unwrap_or("")
            });
        }
    }
    Ok(finish(parts, ob, port, true))
}

fn parse_ss(rest: &str) -> Result<Parsed, String> {
    // SIP002: base64(method:password)@host:port#name
    // Старый вид: base64(method:password@host:port)#name
    let (body, name) = match rest.split_once('#') {
        Some((b, n)) => (b, Some(n)),
        None => (rest, None),
    };
    let body = body.split_once('?').map(|(b, _)| b).unwrap_or(body);
    let full = if body.contains('@') {
        let (user, hostport) = body.rsplit_once('@').unwrap();
        let user = decode(user);
        let creds = if user.contains(':') {
            user
        } else {
            decode_b64(&user).ok_or("Не удалось прочитать данные Shadowsocks")?
        };
        format!("{creds}@{hostport}")
    } else {
        decode_b64(body).ok_or("Не удалось прочитать ссылку Shadowsocks")?
    };
    let with_name = match name {
        Some(n) => format!("{full}#{n}"),
        None => full,
    };
    let parts = split(&with_name)?;
    let port = port_num(&parts.port)?;
    let creds = parts.user.clone().ok_or("В ссылке ss нет метода и пароля")?;
    let (method, password) = creds
        .split_once(':')
        .ok_or("В ссылке ss нет метода шифрования")?;
    let ob = json!({
        "type": "shadowsocks",
        "server": parts.host,
        "server_port": port,
        "method": method,
        "password": password
    });
    Ok(finish(parts, ob, port, false))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vless_reality() {
        let p = parse("vless://11111111-2222-3333-4444-555555555555@example.org:443?type=tcp&security=reality&pbk=PUBKEY&fp=chrome&sni=devlog.example.org&sid=ab12&flow=xtls-rprx-vision#%D0%9D%D0%B8%D0%B4%D0%B5%D1%80%D0%BB%D0%B0%D0%BD%D0%B4%D1%8B").unwrap();
        assert_eq!(p.name, "Нидерланды");
        assert_eq!(p.outbound["type"], "vless");
        assert_eq!(p.outbound["server_port"], 443);
        assert_eq!(p.outbound["flow"], "xtls-rprx-vision");
        assert_eq!(p.outbound["tls"]["reality"]["public_key"], "PUBKEY");
        assert_eq!(p.outbound["tls"]["reality"]["short_id"], "ab12");
        assert_eq!(p.outbound["tls"]["server_name"], "devlog.example.org");
        assert!(p.outbound.get("transport").is_none());
    }

    #[test]
    fn vless_ws_tls() {
        let p = parse("vless://uuid@1.2.3.4:8443?type=ws&security=tls&path=%2Fws&host=cdn.example.com#ws").unwrap();
        assert_eq!(p.outbound["transport"]["type"], "ws");
        assert_eq!(p.outbound["transport"]["path"], "/ws");
        assert_eq!(p.outbound["transport"]["headers"]["Host"], "cdn.example.com");
        assert_eq!(p.outbound["tls"]["server_name"], "1.2.3.4");
    }

    #[test]
    fn hy2_salamander() {
        let p = parse("hy2://p%40ss@blockhaven.example.org:443?sni=blockhaven.example.org&obfs=salamander&obfs-password=secret&insecure=0#RU").unwrap();
        assert_eq!(p.outbound["type"], "hysteria2");
        assert_eq!(p.outbound["password"], "p@ss");
        assert_eq!(p.outbound["obfs"]["type"], "salamander");
        assert_eq!(p.outbound["obfs"]["password"], "secret");
        assert_eq!(p.outbound["server_port"], 443);
        assert!(p.udp_only);
    }

    #[test]
    fn hy2_port_range() {
        let p = parse("hysteria2://pw@[2001:db8::1]:20000-30000?sni=a.b").unwrap();
        assert_eq!(p.host, "2001:db8::1");
        assert_eq!(p.outbound["server_ports"][0], "20000:30000");
        assert!(p.outbound.get("server_port").is_none());
    }

    #[test]
    fn ss_both_forms() {
        // base64("chacha20-ietf-poly1305:pass")
        let creds = STANDARD.encode("chacha20-ietf-poly1305:pass");
        let p = parse(&format!("ss://{creds}@10.0.0.1:8388#home")).unwrap();
        assert_eq!(p.outbound["method"], "chacha20-ietf-poly1305");
        assert_eq!(p.outbound["password"], "pass");
        assert_eq!(p.name, "home");
        let legacy = STANDARD.encode("aes-128-gcm:pw@10.0.0.2:443");
        let p = parse(&format!("ss://{legacy}")).unwrap();
        assert_eq!(p.outbound["server"], "10.0.0.2");
    }

    #[test]
    fn subscription_base64() {
        let list = "vless://u@a.b:443?security=tls#1\nhy2://p@c.d:443#2\ngarbage\n";
        let body = STANDARD.encode(list);
        assert_eq!(parse_subscription_body(&body).len(), 2);
        assert_eq!(parse_subscription_body(list).len(), 2);
    }

    #[test]
    fn clipboard_filter() {
        assert_eq!(
            clipboard_candidate("  vless://u@a.b:443?security=tls#1\nпривет\nhy2://p@c.d:443 ").as_deref(),
            Some("vless://u@a.b:443?security=tls#1\nhy2://p@c.d:443")
        );
        assert!(clipboard_candidate("https://panel.example.org:2096/sub/abc123").is_some());
        assert!(clipboard_candidate("https://youtube.com/watch?v=1").is_none());
        assert!(clipboard_candidate("https://sub.example.org").is_none());
        assert!(clipboard_candidate("мой пароль 12345").is_none());
    }

    #[test]
    fn xhttp_rejected() {
        assert!(parse("vless://u@a.b:443?type=xhttp&security=tls").is_err());
    }
}
