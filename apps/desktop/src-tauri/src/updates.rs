use std::fs;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::time::Duration;

use anyhow::{anyhow, Result};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_notification::{NotificationExt, PermissionState};
use tauri_plugin_updater::{Updater, UpdaterExt};

use crate::github_mirror;
use crate::state::AppState;
use crate::tray;
use crate::update_bundle;

const META_FILE: &str = "update.meta.json";

/// Cached copy of the published relay list (`github_mirror::MIRRORS_FILE`).
///
/// Persisted so a launch that can't reach the CDN still uses the last list we
/// saw rather than falling back to whatever shipped in the binary — which for a
/// long-installed client is exactly the stale list the remote copy exists to
/// replace.
const MIRRORS_CACHE: &str = "update-mirrors.json";

/// Total budget for one relay-list refresh, across every host it tries.
const MIRRORS_REFRESH_BUDGET: Duration = Duration::from_secs(8);

/// Restore the cached relay list, without hitting the network. Called at
/// startup next to `restore_pending`, so the list is in force before anything
/// — a scheduled check, a tray install, a pending-update prompt — can want it.
///
/// Silent on every failure: no cache yet is the normal first-run state, and an
/// unusable one leaves the compiled-in default in force, which is a working
/// configuration and not worth alarming anyone over.
pub fn load_cached_mirrors(app: &AppHandle) {
    let Ok(path) = app.path().app_data_dir().map(|dir| dir.join(MIRRORS_CACHE)) else { return };
    let Ok(json) = fs::read_to_string(path) else { return };
    if let Err(e) = github_mirror::set_release_proxies(&json) {
        log::warn!("[mirrors] cached list unusable, using the compiled-in one: {e}");
    }
}

/// Re-read the published relay list and cache what we get.
///
/// Called from `do_check`, which is where it costs nothing: the check is
/// already cadence-gated, so this can't run more often than the user asked to
/// be checked, and it's the moment just before the list is actually needed. A
/// miss is not an error — `refresh_release_proxies` leaves the current list
/// alone — so this never fails the check it precedes.
async fn refresh_mirrors(app: &AppHandle) {
    // One budget for the whole ladder, because this runs ahead of a check the
    // user may be waiting on: the manual "Check now" passes `force` and so
    // skips `endpoint_reachable`, and an offline machine would otherwise pay
    // every CDN host's connect timeout in turn — half a minute of spinner
    // before the check it precedes even starts. The list is about a kilobyte,
    // so anything slower than this isn't worth the wait, and giving up leaves
    // the list already in force untouched.
    let refreshed =
        tokio::time::timeout(MIRRORS_REFRESH_BUDGET, github_mirror::refresh_release_proxies())
            .await;
    let Ok(Some(json)) = refreshed else { return };
    let Ok(dir) = app.path().app_data_dir() else { return };
    if let Err(e) = fs::create_dir_all(&dir).and_then(|()| fs::write(dir.join(MIRRORS_CACHE), json))
    {
        log::warn!("[mirrors] could not cache the list: {e}");
    }
}

/// User-facing strings for the windowless update flows (OS notification + native
/// dialogs). Following the same convention as the tray labels, translations live
/// in the frontend JSON locale files and are pushed into `AppState` via the
/// `set_update_strings` command; Rust just renders whatever it's told. The
/// English `Default` is the fallback before the frontend has synced (e.g. an
/// autostart launch whose check fires before the webview mounts).
///
/// `notify_body` / `prompt_body` carry a literal `{version}` placeholder (single
/// braces, so i18next leaves it untouched) that we substitute at render time.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStrings {
    pub notify_body: String,
    pub downloading: String,
    pub prompt_body: String,
    pub update_now: String,
    pub later: String,
    pub up_to_date: String,
    pub failed: String,
}

impl Default for UpdateStrings {
    fn default() -> Self {
        Self {
            notify_body: "New version {version} is available — open InkCity to update.".into(),
            downloading: "Downloading update…".into(),
            prompt_body: "Version {version} is available. Update now?".into(),
            update_now: "Update now".into(),
            later: "Later".into(),
            up_to_date: "You're already up to date.".into(),
            failed: "Update failed. Please try again later.".into(),
        }
    }
}

