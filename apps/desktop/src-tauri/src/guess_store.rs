//! The desktop's storage for the guess-the-country game, plus the one rule of the
//! game the backend has to know.
//!
//! The game itself — its rules, its save-file format, stats — is written once in
//! `packages/core/src/guess` and shared with the website, which keeps the same JSON in
//! `localStorage`. On the desktop the frontend reads and writes that JSON through
//! `commands::guess_store_read` / `guess_store_write`, and this module just keeps it
//! on disk at `app_data_dir()/guess.json`. Treat the contents as the frontend's: the
//! format is defined by `packages/core/src/guess/store.ts`.
//!
//! The exception is whether *today's city has been revealed*. The wallpaper's city
//! caption may only appear once it has, and that's decided at render time — often
//! with no window open at all (midnight, a theme flip at sunset). So the backend
//! reads the two fields that decide it (`StoreView`) and applies `is_revealed`, a
//! mirror of `isRevealed(dayState(…))` in packages/core/src/guess/game.ts. Both are tested
//! against the same fixture, scripts/fixtures/guess-reveal-cases.json, so the two
//! readings can't drift apart.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use anyhow::{anyhow, Result};
use chrono::NaiveDate;
use serde::Deserialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::city::City;

const FILE: &str = "guess.json";

/// The `DayEnd` values packages/core/src/guess/types.ts defines. Any other `end` is ignored,
/// exactly as `parseGuessStore` ignores it.
const DAY_ENDS: [&str; 4] = ["won", "lost", "gaveUp", "skipped"];

/// What the backend reads of the save: the `showCityInfo` preference and which
/// days have ended. Parsed by hand from a `serde_json::Value` rather than derived so
/// it is exactly as forgiving as the frontend's parser — a malformed field reads as
/// its default instead of failing the whole file, and unknown fields are ignored.
#[derive(Debug, Default, PartialEq)]
pub struct StoreView {
    pub show_city_info: bool,
    /// The `YYYY-MM-DD` keys of the days that have a valid `end`.
    pub ended: HashSet<String>,
}

impl StoreView {
    /// `None` when `raw` isn't a JSON object at all — never a save.
    pub fn parse(raw: &str) -> Option<StoreView> {
        let v: Value = serde_json::from_str(raw).ok()?;
        let obj = v.as_object()?;
        let mut view = StoreView {
            show_city_info: obj.get("showCityInfo").and_then(Value::as_bool).unwrap_or(false),
            ended: HashSet::new(),
        };
        if let Some(days) = obj.get("days").and_then(Value::as_object) {
            for (date, rec) in days {
                let end = rec.as_object().and_then(|r| r.get("end")).and_then(Value::as_str);
                if end.is_some_and(|e| DAY_ENDS.contains(&e)) {
                    view.ended.insert(date.clone());
                }
            }
        }
        Some(view)
    }
}

/// Country code → English name, from the table the game uses
/// (packages/core/data/countries.json, bundled). The codes decide `is_revealed`'s
/// "unplayable country" rung; the names caption the wallpaper.
fn countries() -> &'static HashMap<String, String> {
    static COUNTRIES: OnceLock<HashMap<String, String>> = OnceLock::new();
    COUNTRIES.get_or_init(|| {
        #[derive(Deserialize)]
        struct Row {
            code: String,
            name: String,
        }
        let rows: Vec<Row> =
            serde_json::from_str(include_str!("../../../../packages/core/data/countries.json"))
                .expect("bundled countries.json invalid");
        rows.into_iter().map(|r| (r.code, r.name)).collect()
    })
}

/// The English name the wallpaper caption gives a country code.
pub fn country_name(code: &str) -> Option<&'static str> {
    countries().get(code).map(String::as_str)
}

