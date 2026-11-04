//! Язык сообщений из Rust: ошибки, трей. Интерфейс сообщает, какой язык выбран
//! (по системе или вручную), командой set_language.

use std::sync::atomic::{AtomicBool, Ordering};

static ENGLISH: AtomicBool = AtomicBool::new(false);

pub fn set_english(on: bool) {
    ENGLISH.store(on, Ordering::Relaxed);
}

pub fn english() -> bool {
    ENGLISH.load(Ordering::Relaxed)
}

/// Русский или английский вариант строки - по текущему языку.
pub fn tr(ru: &'static str, en: &'static str) -> &'static str {
    if english() {
        en
    } else {
        ru
    }
}
