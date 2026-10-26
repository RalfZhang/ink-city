use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::Duration;

use anyhow::{anyhow, Result};
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Theme, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tokio::sync::oneshot;

use crate::bbox::{bbox_for_screen, Bbox};
use crate::cdn;
use crate::city;
use crate::config::{ColorPair, RailwayStyle, StylePreset, StyleVariant, ThemeMode, UpdateMode};
use crate::defaults;
use crate::events::FrontendEvent;
use crate::guess_store;
use crate::osm_sidecar;
use crate::state::{AppState, PendingJob};
use crate::wallpaper_set;

/// How many days of rendered Daily PNGs (`<date>.png`) the cache keeps.
/// Everything older is swept by `cleanup_daily` after each render.
const KEEP_DAYS: i64 = 7;

/// How many days *back* a day's downloaded OSM payload (`<date>.osm.json`) is
/// kept. Retention is split from `KEEP_DAYS` because the two artifacts have
/// wildly different costs: a rendered PNG is a few MB, while an `.osm.json` runs
/// to tens of MB — big city days hit 20 MB — and is only ever re-read to render
/// *the day it belongs to*, which every apply does afresh (`apply_target`). Past
/// days are never rendered again, so keeping a week of them was ~85 MB of pure
/// dead weight. One day back covers the timezone/midnight edge where "today" has
/// just rolled over but the wallpaper hasn't caught up.
const KEEP_OSM_DAYS: i64 = 1;

/// The theme a render is drawn for: `ThemeMode` with `System` resolved. Serialized
/// as the renderer's `Style.theme` and as `Status::effective_theme` (both `Theme`
/// in packages/core/src/types.ts).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
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
    #[serde(rename = "railwayStyle")]
    railway_style: RailwayStyle,
    #[serde(rename = "showAerialways")]
    show_aerialways: bool,
    variant: StyleVariant,
    /// Which of the variant's palettes to draw in. The ink variant's colors are
    /// `background`/`foreground` above already; Mondrian has its own per theme.
    theme: EffectiveTheme,
}

#[derive(Serialize, Clone)]
struct RenderRequest {
    date: String,
    bbox: Bbox,
    width: u32,
    height: u32,
    style: Style,
    osm: serde_json::Value,
    /// The city caption, or absent: an unlabeled request carries no `label` key at
    /// all, the core convention for an optional layer that's off (and what every
    /// renderer shipped before captions existed expects).
    #[serde(skip_serializing_if = "Option::is_none")]
    label: Option<LabelPayload>,
}

/// The city caption as `MapLabel` in packages/core/src/types.ts reads it — what to write,
/// and where. Language-neutral on purpose: the city's own name, its English name
/// and the country's English name, which is how a map's title block reads and spares
/// the cache a per-UI-language dimension.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct LabelPayload {
    corner: &'static str,
    name: String,
    local_name: String,
    country: String,
    /// From packages/core/data/countries.json; `None` falls back to the code in the renderer.
    country_name: Option<String>,
    lat: f64,
    lon: f64,
    /// How far (PNG px) the caption must stay from each edge — see `label_insets`.
    insets: Insets,
}

#[derive(Serialize, Clone, Copy, Debug, Default, PartialEq)]
struct Insets {
    top: f64,
    right: f64,
    bottom: f64,
    left: f64,
}

// ─────────────────────────────────────────────────────────────────────────────
// Cache layout (under the OS app-cache dir):
//
//   <cache>/wallpaper/
//     wallpaper-<ts>.png        ← the file actually handed to the OS. Rewritten
//                                 with a fresh timestamp on every apply so the
//                                 platform reliably re-reads it (macOS caches the
//                                 desktop image by URL). See wallpaper_set::set.
//     daily/                    ← the Daily rotation cache, swept by cleanup_daily.
//       <date>.png                ← that day's latest render, whatever its theme,
//                                   palette or caption: rewritten by every apply,
//                                   never read back as a cache hit (`apply_target`).
//                                   Kept KEEP_DAYS back (and any future preview).
//       <date>.osm.json           ← kept only KEEP_OSM_DAYS back; it's the heavy half.
//     customized/               ← the Customized-pin cache. Writing a new
//                                 coordinate wipes every other coordinate's
//                                 files, so only the active pin is kept.
//       <lat>_<lon>.png           ← the pin's latest render, like <date>.png.
//       <lat>_<lon>.osm.json
// ─────────────────────────────────────────────────────────────────────────────

// These four only *name* directories; they never create them. Creation belongs
// to the writers (`write_osm`, the PNG write, `wallpaper_set::set`), which all
// `create_dir_all` their parent — so a read of a not-yet-existing dir fails
// harmlessly as "nothing cached", and the scheduler's 60s poll
// (`desired_signature` → `resolve_target`) stays free of filesystem syscalls —
// save for `label_for` naming today's city once a day, through
// `city_for_status`'s memo (and only while a city caption is enabled).

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

pub fn colors_for(app: &AppHandle, theme: EffectiveTheme) -> ColorPair {
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
// `resolve_daily`), and that resolution can cost a CDN round trip — so it happens
// only in a run that renders, never in the scheduler's poll, which builds a
// target just for its signature. See `Resolved`.
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
    /// The city caption this render carries, as its corner's tag (`CityLabel::tag`),
    /// if any (`label_for`). Part of the signature, so it's decided here, before
    /// anything renders.
    label: Option<&'static str>,
}

fn daily_target(app: &AppHandle, date: NaiveDate, theme: EffectiveTheme) -> Result<Target> {
    let dir = daily_dir(app)?;
    let label = label_for(app, date);
    Ok(Target {
        signature: daily_signature(date, theme_suffix(theme), label),
        png_path: dir.join(daily_png_name(date)),
        osm_path: dir.join(daily_osm_name(date)),
        kind: TargetKind::Daily(date),
        label,
    })
}

/// A Daily render's `last_applied` signature: `daily:<date>:<theme>`, plus
/// `:label-<corner>` once the day is revealed. Only the signature tells the two
/// apart — the PNG is `<date>.png` either way — and that's where it matters:
/// revealing the day moves the *desired signature*, so the scheduler's poll keeps
/// repainting until the captioned image is actually up, even if the render the
/// reveal kicked off fails.
fn daily_signature(date: NaiveDate, theme: &str, label: Option<&str>) -> String {
    match label {
        Some(tag) => format!("daily:{date}:{theme}:label-{tag}"),
        None => format!("daily:{date}:{theme}"),
    }
}

/// A Daily render's PNG: the date alone. What it looks like — theme, palette,
/// caption — is never read off the name, because nothing reuses a PNG; every apply
/// renders afresh and rewrites it (`apply_target`).
fn daily_png_name(date: NaiveDate) -> String {
    format!("{date}.png")
}

/// The caption the Daily wallpaper for `date` should carry — the Style tab's corner,
/// as its tag — once the day is revealed (`guess_store::is_revealed`); `None` before
/// that, or when the setting is off.
///
/// Only *today* consults the day's city, through `city_for_status`'s memo. Any other
/// date — Dev Mode previewing a day ahead — is judged on the save alone: calling
/// `city_for_status` for it would overwrite today's memo, making the next `Status`
/// re-read today's payload just to recover it.
fn label_for(app: &AppHandle, date: NaiveDate) -> Option<&'static str> {
    let state = app.state::<AppState>();
    let tag = state.city_label.lock().unwrap().tag()?;
    // Looked up before `guess_view` is locked: `city_for_status` takes `resolved_city`.
    let city = if date == city::today() { city_for_status(app, date) } else { None };
    let revealed = guess_store::is_revealed(&state.guess_view.lock().unwrap(), date, city.as_ref());
    revealed.then_some(tag)
}

