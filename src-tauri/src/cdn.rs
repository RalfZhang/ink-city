//! Reads of the pre-cached map data the GitHub Actions workflow
//! (.github/workflows/precache.yml) publishes to the `data` branch and jsDelivr
//! serves. Two flows live there: the date-keyed schedule manifests (`osm-v2/`) and
//! the legacy id-keyed rotation payloads (`osm/`), each a slimmed 20km-square OSM
//! response carrying every layer (see scripts/osm-cli.ts).
//!
//! Tried before the live osm-cli sidecar because jsDelivr is reliably reachable
//! from mainland China and the slim payload is small. Any miss (404 / not yet
//! cached / network error) falls through to the sidecar, which itself falls back
//! across Overpass mirrors (see osm_sidecar.rs / core/osm/overpass.ts).
//!
//! See `github_mirror` for the mirrored-host order and why those hosts.

use std::io::Read;

use anyhow::{anyhow, Result};
use flate2::read::GzDecoder;

use crate::city;
use crate::github_mirror;

const GIT_REF: &str = "data";
const PATH: &str = "osm";
/// The date-keyed manifests.
///
/// Must match `SCHEDULE_ROOT`/`SCHEDULE_DATA_DIR` in `src/core/schedule.ts`,
/// which is where the layout is defined and the producer side reads it from.
const SCHEDULE_PATH: &str = "osm-v2/data";
/// The schedule *state* file, one level up from the manifests: `<dir>/<stem>.json`
/// = `osm-v2/city-list.json`. Must match `SCHEDULE_ROOT`/`SCHEDULE_STATE_FILE` in
/// `src/core/schedule.ts`.
///
/// Normally CI/human-facing only — the client gets city *and* map data from one
/// manifest and never needs this. The exception is Dev Mode's "bypass cache &
/// CDN", which wants the day's true-random city precisely *without* that day's
/// precached map data; see `fetch_schedule_city`.
const SCHEDULE_STATE_DIR: &str = "osm-v2";
const SCHEDULE_STATE_STEM: &str = "city-list";

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
pub async fn fetch_scheduled(date: &str) -> Result<(city::City, serde_json::Value)> {
    let bases = github_mirror::mirror_urls(GIT_REF, SCHEDULE_PATH);
    let v = fetch_from_mirrors(bases, date, Gz::Prefer, validate_scheduled).await?;
    let city = scheduled_city(&v)?;
    Ok((city, v))
}

/// Which mirror hosts a read may use.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Hosts {
    /// Every mirror: CDN edges first, GitHub's raw origin last (`mirror_urls`).
    Mirrored,
    /// GitHub's raw origin only, no CDN edge — Dev Mode's "bypass cache & CDN".
    GithubOnly,
}

/// `date`'s city from the schedule state file alone — no map data.
///
/// Two callers, for the same underlying reason — they want the day's *city*
/// without the multi-MB manifest that normally carries it:
///
///   • the daily fallback chain, once every manifest host has missed: the city
///     from here plus a live Overpass fetch reproduces what the manifest would
///     have held (`Hosts::Mirrored`);
///   • Dev Mode's "bypass cache & CDN", which wants exactly that reconstruction
///     every time, and reads from `Hosts::GithubOnly` so no CDN edge can serve it
///     a cached copy of the one file it still needs.
///
/// Never cached locally: it's a few KB, and it's the hand-editable override point
/// (see docs/random-city-strategy.md), so a stale copy is worse than a refetch.
/// Unlike the manifests it's never gzipped by the workflow, so it's fetched plain
/// (`Gz::Skip`) rather than spending a request on a `.gz` that can't exist.
pub async fn fetch_schedule_city(date: &str, hosts: Hosts) -> Result<city::City> {
    let bases = match hosts {
        Hosts::Mirrored => github_mirror::mirror_urls(GIT_REF, SCHEDULE_STATE_DIR),
        Hosts::GithubOnly => github_mirror::github_only_urls(GIT_REF, SCHEDULE_STATE_DIR),
    };
    let v = fetch_from_mirrors(bases, SCHEDULE_STATE_STEM, Gz::Skip, validate_state).await?;
    schedule_entry(&v, date)
}

