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
use crate::config::{ColorPair, StylePreset, ThemeMode, UpdateMode};
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

// ─────────────────────────────────────────────────────────────────────────────
// Cache layout (under the OS app-cache dir):
//
//   <cache>/wallpaper/
//     wallpaper-<ts>.png        ← the file actually handed to the OS. Rewritten
//                                 with a fresh timestamp on every apply so the
//                                 platform reliably re-reads it (macOS caches the
//                                 desktop image by URL). See wallpaper_set::set.
//     daily/                    ← the Daily rotation cache; pruned to KEEP_DAYS.
//       <date>-<theme>.png
//       <date>.osm.json
//     customized/               ← the Customized-pin cache. Writing a new
//                                 coordinate wipes every other coordinate's
//                                 files, so only the active pin is kept.
//       <lat>_<lon>-<theme>.png
//       <lat>_<lon>.osm.json
// ─────────────────────────────────────────────────────────────────────────────

// These four only *name* directories; they never create them. Creation belongs
// to the writers (`write_osm`, the PNG write, `wallpaper_set::set`), which all
// `create_dir_all` their parent — so a read of a not-yet-existing dir fails
// harmlessly as "nothing cached", and the scheduler's 60s poll
// (`desired_signature` → `resolve_target`) stays free of filesystem syscalls.

fn cache_dir(app: &AppHandle) -> Result<PathBuf> {
    Ok(app.path().app_cache_dir()?)
}

fn wallpaper_dir(app: &AppHandle) -> Result<PathBuf> {
    Ok(cache_dir(app)?.join("wallpaper"))
}

fn daily_dir(app: &AppHandle) -> Result<PathBuf> {
    Ok(wallpaper_dir(app)?.join("daily"))
}