fn strings(app: &AppHandle) -> UpdateStrings {
    app.state::<AppState>().update_strings.lock().unwrap().clone()
}

/// Dialog/notification title is the product name — not translated.
const TITLE: &str = "InkCity";

/// Whether the in-app updater can actually apply an update to *this* install.
///
/// macOS and Windows: yes. One shipped bundle format each, and the updater knows
/// how to replace it.
///
/// Linux: no, as things stand. Tauri's updater can only replace an AppImage, and
/// we ship .deb + .rpm — a package-manager-owned install isn't ours to overwrite,
/// and the AppImage that would carry self-updates is blocked on the bundler (the
/// reason is written up in `.github/workflows/release.yml`). The check is a probe
/// for `$APPIMAGE` — which the AppImage runtime sets itself — rather than a flat
/// `false`, so this stays correct for anyone running a self-built AppImage and
/// lights up on its own if we ever ship one, with no second place to remember.
///
/// Gating on this rather than letting the check run and fail: an unsupported
/// install would otherwise check on its cadence, hit "AppImage not found" every
/// time, and show the user a permanent "Update check failed" they can do nothing
/// about. `Status::updater_supported` carries the same answer to the frontend,
/// which hides the update controls outright.
pub fn supported() -> bool {
    #[cfg(target_os = "linux")]
    {
        std::env::var_os("APPIMAGE").is_some()
    }
    #[cfg(not(target_os = "linux"))]
    {
        true
    }
}

/// Persisted across launches so the weekly/monthly cadence survives restarts
/// (the app is a long-lived menu-bar process, but users do quit it), so we only
/// notify once per new version instead of nagging on every check, and so the
/// "update available" affordance can be restored after a restart even when the
/// cadence gate would skip the next automatic check.
#[derive(Serialize, Deserialize, Default)]
struct CheckMeta {
    /// Unix seconds of the last automatic check (regardless of outcome).
    last_check: Option<i64>,
    /// Version string we've already shown a notification for.
    last_notified_version: Option<String>,
    /// Version string of the last-detected available update. Lets us restore the
    /// tray entry + General-tab affordance on the next launch without hitting the
    /// network — guarded by a semver comparison against the running version so a
    /// user who upgraded out-of-band (or via us) never sees a stale prompt.
    available_version: Option<String>,
}

fn meta_path(app: &AppHandle) -> Result<PathBuf> {
    let d = app.path().app_data_dir()?;
    fs::create_dir_all(&d)?;
    Ok(d.join(META_FILE))
}

fn load_meta(app: &AppHandle) -> CheckMeta {
    let Ok(path) = meta_path(app) else { return CheckMeta::default() };
    let Ok(s) = fs::read_to_string(path) else { return CheckMeta::default() };
    serde_json::from_str(&s).unwrap_or_default()
}

fn save_meta(app: &AppHandle, meta: &CheckMeta) -> Result<()> {
    let path = meta_path(app)?;
    fs::write(path, serde_json::to_string_pretty(meta)?)?;
    Ok(())
}

/// Whether enough time has passed (per the user's chosen cadence) to run
/// another automatic check. Returns `false` when checks are disabled.
fn is_due(app: &AppHandle, meta: &CheckMeta) -> bool {
    let choice = *app.state::<AppState>().update_check.lock().unwrap();
    let Some(days) = choice.interval_days() else { return false };
    match meta.last_check {
        None => true,
        Some(last) => {
            let elapsed = chrono::Local::now().timestamp() - last;
            elapsed >= days * 86_400
        }
    }
}

/// Record (or clear) the available-update state in one place: in-memory
/// `AppState` (read by `get_status`), the persisted meta, and the tray entry.
fn set_available(app: &AppHandle, meta: &mut CheckMeta, version: Option<String>) {
    *app.state::<AppState>().available_update.lock().unwrap() = version.clone();
    meta.available_version = version.clone();
    if version.is_some() {
        tray::show_update_available(app);
    } else {
        tray::hide_update_available(app);
    }
    app.state::<AppState>().mark_status_dirty();
}

