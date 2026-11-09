use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;

use crate::city::{self, City};
use crate::config::{
    self, CityLabel, ColorPair, CustomCity, MapProvider, ProxyMode, RailwayStyle, StylePreset,
    StyleVariant, ThemeMode, UpdateCheck, UpdateMode,
};
use crate::guess_store;
use crate::pipeline;
use crate::state::AppState;
use crate::tray;

/// The whole backend→frontend state contract, rebuilt by `build_status` and pushed
/// on every change. Mirrored field-for-field by `Status` in `apps/desktop/src/types.ts`, so a
/// field added here needs adding there too (and a `mark_status_dirty()` at whatever
/// mutates it, or an open window won't see it).
///
/// `rename_all` rather than a per-field `rename`: nothing type-checks this contract
/// across the IPC boundary, so a field whose hand-written rename was forgotten would
/// arrive at the frontend as snake_case and read `undefined` there — and a
/// `checked={undefined}` handed to a Radix `Switch` silently turns it into an
/// *uncontrolled* one, which moves on click and then resets on the next remount.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// Which map the app shows — General's "How to update?" selector.
    pub update_mode: UpdateMode,
    /// Whether that map is put on the desktop too — the home's "Sync to wallpaper".
    pub sync_wallpaper: bool,
    /// The Customized-mode pin, or `None` until the user applies one.
    pub custom: Option<CustomCity>,
    pub hide_tray: bool,
    pub running: bool,
    /// The city today's Daily wallpaper depicts, per `pipeline::city_for_status` —
    /// what was actually rendered, never a locally recomputed pick. `None` until the
    /// day has been resolved (first launch of a day, a fetch in flight, or one that
    /// couldn't reach the schedule): there's no client-side rotation to name a day
    /// with any more, so the home shows a placeholder. Informational when
    /// `update_mode` isn't `Daily`; a Customized pin is reported by `custom`.
    ///
    /// Sent even while today's guess-the-country game is underway: the game runs in
    /// the frontend (packages/core/src/guess, shared with the website, which has the city
    /// anyway) and needs the answer to score guesses. Keeping it off the screen until
    /// the day is revealed is the home's job.
    pub city: Option<City>,
    /// Which map the window should draw (`pipeline::Target::key`: `daily:<date>` or
    /// `custom:<coords>`), or `None` while Customized has no pin. The window fetches
    /// it with `get_map_data` once `map_ready`.
    pub map_key: Option<String>,
    /// Whether `map_key`'s data is cached, so `get_map_data` can hand it over.
    pub map_ready: bool,
    /// Which writing of that cache file this is: its modification time, in ms (0
    /// when not ready). The window reads the file again whenever it moves, so a map
    /// it couldn't read — or one Dev Mode fetched afresh — is picked up once the
    /// file is written again, without waiting for the key to change.
    pub map_rev: u64,
    /// Why `map_key`'s data couldn't be had, or `None` when it was or hasn't been
    /// tried yet. Read together with `map_ready`, it separates two states that look
    /// identical otherwise and call for opposite responses from the user:
    ///
    ///   - not ready, no error — the map is still on its way (first launch of a
    ///     day, a fetch in flight). Wait.
    ///   - not ready, an error — it can't be had. Not transient: a Daily map is
    ///     tried again in the background, backing off from 5 minutes to an hour; a
    ///     pin only when it's applied again (`pipeline::poll_may_run`).
    ///
    /// Scoped to the current map — see `AppState::map_error` for why that matters.
    pub map_error: Option<String>,
    /// Why the current map didn't make it onto the desktop, while syncing — see
    /// `AppState::wall_error`. Shown under the home's sync box until a run succeeds.
    pub wall_error: Option<String>,
    pub date: String,
    pub theme: ThemeMode,
    pub light: ColorPair,
    pub dark: ColorPair,
    pub style: StylePreset,
    pub update_check: UpdateCheck,
    /// Whether detected updates are installed automatically (see config field).
    pub auto_update: bool,
    /// The version we can update to, or `None`. Single source of truth for the
    /// "update available" affordance — see `AppState::available_update`.
    pub update_available: Option<String>,
    /// Percent complete of an in-flight update download. `None` outside a
    /// download, and also during one whose total size the host didn't report —
    /// the About tab then shows a bare "Downloading…" rather than a made-up
    /// number. Bundles are tens of MB and a blocked route can take twenty
    /// minutes, so without this the spinner is indistinguishable from a hang.
    pub update_progress: Option<u8>,
    /// Whether a download/install is in flight, from *any* path — the tray
    /// entry and auto-update both start one without a window involved.
    ///
    /// Here rather than left to the About tab's own click state, which is what
    /// it used to be: a tab that keyed off its own click showed "version X
    /// available" beside a running download and offered an "Install & restart"
    /// button whose only effect was to hit the concurrency guard and come back
    /// "up to date". Single source of truth, like `update_available`.
    pub update_installing: bool,
    /// Whether the in-app updater can apply an update to this install at all —
    /// false only for a Linux .deb/.rpm, whose updates belong to the system
    /// package manager. See `updates::supported`; the About tab hides its whole
    /// update section when this is false rather than offering a check that is
    /// guaranteed to fail. Not persisted: it's a property of how the running
    /// binary was installed, so it's recomputed every snapshot.
    pub updater_supported: bool,
    pub show_water: bool,
    pub show_airports: bool,
    /// Which symbol the railway layer is drawn in, or `Off`. See
    /// `config::RailwayStyle`.
    pub railway_style: RailwayStyle,
    pub show_aerialways: bool,
    /// Which visual language the wallpaper is drawn in (issue #18). See
    /// `config::Config::variant`.
    pub variant: StyleVariant,
    /// Whether the hidden Dev Mode tab is unlocked (persisted). See
    /// `AppState::dev_mode`.
    pub dev_mode: bool,
    /// Dev-only "bypass cache & CDN" toggle (in-memory, never persisted). See
    /// `AppState::bypass_cache`.
    pub bypass_cache: bool,
    pub proxy_mode: ProxyMode,
    pub proxy_url: String,
    pub map_provider: MapProvider,
    /// Where the wallpaper carries the city caption (Style tab). See `config::CityLabel`.
    pub city_label: CityLabel,
    /// Whether there's a tray icon to quit from — see `AppState::tray_available`.
    pub tray_available: bool,
    /// When updates were last checked for, Unix seconds, or `None` before the first.
    pub last_update_check: Option<i64>,
}