fn custom_dir(app: &AppHandle) -> Result<PathBuf> {
    Ok(wallpaper_dir(app)?.join("customized"))
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

/// Format one coordinate for a filename: fixed to 5 decimals (~1 m), then
/// trailing zeros trimmed so `-68.17000` → `-68.17` while `-16.50016` is kept
/// verbatim. Used to build the stable per-pin cache key.
fn fmt_coord(v: f64) -> String {
    let s = format!("{v:.5}");
    let t = s.trim_end_matches('0').trim_end_matches('.');
    t.to_string()
}

fn coord_key(lat: f64, lon: f64) -> String {
    format!("{}_{}", fmt_coord(lat), fmt_coord(lon))
}

// ─────────────────────────────────────────────────────────────────────────────
// Render target resolution — turns the current UpdateMode into the concrete
// cache paths + signature to render, or `None` when there's nothing to do
// (updates disabled, or Customized with no pin applied yet).
//
// Note what a `Target` deliberately does *not* carry: the city. For the Daily
// flow the city and its map data have to be resolved *together* (see
// `resolve_daily`), and that resolution costs a CDN round trip — so it happens
// only once the target's cached PNG has been ruled out. See `Resolved`.
// ─────────────────────────────────────────────────────────────────────────────

enum TargetKind {
    /// The daily city for a date, resolved through the schedule (issue #1).
    Daily(NaiveDate),
    /// A user-pinned location (issue #11). Carries the coordinate key so a
    /// successful write can prune every *other* pin's files — only the active
    /// coordinate is kept.
    Custom { key: String, lat: f64, lon: f64 },
}

struct Target {
    /// Identity of this render for `last_applied` de-duping — see
    /// `AppState::last_applied`.
    signature: String,
    png_path: PathBuf,
    osm_path: PathBuf,
    kind: TargetKind,
}

fn daily_target(app: &AppHandle, date: NaiveDate, theme: EffectiveTheme) -> Result<Target> {
    let dir = daily_dir(app)?;
    let suffix = theme_suffix(theme);
    Ok(Target {
        signature: format!("daily:{date}:{suffix}"),
        png_path: dir.join(format!("{date}-{suffix}.png")),
        osm_path: dir.join(daily_osm_name(date)),
        kind: TargetKind::Daily(date),
    })
}

fn custom_target(app: &AppHandle, lat: f64, lon: f64, theme: EffectiveTheme) -> Result<Target> {
    let dir = custom_dir(app)?;
    let key = coord_key(lat, lon);
    let suffix = theme_suffix(theme);
    Ok(Target {
        signature: format!("custom:{key}:{suffix}"),
        png_path: dir.join(format!("{key}-{suffix}.png")),
        osm_path: dir.join(format!("{key}.osm.json")),
        kind: TargetKind::Custom { key, lat, lon },
    })
}

/// Resolve what to render right now, or `None` when updates are off / no pin.
/// A Customized pin takes precedence over the daily schedule by construction:
/// the mode selects exactly one of them, so the two never race.
fn resolve_target(
    app: &AppHandle,
    date: NaiveDate,
    theme: EffectiveTheme,
) -> Result<Option<Target>> {
    let mode = *app.state::<AppState>().update_mode.lock().unwrap();
    match mode {
        UpdateMode::Disable => Ok(None),
        UpdateMode::Daily => Ok(Some(daily_target(app, date, theme)?)),
        UpdateMode::Customized => {
            let custom = *app.state::<AppState>().custom.lock().unwrap();
            match custom {
                Some(c) => Ok(Some(custom_target(app, c.lat, c.lon, theme)?)),
                None => Ok(None),
            }
        }
    }
}

fn mark_applied(app: &AppHandle, signature: &str) {
    *app.state::<AppState>().last_applied.lock().unwrap() = Some(signature.to_string());
}

/// The signature the wallpaper *should* currently match, or `None` when there's
/// nothing to render (disabled / no pin). Cheap — the scheduler compares it to
/// `last_applied` to decide whether a repaint is even needed.
pub fn desired_signature(app: &AppHandle) -> Option<String> {
    let date = city::today();
    let theme = effective_theme(app);
    resolve_target(app, date, theme).ok().flatten().map(|t| t.signature)
}

/// Render today's target (per the current UpdateMode) and apply it as the
/// wallpaper. A no-op when updates are disabled or a Customized pin isn't set.
/// Coalesces with any in-flight render via `state.running`.
pub async fn run_now(app: AppHandle) -> Result<()> {
    {
        let state = app.state::<AppState>();
        let mut g = state.running.lock().await;
        if *g {
            return Ok(()); // already running — coalesce silently
        }
        *g = true;
    }
    FrontendEvent::PipelineStart.emit(&app);
    let r = run_now_inner(&app).await;
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

async fn run_now_inner(app: &AppHandle) -> Result<()> {
    let date = city::today();
    let theme = effective_theme(app);
    let Some(target) = resolve_target(app, date, theme)? else {
        return Ok(()); // updates disabled, or Customized with no pin yet
    };
    let live = wallpaper_dir(app)?;

    // Fast path: the render for this exact target is already on disk — just
    // reapply it. This is what makes switching Customized → Daily/Disable and
    // back to the *same* pin free: the customized cache is only pruned when a
    // *different* coordinate is applied (see `prune_other_custom`), never on a
    // mode switch, so the pin's PNG survives and we reapply it here without
    // touching the CDN or Overpass. (Even if only the PNG were missing,
    // `render_bytes_for` would still reuse the cached `.osm.json` and not refetch.)
    if target.png_path.exists() {
        wallpaper_set::set(&target.png_path, &live)?;
        mark_applied(app, &target.signature);
        return Ok(());
    }

    // A new Customized coordinate supersedes any previous pin — drop the old
    // pin's files before writing the new ones so only the active pin is kept.
    if let TargetKind::Custom { ref key, .. } = target.kind {
        if let Ok(dir) = custom_dir(app) {
            let _ = prune_other_custom(&dir, key);
        }
    }

    let resolved = resolve_and_record(app, &target.kind).await;
    let city = resolved.city.clone();
    let bytes = render_bytes_for(app, &target.signature, &target.osm_path, resolved).await?;
    if let Some(parent) = target.png_path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&target.png_path, &bytes)?;
    wallpaper_set::set(&target.png_path, &live)?;
    mark_applied(app, &target.signature);

    if let TargetKind::Daily(_) = target.kind {
        if let Ok(dir) = daily_dir(app) {
            let _ = cleanup_daily(&dir, KEEP_DAYS);
        }
    }
    log::info!("[pipeline] wallpaper set: {} ({})", city.name, city.country);
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// City + OSM resolution. Only reached once a target's cached PNG has been ruled
// out, because it can cost a CDN round trip.
// ─────────────────────────────────────────────────────────────────────────────

/// A day's OSM payload when resolution already had it in hand, tagged with
/// whether it still needs writing to the cache. The distinction is the whole
/// point: these payloads run to tens of MB, so re-persisting one we just read
/// back off disk would be a pointless multi-MB write.
enum DayOsm {
    /// Freshly fetched from the schedule manifest — not on disk yet.
    Fetched(serde_json::Value),
    /// Read back from the OSM cache — already on disk.
    Cached(serde_json::Value),
}

/// What a target actually depicts: the city, plus whatever OSM payload resolving
/// it already produced (the two must be resolved together — see `resolve_daily`).
struct Resolved {
    city: city::City,
    /// `Some(id)` ⇒ the legacy id-keyed jsDelivr pre-cache may hold this city's
    /// map data and is worth a try; `None` ⇒ sidecar only (a Customized pin is
    /// arbitrary coordinates, never precached).
    cdn_id: Option<u64>,
    osm: Option<DayOsm>,
}

/// The synthetic `City` a Customized pin renders as. Not a real place — there's
/// no GeoNames id or name for arbitrary coordinates — so it carries the formatted
/// coordinates as its name for logging and gets `id: 0` to keep it out of the
/// id-keyed CDN path.
fn pin_city(lat: f64, lon: f64) -> city::City {
    city::City {
        id: 0,
        name: format!("{lat:.4}, {lon:.4}"),
        local_name: String::new(),
        country: String::new(),
        lat,
        lon,
        population: 0,
    }
}

/// Resolve what `kind` depicts, recording a Daily resolution in
/// `AppState::resolved_city` so `Status` names the city that was actually
/// rendered instead of recomputing the rotation pick. A Customized pin isn't a
/// city and deliberately doesn't touch that memo.
async fn resolve_and_record(app: &AppHandle, kind: &TargetKind) -> Resolved {
    match *kind {
        TargetKind::Custom { lat, lon, .. } => Resolved {
            city: pin_city(lat, lon),
            cdn_id: None,
            osm: None,
        },
        TargetKind::Daily(date) => {
            let resolved = resolve_daily(app, date).await;
            let state = app.state::<AppState>();
            *state.resolved_city.lock().unwrap() = Some((date, resolved.city.clone()));
            // Push the name to an open window now rather than at the end of the
            // render: the CDN round trip is over, but the renderer still has work
            // to do.
            state.mark_status_dirty();
            resolved
        }
    }
}

/// The day's city + (optionally) its OSM. Resolution order: the local day cache,
/// then the date-keyed schedule manifest (issue #1) — one CDN request yields both
/// the constrained-random city and its map data — then the legacy client-side
/// rotation pick, which leaves OSM to be fetched the usual way. Fallback-guarded
/// so the new path can never break the existing behavior.
async fn resolve_daily(app: &AppHandle, date: NaiveDate) -> Resolved {
    // Dev Mode's "bypass cache & CDN": neither the day cache nor the schedule is
    // consulted, so the rotation picks the city and `render_bytes_for` fetches
    // live from the sidecar.
    if app.state::<AppState>().effective_bypass_cache() {
        return rotation_fallback(date, None);
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
        match city_envelope(&v) {
            Some(city) => {
                log::info!(
                    "[pipeline] city for {} from day cache: {} ({})",
                    date,
                    city.name,
                    city.country
                );
                let cdn_id = Some(city.id);
                return Resolved { city, cdn_id, osm: Some(DayOsm::Cached(v)) };
            }
            None => return rotation_fallback(date, Some(DayOsm::Cached(v))),
        }
    }

    match cdn::fetch_scheduled(&date.to_string()).await {
        Ok((city, v)) => {
            log::info!("[pipeline] scheduled city for {}: {} ({})", date, city.name, city.country);
            let cdn_id = Some(city.id);
            Resolved { city, cdn_id, osm: Some(DayOsm::Fetched(v)) }
        }
        Err(e) => {
            log::info!("[pipeline] no schedule manifest for {} ({}); using rotation", date, e);
            rotation_fallback(date, None)
        }
    }
}

/// The legacy client-side rotation pick — the fallback whenever the schedule
/// can't answer. `osm` carries a day cache that was already read back, if any.
fn rotation_fallback(date: NaiveDate, osm: Option<DayOsm>) -> Resolved {
    let city = city::pick_for_date(date);
    let cdn_id = Some(city.id);
    Resolved { city, cdn_id, osm }
}

/// The city `date`'s wallpaper shows, for `Status`. Three sources, in order:
///
///  1. `AppState::resolved_city`, set by every Daily `resolve_and_record` — the
///     authoritative answer once the pipeline has run this session.
///  2. That day's cached OSM payload. `run_now_inner` short-circuits on an
///     existing PNG without resolving anything, so after a restart onto an
///     already-rendered day (1) is empty; the cached payload carries the `city`
///     envelope both published flows now stamp on, so it says exactly what was
///     rendered.
///  3. The rotation pick — correct for the days that fell back to it, including
///     every payload fetched live from the sidecar (no envelope) and every day
///     not yet rendered at all.
///
/// The answer is memoized under (1) either way: these payloads run to tens of MB,
/// and `Status` is rebuilt on every settings change. A later pipeline run
/// overwrites the memo, so a day that starts on the rotation and later resolves
/// to a scheduled city still corrects itself.
///
/// Describes the *Daily* rotation only, which is what `Status::city` reports —
/// a Customized pin is shown by its own City-tab panel from `Status::custom`.
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

/// The Daily flow's OSM cache filename for `date`. One definition so
/// `daily_target` and `cached_day_osm` can't drift apart.
fn daily_osm_name(date: NaiveDate) -> String {
    format!("{}.osm.json", date)
}

/// `date`'s cached OSM payload, or `None` when there is none / it won't parse.
/// A corrupt one reads as absent on purpose: the caller then refetches and
/// overwrites it, rather than failing the render on a file we can't use.
fn cached_day_osm(app: &AppHandle, date: NaiveDate) -> Option<serde_json::Value> {
    let path = daily_dir(app).ok()?.join(daily_osm_name(date));
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

/// Fetch the target's OSM data and render it via the hidden renderer window,
/// returning the raw PNG bytes. Writes the OSM cache but NOT the PNG — the caller
/// owns the PNG (so `render_preview` can render without persisting a wallpaper).
///
/// `job_id` is echoed back by the renderer and matched against the pending job,
/// so a stale result (e.g. a superseded custom pin) is rejected.
async fn render_bytes_for(
    app: &AppHandle,
    job_id: &str,
    osm_path: &Path,
    resolved: Resolved,
) -> Result<Vec<u8>> {
    let renderer = ensure_renderer(app).await?;
    let (w, h) = primary_size(&renderer)?;
    let aspect = w as f64 / h as f64;
    // 10km half = 20km long side. MUST match MAX_HALF_KM in scripts/osm-cli.ts:
    // the precached square (aspect=1) is the superset every screen-aspect
    // rectangle here must fit inside, so the CDN data always covers the wallpaper.
    let Resolved { city, cdn_id, osm: preloaded } = resolved;
    let bbox = bbox_for_screen(city.lat, city.lon, 10.0, aspect);

    // OSM acquisition order: local cache → the date-keyed schedule manifest →
    // jsDelivr's id-keyed pre-cache (20km square, China-reachable) → the osm-cli
    // sidecar, run live (screen rectangle). The first two steps happen in
    // `resolve_daily`, because both also decide *which city* this is and the two
    // answers must not be resolved independently; whatever it found arrives here
    // as `preloaded`. The remaining two run below.
    //
    // The CDN square is a superset of `bbox`, so the renderer projects within
    // `bbox` and clips the rest; the sidecar fetches exactly `bbox` to save
    // bandwidth. Both the CDN payload and the sidecar go through the same TS
    // implementation (src/core/osm/fetch-city.ts), so a CDN miss never produces
    // data poorer than the CDN's (e.g. water is never missing just because we
    // fell back).
    //
    // A Customized pin has no precached entry (`cdn_id` is `None`), so it goes
    // straight to the sidecar — which honors the proxy, important for
    // mainland-China users.
    let osm: serde_json::Value = match preloaded {
        // Fetched from the date-keyed schedule manifest (issue #1): authoritative
        // for the scheduled city, so cache + use it directly (overwriting any
        // stale day cache from a prior rotation pick).
        Some(DayOsm::Fetched(v)) => {
            write_osm(osm_path, &v)?;
            v
        }
        // Already the contents of `osm_path` — writing it back would just burn a
        // multi-MB write.
        Some(DayOsm::Cached(v)) => v,
        // No usable cache and no manifest — or Dev Mode's "bypass cache & CDN",
        // which skips both on purpose (gated read; see
        // `AppState::effective_bypass_cache`) and fetches live from the sidecar,
        // writing it back so it overwrites the stale local data.
        None => {
            let bypass = app.state::<AppState>().effective_bypass_cache();
            let v = if bypass {
                log::info!("[pipeline] bypass on: fetching osm live from sidecar (overwriting cache)");
                osm_sidecar::fetch(app, bbox).await?
            } else if let Some(id) = cdn_id {
                match cdn::fetch_cached_osm(id).await {
                    Ok(v) => {
                        log::info!("[pipeline] osm from CDN ({id})");
                        v
                    }
                    Err(e) => {
                        log::warn!("[pipeline] CDN miss ({id}), falling back to sidecar: {e}");
                        osm_sidecar::fetch(app, bbox).await?
                    }
                }
            } else {
                log::info!("[pipeline] custom pin: fetching osm live from sidecar");
                osm_sidecar::fetch(app, bbox).await?
            };
            write_osm(osm_path, &v)?;
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
        *g = Some(PendingJob { date: job_id.to_string(), tx });
    }

    let req = RenderRequest {
        date: job_id.to_string(),
        bbox,
        width: w,
        height: h,
        style,
        osm,
    };
    renderer.emit("render-request", &req)?;

    tokio::time::timeout(Duration::from_secs(120), rx)
        .await
        .map_err(|_| anyhow!("renderer timeout"))?
        .map_err(|_| anyhow!("renderer dropped"))
}

fn write_osm(path: &Path, v: &serde_json::Value) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, v.to_string())?;
    Ok(())
}

/// Render (but do not apply or cache as a wallpaper) the daily city for `date` —
/// Dev Mode's "Advance Preview". Always previews the Daily flow regardless of the
/// current UpdateMode. Reuses the same OSM day-cache as the real pipeline
/// (harmless: it's the exact theme-independent payload the real pipeline will
/// fetch anyway once that day arrives), but deliberately does NOT write to the
/// PNG cache path (`{date}-{theme}.png`): the real pipeline treats that path's
/// mere existence as "already rendered, just reapply it" with no staleness check,
/// so a preview-cached PNG would silently outlive a later style/color change and
/// get wrongly reapplied when that day actually arrives. Shares `state.running`
/// with the real pipeline (both drive the same single renderer window/channel, so
/// only one may be in flight at a time) — callers see this as the same "busy"
/// state as a normal regen.
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
    let theme = effective_theme(app);
    let r = match daily_target(app, date, theme) {
        Ok(target) => {
            let resolved = resolve_and_record(app, &target.kind).await;
            let city = resolved.city.clone();
            render_bytes_for(app, &target.signature, &target.osm_path, resolved)
                .await
                .map(|bytes| (city, bytes))
        }
        Err(e) => Err(e),
    };
    {
        let state = app.state::<AppState>();
        let mut g = state.running.lock().await;
        *g = false;
    }
    FrontendEvent::PipelineEnd.emit(app);
    app.state::<AppState>().mark_status_dirty();
    r
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

/// Visit every date-keyed artifact in `dir` — the downloaded OSM data
/// (`YYYY-MM-DD.osm.json`) and rendered wallpapers (`YYYY-MM-DD-<theme>.png`).
/// Matches on the leading 10-char ISO date prefix (slicing, not splitting on
/// '.'), so it never touches anything that isn't ours. Used by `cleanup_daily`.
fn for_each_daily_artifact(dir: &Path, mut f: impl FnMut(&fs::DirEntry, NaiveDate)) -> Result<()> {
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

fn cleanup_daily(dir: &Path, keep_days: i64) -> Result<()> {
    let today = city::today();
    for_each_daily_artifact(dir, |entry, d| {
        if (today - d).num_days() > keep_days {
            let _ = fs::remove_file(entry.path());
        }
    })
}

/// Drop every file in the customized cache that doesn't belong to `key` (the
/// active pin), so applying a new coordinate leaves only that coordinate's
/// files. A pin's files are `<key>.osm.json` and `<key>-<theme>.png`.
fn prune_other_custom(dir: &Path, key: &str) -> Result<()> {
    let osm = format!("{key}.osm.json");
    let png_prefix = format!("{key}-");
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let belongs = name == osm || name.starts_with(&png_prefix);
        if !belongs {
            let _ = fs::remove_file(entry.path());
        }
    }
    Ok(())
}

/// Recursively delete every file under `dir`, tallying count + bytes freed, then
/// remove the now-empty directories. Used by `wipe_cache`.
fn remove_tree_counting(dir: &Path, files: &mut usize, bytes: &mut u64) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            remove_tree_counting(&path, files, bytes);
            let _ = fs::remove_dir(&path);
        } else {
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            if fs::remove_file(&path).is_ok() {
                *files += 1;
                *bytes += size;
            }
        }
    }
}

