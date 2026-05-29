use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// Remote canonical cities list. We pull from jsDelivr (a Cloudflare-fronted
/// CDN of GitHub) rather than raw.githubusercontent.com because the latter is
/// frequently DNS-poisoned in mainland China and unreliable for users there;
/// jsDelivr also has 12h edge-cache propagation, fine for our daily-check
/// cadence. ETag-based conditional GETs avoid re-downloading unchanged
/// content. Update this URL if the repo / branch moves.
const REMOTE_URL: &str =
    "https://cdn.jsdelivr.net/gh/RalfZhang/ink-city@main/src/data/cities.json";

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
    let client = reqwest::Client::builder()
        .user_agent("InkCity/0.1")
        .timeout(Duration::from_secs(30))
        .build()?;

    let mut req = client.get(REMOTE_URL);
    if let Some(etag) = &meta.etag {
        req = req.header("If-None-Match", etag);
    }
    let res = req.send().await?;

    if res.status().as_u16() == 304 {
        eprintln!("[cities] remote unchanged (304)");
        return Ok(());
    }
    if !res.status().is_success() {
        return Err(anyhow!("HTTP {}", res.status()));
    }

    let new_etag = res
        .headers()
        .get("etag")
        .and_then(|v| v.to_str().ok())
        .map(String::from);
    let body = res.text().await?;

    // Validate before overwriting cache.
    let parsed: Vec<serde_json::Value> = serde_json::from_str(&body)?;
    if parsed.is_empty() {
        return Err(anyhow!("remote cities.json is empty"));
    }

    let d = data_dir(app)?;
    fs::write(d.join(CACHE_FILE), &body)?;

    meta.etag = new_etag;
    save_meta(app, &meta)?;

    eprintln!("[cities] cache updated ({} entries)", parsed.len());
    Ok(())
}

/// Fire-and-forget: check the remote list, refresh cache if changed.
/// Errors are logged; never blocks or fails the caller.
pub fn spawn_check(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = check_update(&app).await {
            eprintln!("[cities] update check failed: {}", e);
        }
    });
}
