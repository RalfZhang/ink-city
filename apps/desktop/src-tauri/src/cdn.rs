//! Reads of the pre-cached map data the GitHub Actions workflow
//! (.github/workflows/precache.yml) publishes to the `data` branch and jsDelivr
//! serves: the date-keyed schedule manifests under `osm-v2/`, each a slimmed
//! 20km-square OSM response carrying every layer, plus the schedule state file
//! that names the day (see scripts/osm-cli.ts).
//!
//! The legacy id-keyed rotation payloads (`osm/<id>.json`) aren't read here: the
//! client dropped the `src/data/cities.json` rotation, and CI has since stopped
//! publishing them.
//!
//! Tried before the live osm-cli sidecar because jsDelivr is reliably reachable
//! from mainland China and the slim payload is small. Any miss (404 / not yet
//! cached / network error) falls through to the sidecar, which itself falls back
//! across Overpass mirrors (see osm_sidecar.rs / packages/osm/src/overpass.ts).
//!
//! See `github_mirror` for the mirrored-host order and why those hosts.

use std::io::Read;

use anyhow::{anyhow, Result};
use flate2::read::GzDecoder;

use crate::city;
use crate::github_mirror;

/// The directory of date-keyed manifests, `osm-v2/data`. The layout is the table's
/// `schedule` (`github_mirror::ScheduleLayout`, from packages/core/src/cdn.json),
/// which is also where CI publishes it.
fn manifest_dir() -> String {
    let layout = &github_mirror::table().schedule;
    format!("{}/{}", layout.root, layout.data_dir)
}

/// Fetch the date-keyed schedule manifest published by precache (issue #1):
/// `osm-v2/data/<date>.json[.gz]` = `{ v, elements, …, date, city }`, so one
/// request yields both the day's city and its map data. A miss (not yet
/// published, an older client's window, or a network error) is expected and lets
/// the caller reconstruct the day from the schedule state file instead
/// (`fetch_schedule_city` + a live Overpass fetch).
///
/// Returns the day's `City` already deserialized. A payload that doesn't parse,
/// its `city` included (a truncated body, an HTML error page), gives the *next
/// mirror* a turn.
pub async fn fetch_scheduled(date: &str) -> Result<(city::City, serde_json::Value)> {
    let bases = github_mirror::mirror_urls(&manifest_dir());
    fetch_from_mirrors(bases, &format!("{date}.json"), Gz::Prefer, |bytes, url| {
        let v: serde_json::Value =
            serde_json::from_slice(&bytes).map_err(|e| anyhow!("unusable schedule payload ({url}): {e}"))?;
        let city = scheduled_city(&v).map_err(|e| anyhow!("unusable schedule payload ({url}): {e}"))?;
        Ok((city, v))
    })
    .await
}

/// `fetch_scheduled` for a run that only caches the map (syncing off): the manifest
/// as published (gunzipped), with the city it names. The window reads the cache
/// file itself, so nothing here needs the payload as a `Value` — whose tens of MB
/// of JSON would take hundreds in memory. Parsed as `fetch_scheduled` parses it,
/// by a pass that keeps nothing of the map (`scheduled_city_in`).
pub async fn fetch_scheduled_raw(date: &str) -> Result<(city::City, Vec<u8>)> {
    let bases = github_mirror::mirror_urls(&manifest_dir());
    fetch_from_mirrors(bases, &format!("{date}.json"), Gz::Prefer, |bytes, url| {
        let city = scheduled_city_in(&bytes, url)?;
        Ok((city, bytes))
    })
    .await
}

/// `scheduled_city` on a manifest's bytes: the whole document parsed, but only its
/// city built — serde reads past the map data.
fn scheduled_city_in(bytes: &[u8], url: &str) -> Result<city::City> {
    #[derive(serde::Deserialize)]
    struct Manifest {
        city: city::City,
    }
    let m: Manifest =
        serde_json::from_slice(bytes).map_err(|e| anyhow!("unusable schedule payload ({url}): {e}"))?;
    Ok(m.city)
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
    // `osm-v2/city-list.json`: beside the manifest dir, not inside it.
    let layout = &github_mirror::table().schedule;
    let bases = match hosts {
        Hosts::Mirrored => github_mirror::mirror_urls(&layout.root),
        Hosts::GithubOnly => github_mirror::github_only_urls(&layout.root),
    };
    let v = fetch_from_mirrors(bases, &layout.state_file, Gz::Skip, |bytes, url| {
        serde_json::from_slice::<serde_json::Value>(&bytes)
            .map_err(|e| anyhow!("unusable schedule state ({url}): {e}"))
    })
    .await?;
    schedule_entry(&v, date)
}

