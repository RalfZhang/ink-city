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
    #[serde(rename = "showRailways")]
    show_railways: bool,
    #[serde(rename = "showAerialways")]
    show_aerialways: bool,
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

/// `date`'s OSM payload when resolution already had it in hand, tagged with
/// whether it still needs writing to the day cache. The distinction is the whole
/// point: these payloads run to tens of MB, so re-persisting one we just read
/// back off disk would be a pointless multi-MB write.
enum DayOsm {
    /// Freshly fetched from the schedule manifest — not on disk yet.
    Fetched(serde_json::Value),
    /// Read back from `<date>.osm.json` — already on disk.
    Cached(serde_json::Value),
}

/// The day's city + (optionally) its OSM. Resolution order: the local day cache,
/// then the date-keyed schedule manifest (issue #1) — one CDN request yields both
/// the constrained-random city and its map data — then the legacy client-side
/// rotation pick, which leaves OSM to be fetched the usual way. Fallback-guarded
/// so the new path can never break the existing behavior.
///
/// Records the outcome in `AppState::resolved_city` so `Status` names the city
/// that was actually rendered instead of recomputing the rotation pick.
async fn resolve_city_and_osm(app: &AppHandle, date: NaiveDate) -> (city::City, Option<DayOsm>) {
    let (city, preloaded) = resolve_city_inner(app, date).await;
    let state = app.state::<AppState>();
    *state.resolved_city.lock().unwrap() = Some((date, city.clone()));
    // Push the name to an open window now rather than at the end of the render:
    // the CDN round trip is over, but the renderer still has work to do.
    state.mark_status_dirty();
    (city, preloaded)
}

/// The resolution itself; `resolve_city_and_osm` wraps it to record the outcome.
async fn resolve_city_inner(app: &AppHandle, date: NaiveDate) -> (city::City, Option<DayOsm>) {
    // Dev Mode's "bypass cache & CDN": neither the day cache nor the schedule is
    // consulted, so the rotation picks the city and `render_bytes_for` fetches
    // live from the sidecar.
    if app.state::<AppState>().effective_bypass_cache() {
        return (city::pick_for_date(date), None);
    }

    // The day cache comes before *any* network. Whatever is cached for `date` is
    // what that day was already rendered from, so this is both a big saving and
    // the thing that keeps a day stable:
    //
    //   - `spawn_force_regen` (theme switch, colour/style edit, Lab toggles,
    //     "regenerate now") deletes only the PNG and re-enters the pipeline. Its
    //     doc promises "OSM data is reused if cached" — resolving past the cache
    //     would re-download the whole manifest, tens of MB, on every colour tweak.
    //   - Mid-day the answer can *change*: a schedule manifest that lands after
    //     the day already rendered from the rotation would swap the city out from
    //     under a PNG still cached for the other theme. The PNG cache key is
    //     date+theme, not city, so once a day is rendered it must keep its city.
    //
    // An envelope-less payload predates the `city` stamp or came from a live
    // sidecar fetch — both are the rotation city by construction, so that's the
    // right fallback for its name.
    if let Some(v) = cached_day_osm(app, date) {
        let city = city_envelope(&v).unwrap_or_else(|| city::pick_for_date(date));
        log::info!("[pipeline] city for {} from day cache: {} ({})", date, city.name, city.country);
        return (city, Some(DayOsm::Cached(v)));
    }

    match cdn::fetch_scheduled(&date.to_string()).await {
        Ok((city, v)) => {
            log::info!("[pipeline] scheduled city for {}: {} ({})", date, city.name, city.country);
            (city, Some(DayOsm::Fetched(v)))
        }
        Err(e) => {
            log::info!("[pipeline] no schedule manifest for {} ({}); using rotation", date, e);
            (city::pick_for_date(date), None)
        }
    }
}

