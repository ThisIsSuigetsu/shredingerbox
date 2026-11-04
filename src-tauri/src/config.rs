//! Сборка конфига sing-box (формат 1.12+) из настроек клиента.

use crate::presets;
use crate::settings::{FinalRoute, Mode, Settings};
use serde_json::{json, Value};

pub struct CoreParams {
    pub api_port: u16,
    pub secret: String,
}

/// Имя exe → регулярка по пути процесса без учёта регистра.
/// `process_name` в sing-box сравнивает строго посимвольно, и `Claude.exe`
/// не совпадёт с настоящим `claude.exe`, поэтому матчим путь через `(?i)`.
fn exe_regex(exe: &str) -> String {
    let mut escaped = String::new();
    for c in exe.trim().chars() {
        if "\\.^$|?*+()[]{}".contains(c) {
            escaped.push('\\');
        }
        escaped.push(c);
    }
    format!("(?i)(^|[\\\\/]){escaped}$")
}

/// «Госуслуги.рф» → «xn--c1aapkosapc.xn--p1ai»: sing-box сравнивает домены только в ASCII.
fn ascii_domain(d: &str) -> String {
    url::Url::parse(&format!("http://{d}"))
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or_else(|| d.to_string())
}

/// «1.2.3.4», «10.0.0.0/8», «2001:db8::/32» → CIDR; мусор пропускается.
fn cidrs(list: &[String]) -> Vec<String> {
    let mut out: Vec<String> = list
        .iter()
        .filter_map(|raw| {
            let s = raw.trim();
            let (ip, prefix) = s.split_once('/').map_or((s, None), |(a, b)| (a, Some(b)));
            let ip: std::net::IpAddr = ip.trim().parse().ok()?;
            let max = if ip.is_ipv4() { 32 } else { 128 };
            let prefix = match prefix {
                Some(p) => p.trim().parse::<u8>().ok().filter(|p| *p <= max)?,
                None => max,
            };
            Some(format!("{ip}/{prefix}"))
        })
        .collect();
    out.sort();
    out.dedup();
    out
}

/// DNS-сервер sing-box из адреса вида «1.1.1.1», «dns.google:853», «https://dns.google/dns-query»
/// или «tls://1.1.1.1». Схема в адресе важнее `kind`. Второе значение - нужен ли серверу
/// другой DNS, чтобы узнать собственный адрес (если указано имя, а не IP).
fn dns_server(addr: &str, kind: &str, tag: &str) -> (Value, bool) {
    let mut kind = kind.to_string();
    let mut rest = addr.trim();
    if let Some((scheme, tail)) = rest.split_once("://") {
        kind = match scheme.to_ascii_lowercase().as_str() {
            "https" | "doh" => "https",
            "tls" | "dot" => "tls",
            "quic" | "doq" => "quic",
            _ => "udp",
        }
        .to_string();
        rest = tail;
    }
    let (hostport, path) = rest.split_once('/').map_or((rest, None), |(a, b)| (a, Some(b)));
    let (host, port) = if let Some(v6) = hostport.strip_prefix('[') {
        let (h, tail) = v6.split_once(']').unwrap_or((v6, ""));
        (h.to_string(), tail.strip_prefix(':').and_then(|p| p.parse::<u16>().ok()))
    } else if hostport.matches(':').count() == 1 {
        let (h, p) = hostport.split_once(':').unwrap();
        (h.to_string(), p.parse::<u16>().ok())
    } else {
        (hostport.to_string(), None)
    };
    let mut server = json!({ "type": kind, "tag": tag, "server": host });
    if let Some(port) = port {
        server["server_port"] = json!(port);
    }
    if kind == "https" {
        if let Some(path) = path.filter(|p| !p.is_empty()) {
            server["path"] = json!(format!("/{path}"));
        }
    }
    (server, host.parse::<std::net::IpAddr>().is_err())
}

fn dedup(mut v: Vec<String>) -> Vec<String> {
    v.iter_mut().for_each(|s| *s = ascii_domain(s.trim().trim_start_matches("*.")).to_ascii_lowercase());
    v.retain(|s| !s.is_empty());
    v.sort();
    v.dedup();
    v
}