/// Wipe the whole wallpaper cache (daily + customized + the live copies), plus
/// any legacy flat artifacts left in the cache root by pre-reorg versions.
/// Returns (files removed, bytes freed). The cache is fully regenerable — the
/// next render re-fetches and re-renders. Used by `commands::clean_cache`.
pub fn wipe_cache(app: &AppHandle) -> Result<(usize, u64)> {
    let root = cache_dir(app)?;
    let mut files = 0usize;
    let mut bytes = 0u64;
    remove_tree_counting(&root.join("wallpaper"), &mut files, &mut bytes);
    // Legacy layout: <date>-<theme>.png / <date>.osm.json and macOS ".live." copies
    // written directly in the cache root before the wallpaper/ reorg.
    let _ = for_each_daily_artifact(&root, |entry, _| {
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        if fs::remove_file(entry.path()).is_ok() {
            files += 1;
            bytes += size;
        }
    });
    Ok((files, bytes))
}

/// Apply the current mode's wallpaper without forcing a re-render — reuses a
/// cached PNG if one exists, otherwise renders it. Fire-and-forget; errors are
/// logged. Used on mode switches / applying a pin, where the goal is to show the
/// right wallpaper, not necessarily a fresh render. A no-op when disabled / no pin.
pub fn spawn_apply(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = run_now(app).await {
            log::error!("[pipeline] apply failed: {e}");
        }
    });
}