/// The city `date`'s wallpaper shows, for `Status`. Three sources, in order:
///
///  1. `AppState::resolved_city`, set by every `resolve_city_and_osm` — the
///     authoritative answer once the pipeline has run this session.
///  2. That day's cached OSM payload. `run_inner` short-circuits on an existing
///     PNG without resolving anything, so after a restart onto an already-rendered
///     day (1) is empty; the cached payload carries the `city` envelope both
///     published flows now stamp on, so it says exactly what was rendered.
///  3. The rotation pick — correct for the days that fell back to it, including
///     every payload fetched live from the sidecar (no envelope) and every day
///     not yet rendered at all.
///
/// The answer is memoized under (1) either way: these payloads run to tens of MB,
/// and `Status` is rebuilt on every settings change. A later pipeline run
/// overwrites the memo, so a day that starts on the rotation and later resolves
/// to a scheduled city still corrects itself.
pub fn city_for_status(app: &AppHandle, date: NaiveDate) -> city::City {
    let state = app.state::<AppState>();
    if let Some((d, c)) = state.resolved_city.lock().unwrap().as_ref() {
        if *d == date {
            return c.clone();
        }
    }
    let city = cached_day_city(app, date).unwrap_or_else(|| city::pick_for_date(date));
    *state.resolved_city.lock().unwrap() = Some((date, city.clone()));
    city
}

