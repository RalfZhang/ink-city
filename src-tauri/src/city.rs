use chrono::{NaiveDate, Utc};
use serde::{Deserialize, Serialize};

const CITIES_JSON: &str = include_str!("../../src/data/cities.json");
const EPOCH: (i32, u32, u32) = (2023, 3, 3);

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

pub fn all_cities() -> Vec<City> {
    serde_json::from_str(CITIES_JSON).expect("cities.json invalid")
}

pub fn pick_for_date(date: NaiveDate) -> City {
    let cities = all_cities();
    let epoch = NaiveDate::from_ymd_opt(EPOCH.0, EPOCH.1, EPOCH.2).unwrap();
    let days = (date - epoch).num_days();
    let n = cities.len() as i64;
    let idx = ((days % n) + n) % n;
    cities.into_iter().nth(idx as usize).unwrap()
}

pub fn today() -> NaiveDate {
    Utc::now().date_naive()
}
