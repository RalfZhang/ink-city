//! Live application state, seeded from `config::Config` at launch and read by
//! every other module through `app.state::<AppState>()`.
//!
//! Two things are worth knowing before adding a field. Whether it belongs here or
//! in `config`: this struct also holds state that is deliberately *not* persisted
//! (`bypass_cache`, `last_applied`, `resolved_city`), and each such field says why
//! below. And if the field is reflected in `commands::Status`, every site that
//! mutates it must call `mark_status_dirty()` or an open window will go stale.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

use tokio::sync::{oneshot, Mutex, Notify};

use crate::config::{
    ColorPair, CustomCity, RailwayStyle, StylePreset, StyleVariant, ThemeMode, UpdateCheck,
    UpdateMode,
};
use crate::updates::UpdateStrings;

pub struct PendingJob {
    /// Opaque job id, echoed back verbatim by the renderer window and matched
    /// here so a stale result is discarded (`commands::submit_render_result`).
    /// It carries a date for historical reasons — hence the name and the
    /// `render-request`/`submit_render_result` field name — but since a render is
    /// no longer identified by a date alone it holds `Target::signature`
    /// (`daily:<date>:<theme>` / `custom:<key>:<theme>`). The renderer never
    /// parses it.
    pub date: String,
    pub tx: oneshot::Sender<Vec<u8>>,
}

pub struct AppState {
    pub renderer_ready: AtomicBool,
    pub renderer_notify: Arc<Notify>,
    pub pending: Mutex<Option<PendingJob>>,
    /// How the wallpaper is refreshed (see `config::UpdateMode`).
    pub update_mode: StdMutex<UpdateMode>,
    /// The pinned location for `UpdateMode::Customized`, or `None`. Persisted via
    /// `config::Config::custom`.
    pub custom: StdMutex<Option<CustomCity>>,
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
    /// Which symbol the railway layer is drawn in, `Off` included — a mode rather
    /// than a bool, so it's a mutex like `variant` and not an `AtomicBool` like
    /// its neighbours. See `config::RailwayStyle`.
    pub railway_style: StdMutex<RailwayStyle>,
    pub show_aerialways: AtomicBool,
    /// Which visual language the map is drawn in (issue #18). See
    /// `config::Config::variant`.
    pub variant: StdMutex<StyleVariant>,
    /// Whether the hidden Dev Mode tab is unlocked. Unlike `bypass_cache`, this
    /// is persisted (see `config::Config::dev_mode`) so the tab stays unlocked
    /// across restarts once the 7-click gesture in About has revealed it.
    pub dev_mode: AtomicBool,
    /// Dev-only: when on, `resolve_daily` skips the day cache and every published
    /// manifest, takes the day's city from `osm-v2/city-list.json` read straight
    /// off GitHub, fetches the map live from Overpass, and overwrites the local
    /// cache with the result — so map-data edits are tested against fresh data
    /// while the day still shows the city it's actually scheduled for. In-memory
    /// only (always off on launch) and deliberately never persisted — leaving it on
    /// would make every render hit Overpass live, which isn't always
    /// China-reachable (the reason the CDN exists). Read through
    /// `effective_bypass_cache`, never directly.
    pub bypass_cache: AtomicBool,
    pub proxy_enabled: AtomicBool,
    pub proxy_url: StdMutex<String>,
    /// User-facing strings for the windowless update flows, pushed from the
    /// frontend JSON locale files (see `UpdateStrings`). English until synced.
    pub update_strings: StdMutex<UpdateStrings>,
    pub running: Mutex<bool>,
    pub quitting: AtomicBool,
    /// Signature of the render the wallpaper was last successfully applied for —
    /// see `pipeline::Target::signature`. In-memory only (None on launch →
    /// forces a reconcile at startup). The scheduler's poll compares it against
    /// `pipeline::desired_signature` to skip work when nothing has changed. A
    /// string (rather than a typed tuple) so it can key both the Daily rotation
    /// (by date + theme) and a Customized pin (by coordinates + theme) uniformly.
    pub last_applied: StdMutex<Option<String>>,
    /// The city the pipeline actually resolved for a date — the schedule
    /// manifest's pick when the CDN served one, else the rotation fallback.
    /// `Status` reads it through `pipeline::city_for_status` rather than calling
    /// `city::pick_for_date` itself, which would name a different city than the
    /// wallpaper on every day the schedule was used. In-memory only; see
    /// `city_for_status` for how a restart onto an already-rendered day recovers
    /// it from that day's cached payload. Only the Daily flow writes it — a
    /// Customized pin isn't a city and must not overwrite the day's answer.
    pub resolved_city: StdMutex<Option<(chrono::NaiveDate, crate::city::City)>>,
    /// Signal that some `Status`-affecting state changed. The status-emitter task
    /// waits on it and pushes a fresh snapshot to the frontend. Mutation sites only
    /// signal (`mark_status_dirty`); the snapshot is built in one place.
    /// `notify_one` stores a permit, so a signal raised while the emitter is
    /// mid-build is not lost — the trailing state is always delivered.
    pub status_dirty: Arc<Notify>,
}

