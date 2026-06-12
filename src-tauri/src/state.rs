use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex as StdMutex};

use tokio::sync::{oneshot, Mutex, Notify};

use crate::config::{ColorPair, StylePreset, ThemeMode, UpdateCheck};

pub struct PendingJob {
    pub date: String,
    pub tx: oneshot::Sender<Vec<u8>>,
}

pub struct AppState {
    pub renderer_ready: AtomicBool,
    pub renderer_notify: Arc<Notify>,
    pub pending: Mutex<Option<PendingJob>>,
    pub enabled: AtomicBool,
    pub hide_tray: AtomicBool,
    pub theme: StdMutex<ThemeMode>,
    pub light: StdMutex<ColorPair>,
    pub dark: StdMutex<ColorPair>,
    pub style: StdMutex<StylePreset>,
    pub update_check: StdMutex<UpdateCheck>,
    pub language: StdMutex<String>,
    pub running: Mutex<bool>,
    pub quitting: AtomicBool,
    /// The (date, effective theme) the wallpaper was last successfully applied
    /// for. In-memory only (None on launch → forces a reconcile at startup).
    /// The scheduler's poll uses it to skip work when nothing has changed.
    pub last_applied: StdMutex<Option<(chrono::NaiveDate, crate::pipeline::EffectiveTheme)>>,
}

impl AppState {
    pub fn from_config(cfg: &crate::config::Config) -> Self {
        Self {
            renderer_ready: AtomicBool::new(false),
            renderer_notify: Arc::new(Notify::new()),
            pending: Mutex::new(None),
            enabled: AtomicBool::new(cfg.enabled),
            hide_tray: AtomicBool::new(cfg.hide_tray),
            theme: StdMutex::new(cfg.theme),
            light: StdMutex::new(cfg.light.clone()),
            dark: StdMutex::new(cfg.dark.clone()),
            style: StdMutex::new(cfg.style),
            update_check: StdMutex::new(cfg.update_check),
            language: StdMutex::new("en".into()),
            running: Mutex::new(false),
            quitting: AtomicBool::new(false),
            last_applied: StdMutex::new(None),
        }
    }
}
