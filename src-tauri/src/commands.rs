use std::sync::atomic::Ordering;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::city::{self, City};
use crate::config::{self, ColorPair, StylePreset, ThemeMode};
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
pub fn set_theme(app: AppHandle, mode: ThemeMode) -> Result<(), String> {
    let before = current_effective_colors(&app);
    *app.state::<AppState>().theme.lock().unwrap() = mode;
    crate::apply_window_theme(&app, mode);
    persist(&app)?;
    regen_if_visible_change(app, before);
    Ok(())
}

#[tauri::command]
pub fn set_colors(app: AppHandle, mode: String, background: String, foreground: String) -> Result<(), String> {
    let before = current_effective_colors(&app);
    let state = app.state::<AppState>();
    let pair = ColorPair { background, foreground };
    match mode.as_str() {
        "light" => *state.light.lock().unwrap() = pair,
        "dark" => *state.dark.lock().unwrap() = pair,
        other => return Err(format!("unknown mode: {}", other)),
    }
    persist(&app)?;
    regen_if_visible_change(app, before);
    Ok(())
}

#[tauri::command]
pub fn set_style(app: AppHandle, preset: StylePreset) -> Result<(), String> {
    let before = *app.state::<AppState>().style.lock().unwrap();
    *app.state::<AppState>().style.lock().unwrap() = preset;
    persist(&app)?;
    if before != preset {
        pipeline::spawn_force_regen(app);
    }
    Ok(())
}

#[tauri::command]
pub fn reset_colors(app: AppHandle, mode: String) -> Result<ColorPair, String> {
    let before = current_effective_colors(&app);
    let pair = match mode.as_str() {
        "light" => ColorPair::light_default(),
        "dark" => ColorPair::dark_default(),
        other => return Err(format!("unknown mode: {}", other)),
    };
    let state = app.state::<AppState>();
    match mode.as_str() {
        "light" => *state.light.lock().unwrap() = pair.clone(),
        "dark" => *state.dark.lock().unwrap() = pair.clone(),
        _ => unreachable!(),
    }
    persist(&app)?;
    regen_if_visible_change(app, before);
    Ok(pair)
}

fn current_effective_colors(app: &AppHandle) -> ColorPair {
    let state = app.state::<AppState>();
    match pipeline::effective_theme(app) {
        EffectiveTheme::Light => state.light.lock().unwrap().clone(),
        EffectiveTheme::Dark => state.dark.lock().unwrap().clone(),
    }
}

fn regen_if_visible_change(app: AppHandle, before: ColorPair) {
    let after = current_effective_colors(&app);
    if before != after {
        pipeline::spawn_force_regen(app);
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
) -> Result<(), String> {
    tray::update_labels(&open_settings, &daily_updates, &regenerate_now, &quit);
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
    };
    config::save(app, &cfg).map_err(|e| e.to_string())
}
