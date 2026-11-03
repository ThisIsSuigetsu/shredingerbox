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

fn dedup(mut v: Vec<String>) -> Vec<String> {
    v.iter_mut().for_each(|s| *s = s.trim().trim_start_matches("*.").to_ascii_lowercase());
    v.retain(|s| !s.is_empty());
    v.sort();
    v.dedup();
    v
}

/// `servers` — все разобранные серверы как (тег, outbound), `selected_tag` — текущий.
/// Над ними строится селектор `proxy`: через Clash API его можно переключать без перезапуска
/// ядра и мерить пинг каждого сервера через туннель.
pub fn build(settings: &Settings, servers: &[(String, Value)], selected_tag: &str, params: &CoreParams) -> Value {
    let rules = &settings.rules;
    let adv = &settings.advanced;

    let mut domains = rules.proxy_domains.clone();
    domains.extend(presets::domains_for(&rules.presets));
    let domains = dedup(domains);
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
    let mut dns_rules = vec![];
    if !direct_apps.is_empty() {
        dns_rules.push(json!({ "process_path_regex": direct_apps, "server": "dns-local" }));
    }
    if !proxy_apps.is_empty() {
        dns_rules.push(json!({ "process_path_regex": proxy_apps, "server": "dns-remote" }));
    }
    if !domains.is_empty() {
        dns_rules.push(json!({ "domain_suffix": domains, "server": "dns-remote" }));
    }

    let mut route_rules = vec![
        json!({ "action": "sniff" }),
        json!({ "protocol": "dns", "action": "hijack-dns" }),
        json!({ "ip_is_private": true, "outbound": "direct" }),
    ];
    if !direct_apps.is_empty() {
        route_rules.push(json!({ "process_path_regex": direct_apps, "outbound": "direct" }));
    }
    if !proxy_apps.is_empty() {
        route_rules.push(json!({ "process_path_regex": proxy_apps, "outbound": "proxy" }));
    }
    if !domains.is_empty() {
        route_rules.push(json!({ "domain_suffix": domains, "outbound": "proxy" }));
    }

    let listen = if adv.allow_lan { "0.0.0.0" } else { "127.0.0.1" };
    let mut inbounds = vec![json!({
        "type": "mixed",
        "tag": "mixed-in",
        "listen": listen,
        "listen_port": adv.mixed_port
    })];
    if settings.mode == Mode::Tun {
        inbounds.push(json!({
            "type": "tun",
            "tag": "tun-in",
            "interface_name": "ShredingerBox",
            "address": ["172.19.0.1/30", "fdfe:dcba:9876::1/126"],
            "auto_route": true,
            "strict_route": true
        }));
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

    json!({
        "log": { "level": adv.log_level, "timestamp": true },
        "dns": {
            "servers": [
                { "type": "https", "tag": "dns-remote", "server": adv.remote_dns, "detour": "proxy" },
                { "type": "local", "tag": "dns-local" }
            ],
            "rules": dns_rules,
            "final": final_dns,
            "strategy": "prefer_ipv4"
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
    fn proxy_mode_has_no_tun() {
        let mut s = Settings::default();
        s.mode = Mode::Proxy;
        let c = build(&s, &one(json!({"type":"direct"})), "srv-a", &params());
        assert_eq!(c["inbounds"].as_array().unwrap().len(), 1);
        assert_eq!(c["inbounds"][0]["listen"], "127.0.0.1");
    }
}
