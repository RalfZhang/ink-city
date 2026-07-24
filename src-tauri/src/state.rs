use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex as StdMutex};

use tokio::sync::{oneshot, Mutex, Notify};

use crate::config::{ColorPair, StylePreset, ThemeMode, UpdateCheck};
use crate::updates::UpdateStrings;

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
    /// Auto-install detected updates (on the `update_check` cadence) and relaunch,
    /// without confirmation. Read by the background scheduler after each check.
    pub auto_update: AtomicBool,
    /// Single source of truth for "an update is available": the version string
    /// we can upgrade to, or `None`. Seeded on launch from the persisted
    /// `update.meta.json` (see `updates::restore_pending`), refreshed by every
    /// check, and surfaced to the frontend via `get_status` so the General tab
    /// reflects it across tab switches and window reopens.
    pub available_update: StdMutex<Option<String>>,
    /// Guards against concurrent/duplicate installs (tray + General + repeated
    /// clicks can all race to trigger an install).
    pub update_installing: AtomicBool,
    pub show_water: AtomicBool,
    /// Cache of "which optional layers (see `crate::layers::LAYER_KEYS`) does
    /// the cached OSM data for this date carry". Keyed by date so it's
    /// computed at most once per day per session (checking it means scanning
    /// the cached OSM file). Updated when the pipeline fetches data; read by
    /// `get_status` (via `pipeline::has_layer_for`) to decide whether to
    /// surface a layer's UI toggle — e.g. `has_water`.
    pub present_layers: StdMutex<Option<(chrono::NaiveDate, std::collections::HashSet<String>)>>,
    /// User-facing strings for the windowless update flows, pushed from the
    /// frontend JSON locale files (see `UpdateStrings`). English until synced.
    pub update_strings: StdMutex<UpdateStrings>,
    pub running: Mutex<bool>,
    pub quitting: AtomicBool,
    /// The (date, effective theme) the wallpaper was last successfully applied
    /// for. In-memory only (None on launch → forces a reconcile at startup).
    /// The scheduler's poll uses it to skip work when nothing has changed.
    pub last_applied: StdMutex<Option<(chrono::NaiveDate, crate::pipeline::EffectiveTheme)>>,
    /// Signal that some `Status`-affecting state changed. The status-emitter
    /// task waits on it and pushes a fresh snapshot to the frontend, replacing
    /// the old 2s poll. Mutation sites only signal (`mark_status_dirty`); the
    /// snapshot is built in one place. `notify_one` stores a permit, so a signal
    /// raised while the emitter is mid-build is not lost — the trailing state is
    /// always delivered.
    pub status_dirty: Arc<Notify>,
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
            auto_update: AtomicBool::new(cfg.auto_update),
            available_update: StdMutex::new(None),
            update_installing: AtomicBool::new(false),
            show_water: AtomicBool::new(cfg.show_water),
            present_layers: StdMutex::new(None),
            update_strings: StdMutex::new(UpdateStrings::default()),
            running: Mutex::new(false),
            quitting: AtomicBool::new(false),
            last_applied: StdMutex::new(None),
            status_dirty: Arc::new(Notify::new()),
        }
    }

    /// Signal the status-emitter task to push a fresh snapshot. Call from every
    /// site that mutates a field reflected in `Status`.
    pub fn mark_status_dirty(&self) {
        self.status_dirty.notify_one();
    }
}