/// An error kept against a map (`AppState::map_error` / `wall_error`), but only
/// while that map is the current one — `key` is `Status::map_key`.
///
/// The key gate is what keeps a failure from outliving the map it was about.
/// `scheduler::spawn` pushes a fresh snapshot the moment the date rolls over and
/// only *then* reconciles, so for up to one poll the new day has been tried zero
/// times — and yesterday's message, shown over a map that just means "not started",
/// would read as the new day having already failed. Likewise a pin's failure must
/// not read as the schedule's once the mode is back on Daily.
fn error_for(stored: Option<&(String, String)>, key: Option<&str>) -> Option<String> {
    stored.filter(|(k, _)| Some(k.as_str()) == key).map(|(_, e)| e.clone())
}

/// `Status::map_rev` for a cache file: its modification time in ms. Every write
/// goes through a fresh temp file (`atomic::write`), so each one moves it. Never 0
/// for a file that's there, so 0 can mean "none".
fn file_rev(meta: &std::fs::Metadata) -> u64 {
    let ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64);
    ms.max(1)
}

/// Build the current `Status` snapshot. Shared by the `get_status` command
/// (initial mount fetch) and the status-emitter task (push on every change).
pub async fn build_status(app: &AppHandle) -> Status {
    let state = app.state::<AppState>();
    let date = city::today();
    // The city the pipeline actually rendered — `None` until it has resolved one
    // (see `city_for_status`). Deliberately not a second, independent pick: that
    // would disagree with the schedule on every day served from it (issue #1), and
    // this drives the home's city card: its name, coordinates and Wikipedia / Maps links.
    let city = pipeline::city_for_status(app, date);
    let map = pipeline::current_map(app);
    let running = *state.running.lock().await;
    // Every lock is read into a local *before* the literal, and the literal itself
    // must stay free of `.lock()` calls. A guard created in a field initializer
    // lives until the end of the whole `let` statement (struct fields are not
    // temporary scopes), so a second acquisition further down the literal re-enters
    // a non-reentrant `StdMutex` and hangs this task forever — which, since this is
    // the only thing that feeds `status:changed`, silently freezes the entire UI.
    // That is what the old `bypass_cache: state.effective_bypass_cache()` field did
    // to the `update_mode` guard an earlier field in the same literal was holding.
    let theme = *state.theme.lock().unwrap();
    let update_mode = *state.update_mode.lock().unwrap();
    let custom = *state.custom.lock().unwrap();
    let light = state.light.lock().unwrap().clone();
    let dark = state.dark.lock().unwrap().clone();
    let style = *state.style.lock().unwrap();
    let update_check = *state.update_check.lock().unwrap();
    let update_available = state.available_update.lock().unwrap().clone();
    let update_progress = *state.update_progress.lock().unwrap();
    let variant = *state.variant.lock().unwrap();
    let railway_style = *state.railway_style.lock().unwrap();
    let proxy_url = state.proxy_url.lock().unwrap().clone();
    let map_provider = *state.map_provider.lock().unwrap();
    let city_label = *state.city_label.lock().unwrap();
    let sync_wallpaper = state.sync_wallpaper.load(Ordering::Acquire);
    let map_key = map.as_ref().map(|(key, _)| key.clone());
    let (map_ready, map_rev) = match map.as_ref().map(|(_, path)| std::fs::metadata(path)) {
        Some(Ok(meta)) => (true, file_rev(&meta)),
        _ => (false, 0),
    };
    let map_error = error_for(state.map_error.lock().unwrap().as_ref(), map_key.as_deref());
    let wall_error = if sync_wallpaper {
        error_for(state.wall_error.lock().unwrap().as_ref(), map_key.as_deref())
    } else {
        None
    };
    let proxy_mode = *state.proxy_mode.lock().unwrap();
    let last_update_check = *state.last_update_check.lock().unwrap();
    Status {
        update_mode,
        sync_wallpaper,
        custom,
        hide_tray: state.hide_tray.load(Ordering::Acquire),
        running,
        city,
        map_key,
        map_ready,
        map_rev,
        map_error,
        wall_error,
        date: date.to_string(),
        theme,
        light,
        dark,
        style,
        update_check,
        auto_update: state.auto_update.load(Ordering::Acquire),
        update_available,
        update_progress,
        update_installing: state.update_installing.load(Ordering::Acquire),
        updater_supported: crate::updates::supported(),
        show_water: state.show_water.load(Ordering::Acquire),
        show_airports: state.show_airports.load(Ordering::Acquire),
        railway_style,
        show_aerialways: state.show_aerialways.load(Ordering::Acquire),
        variant,
        dev_mode: state.dev_mode.load(Ordering::Acquire),
        // Reuses the `update_mode` read above rather than taking the lock again, so
        // the two fields can't contradict each other within one snapshot.
        bypass_cache: state.bypass_cache_for(update_mode),
        proxy_mode,
        proxy_url,
        map_provider,
        city_label,
        tray_available: state.tray_available.load(Ordering::Acquire),
        last_update_check,
    }
}

