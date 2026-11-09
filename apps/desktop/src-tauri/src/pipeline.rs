use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::{Duration, SystemTime};

use anyhow::{anyhow, Result};
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Theme, WebviewWindow};
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
/// Everything older is swept by `cleanup_daily` after each Daily run that gets its
/// map — rendered, or with syncing off only fetched (`run_now_inner`).
const KEEP_DAYS: i64 = 7;

/// How many days *back* a day's downloaded OSM payload (`<date>.square.osm.json`) is
/// kept. Retention is split from `KEEP_DAYS` because the two artifacts have
/// wildly different costs: a rendered PNG is a few MB, while an `.osm.json` runs
/// to tens of MB — big city days hit 20 MB — and is only ever re-read to render
/// *the day it belongs to*, which every apply does afresh (`apply_target`). Past
/// days are never rendered again, so keeping a week of them was ~85 MB of pure
/// dead weight. One day back covers the timezone/midnight edge where "today" has
/// just rolled over but the wallpaper hasn't caught up.
const KEEP_OSM_DAYS: i64 = 1;

/// The theme a render is drawn for: `ThemeMode` with `System` resolved. Serialized
/// as the renderer's `Style.theme` (`Theme` in packages/core/src/types.ts).
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
//                                 desktop image by URL). The ones it replaced
//                                 stay a few minutes, in case the OS is still
//                                 reading them. See wallpaper_set::set.
//     daily/                    ← the Daily rotation cache, swept by cleanup_daily.
//       <date>.png                ← that day's latest render, whatever its theme,
//                                   palette or caption: rewritten by every apply,
//                                   never read back as a cache hit (`apply_target`).
//                                   Kept KEEP_DAYS back (and any future preview).
//       <date>.square.osm.json    ← kept only KEEP_OSM_DAYS back; it's the heavy half.
//     customized/               ← the Customized-pin cache. Writing a new
//                                 coordinate wipes every other coordinate's
//                                 files, so only the active pin is kept.
//       <lat>_<lon>.png           ← the pin's latest render, like <date>.png.
//       <lat>_<lon>.square.osm.json ← the square every screen's crop lies in, as a
//                                   day's is (`pin_osm_name`).
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
    // As finely as the pin line rounds it (packages/core/src/defaults.json).
    let s = format!("{:.*}", defaults::get().pin_decimals, v);
    let t = s.trim_end_matches('0').trim_end_matches('.');
    t.to_string()
}

fn coord_key(lat: f64, lon: f64) -> String {
    format!("{}_{}", fmt_coord(lat), fmt_coord(lon))
}

// ─────────────────────────────────────────────────────────────────────────────
// Render target resolution — turns the current UpdateMode into the concrete
// cache paths + signature to render, or `None` when there's nothing to do
// (Customized with no pin applied yet).
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
    /// `AppState::last_applied`. A run that only fetches the map (syncing off)
    /// is `data:<key>`: what's wanted then is the data, whatever it'd be drawn in.
    signature: String,
    /// Which map this is, whatever it's drawn in: `daily:<date>` or
    /// `custom:<coords>`. What the window asks for (`commands::get_map_data`), and
    /// what the errors are kept against (`AppState::map_error`).
    key: String,
    /// Whether this run puts the map on the desktop (`Config::sync_wallpaper`), or
    /// only makes sure its data is to hand for the window.
    paint: bool,
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
    let key = format!("daily:{date}");
    Ok(Target {
        signature: render_signature(&key, theme, label),
        key,
        paint: true,
        png_path: dir.join(daily_png_name(date)),
        osm_path: dir.join(daily_osm_name(date)),
        kind: TargetKind::Daily(date),
        label,
    })
}