/// `servers` - все разобранные серверы как (тег, outbound), `selected_tag` - текущий.
/// Над ними строится селектор `proxy`: через Clash API его можно переключать без перезапуска
/// ядра и мерить пинг каждого сервера через туннель.
pub fn build(settings: &Settings, servers: &[(String, Value)], selected_tag: &str, params: &CoreParams) -> Value {
    let rules = &settings.rules;
    let adv = &settings.advanced;

    let mut domains = rules.proxy_domains.clone();
    domains.extend(presets::domains_for(&rules.presets));
    let domains = dedup(domains);
    let direct_domains = dedup(rules.direct_domains.clone());
    let proxy_ips = cidrs(&adv.proxy_ips);
    let direct_ips = cidrs(&adv.direct_ips);
    let proxy_apps: Vec<String> = rules.proxy_apps.iter().map(|a| exe_regex(&a.exe)).collect();
    let direct_apps: Vec<String> = rules.direct_apps.iter().map(|a| exe_regex(&a.exe)).collect();

    let final_out = match rules.final_route {
        FinalRoute::Proxy => "proxy",
        FinalRoute::Direct => "direct",
    };
    let final_dns = match rules.final_route {
        FinalRoute::Proxy => "dns-remote",
        FinalRoute::Direct => "dns-local",
    };

    // ВАЖНО: правило с пустым списком в sing-box совпадает со всем подряд,
    // поэтому добавляем правило только если в списке что-то есть.
    // «Сайты напрямую» - исключения (банки, госуслуги), поэтому они стоят первыми.
    let mut dns_rules = vec![];
    if !direct_domains.is_empty() {
        dns_rules.push(json!({ "domain_suffix": direct_domains, "server": "dns-local" }));
    }
    if !direct_apps.is_empty() {
        dns_rules.push(json!({ "process_path_regex": direct_apps, "server": "dns-local" }));
    }
    if !proxy_apps.is_empty() {
        dns_rules.push(json!({ "process_path_regex": proxy_apps, "server": "dns-remote" }));
    }
    if !domains.is_empty() {
        dns_rules.push(json!({ "domain_suffix": domains, "server": "dns-remote" }));
    }

    let mut route_rules = vec![];
    if adv.sniff {
        route_rules.push(json!({ "action": "sniff" }));
    }
    route_rules.push(json!({ "protocol": "dns", "action": "hijack-dns" }));
    if adv.bypass_lan {
        route_rules.push(json!({ "ip_is_private": true, "outbound": "direct" }));
    }
    if adv.block_quic {
        route_rules.push(json!({ "network": "udp", "port": 443, "action": "reject" }));
    }
    if !direct_domains.is_empty() {
        route_rules.push(json!({ "domain_suffix": direct_domains, "outbound": "direct" }));
    }
    if !direct_ips.is_empty() {
        route_rules.push(json!({ "ip_cidr": direct_ips, "outbound": "direct" }));
    }
    if !direct_apps.is_empty() {
        route_rules.push(json!({ "process_path_regex": direct_apps, "outbound": "direct" }));
    }
    if !proxy_apps.is_empty() {
        route_rules.push(json!({ "process_path_regex": proxy_apps, "outbound": "proxy" }));
    }
    if !domains.is_empty() {
        route_rules.push(json!({ "domain_suffix": domains, "outbound": "proxy" }));
    }
    if !proxy_ips.is_empty() {
        route_rules.push(json!({ "ip_cidr": proxy_ips, "outbound": "proxy" }));
    }

    let listen = if adv.allow_lan { "0.0.0.0" } else { "127.0.0.1" };
    let mut inbounds = vec![json!({
        "type": "mixed",
        "tag": "mixed-in",
        "listen": listen,
        "listen_port": adv.mixed_port
    })];
    if settings.mode == Mode::Tun {
        let mut address = vec!["172.19.0.1/30"];
        if adv.tun_ipv6 {
            address.push("fdfe:dcba:9876::1/126");
        }
        let stack = match adv.tun_stack.as_str() {
            "system" | "gvisor" => adv.tun_stack.as_str(),
            _ => "mixed",
        };
        let mut tun = json!({
            "type": "tun",
            "tag": "tun-in",
            "address": address,
            "mtu": adv.tun_mtu.clamp(1280, 65535),
            "stack": stack,
            "auto_route": true,
            "strict_route": adv.tun_strict_route
        });
        // На macOS адаптер обязан называться utunN - там имя выбирает само ядро.
        if cfg!(windows) {
            tun["interface_name"] = json!("ShredingerBox");
        }
        inbounds.push(tun);
    }

    let mut outbounds: Vec<Value> = vec![json!({
        "type": "selector",
        "tag": "proxy",
        "outbounds": servers.iter().map(|(tag, _)| tag.clone()).collect::<Vec<_>>(),
        "default": selected_tag,
        "interrupt_exist_connections": true
    })];
    for (tag, ob) in servers {
        let mut ob = ob.clone();
        ob["tag"] = json!(tag);
        outbounds.push(ob);
    }
    outbounds.push(json!({ "type": "direct", "tag": "direct" }));

    // DNS для VPN идёт через туннель. Если у DNS-сервера имя, а не IP, его адрес
    // узнаём через системный DNS.
    let remote_addr = if adv.remote_dns.trim().is_empty() { "1.1.1.1" } else { adv.remote_dns.as_str() };
    let (mut remote, remote_needs) = dns_server(remote_addr, &adv.remote_dns_type, "dns-remote");
    remote["detour"] = json!("proxy");
    let mut need_system = remote_needs;
    let local = if adv.direct_dns.trim().is_empty() {
        json!({ "type": "local", "tag": "dns-local" })
    } else {
        let (mut local, local_needs) = dns_server(&adv.direct_dns, "udp", "dns-local");
        if local_needs {
            local["domain_resolver"] = json!("dns-system");
            need_system = true;
        }
        local
    };
    if remote_needs {
        remote["domain_resolver"] = json!(if adv.direct_dns.trim().is_empty() { "dns-local" } else { "dns-system" });
    }
    let mut dns_servers = vec![remote, local];
    if need_system && !adv.direct_dns.trim().is_empty() {
        dns_servers.push(json!({ "type": "local", "tag": "dns-system" }));
    }
    let strategy = match adv.dns_strategy.as_str() {
        s @ ("prefer_ipv6" | "ipv4_only" | "ipv6_only") => s,
        _ => "prefer_ipv4",
    };

    json!({
        "log": { "level": adv.log_level, "timestamp": true },
        "dns": {
            "servers": dns_servers,
            "rules": dns_rules,
            "final": final_dns,
            "strategy": strategy
        },
        "inbounds": inbounds,
        "outbounds": outbounds,
        "route": {
            "rules": route_rules,
            "final": final_out,
            "auto_detect_interface": true,
            "default_domain_resolver": "dns-local"
        },
        "experimental": {
            "clash_api": {
                "external_controller": format!("127.0.0.1:{}", params.api_port),
                "secret": params.secret
            },
            "cache_file": { "enabled": true, "path": "cache.db" }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::AppRule;

    fn params() -> CoreParams {
        CoreParams { api_port: 9097, secret: "s".into() }
    }

    fn one(ob: Value) -> Vec<(String, Value)> {
        vec![("srv-a".to_string(), ob)]
    }

    #[test]
    fn empty_lists_produce_no_catch_all_rules() {
        let mut s = Settings::default();
        s.rules.presets.clear();
        let c = build(&s, &one(json!({"type":"direct"})), "srv-a", &params());
        let rules = c["route"]["rules"].as_array().unwrap();
        assert_eq!(rules.len(), 3);
        assert!(c["dns"]["rules"].as_array().unwrap().is_empty());
        assert_eq!(c["route"]["final"], "direct");
    }

    #[test]
    fn rules_and_tun() {
        let mut s = Settings::default();
        s.mode = Mode::Tun;
        s.rules.final_route = FinalRoute::Proxy;
        s.rules.proxy_apps.push(AppRule { name: "Discord".into(), exe: "Discord.exe".into() });
        s.rules.direct_apps.push(AppRule { name: "Steam".into(), exe: "steam.exe".into() });
        s.rules.proxy_domains.push("*.Example.com".into());
        let c = build(&s, &one(json!({"type":"vless","server":"a"})), "srv-a", &params());
        assert_eq!(c["outbounds"][0]["tag"], "proxy");
        assert_eq!(c["outbounds"][0]["type"], "selector");
        assert_eq!(c["outbounds"][0]["default"], "srv-a");
        assert_eq!(c["outbounds"][1]["tag"], "srv-a");
        assert_eq!(c["inbounds"][1]["type"], "tun");
        assert_eq!(c["route"]["final"], "proxy");
        assert_eq!(c["dns"]["final"], "dns-remote");
        let rules = c["route"]["rules"].as_array().unwrap();
        // direct-приложения должны стоять раньше proxy-правил
        assert_eq!(rules[3]["process_path_regex"][0], r"(?i)(^|[\\/])steam\.exe$");
        assert_eq!(rules[4]["process_path_regex"][0], r"(?i)(^|[\\/])Discord\.exe$");
        let domains = rules[5]["domain_suffix"].as_array().unwrap();
        assert!(domains.contains(&json!("example.com")));
        assert!(domains.contains(&json!("googlevideo.com")));
    }

    #[test]
    fn direct_domains_win_over_apps_and_presets() {
        let mut s = Settings::default();
        s.rules.final_route = FinalRoute::Proxy;
        s.rules.proxy_apps.push(AppRule { name: "Chrome".into(), exe: "chrome.exe".into() });
        s.rules.direct_domains =
            vec!["*.Gosuslugi.ru".into(), "youtube.com".into(), "".into(), "госуслуги.рф".into()];
        let c = build(&s, &one(json!({"type":"direct"})), "srv-a", &params());
        let rules = c["route"]["rules"].as_array().unwrap();
        assert_eq!(
            rules[3]["domain_suffix"],
            json!(["gosuslugi.ru", "xn--c1aapkosapc.xn--p1ai", "youtube.com"])
        );
        assert_eq!(rules[3]["outbound"], "direct");
        assert_eq!(rules[4]["outbound"], "proxy");
        assert_eq!(c["dns"]["rules"][0]["server"], "dns-local");
    }

    #[test]
    fn dns_addresses() {
        let (s, needs) = dns_server("1.1.1.1", "https", "t");
        assert_eq!(s, json!({"type":"https","tag":"t","server":"1.1.1.1"}));
        assert!(!needs);
        let (s, needs) = dns_server("https://dns.google/dns-query", "udp", "t");
        assert_eq!(s, json!({"type":"https","tag":"t","server":"dns.google","path":"/dns-query"}));
        assert!(needs);
        let (s, _) = dns_server("tls://9.9.9.9:853", "https", "t");
        assert_eq!(s, json!({"type":"tls","tag":"t","server":"9.9.9.9","server_port":853}));
        let (s, _) = dns_server("[2606:4700::1111]:53", "udp", "t");
        assert_eq!(s, json!({"type":"udp","tag":"t","server":"2606:4700::1111","server_port":53}));
    }

    #[test]
    fn advanced_routing_and_dns() {
        let mut s = Settings::default();
        s.mode = Mode::Tun;
        s.advanced.block_quic = true;
        s.advanced.bypass_lan = false;
        s.advanced.tun_ipv6 = false;
        s.advanced.tun_stack = "gvisor".into();
        s.advanced.direct_ips = vec!["10.1.2.3".into(), "bad".into(), "192.168.0.0/16".into()];
        s.advanced.proxy_ips = vec!["2001:db8::/32".into()];
        s.advanced.remote_dns = "dns.google".into();
        s.advanced.direct_dns = "77.88.8.8".into();
        s.advanced.dns_strategy = "ipv4_only".into();
        let c = build(&s, &one(json!({"type":"direct"})), "srv-a", &params());
        let rules = c["route"]["rules"].as_array().unwrap();
        assert!(!rules.iter().any(|r| r.get("ip_is_private").is_some()));
        assert!(rules.iter().any(|r| r["action"] == "reject" && r["port"] == 443));
        let direct = rules.iter().find(|r| r.get("ip_cidr").is_some() && r["outbound"] == "direct").unwrap();
        assert_eq!(direct["ip_cidr"], json!(["10.1.2.3/32", "192.168.0.0/16"]));
        let proxy = rules.iter().find(|r| r.get("ip_cidr").is_some() && r["outbound"] == "proxy").unwrap();
        assert_eq!(proxy["ip_cidr"], json!(["2001:db8::/32"]));
        assert_eq!(c["inbounds"][1]["stack"], "gvisor");
        assert_eq!(c["inbounds"][1]["address"].as_array().unwrap().len(), 1);
        assert_eq!(c["dns"]["strategy"], "ipv4_only");
        assert_eq!(c["dns"]["servers"][0]["domain_resolver"], "dns-system");
        assert_eq!(c["dns"]["servers"][1], json!({"type":"udp","tag":"dns-local","server":"77.88.8.8"}));
        assert_eq!(c["dns"]["servers"][2]["type"], "local");
    }

    #[test]
    fn proxy_mode_has_no_tun() {
        let mut s = Settings::default();
        s.mode = Mode::Proxy;
        let c = build(&s, &one(json!({"type":"direct"})), "srv-a", &params());
        assert_eq!(c["inbounds"].as_array().unwrap().len(), 1);
        assert_eq!(c["inbounds"][0]["listen"], "127.0.0.1");
    }
}