/// How long one manifest fetch may take before the updater moves to the next
/// endpoint. The plugin sets no timeout of its own, so an endpoint that accepts
/// the connection and then goes quiet would hang on the OS-level TCP timeout
/// (over a minute) before the ladder below got a turn.
///
/// Per *endpoint*, so it doesn't bound the check — that's `CHECK_BUDGET`.
///
/// Applies to the check only: the plugin hands `Update` an explicit `None`
/// timeout, so this can't cut a slow bundle download short.
const MANIFEST_TIMEOUT: Duration = Duration::from_secs(10);

/// Total budget for one check, across every endpoint in the ladder.
///
/// `MANIFEST_TIMEOUT` alone doesn't bound anything a user experiences: the two
/// multiply, so widening the ladder to the origin plus five relays turned a
/// ten-second worst case into a minute of spinner the manual "Check now" can't
/// be talked out of (it passes `force`, so it skips `endpoint_reachable`).
///
/// This can cut the ladder short of its last hosts, and that's the trade: those
/// hosts are only reached when every earlier one wedged for ten seconds
/// apiece, and a check that far gone is better retried — nothing is recorded on
/// failure, so the next tick tries again, against a possibly refreshed list.
const CHECK_BUDGET: Duration = Duration::from_secs(30);

/// The `endpoints` array out of the `updater` plugin config.
///
/// Split out from `configured_endpoints` so it can be tested against the real
/// `tauri.conf.json`: an empty result here doesn't break the updater, it just
/// silently costs every user the mirror ladder, so a renamed key or a moved
/// endpoint would otherwise regress this with nothing to show for it.
fn endpoints_in(updater_config: Option<&serde_json::Value>) -> Vec<String> {
    updater_config
        .and_then(|updater| updater.get("endpoints"))
        .and_then(|endpoints| endpoints.as_array())
        .map(|endpoints| {
            endpoints.iter().filter_map(|url| url.as_str().map(str::to_string)).collect()
        })
        .unwrap_or_default()
}

/// The updater endpoints from `tauri.conf.json` (`plugins.updater.endpoints`),
/// read back out of the app config rather than restated here — the config is
/// where that URL lives, and a second copy in Rust is a copy that can drift.
/// Empty when the config is missing or shaped unexpectedly, which `updater`
/// treats as "leave the plugin's own list alone".
fn configured_endpoints(app: &AppHandle) -> Vec<String> {
    endpoints_in(app.config().plugins.0.get("updater"))
}

/// The signing pubkey from `tauri.conf.json` (`plugins.updater.pubkey`), read
/// from the same place for the same reason as the endpoints above.
///
/// An error, not an `Option`: `update_bundle` does its own verification now
/// (the plugin's lived inside the `download` we replaced), and that check is
/// the entire reason the untrusted relays in `github_mirror` are safe to
/// download from. No key means no verification, and no verification means we
/// don't install — so a config we can't read this out of has to stop the
/// install rather than quietly weaken it.
fn updater_pubkey(app: &AppHandle) -> Result<String> {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|updater| updater.get("pubkey"))
        .and_then(|pubkey| pubkey.as_str())
        .map(str::to_string)
        .filter(|pubkey| !pubkey.trim().is_empty())
        .ok_or_else(|| anyhow!("no updater pubkey configured — refusing to install"))
}

/// Each configured endpoint widened into the origin-then-relays ladder, so a
/// check that can't reach github.com falls through instead of failing outright.
fn manifest_endpoints(app: &AppHandle) -> Vec<Url> {
    configured_endpoints(app)
        .iter()
        .flat_map(|url| github_mirror::release_mirror_urls(url))
        .filter_map(|url| match Url::parse(&url) {
            Ok(parsed) => Some(parsed),
            Err(e) => {
                log::warn!("[updater] skipping unparseable endpoint {url:?}: {e}");
                None
            }
        })
        .collect()
}