#[tauri::command]
pub async fn get_status(app: AppHandle) -> Result<Status, String> {
    Ok(build_status(&app).await)
}

/// Set which map the app shows (Daily / Customized) — General's selector.
/// Persists and brings the new mode's map in: rendered afresh from the cached map
/// data and set as the wallpaper while syncing, only fetched otherwise; Customized
/// is a no-op until a pin is applied.
#[tauri::command]
pub fn set_update_mode(app: AppHandle, mode: UpdateMode) -> Result<(), String> {
    let state = app.state::<AppState>();
    let before = std::mem::replace(&mut *state.update_mode.lock().unwrap(), mode);
    // All or nothing, as `apply_map_settings`: a mode that couldn't be written is put back.
    if let Err(e) = persist(&app) {
        *state.update_mode.lock().unwrap() = before;
        return Err(e);
    }
    state.mark_status_dirty();
    pipeline::spawn_apply(app.clone());
    Ok(())
}

/// The home's "Sync to wallpaper" box. Turned on, returns the ticket of the run
/// that paints the desktop (`pipeline::spawn_run`), whose end the box waits on.
#[tauri::command]
pub fn set_sync_wallpaper(app: AppHandle, on: bool) -> Result<Option<u64>, String> {
    set_sync(&app, on)
}

/// Turn syncing on or off, from the home's box or the tray's check item. On, the
/// current map is drawn and set straight away — a force regen, since what the
/// desktop shows meanwhile may be anything — and its ticket returned. Off leaves the
/// desktop with whatever it has: there's no telling what the user had before
/// InkCity, so nothing is put back. A wallpaper failure is forgotten either way —
/// nothing is trying any more, or the run starting now will say again. If the
/// switch can't be written, it's put back and nothing else happens.
pub fn set_sync(app: &AppHandle, on: bool) -> Result<Option<u64>, String> {
    let state = app.state::<AppState>();
    let before = state.sync_wallpaper.swap(on, Ordering::AcqRel);
    if let Err(e) = persist(app) {
        state.sync_wallpaper.store(before, Ordering::Release);
        return Err(e);
    }
    *state.wall_error.lock().unwrap() = None;
    tray::sync_sync_to_tray(app);
    state.mark_status_dirty();
    if on {
        Ok(Some(pipeline::spawn_force_regen(app.clone())))
    } else {
        // What the target is changes (a fetch, not a render): the poll would get
        // there too, this just doesn't wait for it.
        pipeline::spawn_apply(app.clone());
        Ok(None)
    }
}

/// Apply a Customized-mode pin: store the coordinates, switch to Customized
/// mode, and render that location. Coordinates are validated on the frontend
/// (see core/coords.ts).
#[tauri::command]
pub fn apply_custom_city(app: AppHandle, lat: f64, lon: f64) -> Result<u64, String> {
    let state = app.state::<AppState>();
    let before = (*state.custom.lock().unwrap(), *state.update_mode.lock().unwrap());
    *state.custom.lock().unwrap() = Some(CustomCity { lat, lon });
    *state.update_mode.lock().unwrap() = UpdateMode::Customized;
    // All or nothing, as `apply_map_settings`: a pin that couldn't be written is put back.
    if let Err(e) = persist(&app) {
        *state.custom.lock().unwrap() = before.0;
        *state.update_mode.lock().unwrap() = before.1;
        return Err(e);
    }
    // Applying a pin is trying it again: kept, the last try's failure — the same
    // pin's, applied again — would hide the fetch this starts (not ready, no
    // error), and the pin line would sit unlocked over a stale reason.
    *state.map_error.lock().unwrap() = None;
    state.mark_status_dirty();
    // The run's ticket: the pin line settles once the `pipeline:end` that serves it
    // is in, rather than reading it off a status push that may predate the apply.
    Ok(pipeline::spawn_apply(app.clone()))
}

/// Name lookup for the Customized-mode input (issue #11): the bundled city list
/// filtered by `query`, best match first. Searched in the backend because the
/// list already lives there (see `city::search`) — shipping the whole schedule
/// pool to the webview just to filter it would only bloat the bundle.
#[tauri::command]
pub fn search_cities(query: String) -> Vec<City> {
    city::search(&query, 8)
}

#[tauri::command]
pub fn set_hide_tray(app: AppHandle, hide: bool) -> Result<(), String> {
    app.state::<AppState>().hide_tray.store(hide, Ordering::Release);
    tray::apply_hide_tray(&app, hide);
    app.state::<AppState>().mark_status_dirty();
    persist(&app)
}

