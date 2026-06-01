use std::fs;
use std::path::PathBuf;

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::{NotificationExt, PermissionState};
use tauri_plugin_updater::UpdaterExt;

use crate::state::AppState;
use crate::tray;

const META_FILE: &str = "update.meta.json";

/// Persisted across launches so the weekly/monthly cadence survives restarts
/// (the app is a long-lived menu-bar process, but users do quit it) and so we
/// only notify once per new version instead of nagging on every check.
#[derive(Serialize, Deserialize, Default)]
struct CheckMeta {
    /// Unix seconds of the last automatic check (regardless of outcome).
    last_check: Option<i64>,
    /// Version string we've already shown a notification for.
    last_notified_version: Option<String>,
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

async fn run_check(app: &AppHandle) -> Result<()> {
    let mut meta = load_meta(app);
    if !is_due(app, &meta) {
        return Ok(());
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

    if let Some(upd) = update {
        let version = upd.version.clone();
        // Persistent in-app affordance: a tray entry that opens the About tab
        // (where Install & Restart lives). Shown on every detection so it
        // survives even after the one-shot notification is dismissed.
        tray::show_update_available(app);

        if meta.last_notified_version.as_deref() != Some(version.as_str()) {
            notify(app, &version);
            meta.last_notified_version = Some(version);
        }
    }

    save_meta(app, &meta)?;
    Ok(())
}

fn notify(app: &AppHandle, version: &str) {
    // macOS (and Windows toast) require the user to have granted notification
    // permission; request it lazily on first use if not already granted.
    if !matches!(app.notification().permission_state(), Ok(PermissionState::Granted)) {
        let _ = app.notification().request_permission();
    }

    let lang = app.state::<AppState>().language.lock().unwrap().clone();
    let (title, body) = match lang.as_str() {
        "zh-Hans" => (
            "InkCity",
            format!("有新版本 {} 可用 — 打开 InkCity 安装", version),
        ),
        _ => (
            "InkCity",
            format!("New version {} is available — open InkCity to install.", version),
        ),
    };

    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        eprintln!("[updater] notification failed: {e}");
    }
}

/// Fire-and-forget background check honoring the user's cadence. Called from
/// the scheduler on startup and on every midnight tick; the cadence gate
/// inside decides whether to actually hit the network. Never blocks or fails
/// the caller.
pub fn spawn_check(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = run_check(&app).await {
            eprintln!("[updater] {e}");
        }
    });
}
