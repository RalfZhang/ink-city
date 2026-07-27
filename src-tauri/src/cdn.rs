use std::io::Read;

use anyhow::{anyhow, Result};
use flate2::read::GzDecoder;

use crate::github_mirror;

// Pre-cached road + water data published daily by the GitHub Actions workflow
// (.github/workflows/precache.yml) to the `data` branch, served via jsDelivr.
// Keyed by GeoNames city id; the payload is a slimmed 20km-square OSM response
// (see scripts/osm-cli.ts). We fetch this before falling back to the osm-cli
// sidecar run live, because jsDelivr is reliably reachable from mainland
// China and the slim payload is small. A miss (404 / not yet cached / network
// error) just falls back to the sidecar, which itself falls back across
// Overpass mirrors (see osm_sidecar.rs / core/osm/overpass.ts).
//
// See `github_mirror` for the mirrored-host fallback order and rationale.
const GIT_REF: &str = "data";
const PATH: &str = "osm";

pub async fn fetch_cached_osm(city_id: u64) -> Result<serde_json::Value> {
    let client = github_mirror::client()?;
    let bases = github_mirror::mirror_urls(GIT_REF, PATH);

    let mut last_err = None;
    for base in bases {
        // jsDelivr rejects individual files over its 20 MB per-file cap, which
        // large/dense cities' plain JSON can exceed. The workflow publishes a
        // gzip-compressed sibling to bring those payloads back under 20 MB so
        // the CDN will serve them at all (see precache.yml) — this is about the
        // file-size cap, not bandwidth, since jsDelivr already gzips .json over
        // the wire transparently. So prefer the .gz. Fall back to the plain
        // .json on the *same* host (branch not yet re-published with .gz
        // files, or this particular id predates that) before moving to the
        // next host entirely.
        let attempts: [(String, bool); 2] = [
            (format!("{base}/{city_id}.json.gz"), true),
            (format!("{base}/{city_id}.json"), false),
        ];
        for (url, gzipped) in attempts {
            let result = if gzipped {
                fetch_and_validate_gz(&client, &url).await
            } else {
                fetch_and_validate(&client, &url).await
            };
            match result {
                Ok(v) => return Ok(v),
                Err(e) => last_err = Some(e),
            }
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
    validate_osm(v, url)
}

async fn fetch_and_validate_gz(client: &reqwest::Client, url: &str) -> Result<serde_json::Value> {
    let res = client.get(url).send().await?;
    if !res.status().is_success() {
        return Err(anyhow!("CDN HTTP {} ({url})", res.status()));
    }
    let bytes = res.bytes().await?;
    let v = decode_gz_osm(&bytes, url)?;
    validate_osm(v, url)
}

fn decode_gz_osm(bytes: &[u8], url: &str) -> Result<serde_json::Value> {
    let mut decoder = GzDecoder::new(bytes);
    let mut s = String::new();
    decoder
        .read_to_string(&mut s)
        .map_err(|e| anyhow!("gunzip failed ({url}): {e}"))?;
    Ok(serde_json::from_str(&s)?)
}

// Validate before trusting it, so a truncated/garbage response falls back to
// the osm-cli sidecar instead of producing an empty wallpaper.
fn validate_osm(v: serde_json::Value, url: &str) -> Result<serde_json::Value> {
    let has_roads = v
        .get("elements")
        .and_then(|e| e.as_array())
        .map_or(false, |a| !a.is_empty());
    if !has_roads {
        return Err(anyhow!("CDN payload has no road elements ({url})"));
    }
    Ok(v)
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use std::io::Write;

    fn gzip(bytes: &[u8]) -> Vec<u8> {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(bytes).unwrap();
        encoder.finish().unwrap()
    }

    #[test]
    fn decode_gz_osm_round_trips_json() {
        let json = r#"{"elements":[{"type":"way"}]}"#;
        let compressed = gzip(json.as_bytes());
        let v = decode_gz_osm(&compressed, "test://x").unwrap();
        assert_eq!(v["elements"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn decode_gz_osm_rejects_non_gzip_bytes() {
        let err = decode_gz_osm(b"not gzip data", "test://x").unwrap_err();
        assert!(err.to_string().contains("gunzip failed"));
    }

    #[test]
    fn validate_osm_accepts_payload_with_roads() {
        let v: serde_json::Value = serde_json::from_str(r#"{"elements":[{"type":"way"}]}"#).unwrap();
        assert!(validate_osm(v, "test://x").is_ok());
    }

    #[test]
    fn validate_osm_rejects_empty_elements() {
        let v: serde_json::Value = serde_json::from_str(r#"{"elements":[]}"#).unwrap();
        assert!(validate_osm(v, "test://x").is_err());
    }

    #[test]
    fn validate_osm_rejects_missing_elements() {
        let v: serde_json::Value = serde_json::from_str(r#"{"water":[]}"#).unwrap();
        assert!(validate_osm(v, "test://x").is_err());
    }
}
