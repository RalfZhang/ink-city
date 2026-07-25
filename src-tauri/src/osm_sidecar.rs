use std::collections::HashMap;
use std::sync::atomic::Ordering;

use anyhow::{anyhow, Result};
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

use crate::bbox::Bbox;
use crate::state::AppState;

/// Fetch OSM data for `b` by invoking the bundled `osm-cli` sidecar in
/// single-shot "fetch" mode — the exact same TypeScript implementation
/// (`scripts/osm-cli.ts` → `src/core/fetch-city.ts`) that produces the
/// precached CDN payload, run live. Used whenever CDN-cached data isn't
/// available: a CDN miss on the daily rotation, or (in the future) a
/// user-entered custom city/coordinates, which are never precached. Because
/// both paths go through this one binary — and neither passes `--layers`, so
/// both fall through to `osm-cli`'s all-layers default — the live fallback
/// always carries the same layers as the CDN, instead of the roads-only gap
/// the old hand-written Rust Overpass client left.
pub async fn fetch(app: &AppHandle, b: Bbox) -> Result<serde_json::Value> {
    let sidecar = app
        .shell()
        .sidecar("osm-cli")
        .map_err(|e| anyhow!("osm-cli sidecar not available: {}", e))?;

    let mut cmd = sidecar.args([
        "fetch".to_string(),
        format!("--south={}", b.south),
        format!("--west={}", b.west),
        format!("--north={}", b.north),
        format!("--east={}", b.east),
    ]);

    // Route the sidecar's live Overpass fetch through the user's proxy when set.
    // The sidecar is a compiled Bun binary whose `fetch` honors the standard
    // HTTPS_PROXY / HTTP_PROXY / ALL_PROXY environment variables, so handing the
    // child those vars is all that's needed — no JS-side change. Extends the
    // inherited environment (doesn't clear it).
    {
        let state = app.state::<AppState>();
        if state.proxy_enabled.load(Ordering::Acquire) {
            let url = state.proxy_url.lock().unwrap().trim().to_string();
            if !url.is_empty() {
                let env = HashMap::from([
                    ("HTTPS_PROXY".to_string(), url.clone()),
                    ("HTTP_PROXY".to_string(), url.clone()),
                    ("ALL_PROXY".to_string(), url),
                ]);
                cmd = cmd.envs(env);
            }
        }
    }

    let (mut rx, _child) = cmd
        .spawn()
        .map_err(|e| anyhow!("failed to spawn osm-cli sidecar: {}", e))?;

    let mut stdout = Vec::new();
    let mut stderr_msg = String::new();
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => stdout.extend_from_slice(&bytes),
            CommandEvent::Stderr(bytes) => stderr_msg.push_str(&String::from_utf8_lossy(&bytes)),
            CommandEvent::Error(e) => return Err(anyhow!("osm-cli sidecar error: {}", e)),
            CommandEvent::Terminated(payload) => {
                if payload.code != Some(0) {
                    return Err(anyhow!(
                        "osm-cli sidecar exited with {:?}: {}",
                        payload.code,
                        stderr_msg.trim()
                    ));
                }
            }
            _ => {}
        }
    }

    serde_json::from_slice(&stdout).map_err(|e| anyhow!("osm-cli sidecar produced invalid JSON: {}", e))
}