/// The manifest's `city` envelope as a `City`.
fn scheduled_city(v: &serde_json::Value) -> Result<city::City> {
    let c = v.get("city").ok_or_else(|| anyhow!("schedule payload has no `city`"))?;
    Ok(serde_json::from_value(c.clone())?)
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

/// Fetch `{base}/{file}` from the first of `bases` that serves a payload
/// `validate` accepts. Shared by every published read — they differ only in the
/// host list, the file (`<date>.json` / `city-list.json`), whether a `.gz` sibling
/// (`<file>.gz`, as `gzip -k` names it) exists, and what "usable" means for that file.
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
///
/// `read` turns a response's (gunzipped) bytes into what the caller keeps, and
/// says no to a payload it can't use — the next URL then gets its turn.
async fn fetch_from_mirrors<T>(
    bases: Vec<String>,
    file: &str,
    gz: Gz,
    read: impl Fn(Vec<u8>, &str) -> Result<T>,
) -> Result<T> {
    let client = github_mirror::client()?;
    let mut last_err = None;
    for base in bases {
        let mut attempts: Vec<(String, bool)> = Vec::with_capacity(2);
        if gz == Gz::Prefer {
            attempts.push((format!("{base}/{file}.gz"), true));
        }
        attempts.push((format!("{base}/{file}"), false));
        for (url, gzipped) in attempts {
            let result = fetch_bytes(&client, &url, gzipped).await.and_then(|bytes| read(bytes, &url));
            match result {
                Ok(v) => return Ok(v),
                Err(e) => last_err = Some(e),
            }
        }
    }
    Err(last_err.unwrap_or_else(|| anyhow!("no CDN hosts configured")))
}

/// A response's body, gunzipped when it's a `.gz`.
async fn fetch_bytes(client: &reqwest::Client, url: &str, gzipped: bool) -> Result<Vec<u8>> {
    let res = client.get(url).send().await?;
    if !res.status().is_success() {
        return Err(anyhow!("CDN HTTP {} ({url})", res.status()));
    }
    let bytes = res.bytes().await?;
    if gzipped {
        gunzip(&bytes, url)
    } else {
        Ok(bytes.to_vec())
    }
}

fn gunzip(bytes: &[u8], url: &str) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    GzDecoder::new(bytes).read_to_end(&mut out).map_err(|e| anyhow!("gunzip failed ({url}): {e}"))?;
    Ok(out)
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
    fn gunzip_round_trips() {
        let compressed = gzip(br#"{"elements":[{"type":"way"}]}"#);
        let v: serde_json::Value = serde_json::from_slice(&gunzip(&compressed, "test://x").unwrap()).unwrap();
        assert_eq!(v["elements"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn gunzip_rejects_non_gzip_bytes() {
        let err = gunzip(b"not gzip data", "test://x").unwrap_err();
        assert!(err.to_string().contains("gunzip failed"));
    }

    /// A manifest the bytes path can't name a city from — no city, a half-written
    /// one, a body cut short — is refused, so the next mirror gets a turn.
    #[test]
    fn scheduled_city_in_needs_a_city() {
        let both = format!(r#"{{"elements":[{{"type":"way"}}],"city":{CITY}}}"#);
        assert_eq!(scheduled_city_in(both.as_bytes(), "test://x").unwrap().id, 2797656);
        assert!(scheduled_city_in(br#"{"elements":[{"type":"way"}]}"#, "test://x").is_err());
        assert!(scheduled_city_in(br#"{"city":{"lat":51.05,"lon":3.72}}"#, "test://x").is_err());
        assert!(scheduled_city_in(both[..both.len() - 1].as_bytes(), "test://x").is_err(), "cut short");
    }

    const CITY: &str = r#"{"id":2797656,"name":"Ghent","localName":"Gent",
        "country":"BE","lat":51.05,"lon":3.72,"population":231493}"#;

    // --- the schedule state file ---

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

    /// Every release reads these paths with its own copy of cdn.json compiled in, and
    /// CI publishes wherever the current copy says — so renaming one strands every
    /// version already out there (CLAUDE.md: a `data` path any release has read is
    /// frozen). Add a new path instead.
    #[test]
    fn the_published_layout_never_moves() {
        let layout = &github_mirror::table().schedule;
        assert_eq!(manifest_dir(), "osm-v2/data");
        assert_eq!(
            (layout.root.as_str(), layout.state_file.as_str()),
            ("osm-v2", "city-list.json")
        );
    }
}
