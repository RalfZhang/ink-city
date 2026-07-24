use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::Duration;

use anyhow::{anyhow, Result};
use chrono::NaiveDate;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Theme, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tokio::sync::oneshot;

use crate::bbox::{bbox_for_screen, Bbox};
use crate::cdn;
use crate::city;
use crate::config::{ColorPair, StylePreset, ThemeMode};
use crate::events::FrontendEvent;
use crate::layers;
use crate::osm_sidecar;
use crate::state::{AppState, PendingJob};
use crate::wallpaper_set;

const KEEP_DAYS: i64 = 7;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EffectiveTheme {
    Light,
    Dark,
}

#[derive(Serialize, Clone)]
struct Style {
    background: String,
    foreground: String,
    preset: StylePreset,
    #[serde(rename = "showWater")]
    show_water: bool,
    #[serde(rename = "showAirports")]
    show_airports: bool,
}

#[derive(Serialize, Clone)]
struct RenderRequest {
    date: String,
    bbox: Bbox,
    width: u32,
    height: u32,
    style: Style,
    osm: serde_json::Value,
}

pub fn cache_dir(app: &AppHandle) -> Result<PathBuf> {
    let d = app.path().app_cache_dir()?;
    fs::create_dir_all(&d)?;
    Ok(d)
}

fn set_present_layers(app: &AppHandle, date: NaiveDate, present: std::collections::HashSet<String>) {
    *app.state::<AppState>().present_layers.lock().unwrap() = Some((date, present));
}

/// Which optional layers (see `layers::LAYER_KEYS`) are present for `date`,
/// computing and caching them from the cached OSM file on first miss this
/// session. Used by `get_status` when the wallpaper was already cached this
/// session (so the pipeline never parsed the data) — see
/// `layers::detect_present_text` for why this scans rather than parses.
fn present_layers_for(app: &AppHandle, date: NaiveDate) -> std::collections::HashSet<String> {
    let state = app.state::<AppState>();
    {
        let g = state.present_layers.lock().unwrap();
        if let Some((d, set)) = &*g {
            if *d == date {
                return set.clone();
            }
        }
    }
    let present = cache_dir(app)
        .ok()
        .and_then(|c| fs::read_to_string(c.join(format!("{}.osm.json", date))).ok())
        .map(|s| layers::detect_present_text(&s))
        .unwrap_or_default();
    *state.present_layers.lock().unwrap() = Some((date, present.clone()));
    present
}

/// Whether the current city's cached data for `date` carries `layer` (e.g.
/// `"water"`). Gates the corresponding UI toggle in `get_status`.
pub fn has_layer_for(app: &AppHandle, date: NaiveDate, layer: &str) -> bool {
    present_layers_for(app, date).contains(layer)
}

pub fn effective_theme(app: &AppHandle) -> EffectiveTheme {
    let mode = *app.state::<AppState>().theme.lock().unwrap();
    match mode {
        ThemeMode::Light => EffectiveTheme::Light,
        ThemeMode::Dark => EffectiveTheme::Dark,
        ThemeMode::System => system_theme(app),
    }
}

fn system_theme(app: &AppHandle) -> EffectiveTheme {
    let t = app.get_webview_window("main").and_then(|w| w.theme().ok());
    match t {
        Some(Theme::Dark) => EffectiveTheme::Dark,
        _ => EffectiveTheme::Light,
    }
}

fn colors_for(app: &AppHandle, theme: EffectiveTheme) -> ColorPair {
    let state = app.state::<AppState>();
    match theme {
        EffectiveTheme::Light => state.light.lock().unwrap().clone(),
        EffectiveTheme::Dark => state.dark.lock().unwrap().clone(),
    }
}

fn theme_suffix(theme: EffectiveTheme) -> &'static str {
    match theme {
        EffectiveTheme::Light => "light",
        EffectiveTheme::Dark => "dark",
    }
}

/// Cached wallpaper path for a given day + theme. The theme is part of the
/// filename so a dark/light switch (including one missed while the machine
/// slept) renders/loads its own variant instead of reusing the other theme's
/// stale PNG. OSM data (`{date}.osm.json`) stays theme-independent.
fn png_path(cache: &Path, date: NaiveDate, theme: EffectiveTheme) -> PathBuf {
    cache.join(format!("{}-{}.png", date, theme_suffix(theme)))
}

fn mark_applied(app: &AppHandle, date: NaiveDate, theme: EffectiveTheme) {
    *app.state::<AppState>().last_applied.lock().unwrap() = Some((date, theme));
}

pub async fn run_for_date(app: AppHandle, date: NaiveDate) -> Result<()> {
    {
        let state = app.state::<AppState>();
        let mut g = state.running.lock().await;
        if *g {
            return Ok(()); // already running — coalesce silently
        }
        *g = true;
    }
    FrontendEvent::PipelineStart.emit(&app);
    let r = run_inner(&app, date).await;
    {
        let state = app.state::<AppState>();
        let mut g = state.running.lock().await;
        *g = false;
    }
    FrontendEvent::PipelineEnd.emit(&app);
    // Push the post-render snapshot: running back to false, plus any new
    // date/city/has_water (e.g. the scheduler's midnight reconcile).
    app.state::<AppState>().mark_status_dirty();
    r
}

