use std::io::Read;

use anyhow::{anyhow, Result};
use flate2::read::GzDecoder;

use crate::city;
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
/// The date-keyed manifests. Their schedule (`osm-v2/city-list.json`) sits one
/// level up and is CI/human-facing only — the client never fetches it.
///
/// Must match `SCHEDULE_ROOT`/`SCHEDULE_DATA_DIR` in `src/core/schedule.ts`,
/// which is where the layout is defined and the producer side reads it from.
const SCHEDULE_PATH: &str = "osm-v2/data";

/// Fetch the date-keyed schedule manifest published by precache (issue #1):
/// `osm-v2/data/<date>.json[.gz]` = `{ v, elements, …, date, city }`, so one
/// request yields both the day's city and its map data. A miss (not yet
/// published, an older client's window, or a network error) is expected and lets
/// the caller fall back to the legacy id-keyed rotation.
///
/// Returns the day's `City` already deserialized, and rejects a payload whose
/// `city` won't deserialize as part of validation — so a host serving a
/// truncated or half-written manifest is treated like any other bad payload and
/// the *next mirror* gets a turn, rather than the whole day silently dropping to
/// the rotation. Validating exactly what the caller consumes is also what keeps
/// the two from drifting apart.
///
/// NOTE: the publish→CDN→client path is unverified end-to-end (needs a real
/// precache run + the live CDN); the fetch is fallback-guarded so a miss is safe.
pub async fn fetch_scheduled(date: &str) -> Result<(city::City, serde_json::Value)> {
    let v = fetch_from_mirrors(SCHEDULE_PATH, date, require_city).await?;
    let city = scheduled_city(&v)?;
    Ok((city, v))
}

pub async fn fetch_cached_osm(city_id: u64) -> Result<serde_json::Value> {
    fetch_from_mirrors(PATH, &city_id.to_string(), |_, _| Ok(())).await
}

/// The manifest's `city` envelope as a `City`. The id-keyed flow's payloads carry
/// one too, but this is only ever called on the date-keyed ones.
fn scheduled_city(v: &serde_json::Value) -> Result<city::City> {
    let c = v.get("city").ok_or_else(|| anyhow!("schedule payload has no `city`"))?;
    Ok(serde_json::from_value(c.clone())?)
}

fn require_city(v: &serde_json::Value, url: &str) -> Result<()> {
    scheduled_city(v)
        .map(|_| ())
        .map_err(|e| anyhow!("unusable schedule payload ({url}): {e}"))
}

/// Fetch `{path}/{stem}.json` from the first mirror host that serves a payload
/// passing `validate_osm` and `extra`. Shared by both published flows — they
/// differ only in the directory, the file stem (city id vs. date) and that extra
/// check.
///
/// jsDelivr rejects individual files over its 20 MB per-file cap, which
/// large/dense cities' plain JSON can exceed. The workflow publishes a
/// gzip-compressed sibling to bring those payloads back under 20 MB so the CDN
/// will serve them at all (see precache.yml) — this is about the file-size cap,
/// not bandwidth, since jsDelivr already gzips .json over the wire
/// transparently. So prefer the .gz. Fall back to the plain .json on the *same*
/// host (branch not yet re-published with .gz files, or this particular file
/// predates that) before moving to the next host entirely.
async fn fetch_from_mirrors(
    path: &str,
    stem: &str,
    extra: fn(&serde_json::Value, &str) -> Result<()>,
) -> Result<serde_json::Value> {
    let client = github_mirror::client()?;
    let mut last_err = None;
    for base in github_mirror::mirror_urls(GIT_REF, path) {
        let attempts: [(String, bool); 2] = [
            (format!("{base}/{stem}.json.gz"), true),
            (format!("{base}/{stem}.json"), false),
        ];
        for (url, gzipped) in attempts {
            let result = if gzipped {
                fetch_and_validate_gz(&client, &url).await
            } else {
                fetch_and_validate(&client, &url).await
            };
            match result.and_then(|v| extra(&v, &url).map(|()| v)) {
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

    const CITY: &str = r#"{"id":2797656,"name":"Ghent","localName":"Gent",
        "country":"BE","lat":51.05,"lon":3.72,"population":231493}"#;

    #[test]
    fn require_city_accepts_a_schedule_manifest() {
        let v: serde_json::Value = serde_json::from_str(&format!(r#"{{"city":{CITY}}}"#)).unwrap();
        assert!(require_city(&v, "test://x").is_ok());
    }

    // The id-keyed flow's payload: valid OSM, but nothing naming the day's city.
    #[test]
    fn require_city_rejects_a_payload_without_one() {
        let v: serde_json::Value = serde_json::from_str(r#"{"elements":[{"type":"way"}]}"#).unwrap();
        assert!(require_city(&v, "test://x").is_err());
    }

    // A half-written `city` must fail here, not later in the pipeline: failing
    // here lets the mirror loop try the next host instead of dropping the day.
    #[test]
    fn require_city_rejects_a_partial_city() {
        let v: serde_json::Value = serde_json::from_str(r#"{"city":{"lat":51.05,"lon":3.72}}"#).unwrap();
        assert!(require_city(&v, "test://x").is_err());
    }
}