/// Delete the current target's PNG and re-render + reapply it (OSM data is reused
/// if cached). Used for theme switches, style/color/layer edits, and "regenerate
/// now" — where the output must change even though the filename may not. Clearing
/// `last_applied` ensures the scheduler re-applies rather than treating stale
/// state as current. Fire-and-forget: errors are logged. A no-op when updates are
/// disabled / no pin.
pub fn spawn_force_regen(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let date = city::today();
        let theme = effective_theme(&app);
        if let Ok(Some(target)) = resolve_target(&app, date, theme) {
            let _ = fs::remove_file(&target.png_path);
        }
        *app.state::<AppState>().last_applied.lock().unwrap() = None;
        if let Err(e) = run_now(app).await {
            log::error!("[pipeline] force regen failed: {e}");
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

    // The pin cache key is a filename component, so it must be stable and free of
    // trailing-zero noise — two spellings of the same coordinate have to hit the
    // same cache entry.
    #[test]
    fn coord_key_trims_trailing_zeros() {
        assert_eq!(coord_key(-16.5, -68.17), "-16.5_-68.17");
        assert_eq!(coord_key(-16.50000, -68.170000), "-16.5_-68.17");
        assert_eq!(coord_key(0.0, 0.0), "0_0");
    }

    // ~1 m of precision is kept; anything finer collapses into the same key.
    #[test]
    fn coord_key_keeps_five_decimals() {
        assert_eq!(coord_key(-16.50016, 68.123456), "-16.50016_68.12346");
    }

    // `prune_other_custom` runs over a directory that holds the *previous* pin's
    // files, so the active pin's own files must survive and everything else must go.
    #[test]
    fn prune_other_custom_keeps_only_the_active_pin() {
        let dir = std::env::temp_dir().join(format!("inkcity-prune-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let keep = ["51.5_-0.12.osm.json", "51.5_-0.12-light.png", "51.5_-0.12-dark.png"];
        let drop = ["48.85_2.35.osm.json", "48.85_2.35-light.png"];
        for f in keep.iter().chain(drop.iter()) {
            fs::write(dir.join(f), b"x").unwrap();
        }
        prune_other_custom(&dir, "51.5_-0.12").unwrap();
        for f in keep {
            assert!(dir.join(f).exists(), "{f} should have been kept");
        }
        for f in drop {
            assert!(!dir.join(f).exists(), "{f} should have been pruned");
        }
        let _ = fs::remove_dir_all(&dir);
    }
}
