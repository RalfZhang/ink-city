use std::time::Duration;

use anyhow::{anyhow, Result};

// Pre-cached road + water data published daily by the GitHub Actions workflow
// (.github/workflows/precache.yml) to the `data` branch, served via jsDelivr.
// Keyed by GeoNames city id; the payload is a slimmed 20km-square OSM response
// (see scripts/osm-cli.ts). We fetch this before falling back to the osm-cli
// sidecar run live, because jsDelivr is reliably reachable from mainland China
// and the slim payload is small. A miss (404 / not yet cached / network error)
// just falls back to the sidecar.
const CDN_BASE: &str = "https://cdn.jsdelivr.net/gh/RalfZhang/ink-city@data/osm";

pub async fn fetch_cached_osm(city_id: u64) -> Result<serde_json::Value> {
    let url = format!("{}/{}.json", CDN_BASE, city_id);
    let client = reqwest::Client::builder()
        .user_agent("InkCity/0.1")
        .timeout(Duration::from_secs(30))
        .build()?;

    let res = client.get(&url).send().await?;
    if !res.status().is_success() {
        return Err(anyhow!("CDN HTTP {}", res.status()));
    }

    let v: serde_json::Value = res.json().await?;
    // Validate before trusting it, so a truncated/garbage response falls back to
    // the osm-cli sidecar instead of producing an empty wallpaper.
    let has_roads = v
        .get("elements")
        .and_then(|e| e.as_array())
        .map_or(false, |a| !a.is_empty());
    if !has_roads {
        return Err(anyhow!("CDN payload has no road elements"));
    }
    Ok(v)
}
