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
