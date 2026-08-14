use std::sync::atomic::Ordering;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;

use crate::city::{self, City};
use crate::config::{
    self, ColorPair, CustomCity, RailwayStyle, StylePreset, StyleVariant, ThemeMode, UpdateCheck,
    UpdateMode,
};
use crate::pipeline::{self, EffectiveTheme};
use crate::state::AppState;
use crate::tray;

/// The whole backend→frontend state contract, rebuilt by `build_status` and pushed
/// on every change. Mirrored field-for-field by `Status` in `src/types.ts`, so a
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
    /// How the wallpaper is refreshed — the City-tab "How to update?" selector.
    pub update_mode: UpdateMode,
    /// The Customized-mode pin, or `None` until the user applies one.
    pub custom: Option<CustomCity>,
    pub hide_tray: bool,
    pub running: bool,
    /// The city today's Daily wallpaper depicts, per `pipeline::city_for_status` —
    /// what was actually rendered, never a locally recomputed pick. `None` until the
    /// day has been resolved (first launch of a day, a render in flight, or one that
    /// couldn't reach the schedule): there's no client-side rotation to name a day
    /// with any more, so the City tab shows a placeholder. Informational when
    /// `update_mode` isn't `Daily`; a Customized pin is reported by `custom`.
    pub city: Option<City>,
    /// Why today's Daily render failed, or `None` when it succeeded or hasn't run
    /// yet. Read together with `city`, it separates two states that look identical
    /// otherwise and call for opposite responses from the user:
    ///
    ///   - `city: None`, `last_error: None` — the day is still resolving (first
    ///     launch of a day, a render in flight). Wait.
    ///   - `city: None`, `last_error: Some(_)` — the day can't be resolved. Not
    ///     transient; the poll will keep retrying and keep failing until the
    ///     network changes.
    ///
    /// The second state is new: while the client still had the population rotation
    /// as its last rung it could always name a day locally, so an unnameable day
    /// wasn't representable and needed no explanation.
    ///
    /// Scoped to the Daily flow and to *today* — see `AppState::last_error` for why
    /// both matter. A Customized pin reports its own failures through `custom`'s
    /// panel.
    pub last_error: Option<String>,
    pub date: String,
    pub theme: ThemeMode,
    pub effective_theme: String,
    pub light: ColorPair,
    pub dark: ColorPair,
    pub style: StylePreset,
    pub update_check: UpdateCheck,
    /// Whether detected updates are installed automatically (see config field).
    pub auto_update: bool,
    /// The version we can update to, or `None`. Single source of truth for the
    /// "update available" affordance — see `AppState::available_update`.
    pub update_available: Option<String>,
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
    pub proxy_enabled: bool,
    pub proxy_url: String,
}

/// `Status::last_error` from `AppState::last_error`: the stored message, but only
/// while it belongs to `today`.
///
/// The date gate is what keeps a failure from outliving the day it happened on.
/// `scheduler::spawn` pushes a fresh snapshot the moment the date rolls over and
/// only *then* reconciles, so for up to one poll the new day has been attempted
/// zero times — and yesterday's message, shown next to a `city: None` that just
/// means "not started", would read as the new day having already failed.
fn error_for_today(
    stored: Option<&(chrono::NaiveDate, String)>,
    today: chrono::NaiveDate,
) -> Option<String> {
    stored.filter(|(d, _)| *d == today).map(|(_, e)| e.clone())
}