/// Build the updater with the user's proxy applied when enabled, so update
/// checks and downloads take the same route as the rest of the app's traffic.
/// The proxy exists precisely for networks where the release host isn't reachable
/// directly, so a direct-connecting updater would be broken exactly when the
/// proxy is needed. Falls back to a direct connection when the proxy is off or
/// the stored URL is unparseable (logged, mirroring `github_mirror`).
fn updater(app: &AppHandle) -> Result<Updater> {
    let mut builder = app.updater_builder().timeout(MANIFEST_TIMEOUT);

    // `endpoints` *replaces* the plugin's configured list rather than adding to
    // it, which is why `release_mirror_urls` yields the origin as its first
    // entry. An empty ladder means we couldn't read the config at all — leave
    // the plugin's own list in place rather than build an updater with none.
    let endpoints = manifest_endpoints(app);
    if !endpoints.is_empty() {
        builder =
            builder.endpoints(endpoints).map_err(|e| anyhow!("invalid updater endpoints: {e}"))?;
    }

    let st = app.state::<AppState>();
    if st.proxy_enabled.load(Ordering::Acquire) {
        let url = st.proxy_url.lock().unwrap().trim().to_string();
        if !url.is_empty() {
            match reqwest::Url::parse(&url) {
                Ok(parsed) => builder = builder.proxy(parsed),
                Err(e) => log::warn!("[updater] ignoring invalid proxy URL {url:?}: {e}"),
            }
        }
    }
    builder.build().map_err(|e| anyhow!("updater unavailable: {e}"))
}

/// Run an update check. `force` bypasses the cadence gate (used by the manual
/// "Check now" button); the background scheduler passes `false`. Returns the
/// available version string, or `None` when already up to date / the check was
/// skipped by the cadence gate.
pub async fn do_check(app: &AppHandle, force: bool) -> Result<Option<String>> {
    // Ahead of the cadence gate and of `force`, so the manual "Check now" path
    // can't reach the updater either — on a .deb/.rpm install there is nothing
    // this could offer to install. The frontend hides the button that gets here,
    // so in practice this covers the tray/scheduler paths and anything a future
    // caller adds.
    if !supported() {
        return Ok(None);
    }

    let mut meta = load_meta(app);
    if !force && !is_due(app, &meta) {
        return Ok(None);
    }

    // Past the cadence gate, so we're committed to touching the network:
    // pick up any republished relay list before the check and the download
    // that may follow both go looking for one.
    refresh_mirrors(app).await;

    let update = checked(app).await?;

    // Record the attempt regardless of result so the cadence advances even
    // when we're already up to date or the endpoint was unreachable.
    meta.last_check = Some(chrono::Local::now().timestamp());

    let result = match update {
        Some(upd) => {
            let version = upd.version.clone();
            set_available(app, &mut meta, Some(version.clone()));
            // In auto-update mode the caller installs immediately, so the
            // "open InkCity to update" nudge would be misleading — the install
            // path shows its own "Downloading…" notice instead. Otherwise notify
            // once per new version; a freshly-released newer version re-notifies
            // because its string differs from last_notified_version.
            let auto = app.state::<AppState>().auto_update.load(Ordering::Acquire);
            if !auto && meta.last_notified_version.as_deref() != Some(version.as_str()) {
                notify(app, &version);
                meta.last_notified_version = Some(version.clone());
            }
            Some(version)
        }
        None => {
            // Up to date — clear any stale affordance (e.g. the user upgraded
            // out-of-band since the last detection).
            set_available(app, &mut meta, None);
            meta.last_notified_version = None;
            None
        }
    };

    save_meta(app, &meta)?;
    Ok(result)
}

/// Restore the "update available" affordance on launch from persisted meta,
/// without hitting the network. Guards against a stale prompt: only restores
/// when the persisted version is genuinely newer than the running version
/// (handles "user quit and reinstalled the latest build by hand").
pub fn restore_pending(app: &AppHandle) {
    if !supported() {
        return;
    }
    let mut meta = load_meta(app);
    let Some(v) = meta.available_version.clone() else { return };

    let current = &app.package_info().version; // semver::Version
    let still_newer = semver::Version::parse(&v).map(|av| av > *current).unwrap_or(false);

    if still_newer {
        *app.state::<AppState>().available_update.lock().unwrap() = Some(v);
        tray::show_update_available(app);
        // Bypasses `set_available`'s direct write — mark here too. Runs at
        // startup before any window listener (a harmless no-op then; the mount
        // `get_status` covers it).
        app.state::<AppState>().mark_status_dirty();
    } else {
        // Stale or unparseable — forget it so we don't prompt for a version the
        // user is already on (or past).
        meta.available_version = None;
        let _ = save_meta(app, &meta);
    }
}