/// Purely a UI preference, so nothing re-renders — the wallpaper is drawn from
/// OpenStreetMap data whichever service is picked.
#[tauri::command]
pub fn set_map_provider(app: AppHandle, provider: MapProvider) -> Result<(), String> {
    let state = app.state::<AppState>();
    *state.map_provider.lock().unwrap() = provider;
    state.mark_status_dirty();
    persist(&app)
}

#[tauri::command]
pub fn set_update_check(app: AppHandle, value: UpdateCheck) -> Result<(), String> {
    let state = app.state::<AppState>();
    *state.update_check.lock().unwrap() = value;
    // Auto-update rides this cadence; `Never` means no automatic checks fire, so
    // it can't auto-install — turn it off so the (now-disabled) UI switch and the
    // persisted state stay consistent.
    if value == UpdateCheck::Never {
        state.auto_update.store(false, Ordering::Release);
    }
    state.mark_status_dirty();
    persist(&app)
}

/// Toggle automatic install-and-relaunch of detected updates. Only meaningful
/// with a non-`Never` cadence (the frontend disables the switch otherwise).
#[tauri::command]
pub fn set_auto_update(app: AppHandle, on: bool) -> Result<(), String> {
    app.state::<AppState>().auto_update.store(on, Ordering::Release);
    app.state::<AppState>().mark_status_dirty();
    persist(&app)
}

/// Manual "Check now" — bypasses the cadence gate. Returns the available
/// version string, or `None` when already up to date. Updates the shared state
/// (tray entry + General affordance) as a side effect.
#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> Result<Option<String>, String> {
    crate::updates::do_check(&app, true).await.map_err(|e| e.to_string())
}

/// Install the available update and relaunch. On success this never returns
/// (the app restarts). Returns `Ok(false)` when there's nothing to install.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<bool, String> {
    crate::updates::install_now(&app).await.map_err(|e| e.to_string())
}

/// Ask the in-flight update download to stop. Always `Ok`: there is nothing to
/// fail, and nothing to report — a cancel that finds no download running has
/// already got what the user wanted.
#[tauri::command]
pub fn cancel_update(app: AppHandle) -> Result<(), String> {
    crate::updates::cancel(&app);
    Ok(())
}

/// Push the localized strings for the windowless update flows (notification +
/// native dialogs) from the frontend, mirroring `update_tray_labels`. Keeps
/// translations in the JSON locale files as the single source of truth.
#[tauri::command]
pub fn set_update_strings(
    app: AppHandle,
    strings: crate::updates::UpdateStrings,
) -> Result<(), String> {
    *app.state::<AppState>().update_strings.lock().unwrap() = strings;
    Ok(())
}

/// Everything the Style and Lab tabs set, as one value: they share one draft and
/// one Save (`apply_map_settings`). Doubles as the command payload and as the
/// before/after snapshot the save diffs, so a new map setting is one field here.
///
/// `variant` is the palette: the user's own `light`/`dark`, or Mondrian's
/// (`config::Config::variant`).
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MapSettings {
    pub theme: ThemeMode,
    pub style: StylePreset,
    pub variant: StyleVariant,
    pub light: ColorPair,
    pub dark: ColorPair,
    pub city_label: CityLabel,
    pub show_airports: bool,
    pub show_water: bool,
    pub railway_style: RailwayStyle,
    pub show_aerialways: bool,
}