pub async fn fetch_cached_osm(city_id: u64) -> Result<serde_json::Value> {
    let bases = github_mirror::mirror_urls(GIT_REF, PATH);
    fetch_from_mirrors(bases, &city_id.to_string(), Gz::Prefer, validate_osm).await
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

/// A date-keyed manifest must be usable as *both* map data and a city — validate
/// exactly what `fetch_scheduled` hands back, so a truncated or half-written one
/// gives the next mirror a turn instead of silently dropping the day.
fn validate_scheduled(v: &serde_json::Value, url: &str) -> Result<()> {
    validate_osm(v, url)?;
    require_city(v, url)
}

/// `city-list.json` carries no `elements`, so the OSM check doesn't apply — what
/// makes it usable is a `list` object. An array passes `is_object()` nowhere, and
/// a missing/renamed key must not read as "an empty schedule": that would look
/// like every day legitimately having no entry.
fn validate_state(v: &serde_json::Value, url: &str) -> Result<()> {
    match v.get("list") {
        Some(l) if l.is_object() => Ok(()),
        _ => Err(anyhow!("unusable schedule state ({url}): no `list` object")),
    }
}

/// One day out of a parsed `city-list.json`. A date the schedule doesn't cover is
/// an ordinary miss (the client's window can sit outside the published 30 days).
fn schedule_entry(v: &serde_json::Value, date: &str) -> Result<city::City> {
    let entry = v
        .get("list")
        .and_then(|l| l.get(date))
        .ok_or_else(|| anyhow!("schedule has no entry for {date}"))?;
    Ok(serde_json::from_value(entry.clone())?)
}

/// Whether a `.json.gz` sibling is worth asking for before the plain `.json`.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Gz {
    /// The map payloads: try `.gz` first (see `fetch_from_mirrors`).
    Prefer,
    /// `city-list.json` — the workflow's gzip pass deliberately sweeps only
    /// `osm-v2/data/` (asserted by `pnpm schedule-test`), so no `.gz` sibling is
    /// ever published for it and asking would just spend a request on a 404.
    Skip,
}

/// Fetch `{base}/{stem}.json` from the first of `bases` that serves a payload
/// `validate` accepts. Shared by every published read — they differ only in the
/// host list, the file stem (city id / date / `city-list`), whether a `.gz`
/// sibling exists, and what "usable" means for that file.
///
/// `bases` is already ordered by the caller (see `github_mirror::mirror_urls`):
/// every CDN edge first, GitHub's raw origin last. Combined with the per-host
/// `.gz` → `.json` pair below, that's the whole fallback ladder for a day's map
/// data — CDN gz, CDN json, …, GitHub gz, GitHub json — before `pipeline` gives
/// up on the manifest and reconstructs it from the schedule state file instead.
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
    bases: Vec<String>,
    stem: &str,
    gz: Gz,
    validate: fn(&serde_json::Value, &str) -> Result<()>,
) -> Result<serde_json::Value> {
    let client = github_mirror::client()?;
    let mut last_err = None;
    for base in bases {
        let mut attempts: Vec<(String, bool)> = Vec::with_capacity(2);
        if gz == Gz::Prefer {
            attempts.push((format!("{base}/{stem}.json.gz"), true));
        }
        attempts.push((format!("{base}/{stem}.json"), false));
        for (url, gzipped) in attempts {
            let result = fetch_json(&client, &url, gzipped)
                .await
                .and_then(|v| validate(&v, &url).map(|()| v));
            match result {
                Ok(v) => return Ok(v),
                Err(e) => last_err = Some(e),
            }
        }
    }
    Err(last_err.unwrap_or_else(|| anyhow!("no CDN hosts configured")))
}

async fn fetch_json(
    client: &reqwest::Client,
    url: &str,
    gzipped: bool,
) -> Result<serde_json::Value> {
    let res = client.get(url).send().await?;
    if !res.status().is_success() {
        return Err(anyhow!("CDN HTTP {} ({url})", res.status()));
    }
    if gzipped {
        decode_gz_json(&res.bytes().await?, url)
    } else {
        Ok(res.json().await?)
    }
}

fn decode_gz_json(bytes: &[u8], url: &str) -> Result<serde_json::Value> {
    let mut decoder = GzDecoder::new(bytes);
    let mut s = String::new();
    decoder
        .read_to_string(&mut s)
        .map_err(|e| anyhow!("gunzip failed ({url}): {e}"))?;
    Ok(serde_json::from_str(&s)?)
}

