//! Готовые наборы доменов: одна кнопка в интерфейсе — все домены сервиса.

use serde::Serialize;

#[derive(Serialize, Clone)]
pub struct Preset {
    pub id: &'static str,
    pub title: &'static str,
    pub domains: &'static [&'static str],
}

pub const PRESETS: &[Preset] = &[
    Preset {
        id: "youtube",
        title: "YouTube",
        domains: &[
            "youtube.com",
            "youtu.be",
            "googlevideo.com",
            "ytimg.com",
            "ggpht.com",
            "youtube-nocookie.com",
            "youtubei.googleapis.com",
            "yt.be",
        ],
    },
    Preset {
        id: "discord",
        title: "Discord",
        domains: &[
            "discord.com",
            "discord.gg",
            "discordapp.com",
            "discordapp.net",
            "discord.media",
            "discordcdn.com",
            "discord.dev",
        ],
    },
    Preset {
        id: "instagram",
        title: "Instagram",
        domains: &["instagram.com", "cdninstagram.com", "fbcdn.net", "facebook.com"],
    },
    Preset {
        id: "x",
        title: "X / Twitter",
        domains: &["x.com", "twitter.com", "twimg.com", "t.co"],
    },
    Preset {
        id: "claude",
        title: "Claude",
        domains: &["claude.ai", "claude.com", "anthropic.com", "claudeusercontent.com"],
    },
    Preset {
        id: "chatgpt",
        title: "ChatGPT",
        domains: &["openai.com", "chatgpt.com", "oaistatic.com", "oaiusercontent.com"],
    },
    Preset {
        id: "spotify",
        title: "Spotify",
        domains: &["spotify.com", "scdn.co", "spotifycdn.com", "spotify.design"],
    },
];

pub fn domains_for(ids: &[String]) -> Vec<String> {
    PRESETS
        .iter()
        .filter(|p| ids.iter().any(|id| id == p.id))
        .flat_map(|p| p.domains.iter().map(|d| d.to_string()))
        .collect()
}