fn custom_target(app: &AppHandle, lat: f64, lon: f64, theme: EffectiveTheme) -> Result<Target> {
    let dir = custom_dir(app)?;
    let key = coord_key(lat, lon);
    Ok(Target {
        signature: format!("custom:{key}:{}", theme_suffix(theme)),
        png_path: dir.join(format!("{key}.png")),
        osm_path: dir.join(format!("{key}.osm.json")),
        kind: TargetKind::Custom { key, lat, lon },
        // A pin is coordinates, not a city — there's nothing to caption.
        label: None,
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

/// Record which Daily map is now the desktop wallpaper — see
/// `AppState::painted_day`. A Customized pin replaces it, so applying one clears it:
/// otherwise switching back to Daily would report today's map as up while the pin
/// is still showing, and open the game against it until the Daily render lands.
///
/// Pushes the change itself rather than leaving it to `run_now`'s closing push,
/// which a queued run would hold back for a whole extra render.
fn mark_painted(app: &AppHandle, target: &Target) {
    let day = match target.kind {
        TargetKind::Daily(date) => Some(date),
        TargetKind::Custom { .. } => None,
    };
    let state = app.state::<AppState>();
    let previous = std::mem::replace(&mut *state.painted_day.lock().unwrap(), day);
    if previous != day {
        state.mark_status_dirty();
    }
}

/// The signature the wallpaper *should* currently match, or `None` when there's
/// nothing to render (disabled / no pin). Cheap — the scheduler compares it to
/// `last_applied` to decide whether a repaint is even needed.
pub fn desired_signature(app: &AppHandle) -> Option<String> {
    let date = city::today();
    let theme = effective_theme(app);
    resolve_target(app, date, theme).ok().flatten().map(|t| t.signature)
}

/// Whether there's nothing to repaint: the wallpaper already shows what the current
/// settings ask for, or they ask for nothing (updates disabled, Customized with no
/// pin). The scheduler's poll runs on it (`scheduler::reconcile`), and so does a
/// change that may have moved the target (`commands::adopt_guess_view`).
pub fn up_to_date(app: &AppHandle) -> bool {
    desired_signature(app).is_none_or(|desired| {
        app.state::<AppState>().last_applied.lock().unwrap().as_deref() == Some(desired.as_str())
    })
}

/// What a caller of `run_now` needs. Both render the current target afresh and set
/// it (`apply_target`). `Force` also forgets what was last applied, and a queued
/// `Force` always runs where a queued `Apply` is skipped once up to date — so use it
/// when the look changed, which the signature doesn't encode. Declared weakest
/// first, so queued requests merge to the stronger one with `max` — see
/// `AppState::rerun`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum RunKind {
    Apply,
    Force,
}

/// Render today's target (per the current UpdateMode) and apply it as the
/// wallpaper. A no-op when updates are disabled or a Customized pin isn't set.
///
/// Only one run is ever in flight (`state.running` — there's one renderer window).
/// A request that arrives during a run used to be dropped, which lost real work: the
/// run in flight had already read its inputs, so a style edit or a caption change
/// made meanwhile only reached the wallpaper at some later regen. Now it's queued
/// instead (`AppState::rerun`), and the run that holds `running` goes round again
/// before letting go — checked and cleared under the same lock that releases
/// `running`, so a request can't slip in between the last check and the release.
/// `PipelineStart`/`End` bracket the whole loop, so the UI sees one busy stretch.
pub async fn run_now(app: AppHandle, kind: RunKind) -> Result<()> {
    {
        let state = app.state::<AppState>();
        let mut g = state.running.lock().await;
        if *g {
            let mut rerun = state.rerun.lock().unwrap();
            *rerun = (*rerun).max(Some(kind));
            return Ok(());
        }
        *g = true;
    }
    FrontendEvent::PipelineStart.emit(&app);
    let mut kind = kind;
    let mut queued = false;
    let r = loop {
        // A queued Apply is usually the scheduler's poll landing mid-render, which the
        // render it waited for has already satisfied — rerunning it would just set the
        // same wallpaper again. A queued Force always runs: something changed.
        let r = if queued && kind == RunKind::Apply && up_to_date(&app) {
            Ok(())
        } else {
            if kind == RunKind::Force {
                forget_applied(&app);
            }
            run_now_inner(&app).await
        };
        queued = true;
        let state = app.state::<AppState>();
        let mut g = state.running.lock().await;
        let next = state.rerun.lock().unwrap().take();
        match next {
            None => {
                *g = false;
                break r;
            }
            // An Apply queued behind a *failed* run isn't looped into: attempts that
            // fail slowly (CDN/Overpass timeouts, the renderer's 120s) outlast the
            // scheduler's 60s poll, which would queue another each time, so the loop
            // would retry back to back and never release `running` — the UI stuck
            // busy, `PipelineEnd` and the status push carrying `last_error` never
            // sent. The poll retries within a minute anyway, against whatever the
            // target has become by then. A queued Force still runs: something changed.
            Some(RunKind::Apply) if r.is_err() => {
                *g = false;
                break r;
            }
            Some(next) => {
                if let Err(e) = &r {
                    log::error!("[pipeline] run failed, running the queued one next: {e}");
                }
                kind = next;
            }
        }
    };
    FrontendEvent::PipelineEnd.emit(&app);
    // Push the post-render snapshot: running back to false, plus any new
    // date/city/has_water (e.g. the scheduler's midnight reconcile).
    app.state::<AppState>().mark_status_dirty();
    r
}

/// `RunKind::Force`'s extra step: forget what was last applied. The signature names
/// the target, not its look, so after a style edit it still matches the old image —
/// and if the render that edit asked for fails, the poll would take the old image
/// for up to date and never retry. Runs only while holding `state.running` (from
/// inside `run_now`'s loop): done before taking it, a render already in flight could
/// mark its pre-change image applied right after.
fn forget_applied(app: &AppHandle) {
    *app.state::<AppState>().last_applied.lock().unwrap() = None;
}

async fn run_now_inner(app: &AppHandle) -> Result<()> {
    let date = city::today();
    let theme = effective_theme(app);
    let Some(target) = resolve_target(app, date, theme)? else {
        // Nothing to render (disabled / no pin). Not an outcome either way, so the
        // memo below is left exactly as it was.
        return Ok(());
    };
    let r = apply_target(app, &target).await;
    // Record the Daily outcome for `Status::last_error` — the one path by which a
    // failure reaches the UI, since every caller of `run_now` is detached and drops
    // the `Result` (see `AppState::last_error`). Success clears it, so a day that
    // recovers stops reporting.
    //
    // Only the Daily flow, because `Status::city`/`last_error` describe that flow
    // alone: a pin's failure recorded here would surface as the reason the
    // *schedule* couldn't name the day, and "apply a pin, then switch back to
    // Daily" is an ordinary pair of actions. The date is stamped for the same
    // reason across midnight — see `commands::build_status`.
    if let TargetKind::Daily(d) = target.kind {
        *app.state::<AppState>().last_error.lock().unwrap() =
            r.as_ref().err().map(|e| (d, e.to_string()));
    }
    r
}

/// Everything `run_now_inner` does once it knows *what* to render: resolve, render
/// and cache it, then set it as the wallpaper. Split out from its caller only so the
/// outcome can be recorded against `target.kind` without wrapping this whole body in
/// a closure.
///
/// Always a fresh render, even when the target's PNG is already on disk: its name is
/// just the date (or the pin), so nothing on disk says which theme, palette, preset
/// or caption it was drawn with, and reapplying it could put back a look the user
/// has since changed. The map data is still reused — `resolve_and_record` reads the
/// cached `.osm.json` first — so switching Customized → Daily and back to the same
/// pin, or a theme flip, costs a render, never a download.
async fn apply_target(app: &AppHandle, target: &Target) -> Result<()> {
    let live = wallpaper_dir(app)?;

    // A new Customized coordinate supersedes any previous pin — drop the old
    // pin's files before writing the new ones so only the active pin is kept.
    if let TargetKind::Custom { ref key, .. } = target.kind {
        if let Ok(dir) = custom_dir(app) {
            let _ = prune_other_custom(&dir, key);
        }
    }

    let (city, _png) = render_and_cache(app, target).await?;
    wallpaper_set::set(&target.png_path, &live)?;
    mark_applied(app, &target.signature);
    mark_painted(app, target);

    if let TargetKind::Daily(_) = target.kind {
        if let Ok(dir) = daily_dir(app) {
            let _ = cleanup_daily(&dir, city::today());
        }
    }
    log::info!("[pipeline] wallpaper set: {} ({})", city.name, city.country);
    Ok(())
}

/// Resolve `target`, render it, and write both halves to its cache — the day's
/// (or pin's) `.osm.json` (inside `render_bytes_for`) and its `.png`.
/// Everything the pipeline does for a target *except* applying the wallpaper, so
/// `run_now_inner` and Dev Mode's Advance Preview can share one path and can't
/// drift apart. Returns the city drawn plus the PNG bytes.
async fn render_and_cache(app: &AppHandle, target: &Target) -> Result<(city::City, Vec<u8>)> {
    let resolved = resolve_and_record(app, target).await?;
    let city = resolved.city.clone();
    let bytes = render_bytes_for(app, target, resolved).await?;
    if let Some(parent) = target.png_path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&target.png_path, &bytes)?;
    Ok((city, bytes))
}

// ─────────────────────────────────────────────────────────────────────────────
// City + OSM resolution. Only reached by a run that renders, never by the poll's
// `desired_signature`, because it can cost a CDN round trip.
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
    osm: Option<DayOsm>,
    /// `Some(date)` ⇒ a payload fetched live from the sidecar gets `{ date, city }`
    /// spliced onto it before it's cached, reproducing exactly what the published
    /// `osm-v2/data/<date>.json` holds. That's what makes the reconstruction path
    /// (schedule state file + Overpass) produce a day cache indistinguishable from
    /// a manifest download — including for `city_for_status`, which reads the
    /// `city` envelope back after a restart. `None` for a Customized pin, which
    /// isn't a day and whose cache nothing reads for a name.
    stamp: Option<NaiveDate>,
}

