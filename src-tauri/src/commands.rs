use std::sync::atomic::Ordering;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;

use crate::city::{self, City};
use crate::config::{self, ColorPair, StylePreset, ThemeMode, UpdateCheck};
use crate::pipeline::{self, EffectiveTheme};
use crate::state::AppState;
use crate::tray;

#[derive(Serialize, Clone)]
pub struct Status {
    pub enabled: bool,
    pub hide_tray: bool,
    pub running: bool,
    pub city: City,
    pub date: String,
    pub theme: ThemeMode,
    #[serde(rename = "effectiveTheme")]
    pub effective_theme: String,
    pub light: ColorPair,
    pub dark: ColorPair,
    pub style: StylePreset,
    #[serde(rename = "updateCheck")]
    pub update_check: UpdateCheck,
    /// Whether detected updates are installed automatically (see config field).
    #[serde(rename = "autoUpdate")]
    pub auto_update: bool,
    /// The version we can update to, or `None`. Single source of truth for the
    /// "update available" affordance — see `AppState::available_update`.
    #[serde(rename = "updateAvailable")]
    pub update_available: Option<String>,
    #[serde(rename = "showWater")]
    pub show_water: bool,
    #[serde(rename = "showAirports")]
    pub show_airports: bool,
    #[serde(rename = "showRailways")]
    pub show_railways: bool,
    /// Whether the hidden Dev Mode tab is unlocked (persisted). See
    /// `AppState::dev_mode`.
    #[serde(rename = "devMode")]
    pub dev_mode: bool,
    /// Dev-only "bypass cache & CDN" toggle (in-memory, never persisted). See
    /// `AppState::bypass_cache`.
    #[serde(rename = "bypassCache")]
    pub bypass_cache: bool,
}

/// Build the current `Status` snapshot. Shared by the `get_status` command
/// (initial mount fetch) and the status-emitter task (push on every change).
pub async fn build_status(app: &AppHandle) -> Status {
    let state = app.state::<AppState>();
    let date = city::today();
    let city = city::pick_for_date(date);
    let running = *state.running.lock().await;
    let theme = *state.theme.lock().unwrap();
    let effective = match pipeline::effective_theme(app) {
        EffectiveTheme::Light => "light",
        EffectiveTheme::Dark => "dark",
    };
    // Bound to a local so the lock-guard temporaries in the literal drop before
    // `state` (the function's tail expression would otherwise outlive it).
    let status = Status {
        enabled: state.enabled.load(Ordering::Acquire),
        hide_tray: state.hide_tray.load(Ordering::Acquire),
        running,
        city,
        date: date.to_string(),
        theme,
        effective_theme: effective.into(),
        light: state.light.lock().unwrap().clone(),
        dark: state.dark.lock().unwrap().clone(),
        style: *state.style.lock().unwrap(),
        update_check: *state.update_check.lock().unwrap(),
        auto_update: state.auto_update.load(Ordering::Acquire),
        update_available: state.available_update.lock().unwrap().clone(),
        show_water: state.show_water.load(Ordering::Acquire),
        show_airports: state.show_airports.load(Ordering::Acquire),
        show_railways: state.show_railways.load(Ordering::Acquire),
        dev_mode: state.dev_mode.load(Ordering::Acquire),
        bypass_cache: state.effective_bypass_cache(),
    };
    status
}

#[tauri::command]
pub async fn get_status(app: AppHandle) -> Result<Status, String> {
    Ok(build_status(&app).await)
}

#[tauri::command]
pub fn set_enabled(app: AppHandle, on: bool) -> Result<(), String> {
    app.state::<AppState>().enabled.store(on, Ordering::Release);
    tray::sync_enabled_to_tray(&app);
    app.state::<AppState>().mark_status_dirty();
    persist(&app)
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
    crate::updates::do_check(&app, true)
        .await
        .map_err(|e| e.to_string())
}

/// Install the available update and relaunch. On success this never returns
/// (the app restarts). Returns `Ok(false)` when there's nothing to install.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<bool, String> {
    crate::updates::install_now(&app)
        .await
        .map_err(|e| e.to_string())
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

