//! The bundled city list. Its one job is the City tab's "Customized" name lookup
//! (issue #11) — `search` below — plus `today()`, the app's single definition of
//! the current date.
//!
//! The list is the schedule's own pool: every `packages/core/data/cities-*.json`, merged
//! the way CI merges them, so any city that can come up as the daily one can be
//! found by name too, under the same native-script `localName`. It is compiled
//! in and nothing else: releases up to v0.13.0 searched `src/data/cities.json`
//! instead and re-downloaded it daily from `main` (`cities_update`, removed),
//! which CLAUDE.md's "Files clients fetch at runtime" now rules out.
//!
//! The list used to also *be* the daily city: a `(days * 379) % N` permutation
//! over the population-sorted cities.json, computed offline and mirrored in
//! `packages/core/src/city.ts`. That rotation is gone from the client. The daily city now
//! comes from the CI-authored schedule and nothing else, with
//! `osm-v2/city-list.json` as its own last rung (see `pipeline::resolve_daily`
//! and docs/random-city-strategy.md) — so no local formula can name a day the
//! schedule didn't, and none tries to.

use std::collections::HashMap;
use std::fs;
use std::sync::OnceLock;

use chrono::{Local, NaiveDate};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use unicode_normalization::UnicodeNormalization;

/// The schedule's pools in the order CI merges them (scripts/osm-cli.ts reads
/// `packages/core/data/cities-*.json` sorted by name), named so a test can check that a
/// pool added there isn't missing here.
const POOLS: [(&str, &str); 2] = [
    ("cities-countries.json", include_str!("../../packages/core/data/cities-countries.json")),
    ("cities-famous.json", include_str!("../../packages/core/data/cities-famous.json")),
];

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct City {
    pub id: u64,
    pub name: String,
    #[serde(rename = "localName")]
    pub local_name: String,
    pub country: String,
    pub lat: f64,
    pub lon: f64,
    pub population: u64,
}

/// A city with its search keys folded once up front (`fold`), so a keystroke
/// compares strings and allocates nothing but the result.
struct Indexed {
    city: City,
    /// `fold` of `name` and `localName`, plus their German-style spellings where
    /// those differ ("duesseldorf"), deduplicated.
    keys: Vec<String>,
}

fn index(cities: Vec<City>) -> Vec<Indexed> {
    cities
        .into_iter()
        .map(|city| {
            let mut keys: Vec<String> = Vec::with_capacity(2);
            for text in [&city.name, &city.local_name] {
                for german in [false, true] {
                    let key = fold(text, german);
                    if !keys.contains(&key) {
                        keys.push(key);
                    }
                }
            }
            Indexed { city, keys }
        })
        .collect()
}

/// The merged pool, parsed and indexed on the first search — about a thousand
/// entries, so a millisecond or two that only someone typing into the
/// Customized box pays.
fn cities() -> &'static [Indexed] {
    static CITIES: OnceLock<Vec<Indexed>> = OnceLock::new();
    CITIES.get_or_init(|| {
        index(merge_pools(POOLS.iter().map(|(_, json)| {
            serde_json::from_str::<Vec<City>>(json).expect("bundled city pool invalid")
        })))
    })
}

/// Lowercase `text` and fold away what an ASCII keyboard can't type, so "sao
/// paulo" finds São Paulo, "lodz" Łódź and "izmir" İzmir: accents (decomposed,
/// then the combining diacritics U+0300–U+036F dropped), the Latin letters that
/// have no decomposition (ł, ı, ø, ß, …), and apostrophes and ʻokinas.
///
/// Only that one block of marks goes, so scripts whose vowel signs or voicing
/// marks are combining characters of their own (Devanagari, Arabic, kana) keep
/// them. `german` spells ä/ö/ü as ae/oe/ue instead — the ASCII spelling the
/// old search index used for Düsseldorf, Köln and Ürümqi.
fn fold(text: &str, german: bool) -> String {
    let mut out = String::with_capacity(text.len());
    let mut prev = '\0';
    for c in text.to_lowercase().nfkd() {
        match c {
            '\u{0308}' if german && matches!(prev, 'a' | 'o' | 'u') => out.push('e'),
            '\u{0300}'..='\u{036f}' => {}
            '\'' | '\u{2019}' | '\u{02bb}' | '\u{02bc}' => {}
            'ł' => out.push('l'),
            'ı' => out.push('i'),
            'đ' | 'ð' => out.push('d'),
            'ø' => out.push('o'),
            'ħ' => out.push('h'),
            'ŧ' => out.push('t'),
            'ə' => out.push('e'),
            'ß' => out.push_str("ss"),
            'æ' => out.push_str("ae"),
            'œ' => out.push_str("oe"),
            'þ' => out.push_str("th"),
            _ => out.push(c),
        }
        prev = c;
    }
    out
}