async fn run_inner(app: &AppHandle, date: NaiveDate) -> Result<()> {
    let city = city::pick_for_date(date);
    let theme = effective_theme(app);
    let cache = cache_dir(app)?;
    let png_path = png_path(&cache, date, theme);

    if png_path.exists() {
        wallpaper_set::set(&png_path)?;
        mark_applied(app, date, theme);
        return Ok(());
    }

    let renderer = ensure_renderer(app).await?;
    let (w, h) = primary_size(&renderer)?;
    let aspect = w as f64 / h as f64;
    // 10km half = 20km long side. MUST match MAX_HALF_KM in
    // scripts/osm-cli.ts: the precached square (aspect=1) is the superset
    // every screen-aspect rectangle here must fit inside, so the CDN data
    // always covers the wallpaper.
    let bbox = bbox_for_screen(city.lat, city.lon, 10.0, aspect);

    // OSM acquisition order: local day cache → jsDelivr CDN (pre-cached 20km
    // square, China-reachable) → the osm-cli sidecar, run live (screen
    // rectangle). The CDN square is a superset of `bbox`, so the renderer
    // projects within `bbox` and clips the rest; the sidecar fetches exactly
    // `bbox` to save bandwidth. Both the CDN payload and the sidecar go
    // through the same TS implementation (src/core/fetch-city.ts), so a CDN
    // miss never produces data poorer than the CDN's (e.g. water is never
    // missing just because we fell back).
    let osm_path = cache.join(format!("{}.osm.json", date));
    let osm: serde_json::Value = if osm_path.exists() {
        serde_json::from_str(&fs::read_to_string(&osm_path)?)?
    } else {
        let v = match cdn::fetch_cached_osm(city.id).await {
            Ok(v) => {
                log::info!("[pipeline] osm from CDN ({})", city.id);
                v
            }
            Err(e) => {
                log::warn!("[pipeline] CDN miss ({}), falling back to sidecar: {}", city.id, e);
                osm_sidecar::fetch(app, bbox).await?
            }
        };
        fs::write(&osm_path, v.to_string())?;
        v
    };

    // Record which optional layers this city's data carries so the UI can
    // decide whether to surface layer toggles (e.g. "show water").
    set_present_layers(app, date, layers::detect_present_value(&osm));

    let colors = colors_for(app, theme);
    let preset = *app.state::<AppState>().style.lock().unwrap();
    let show_water = app.state::<AppState>().show_water.load(Ordering::Acquire);
    let show_airports = app.state::<AppState>().show_airports.load(Ordering::Acquire);
    let style =
        Style { background: colors.background, foreground: colors.foreground, preset, show_water, show_airports };

    let (tx, rx) = oneshot::channel::<Vec<u8>>();
    {
        let state = app.state::<AppState>();
        let mut g = state.pending.lock().await;
        *g = Some(PendingJob { date: date.to_string(), tx });
    }

    let req = RenderRequest { date: date.to_string(), bbox, width: w, height: h, style, osm };
    renderer.emit("render-request", &req)?;

    let bytes = tokio::time::timeout(Duration::from_secs(120), rx)
        .await
        .map_err(|_| anyhow!("renderer timeout"))?
        .map_err(|_| anyhow!("renderer dropped"))?;

    fs::write(&png_path, &bytes)?;
    wallpaper_set::set(&png_path)?;
    mark_applied(app, date, theme);
    let _ = cleanup_cache(&cache, KEEP_DAYS);
    log::info!("[pipeline] wallpaper set: {} ({})", city.name, city.country);
    Ok(())
}

async fn ensure_renderer(app: &AppHandle) -> Result<WebviewWindow> {
    if let Some(w) = app.get_webview_window("renderer") {
        return Ok(w);
    }
    let w = WebviewWindowBuilder::new(app, "renderer", WebviewUrl::App("render.html".into()))
        .visible(false)
        .title("InkCity Renderer")
        .build()?;
    wait_renderer_ready(app).await?;
    Ok(w)
}

async fn wait_renderer_ready(app: &AppHandle) -> Result<()> {
    let state = app.state::<AppState>();
    if state.renderer_ready.load(Ordering::Acquire) {
        return Ok(());
    }
    let notify = state.renderer_notify.clone();
    tokio::time::timeout(Duration::from_secs(20), notify.notified())
        .await
        .map_err(|_| anyhow!("renderer never became ready"))?;
    Ok(())
}

fn primary_size(win: &WebviewWindow) -> Result<(u32, u32)> {
    let m = win.primary_monitor()?.ok_or_else(|| anyhow!("no monitor"))?;
    let s = m.size();
    Ok((s.width, s.height))
}

fn cleanup_cache(dir: &Path, keep_days: i64) -> Result<()> {
    let today = city::today();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        // Both `YYYY-MM-DD-<theme>.png` and `YYYY-MM-DD.osm.json` start with the
        // 10-char ISO date, so slice the prefix rather than splitting on '.'.
        let date_part = name.get(..10).unwrap_or("");
        if let Ok(d) = NaiveDate::parse_from_str(date_part, "%Y-%m-%d") {
            if (today - d).num_days() > keep_days {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
    Ok(())
}

/// Delete the current (date, theme) PNG and re-run the pipeline (OSM data is
/// reused if cached). Used for theme switches and style/color edits, where the
/// rendered output must change even though the filename may not. Clearing
/// `last_applied` ensures the poll re-applies rather than treating the stale
/// state as up to date. Fire-and-forget: errors are logged to stderr.
pub fn spawn_force_regen(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let date = city::today();
        let theme = effective_theme(&app);
        let cache = match cache_dir(&app) {
            Ok(c) => c,
            Err(e) => {
                log::error!("[pipeline] cache_dir: {}", e);
                return;
            }
        };
        let _ = fs::remove_file(png_path(&cache, date, theme));
        *app.state::<AppState>().last_applied.lock().unwrap() = None;
        if let Err(e) = run_for_date(app, date).await {
            log::error!("[pipeline] force regen failed: {}", e);
        }
    });
}