/// `date`'s cached OSM payload, or `None` when there is none / it won't parse.
/// A corrupt one reads as absent on purpose: the caller then refetches and
/// overwrites it, rather than failing the render on a file we can't use.
fn cached_day_osm(app: &AppHandle, date: NaiveDate) -> Option<serde_json::Value> {
    let path = cache_dir(app).ok()?.join(format!("{}.osm.json", date));
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

/// The `city` envelope both published flows stamp onto a payload, or `None` when
/// it predates the envelope (a live sidecar fetch) or is half-written.
fn city_envelope(v: &serde_json::Value) -> Option<city::City> {
    serde_json::from_value(v.get("city")?.clone()).ok()
}

/// The `city` envelope on `<date>.osm.json` — `city_for_status`'s source (2).
fn cached_day_city(app: &AppHandle, date: NaiveDate) -> Option<city::City> {
    city_envelope(&cached_day_osm(app, date)?)
}

async fn run_inner(app: &AppHandle, date: NaiveDate) -> Result<()> {
    let theme = effective_theme(app);
    let cache = cache_dir(app)?;
    let png_path = png_path(&cache, date, theme);

    if png_path.exists() {
        wallpaper_set::set(&png_path)?;
        mark_applied(app, date, theme);
        return Ok(());
    }

    let (city, preloaded) = resolve_city_and_osm(app, date).await;
    let bytes = render_bytes_for(app, &cache, date, &city, preloaded).await?;

    fs::write(&png_path, &bytes)?;
    wallpaper_set::set(&png_path)?;
    mark_applied(app, date, theme);
    let _ = cleanup_cache(&cache, KEEP_DAYS);
    log::info!("[pipeline] wallpaper set: {} ({})", city.name, city.country);
    Ok(())
}

/// Fetch `date`'s OSM data (city + bbox derived from it) and render it via the
/// hidden renderer window, returning the raw PNG bytes. Shared by the real
/// pipeline (`run_inner`, which then writes/applies the PNG) and
/// `render_preview` (Dev Mode's "Advance Preview", which does neither — see
/// its doc comment for why).
async fn render_bytes_for(
    app: &AppHandle,
    cache: &Path,
    date: NaiveDate,
    city: &city::City,
    preloaded: Option<DayOsm>,
) -> Result<Vec<u8>> {
    let renderer = ensure_renderer(app).await?;
    let (w, h) = primary_size(&renderer)?;
    let aspect = w as f64 / h as f64;
    // 10km half = 20km long side. MUST match MAX_HALF_KM in
    // scripts/osm-cli.ts: the precached square (aspect=1) is the superset
    // every screen-aspect rectangle here must fit inside, so the CDN data
    // always covers the wallpaper.
    let bbox = bbox_for_screen(city.lat, city.lon, 10.0, aspect);

    // OSM acquisition order: local day cache → the date-keyed schedule manifest
    // → jsDelivr's id-keyed pre-cache (20km square, China-reachable) → the
    // osm-cli sidecar, run live (screen rectangle). The first two steps happen in
    // `resolve_city_inner`, because both also decide *which city* this is and the
    // two answers must not be resolved independently; whatever it found arrives
    // here as `preloaded`. The remaining two run below.
    //
    // The CDN square is a superset of `bbox`, so the renderer projects within
    // `bbox` and clips the rest; the sidecar fetches exactly `bbox` to save
    // bandwidth. Both the CDN payload and the sidecar go through the same TS
    // implementation (src/core/osm/fetch-city.ts), so a CDN miss never produces
    // data poorer than the CDN's (e.g. water is never missing just because we
    // fell back).
    let osm_path = cache.join(format!("{}.osm.json", date));
    let osm: serde_json::Value = match preloaded {
        // Fetched from the date-keyed schedule manifest (issue #1): authoritative
        // for the scheduled city, so cache + use it directly (overwriting any
        // stale day cache from a prior rotation pick).
        Some(DayOsm::Fetched(v)) => {
            fs::write(&osm_path, v.to_string())?;
            v
        }
        // Already the contents of `osm_path` — writing it back would just burn a
        // multi-MB write.
        Some(DayOsm::Cached(v)) => v,
        // No usable day cache and no manifest — or Dev Mode's "bypass cache &
        // CDN", which skips both on purpose (gated read; see
        // `AppState::effective_bypass_cache`) and fetches live from the sidecar,
        // writing it back so it overwrites the stale local data.
        None => {
            let bypass = app.state::<AppState>().effective_bypass_cache();
            let v = if bypass {
                log::info!("[pipeline] bypass on: fetching osm live from sidecar (overwriting cache)");
                osm_sidecar::fetch(app, bbox).await?
            } else {
                match cdn::fetch_cached_osm(city.id).await {
                    Ok(v) => {
                        log::info!("[pipeline] osm from CDN ({})", city.id);
                        v
                    }
                    Err(e) => {
                        log::warn!("[pipeline] CDN miss ({}), falling back to sidecar: {}", city.id, e);
                        osm_sidecar::fetch(app, bbox).await?
                    }
                }
            };
            fs::write(&osm_path, v.to_string())?;
            v
        }
    };

    let theme = effective_theme(app);
    let colors = colors_for(app, theme);
    let preset = *app.state::<AppState>().style.lock().unwrap();
    let show_water = app.state::<AppState>().show_water.load(Ordering::Acquire);
    let show_airports = app.state::<AppState>().show_airports.load(Ordering::Acquire);
    let show_railways = app.state::<AppState>().show_railways.load(Ordering::Acquire);
    let show_aerialways = app.state::<AppState>().show_aerialways.load(Ordering::Acquire);
    let style = Style {
        background: colors.background,
        foreground: colors.foreground,
        preset,
        show_water,
        show_airports,
        show_railways,
        show_aerialways,
    };

    let (tx, rx) = oneshot::channel::<Vec<u8>>();
    {
        let state = app.state::<AppState>();
        let mut g = state.pending.lock().await;
        *g = Some(PendingJob { date: date.to_string(), tx });
    }

    let req = RenderRequest { date: date.to_string(), bbox, width: w, height: h, style, osm };
    renderer.emit("render-request", &req)?;

    tokio::time::timeout(Duration::from_secs(120), rx)
        .await
        .map_err(|_| anyhow!("renderer timeout"))?
        .map_err(|_| anyhow!("renderer dropped"))
}

/// Render (but do not apply or cache as a wallpaper) `date`'s city map — Dev
/// Mode's "Advance Preview". Reuses the same OSM-data cache as the real
/// pipeline (harmless: it's the exact theme-independent payload the real
/// pipeline will fetch anyway once that day's rotation arrives), but
/// deliberately does NOT write to the PNG cache path (`{date}-{theme}.png`):
/// the real pipeline treats that path's mere existence as "already rendered,
/// just reapply it" with no staleness check, so a preview-cached PNG would
/// silently outlive a later style/color change and get wrongly reapplied when
/// that day actually arrives. Shares `state.running` with the real pipeline
/// (both drive the same single renderer window/channel, so only one may be
/// in flight at a time) — callers see this as the same "busy" state as a
/// normal regen.
pub async fn render_preview(app: &AppHandle, date: NaiveDate) -> Result<(city::City, Vec<u8>)> {
    {
        let state = app.state::<AppState>();
        let mut g = state.running.lock().await;
        if *g {
            return Err(anyhow!("pipeline busy"));
        }
        *g = true;
    }
    FrontendEvent::PipelineStart.emit(app);
    let (city, preloaded) = resolve_city_and_osm(app, date).await;
    let cache = cache_dir(app);
    let r = match cache {
        Ok(cache) => render_bytes_for(app, &cache, date, &city, preloaded).await,
        Err(e) => Err(e),
    };
    {
        let state = app.state::<AppState>();
        let mut g = state.running.lock().await;
        *g = false;
    }
    FrontendEvent::PipelineEnd.emit(app);
    app.state::<AppState>().mark_status_dirty();
    r.map(|bytes| (city, bytes))
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

/// Visit every file in `dir` that InkCity itself wrote — the downloaded OSM data
/// (`YYYY-MM-DD.osm.json`) and the rendered wallpapers (`YYYY-MM-DD-<theme>.png`).
/// Everything we write is keyed by a leading 10-char ISO date, so we match on
/// that prefix (slicing rather than splitting on '.') and never touch anything
/// else that might live in the cache dir. `f` receives each matching entry and
/// its parsed date. Shared by `cleanup_cache` (age-based prune) and the Dev Mode
/// `clean_cache` command (delete-all).
pub fn for_each_artifact(dir: &Path, mut f: impl FnMut(&fs::DirEntry, NaiveDate)) -> Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let date_part = name.get(..10).unwrap_or("");
        if let Ok(d) = NaiveDate::parse_from_str(date_part, "%Y-%m-%d") {
            f(&entry, d);
        }
    }
    Ok(())
}