/// Whether `today`'s city may be shown: the day has ended (won, lost, given up or
/// skipped), or the `showCityInfo` preference is on (the game switched off), or the
/// city's country isn't one the game can be played for. The mirror of
/// `isRevealed(dayState(…))` in packages/core/src/guess/game.ts — whose remaining states (no
/// city yet, map not showing yet, playing) are exactly the ones that reveal nothing,
/// which is why "is the map on the desktop yet" has no counterpart here.
pub fn is_revealed(view: &StoreView, today: NaiveDate, city: Option<&City>) -> bool {
    view.ended.contains(&today.to_string())
        || view.show_city_info
        || city.is_some_and(|c| !countries().contains_key(&c.country))
}

/// Whether `today` can be played right now — the frontend's `playing` state
/// (`dayState`), given whether today's map is on the desktop (`painted`): there's a
/// city to guess, its wallpaper is up, and nothing has revealed the day. Not merely
/// "not over yet": a day still resolving, or one whose wallpaper never landed,
/// isn't over either, but its game card has nothing to play.
pub fn is_playing(view: &StoreView, today: NaiveDate, city: Option<&City>, painted: bool) -> bool {
    city.is_some() && painted && !is_revealed(view, today, city)
}

/// Where the save lives: `app_data_dir()/guess.json`.
pub fn path(app: &AppHandle) -> Result<PathBuf> {
    Ok(app.path().app_data_dir()?.join(FILE))
}

/// The saved JSON, or `None` when there's none yet — see `read_at`.
pub fn read(app: &AppHandle) -> Result<Option<String>> {
    read_at(&path(app)?)
}

/// The view of whatever is saved, for seeding `AppState::guess_view` at launch.
/// Missing or unreadable reads as an empty save: nothing revealed by it.
pub fn load_view(app: &AppHandle) -> StoreView {
    read(app).ok().flatten().and_then(|raw| StoreView::parse(&raw)).unwrap_or_default()
}

/// Persist the frontend's serialized save, returning its view. Refuses anything that
/// isn't a JSON object, which no version of the save ever is.
pub fn write(app: &AppHandle, raw: &str) -> Result<StoreView> {
    let view = StoreView::parse(raw).ok_or_else(|| anyhow!("not a guess-game save"))?;
    write_at(&path(app)?, raw)?;
    Ok(view)
}

/// A file that can't be a save (not UTF-8, not a JSON object) is moved aside to
/// `guess.json.corrupt-<unix seconds>` and reads as `None`: the game then starts
/// over, and its first save would otherwise overwrite the only copy of the history.
/// An empty file is handed back as is — the frontend reads it as "nothing saved".
fn read_at(path: &Path) -> Result<Option<String>> {
    let bytes = match fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    if let Ok(raw) = String::from_utf8(bytes) {
        if raw.trim().is_empty() || StoreView::parse(&raw).is_some() {
            return Ok(Some(raw));
        }
    }
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let backup = path.with_file_name(format!("{FILE}.corrupt-{secs}"));
    log::warn!("[guess] {} is not a save; moving it to {}", path.display(), backup.display());
    fs::rename(path, &backup)?;
    Ok(None)
}

