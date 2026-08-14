use std::fs;
use std::path::PathBuf;

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::github_mirror;

/// Remote canonical cities list — the search index `city.rs` loads (it no longer
/// feeds a daily rotation; the schedule does that). Refreshing it out of band means
/// a city added to `main` becomes searchable without shipping a new build.
///
/// ETag-based conditional GETs avoid re-downloading unchanged content, but only
/// against the primary host below (see `check_update`) — jsDelivr's 12h edge-cache
/// propagation is fine for our daily-check cadence.
///
/// See `github_mirror` for the mirrored-host fallback order and rationale.
/// Update `GIT_REF` / `REMOTE_PATH` if the repo / branch moves.
const GIT_REF: &str = "main";
const REMOTE_PATH: &str = "src/data/cities.json";

const CACHE_FILE: &str = "cities.json";
const META_FILE: &str = "cities.meta.json";

#[derive(Serialize, Deserialize, Default)]
struct CacheMeta {
    etag: Option<String>,
}

fn data_dir(app: &AppHandle) -> Result<PathBuf> {
    let d = app.path().app_data_dir()?;
    fs::create_dir_all(&d)?;
    Ok(d)
}

fn load_meta(app: &AppHandle) -> CacheMeta {
    let Ok(d) = data_dir(app) else { return CacheMeta::default() };
    let Ok(s) = fs::read_to_string(d.join(META_FILE)) else { return CacheMeta::default() };
    serde_json::from_str(&s).unwrap_or_default()
}

fn save_meta(app: &AppHandle, meta: &CacheMeta) -> Result<()> {
    let d = data_dir(app)?;
    fs::write(d.join(META_FILE), serde_json::to_string_pretty(meta)?)?;
    Ok(())
}

async fn check_update(app: &AppHandle) -> Result<()> {
    let mut meta = load_meta(app);
    let client = github_mirror::client()?;
    let urls = github_mirror::mirror_urls(GIT_REF, REMOTE_PATH);

    let mut last_err = None;
    for (i, url) in urls.iter().enumerate() {
        let mut req = client.get(url);
        // Conditional GET only makes sense against the primary host: its
        // ETag is what we cached last time, and the fallback hosts are
        // different CDN providers entirely (e.g. Bunny for
        // jsdelivr.b-cdn.net), not guaranteed to compute the same ETag for
        // identical content.
        if i == 0 {
            if let Some(etag) = &meta.etag {
                req = req.header("If-None-Match", etag);
            }
        }

        let res = match req.send().await {
            Ok(res) => res,
            Err(e) => {
                last_err = Some(anyhow!("{e} ({url})"));
                continue;
            }
        };

        if i == 0 && res.status().as_u16() == 304 {
            log::info!("[cities] remote unchanged (304)");
            return Ok(());
        }
        if !res.status().is_success() {
            last_err = Some(anyhow!("HTTP {} ({url})", res.status()));
            continue;
        }

        return apply_update(app, &mut meta, res).await;
    }
    Err(last_err.unwrap_or_else(|| anyhow!("no remote hosts configured")))
}

async fn apply_update(app: &AppHandle, meta: &mut CacheMeta, res: reqwest::Response) -> Result<()> {
    let new_etag = res.headers().get("etag").and_then(|v| v.to_str().ok()).map(String::from);
    let body = res.text().await?;

    // Validate before overwriting cache.
    let parsed: Vec<serde_json::Value> = serde_json::from_str(&body)?;
    if parsed.is_empty() {
        return Err(anyhow!("remote cities.json is empty"));
    }

    let d = data_dir(app)?;
    fs::write(d.join(CACHE_FILE), &body)?;

    meta.etag = new_etag;
    save_meta(app, meta)?;

    log::info!("[cities] cache updated ({} entries)", parsed.len());
    Ok(())
}

/// Fire-and-forget: check the remote list, refresh cache if changed.
/// Errors are logged; never blocks or fails the caller.
pub fn spawn_check(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = check_update(&app).await {
            log::warn!("[cities] update check failed: {}", e);
        }
    });
}