/// Percent complete, or `None` when the total isn't known — a host that sent no
/// size gets a bare "Downloading…" rather than a number we made up. Clamped
/// because a resumed transfer's bookkeeping should never exceed the total, and
/// a readout that reads "104%" is worse than one that stalls at 100.
fn percent(downloaded: u64, total: Option<u64>) -> Option<u8> {
    let total = total?;
    if total == 0 {
        return None;
    }
    Some((downloaded.min(total) * 100 / total) as u8)
}

/// Publish the download percent to the frontend.
///
/// Pushes only when the integer percent actually changes, which is the whole
/// throttle: a 70 MB bundle arrives in thousands of chunks but crosses at most
/// a hundred percentage points, so there's no timer to manage and no risk of
/// flooding the status channel.
fn set_download_progress(app: &AppHandle, percent: Option<u8>) {
    let state = app.state::<AppState>();
    {
        let mut current = state.update_progress.lock().unwrap();
        if *current == percent {
            return;
        }
        *current = percent;
    }
    state.mark_status_dirty();
}

/// Re-check and install the latest update, then relaunch. Re-checking rather than
/// caching the `Update` object keeps state simple and handles the user having
/// upgraded out-of-band for free: `check()` returns `None`, so we clear the
/// affordance and report `Ok(false)` ("already up to date"). On success this calls
/// `app.restart()` and never returns.
async fn perform_install(app: &AppHandle) -> Result<bool> {
    let update = checked(app).await?;

    let Some(update) = update else {
        // Nothing to install — clear any stale affordance.
        let mut meta = load_meta(app);
        set_available(app, &mut meta, None);
        let _ = save_meta(app, &meta);
        return Ok(false);
    };

    // `download_and_install` is exactly these two steps, and splitting them is
    // what lets `update_bundle` own the transfer — resumable, across the mirror
    // ladder, verified against the same key — while the install itself stays
    // the plugin's business.
    let state = app.state::<AppState>();
    let fetched = update_bundle::fetch(
        &update,
        &updater_pubkey(app)?,
        |downloaded, total| set_download_progress(app, percent(downloaded, total)),
        || state.update_cancel.load(Ordering::Acquire),
    )
    .await;
    // Cleared on both outcomes and before `?`, so a failed download can't leave
    // the About tab showing a percentage for a transfer that isn't running.
    set_download_progress(app, None);

    update.install(fetched?).map_err(|e| anyhow!("update install failed: {e}"))?;

    app.restart();
}

/// Fire-and-forget install for the windowless paths (tray menu / notification
/// click). Guards against re-entry, surfaces success/failure via native dialogs
/// since there may be no webview to show state in, and relaunches on success.
pub fn spawn_install(app: AppHandle) {
    spawn_install_impl(app, false);
}

/// Auto-update install: same as `spawn_install` but `quiet` — no result dialogs.
/// A silent failure leaves the "update available" affordance (tray entry +
/// General tab) in place so the user can retry manually, and the next cadence
/// tick retries automatically; popping an unprompted error dialog on a menu-bar
/// app would be more alarming than useful.
pub fn spawn_auto_install(app: AppHandle) {
    spawn_install_impl(app, true);
}

/// Claim the single install slot, or `false` when an install is already running.
///
/// Also clears any cancel left over from a previous install — a flag set after
/// the last one had already finished would otherwise kill this one before it
/// started — and publishes the claim, because `Status::update_installing` is
/// what the About tab draws its progress from no matter which path started the
/// install.
fn claim_install(app: &AppHandle) -> bool {
    let state = app.state::<AppState>();
    if state.update_installing.swap(true, Ordering::AcqRel) {
        return false;
    }
    state.update_cancel.store(false, Ordering::Release);
    state.mark_status_dirty();
    true
}

/// Release the install slot and publish that, so a window open on a failed or
/// cancelled install stops showing it as running.
fn release_install(app: &AppHandle) {
    let state = app.state::<AppState>();
    state.update_installing.store(false, Ordering::Release);
    state.mark_status_dirty();
}

/// Ask the in-flight download to stop. A no-op when nothing is downloading, and
/// deliberately not a promise that it stops *now*: `update_bundle::fetch` polls
/// this between chunks, and a cancel that arrives once the bytes are already in
/// hand is ignored rather than abandoning an install mid-write.
pub fn cancel(app: &AppHandle) {
    app.state::<AppState>().update_cancel.store(true, Ordering::Release);
}