/// The synthetic `City` a Customized pin renders as. Not a real place — there's
/// no GeoNames id or name for arbitrary coordinates — so it carries the formatted
/// coordinates as its name for logging and gets `id: 0`.
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
/// rendered. A Customized pin isn't a city and deliberately doesn't touch that
/// memo.
async fn resolve_and_record(app: &AppHandle, target: &Target) -> Result<Resolved> {
    match target.kind {
        TargetKind::Custom { lat, lon, .. } => {
            Ok(Resolved { city: pin_city(lat, lon), osm: None, stamp: None })
        }
        TargetKind::Daily(date) => {
            let resolved = resolve_daily(app, date, &target.osm_path).await?;
            let state = app.state::<AppState>();
            *state.resolved_city.lock().unwrap() = Some((date, Some(resolved.city.clone())));
            // Push the name to an open window now rather than at the end of the
            // render: the CDN round trip is over, but the renderer still has work
            // to do.
            state.mark_status_dirty();
            Ok(resolved)
        }
    }
}

/// The day's city + (optionally) its OSM, resolved together — the pair has to be
/// consistent, so nothing resolves one without the other.
///
/// The full ladder, in order, each rung tried only once the one above has missed:
///
///  1. **The local cache** at `osm_path`. No network, and load-bearing beyond the
///     saving — see the comment on that branch below.
///  2. **The published manifest** `osm-v2/data/<date>.json[.gz]`, one request for
///     the day's city *and* its map data. `cdn::fetch_scheduled` walks every CDN
///     edge (`.gz` then `.json` per host) before GitHub's raw origin, so this rung
///     alone is "CDN gz → CDN json → GitHub gz → GitHub json".
///  3. **Reconstruct it.** With no manifest anywhere, read the schedule *state*
///     file `osm-v2/city-list.json` (a few KB, CDN then GitHub) for the day's
///     city, fetch its map data live from Overpass, and splice `{ date, city }`
///     back on — yielding byte-for-byte the shape rung 2 would have delivered, so
///     the day cache and `city_for_status` can't tell the difference.
///
/// There is no rung below that any more. The client used to end on the
/// `src/data/cities.json` population rotation (`(days * 379) % N` + the id-keyed
/// `osm/<id>.json` pre-cache), which let a total CDN outage still paint *some*
/// city — a different one than the schedule had for that day. Rung 3 is now the
/// fallback: it needs only a few KB of the state file, so the case the rotation
/// covered had narrowed to "GitHub and every CDN edge unreachable, but Overpass
/// reachable". When even that misses, the day is unresolvable and this returns
/// `Err` — the caller leaves yesterday's wallpaper up and the scheduler retries on
/// its next poll, rather than painting a city nothing else agrees on.
///
/// Dev Mode's "bypass cache & CDN" jumps straight to rung 3 — see below.
async fn resolve_daily(app: &AppHandle, date: NaiveDate, osm_path: &Path) -> Result<Resolved> {
    let stamp = |city: city::City| Resolved { city, osm: None, stamp: Some(date) };

    // Dev Mode's "bypass cache & CDN". The switch is about the *map data*, not
    // about which city the day is — so the local cache and every published
    // manifest are skipped, and we go directly to rung 3. The one file still read
    // is the schedule state, and it's read from GitHub's origin rather than a CDN
    // edge (`Hosts::GithubOnly`), since a cached copy of it is precisely what the
    // switch is meant to rule out.
    if app.state::<AppState>().effective_bypass_cache() {
        let city = cdn::fetch_schedule_city(&date.to_string(), cdn::Hosts::GithubOnly)
            .await
            .map_err(|e| anyhow!("bypass on: no schedule city for {date}: {e}"))?;
        log::info!(
            "[pipeline] bypass on: schedule (github) says {} is {} ({}); osm live from overpass",
            date,
            city.name,
            city.country
        );
        return Ok(stamp(city));
    }

    // Rung 1. The cache comes before *any* network. Whatever is cached for `date`
    // is what that day was already rendered from, so this is both a big saving and
    // the thing that keeps a day stable:
    //
    //   - `spawn_force_regen` (theme switch, colour/style edit, Lab toggles,
    //     "regenerate now") deletes only today's PNGs and re-enters the pipeline. Its
    //     doc promises "OSM data is reused if cached" — resolving past the cache
    //     would re-download the whole manifest, tens of MB, on every colour tweak.
    //   - Mid-day the answer can *change*: a schedule manifest that lands after
    //     the day already rendered from the rotation would swap the city out from
    //     under a PNG still cached for the other theme. The PNG cache key is
    //     date+theme, not city, so once a day is rendered it must keep its city.
    //
    // An envelope-less payload predates the `city` stamp — every flow that writes
    // one now stamps it (see `stamp`). Nothing on disk says which city such a
    // payload depicts, and the rotation that used to name it is gone, so it reads
    // as a miss: pairing it with a city resolved further down would draw one city's
    // map under another's name.
    //
    // It's deleted rather than left for the answering rung to overwrite, because
    // the rungs below can *fail* (no host, or Overpass down after the state file
    // named the day) and then nothing overwrites anything. The file would sit there
    // unusable while every 60s poll re-read and re-parsed it — tens of MB — only to
    // discard it again. Deleting costs nothing: the payload is regenerable, and it
    // is provably unnameable, so there is no future in which we'd want it back.
    if let Some(v) = cached_osm_at(osm_path) {
        match city_envelope(&v) {
            Some(city) => {
                log::info!(
                    "[pipeline] city for {} from cache: {} ({})",
                    date,
                    city.name,
                    city.country
                );
                return Ok(Resolved { city, osm: Some(DayOsm::Cached(v)), stamp: Some(date) });
            }
            None => match fs::remove_file(osm_path) {
                Ok(()) => log::info!(
                    "[pipeline] dropped the cached payload for {}: no city envelope, so nothing \
                     can name it; re-resolving the day",
                    date
                ),
                // Worth its own line rather than a swallowed `let _`: a delete that
                // didn't happen is a file re-read and re-parsed on every 60s poll —
                // tens of MB, to reach this same branch again — which is precisely
                // the cost the delete exists to avoid. Not hypothetical on Windows,
                // where an indexer, AV scanner or sync client holding a handle
                // denies the unlink. The day still resolves either way, so this
                // doesn't abort the ladder.
                Err(e) => log::warn!(
                    "[pipeline] couldn't drop the unnameable cached payload for {} ({}); \
                     re-resolving the day anyway, but it will be re-read every poll \
                     until it goes",
                    date,
                    e
                ),
            },
        }
    }

    // Rung 2.
    match cdn::fetch_scheduled(&date.to_string()).await {
        Ok((city, v)) => {
            log::info!("[pipeline] scheduled city for {}: {} ({})", date, city.name, city.country);
            return Ok(Resolved { city, osm: Some(DayOsm::Fetched(v)), stamp: Some(date) });
        }
        // `info`, not `warn`: rung 3 still yields the *scheduled* city, so a missing
        // manifest costs an Overpass fetch, not correctness. Warning here would cry
        // wolf over the one rung that recovers on its own.
        Err(e) => {
            log::info!("[pipeline] no manifest for {} ({}); trying the schedule state", date, e)
        }
    }

    // Rung 3.
    match cdn::fetch_schedule_city(&date.to_string(), cdn::Hosts::Mirrored).await {
        Ok(city) => {
            log::info!(
                "[pipeline] schedule state says {} is {} ({}); rebuilding its manifest from overpass",
                date,
                city.name,
                city.country
            );
            Ok(stamp(city))
        }
        // Bottom of the ladder: no host served *either* schedule file, so there is
        // nothing that can name this day. Propagating the error (rather than the
        // rotation pick this used to fall back to) is what keeps "one city per day"
        // true — a locally invented city would disagree with the schedule, and the
        // day cache would then pin that disagreement for the rest of the day.
        //
        // The caller logs it: `scheduler::reconcile` at `error!` on each poll it
        // can't paint, Dev Mode's Advance Preview as an inline error. An offline
        // machine is the common cause and would have failed at the Overpass fetch
        // one step later anyway.
        Err(e) => Err(anyhow!("no manifest and no schedule state for {date}: {e}")),
    }
}