/// `mergePools` (packages/core/src/schedule.ts) in Rust: one entry per id, with a later
/// pool's entry replacing an earlier one in place. Fed the same files in the same
/// order, it yields exactly the cities the schedule draws from, under the same
/// names — the pools share 221 cities and spell some of them differently
/// (Bogotá/Bogota).
fn merge_pools(pools: impl IntoIterator<Item = Vec<City>>) -> Vec<City> {
    let mut merged: Vec<City> = Vec::new();
    let mut index: HashMap<u64, usize> = HashMap::new();
    for pool in pools {
        for city in pool {
            match index.get(&city.id) {
                Some(&i) => merged[i] = city,
                None => {
                    index.insert(city.id, merged.len());
                    merged.push(city);
                }
            }
        }
    }
    merged
}

/// Delete the hot-updated `cities.json` (and its ETag file) that releases up to
/// v0.13.0 kept in `app_data_dir`. Nothing reads them any more. Best effort,
/// once per launch; a file already gone is the normal case.
pub fn remove_retired_cache(app: &AppHandle) {
    let Ok(dir) = app.path().app_data_dir() else { return };
    for name in ["cities.json", "cities.meta.json"] {
        match fs::remove_file(dir.join(name)) {
            Ok(()) => log::info!("[city] removed the retired {name}"),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => log::warn!("[city] could not remove the retired {name}: {e}"),
        }
    }
}

pub fn today() -> NaiveDate {
    let today = Local::now().date_naive();
    #[cfg(debug_assertions)]
    if let Some(days) = dev_day_offset() {
        return today + chrono::Duration::days(days);
    }
    today
}

/// Dev builds only: `INKCITY_DAY_OFFSET=<n> pnpm tauri dev` makes the whole app
/// believe today is `n` days from now — the schedule, the caches, `Status.date` and
/// with it the guess-the-country game all follow `today()`. For testing what only
/// happens across days (the midnight rollover, streaks, the game resuming after
/// the "Daily guess" switch is turned back on) without touching the system clock. The CDN
/// publishes about a week of days ahead, so offsets of 0–6 resolve to scheduled
/// cities; beyond that a day can't be named. Read once; compiled out of release
/// builds entirely.
#[cfg(debug_assertions)]
fn dev_day_offset() -> Option<i64> {
    static OFFSET: OnceLock<Option<i64>> = OnceLock::new();
    *OFFSET.get_or_init(|| {
        let raw = std::env::var("INKCITY_DAY_OFFSET").ok()?;
        match raw.trim().parse::<i64>() {
            Ok(days) => {
                log::warn!("[city] INKCITY_DAY_OFFSET: pretending today is {days} day(s) away");
                Some(days)
            }
            Err(_) => {
                log::warn!(
                    "[city] ignoring INKCITY_DAY_OFFSET={raw:?}: not a whole number of days"
                );
                None
            }
        }
    })
}

/// Cities whose `name`, `localName` or country code matches `query`, best first,
/// capped at `limit`. Backs the City tab's "Customized" name lookup (issue #11):
/// the list is already in memory here, so searching it costs nothing and keeps
/// the whole pool out of the frontend bundle.
///
/// Ranking is prefix-before-substring, then by population descending, so typing
/// "san" surfaces San Antonio/San Diego ahead of Santiago de los Caballeros and
/// never buries a big city under a small one that merely matched earlier in the
/// file. Query and names are compared through `fold`, which is case- and
/// accent-insensitive and leaves non-Latin scripts intact, so a CJK/Cyrillic
/// query finds its city's `localName` too.
pub fn search(query: &str, limit: usize) -> Vec<City> {
    search_in(cities(), query, limit)
}