fn spawn_install_impl(app: AppHandle, quiet: bool) {
    if !claim_install(&app) {
        return; // an install is already in flight
    }

    tauri::async_runtime::spawn(async move {
        // A short "downloading" notification is the only feedback when no window
        // is open; the relaunch itself signals completion. Shown in quiet mode
        // too, so an auto-update gives a heads-up before the app restarts.
        notify_installing(&app);

        let res = perform_install(&app).await;
        let cancelled = app.state::<AppState>().update_cancel.load(Ordering::Acquire);
        release_install(&app);

        match res {
            Ok(true) => { /* unreachable: perform_install relaunched */ }
            Ok(false) => {
                if !quiet {
                    info_dialog(&app, strings(&app).up_to_date);
                }
            }
            // A cancel arrives here as a failed download, because that's what it
            // is — but the user asked for it, so it gets neither the error log
            // nor a dialog telling them what they just did. Read off the flag
            // rather than the message: `claim_install` clears it, so it can only
            // be set by a cancel belonging to *this* install.
            Err(_) if cancelled => log::info!("[updater] install cancelled"),
            Err(e) => {
                log::error!("[updater] install failed: {e}");
                if !quiet {
                    info_dialog(&app, strings(&app).failed);
                }
            }
        }
    });
}

/// Awaitable install for the General tab, where a webview is open to show the
/// "installing" spinner and surface errors. Returns `Ok(false)` when there's
/// nothing to install (already up to date, or another install is already in
/// flight); relaunches and never returns on success.
pub async fn install_now(app: &AppHandle) -> Result<bool> {
    if !claim_install(app) {
        return Ok(false); // an install is already running elsewhere
    }
    let res = perform_install(app).await;
    let cancelled = app.state::<AppState>().update_cancel.load(Ordering::Acquire);
    release_install(app);
    // Cancelling is not a failure to report: the tab that asked knows, and an
    // error toast for a button the user just pressed reads as a bug. Logged
    // rather than dropped, because a cancel landing in the narrow window after
    // the bytes are in hand would otherwise swallow a real install error.
    if cancelled {
        if let Err(e) = &res {
            log::info!("[updater] install ended after a cancel: {e}");
        }
        return Ok(false);
    }
    res
}

/// Ask the user (native dialog, no main window) whether to update now, and
/// install on confirmation. Shared by the tray entry and the notification path.
pub fn prompt_and_install(app: &AppHandle) {
    let version = app.state::<AppState>().available_update.lock().unwrap().clone();
    let Some(version) = version else { return };

    let s = strings(app);
    let app = app.clone();
    app.dialog()
        .message(s.prompt_body.replace("{version}", &version))
        .title(TITLE)
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(s.update_now, s.later))
        .show(move |confirmed| {
            if confirmed {
                spawn_install(app);
            }
        });
}

/// Budget for one host's pre-flight handshake below.
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// Best-effort "is the network up?" probe: a short TCP handshake against the
/// release origin and every relay, resolving as soon as *any* of them answers.
/// Right after wake-from-sleep the scheduler poll often races ahead of the Wi-Fi
/// reconnect, and the updater would surface that as an opaque error. We
/// pre-flight here so that race is treated as "retry next tick" instead. A
/// failure (or timeout) just means not-reachable-yet; it never fails the caller.
///
/// Probing the whole set rather than github.com alone is load-bearing, not
/// thoroughness: where the origin is blocked outright the handshake never
/// succeeds, so a single-host probe gates the scheduled check off *permanently*
/// — automatic updates silently never run, and the manual button (which passes
/// `force` and so never reaches here) becomes the only route to a new version.
/// Any host answering is enough, because the check that follows walks all of them.
async fn endpoint_reachable() -> bool {
    let mut probes = tokio::task::JoinSet::new();
    for target in github_mirror::release_probe_targets() {
        probes.spawn(async move {
            matches!(
                tokio::time::timeout(PROBE_TIMEOUT, tokio::net::TcpStream::connect(&target)).await,
                Ok(Ok(_))
            )
        });
    }
    // Concurrent rather than in sequence so an offline machine costs one
    // timeout instead of one per host; dropping the set aborts whatever is
    // still in flight the moment we have an answer.
    while let Some(result) = probes.join_next().await {
        if matches!(result, Ok(true)) {
            return true;
        }
    }
    false
}

