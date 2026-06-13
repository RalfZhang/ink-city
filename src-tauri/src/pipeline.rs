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
use crate::overpass;
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

/// True if a parsed OSM value carries a non-empty `water` layer.
fn osm_value_has_water(v: &serde_json::Value) -> bool {
    v.get("water").and_then(|w| w.as_array()).map_or(false, |a| !a.is_empty())
}

fn set_has_water(app: &AppHandle, date: NaiveDate, has: bool) {
    *app.state::<AppState>().has_water.lock().unwrap() = Some((date, has));
}

/// True if a JSON document text contains a non-empty top-level `"water"` array.
/// Deliberately a byte scan, not a `serde_json` parse: these payloads reach tens
/// of MB for dense cities, and materializing a full `Value` tree just to read one
/// bit would cost hundreds of ms on the async worker. We already hold the text;
/// finding the key and peeking the first non-space char after its `[` is enough.
/// Tolerates whitespace around `:` and `[`, so it survives even if the cache is
/// ever written pretty-printed instead of compact (the one realistic way the old
/// fixed-substring check could have silently broken).
fn json_has_nonempty_water(s: &str) -> bool {
    let Some(i) = s.find("\"water\"") else { return false };
    let after_key = s[i + "\"water\"".len()..].trim_start();
    let Some(after_colon) = after_key.strip_prefix(':') else { return false };
    let Some(in_array) = after_colon.trim_start().strip_prefix('[') else { return false };
    // Non-empty iff the next non-space char isn't the array's closing bracket.
    in_array.trim_start().starts_with(|c| c != ']')
}

/// Whether the cached OSM file for `date` has a water layer. Used by
/// `get_status` when the wallpaper was already cached this session (so the
/// pipeline never parsed the data). See `json_has_nonempty_water` for why this
/// scans rather than parses.
pub fn cached_data_has_water(cache: &Path, date: NaiveDate) -> bool {
    let path = cache.join(format!("{}.osm.json", date));
    fs::read_to_string(path).map_or(false, |s| json_has_nonempty_water(&s))
}

/// Read the `has_water` flag for `date`, computing and caching it from the
/// cached OSM file on first miss.
pub fn has_water_for(app: &AppHandle, date: NaiveDate) -> bool {
    let state = app.state::<AppState>();
    {
        let g = state.has_water.lock().unwrap();
        if let Some((d, v)) = *g {
            if d == date {
                return v;
            }
        }
    }
    let has = cache_dir(app).map(|c| cached_data_has_water(&c, date)).unwrap_or(false);
    *state.has_water.lock().unwrap() = Some((date, has));
    has
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
    let _ = app.emit("pipeline:start", ());
    let r = run_inner(&app, date).await;
    {
        let state = app.state::<AppState>();
        let mut g = state.running.lock().await;
        *g = false;
    }
    let _ = app.emit("pipeline:end", ());
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
    // scripts/precache-osm.ts: the precached square (aspect=1) is the superset
    // every screen-aspect rectangle here must fit inside, so the CDN data
    // always covers the wallpaper.
    let bbox = bbox_for_screen(city.lat, city.lon, 10.0, aspect);

    // OSM acquisition order: local day cache → jsDelivr CDN (pre-cached 20km
    // square, China-reachable) → live Overpass (screen rectangle). The CDN
    // square is a superset of `bbox`, so the renderer projects within `bbox`
    // and clips the rest; Overpass fetches exactly `bbox` to save bandwidth.
    let osm_path = cache.join(format!("{}.osm.json", date));
    let osm: serde_json::Value = if osm_path.exists() {
        serde_json::from_str(&fs::read_to_string(&osm_path)?)?
    } else {
        let v = match cdn::fetch_cached_osm(city.id).await {
            Ok(v) => {
                eprintln!("[pipeline] osm from CDN ({})", city.id);
                v
            }
            Err(e) => {
                eprintln!("[pipeline] CDN miss ({}), falling back to Overpass: {}", city.id, e);
                overpass::fetch_roads(bbox).await?
            }
        };
        fs::write(&osm_path, v.to_string())?;
        v
    };

    // Record whether this city's data has a water layer so the UI can decide
    // whether to surface the "show water" toggle.
    set_has_water(app, date, osm_value_has_water(&osm));

    let colors = colors_for(app, theme);
    let preset = *app.state::<AppState>().style.lock().unwrap();
    let show_water = app.state::<AppState>().show_water.load(Ordering::Acquire);
    let style = Style { background: colors.background, foreground: colors.foreground, preset, show_water };

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
    eprintln!("[pipeline] wallpaper set: {} ({})", city.name, city.country);
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
                eprintln!("[pipeline] cache_dir: {}", e);
                return;
            }
        };
        let _ = fs::remove_file(png_path(&cache, date, theme));
        *app.state::<AppState>().last_applied.lock().unwrap() = None;
        if let Err(e) = run_for_date(app, date).await {
            eprintln!("[pipeline] force regen failed: {}", e);
        }
    });
}