/// The map settings as currently held in `AppState`.
fn map_settings(state: &AppState) -> MapSettings {
    MapSettings {
        theme: *state.theme.lock().unwrap(),
        style: *state.style.lock().unwrap(),
        variant: *state.variant.lock().unwrap(),
        light: state.light.lock().unwrap().clone(),
        dark: state.dark.lock().unwrap().clone(),
        city_label: *state.city_label.lock().unwrap(),
        show_airports: state.show_airports.load(Ordering::Acquire),
        show_water: state.show_water.load(Ordering::Acquire),
        railway_style: *state.railway_style.lock().unwrap(),
        show_aerialways: state.show_aerialways.load(Ordering::Acquire),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    /// The re-render's ticket (`pipeline::spawn_run`), or `None` when there's none:
    /// the UI waits for the `pipeline:end` that serves it, and reads how it went there.
    pub ticket: Option<u64>,
}

/// The Style and Lab tabs' one Save: write every map setting at once, then — while
/// syncing — re-render the wallpaper once for all of it. Returns that re-render's
/// ticket, if it started one.
///
/// A save re-renders only when what a render draws with has moved (`render_inputs`):
/// the other theme's palette, System for the theme it comes to, or the caption's
/// corner while today is unrevealed change nothing on the desktop — and setting the
/// same picture again costs a render and, on macOS 27, another copy in the OS's
/// wallpaper cache, which the app can't clear. It reports a re-render only when
/// there's one to wait for: with syncing off, or no pin, there's none.
///
/// All or nothing: if the settings can't be written, the ones held before are put
/// back and the error returned, so the app never runs on settings the next launch
/// won't start with.
#[tauri::command]
pub fn apply_map_settings(app: AppHandle, settings: MapSettings) -> Result<ApplyResult, String> {
    let state = app.state::<AppState>();
    let before = map_settings(&state);
    let drawn = render_inputs(&app);
    hold_map_settings(&state, settings);
    if let Err(e) = persist(&app) {
        hold_map_settings(&state, before);
        return Err(e);
    }
    // Push the new settings immediately, even when no re-render is triggered below
    // (a render, if any, will mark dirty again on completion).
    state.mark_status_dirty();

    let regen = state.sync_wallpaper.load(Ordering::Acquire)
        && pipeline::desired_signature(&app).is_some()
        && render_inputs(&app) != drawn;
    Ok(ApplyResult { ticket: regen.then(|| pipeline::spawn_force_regen(app.clone())) })
}

/// Hold `s` as the map settings, in `AppState`.
fn hold_map_settings(state: &AppState, s: MapSettings) {
    let MapSettings {
        theme,
        style,
        variant,
        light,
        dark,
        city_label,
        show_airports,
        show_water,
        railway_style,
        show_aerialways,
    } = s;
    *state.theme.lock().unwrap() = theme;
    *state.style.lock().unwrap() = style;
    *state.variant.lock().unwrap() = variant;
    *state.light.lock().unwrap() = light;
    *state.dark.lock().unwrap() = dark;
    *state.city_label.lock().unwrap() = city_label;
    state.show_airports.store(show_airports, Ordering::Release);
    state.show_water.store(show_water, Ordering::Release);
    *state.railway_style.lock().unwrap() = railway_style;
    state.show_aerialways.store(show_aerialways, Ordering::Release);
}

/// What a render of the current target draws with, of all the map settings hold:
/// the palette of the theme in effect, the preset, the variant and the layers
/// (`pipeline::render_bytes` reads the same), plus the target's signature — that
/// theme, and the caption if it's showing. Equal before and after a save, the
/// desktop would get the same picture again.
fn render_inputs(app: &AppHandle) -> impl PartialEq {
    let state = app.state::<AppState>();
    // One lock per statement: a guard taken inside the tuple would be held to its end.
    let colors = pipeline::colors_for(app, pipeline::effective_theme(app));
    let style = *state.style.lock().unwrap();
    let variant = *state.variant.lock().unwrap();
    let railway_style = *state.railway_style.lock().unwrap();
    let layers = (
        state.show_water.load(Ordering::Acquire),
        state.show_airports.load(Ordering::Acquire),
        state.show_aerialways.load(Ordering::Acquire),
    );
    let target = pipeline::desired_signature(app);
    (colors, style, variant, railway_style, layers, target)
}

/// Dev Mode's "bypass cache & CDN" toggle (see `AppState::bypass_cache`). Only
/// flips the flag; the next render picks it up — toggling never kicks off a
/// render on its own.
#[tauri::command]
pub fn set_bypass_cache(app: AppHandle, on: bool) -> Result<(), String> {
    let state = app.state::<AppState>();
    state.bypass_cache.store(on, Ordering::Release);
    state.mark_status_dirty();
    Ok(())
}

/// Unlock or hide the Dev Mode tab. Toggled by the 7-click gesture on the
/// version number in About. Persisted (see `Config::dev_mode`) so the tab stays
/// unlocked across restarts.
#[tauri::command]
pub fn set_dev_mode(app: AppHandle, on: bool) -> Result<(), String> {
    let state = app.state::<AppState>();
    let before = state.dev_mode.swap(on, Ordering::AcqRel);
    if let Err(e) = persist(&app) {
        state.dev_mode.store(before, Ordering::Release);
        return Err(e);
    }
    state.mark_status_dirty();
    // Locking the tab makes every `dev_mode`-gated Dev Mode switch/setting read
    // as off (today just `bypass_cache`; see `AppState::effective_bypass_cache`);
    // no render is kicked off here.
    Ok(())
}

/// Persist + apply the Proxy setting. A custom URL is validated up front (so the
/// UI can surface a bad value) before it's applied. The osm-cli sidecar picks the
/// route up from its environment on its next spawn (see `osm_sidecar::fetch`), so
/// no restart is needed. All or nothing: requests only take the new route once it's
/// on disk, and a failed write puts the old setting back.
#[tauri::command]
pub fn apply_proxy_settings(app: AppHandle, mode: ProxyMode, url: String) -> Result<(), String> {
    let url = url.trim().to_string();
    if mode == ProxyMode::Custom && !url.is_empty() {
        // Reject a malformed URL up front so the user sees the error immediately,
        // rather than silently falling back to a direct connection later.
        reqwest::Proxy::all(&url).map_err(|e| format!("Invalid proxy URL: {e}"))?;
    }
    let state = app.state::<AppState>();
    // Each guard lets go at the end of its statement: `persist` takes both locks.
    let before_mode = std::mem::replace(&mut *state.proxy_mode.lock().unwrap(), mode);
    let before_url = std::mem::replace(&mut *state.proxy_url.lock().unwrap(), url.clone());
    if let Err(e) = persist(&app) {
        *state.proxy_mode.lock().unwrap() = before_mode;
        *state.proxy_url.lock().unwrap() = before_url;
        return Err(e);
    }
    crate::proxy::set(crate::proxy::Route::from_setting(mode, &url));
    state.mark_status_dirty();
    Ok(())
}

/// The OS's proxy as it's set this moment, for General to show beside its System
/// choice — `None` when there isn't one. A subprocess on macOS, so a command the
/// tab calls when it needs it rather than a `Status` field rebuilt on every push.
#[tauri::command]
pub async fn get_system_proxy() -> Option<String> {
    tauri::async_runtime::spawn_blocking(crate::proxy::system_now).await.ok().flatten()
}

/// General's "Test connection": reach the CDN, GitHub and Overpass through the
/// route `mode` and `url` describe — the address as typed, applied or not.
#[tauri::command]
pub async fn test_proxy(mode: ProxyMode, url: String) -> Vec<crate::proxy::Probe> {
    let proxy = match mode {
        // Read now, not through the half-minute cache: a test is a fresh look.
        ProxyMode::System => get_system_proxy().await,
        _ => crate::proxy::Route::from_setting(mode, &url).url(),
    };
    crate::proxy::test(proxy).await
}

/// The current map's cached data (the one `Status::map_key` names) — the day's or
/// the pin's `.osm.json`, the same file the wallpaper is drawn from — as raw bytes for the
/// window to draw. Tens of MB for a big city, so it's read off the main thread and
/// handed over as a binary response, never as a JSON string.
#[tauri::command]
pub async fn get_map_data(app: AppHandle) -> Result<tauri::ipc::Response, String> {
    let (_, path) = pipeline::current_map(&app).ok_or("no map to show")?;
    let bytes = tauri::async_runtime::spawn_blocking(move || std::fs::read(path))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("map data not available yet: {e}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// The page has its palette on: a launch waiting to show the window
/// (`AppState::show_on_ready`) shows it now, in its own colours from the first frame.
/// `paper` (`#rrggbb`) is what the window itself is filled with behind the page, so
/// nothing of another colour shows before the page paints — or at an edge while
/// it's resized. Called again whenever the paper changes: only the first call can
/// show the window.
#[tauri::command]
pub fn window_ready(app: AppHandle, paper: Option<String>) {
    if let (Some(color), Some(main)) = (paper.as_deref().and_then(hex_color), app.get_webview_window("main")) {
        let _ = main.set_background_color(Some(color));
    }
    show_main_if_waiting(&app);
}

/// `#rrggbb` as an opaque colour, or `None` for anything else.
fn hex_color(hex: &str) -> Option<tauri::window::Color> {
    let digits = hex.strip_prefix('#').filter(|h| h.len() == 6)?;
    let n = u32::from_str_radix(digits, 16).ok()?;
    Some(tauri::window::Color((n >> 16) as u8, (n >> 8) as u8, n as u8, 255))
}

/// Show and focus the main window if a launch is still waiting to — once.
fn show_main_if_waiting(app: &AppHandle) {
    if !app.state::<AppState>().show_on_ready.swap(false, Ordering::AcqRel) {
        return;
    }
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.set_focus();
        crate::events::FrontendEvent::WindowShown.emit(app);
    }
}

/// Render and set the current map again. Returns the run's ticket
/// (`pipeline::spawn_run`): the window says how it went once that run has ended.
#[tauri::command]
pub async fn regenerate_now(app: AppHandle) -> Result<u64, String> {
    Ok(pipeline::spawn_force_regen(app))
}

/// The guess-the-country save as it is on disk (`guess.json`), or `None` before the
/// first save. The desktop's `GuessStorage.load` — see apps/desktop/src/lib/guess-storage.ts; the
/// website's equivalent reads localStorage.
///
/// Also re-reads the backend's own view of it: the file is normally only ever
/// written through `guess_store_write`, but Dev Mode hands it out for editing by
/// hand, and the window reads it again after each Dev Mode rewrite and, while Dev
/// Mode is on, whenever it's focused — so an edit takes effect, wallpaper caption
/// included, once the window is clicked back into.
#[tauri::command]
pub fn guess_store_read(app: AppHandle) -> Result<Option<String>, String> {
    let raw = guess_store::read(&app).map_err(|e| e.to_string())?;
    let view = raw.as_deref().and_then(guess_store::StoreView::parse).unwrap_or_default();
    adopt_guess_view(app, view);
    Ok(raw)
}

/// Persist the guess-the-country save (`GuessStorage.save`). An `Err` means nothing
/// was written, and the frontend keeps its previous state.
///
/// Writing is also how the backend learns that today has been revealed — a guess
/// that ended the game, or the game being switched off (`showCityInfo`). If that moves
/// the wallpaper's caption, the captioned render is a new target
/// (`pipeline::render_signature`), so an ordinary apply renders it — queued behind any
/// render already running (`pipeline::drive`), and backed by the scheduler's
/// poll, which sees the signature change if that render fails. Returns that run's
/// ticket, if the write started one (`pipeline::spawn_run`): the home says when the
/// caption is on the desktop.
#[tauri::command]
pub fn guess_store_write(app: AppHandle, raw: String) -> Result<Option<u64>, String> {
    let view = guess_store::write(&app, &raw).map_err(|e| e.to_string())?;
    Ok(adopt_guess_view(app, view))
}

/// Swap in a fresh view of the save. A no-op when it's the view already held — a
/// guess that didn't end the game, the home re-reading an unchanged file. If it
/// did change, re-apply the wallpaper should that have moved its target — a day
/// revealed (a game won, lost or given up, the preference turned on) moves its city
/// caption, as does one un-revealed again through Dev Mode — and mark status dirty:
/// no `Status` field changes, but the push is what re-checks the tray's "Open Game"
/// entry (`tray::sync_open_item`). Returns the ticket of the run it started, if any.
fn adopt_guess_view(app: AppHandle, view: guess_store::StoreView) -> Option<u64> {
    let state = app.state::<AppState>();
    {
        let mut current = state.guess_view.lock().unwrap();
        if *current == view {
            return None;
        }
        *current = view;
    }
    state.mark_status_dirty();
    (!pipeline::up_to_date(&app)).then(|| pipeline::spawn_apply(app))
}

/// Dev Mode: show the guess-the-country save in Finder / Explorer / the file
/// manager, for editing by hand (`guess_store_read` picks the edit up). Before the
/// first save there's no file to point at, so its folder opens instead.
#[tauri::command]
pub fn reveal_guess_store(app: AppHandle) -> Result<(), String> {
    let path = guess_store::path(&app).map_err(|e| e.to_string())?;
    if path.exists() {
        return app.opener().reveal_item_in_dir(&path).map_err(|e| e.to_string());
    }
    open_dir(&app, path.parent().ok_or("guess.json has no parent directory")?)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewResult {
    pub city: City,
    pub date: String,
    /// Base64-encoded PNG, ready for an `<img src="data:image/png;base64,...">`.
    pub png_base64: String,
    /// Where the same PNG landed in the day cache
    /// (`wallpaper/daily/<date>.png`). Handed back so double-clicking the
    /// preview can open that file — see `open_preview_image`.
    pub png_path: String,
}

/// Dev Mode's "Advance Preview": render (without applying) the city map for
/// `days_ahead` days from today, so a developer can see an upcoming
/// rotation day without waiting for it or touching the real wallpaper.
#[tauri::command]
pub async fn preview_city(app: AppHandle, days_ahead: i64) -> Result<PreviewResult, String> {
    let date = city::today() + chrono::Duration::days(days_ahead);
    let (city, bytes, png_path) =
        pipeline::render_preview(&app, date).await.map_err(|e| e.to_string())?;
    Ok(PreviewResult {
        city,
        date: date.to_string(),
        png_base64: base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes),
        png_path: png_path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub fn renderer_ready(state: State<'_, AppState>) {
    state.renderer_ready.store(true, Ordering::Release);
    state.renderer_notify.notify_waiters();
}

#[tauri::command]
pub async fn submit_render_result(
    state: State<'_, AppState>,
    date: String,
    bytes: Vec<u8>,
) -> Result<(), String> {
    // Take only a match: a late result from a job that already timed out must leave
    // the *current* job's channel in place, or that job loses its result too and
    // fails as "renderer dropped".
    let mut g = state.pending.lock().await;
    if let Some(p) = g.take_if(|p| p.date == date) {
        let _ = p.tx.send(bytes);
    } else if let Some(p) = g.as_ref() {
        log::warn!("[commands] stale render result for {}, expected {}", date, p.date);
    } else {
        log::warn!("[commands] render result for {date} arrived with no job pending");
    }
    Ok(())
}

#[tauri::command]
pub fn update_tray_labels(
    open_settings: String,
    open_game: String,
    sync_wallpaper: String,
    regenerate_now: String,
    quit: String,
    update_available: String,
) -> Result<(), String> {
    tray::update_labels(
        &open_settings,
        &open_game,
        &sync_wallpaper,
        &regenerate_now,
        &quit,
        &update_available,
    );
    Ok(())
}

#[tauri::command]
pub fn quit_app(app: AppHandle) -> Result<(), String> {
    app.state::<AppState>().quitting.store(true, Ordering::Release);
    app.exit(0);
    Ok(())
}

/// Reveal the log directory (see the `tauri_plugin_log` registration in
/// lib.rs) in Finder/Explorer, so a user reporting a bug can find and attach
/// the log file without knowing the platform-specific path themselves.
#[tauri::command]
pub fn open_log_dir(app: AppHandle) -> Result<(), String> {
    open_dir(&app, &app.path().app_log_dir().map_err(|e| e.to_string())?)
}

/// Open `dir` in the platform's file manager, creating it first if need be.
fn open_dir(app: &AppHandle, dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    app.opener().open_path(dir.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())
}

/// Whether General shows its "Wallpaper cache" row — see `wallpaper_cache_dirs`.
#[tauri::command]
pub fn has_wallpaper_cache(app: AppHandle) -> bool {
    !wallpaper_cache_dirs(&app).is_empty()
}

/// General's "Show in Finder": open each of macOS's wallpaper cache folders, so the
/// user can empty them by hand.
#[tauri::command]
pub fn open_wallpaper_cache(app: AppHandle) -> Result<(), String> {
    for dir in wallpaper_cache_dirs(&app) {
        app.opener().open_path(dir.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// macOS's own caches of the images it's handed as wallpaper: the wallpaper agent
/// keeps a decoded `.bmp` (W×H×4 bytes, ~30 MB on a laptop screen) and the image
/// extension a copy of each source file. Every daily set adds to both, and since
/// macOS 27 neither is ever evicted — gigabytes within weeks (reported to Apple as
/// FB25321510). Both sit in other apps' containers, which TCC won't let us read or
/// prune, but `is_dir` is only a stat (allowed) and Finder can open them. Macs
/// before Sonoma have neither folder, and the other platforms nothing like them, so
/// an empty list hides the row.
fn wallpaper_cache_dirs(app: &AppHandle) -> Vec<PathBuf> {
    if !cfg!(target_os = "macos") {
        return Vec::new();
    }
    let Ok(home) = app.path().home_dir() else { return Vec::new() };
    [
        "Library/Containers/com.apple.wallpaper.agent/Data/Library/Caches/com.apple.wallpaper.caches/extension-com.apple.wallpaper.extension.image",
        "Library/Containers/com.apple.wallpaper.extension.image/Data/Library/Caches",
    ]
    .iter()
    .map(|p| home.join(p))
    .filter(|p| p.is_dir())
    .collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanCacheResult {
    /// Number of cache files deleted.
    pub removed_files: usize,
    /// Total size of the deleted files, in bytes.
    pub freed_bytes: u64,
}

/// Dev Mode's "Clean cache": wipe the whole wallpaper cache — the downloaded OSM
/// data and rendered wallpapers under `wallpaper/{daily,customized}/` plus the
/// live copies — and any legacy flat artifacts left by pre-reorg versions (see
/// `pipeline::wipe_cache`). The cache is fully regenerable: the next render
/// re-fetches from the CDN / sidecar and re-renders. Returns how many files were
/// removed and how many bytes were freed, for UI feedback.
#[tauri::command]
pub fn clean_cache(app: AppHandle) -> Result<CleanCacheResult, String> {
    let (removed_files, freed_bytes) = pipeline::wipe_cache(&app).map_err(|e| e.to_string())?;
    log::info!("[commands] clean_cache removed {} files ({} bytes)", removed_files, freed_bytes);
    // The current map went with the rest: say so, and have it again — a force run,
    // since what was last applied still matches the target and the poll would take
    // the app for up to date with nothing cached.
    app.state::<AppState>().mark_status_dirty();
    pipeline::spawn_force_regen(app.clone());
    Ok(CleanCacheResult { removed_files, freed_bytes })
}

/// Open a cached render in the OS default image viewer, so the Dev Mode Advance
/// Preview can be inspected full-size. Nothing is exported: `render_preview`
/// already wrote this PNG into the day cache, and `path` is the `pngPath` its
/// `PreviewResult` carried back.
///
/// Refuses anything outside the app cache dir (canonicalized on both sides, so a
/// symlinked cache root still matches), and reports a missing file as such: Clean
/// cache sits above this control and can leave a previously returned path stale.
/// The original `path` is what gets opened — a canonicalized Windows path is
/// `\\?\C:\…`, which not every shell handler accepts.
#[tauri::command]
pub fn open_preview_image(app: AppHandle, path: String) -> Result<(), String> {
    let file = std::path::Path::new(&path);
    let real = file.canonicalize().map_err(|_| "image is no longer in the cache".to_string())?;
    let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    let cache = cache.canonicalize().map_err(|e| e.to_string())?;
    if !real.starts_with(&cache) {
        return Err(format!("refusing to open {path}: outside the cache"));
    }
    app.opener().open_path(&path, None::<&str>).map_err(|e| e.to_string())
}

fn persist(app: &AppHandle) -> Result<(), String> {
    let s = app.state::<AppState>();
    let cfg = config::Config {
        update_mode: *s.update_mode.lock().unwrap(),
        sync_wallpaper: s.sync_wallpaper.load(Ordering::Acquire),
        custom: *s.custom.lock().unwrap(),
        hide_tray: s.hide_tray.load(Ordering::Acquire),
        theme: *s.theme.lock().unwrap(),
        light: s.light.lock().unwrap().clone(),
        dark: s.dark.lock().unwrap().clone(),
        style: *s.style.lock().unwrap(),
        update_check: *s.update_check.lock().unwrap(),
        auto_update: s.auto_update.load(Ordering::Acquire),
        show_water: s.show_water.load(Ordering::Acquire),
        show_airports: s.show_airports.load(Ordering::Acquire),
        railway_style: *s.railway_style.lock().unwrap(),
        show_aerialways: s.show_aerialways.load(Ordering::Acquire),
        variant: *s.variant.lock().unwrap(),
        dev_mode: s.dev_mode.load(Ordering::Acquire),
        proxy_mode: *s.proxy_mode.lock().unwrap(),
        proxy_url: s.proxy_url.lock().unwrap().clone(),
        map_provider: *s.map_provider.lock().unwrap(),
        city_label: *s.city_label.lock().unwrap(),
    };
    config::save(app, &cfg).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    // A map that isn't ready is either still on its way or can't be had;
    // `map_error` is the only thing that tells those apart (see the field's docs).
    // So it's pinned here, along with the key gate that stops one map's failure
    // from being read as another's — the scheduler pushes a snapshot on the rollover
    // before it has retried even once, and a pin's failure isn't the schedule's.

    #[test]
    fn error_for_surfaces_the_current_maps_failure() {
        let stored = ("daily:2026-08-13".to_string(), "no manifest and no schedule state".to_string());
        assert_eq!(
            error_for(Some(&stored), Some("daily:2026-08-13")).as_deref(),
            Some("no manifest and no schedule state")
        );
    }

    #[test]
    fn error_for_drops_a_failure_from_another_day_or_a_pin() {
        let stored = ("daily:2026-08-12".to_string(), "no manifest and no schedule state".to_string());
        assert_eq!(error_for(Some(&stored), Some("daily:2026-08-13")), None);
        let pin = ("custom:1.5000_2.5000".to_string(), "overpass timed out".to_string());
        assert_eq!(error_for(Some(&pin), Some("daily:2026-08-13")), None);
        assert_eq!(error_for(Some(&pin), None), None);
    }

    #[test]
    fn error_for_is_none_when_nothing_has_failed() {
        assert_eq!(error_for(None, Some("daily:2026-08-13")), None);
    }
}