/// A render's `last_applied` signature: its map's key and theme —
/// `daily:<date>:<theme>`, `custom:<coords>:<theme>` — plus `:label-<corner>` while
/// it carries the caption. Only the signature tells a Daily render's two looks
/// apart — the PNG is `<date>.png` either way — and that's where it matters:
/// revealing the day moves the *desired signature*, so the scheduler's poll keeps
/// repainting until the captioned image is actually up, even if the render the
/// reveal kicked off fails.
fn render_signature(key: &str, theme: EffectiveTheme, label: Option<&str>) -> String {
    let theme = theme_suffix(theme);
    match label {
        Some(tag) => format!("{key}:{theme}:label-{tag}"),
        None => format!("{key}:{theme}"),
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
    // A pin isn't a city and has no game to reveal it: its caption — its
    // coordinates — is there whenever the setting is on. Part of the signature, so
    // moving the corner renders the pin again.
    let label = app.state::<AppState>().city_label.lock().unwrap().tag();
    let map = format!("custom:{key}");
    Ok(Target {
        signature: render_signature(&map, theme, label),
        key: map,
        paint: true,
        png_path: dir.join(format!("{key}.png")),
        osm_path: dir.join(pin_osm_name(&key)),
        kind: TargetKind::Custom { key, lat, lon },
        label,
    })
}

/// Resolve what to show right now, or `None` when Customized has no pin yet. A
/// Customized pin takes precedence over the daily schedule by construction: the
/// mode selects exactly one of them, so the two never race.
///
/// With syncing off the target is still resolved — the window draws its map, and
/// the day's game is played on it — but only its data is wanted: the run fetches
/// and caches it and leaves the desktop alone (`fetch_target`).
fn resolve_target(
    app: &AppHandle,
    date: NaiveDate,
    theme: EffectiveTheme,
) -> Result<Option<Target>> {
    let state = app.state::<AppState>();
    let mode = *state.update_mode.lock().unwrap();
    let mut target = match mode {
        UpdateMode::Daily => daily_target(app, date, theme)?,
        UpdateMode::Customized => {
            let custom = *state.custom.lock().unwrap();
            match custom {
                Some(c) => custom_target(app, c.lat, c.lon, theme)?,
                None => return Ok(None),
            }
        }
    };
    if !state.sync_wallpaper.load(Ordering::Acquire) {
        target.signature = format!("data:{}", target.key);
        target.paint = false;
        target.label = None;
    }
    Ok(Some(target))
}

/// The map the window should show: its key, and where its data is cached — whether
/// or not it's there yet. `None` when Customized has no pin.
pub fn current_map(app: &AppHandle) -> Option<(String, PathBuf)> {
    let target = resolve_target(app, city::today(), effective_theme(app)).ok().flatten()?;
    Some((target.key, target.osm_path))
}

fn mark_applied(app: &AppHandle, signature: &str) {
    *app.state::<AppState>().last_applied.lock().unwrap() = Some(signature.to_string());
}

/// The signature the current target *should* match, or `None` when there's
/// nothing to show (Customized with no pin). Cheap — the scheduler compares it to
/// `last_applied` to decide whether a repaint is even needed.
pub fn desired_signature(app: &AppHandle) -> Option<String> {
    let date = city::today();
    let theme = effective_theme(app);
    resolve_target(app, date, theme).ok().flatten().map(|t| t.signature)
}

/// Whether there's nothing to do: the current settings' map is in hand (and on the
/// desktop, when syncing), or they ask for nothing (Customized with no pin). The scheduler's poll runs on it (`scheduler::reconcile`), and so does a
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
/// `Requests`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum RunKind {
    Apply,
    Force,
}

/// The run requests not yet taken up, and how many have been numbered
/// (`AppState::requests`). One lock for both, so a request is numbered and queued in
/// a single step (`ask`), and a pass takes the work and reads the last number in a
/// single step (`take`): every ticket a pass says it served is one whose work it
/// took. Numbered in one step and queued in another, a request could be counted by
/// a pass that never saw its work — a Force's `forget_applied` among it — and its
/// asker settled from that pass's outcome while its own run was still to come.
#[derive(Debug, Default)]
pub struct Requests {
    /// The work asked for and not yet taken by a pass, merged to the stronger kind:
    /// a queued `Force` absorbs a queued `Apply`.
    pending: Option<RunKind>,
    /// The last ticket handed out. Starts at 0, which no request gets.
    issued: u64,
}

impl Requests {
    /// Number a request for `kind` and queue its work: its ticket.
    fn ask(&mut self, kind: RunKind) -> u64 {
        self.issued += 1;
        self.pending = self.pending.max(Some(kind));
        self.issued
    }

    /// The queued work for a pass, and the last ticket that pass serves — or `None`
    /// when nothing's queued.
    fn take(&mut self) -> Option<(RunKind, u64)> {
        self.pending.take().map(|kind| (kind, self.issued))
    }
}

/// Number a request for `kind` and queue its work (`Requests::ask`), after whatever
/// the caller changed: the pass that takes the work then sees the change too.
fn ask(app: &AppHandle, kind: RunKind) -> u64 {
    app.state::<AppState>().requests.lock().unwrap().ask(kind)
}

/// Render today's target (per the current UpdateMode) and apply it as the
/// wallpaper — or, with syncing off, only fetch its map (`fetch_target`). A no-op
/// when a Customized pin isn't set. The scheduler's poll waits on it; everything
/// else asks without waiting (`spawn_run`).
pub async fn run_now(app: AppHandle, kind: RunKind) -> Result<()> {
    ask(&app, kind);
    drive(app).await
}