/// The city `date`'s wallpaper shows, for `Status`. Two sources, in order:
///
///  1. `AppState::resolved_city`, set by every Daily `resolve_and_record` — the
///     authoritative answer once the pipeline has run this session.
///  2. That day's cached OSM payload. `run_now_inner` short-circuits on an
///     existing PNG without resolving anything, so after a restart onto an
///     already-rendered day (1) is empty; the cached payload carries the `city`
///     envelope both published flows now stamp on, so it says exactly what was
///     rendered.
///
/// `None` when neither has an answer — the day hasn't been rendered yet (first
/// launch of a day, a render still in flight or one that couldn't reach the
/// schedule), or its cached payload predates the `city` envelope. There is
/// deliberately no third source: naming the day from a local formula is exactly
/// what the retired rotation did, and it would report a city the wallpaper doesn't
/// show. The City tab renders the gap as a placeholder.
///
/// The answer is memoized under (1) **whether or not there was one** — (2) is the
/// expensive source and its miss is the expensive miss: an envelope-less payload
/// is read and parsed in full, tens of MB, only to yield nothing. `Status` is
/// rebuilt on every settings change, so a miss that isn't remembered is re-paid on
/// each one, all day. That combination is reachable rather than theoretical: a day
/// already rendered by a build that predates the `city` envelope keeps its payload,
/// because `apply_target` short-circuits on the existing PNG and never reaches the
/// `resolve_daily` rung that would delete it.
///
/// A memoized `None` can't go stale. The only way this day acquires an answer later
/// is a render, `render_bytes_for` is the only writer of `<date>.osm.json`, and it
/// is reachable only through `render_and_cache` — which calls `resolve_and_record`
/// first, overwriting the memo with the city it resolved.
///
/// Describes the *Daily* flow only, which is what `Status::city` reports — a
/// Customized pin is shown by its own City-tab panel from `Status::custom`.
pub fn city_for_status(app: &AppHandle, date: NaiveDate) -> Option<city::City> {
    let state = app.state::<AppState>();
    if let Some((d, c)) = state.resolved_city.lock().unwrap().as_ref() {
        if *d == date {
            return c.clone();
        }
    }
    let city = cached_day_city(app, date);
    *state.resolved_city.lock().unwrap() = Some((date, city.clone()));
    city
}

/// The Daily flow's OSM cache filename for `date`. One definition so
/// `daily_target` and `cached_day_city` can't drift apart.
fn daily_osm_name(date: NaiveDate) -> String {
    format!("{}.osm.json", date)
}

/// The cached OSM payload at `path`, or `None` when there is none / it won't
/// parse. A corrupt one reads as absent on purpose: the caller then refetches and
/// overwrites it, rather than failing the render on a file we can't use.
fn cached_osm_at(path: &Path) -> Option<serde_json::Value> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

/// The `city` envelope both published flows stamp onto a payload, or `None` when
/// it predates the envelope (a live sidecar fetch) or is half-written.
fn city_envelope(v: &serde_json::Value) -> Option<city::City> {
    serde_json::from_value(v.get("city")?.clone()).ok()
}

/// The `city` envelope on `<date>.osm.json` in the *Daily* cache —
/// `city_for_status`'s source (2). Deserializes that one field and lets serde skip
/// the map data rather than build it into a `Value`: the memo runs this on its first
/// call of a day, which the scheduler's poll can make, and a tens-of-MB `Value` just
/// to read the envelope costs hundreds of MB of peak memory. (`resolve_daily` reads
/// the whole payload because it renders it.)
fn cached_day_city(app: &AppHandle, date: NaiveDate) -> Option<city::City> {
    #[derive(Deserialize)]
    struct Envelope {
        city: Option<city::City>,
    }
    let path = daily_dir(app).ok()?.join(daily_osm_name(date));
    serde_json::from_str::<Envelope>(&fs::read_to_string(path).ok()?).ok()?.city
}