impl AppState {
    pub fn from_config(cfg: &crate::config::Config) -> Self {
        Self {
            renderer_ready: AtomicBool::new(false),
            renderer_notify: Arc::new(Notify::new()),
            pending: Mutex::new(None),
            update_mode: StdMutex::new(cfg.update_mode),
            custom: StdMutex::new(cfg.custom),
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
            railway_style: StdMutex::new(cfg.railway_style),
            show_aerialways: AtomicBool::new(cfg.show_aerialways),
            variant: StdMutex::new(cfg.variant),
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

    /// Effective value of the Dev Mode "bypass cache & CDN" switch for a given
    /// `UpdateMode`. Two gates, and in both cases the stored `bypass_cache` is left
    /// untouched so the real setting comes back once the gate lifts:
    ///
    ///   • `dev_mode` — while the tab is locked the switch reads as off;
    ///   • `mode != Customized` — the switch only means anything on the Daily path
    ///     (skip the manifest, take the city from the schedule state, fetch the map
    ///     live). A Customized pin is arbitrary coordinates that nothing precaches,
    ///     so it already goes straight to Overpass and there is nothing left to
    ///     bypass. Gating it here rather than only in the UI is what keeps
    ///     `Status::bypass_cache` — and therefore the rendered switch — honest
    ///     about that.
    ///
    /// The mode is a parameter, and this **must stay lock-free**: `build_status`
    /// calls it while the guard for the `update_mode` it already read is still
    /// alive, so locking `update_mode` here would re-enter a non-reentrant
    /// `StdMutex` and hang the status-emitter task — the app's only state channel —
    /// for the rest of the process. That the `&&` chain short-circuits is what made
    /// the old version look healthy: the third gate was only ever reached with the
    /// switch actually on.
    pub fn bypass_cache_for(&self, mode: UpdateMode) -> bool {
        self.dev_mode.load(Ordering::Acquire)
            && self.bypass_cache.load(Ordering::Acquire)
            && mode != UpdateMode::Customized
    }

    /// `bypass_cache_for` for callers that hold no `update_mode` guard (the render
    /// pipeline). Every consumer of the switch reads through one of these two
    /// rather than the raw atom.
    pub fn effective_bypass_cache(&self) -> bool {
        let mode = *self.update_mode.lock().unwrap();
        self.bypass_cache_for(mode)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;

    fn unlocked_and_on() -> AppState {
        let state = AppState::from_config(&Config::default());
        state.dev_mode.store(true, Ordering::Release);
        state.bypass_cache.store(true, Ordering::Release);
        state
    }

    /// Deadlock regression guard: computing the effective bypass flag must never
    /// need the `update_mode` lock, because `commands::build_status` calls it while
    /// holding that lock's guard. Against a lock-taking implementation this test
    /// hangs forever instead of failing.
    #[test]
    fn bypass_cache_for_does_not_touch_the_update_mode_lock() {
        let state = unlocked_and_on();
        let mode = state.update_mode.lock().unwrap();
        assert!(state.bypass_cache_for(*mode));
    }

    #[test]
    fn locked_dev_mode_reads_as_off() {
        let state = unlocked_and_on();
        state.dev_mode.store(false, Ordering::Release);
        assert!(!state.bypass_cache_for(UpdateMode::Daily));
    }

    #[test]
    fn switch_off_reads_as_off() {
        let state = unlocked_and_on();
        state.bypass_cache.store(false, Ordering::Release);
        assert!(!state.bypass_cache_for(UpdateMode::Daily));
    }

    /// A pin already fetches live, so there is nothing left to bypass — and the
    /// stored atom stays on, so Daily gets the real setting back.
    #[test]
    fn customized_mode_reads_as_off_without_clearing_the_switch() {
        let state = unlocked_and_on();
        assert!(!state.bypass_cache_for(UpdateMode::Customized));
        assert!(state.bypass_cache_for(UpdateMode::Daily));
    }
}
