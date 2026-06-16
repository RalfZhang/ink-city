use std::fs;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::time::Duration;

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_notification::{NotificationExt, PermissionState};
use tauri_plugin_updater::UpdaterExt;

use crate::state::AppState;
use crate::tray;

const META_FILE: &str = "update.meta.json";

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

/// Run an update check. `force` bypasses the cadence gate (used by the manual
/// "Check now" button); the background scheduler passes `false`. Returns the
/// available version string, or `None` when already up to date / the check was
/// skipped by the cadence gate.
pub async fn do_check(app: &AppHandle, force: bool) -> Result<Option<String>> {
    let mut meta = load_meta(app);
    if !force && !is_due(app, &meta) {
        return Ok(None);
    }

    let update = app
        .updater()
        .map_err(|e| anyhow!("updater unavailable: {e}"))?
        .check()
        .await
        .map_err(|e| anyhow!("update check failed: {e}"))?;

    // Record the attempt regardless of result so the cadence advances even
    // when we're already up to date or the endpoint was unreachable.
    meta.last_check = Some(chrono::Local::now().timestamp());

    let result = match update {
        Some(upd) => {
            let version = upd.version.clone();
            set_available(app, &mut meta, Some(version.clone()));
            // Notify once per new version; a freshly-released newer version
            // re-notifies because its string differs from last_notified_version.
            if meta.last_notified_version.as_deref() != Some(version.as_str()) {
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

/// Re-check and install the latest update, then relaunch. Re-checking (rather
/// than caching the `Update` object) keeps state simple and naturally handles
/// the case where the user upgraded out-of-band: `check()` returns `None`, we
/// clear the affordance and report `Ok(false)` ("already up to date").
/// On success this calls `app.restart()` and never returns.
async fn perform_install(app: &AppHandle) -> Result<bool> {
    let update = app
        .updater()
        .map_err(|e| anyhow!("updater unavailable: {e}"))?
        .check()
        .await
        .map_err(|e| anyhow!("update check failed: {e}"))?;

    let Some(update) = update else {
        // Nothing to install — clear any stale affordance.
        let mut meta = load_meta(app);
        set_available(app, &mut meta, None);
        let _ = save_meta(app, &meta);
        return Ok(false);
    };

    update
        .download_and_install(|_chunk, _total| {}, || {})
        .await
        .map_err(|e| anyhow!("update install failed: {e}"))?;

    app.restart();
}

/// Fire-and-forget install for the windowless paths (tray menu / notification
/// click). Guards against re-entry, surfaces success/failure via native dialogs
/// since there may be no webview to show state in, and relaunches on success.
pub fn spawn_install(app: AppHandle) {
    if app
        .state::<AppState>()
        .update_installing
        .swap(true, Ordering::AcqRel)
    {
        return; // an install is already in flight
    }

    tauri::async_runtime::spawn(async move {
        // A short "downloading" notification is the only feedback when no window
        // is open; the relaunch itself signals completion.
        notify_installing(&app);

        let res = perform_install(&app).await;
        app.state::<AppState>()
            .update_installing
            .store(false, Ordering::Release);

        match res {
            Ok(true) => { /* unreachable: perform_install relaunched */ }
            Ok(false) => info_dialog(&app, strings(&app).up_to_date),
            Err(e) => {
                eprintln!("[updater] install failed: {e}");
                info_dialog(&app, strings(&app).failed);
            }
        }
    });
}

/// Awaitable install for the General tab, where a webview is open to show the
/// "installing" spinner and surface errors. Returns `Ok(false)` when there's
/// nothing to install (already up to date, or another install is already in
/// flight); relaunches and never returns on success.
pub async fn install_now(app: &AppHandle) -> Result<bool> {
    let st = app.state::<AppState>();
    if st.update_installing.swap(true, Ordering::AcqRel) {
        return Ok(false); // an install is already running elsewhere
    }
    let res = perform_install(app).await;
    app.state::<AppState>()
        .update_installing
        .store(false, Ordering::Release);
    res
}

/// Ask the user (native dialog, no main window) whether to update now, and
/// install on confirmation. Shared by the tray entry and the notification path.
pub fn prompt_and_install(app: &AppHandle) {
    let version = app
        .state::<AppState>()
        .available_update
        .lock()
        .unwrap()
        .clone();
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

/// Hostname:port of the updater endpoint (see the `updater` plugin config in
/// `tauri.conf.json`). Used only for the cheap pre-flight handshake below; the
/// actual manifest fetch goes through the updater plugin.
const ENDPOINT_HOST: &str = "github.com:443";

/// Best-effort "is the network up?" probe: a short TCP handshake to the release
/// host. Right after wake-from-sleep the scheduler poll often races ahead of the
/// Wi-Fi reconnect, and the updater would surface that as an opaque error. We
/// pre-flight here so that race is treated as "retry next tick" instead. A
/// failure (or timeout) just means not-reachable-yet; it never fails the caller.
async fn endpoint_reachable() -> bool {
    matches!(
        tokio::time::timeout(
            Duration::from_secs(5),
            tokio::net::TcpStream::connect(ENDPOINT_HOST),
        )
        .await,
        Ok(Ok(_))
    )
}

/// One cadence-gated update check for the background scheduler, which calls this
/// on every poll tick. The persisted cadence gate (`is_due`, backed by
/// `last_check`) is the single source of truth for "is it time yet", so calling
/// this often is cheap — when nothing is due it's a no-op that touches no network.
///
/// Crucially this is safe to retry, unlike the old fire-once-per-day trigger: a
/// check that can't complete (most commonly the wake-from-sleep race above)
/// leaves `last_check` untouched, so the next tick tries again instead of the
/// day's only attempt being burned. It also means a `Daily` cadence fires the
/// moment 24h have actually elapsed, not only at the next date rollover. Never
/// blocks meaningfully or fails the caller.
pub async fn run_scheduled_check(app: &AppHandle) {
    let meta = load_meta(app);
    if !is_due(app, &meta) {
        return; // cadence not elapsed — nothing to do, no network touched
    }
    if !endpoint_reachable().await {
        return; // network not up yet (e.g. just woke) — retry on the next poll
    }
    // We've already gated on cadence + reachability, so commit to the check;
    // `force` skips the redundant in-`do_check` cadence re-evaluation.
    if let Err(e) = do_check(app, true).await {
        eprintln!("[updater] {e}");
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
        eprintln!("[updater] notification failed: {e}");
    }
}

fn notify_installing(app: &AppHandle) {
    let body = strings(app).downloading;
    let _ = app.notification().builder().title(TITLE).body(body).show();
}

/// A simple OK info dialog (no main window needed).
fn info_dialog(app: &AppHandle, body: String) {
    app.dialog()
        .message(body)
        .title(TITLE)
        .kind(MessageDialogKind::Info)
        .show(|_| {});
}
