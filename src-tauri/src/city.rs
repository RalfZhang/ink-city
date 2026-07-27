use std::fs;
use std::sync::OnceLock;

use chrono::{Local, NaiveDate};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const BUNDLED_CITIES: &str = include_str!("../../src/data/cities.json");
const CACHE_FILE: &str = "cities.json";
const EPOCH: (i32, u32, u32) = (2023, 3, 3);
/// Day-to-city index uses `(days * MULTIPLIER) % N`. A prime coprime to N
/// makes this a permutation of 0..N-1, so cities.json can stay sorted by
/// population while the daily sequence still feels random and never repeats
/// within an N-day cycle. 379 is prime, so it stays coprime to most N as the
/// list grows.
///
/// MUST stay equivalent to the TS port in `src/core/city.ts` (the website / CI
/// pick the same city there); if they diverge the website shows a different
/// city than the user's wallpaper.
///
/// Since issue #1 this rotation is the *fallback*, not the daily city: the
/// wallpaper prefers the CI-authored schedule manifest, which no formula can
/// reproduce (see `docs/random-city-strategy.md`). So in-process, nothing but
/// `pipeline::resolve_city_and_osm` may call `pick_for_date` — everything else
/// goes through `pipeline::city_for_status` to get the city actually rendered.
/// The website still recomputes it and will name the rotation city until it
/// reads the manifests too.
const MULTIPLIER: i64 = 379;

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

static CITIES: OnceLock<Vec<City>> = OnceLock::new();

/// Load the cities list once at startup. Prefers the hot-updatable cache file
/// in `app_data_dir`; falls back to the bundled JSON if missing/corrupt/empty.
/// Subsequent remote updates land in the cache but only take effect on the
/// next launch — avoiding mid-session city switches.
pub fn initialize(app: &AppHandle) {
    let cities = load_from_cache_or_bundled(app);
    let _ = CITIES.set(cities);
}

fn load_from_cache_or_bundled(app: &AppHandle) -> Vec<City> {
    if let Some(cities) = load_from_cache(app) {
        log::info!("[city] loaded {} cities from cache", cities.len());
        return cities;
    }
    log::info!("[city] using bundled cities list");
    serde_json::from_str(BUNDLED_CITIES).expect("bundled cities.json invalid")
}

fn load_from_cache(app: &AppHandle) -> Option<Vec<City>> {
    let dir = app.path().app_data_dir().ok()?;
    let path = dir.join(CACHE_FILE);
    let s = fs::read_to_string(&path).ok()?;
    let cities: Vec<City> = serde_json::from_str(&s).ok()?;
    if cities.len() < 100 {
        return None; // sanity floor: don't trust a tiny list
    }
    Some(cities)
}

fn cities() -> &'static [City] {
    CITIES.get().expect("city::initialize must run before pick_for_date")
}

pub fn pick_for_date(date: NaiveDate) -> City {
    let all = cities();
    let epoch = NaiveDate::from_ymd_opt(EPOCH.0, EPOCH.1, EPOCH.2).unwrap();
    let days = (date - epoch).num_days();
    let n = all.len() as i64;
    let raw = ((days % n) + n) % n;
    let idx = (raw * MULTIPLIER) % n;
    all[idx as usize].clone()
}

pub fn today() -> NaiveDate {
    Local::now().date_naive()
}

/// Cities whose `name`, `localName` or country code matches `query`, best first,
/// capped at `limit`. Backs the City tab's "Customized" name lookup (issue #11):
/// the list is already in memory here, so searching it costs nothing and keeps
/// ~1000 cities out of the frontend bundle.
///
/// Ranking is prefix-before-substring, then by population descending, so typing
/// "san" surfaces San Antonio/San Diego ahead of Santiago de los Caballeros and
/// never buries a big city under a small one that merely matched earlier in the
/// file. Matching is ASCII-case-insensitive; `localName` is matched verbatim so
/// a CJK/Cyrillic query finds its city too.
pub fn search(query: &str, limit: usize) -> Vec<City> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Vec::new();
    }
    let mut hits: Vec<(u8, u64, &City)> = Vec::new();
    for c in cities() {
        let name = c.name.to_lowercase();
        let local = c.local_name.to_lowercase();
        let rank = if name.starts_with(&q) || local.starts_with(&q) {
            0
        } else if name.contains(&q) || local.contains(&q) {
            1
        } else if c.country.to_lowercase() == q {
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

    /// `search` reads the process-wide `CITIES`, which `initialize` can only fill
    /// from an `AppHandle`. Seed it directly so the ranking is testable headless;
    /// `OnceLock::set` is idempotent-safe here because these tests are the only
    /// writer in the test binary.
    fn seed() {
        let _ = CITIES.set(vec![
            city(1, "Santiago de los Caballeros", "Santiago", "DO", 550_753),
            city(2, "San Antonio", "San Antonio", "US", 1_469_845),
            city(3, "San Diego", "San Diego", "US", 1_394_928),
            city(4, "Shenzhen", "深圳", "CN", 17_494_398),
            city(5, "Busan", "부산", "KR", 3_678_555),
        ]);
    }

    // Busan is the point of this one: it's far bigger than Santiago yet must still
    // rank last, because a prefix match beats a substring match regardless of size.
    #[test]
    fn search_ranks_prefixes_above_substrings_then_by_population() {
        seed();
        let names: Vec<String> = search("san", 10).into_iter().map(|c| c.name).collect();
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
        seed();
        assert_eq!(search("深圳", 5).first().map(|c| c.id), Some(4));
        assert_eq!(search("cn", 5).first().map(|c| c.id), Some(4));
    }

    #[test]
    fn search_is_empty_for_blank_input_and_respects_the_limit() {
        seed();
        assert!(search("   ", 5).is_empty());
        assert_eq!(search("san", 2).len(), 2);
    }
}