fn cleanup_cache(dir: &Path, keep_days: i64) -> Result<()> {
    let today = city::today();
    for_each_artifact(dir, |entry, d| {
        if (today - d).num_days() > keep_days {
            let _ = fs::remove_file(entry.path());
        }
    })
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

#[cfg(test)]
mod tests {
    use super::*;

    // `city_envelope` decides whether a cached day keeps the city it was rendered
    // from or silently falls back to the rotation pick, so all three shapes a day
    // cache can actually hold are pinned here.

    #[test]
    fn city_envelope_reads_a_stamped_payload() {
        let v: serde_json::Value = serde_json::from_str(
            r#"{"v":4,"elements":[],"city":{"id":1795565,"name":"Shenzhen","localName":"深圳",
                "country":"CN","lat":22.5466,"lon":114.0544,"population":17494398}}"#,
        )
        .unwrap();
        let city = city_envelope(&v).expect("stamped payload has a city");
        assert_eq!(city.id, 1795565);
        assert_eq!(city.local_name, "深圳");
    }

    // A live sidecar fetch, or anything cached before the envelope existed: the
    // caller must fall back to the rotation pick for the name.
    #[test]
    fn city_envelope_absent_on_an_unstamped_payload() {
        let v: serde_json::Value = serde_json::from_str(r#"{"v":4,"elements":[{"type":"way"}]}"#).unwrap();
        assert!(city_envelope(&v).is_none());
    }

    // Half-written: treated as absent rather than deserialized into a partial city.
    #[test]
    fn city_envelope_absent_on_a_partial_city() {
        let v: serde_json::Value = serde_json::from_str(r#"{"city":{"lat":22.5,"lon":114.0}}"#).unwrap();
        assert!(city_envelope(&v).is_none());
    }
}