/// Run the updater's check under `CHECK_BUDGET`. Shared by `do_check` and by
/// the re-check `perform_install` opens with, so neither can strand the user on
/// a spinner for as long as the ladder happens to be.
async fn checked(app: &AppHandle) -> Result<Option<tauri_plugin_updater::Update>> {
    tokio::time::timeout(CHECK_BUDGET, updater(app)?.check())
        .await
        .map_err(|_| anyhow!("update check timed out"))?
        .map_err(|e| anyhow!("update check failed: {e}"))
}

/// One cadence-gated update check for the background scheduler, which calls this
/// on every poll tick. The persisted cadence gate (`is_due`, backed by
/// `last_check`) is the single source of truth for "is it time yet", so calling
/// this often is cheap — when nothing is due it's a no-op that touches no network.
///
/// Crucially it is safe to retry: a check that can't complete (most commonly the
/// wake-from-sleep race above) leaves `last_check` untouched, so the next tick tries
/// again rather than the day's only attempt being burned. It also means a `Daily`
/// cadence fires the moment 24h have actually elapsed, not only at the next date
/// rollover. Never blocks meaningfully or fails the caller.
pub async fn run_scheduled_check(app: &AppHandle) {
    let meta = load_meta(app);
    if !is_due(app, &meta) {
        return; // cadence not elapsed — nothing to do, no network touched
    }
    // The reachability probe is a *direct* TCP handshake to the release hosts.
    // With a proxy set those are typically unreachable directly by design, so the
    // probe would gate the check off forever. Skip it and let the proxied check
    // try — a failure just leaves `last_check` untouched and retries next tick.
    let proxied = app.state::<AppState>().proxy_enabled.load(Ordering::Acquire);
    if !proxied && !endpoint_reachable().await {
        return; // network not up yet (e.g. just woke) — retry on the next poll
    }
    // We've already gated on cadence + reachability, so commit to the check;
    // `force` skips the redundant in-`do_check` cadence re-evaluation.
    match do_check(app, true).await {
        // Update found and auto-update is on: install it and relaunch, no
        // confirmation. `do_check` already recorded `last_check`, so a failed
        // download won't re-fire until the next cadence window — the tray
        // affordance it set is the manual fallback in the meantime. When
        // auto-update is off, `do_check` has already surfaced the notification
        // and tray entry for a manual install.
        Ok(Some(_version)) => {
            if app.state::<AppState>().auto_update.load(Ordering::Acquire) {
                spawn_auto_install(app.clone());
            }
        }
        Ok(None) => {}
        Err(e) => log::warn!("[updater] {e}"),
    }
}

/// Request notification permission once, at startup. macOS shows its
/// authorization dialog only the first time; subsequent calls just return the
/// stored decision without prompting, so calling this on every launch is
/// harmless. Doing it here — rather than lazily the moment the first update
/// notification fires — means the user's choice is already settled by the time
/// we have something to announce, so that first notification can't be lost to a
/// still-open permission prompt.
pub fn ensure_permission(app: &AppHandle) {
    if !matches!(app.notification().permission_state(), Ok(PermissionState::Granted)) {
        let _ = app.notification().request_permission();
    }
}

fn notify(app: &AppHandle, version: &str) {
    // macOS (and Windows toast) only deliver notifications once permission has
    // been granted. We request that up front at startup (see `ensure_permission`),
    // so by now the decision is settled — we never race the OS prompt and drop
    // this notification. If it wasn't granted, stay silent: the tray "update
    // available" entry is still the affordance, and a user who declined
    // notifications shouldn't be nagged into re-requesting here.
    if !matches!(app.notification().permission_state(), Ok(PermissionState::Granted)) {
        return;
    }

    // NOTE: clicking a desktop notification is not delivered as an action by
    // tauri-plugin-notification (action handling is mobile-only). On macOS the
    // click instead activates the app → handled as `RunEvent::Reopen` in lib.rs,
    // which calls `prompt_and_install` when an update is pending. Windows toasts
    // don't route the click back, so there the tray entry is the actionable path.
    let body = strings(app).notify_body.replace("{version}", version);
    if let Err(e) = app.notification().builder().title(TITLE).body(body).show() {
        log::warn!("[updater] notification failed: {e}");
    }
}

