use std::sync::atomic::Ordering;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::city::{self, City};
use crate::config::{self, ColorPair, StylePreset, ThemeMode, UpdateCheck};
use crate::pipeline::{self, EffectiveTheme};
use crate::state::AppState;
use crate::tray;

#[derive(Serialize)]
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
    #[serde(rename = "showWater")]
    pub show_water: bool,
    /// Whether the current city's data has a water layer (gates the UI toggle).
    #[serde(rename = "hasWater")]
    pub has_water: bool,
}

#[tauri::command]
pub async fn get_status(app: AppHandle, state: State<'_, AppState>) -> Result<Status, String> {
    let date = city::today();
    let city = city::pick_for_date(date);
    let running = *state.running.lock().await;
    let theme = *state.theme.lock().unwrap();
    let effective = match pipeline::effective_theme(&app) {
        EffectiveTheme::Light => "light",
        EffectiveTheme::Dark => "dark",
    };
    Ok(Status {
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
        show_water: state.show_water.load(Ordering::Acquire),
        has_water: pipeline::has_water_for(&app, date),
    })
}

#[tauri::command]
pub fn set_enabled(app: AppHandle, on: bool) -> Result<(), String> {
    app.state::<AppState>().enabled.store(on, Ordering::Release);
    tray::sync_enabled_to_tray(&app);
    persist(&app)
}

#[tauri::command]
pub fn set_hide_tray(app: AppHandle, hide: bool) -> Result<(), String> {
    app.state::<AppState>().hide_tray.store(hide, Ordering::Release);
    tray::apply_hide_tray(&app, hide);
    persist(&app)
}

#[tauri::command]
pub fn set_update_check(app: AppHandle, value: UpdateCheck) -> Result<(), String> {
    *app.state::<AppState>().update_check.lock().unwrap() = value;
    persist(&app)
}

#[tauri::command]
pub fn set_language(app: AppHandle, lang: String) -> Result<(), String> {
    *app.state::<AppState>().language.lock().unwrap() = lang;
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
    show_water: bool,
) -> Result<ApplyResult, String> {
    let before_colors = current_effective_colors(&app);
    let before_style = *app.state::<AppState>().style.lock().unwrap();
    let before_water = app.state::<AppState>().show_water.load(Ordering::Acquire);

    {
        let s = app.state::<AppState>();
        *s.theme.lock().unwrap() = theme;
        *s.style.lock().unwrap() = style;
        *s.light.lock().unwrap() = light;
        *s.dark.lock().unwrap() = dark;
        s.show_water.store(show_water, Ordering::Release);
    }
    persist(&app)?;

    let after_colors = current_effective_colors(&app);
    let after_style = *app.state::<AppState>().style.lock().unwrap();

    let regen_started =
        before_colors != after_colors || before_style != after_style || before_water != show_water;
    if regen_started {
        pipeline::spawn_force_regen(app);
    }
    Ok(ApplyResult { regen_started })
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
            eprintln!("[commands] stale render result for {}, expected {}", date, p.date);
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
        show_water: s.show_water.load(Ordering::Acquire),
    };
    config::save(app, &cfg).map_err(|e| e.to_string())
}