/// Do the queued work (`Requests`), unless a loop is doing it already.
///
/// Only one run is ever in flight (`state.running` — there's one renderer window).
/// A request that arrives during a run used to be dropped, which lost real work: the
/// run in flight had already read its inputs, so a style edit or a caption change
/// made meanwhile only reached the wallpaper at some later regen. Now it's queued
/// instead, and the loop that holds `running` goes round again before letting go —
/// the queue checked under the same lock that releases `running`, so a request can't
/// slip in between the last check and the release. `PipelineStart`/`End` bracket the
/// whole loop, so the UI sees one busy stretch; the `End` says which requests each
/// pass served and how it went (`RunEnd`).
async fn drive(app: AppHandle) -> Result<()> {
    let state = app.state::<AppState>();
    // The work is taken, and the last ticket it covers read, before the pass reads
    // anything else: a request changes what it changes before it's queued (`ask`),
    // so a pass that has taken its work also sees the change.
    let (mut kind, mut served) = {
        let mut g = state.running.lock().await;
        if *g {
            // The loop in flight takes the work before it lets go.
            return Ok(());
        }
        let Some(work) = state.requests.lock().unwrap().take() else {
            // A loop that has ended since this was queued took the work.
            return Ok(());
        };
        *g = true;
        work
    };
    FrontendEvent::PipelineStart.emit(&app);
    let mut queued = false;
    let mut passes: Vec<PassEnd> = Vec::new();
    let r = loop {
        // What this pass is after, to tell a queued request for the same thing from
        // one for something new, should the pass fail.
        let attempted = desired_signature(&app);
        // A queued Apply is usually the scheduler's poll landing mid-render, which the
        // render it waited for has already satisfied — rerunning it would just set the
        // same wallpaper again. A queued Force always runs: something changed.
        let r = if queued && kind == RunKind::Apply && up_to_date(&app) {
            Ok(false)
        } else {
            if kind == RunKind::Force {
                forget_applied(&app);
            }
            run_now_inner(&app).await
        };
        queued = true;
        passes.push(PassEnd { served, failure: r.as_ref().err().map(|e| e.to_string()), painted: matches!(r, Ok(true)) });
        let mut g = state.running.lock().await;
        let same_target_failed = r.is_err() && desired_signature(&app) == attempted;
        let next = state.requests.lock().unwrap().take();
        match next {
            None => {
                *g = false;
                break r;
            }
            // An Apply queued behind a *failed* run isn't looped into while it would
            // only try the same target again: attempts that fail slowly (CDN/Overpass
            // timeouts, the renderer's 120s) outlast the scheduler's 60s poll, which
            // would queue another each time, so the loop would retry back to back and
            // never release `running` — the UI stuck busy, `PipelineEnd` and the
            // status push carrying the error never sent. When the same target is
            // tried again is the poll's to decide (`poll_may_run`). One for a target
            // that has moved since — a new pin, the mode switched, the day revealed —
            // is new work someone asked for, and runs; so does a queued Force.
            Some((RunKind::Apply, last)) if same_target_failed => {
                // What it asked for just failed: that failure is its answer, so this
                // pass covers it too, and nothing waits on it for ever.
                if let Some(pass) = passes.last_mut() {
                    pass.served = last;
                }
                *g = false;
                break r;
            }
            Some(work) => {
                if let Err(e) = &r {
                    log::error!("[pipeline] run failed, running the queued one next: {e}");
                }
                (kind, served) = work;
            }
        }
    };
    let served = passes.last().map(|pass| pass.served);
    FrontendEvent::PipelineEnd(RunEnd { served, passes }).emit(&app);
    // Push the post-render snapshot: running back to false, plus any new
    // date/city/has_water (e.g. the scheduler's midnight reconcile).
    state.mark_status_dirty();
    r.map(|_| ())
}

/// How a run loop (`drive`) ended: `pipeline:end`'s payload. The window settles each
/// request it's waiting on from the pass that served it — the first whose `served`
/// reaches its ticket — rather than from the loop's last pass, which may have been
/// another request's, or from the next status, guessing which busy stretch was its
/// request's.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunEnd {
    /// Every request whose ticket is at or below this was served: the last pass's
    /// `served`. `None` from Dev Mode's preview, which serves none.
    pub served: Option<u64>,
    /// Each pass in turn.
    pub passes: Vec<PassEnd>,
}

/// One pass of a run loop (`drive`), for the requests it served: those whose tickets
/// are above the pass before's `served`, and at or below its own.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PassEnd {
    /// The last ticket this pass served (`Requests::take`).
    pub served: u64,
    /// Why it failed, or `None` when it didn't.
    pub failure: Option<String>,
    /// Whether it put a map on the desktop. With syncing off none does.
    pub painted: bool,
}

/// `RunKind::Force`'s extra step: forget what was last applied. The signature names
/// the target, not its look, so after a style edit it still matches the old image —
/// and if the render that edit asked for fails, the poll would take the old image
/// for up to date and never retry. Runs only while holding `state.running` (from
/// inside `drive`'s loop): done before taking it, a render already in flight could
/// mark its pre-change image applied right after.
fn forget_applied(app: &AppHandle) {
    *app.state::<AppState>().last_applied.lock().unwrap() = None;
}