fn notify_installing(app: &AppHandle) {
    let body = strings(app).downloading;
    let _ = app.notification().builder().title(TITLE).body(body).show();
}

/// A simple OK info dialog (no main window needed).
fn info_dialog(app: &AppHandle, body: String) {
    app.dialog().message(body).title(TITLE).kind(MessageDialogKind::Info).show(|_| {});
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tauri_conf() -> serde_json::Value {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tauri.conf.json");
        serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
    }

    /// Reads the shipped config, not a fixture: the point is to catch the
    /// endpoint being renamed or moved out from under `configured_endpoints`,
    /// which would drop the mirror ladder without failing anything else.
    #[test]
    fn endpoints_in_finds_the_configured_updater_endpoint() {
        let endpoints = endpoints_in(tauri_conf().pointer("/plugins/updater"));
        assert_eq!(endpoints.len(), 1, "expected exactly one configured endpoint");
        assert!(
            endpoints[0].starts_with("https://github.com/"),
            "endpoint {:?} is not on the host the relays prefix — release_mirror_urls \
             will hand it back unmirrored",
            endpoints[0]
        );
    }

    #[test]
    fn percent_needs_a_total_to_report_against() {
        assert_eq!(percent(0, None), None);
        assert_eq!(percent(1024, None), None);
        // A zero total would divide by zero; it also can't be a real bundle.
        assert_eq!(percent(0, Some(0)), None);
    }

    #[test]
    fn percent_reports_progress_against_the_total() {
        assert_eq!(percent(0, Some(200)), Some(0));
        assert_eq!(percent(100, Some(200)), Some(50));
        assert_eq!(percent(200, Some(200)), Some(100));
        // Truncates rather than rounds up, so it can't read 100% early.
        assert_eq!(percent(199, Some(200)), Some(99));
        // The real macOS bundle size, to be sure the arithmetic doesn't
        // overflow u64 on the `* 100` that precedes the divide. It's an odd
        // number of bytes, so a byte under half really is 49%.
        assert_eq!(percent(36_535_600, Some(73_071_199)), Some(50));
        assert_eq!(percent(36_535_599, Some(73_071_199)), Some(49));
    }

    /// Bookkeeping should never run past the total, but a readout showing
    /// "104%" is worse than one that sits at 100 — so it clamps.
    #[test]
    fn percent_clamps_rather_than_exceeding_a_hundred() {
        assert_eq!(percent(300, Some(200)), Some(100));
    }

    #[test]
    fn endpoints_in_tolerates_a_missing_or_misshapen_config() {
        assert!(endpoints_in(None).is_empty());
        assert!(endpoints_in(Some(&serde_json::json!({}))).is_empty());
        assert!(endpoints_in(Some(&serde_json::json!({ "endpoints": "not an array" }))).is_empty());
        // Non-string entries are dropped rather than poisoning the whole list.
        assert_eq!(
            endpoints_in(Some(&serde_json::json!({ "endpoints": ["https://a.example/x", 7] }))),
            ["https://a.example/x"]
        );
    }

    /// The whole ladder has to survive `Url` parsing, because the plugin
    /// re-parses each endpoint from a string on every check — and a relay URL
    /// carries a second `https://` inside its *path*, which is exactly the shape
    /// a normalizer might mangle. If it round-trips here it reaches the relay
    /// intact.
    #[test]
    fn every_mirrored_endpoint_survives_a_url_round_trip() {
        let configured = endpoints_in(tauri_conf().pointer("/plugins/updater"));
        let ladder = github_mirror::release_mirror_urls(&configured[0]);
        assert!(ladder.len() > 1, "expected the origin plus relays");
        for url in ladder {
            let parsed = Url::parse(&url).expect("mirrored endpoint must parse");
            assert_eq!(parsed.to_string(), url, "Url normalization altered {url}");
            assert_eq!(parsed.scheme(), "https", "the plugin rejects non-https endpoints");
        }
    }
}