/// Fetch the target's OSM data and render it via the hidden renderer window,
/// returning the raw PNG bytes. Writes the OSM cache but NOT the PNG — the caller
/// owns the PNG (so `render_preview` can render without persisting a wallpaper).
///
/// `target.signature` doubles as the job id: the renderer echoes it back and it's
/// matched against the pending job, so a stale result (e.g. a superseded custom pin)
/// is rejected.
async fn render_bytes_for(app: &AppHandle, target: &Target, resolved: Resolved) -> Result<Vec<u8>> {
    let renderer = ensure_renderer(app).await?;
    let ((w, h), screens) = screen_geometry(&renderer)?;
    let aspect = w as f64 / h as f64;
    // A 20km long side: the same `max_half_km` (packages/core/src/defaults.json) that
    // osm-cli precaches each day's square with, at aspect 1 — the superset every
    // screen-aspect rectangle here fits inside, so the CDN data always covers the
    // wallpaper (`pnpm bbox-test` checks the square contains them all).
    let Resolved { city, osm: preloaded, stamp } = resolved;
    let bbox = bbox_for_screen(city.lat, city.lon, defaults::get().max_half_km, aspect);

    // The back half of the acquisition ladder `resolve_daily` documents: its first
    // two rungs (cache, schedule manifest) arrive here already resolved as
    // `preloaded`, because they also decide *which city* this is. What's left is the
    // live sidecar — which honors the proxy, important for mainland-China users.
    //
    // The published square is a superset of `bbox`, so the renderer projects within
    // `bbox` and clips the rest; the sidecar fetches exactly `bbox` to save
    // bandwidth.
    let osm: serde_json::Value = match preloaded {
        // Fetched from the date-keyed schedule manifest (issue #1): authoritative
        // for the scheduled city, so cache + use it directly (overwriting any
        // stale day cache from a prior rotation pick).
        Some(DayOsm::Fetched(v)) => {
            write_osm(&target.osm_path, &v)?;
            v
        }
        // Already the contents of `target.osm_path` — writing it back would just burn
        // a multi-MB write.
        Some(DayOsm::Cached(v)) => v,
        // Nothing preloaded: a Customized pin (arbitrary coordinates, never
        // published), the reconstruction rung, or Dev Mode's bypass. Written back
        // afterwards, so a bypassed fetch overwrites the stale local data as
        // documented.
        None => {
            log::info!("[pipeline] fetching osm live from sidecar");
            let mut v = osm_sidecar::fetch(app, bbox).await?;
            if let Some(date) = stamp {
                stamp_manifest_envelope(&mut v, date, &city);
            }
            write_osm(&target.osm_path, &v)?;
            v
        }
    };

    let theme = effective_theme(app);
    let colors = colors_for(app, theme);
    let preset = *app.state::<AppState>().style.lock().unwrap();
    let show_water = app.state::<AppState>().show_water.load(Ordering::Acquire);
    let show_airports = app.state::<AppState>().show_airports.load(Ordering::Acquire);
    let railway_style = *app.state::<AppState>().railway_style.lock().unwrap();
    let show_aerialways = app.state::<AppState>().show_aerialways.load(Ordering::Acquire);
    let variant = *app.state::<AppState>().variant.lock().unwrap();
    let style = Style {
        background: colors.background,
        foreground: colors.foreground,
        preset,
        show_water,
        show_airports,
        railway_style,
        show_aerialways,
        variant,
        theme,
    };

    let (tx, rx) = oneshot::channel::<Vec<u8>>();
    {
        let state = app.state::<AppState>();
        let mut g = state.pending.lock().await;
        *g = Some(PendingJob { date: target.signature.clone(), tx });
    }

    let label = target.label.map(|corner| LabelPayload {
        corner,
        name: city.name.clone(),
        local_name: city.local_name.clone(),
        country: city.country.clone(),
        country_name: guess_store::country_name(&city.country).map(str::to_string),
        lat: city.lat,
        lon: city.lon,
        insets: label_insets(w as f64, h as f64, &screens),
    });

    let req = RenderRequest {
        date: target.signature.clone(),
        bbox,
        width: w,
        height: h,
        style,
        osm,
        label,
    };
    renderer.emit("render-request", &req)?;

    tokio::time::timeout(Duration::from_secs(120), rx)
        .await
        .map_err(|_| anyhow!("renderer timeout"))?
        .map_err(|_| anyhow!("renderer dropped"))
}

/// Splice the `{ date, city }` envelope a published manifest carries onto a payload
/// fetched live from the sidecar, so what lands in the day cache is shaped exactly
/// like `osm-v2/data/<date>.json` (`{ v, …osm, date, city }`) — that's what makes
/// the reconstruction rung indistinguishable from a manifest download, both for the
/// next cache read and for `city_for_status` after a restart. Existing keys are
/// left alone: a real manifest's own envelope is authoritative.
fn stamp_manifest_envelope(v: &mut serde_json::Value, date: NaiveDate, city: &city::City) {
    let Some(obj) = v.as_object_mut() else { return };
    obj.entry("date").or_insert_with(|| serde_json::Value::String(date.to_string()));
    if !obj.contains_key("city") {
        if let Ok(c) = serde_json::to_value(city) {
            obj.insert("city".into(), c);
        }
    }
}

/// Write a payload to its cache path, creating the directory (see the note above
/// the `*_dir` helpers — writers own creation).
fn write_osm(path: &Path, v: &serde_json::Value) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, v.to_string())?;
    Ok(())
}

/// Render an upcoming day without applying it as the wallpaper — Dev Mode's
/// "Advance Preview".
///
/// Deliberately just the ordinary Daily path with a date handed to it: same
/// `resolve_daily` ladder (so it shows the scheduled city, and honours the bypass
/// switch), same `wallpaper/daily/` cache for both the payload and the PNG. The PNG
/// lands at that day's `<date>.png`, but nothing reuses it: when the day arrives the
/// pipeline renders it afresh like any other (`apply_target`), so a preview drawn
/// before a style change can't stand in for the real wallpaper.
///
/// The only thing it doesn't do is apply the wallpaper or touch `last_applied`.
/// Shares `state.running` with the real pipeline — both drive the same single
/// renderer window/channel, so only one may be in flight at a time — which callers
/// see as the same "busy" state as a normal regen.
///
/// Returns the city drawn, the PNG bytes (for the inline preview) and the cached
/// PNG's path — that path is what Dev Mode opens full-size, so no copy of the
/// image is exported anywhere (see `commands::open_preview_image`).
pub async fn render_preview(
    app: &AppHandle,
    date: NaiveDate,
) -> Result<(city::City, Vec<u8>, PathBuf)> {
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
            let out = render_and_cache(app, &target).await;
            if let Ok(dir) = daily_dir(app) {
                let _ = cleanup_daily(&dir, city::today());
            }
            out.map(|(city, bytes)| (city, bytes, target.png_path))
        }
        Err(e) => Err(e),
    };
    // A run requested while the preview held `running` was queued for it (see
    // `run_now`); hand it on now that the renderer is free.
    let state = app.state::<AppState>();
    let queued = {
        let mut g = state.running.lock().await;
        *g = false;
        state.rerun.lock().unwrap().take()
    };
    FrontendEvent::PipelineEnd.emit(app);
    state.mark_status_dirty();
    if let Some(kind) = queued {
        spawn_run(app.clone(), kind);
    }
    r
}

/// The hidden renderer window, built on demand if `setup` hasn't already made it.
///
/// Both paths wait for readiness, and that's the point: the window *existing* says
/// nothing about the webview inside it having subscribed yet. `render-request` is a
/// fire-and-forget `emit`, so a render that gets here first has its request dropped
/// on the floor and then burns the full 120s result timeout ("renderer timeout").
/// Since `lib.rs`'s setup pre-builds the window, the found path is the one that
/// actually runs in production — it used to be the one that skipped the wait.
async fn ensure_renderer(app: &AppHandle) -> Result<WebviewWindow> {
    let w = match app.get_webview_window("renderer") {
        Some(w) => w,
        None => WebviewWindowBuilder::new(app, "renderer", WebviewUrl::App("render.html".into()))
            .visible(false)
            .skip_taskbar(true)
            .title("InkCity Renderer")
            .build()?,
    };
    wait_renderer_ready(app).await?;
    Ok(w)
}