/// One pass of `drive`'s loop: resolve today's target and bring it in — painted while
/// syncing, only fetched otherwise. `Ok(true)` when it put a map on the desktop.
async fn run_now_inner(app: &AppHandle) -> Result<bool> {
    let date = city::today();
    let theme = effective_theme(app);
    let Some(target) = resolve_target(app, date, theme)? else {
        // Nothing to show (no pin). Not an outcome either way, so the errors below
        // are left exactly as they were.
        return Ok(false);
    };
    let r = if target.paint {
        apply_target(app, &target).await
    } else {
        fetch_target(app, &target).await.map(|()| false)
    };
    // Record the outcome against the target — the one path by which a failure
    // reaches the UI, since every caller of `run_now` is detached and drops the
    // `Result` (see `AppState::map_error`). Success clears it, so a map that
    // recovers stops reporting. A run that only fetches says nothing about the
    // desktop, so it leaves `wall_error` alone.
    let state = app.state::<AppState>();
    let at = |e: &anyhow::Error| Some((target.key.clone(), e.to_string()));
    let (map, wall) = match &r {
        Ok(_) => (None, None),
        Err(Failure::Map(e)) => (at(e), None),
        Err(Failure::Wallpaper(e)) => (None, at(e)),
    };
    *state.map_error.lock().unwrap() = map;
    if target.paint {
        *state.wall_error.lock().unwrap() = wall;
    }
    note_outcome(app, &target, r.is_ok());
    // A Daily run that has its map sweeps the days gone by, whether it painted the
    // desktop or only fetched: with syncing off, a fetch is all that ever runs, and
    // each day's tens of MB would otherwise pile up for good.
    if r.is_ok() {
        if let TargetKind::Daily(_) = target.kind {
            if let Ok(dir) = daily_dir(app) {
                let _ = cleanup_daily(&dir, city::today());
            }
        }
    }
    r.map_err(Failure::into_error)
}

/// The current map's run of failures (`AppState::failed_run`): which map, how many
/// in a row, and when the scheduler's poll may try it again — `None` for not at all.
#[derive(Clone, Debug)]
pub struct FailedRun {
    pub key: String,
    pub count: u32,
    pub retry_at: Option<SystemTime>,
}

/// How long the poll waits before trying a Daily map again after it failed, by how
/// many times in a row it has: five minutes, then fifteen, then every hour from the
/// third on.
const DAILY_RETRY_MINUTES: [u64; 3] = [5, 15, 60];

/// When the poll may try a map again after its `count`-th failure in a row, from
/// now — `None` for never.
///
/// A Daily map is the background's to get: whoever uses Daily isn't watching for
/// it, so it's tried again quietly, backing off. A pin isn't: whoever just pinned a
/// place is watching for it, and decides themselves whether to try again — which
/// also keeps live Overpass fetches, each pin's only source, as rare as can be.
fn retry_after(kind: &TargetKind, count: u32) -> Option<Duration> {
    match kind {
        TargetKind::Custom { .. } => None,
        TargetKind::Daily(_) => {
            let i = (count.max(1) as usize - 1).min(DAILY_RETRY_MINUTES.len() - 1);
            Some(Duration::from_secs(DAILY_RETRY_MINUTES[i] * 60))
        }
    }
}

/// Keep `target`'s outcome for the poll (`poll_may_run`): a success clears the
/// record; a failure counts on from one of the same map's, or starts over. Wall
/// clock rather than a monotonic one, which barely moves while the machine sleeps:
/// an hour's wait is an hour, asleep or not.
fn note_outcome(app: &AppHandle, target: &Target, ok: bool) {
    let state = app.state::<AppState>();
    let mut failed = state.failed_run.lock().unwrap();
    if ok {
        *failed = None;
        return;
    }
    let count = failed.as_ref().filter(|f| f.key == target.key).map_or(0, |f| f.count) + 1;
    let retry_at = retry_after(&target.kind, count).map(|wait| SystemTime::now() + wait);
    *failed = Some(FailedRun { key: target.key.clone(), count, retry_at });
}

/// Whether the scheduler's poll may run now: not while the current map is waiting
/// out a failure, and never for a pin that failed (`retry_after`). Someone asking —
/// Regenerate, Retry, a pin applied again, a setting changed — runs regardless; only
/// the poll waits.
pub fn poll_may_run(app: &AppHandle) -> bool {
    let Some((key, _)) = current_map(app) else { return true };
    match app.state::<AppState>().failed_run.lock().unwrap().as_ref() {
        Some(f) if f.key == key => f.retry_at.is_some_and(|at| SystemTime::now() >= at),
        _ => true,
    }
}

/// Where a run fell short: getting the map's data — the window has nothing to
/// show — or, with the data in hand, putting it on the desktop.
enum Failure {
    Map(anyhow::Error),
    Wallpaper(anyhow::Error),
}

impl Failure {
    fn into_error(self) -> anyhow::Error {
        match self {
            Failure::Map(e) | Failure::Wallpaper(e) => e,
        }
    }
}

/// A run with syncing off: make sure the target's map data is cached for the
/// window, and leave the desktop alone. Free once it's there: a Daily cache that
/// already names its city — as `city_for_status`'s memo says, without reading tens
/// of MB again — or a pin's square, written whole (`atomic::write`), is taken as it
/// is (the window reads the file itself), unless Dev Mode's bypass asks for the map
/// afresh.
async fn fetch_target(app: &AppHandle, target: &Target) -> Result<(), Failure> {
    let bypass = app.state::<AppState>().effective_bypass_cache();
    let cached = !bypass
        && target.osm_path.exists()
        && match target.kind {
            TargetKind::Daily(date) => city_for_status(app, date).is_some(),
            TargetKind::Custom { .. } => true,
        };
    if !cached {
        prune_other_pins(app, target);
        let quick = match target.kind {
            TargetKind::Daily(date) if !bypass => cache_published_day(app, target, date).await,
            _ => false,
        };
        if !quick {
            let resolved = resolve_and_record(app, target).await.map_err(Failure::Map)?;
            acquire_osm(app, target, resolved).await.map_err(Failure::Map)?;
        }
    }
    mark_applied(app, &target.signature);
    Ok(())
}