/// Write via a sibling temp file and a rename, so a crash mid-write leaves the old
/// save intact rather than half of a new one.
fn write_at(path: &Path, raw: &str) -> Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_file_name(format!("{FILE}.tmp"));
    fs::write(&tmp, raw)?;
    if let Err(e) = fs::rename(&tmp, path) {
        // Windows refuses to replace a file another process has open — an indexer
        // or antivirus scanner looking at it. Writing in place loses the atomicity
        // but keeps the guess, which is the point.
        log::warn!("[guess] replacing {} failed ({e}); writing in place", path.display());
        let _ = fs::remove_file(&tmp);
        fs::write(path, raw)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("inkcity-guess-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The same cases scripts/guess-test.ts runs through the frontend's
    /// `isRevealed(dayState(…))`: if either reading of the save changes, one of the
    /// two test suites fails.
    #[test]
    fn is_revealed_matches_the_shared_fixture() {
        #[derive(Deserialize)]
        struct FixtureCity {
            id: u64,
            country: String,
            lat: f64,
            lon: f64,
        }
        #[derive(Deserialize)]
        struct Case {
            name: String,
            store: Value,
            city: Option<FixtureCity>,
            revealed: bool,
        }
        #[derive(Deserialize)]
        struct Fixture {
            date: NaiveDate,
            cases: Vec<Case>,
        }
        let fixture: Fixture = serde_json::from_str(include_str!(
            "../../../../scripts/fixtures/guess-reveal-cases.json"
        ))
        .unwrap();
        assert!(!fixture.cases.is_empty());
        for case in fixture.cases {
            let view = if case.store.is_null() {
                StoreView::default()
            } else {
                StoreView::parse(&case.store.to_string()).unwrap_or_default()
            };
            let city = case.city.map(|c| City {
                id: c.id,
                name: String::new(),
                local_name: String::new(),
                country: c.country,
                lat: c.lat,
                lon: c.lon,
                population: 0,
            });
            assert_eq!(
                is_revealed(&view, fixture.date, city.as_ref()),
                case.revealed,
                "fixture case: {}",
                case.name
            );
            // `playing` is what's left once nothing reveals the day, there's a city,
            // and its map is up (the frontend's `ready`).
            assert_eq!(
                is_playing(&view, fixture.date, city.as_ref(), true),
                !case.revealed && city.is_some(),
                "fixture case (painted): {}",
                case.name
            );
            assert!(
                !is_playing(&view, fixture.date, city.as_ref(), false),
                "fixture case (not painted): {}",
                case.name
            );
        }
    }

    #[test]
    fn view_reads_only_valid_ends_and_tolerates_junk() {
        let view = StoreView::parse(
            r#"{"v":1,"showCityInfo":true,"future":1,"days":{
                "2026-10-15":{"guesses":"bad","end":"won"},
                "2026-10-16":{"end":"victory"},
                "2026-10-17":"won"}}"#,
        )
        .unwrap();
        assert!(view.show_city_info);
        assert_eq!(view.ended, HashSet::from(["2026-10-15".to_string()]));
        assert!(StoreView::parse("[1]").is_none());
        assert!(StoreView::parse("nope").is_none());
        assert_eq!(StoreView::parse("{}"), Some(StoreView::default()));
    }

    #[test]
    fn country_names_come_from_the_bundled_table() {
        assert_eq!(country_name("FR"), Some("France"));
        assert_eq!(country_name("HK"), Some("Hong Kong"));
        assert_eq!(country_name("ZZ"), None);
    }

    #[test]
    fn write_then_read_round_trips_and_leaves_no_temp_file() {
        let dir = scratch("rw");
        let path = dir.join(FILE);
        assert_eq!(read_at(&path).unwrap(), None, "nothing saved yet");
        write_at(&path, r#"{"v":1,"showCityInfo":false,"days":{}}"#).unwrap();
        write_at(&path, r#"{"v":1,"showCityInfo":true,"days":{}}"#).unwrap();
        assert_eq!(
            read_at(&path).unwrap().as_deref(),
            Some(r#"{"v":1,"showCityInfo":true,"days":{}}"#)
        );
        assert!(!dir.join(format!("{FILE}.tmp")).exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_corrupt_save_is_moved_aside_not_returned() {
        let dir = scratch("corrupt");
        let path = dir.join(FILE);
        fs::write(&path, "{half a save").unwrap();
        assert_eq!(read_at(&path).unwrap(), None);
        assert!(!path.exists(), "the corrupt file must not be left where the next save lands");
        let backups: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with("guess.json.corrupt-"))
            .collect();
        assert_eq!(backups.len(), 1);
        assert_eq!(fs::read_to_string(backups[0].path()).unwrap(), "{half a save");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_empty_file_reads_as_empty_not_corrupt() {
        let dir = scratch("empty");
        let path = dir.join(FILE);
        fs::write(&path, "").unwrap();
        assert_eq!(read_at(&path).unwrap().as_deref(), Some(""));
        assert!(path.exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