/// Build the current `Status` snapshot. Shared by the `get_status` command
/// (initial mount fetch) and the status-emitter task (push on every change).
pub async fn build_status(app: &AppHandle) -> Status {
    let state = app.state::<AppState>();
    let date = city::today();
    // The city the pipeline actually rendered — `None` until it has resolved one
    // (see `city_for_status`). Deliberately not a second, independent pick: that
    // would disagree with the schedule on every day served from it (issue #1), and
    // this drives the City tab's name, coordinates and Wikipedia / Maps links.
    let city = pipeline::city_for_status(app, date);
    let running = *state.running.lock().await;
    let effective = match pipeline::effective_theme(app) {
        EffectiveTheme::Light => "light",
        EffectiveTheme::Dark => "dark",
    };
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
    let variant = *state.variant.lock().unwrap();
    let railway_style = *state.railway_style.lock().unwrap();
    let proxy_url = state.proxy_url.lock().unwrap().clone();
    let last_error = error_for_today(state.last_error.lock().unwrap().as_ref(), date);
    Status {
        update_mode,
        custom,
        hide_tray: state.hide_tray.load(Ordering::Acquire),
        running,
        city,
        last_error,
        date: date.to_string(),
        theme,
        effective_theme: effective.into(),
        light,
        dark,
        style,
        update_check,
        auto_update: state.auto_update.load(Ordering::Acquire),
        update_available,
        show_water: state.show_water.load(Ordering::Acquire),
        show_airports: state.show_airports.load(Ordering::Acquire),
        railway_style,
        show_aerialways: state.show_aerialways.load(Ordering::Acquire),
        variant,
        dev_mode: state.dev_mode.load(Ordering::Acquire),
        // Reuses the `update_mode` read above rather than taking the lock again, so
        // the two fields can't contradict each other within one snapshot.
        bypass_cache: state.bypass_cache_for(update_mode),
        proxy_enabled: state.proxy_enabled.load(Ordering::Acquire),
        proxy_url,
    }
}

#[tauri::command]
pub async fn get_status(app: AppHandle) -> Result<Status, String> {
    Ok(build_status(&app).await)
}

/// Set the wallpaper update mode (Disable / Daily / Customized) — the City-tab
/// selector. Persists, syncs the tray, and applies the wallpaper for the new
/// mode: Daily and Customized reapply the current cached render (or render it if
/// missing); Customized is a no-op until a pin is applied; Disable leaves the
/// current wallpaper untouched.
#[tauri::command]
pub fn set_update_mode(app: AppHandle, mode: UpdateMode) -> Result<(), String> {
    *app.state::<AppState>().update_mode.lock().unwrap() = mode;
    tray::sync_mode_to_tray(&app);
    app.state::<AppState>().mark_status_dirty();
    persist(&app)?;
    if mode != UpdateMode::Disable {
        pipeline::spawn_apply(app);
    }
    Ok(())
}

/// Apply a Customized-mode pin: store the coordinates, switch to Customized
/// mode, and render that location. Coordinates are also validated on the
/// frontend (see core/coords.ts); this re-checks the range defensively.
#[tauri::command]
pub fn apply_custom_city(app: AppHandle, lat: f64, lon: f64) -> Result<(), String> {
    if !lat.is_finite() || !lon.is_finite() || lat.abs() > 90.0 || lon.abs() > 180.0 {
        return Err("coordinates out of range".into());
    }
    {
        let state = app.state::<AppState>();
        *state.custom.lock().unwrap() = Some(CustomCity { lat, lon });
        *state.update_mode.lock().unwrap() = UpdateMode::Customized;
    }
    tray::sync_mode_to_tray(&app);
    app.state::<AppState>().mark_status_dirty();
    persist(&app)?;
    pipeline::spawn_apply(app);
    Ok(())
}

/// Name lookup for the Customized-mode input (issue #11): the bundled city list
/// filtered by `query`, best match first. Searched in the backend because the
/// list already lives there (see `city::search`) — shipping ~1000 cities to the
/// webview just to filter them would only bloat the bundle.
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    pub regen_started: bool,
}

#[derive(Serialize)]
pub struct ColorDefaults {
    pub light: ColorPair,
    pub dark: ColorPair,
}

/// Atomic write of all Style-tab settings. Returns whether a wallpaper
/// re-render was triggered so the UI can decide whether to wait for
/// pipeline:end before clearing its Save spinner.
#[tauri::command]
pub fn apply_style_settings(
    app: AppHandle,
    theme: ThemeMode,
    style: StylePreset,
    light: ColorPair,
    dark: ColorPair,
) -> Result<ApplyResult, String> {
    let before_colors = current_effective_colors(&app);
    let before_style = *app.state::<AppState>().style.lock().unwrap();

    {
        let s = app.state::<AppState>();
        *s.theme.lock().unwrap() = theme;
        *s.style.lock().unwrap() = style;
        *s.light.lock().unwrap() = light;
        *s.dark.lock().unwrap() = dark;
    }
    persist(&app)?;
    // Push the new theme/style/colors immediately, even when no re-render is
    // triggered below (a render, if any, will mark dirty again on completion).
    app.state::<AppState>().mark_status_dirty();

    let after_colors = current_effective_colors(&app);
    let after_style = *app.state::<AppState>().style.lock().unwrap();

    let regen_started = before_colors != after_colors || before_style != after_style;
    if regen_started {
        pipeline::spawn_force_regen(app);
    }
    Ok(ApplyResult { regen_started })
}

