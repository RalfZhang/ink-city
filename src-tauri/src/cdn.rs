use anyhow::{anyhow, Result};

use crate::github_mirror;

// Pre-cached road + water data published daily by the GitHub Actions workflow
// (.github/workflows/precache.yml) to the `data` branch, served via jsDelivr.
// Keyed by GeoNames city id; the payload is a slimmed 20km-square OSM response
// (see scripts/osm-cli.ts). We fetch this before falling back to the osm-cli
// sidecar run live, because jsDelivr is reliably reachable from mainland
// China and the slim payload is small. A miss (404 / not yet cached / network
// error) just falls back to the sidecar, which itself falls back across
// Overpass mirrors (see osm_sidecar.rs / core/overpass.ts).
//
// See `github_mirror` for the mirrored-host fallback order and rationale.
const GIT_REF: &str = "data";
const PATH: &str = "osm";

pub async fn fetch_cached_osm(city_id: u64) -> Result<serde_json::Value> {
    let client = github_mirror::client()?;
    let bases = github_mirror::mirror_urls(GIT_REF, PATH);

    let mut last_err = None;
    for base in bases {
        let url = format!("{base}/{city_id}.json");
        match fetch_and_validate(&client, &url).await {
            Ok(v) => return Ok(v),
            Err(e) => last_err = Some(e),
        }
    }
    Err(last_err.unwrap_or_else(|| anyhow!("no CDN hosts configured")))
}

async fn fetch_and_validate(client: &reqwest::Client, url: &str) -> Result<serde_json::Value> {
    let res = client.get(url).send().await?;
    if !res.status().is_success() {
        return Err(anyhow!("CDN HTTP {} ({url})", res.status()));
    }

    let v: serde_json::Value = res.json().await?;
    // Validate before trusting it, so a truncated/garbage response falls back to
    // the osm-cli sidecar instead of producing an empty wallpaper.
    let has_roads = v
        .get("elements")
        .and_then(|e| e.as_array())
        .map_or(false, |a| !a.is_empty());
    if !has_roads {
        return Err(anyhow!("CDN payload has no road elements ({url})"));
    }
    Ok(v)
}
