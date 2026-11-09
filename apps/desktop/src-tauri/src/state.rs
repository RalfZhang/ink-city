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
    CityLabel, ColorPair, CustomCity, MapProvider, ProxyMode, RailwayStyle, StylePreset,
    StyleVariant, ThemeMode, UpdateCheck, UpdateMode,
};
use crate::guess_store::StoreView;
use crate::pipeline::{FailedRun, Requests};
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
    /// Which map the app shows (see `config::UpdateMode`).
    pub update_mode: StdMutex<UpdateMode>,
    /// Whether that map is put on the desktop too (see `config::Config::sync_wallpaper`).
    pub sync_wallpaper: AtomicBool,
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
    /// Percent complete of an in-flight update download, or `None` when nothing
    /// is downloading *or* the serving host never told us the total. Written by
    /// `updates::set_download_progress`, which only publishes on a change, so
    /// this is already throttled to at most a hundred writes per download.
    pub update_progress: StdMutex<Option<u8>>,
    /// Set by `updates::cancel` to ask the in-flight download to stop, and
    /// cleared by `claim_install` at the start of every install — a cancel is
    /// only ever meaningful for the transfer running when it arrives, so one
    /// that lands after a download has already finished must not kill the next.
    pub update_cancel: AtomicBool,
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
    /// The Proxy setting as persisted; the route requests take is `proxy::set`'s
    /// copy, which `System` resolves at each use.
    pub proxy_mode: StdMutex<ProxyMode>,
    pub proxy_url: StdMutex<String>,
    pub map_provider: StdMutex<MapProvider>,
    /// Where the wallpaper carries the day's city caption (Style tab). Persisted —
    /// see `config::CityLabel`.
    pub city_label: StdMutex<CityLabel>,
    /// The two fields of the guess-the-country save the backend needs — the "show
    /// city info" preference and which days have ended — for
    /// `guess_store::is_revealed`, which gates the wallpaper caption. Seeded from
    /// `guess.json` at launch and replaced on every `guess_store_write`; the save
    /// itself belongs to the frontend (packages/core/src/guess), so this is never written
    /// back. Never hold it across a call into the pipeline: `pipeline::label_for`
    /// looks the city up (`city_for_status` takes `resolved_city`) before locking it.
    pub guess_view: StdMutex<StoreView>,
    /// Whether the app has a tray icon to be reached and quit from: false only on a
    /// Linux session with no `StatusNotifierItem` host (see `tray_linux`), where
    /// General offers its own Quit instead. Probed once at launch.
    pub tray_available: AtomicBool,
    /// When updates were last checked for (Unix seconds), for About's "Last
    /// checked". Seeded from `update.meta.json` at launch and set by every check.
    pub last_update_check: StdMutex<Option<i64>>,
    /// User-facing strings for the windowless update flows, pushed from the
    /// frontend JSON locale files (see `UpdateStrings`). English until synced.
    pub update_strings: StdMutex<UpdateStrings>,
    pub running: Mutex<bool>,
    /// The run requests not yet taken up, and the last ticket handed out: each
    /// request is numbered and queued under this one lock, and each pass of the
    /// loop that holds `running` takes the work and reads the number under it too,
    /// so the `pipeline:end` it ends with can say which requests each pass served.
    /// The window waits on its own request's number for its outcome, rather than
    /// guessing which busy stretch was its own. See `pipeline::Requests`.
    /// In-memory only.
    pub requests: StdMutex<Requests>,
    /// The current map's run of failures, and when the scheduler's poll may try it
    /// again (`pipeline::note_outcome`). Cleared by a success. In-memory only: a
    /// launch tries afresh.
    pub failed_run: StdMutex<Option<FailedRun>>,
    pub quitting: AtomicBool,
    /// A launch the user made is waiting to show the window until its page has its
    /// first palette on (`commands::window_ready`), so a dark desktop doesn't first see the light defaults the page starts in.
    pub show_on_ready: AtomicBool,
    /// Signature of the render the wallpaper was last successfully applied for —
    /// see `pipeline::Target::signature`. In-memory only (None on launch →
    /// forces a reconcile at startup). The scheduler's poll compares it against
    /// `pipeline::desired_signature` to skip work when nothing has changed. A
    /// string (rather than a typed tuple) so it can key both the Daily rotation
    /// (by date + theme) and a Customized pin (by coordinates + theme) uniformly.
    pub last_applied: StdMutex<Option<String>>,
    /// What a date resolved to, once anything has looked: `Some(city)` for the
    /// schedule manifest's pick when a host served one, else the schedule state
    /// file's — and **`None` for "looked, and nothing can name this day"**. `Status`
    /// reads it through `pipeline::city_for_status`, which is the only way to name
    /// the day at all now that the client computes no rotation of its own.
    ///
    /// The inner `Option` is what keeps the negative answer memoized too. Its cost
    /// is asymmetric: a day whose cached payload predates the `city` envelope reads
    /// and parses tens of MB to learn nothing, and `Status` is rebuilt on every
    /// settings change — so a miss that isn't remembered is re-paid indefinitely.
    /// A negative entry can't go stale: the only way an answer appears later is a
    /// render, and every render goes through `pipeline::resolve_and_record`, which
    /// overwrites this with the city it resolved.
    ///
    /// In-memory only; see `city_for_status` for how a restart onto an
    /// already-rendered day recovers the answer from that day's cached payload.
    /// Only the Daily flow writes it — a Customized pin isn't a city and must not
    /// overwrite the day's answer.
    pub resolved_city: StdMutex<Option<(chrono::NaiveDate, Option<crate::city::City>)>>,
    /// Why the map for a target couldn't be had — the schedule or the CDN
    /// unreachable, Overpass refusing a pin — keyed by the target it was for
    /// (`pipeline::Target::key`: `daily:<date>` or `custom:<coords>`), or `None`
    /// once it's had. The window has no map to show then, and says why.
    ///
    /// It has to be state rather than a command's return value because **every**
    /// caller of `pipeline::run_now` is detached — `spawn_apply`,
    /// `spawn_force_regen` (which is what `regenerate_now` invokes) and the
    /// scheduler's `reconcile` all spawn and drop the `Result`. So a failure has no
    /// awaited `Result` to travel back on, and the only other trace is a log line
    /// the user never sees.
    ///
    /// The key is what keeps it honest: `Status` reports it only while it names the
    /// current target, so yesterday's failure doesn't indict a day nothing has tried
    /// yet (the scheduler pushes a snapshot on the rollover before it reconciles),
    /// and a pin's doesn't read as the schedule's.
    pub map_error: StdMutex<Option<(String, String)>>,
    /// Why the map, once had, didn't make it onto the desktop — the renderer timing
    /// out, the OS refusing it, a Linux desktop with no known way to set one — keyed
    /// like `map_error`. Only a run that puts the map on the desktop sets or clears
    /// it; turning syncing off clears it (`commands::set_sync`), since nothing is
    /// trying any more. The home shows it under the sync box until a run succeeds.
    pub wall_error: StdMutex<Option<(String, String)>>,
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
            sync_wallpaper: AtomicBool::new(cfg.sync_wallpaper),
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
            update_progress: StdMutex::new(None),
            update_cancel: AtomicBool::new(false),
            show_water: AtomicBool::new(cfg.show_water),
            show_airports: AtomicBool::new(cfg.show_airports),
            railway_style: StdMutex::new(cfg.railway_style),
            show_aerialways: AtomicBool::new(cfg.show_aerialways),
            variant: StdMutex::new(cfg.variant),
            dev_mode: AtomicBool::new(cfg.dev_mode),
            bypass_cache: AtomicBool::new(false),
            proxy_mode: StdMutex::new(cfg.proxy_mode),
            proxy_url: StdMutex::new(cfg.proxy_url.clone()),
            map_provider: StdMutex::new(cfg.map_provider),
            city_label: StdMutex::new(cfg.city_label),
            // Read from disk in `lib.rs`'s setup, which has the AppHandle that
            // locates it; empty until then.
            guess_view: StdMutex::new(StoreView::default()),
            // Probed and read in `lib.rs`'s setup, which has the AppHandle.
            tray_available: AtomicBool::new(true),
            last_update_check: StdMutex::new(None),
            update_strings: StdMutex::new(UpdateStrings::default()),
            running: Mutex::new(false),
            requests: StdMutex::new(Requests::default()),
            failed_run: StdMutex::new(None),
            quitting: AtomicBool::new(false),
            show_on_ready: AtomicBool::new(false),
            last_applied: StdMutex::new(None),
            resolved_city: StdMutex::new(None),
            map_error: StdMutex::new(None),
            wall_error: StdMutex::new(None),
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