/// Every Lab-tab setting as one value: the optional data-layer toggles plus the
/// map's visual variant. Deliberately one struct rather than a parameter list —
/// it doubles as the command payload and as the before/after snapshot
/// `apply_lab_settings` diffs, so a new Lab setting is one field here instead of
/// a parameter, a `before_*` local and another `||` clause.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LabSettings {
    pub show_airports: bool,
    pub show_water: bool,
    pub railway_style: RailwayStyle,
    pub show_aerialways: bool,
    pub variant: StyleVariant,
}

/// The Lab settings as currently held in `AppState`.
fn lab_settings(state: &AppState) -> LabSettings {
    LabSettings {
        show_airports: state.show_airports.load(Ordering::Acquire),
        show_water: state.show_water.load(Ordering::Acquire),
        railway_style: *state.railway_style.lock().unwrap(),
        show_aerialways: state.show_aerialways.load(Ordering::Acquire),
        variant: *state.variant.lock().unwrap(),
    }
}

/// Atomic write of the Lab-tab settings (see `LabSettings`). Same return
/// contract as `apply_style_settings`: whether a re-render started.
#[tauri::command]
pub fn apply_lab_settings(app: AppHandle, settings: LabSettings) -> Result<ApplyResult, String> {
    let state = app.state::<AppState>();
    let before = lab_settings(&state);
    let LabSettings { show_airports, show_water, railway_style, show_aerialways, variant } =
        settings;

    state.show_airports.store(show_airports, Ordering::Release);
    state.show_water.store(show_water, Ordering::Release);
    *state.railway_style.lock().unwrap() = railway_style;
    state.show_aerialways.store(show_aerialways, Ordering::Release);
    *state.variant.lock().unwrap() = variant;
    persist(&app)?;
    // Push the new flags immediately, even when no re-render is triggered below
    // (a render, if any, will mark dirty again on completion).
    app.state::<AppState>().mark_status_dirty();

    let regen_started = before != settings;
    if regen_started {
        pipeline::spawn_force_regen(app);
    }
    Ok(ApplyResult { regen_started })
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
    state.dev_mode.store(on, Ordering::Release);
    state.mark_status_dirty();
    persist(&app)?;
    // Locking the tab makes every `dev_mode`-gated Dev Mode switch/setting read
    // as off (today just `bypass_cache`; see `AppState::effective_bypass_cache`);
    // no render is kicked off here.
    Ok(())
}

/// Persist + apply the Proxy setting. When enabled, validates the URL up front
/// (so the UI can surface a bad value) before applying it to the shared HTTP
/// client. The osm-cli sidecar picks the proxy up from its environment on its
/// next spawn (see `osm_sidecar::fetch`), so no restart is needed.
#[tauri::command]
pub fn apply_proxy_settings(
    app: AppHandle,
    proxy_enabled: bool,
    proxy_url: String,
) -> Result<(), String> {
    let url = proxy_url.trim().to_string();
    if proxy_enabled && !url.is_empty() {
        // Reject a malformed URL up front so the user sees the error immediately,
        // rather than silently falling back to a direct connection later.
        reqwest::Proxy::all(&url).map_err(|e| format!("Invalid proxy URL: {e}"))?;
    }
    {
        let state = app.state::<AppState>();
        state.proxy_enabled.store(proxy_enabled, Ordering::Release);
        *state.proxy_url.lock().unwrap() = url.clone();
    }
    let active = if proxy_enabled && !url.is_empty() { Some(url) } else { None };
    crate::github_mirror::set_proxy(active);
    app.state::<AppState>().mark_status_dirty();
    persist(&app)
}

#[tauri::command]
pub fn get_color_defaults() -> ColorDefaults {
    ColorDefaults { light: ColorPair::light_default(), dark: ColorPair::dark_default() }
}