/// Wait until the renderer webview has announced itself (`commands::renderer_ready`).
///
/// Joins the waiter list *before* the final flag check. `renderer_ready` signals with
/// `notify_waiters()`, which wakes only already-registered waiters and — unlike
/// `notify_one` — stores no permit, so a check-then-subscribe order would drop a
/// signal landing in between and then stall for the whole timeout. Cheap to get wrong
/// unnoticed while this was only reachable on the cold-start path.
async fn wait_renderer_ready(app: &AppHandle) -> Result<()> {
    let state = app.state::<AppState>();
    let notify = state.renderer_notify.clone();
    let notified = notify.notified();
    tokio::pin!(notified);
    // A `Notified` only registers when first polled; `enable` does that up front
    // without waiting on it.
    let _ = notified.as_mut().enable();
    if state.renderer_ready.load(Ordering::Acquire) {
        return Ok(());
    }
    tokio::time::timeout(Duration::from_secs(20), notified)
        .await
        .map_err(|_| anyhow!("renderer never became ready"))?;
    Ok(())
}

/// The pixel size the wallpaper has to be drawn at.
///
/// Three rungs, because "the primary monitor" is not a concept every display
/// server has. Wayland has no primary at all: tao maps `primary_monitor()`
/// straight onto `gdk_display_get_primary_monitor()`, whose Wayland backend
/// answers NULL — so on a Wayland session (the default on current GNOME and
/// Plasma) the first rung is unconditionally `None`, and taking that for "no
/// monitor" would fail every single render.
///
/// `current_monitor` is second rather than first so a multi-monitor X11 desktop
/// keeps sizing to the monitor the user calls primary, not to wherever the
/// hidden renderer window happens to have been placed. It can itself come back
/// `None` here — GTK has no monitor for a window it hasn't realized, and the
/// renderer window is deliberately never shown — hence the third rung, which
/// goes through `gdk_display_get_n_monitors` and so answers on Wayland too.
///
/// Also returns every display the image will be shown on, for `label_insets` — the
/// one PNG is applied to all of them. When the list can't be had, the sizing monitor
/// stands in for it.
fn screen_geometry(win: &WebviewWindow) -> Result<((u32, u32), Vec<Screen>)> {
    let m = match win.primary_monitor()? {
        Some(m) => m,
        None => win
            .current_monitor()?
            .or_else(|| win.available_monitors().ok()?.into_iter().next())
            .ok_or_else(|| anyhow!("no monitor"))?,
    };
    let s = m.size();
    let mut screens: Vec<Screen> =
        win.available_monitors().unwrap_or_default().iter().map(screen_of).collect();
    if screens.is_empty() {
        screens.push(screen_of(&m));
    }
    Ok(((s.width, s.height), screens))
}

/// One screen, as `label_insets` sees it: its physical size, and how much of each
/// edge the system keeps for itself — the strip outside its `work_area`, i.e. the
/// menu bar and a visible Dock on macOS (`NSScreen.visibleFrame`), the taskbar on
/// Windows, panels on X11. Wayland reports the whole screen as the work area, so
/// there it's all zeros and only the renderer's base margin keeps the caption clear.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Screen {
    w: f64,
    h: f64,
    reserved: Insets,
}

fn screen_of(m: &tauri::Monitor) -> Screen {
    let (pos, size, wa) = (m.position(), m.size(), m.work_area());
    let (mx, my, mw, mh) = (pos.x as f64, pos.y as f64, size.width as f64, size.height as f64);
    let (wx, wy) = (wa.position.x as f64, wa.position.y as f64);
    let (ww, wh) = (wa.size.width as f64, wa.size.height as f64);
    Screen {
        w: mw,
        h: mh,
        reserved: Insets {
            top: (wy - my).max(0.0),
            right: ((mx + mw) - (wx + ww)).max(0.0),
            bottom: ((my + mh) - (wy + wh)).max(0.0),
            left: (wx - mx).max(0.0),
        },
    }
}

/// How far the caption must stay from each edge of a `w`×`h` wallpaper so that it
/// shows whole on every display.
///
/// Every platform applies the one PNG cover-fit (scaled to fill, centred, overflow
/// cropped — see `wallpaper_set`), so a display whose aspect differs from the image's
/// loses a band off two opposite edges, and its reserved strips cover a bit more.
/// Both are converted to image pixels, and the worst display wins per edge — a 16:10
/// laptop driving a 21:9 monitor crops a sixth off the top and bottom of the image,
/// which a corner caption must survive. Each edge is capped at a quarter of the image
/// so a degenerate geometry can't push the caption off the canvas. Deliberately not
/// part of the render's signature: moving the Dock shouldn't re-render the day.
fn label_insets(w: f64, h: f64, screens: &[Screen]) -> Insets {
    let mut out = Insets::default();
    for d in screens.iter().filter(|d| d.w > 0.0 && d.h > 0.0) {
        // Screen pixels per image pixel under cover-fit.
        let s = (d.w / w).max(d.h / h);
        let crop_x = (w - d.w / s) / 2.0;
        let crop_y = (h - d.h / s) / 2.0;
        out.top = out.top.max(crop_y + d.reserved.top / s);
        out.bottom = out.bottom.max(crop_y + d.reserved.bottom / s);
        out.left = out.left.max(crop_x + d.reserved.left / s);
        out.right = out.right.max(crop_x + d.reserved.right / s);
    }
    Insets {
        top: out.top.min(h / 4.0),
        right: out.right.min(w / 4.0),
        bottom: out.bottom.min(h / 4.0),
        left: out.left.min(w / 4.0),
    }
}

/// Visit every date-keyed artifact in `dir` — the downloaded OSM data
/// (`YYYY-MM-DD.osm.json`) and rendered wallpapers (`YYYY-MM-DD.png`, or the
/// `YYYY-MM-DD-<theme>….png` names older versions wrote). Matches on the leading
/// 10-char ISO date prefix (slicing, not splitting on '.'), so it never touches
/// anything that isn't ours. Used by `cleanup_daily` and `wipe_cache`.
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

/// Sweep the Daily cache, applying `KEEP_DAYS` to rendered PNGs and the much
/// tighter `KEEP_OSM_DAYS` to the `.osm.json` payloads.
///
/// The asymmetry at the *future* end is deliberate too. Dev Mode's advance
/// preview renders up to five days out; its PNG is kept, since that's the file
/// Dev Mode opens full-size (it ages out normally once its day passes, and is
/// rewritten when the day itself renders). Its payload isn't: re-previewing the
/// same day re-resolves through the CDN anyway. So a future date fails the
/// `0..=KEEP_OSM_DAYS` window and its payload goes.
///
/// `today` is a parameter rather than a `city::today()` call so the windows are
/// testable without moving the clock.
fn cleanup_daily(dir: &Path, today: NaiveDate) -> Result<()> {
    for_each_daily_artifact(dir, |entry, d| {
        let age = (today - d).num_days();
        let keep = if entry.file_name().to_string_lossy().ends_with(".osm.json") {
            (0..=KEEP_OSM_DAYS).contains(&age)
        } else {
            age <= KEEP_DAYS
        };
        if !keep {
            let _ = fs::remove_file(entry.path());
        }
    })
}

/// Drop every file in the customized cache that doesn't belong to `key` (the
/// active pin), so applying a new coordinate leaves only that coordinate's
/// files. A pin's files are `<key>.osm.json` and `<key>.png`; the
/// `<key>-<theme>.png` names older versions wrote go too, since nothing reads them.
fn prune_other_custom(dir: &Path, key: &str) -> Result<()> {
    let osm = format!("{key}.osm.json");
    let png = format!("{key}.png");
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let belongs = name == osm || name == png;
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

fn spawn_run(app: AppHandle, kind: RunKind) {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = run_now(app, kind).await {
            log::error!("[pipeline] {kind:?} run failed: {e}");
        }
    });
}

