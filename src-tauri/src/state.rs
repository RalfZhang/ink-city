use std::sync::atomic::{AtomicBool, Ordering};
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
    pub show_airports: AtomicBool,
    pub show_railways: AtomicBool,
    pub show_aerialways: AtomicBool,
    /// Whether the hidden Dev Mode tab is unlocked. Unlike `bypass_cache`, this
    /// is persisted (see `config::Config::dev_mode`) so the tab stays unlocked
    /// across restarts once the 7-click gesture in About has revealed it.
    pub dev_mode: AtomicBool,
    /// Dev-only: when on, `render_bytes_for` skips the day-cache read and the
    /// CDN, fetches OSM live from the Overpass sidecar, and overwrites the local
    /// cache with it, so map-data edits are tested against fresh data. In-memory
    /// only (always off on launch) and deliberately never persisted — leaving it
    /// on would make every render hit Overpass live, which isn't always
    /// China-reachable (the reason the CDN exists).
    pub bypass_cache: AtomicBool,
    pub proxy_enabled: AtomicBool,
    pub proxy_url: StdMutex<String>,
    /// User-facing strings for the windowless update flows, pushed from the
    /// frontend JSON locale files (see `UpdateStrings`). English until synced.
    pub update_strings: StdMutex<UpdateStrings>,
    pub running: Mutex<bool>,
    pub quitting: AtomicBool,
    /// The (date, effective theme) the wallpaper was last successfully applied
    /// for. In-memory only (None on launch → forces a reconcile at startup).
    /// The scheduler's poll uses it to skip work when nothing has changed.
    pub last_applied: StdMutex<Option<(chrono::NaiveDate, crate::pipeline::EffectiveTheme)>>,
    /// The city the pipeline actually resolved for a date — the schedule
    /// manifest's pick when the CDN served one, else the rotation fallback.
    /// `Status` reads it through `pipeline::city_for_status` rather than calling
    /// `city::pick_for_date` itself, which would name a different city than the
    /// wallpaper on every day the schedule was used. In-memory only; see
    /// `city_for_status` for how a restart onto an already-rendered day recovers
    /// it from that day's cached payload.
    pub resolved_city: StdMutex<Option<(chrono::NaiveDate, crate::city::City)>>,
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
            show_airports: AtomicBool::new(cfg.show_airports),
            show_railways: AtomicBool::new(cfg.show_railways),
            show_aerialways: AtomicBool::new(cfg.show_aerialways),
            dev_mode: AtomicBool::new(cfg.dev_mode),
            bypass_cache: AtomicBool::new(false),
            proxy_enabled: AtomicBool::new(cfg.proxy_enabled),
            proxy_url: StdMutex::new(cfg.proxy_url.clone()),
            update_strings: StdMutex::new(UpdateStrings::default()),
            running: Mutex::new(false),
            quitting: AtomicBool::new(false),
            last_applied: StdMutex::new(None),
            resolved_city: StdMutex::new(None),
            status_dirty: Arc::new(Notify::new()),
        }
    }

    /// Signal the status-emitter task to push a fresh snapshot. Call from every
    /// site that mutates a field reflected in `Status`.
    pub fn mark_status_dirty(&self) {
        self.status_dirty.notify_one();
    }

    /// Effective value of the Dev Mode "bypass cache & CDN" switch: gated on
    /// `dev_mode`, so while the tab is locked it always reads as off. The stored
    /// `bypass_cache` is left untouched, so the real setting is restored the
    /// moment the tab is unlocked again. Every consumer of the switch (pipeline,
    /// `Status`) reads through here rather than the raw atom.
    pub fn effective_bypass_cache(&self) -> bool {
        self.dev_mode.load(Ordering::Acquire) && self.bypass_cache.load(Ordering::Acquire)
    }
}