// Validate before trusting it, so a truncated/garbage response falls back to
// the osm-cli sidecar instead of producing an empty wallpaper.
fn validate_osm(v: &serde_json::Value, url: &str) -> Result<()> {
    let has_roads = v
        .get("elements")
        .and_then(|e| e.as_array())
        .is_some_and(|a| !a.is_empty());
    if !has_roads {
        return Err(anyhow!("CDN payload has no road elements ({url})"));
    }
    Ok(())
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

    fn json(s: &str) -> serde_json::Value {
        serde_json::from_str(s).unwrap()
    }

    #[test]
    fn decode_gz_json_round_trips() {
        let compressed = gzip(br#"{"elements":[{"type":"way"}]}"#);
        let v = decode_gz_json(&compressed, "test://x").unwrap();
        assert_eq!(v["elements"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn decode_gz_json_rejects_non_gzip_bytes() {
        let err = decode_gz_json(b"not gzip data", "test://x").unwrap_err();
        assert!(err.to_string().contains("gunzip failed"));
    }

    #[test]
    fn validate_osm_accepts_payload_with_roads() {
        assert!(validate_osm(&json(r#"{"elements":[{"type":"way"}]}"#), "test://x").is_ok());
    }

    #[test]
    fn validate_osm_rejects_empty_elements() {
        assert!(validate_osm(&json(r#"{"elements":[]}"#), "test://x").is_err());
    }

    #[test]
    fn validate_osm_rejects_missing_elements() {
        assert!(validate_osm(&json(r#"{"water":[]}"#), "test://x").is_err());
    }

    const CITY: &str = r#"{"id":2797656,"name":"Ghent","localName":"Gent",
        "country":"BE","lat":51.05,"lon":3.72,"population":231493}"#;

    #[test]
    fn require_city_accepts_a_schedule_manifest() {
        assert!(require_city(&json(&format!(r#"{{"city":{CITY}}}"#)), "test://x").is_ok());
    }

    // The id-keyed flow's payload: valid OSM, but nothing naming the day's city.
    #[test]
    fn require_city_rejects_a_payload_without_one() {
        assert!(require_city(&json(r#"{"elements":[{"type":"way"}]}"#), "test://x").is_err());
    }

    // A half-written `city` must fail here, not later in the pipeline: failing
    // here lets the mirror loop try the next host instead of dropping the day.
    #[test]
    fn require_city_rejects_a_partial_city() {
        assert!(require_city(&json(r#"{"city":{"lat":51.05,"lon":3.72}}"#), "test://x").is_err());
    }

    // A manifest has to pass both halves — map data *and* city.
    #[test]
    fn validate_scheduled_needs_both_osm_and_city() {
        let both = json(&format!(r#"{{"elements":[{{"type":"way"}}],"city":{CITY}}}"#));
        assert!(validate_scheduled(&both, "test://x").is_ok());
        assert!(validate_scheduled(&json(&format!(r#"{{"city":{CITY}}}"#)), "test://x").is_err());
        assert!(validate_scheduled(&json(r#"{"elements":[{"type":"way"}]}"#), "test://x").is_err());
    }

    // --- the schedule state file (Dev Mode's bypass path) ---

    #[test]
    fn validate_state_accepts_a_list_object() {
        assert!(validate_state(&json(r#"{"list":{}}"#), "test://x").is_ok());
    }

    // A missing or array `list` must be an error, not "an empty schedule" — the
    // latter would look like every day legitimately having no entry.
    #[test]
    fn validate_state_rejects_a_missing_or_array_list() {
        assert!(validate_state(&json(r#"{"list":[]}"#), "test://x").is_err());
        assert!(validate_state(&json(r#"{}"#), "test://x").is_err());
    }

    #[test]
    fn schedule_entry_reads_the_day() {
        let v = json(&format!(r#"{{"list":{{"2026-07-28":{CITY}}}}}"#));
        let city = schedule_entry(&v, "2026-07-28").expect("the day is in the list");
        assert_eq!(city.id, 2797656);
        assert_eq!(city.local_name, "Gent");
    }

    // A date outside the published window, and a day whose hand-edited entry is
    // malformed, are both ordinary misses the caller has to handle.
    #[test]
    fn schedule_entry_errors_on_an_absent_or_broken_day() {
        let v = json(&format!(r#"{{"list":{{"2026-07-28":{CITY},"2026-07-29":{{"lat":1}}}}}}"#));
        assert!(schedule_entry(&v, "2026-08-15").is_err());
        assert!(schedule_entry(&v, "2026-07-29").is_err());
    }
}