/// `search` over a given index, so the ranking is testable without the bundled
/// pool.
fn search_in(cities: &[Indexed], query: &str, limit: usize) -> Vec<City> {
    let q = fold(query.trim(), false);
    if q.is_empty() {
        return Vec::new();
    }
    let mut hits: Vec<(u8, u64, &City)> = Vec::new();
    for Indexed { city: c, keys } in cities {
        let rank = if keys.iter().any(|k| k.starts_with(&q)) {
            0
        } else if keys.iter().any(|k| k.contains(&q)) {
            1
        } else if c.country.eq_ignore_ascii_case(&q) {
            2
        } else {
            continue;
        };
        hits.push((rank, c.population, c));
    }
    // Descending population within a rank: `sort_by_key` is ascending, so the
    // population is negated via `Reverse`.
    hits.sort_by_key(|(rank, pop, _)| (*rank, std::cmp::Reverse(*pop)));
    hits.into_iter().take(limit).map(|(_, _, c)| c.clone()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn city(id: u64, name: &str, local: &str, country: &str, population: u64) -> City {
        City {
            id,
            name: name.into(),
            local_name: local.into(),
            country: country.into(),
            lat: 0.0,
            lon: 0.0,
            population,
        }
    }

    fn sample() -> Vec<Indexed> {
        index(vec![
            city(1, "Santiago de los Caballeros", "Santiago", "DO", 550_753),
            city(2, "San Antonio", "San Antonio", "US", 1_469_845),
            city(3, "San Diego", "San Diego", "US", 1_394_928),
            city(4, "Shenzhen", "深圳", "CN", 17_494_398),
            city(5, "Busan", "부산", "KR", 3_678_555),
            city(6, "Düsseldorf", "Düsseldorf", "DE", 631_217),
            city(7, "İzmir", "İzmir", "TR", 4_493_242),
            city(8, "Łódź", "Łódź", "PL", 648_711),
        ])
    }

    // Busan is the point of this one: it's far bigger than Santiago yet must still
    // rank last, because a prefix match beats a substring match regardless of size.
    #[test]
    fn search_ranks_prefixes_above_substrings_then_by_population() {
        let names: Vec<String> =
            search_in(&sample(), "san", 10).into_iter().map(|c| c.name).collect();
        assert_eq!(
            names,
            [
                "San Antonio",                // prefix, biggest
                "San Diego",                  // prefix
                "Santiago de los Caballeros", // prefix, smallest
                "Busan",                      // substring ("buSAN")
            ]
        );
    }

    #[test]
    fn search_matches_local_name_and_country_code() {
        assert_eq!(search_in(&sample(), "深圳", 5).first().map(|c| c.id), Some(4));
        assert_eq!(search_in(&sample(), "cn", 5).first().map(|c| c.id), Some(4));
    }

    #[test]
    fn search_folds_accents_and_letters_ascii_cannot_type() {
        for (query, id) in [
            ("dusseldorf", 6),
            ("duesseldorf", 6),
            ("DÜSSELDORF", 6),
            ("izmir", 7),
            ("İzmir", 7),
            ("lodz", 8),
            ("Łódź", 8),
        ] {
            assert_eq!(search_in(&sample(), query, 5).first().map(|c| c.id), Some(id), "{query}");
        }
    }

    #[test]
    fn search_is_empty_for_blank_input_and_respects_the_limit() {
        assert!(search_in(&sample(), "   ", 5).is_empty());
        assert_eq!(search_in(&sample(), "san", 2).len(), 2);
    }

    // Same rule as `mergePools`: the later pool's entry wins, but keeps the place
    // the id first took, so the merged order doesn't depend on which pool won.
    #[test]
    fn merge_pools_keeps_one_entry_per_id_and_the_later_pool_wins() {
        let first = vec![city(1, "Bogota", "x", "XX", 1), city(2, "Quito", "x", "XX", 1)];
        let second = vec![city(3, "Lima", "x", "XX", 1), city(1, "Bogotá", "x", "XX", 1)];
        let names: Vec<String> = merge_pools([first, second]).into_iter().map(|c| c.name).collect();
        assert_eq!(names, ["Bogotá", "Quito", "Lima"]);
    }

    /// CI draws the daily city from every `packages/core/data/cities-*.json` it finds; the
    /// search can only include the ones named in `POOLS`. A pool added on one side
    /// alone would make some daily cities unsearchable, so compare the two lists,
    /// in CI's (sorted) order — which is also the order `merge_pools` needs.
    #[test]
    fn the_bundled_pools_are_every_schedule_pool() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../packages/core/data");
        let mut on_disk: Vec<String> = fs::read_dir(&dir)
            .expect("packages/core/data is readable")
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with("cities-") && name.ends_with(".json"))
            .collect();
        on_disk.sort();
        let bundled: Vec<&str> = POOLS.iter().map(|(name, _)| *name).collect();
        assert_eq!(on_disk, bundled);
    }

    #[test]
    fn the_bundled_index_finds_cities_by_native_and_latin_names() {
        for (query, name) in [
            ("北京", "Beijing"),
            ("Москва", "Moscow"),
            ("beij", "Beijing"),
            ("sao paulo", "São Paulo"),
            ("bogota", "Bogotá"),
            ("krakow", "Kraków"),
            ("ueruemqi", "Ürümqi"),
            ("diyarbakir", "Diyarbakır"),
        ] {
            assert_eq!(search(query, 5).first().map(|c| c.name.as_str()), Some(name), "{query}");
        }
    }
}