/// `fetch_target`'s short way to a Daily map: the published manifest
/// (`cdn::fetch_scheduled_raw`), written to the cache as published, and its city
/// recorded as `resolve_and_record` records it — no `Value` built, since nothing
/// here draws it. `false` on any miss, for the whole ladder to take over (whose
/// manifest rung then asks again: a few quick misses, against a reconstruction).
async fn cache_published_day(app: &AppHandle, target: &Target, date: NaiveDate) -> bool {
    let (city, bytes) = match cdn::fetch_scheduled_raw(&date.to_string()).await {
        Ok(got) => got,
        Err(e) => {
            log::info!("[pipeline] no manifest for {date} ({e}); going down the ladder");
            return false;
        }
    };
    if let Err(e) = crate::atomic::write(&target.osm_path, &bytes) {
        log::warn!("[pipeline] couldn't cache {date}'s map ({e}); going down the ladder");
        return false;
    }
    log::info!("[pipeline] scheduled city for {}: {} ({}), cached as published", date, city.name, city.country);
    let state = app.state::<AppState>();
    *state.resolved_city.lock().unwrap() = Some((date, Some(city)));
    // The city, and the map now to hand (`Status::map_ready`).
    state.mark_status_dirty();
    true
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
///
/// `Ok(true)` once the picture is on the desktop; `Ok(false)` when syncing was turned
/// off while it rendered — a pin's fetch and render can take minutes — since off
/// means the desktop keeps whatever it has (`commands::set_sync`). The picture then
/// stays in the cache, nothing is marked applied, and the fetch-only run that
/// turning it off queued takes over.
async fn apply_target(app: &AppHandle, target: &Target) -> Result<bool, Failure> {
    let live = wallpaper_dir(app).map_err(Failure::Wallpaper)?;
    prune_other_pins(app, target);

    render_and_cache(app, target).await?;
    if !app.state::<AppState>().sync_wallpaper.load(Ordering::Acquire) {
        log::info!("[pipeline] syncing turned off mid-run; not setting {}", target.key);
        return Ok(false);
    }
    wallpaper_set::set(&target.png_path, &live).map_err(Failure::Wallpaper)?;
    mark_applied(app, &target.signature);
    log::info!("[pipeline] wallpaper set: {}", target.key);
    Ok(true)
}

/// A new Customized coordinate supersedes any previous pin: the old pin's files go
/// before the new one's are written, so only the active pin is kept.
fn prune_other_pins(app: &AppHandle, target: &Target) {
    if let TargetKind::Custom { ref key, .. } = target.kind {
        if let Ok(dir) = custom_dir(app) {
            let _ = prune_other_custom(&dir, key);
        }
    }
}

/// Resolve `target`, render it, and write both halves to its cache — the day's
/// (or pin's) `.osm.json` (inside `render_bytes_for`) and its `.png`.
/// Everything the pipeline does for a target *except* applying the wallpaper, so
/// `run_now_inner` and Dev Mode's Advance Preview can share one path and can't
/// drift apart. Returns the city drawn plus the PNG bytes.
async fn render_and_cache(app: &AppHandle, target: &Target) -> Result<(city::City, Vec<u8>), Failure> {
    let resolved = resolve_and_record(app, target).await.map_err(Failure::Map)?;
    let city = resolved.city.clone();
    let bytes = render_bytes_for(app, target, resolved).await?;
    crate::atomic::write(&target.png_path, &bytes).map_err(|e| Failure::Wallpaper(e.into()))?;
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
/// no GeoNames id, name or country for arbitrary coordinates — so it's its
/// coordinates alone, which is all its caption shows (core/label.ts), and `id: 0`.
fn pin_city(lat: f64, lon: f64) -> city::City {
    city::City {
        id: 0,
        name: String::new(),
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
        // A pin is never published, and Dev Mode's bypass leaves pins alone
        // (`AppState::bypass_cache_for`) — each would be another live Overpass fetch.
        // Once its square is cached, that's the pin's map; Dev Mode's Clean cache is
        // the way to have it fetched afresh (`commands::clean_cache`).
        TargetKind::Custom { lat, lon, .. } => {
            let osm = cached_osm_at(&target.osm_path).map(DayOsm::Cached);
            Ok(Resolved { city: pin_city(lat, lon), osm, stamp: None })
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
/// `Err` — the caller leaves yesterday's wallpaper up and the scheduler tries again,
/// backing off (`poll_may_run`), rather than painting a city nothing else agrees on.
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
    // Every writer of this file stamps the day's city on it (see `stamp`).
    if let Some(v) = cached_osm_at(osm_path) {
        if let Some(city) = city_envelope(&v) {
            log::info!("[pipeline] city for {} from cache: {} ({})", date, city.name, city.country);
            return Ok(Resolved { city, osm: Some(DayOsm::Cached(v)), stamp: Some(date) });
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
///     envelope every writer stamps on, so it says exactly what was rendered.
///
/// `None` when neither has an answer — the day hasn't been rendered yet (first
/// launch of a day, a render still in flight or one that couldn't reach the
/// schedule). There is
/// deliberately no third source: naming the day from a local formula is exactly
/// what the retired rotation did, and it would report a city the wallpaper doesn't
/// show. The home renders the gap as a placeholder.
///
/// The answer is memoized under (1) **whether or not there was one**: `Status` is
/// rebuilt on every settings change, and (2) reads a payload of tens of MB.
///
/// A memoized `None` can't go stale. The only way this day acquires an answer later
/// is its payload being written, and every writer records the city as it does,
/// overwriting the memo: a render or a fetch-only run going down the ladder
/// (`resolve_and_record`, first), or a fetch-only run's published manifest
/// (`cache_published_day`, alongside).
///
/// Describes the *Daily* flow only, which is what `Status::city` reports — a
/// Customized pin is shown from `Status::custom`.
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
///
/// Not `<date>.osm.json`, the name earlier versions wrote: a day they had to rebuild
/// live (no manifest on the CDN) they fetched as their screen's crop alone, which the
/// window — laying every day as the 20 km square — would show with bands missing. So
/// those are never read: the day is had again, once, as the square, and the old file
/// ages out with the rest (`cleanup_daily`). As pins did (`pin_osm_name`).
fn daily_osm_name(date: NaiveDate) -> String {
    format!("{date}.square.osm.json")
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

/// The `city` envelope on `<date>.square.osm.json` in the *Daily* cache —
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
async fn render_bytes_for(app: &AppHandle, target: &Target, resolved: Resolved) -> Result<Vec<u8>, Failure> {
    let (city, osm) = acquire_osm(app, target, resolved).await.map_err(Failure::Map)?;
    render_bytes(app, target, &city, osm).await.map_err(Failure::Wallpaper)
}

/// The target's map data, in hand and in its cache: what resolving it already
/// produced, or — for a pin not fetched yet, the reconstruction rung, or Dev Mode's
/// bypass — fetched live as the square every screen's crop lies in, and written back.
async fn acquire_osm(app: &AppHandle, target: &Target, resolved: Resolved) -> Result<(city::City, serde_json::Value)> {
    let Resolved { city, osm: preloaded, stamp } = resolved;

    // The back half of the acquisition ladder `resolve_daily` documents: its first
    // two rungs (cache, schedule manifest) arrive here already resolved as
    // `preloaded`, because they also decide *which city* this is. What's left is the
    // live sidecar — which honors the proxy, important for mainland-China users.
    //
    // Every rung yields the same square — the published one, or the one fetched live
    // here — so the window can lay it for any shape of its own, as the website lays a
    // day's, and the renderer projects within its screen's crop and clips the rest.
    let written = !matches!(preloaded, Some(DayOsm::Cached(_)));
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
        // Nothing preloaded: a Customized pin not fetched yet (arbitrary coordinates,
        // never published), the reconstruction rung, or Dev Mode's bypass. Written
        // back afterwards, so a bypassed fetch overwrites the stale local data as
        // documented.
        None => {
            log::info!("[pipeline] fetching osm live from sidecar");
            let square = bbox_for_screen(city.lat, city.lon, defaults::get().max_half_km, 1.0);
            let mut v = osm_sidecar::fetch(app, square).await?;
            if let Some(date) = stamp {
                stamp_manifest_envelope(&mut v, date, &city);
            }
            write_osm(&target.osm_path, &v)?;
            v
        }
    };
    // Written: the window can draw it now (`Status::map_ready`) rather than once the
    // wallpaper is rendered and set, and the pin line stops showing a fetch.
    if written {
        app.state::<AppState>().mark_status_dirty();
    }
    Ok((city, osm))
}

/// Draw `osm` for the screen in the hidden renderer window, in the current style,
/// returning the PNG bytes.
async fn render_bytes(app: &AppHandle, target: &Target, city: &city::City, osm: serde_json::Value) -> Result<Vec<u8>> {
    let renderer = ensure_renderer(app).await?;
    let ((w, h), screens) = screen_geometry(&renderer)?;
    // The screen's crop of the square the data was had for (`acquire_osm`): the same
    // 20 km long side (`max_half_km`, packages/core/src/defaults.json) — the square
    // is the superset every screen-aspect rectangle fits inside, so the data always
    // covers the wallpaper (`pnpm bbox-test` checks the square contains them all).
    let bbox = bbox_for_screen(city.lat, city.lon, defaults::get().max_half_km, w as f64 / h as f64);
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

    // A pin has no name (`pin_city`), so its caption is its coordinates alone: the
    // renderer sets them as the caption's one line (core/label.ts).
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

/// Write a payload to its cache path, whole or not at all (`atomic::write`, which
/// also creates the directory — see the note above the `*_dir` helpers). The window
/// reads the file as soon as it exists (`Status::map_ready`), and so does the next
/// launch: a write cut short by a quit or a crash must leave no half of it there.
fn write_osm(path: &Path, v: &serde_json::Value) -> Result<()> {
    crate::atomic::write(path, v.to_string().as_bytes())?;
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
            let out = render_and_cache(app, &target).await.map_err(Failure::into_error);
            if let Ok(dir) = daily_dir(app) {
                let _ = cleanup_daily(&dir, city::today());
            }
            out.map(|(city, bytes)| (city, bytes, target.png_path))
        }
        Err(e) => Err(e),
    };
    // A run requested while the preview held `running` was queued for it (see
    // `drive`); hand it on now that the renderer is free.
    let state = app.state::<AppState>();
    let queued = {
        let mut g = state.running.lock().await;
        *g = false;
        state.requests.lock().unwrap().pending.is_some()
    };
    FrontendEvent::PipelineEnd(RunEnd { served: None, passes: Vec::new() }).emit(app);
    state.mark_status_dirty();
    if queued {
        spawn_drive(app.clone());
    }
    r
}

/// The hidden renderer window `lib.rs`'s setup builds, once its webview is ready.
///
/// The window *existing* says nothing about the webview inside it having
/// subscribed yet. `render-request` is a fire-and-forget `emit`, so a render that
/// gets here first would have its request dropped on the floor and then burn the
/// full 120s result timeout ("renderer timeout").
async fn ensure_renderer(app: &AppHandle) -> Result<WebviewWindow> {
    let w = app.get_webview_window("renderer").ok_or_else(|| anyhow!("no renderer window"))?;
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
///
/// A temp file left by a write cut short (`atomic::write`) goes whatever its date:
/// nothing reads it, and no write is under way while this runs — both happen only
/// inside a run, which holds `running`.
fn cleanup_daily(dir: &Path, today: NaiveDate) -> Result<()> {
    for_each_daily_artifact(dir, |entry, d| {
        let age = (today - d).num_days();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let keep = if name.ends_with(".tmp") {
            false
        } else if name.ends_with(".osm.json") {
            (0..=KEEP_OSM_DAYS).contains(&age)
        } else {
            age <= KEEP_DAYS
        };
        if !keep {
            let _ = fs::remove_file(entry.path());
        }
    })
}

/// A pin's map data's file name. Not `<key>.osm.json`, the name earlier versions
/// wrote: theirs is only the crop of the screen it was rendered for, which a window
/// of another shape would run off the edge of — so it's fetched again, once, as the
/// square, and the old file is swept with the rest.
fn pin_osm_name(key: &str) -> String {
    format!("{key}.square.osm.json")
}

/// Drop every file in the customized cache that doesn't belong to `key` (the
/// active pin), so applying a new coordinate leaves only that coordinate's
/// files. A pin's files are `pin_osm_name` and `<key>.png`; the names older
/// versions wrote (`<key>.osm.json`, `<key>-<theme>.png`) go too, since nothing
/// reads them.
fn prune_other_custom(dir: &Path, key: &str) -> Result<()> {
    let osm = pin_osm_name(key);
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

/// Request a run, detached: number and queue the request (`ask`), then start a loop
/// to do it — or leave it to the loop in flight. Returns the request's ticket: the
/// pass in `pipeline:end` whose `served` first reaches it is the one that served it.
fn spawn_run(app: AppHandle, kind: RunKind) -> u64 {
    let ticket = ask(&app, kind);
    spawn_drive(app);
    ticket
}

/// `drive`, detached: errors are logged.
fn spawn_drive(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = drive(app).await {
            log::error!("[pipeline] run failed: {e}");
        }
    });
}

/// Render + apply the current mode's wallpaper (OSM data is reused if cached).
/// Fire-and-forget; errors are logged. Used on mode switches / applying a pin /
/// revealing today's city or moving its caption — changes that move the target, so
/// the signature alone tells the poll whether they landed. With syncing off it only
/// fetches the map. A no-op with no pin. Returns the request's ticket (`spawn_run`).
pub fn spawn_apply(app: AppHandle) -> u64 {
    spawn_run(app, RunKind::Apply)
}

/// Render + apply today's wallpaper when what changed is its look, which the
/// signature doesn't encode — see `forget_applied`. Used for theme switches,
/// style/color/layer edits, and "regenerate now".
/// Fire-and-forget: errors are logged. A no-op with no pin. Returns the request's
/// ticket (`spawn_run`).
pub fn spawn_force_regen(app: AppHandle) -> u64 {
    spawn_run(app, RunKind::Force)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pass_serves_only_the_requests_whose_work_it_took() {
        let mut queue = Requests::default();
        assert_eq!(queue.take(), None, "nothing asked for, nothing to do");
        let apply = queue.ask(RunKind::Apply);
        let force = queue.ask(RunKind::Force);
        assert!(apply < force);
        // Both asked before the pass: merged to the stronger, both served by it.
        assert_eq!(queue.take(), Some((RunKind::Force, force)));
        // Asked once the pass has its work: the next pass's, never this one's.
        let later = queue.ask(RunKind::Apply);
        assert_eq!(queue.take(), Some((RunKind::Apply, later)));
        assert_eq!(queue.take(), None);
    }

    /// The loop's side of `Requests` while the window's commands and the scheduler
    /// ask from other threads. Were a request numbered in one step and queued in
    /// another, a pass could count a ticket whose work wasn't queued yet, and the
    /// pass that later took that work would serve no ticket of its own.
    #[test]
    fn every_ticket_asked_from_many_threads_is_served_by_exactly_one_pass() {
        use std::sync::{Arc, Mutex};
        const THREADS: u64 = 8;
        const EACH: u64 = 500;
        let queue = Arc::new(Mutex::new(Requests::default()));
        let askers: Vec<_> = (0..THREADS)
            .map(|i| {
                let queue = Arc::clone(&queue);
                std::thread::spawn(move || {
                    (0..EACH)
                        .map(|j| {
                            let kind = if (i + j) % 3 == 0 { RunKind::Force } else { RunKind::Apply };
                            queue.lock().unwrap().ask(kind)
                        })
                        .collect::<Vec<u64>>()
                })
            })
            .collect();
        let mut served = vec![0];
        loop {
            let asked = askers.iter().all(|t| t.is_finished());
            let taken = queue.lock().unwrap().take();
            match taken {
                Some((_, last)) => served.push(last),
                None if asked => break,
                None => std::thread::yield_now(),
            }
        }
        let mut tickets: Vec<u64> = askers.into_iter().flat_map(|t| t.join().unwrap()).collect();
        tickets.sort_unstable();
        assert_eq!(tickets, (1..=THREADS * EACH).collect::<Vec<_>>(), "each request numbered once, none skipped");
        assert!(served.windows(2).all(|w| w[0] < w[1]), "every pass serves a ticket the one before didn't");
        assert_eq!(served.last(), Some(&(THREADS * EACH)), "no ticket left unserved");
    }

    /// `RunEnd` crosses the IPC boundary untyped: apps/desktop/src/types.ts reads
    /// these keys, and settles each waiting request from its own pass.
    #[test]
    fn run_end_payload_uses_the_keys_the_window_reads() {
        let end = RunEnd {
            served: Some(7),
            passes: vec![
                PassEnd { served: 5, failure: None, painted: true },
                PassEnd { served: 7, failure: Some("renderer timed out".into()), painted: false },
            ],
        };
        assert_eq!(
            serde_json::to_value(&end).unwrap(),
            serde_json::json!({
                "served": 7,
                "passes": [
                    { "served": 5, "failure": null, "painted": true },
                    { "served": 7, "failure": "renderer timed out", "painted": false },
                ],
            })
        );
    }

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

    // An unstamped payload names no city, so `resolve_daily`
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
        let keep = ["51.5_-0.12.square.osm.json", "51.5_-0.12.png"];
        let drop = [
            "48.85_2.35.square.osm.json",
            "48.85_2.35.png",
            // The active pin's names from older versions: never read, so swept.
            "51.5_-0.12.osm.json",
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

    /// Earlier versions' day caches were sometimes only their screen's crop: the
    /// name moved so those are never read as the square the window lays.
    #[test]
    fn a_days_cache_is_named_for_the_square() {
        let date = NaiveDate::from_ymd_opt(2026, 11, 7).unwrap();
        assert_eq!(daily_osm_name(date), "2026-11-07.square.osm.json");
    }

    /// A Daily map is tried again after 5 minutes, then 15, then every hour; a pin
    /// that failed is never tried again by the poll.
    #[test]
    fn retry_backs_off_for_a_day_and_never_for_a_pin() {
        let day = TargetKind::Daily(NaiveDate::from_ymd_opt(2026, 11, 7).unwrap());
        let minutes = |n: u32| retry_after(&day, n).map(|d| d.as_secs() / 60);
        assert_eq!([1, 2, 3, 4, 10].map(minutes), [Some(5), Some(15), Some(60), Some(60), Some(60)]);
        let pin = TargetKind::Custom { key: "48.85_2.35".into(), lat: 48.85, lon: 2.35 };
        assert_eq!(retry_after(&pin, 1), None);
        assert_eq!(retry_after(&pin, 5), None);
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
            format!("{}.square.osm.json", day(0)),
            format!("{}.png", day(0)),
            format!("{}.square.osm.json", day(-1)),
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
            // Today's payload, from a write cut short: never read.
            format!("{}.osm.json.tmp", day(0)),
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
        let key = format!("daily:{date}");
        assert_eq!(render_signature(&key, EffectiveTheme::Light, None), "daily:2026-10-16:light");
        assert_eq!(
            render_signature(&key, EffectiveTheme::Dark, Some("bottom-right")),
            "daily:2026-10-16:dark:label-bottom-right"
        );
        assert_ne!(
            render_signature(&key, EffectiveTheme::Dark, Some("top-left")),
            render_signature(&key, EffectiveTheme::Dark, Some("bottom-right"))
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