fn current_effective_colors(app: &AppHandle) -> ColorPair {
    let state = app.state::<AppState>();
    match pipeline::effective_theme(app) {
        EffectiveTheme::Light => state.light.lock().unwrap().clone(),
        EffectiveTheme::Dark => state.dark.lock().unwrap().clone(),
    }
}

#[tauri::command]
pub async fn regenerate_now(app: AppHandle) -> Result<(), String> {
    pipeline::spawn_force_regen(app);
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewResult {
    pub city: City,
    pub date: String,
    /// Base64-encoded PNG, ready for an `<img src="data:image/png;base64,...">`.
    pub png_base64: String,
    /// Where the same PNG landed in the day cache
    /// (`wallpaper/daily/<date>-<theme>.png`). Handed back so double-clicking the
    /// preview can open that file — see `open_preview_image`.
    pub png_path: String,
}

/// Dev Mode's "Advance Preview": render (without applying) the city map for
/// `days_ahead` days from today, so a developer can see an upcoming
/// rotation day without waiting for it or touching the real wallpaper.
#[tauri::command]
pub async fn preview_city(app: AppHandle, days_ahead: i64) -> Result<PreviewResult, String> {
    if !(0..=5).contains(&days_ahead) {
        return Err("daysAhead must be between 0 and 5".to_string());
    }
    // The City tab's Customized pin has no daily schedule to preview, and the UI
    // disables this control there — re-checked here so the command can't be driven
    // into rendering a day the user isn't on.
    if *app.state::<AppState>().update_mode.lock().unwrap() == UpdateMode::Customized {
        return Err("Advance Preview applies to the Daily update mode".to_string());
    }
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
    let mut g = state.pending.lock().await;
    if let Some(p) = g.take() {
        if p.date == date {
            let _ = p.tx.send(bytes);
        } else {
            log::warn!("[commands] stale render result for {}, expected {}", date, p.date);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn update_tray_labels(
    open_settings: String,
    daily_updates: String,
    regenerate_now: String,
    quit: String,
    update_available: String,
) -> Result<(), String> {
    tray::update_labels(&open_settings, &daily_updates, &regenerate_now, &quit, &update_available);
    Ok(())
}

#[tauri::command]
pub fn hide_window(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("main") {
        w.hide().map_err(|e| e.to_string())?;
    }
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
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    app.opener().open_path(dir.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())
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
    Ok(CleanCacheResult { removed_files, freed_bytes })
}

/// Open a cached render in the OS default image viewer, so the Dev Mode Advance
/// Preview can be inspected full-size. Nothing is exported: `render_preview`
/// already wrote this PNG into the day cache, and `path` is the `pngPath` its
/// `PreviewResult` carried back — the file the viewer shows is the very one the
/// pipeline will reapply when that day arrives.
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
        proxy_enabled: s.proxy_enabled.load(Ordering::Acquire),
        proxy_url: s.proxy_url.lock().unwrap().clone(),
    };
    config::save(app, &cfg).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn d(y: i32, m: u32, day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, day).unwrap()
    }

    // `Status::city` is `None` both while a day is still resolving and when it
    // can't be resolved at all; `last_error` is the only thing that tells those
    // apart (see the field's docs). So the two states it has to produce are pinned
    // here, along with the date gate that stops one day's failure from being read
    // as the next day's — the scheduler pushes a snapshot on the rollover before it
    // has retried even once.

    #[test]
    fn error_for_today_surfaces_todays_failure() {
        let stored = (d(2026, 8, 13), "no manifest and no schedule state".to_string());
        assert_eq!(
            error_for_today(Some(&stored), d(2026, 8, 13)).as_deref(),
            Some("no manifest and no schedule state")
        );
    }

    #[test]
    fn error_for_today_drops_a_failure_from_another_day() {
        let stored = (d(2026, 8, 12), "no manifest and no schedule state".to_string());
        assert_eq!(error_for_today(Some(&stored), d(2026, 8, 13)), None);
    }

    #[test]
    fn error_for_today_is_none_when_nothing_has_failed() {
        assert_eq!(error_for_today(None, d(2026, 8, 13)), None);
    }
}