/// Atomic write of the Lab-tab settings: the optional data-layer toggles
/// (airports, water, railways). Same return contract as `apply_style_settings`:
/// whether a re-render started.
#[tauri::command]
pub fn apply_lab_settings(
    app: AppHandle,
    show_airports: bool,
    show_water: bool,
    show_railways: bool,
) -> Result<ApplyResult, String> {
    let state = app.state::<AppState>();
    let before_airports = state.show_airports.load(Ordering::Acquire);
    let before_water = state.show_water.load(Ordering::Acquire);
    let before_railways = state.show_railways.load(Ordering::Acquire);

    state.show_airports.store(show_airports, Ordering::Release);
    state.show_water.store(show_water, Ordering::Release);
    state.show_railways.store(show_railways, Ordering::Release);
    persist(&app)?;
    // Push the new flags immediately, even when no re-render is triggered below
    // (a render, if any, will mark dirty again on completion).
    app.state::<AppState>().mark_status_dirty();

    let regen_started = before_airports != show_airports
        || before_water != show_water
        || before_railways != show_railways;
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

#[tauri::command]
pub fn get_color_defaults() -> ColorDefaults {
    ColorDefaults {
        light: ColorPair::light_default(),
        dark: ColorPair::dark_default(),
    }
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
}

/// Dev Mode's "Advance Preview": render (without applying) the city map for
/// `days_ahead` days from today, so a developer can see an upcoming
/// rotation day without waiting for it or touching the real wallpaper.
#[tauri::command]
pub async fn preview_city(app: AppHandle, days_ahead: i64) -> Result<PreviewResult, String> {
    if !(0..=5).contains(&days_ahead) {
        return Err("daysAhead must be between 0 and 5".to_string());
    }
    let date = city::today() + chrono::Duration::days(days_ahead);
    let (city, bytes) = pipeline::render_preview(&app, date).await.map_err(|e| e.to_string())?;
    Ok(PreviewResult {
        city,
        date: date.to_string(),
        png_base64: base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes),
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
    tray::update_labels(
        &open_settings,
        &daily_updates,
        &regenerate_now,
        &quit,
        &update_available,
    );
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

/// Dev Mode's "Clean cache": delete every cached artifact in the app cache dir
/// — the downloaded OSM data (`{date}.osm.json`) and the rendered wallpapers
/// (`{date}-{theme}.png`). Everything we write there is keyed by a leading
/// 10-char ISO date, so we match on that prefix (like `pipeline::cleanup_cache`)
/// and never touch anything else that might live in the cache dir. The cache is
/// fully regenerable: the next render re-fetches from the CDN / sidecar and
/// re-renders. Returns how many files were removed and how many bytes were
/// freed, for UI feedback.
#[tauri::command]
pub fn clean_cache(app: AppHandle) -> Result<CleanCacheResult, String> {
    let cache = pipeline::cache_dir(&app).map_err(|e| e.to_string())?;
    let mut removed_files = 0usize;
    let mut freed_bytes = 0u64;
    // Delete every artifact `for_each_artifact` matches (the same date-prefix
    // whitelist `pipeline::cleanup_cache` prunes by age), counting files and
    // bytes freed for UI feedback.
    pipeline::for_each_artifact(&cache, |entry, _date| {
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        if std::fs::remove_file(entry.path()).is_ok() {
            removed_files += 1;
            freed_bytes += size;
        }
    })
    .map_err(|e| e.to_string())?;
    log::info!("[commands] clean_cache removed {} files ({} bytes)", removed_files, freed_bytes);
    Ok(CleanCacheResult { removed_files, freed_bytes })
}

fn persist(app: &AppHandle) -> Result<(), String> {
    let s = app.state::<AppState>();
    let cfg = config::Config {
        enabled: s.enabled.load(Ordering::Acquire),
        hide_tray: s.hide_tray.load(Ordering::Acquire),
        theme: *s.theme.lock().unwrap(),
        light: s.light.lock().unwrap().clone(),
        dark: s.dark.lock().unwrap().clone(),
        style: *s.style.lock().unwrap(),
        update_check: *s.update_check.lock().unwrap(),
        auto_update: s.auto_update.load(Ordering::Acquire),
        show_water: s.show_water.load(Ordering::Acquire),
        show_airports: s.show_airports.load(Ordering::Acquire),
        show_railways: s.show_railways.load(Ordering::Acquire),
        dev_mode: s.dev_mode.load(Ordering::Acquire),
    };
    config::save(app, &cfg).map_err(|e| e.to_string())
}