/// Render + apply the current mode's wallpaper (OSM data is reused if cached).
/// Fire-and-forget; errors are logged. Used on mode switches / applying a pin /
/// revealing today's city or moving its caption — changes that move the target, so
/// the signature alone tells the poll whether they landed. A no-op when disabled /
/// no pin.
pub fn spawn_apply(app: AppHandle) {
    spawn_run(app, RunKind::Apply);
}

/// Render + apply today's wallpaper when what changed is its look, which the
/// signature doesn't encode — see `forget_applied`. Used for theme switches,
/// style/color/layer edits, and "regenerate now".
/// Fire-and-forget: errors are logged. A no-op when updates are disabled / no pin.
pub fn spawn_force_regen(app: AppHandle) {
    spawn_run(app, RunKind::Force);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The renderer's `Style` payload is the one place with hand-written
    /// `#[serde(rename)]`s, and nothing type-checks it across the IPC boundary: a
    /// forgotten rename would arrive at `drawScene` as snake_case, read as
    /// `undefined`, and silently render as if the layer were off. So pin the
    /// camelCase key names and the railway mode's wire values, which must match
    /// `Style` / `RailwayStyle` in packages/core/src/types.ts.
    #[test]
    fn style_payload_uses_the_keys_the_renderer_reads() {
        let style = Style {
            background: "#eee8d6".into(),
            foreground: "#2d2d2d".into(),
            preset: StylePreset::Standard,
            show_water: true,
            show_airports: false,
            railway_style: RailwayStyle::Ties,
            show_aerialways: true,
            variant: StyleVariant::Mondrian,
            theme: EffectiveTheme::Dark,
        };
        let v = serde_json::to_value(&style).unwrap();
        let obj = v.as_object().unwrap();
        assert_eq!(obj["showWater"], serde_json::json!(true));
        assert_eq!(obj["showAirports"], serde_json::json!(false));
        assert_eq!(obj["showAerialways"], serde_json::json!(true));
        assert_eq!(obj["railwayStyle"], serde_json::json!("ties"));
        assert_eq!(obj["variant"], serde_json::json!("mondrian"));
        // Absent, the renderer would draw Mondrian's light palette at night.
        assert_eq!(obj["theme"], serde_json::json!("dark"));
        assert_eq!(serde_json::to_value(EffectiveTheme::Light).unwrap(), "light");
        // No stale boolean left behind for the renderer to prefer.
        assert!(!obj.contains_key("showRailways"), "showRailways must be gone");
    }

    #[test]
    fn every_railway_mode_serializes_to_its_wire_value() {
        for (mode, wire) in [
            (RailwayStyle::Off, "off"),
            (RailwayStyle::Plain, "plain"),
            (RailwayStyle::Banded, "banded"),
            (RailwayStyle::Ties, "ties"),
        ] {
            assert_eq!(serde_json::to_value(mode).unwrap(), serde_json::json!(wire));
        }
    }

    // `city_envelope` decides whether a cached day keeps the city it was rendered
    // from or has to be re-resolved from the network, so all three shapes a day
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

    // Anything cached before the envelope existed: unnameable, so `resolve_daily`
    // treats it as a cache miss and `city_for_status` reports `None`.
    #[test]
    fn city_envelope_absent_on_an_unstamped_payload() {
        let v: serde_json::Value =
            serde_json::from_str(r#"{"v":4,"elements":[{"type":"way"}]}"#).unwrap();
        assert!(city_envelope(&v).is_none());
    }

    // Half-written: treated as absent rather than deserialized into a partial city.
    #[test]
    fn city_envelope_absent_on_a_partial_city() {
        let v: serde_json::Value =
            serde_json::from_str(r#"{"city":{"lat":22.5,"lon":114.0}}"#).unwrap();
        assert!(city_envelope(&v).is_none());
    }

    // A live sidecar fetch has no `city` of its own, so the stamp is what lets a
    // bypassed render still name its city after a restart (`city_for_status`).
    #[test]
    fn stamp_manifest_envelope_reproduces_a_manifest() {
        let mut v: serde_json::Value = serde_json::from_str(r#"{"v":5,"elements":[]}"#).unwrap();
        let city = city::City {
            id: 702550,
            name: "Lviv".into(),
            local_name: "Львів".into(),
            country: "UA".into(),
            lat: 49.84,
            lon: 24.03,
            population: 717803,
        };
        stamp_manifest_envelope(&mut v, NaiveDate::from_ymd_opt(2026, 7, 28).unwrap(), &city);
        let read = city_envelope(&v).expect("stamped");
        assert_eq!(read.id, 702550);
        assert_eq!(read.local_name, "Львів");
        // Both envelope keys a published manifest carries, so the reconstruction is
        // indistinguishable from a download.
        assert_eq!(v["date"], "2026-07-28");
        // The rest of the payload is untouched.
        assert_eq!(v["v"], 5);
    }

    // The CDN's own envelope is authoritative — never overwrite it.
    #[test]
    fn stamp_manifest_envelope_leaves_an_existing_one_alone() {
        let mut v: serde_json::Value = serde_json::from_str(
            r#"{"elements":[],"date":"2026-01-01","city":{"id":1,"name":"Kept",
                "localName":"Kept","country":"XX","lat":0.0,"lon":0.0,"population":1}}"#,
        )
        .unwrap();
        let other = city::City {
            id: 2,
            name: "Other".into(),
            local_name: "Other".into(),
            country: "YY".into(),
            lat: 1.0,
            lon: 1.0,
            population: 2,
        };
        stamp_manifest_envelope(&mut v, NaiveDate::from_ymd_opt(2026, 7, 28).unwrap(), &other);
        assert_eq!(city_envelope(&v).unwrap().id, 1);
        assert_eq!(v["date"], "2026-01-01");
    }

    // A payload that isn't a JSON object can't carry an envelope; must not panic.
    #[test]
    fn stamp_manifest_envelope_ignores_a_non_object_payload() {
        let mut v: serde_json::Value = serde_json::from_str("[1,2,3]").unwrap();
        let date = NaiveDate::from_ymd_opt(2026, 7, 28).unwrap();
        stamp_manifest_envelope(&mut v, date, &pin_city(0.0, 0.0));
        assert!(v.is_array());
    }

    // The whole claim of resolution rung 3 is that a sidecar payload + the envelope
    // is indistinguishable from a downloaded manifest. Pinned against the real key
    // set of a published `osm-v2/data/<date>.json` (checked against the live CDN on
    // 2026-07-28), so a change to either side has to come here and say so.
    #[test]
    fn a_stamped_sidecar_payload_has_a_manifests_exact_shape() {
        let mut v: serde_json::Value = serde_json::from_str(
            r#"{"v":5,"elements":[{"type":"way"}],"water":[],"airports":[],
                "railways":[],"aerialways":[]}"#,
        )
        .unwrap();
        stamp_manifest_envelope(
            &mut v,
            NaiveDate::from_ymd_opt(2026, 7, 30).unwrap(),
            &city::City {
                id: 1172451,
                name: "Lahore".into(),
                local_name: "لاہور".into(),
                country: "PK".into(),
                lat: 31.549722222,
                lon: 74.343611111,
                population: 11126285,
            },
        );
        let mut keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            ["aerialways", "airports", "city", "date", "elements", "railways", "v", "water"]
        );
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
        let keep = ["51.5_-0.12.osm.json", "51.5_-0.12.png"];
        let drop = [
            "48.85_2.35.osm.json",
            "48.85_2.35.png",
            // The active pin's names from older versions: never read, so swept.
            "51.5_-0.12-light.png",
            "51.5_-0.12-dark.png",
        ];
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

    /// The whole point of splitting the retention: a week of `.osm.json` was
    /// tens of MB of payload nothing re-reads, while the PNGs it shared a window
    /// with are cheap — including the future-dated ones Dev Mode's advance preview
    /// writes and opens full-size.
    #[test]
    fn cleanup_daily_keeps_pngs_a_week_but_payloads_a_day() {
        let dir = std::env::temp_dir().join(format!("inkcity-daily-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let today = NaiveDate::from_ymd_opt(2026, 8, 31).unwrap();
        let day = |n: i64| (today + chrono::Duration::days(n)).to_string();

        let keep = [
            // Today and yesterday: both halves live.
            format!("{}.osm.json", day(0)),
            format!("{}.png", day(0)),
            format!("{}.osm.json", day(-1)),
            format!("{}.png", day(-1)),
            // Still inside the PNG window.
            format!("{}.png", day(-7)),
            // An older version's name ages exactly like the current one: the date
            // prefix is all the sweep reads.
            format!("{}-dark-label-bottom-right.png", day(-7)),
            // An advance preview five days out.
            format!("{}.png", day(5)),
            // Not ours: no leading ISO date, so nothing should touch it.
            "notes.txt".to_string(),
        ];
        let drop = [
            // Two days back: the payload is dead weight, its PNG is not.
            format!("{}.osm.json", day(-2)),
            format!("{}.osm.json", day(-7)),
            format!("{}.png", day(-8)),
            format!("{}-light-label-top-left.png", day(-8)),
            // A future preview's payload: re-previewing re-resolves anyway.
            format!("{}.osm.json", day(5)),
        ];
        for f in keep.iter().chain(drop.iter()) {
            fs::write(dir.join(f), b"x").unwrap();
        }

        cleanup_daily(&dir, today).unwrap();

        for f in &keep {
            assert!(dir.join(f).exists(), "{f} should have been kept");
        }
        for f in &drop {
            assert!(!dir.join(f).exists(), "{f} should have been swept");
        }
        let _ = fs::remove_dir_all(&dir);
    }

    /// A caption (and each corner) must move the signature, so the scheduler repaints
    /// once the day is revealed; the PNG stays the bare date whatever it shows.
    #[test]
    fn a_caption_moves_the_signature_but_not_the_png() {
        let date = NaiveDate::from_ymd_opt(2026, 10, 16).unwrap();
        assert_eq!(daily_signature(date, "light", None), "daily:2026-10-16:light");
        assert_eq!(
            daily_signature(date, "dark", Some("bottom-right")),
            "daily:2026-10-16:dark:label-bottom-right"
        );
        assert_ne!(
            daily_signature(date, "dark", Some("top-left")),
            daily_signature(date, "dark", Some("bottom-right"))
        );
        assert_eq!(daily_png_name(date), "2026-10-16.png");
    }

    /// Queued requests merge with `max`, so the declaration order is the merge order: a
    /// queued Force must outrank a queued Apply, and either must outrank nothing queued.
    #[test]
    fn queued_run_kinds_merge_to_the_stronger_one() {
        assert_eq!(Some(RunKind::Apply).max(Some(RunKind::Force)), Some(RunKind::Force));
        assert_eq!(None.max(Some(RunKind::Apply)), Some(RunKind::Apply));
    }

    /// Same reasoning as the `Style` payload test: nothing type-checks the IPC
    /// boundary, so pin the camelCase keys `MapLabel` (packages/core/src/types.ts) reads, and
    /// that an unlabeled request carries no `label` key at all.
    #[test]
    fn label_payload_uses_the_keys_the_renderer_reads() {
        let label = LabelPayload {
            corner: "bottom-right",
            name: "Moscow".into(),
            local_name: "Москва".into(),
            country: "RU".into(),
            country_name: Some("Russia".into()),
            lat: 55.7558,
            lon: 37.6173,
            insets: Insets { top: 1.0, right: 2.0, bottom: 3.0, left: 4.0 },
        };
        let v = serde_json::to_value(&label).unwrap();
        assert_eq!(v["corner"], "bottom-right");
        assert_eq!(v["localName"], "Москва");
        assert_eq!(v["countryName"], "Russia");
        assert_eq!(v["insets"]["bottom"], 3.0);
        let req = |label| RenderRequest {
            date: "daily:2026-10-16:light".into(),
            bbox: Bbox { south: 0.0, west: 0.0, north: 1.0, east: 1.0 },
            width: 10,
            height: 10,
            style: Style {
                background: "#000000".into(),
                foreground: "#ffffff".into(),
                preset: StylePreset::Standard,
                show_water: false,
                show_airports: false,
                railway_style: RailwayStyle::Off,
                show_aerialways: false,
                variant: StyleVariant::Ink,
                theme: EffectiveTheme::Light,
            },
            osm: serde_json::json!({}),
            label,
        };
        assert!(serde_json::to_value(req(None)).unwrap().get("label").is_none());
        assert_eq!(serde_json::to_value(req(Some(label))).unwrap()["label"]["name"], "Moscow");
    }

    fn screen(w: f64, h: f64, top: f64, right: f64, bottom: f64, left: f64) -> Screen {
        Screen { w, h, reserved: Insets { top, right, bottom, left } }
    }

    #[test]
    fn label_insets_cover_the_menu_bar_and_dock_of_a_matching_display() {
        // A 2880×1800 MacBook screen: 74 px menu bar, 140 px Dock at the bottom.
        let i = label_insets(2880.0, 1800.0, &[screen(2880.0, 1800.0, 74.0, 0.0, 140.0, 0.0)]);
        assert_eq!(i, Insets { top: 74.0, right: 0.0, bottom: 140.0, left: 0.0 });
    }

    #[test]
    fn label_insets_add_the_crop_of_a_display_with_another_aspect() {
        // A 16:10 wallpaper on a 21:9 (3440×1440) monitor: cover-fit scales the width
        // to fit and crops the overflow off the top and bottom equally.
        let (w, h) = (2880.0, 1800.0);
        let i = label_insets(
            w,
            h,
            &[
                screen(2880.0, 1800.0, 0.0, 0.0, 0.0, 0.0),
                screen(3440.0, 1440.0, 0.0, 0.0, 96.0, 0.0),
            ],
        );
        let s = 3440.0 / w;
        let crop_y = (h - 1440.0 / s) / 2.0;
        assert!((i.top - crop_y).abs() < 1e-9, "{i:?}");
        assert!((i.bottom - (crop_y + 96.0 / s)).abs() < 1e-9, "{i:?}");
        assert_eq!(i.left, 0.0);
        assert_eq!(i.right, 0.0);
    }

    /// Wayland reports the whole screen as its work area: no insets at all, the
    /// renderer's own margin is all that's left.
    #[test]
    fn label_insets_are_zero_when_nothing_is_reserved() {
        let i = label_insets(1920.0, 1080.0, &[screen(1920.0, 1080.0, 0.0, 0.0, 0.0, 0.0)]);
        assert_eq!(i, Insets::default());
        assert_eq!(label_insets(1920.0, 1080.0, &[]), Insets::default());
    }

    #[test]
    fn label_insets_are_capped_at_a_quarter_of_the_image() {
        let i = label_insets(1000.0, 1000.0, &[screen(1000.0, 1000.0, 900.0, 0.0, 0.0, 600.0)]);
        assert_eq!(i.top, 250.0);
        assert_eq!(i.left, 250.0);
    }
}
