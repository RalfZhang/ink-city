use std::fs;
use std::path::PathBuf;

use anyhow::Result;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ThemeMode {
    Light,
    Dark,
    System,
}

impl Default for ThemeMode {
    fn default() -> Self {
        ThemeMode::System
    }
}

/// How the wallpaper is refreshed — the "How to update?" selector in the City
/// tab. `Daily` rotates through the city list at midnight (the classic
/// behavior); `Customized` pins the wallpaper to a user-entered location and
/// never rotates; `Disable` turns automatic updates off entirely (the wallpaper
/// stays whatever it currently is).
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum UpdateMode {
    Disable,
    Daily,
    Customized,
}

impl Default for UpdateMode {
    fn default() -> Self {
        UpdateMode::Daily
    }
}

/// A user-pinned location for `UpdateMode::Customized` (issue #11). No GeoNames
/// id — arbitrary coordinates are never precached, so the map is always fetched
/// live via the osm-cli sidecar (honoring the proxy for mainland-China users).
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
pub struct CustomCity {
    pub lat: f64,
    pub lon: f64,
}

/// How often the background scheduler checks GitHub for a new release.
/// `Never` disables automatic checks entirely (the user can still check
/// manually from the About tab).
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum UpdateCheck {
    Daily,
    Weekly,
    Monthly,
    Never,
}

impl Default for UpdateCheck {
    fn default() -> Self {
        UpdateCheck::Daily
    }
}

impl UpdateCheck {
    /// Minimum days between automatic checks, or `None` when disabled.
    pub fn interval_days(self) -> Option<i64> {
        match self {
            UpdateCheck::Daily => Some(1),
            UpdateCheck::Weekly => Some(7),
            UpdateCheck::Monthly => Some(30),
            UpdateCheck::Never => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum StylePreset {
    Minimal,
    Standard,
    Bold,
}

impl Default for StylePreset {
    fn default() -> Self {
        StylePreset::Standard
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ColorPair {
    pub background: String,
    pub foreground: String,
}

impl ColorPair {
    pub fn light_default() -> Self {
        Self { background: "#eee8d6".into(), foreground: "#2d2d2d".into() }
    }
    pub fn dark_default() -> Self {
        Self { background: "#000000".into(), foreground: "#5e5d58".into() }
    }
}

/// Persisted user settings. The container-level `#[serde(default)]` fills any
/// field absent from `config.json` from `Config::default()` below, so every
/// default lives in exactly one place — the `Default` impl — with no per-field
/// serde mirror to keep in sync.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    /// How the wallpaper is refreshed (see `UpdateMode`). Replaces the old
    /// `enabled: bool`; legacy configs are migrated in `load`.
    pub update_mode: UpdateMode,
    /// The pinned location for `UpdateMode::Customized`, or `None` until the user
    /// applies one. Kept even while the mode isn't `Customized` so switching back
    /// restores the last location.
    pub custom: Option<CustomCity>,
    pub hide_tray: bool,
    pub theme: ThemeMode,
    pub light: ColorPair,
    pub dark: ColorPair,
    pub style: StylePreset,
    pub update_check: UpdateCheck,
    /// Download and install detected updates automatically (on the `update_check`
    /// cadence), then relaunch — no confirmation. On by default; meaningless when
    /// `update_check` is `Never` (no automatic checks fire), so it's forced off in
    /// that case (see `set_update_check`).
    pub auto_update: bool,
    /// Draw the water layer on the wallpaper. Off by default; only surfaced in
    /// the UI when the current city's data actually has water.
    pub show_water: bool,
    /// Draw the airport layer (runways + aprons) on the wallpaper. Off by
    /// default; only surfaced in the UI when the current city's data actually
    /// has an airport.
    pub show_airports: bool,
    /// Draw the railway layer (surface rail centerlines) on the wallpaper. Off
    /// by default.
    pub show_railways: bool,
    /// Draw the aerialway layer (cable cars / ropeways) on the wallpaper. Off by
    /// default.
    pub show_aerialways: bool,
    /// Whether the hidden Dev Mode tab is unlocked. Off by default; toggled by
    /// the 7-click gesture on the version number in About. Persisted so the tab
    /// stays unlocked across restarts. (The dev-only "bypass cache & CDN" toggle
    /// inside that tab is a separate, deliberately in-memory-only flag — see
    /// `AppState::bypass_cache`.)
    pub dev_mode: bool,
    /// Route network requests (CDN/GitHub via reqwest, and the osm-cli sidecar's
    /// live Overpass fetch) through a proxy. Off by default. For regions where
    /// OpenStreetMap/Overpass is unreachable directly.
    pub proxy_enabled: bool,
    /// Proxy URL, e.g. `http://127.0.0.1:7890` or `socks5://127.0.0.1:1080`.
    /// Only used when `proxy_enabled`.
    pub proxy_url: String,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            update_mode: UpdateMode::default(),
            custom: None,
            hide_tray: false,
            theme: ThemeMode::default(),
            light: ColorPair::light_default(),
            dark: ColorPair::dark_default(),
            style: StylePreset::default(),
            update_check: UpdateCheck::default(),
            auto_update: true,
            show_water: false,
            show_airports: false,
            show_railways: false,
            show_aerialways: false,
            dev_mode: false,
            proxy_enabled: false,
            proxy_url: String::new(),
        }
    }
}

fn config_path(app: &AppHandle) -> Result<PathBuf> {
    let dir = app.path().app_config_dir()?;
    fs::create_dir_all(&dir)?;
    Ok(dir.join("config.json"))
}

/// Path to the first-run sentinel — an empty marker file whose presence means
/// the app has completed its one-time first-launch setup.
fn marker_path(app: &AppHandle) -> Result<PathBuf> {
    let dir = app.path().app_config_dir()?;
    fs::create_dir_all(&dir)?;
    Ok(dir.join(".initialized"))
}

/// Whether this is the very first launch of a fresh install. Deliberately keyed
/// off a dedicated sentinel rather than `config.json` so that running first-run
/// setup never writes `config.json`: users who never touch a setting keep no
/// config file and so still pick up future changes to `Config::default()`.
pub fn is_first_run(app: &AppHandle) -> bool {
    marker_path(app).map(|p| !p.exists()).unwrap_or(false)
}

/// Record that first-run setup has completed, so it runs exactly once.
pub fn mark_initialized(app: &AppHandle) -> Result<()> {
    fs::write(marker_path(app)?, b"")?;
    Ok(())
}

pub fn load(app: &AppHandle) -> Config {
    let Ok(path) = config_path(app) else { return Config::default() };
    let Ok(raw) = fs::read_to_string(&path) else { return Config::default() };
    parse_config(&raw)
}

/// Parse persisted config JSON, migrating the legacy `enabled: bool` field to
/// the tri-state `update_mode` when the latter is absent — so a user who had
/// daily updates switched *off* stays on `Disable` after upgrading instead of
/// silently reverting to the `Daily` default (and `enabled: true` maps to
/// `Daily`). A config already on the new schema is left untouched. Unparseable
/// or empty input falls back to `Config::default()` (⇒ `Daily`, the new-user
/// default). Pure (no IO) so it's unit-testable — see the tests below.
fn parse_config(raw: &str) -> Config {
    let Ok(mut v) = serde_json::from_str::<serde_json::Value>(raw) else {
        return Config::default();
    };
    if let Some(obj) = v.as_object_mut() {
        if !obj.contains_key("update_mode") {
            if let Some(enabled) = obj.get("enabled").and_then(|e| e.as_bool()) {
                let mode = if enabled { "daily" } else { "disable" };
                obj.insert("update_mode".into(), serde_json::Value::String(mode.into()));
            }
        }
    }
    serde_json::from_value(v).unwrap_or_default()
}

pub fn save(app: &AppHandle, cfg: &Config) -> Result<()> {
    let path = config_path(app)?;
    fs::write(path, serde_json::to_string_pretty(cfg)?)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrates_legacy_enabled_false_to_disable() {
        assert_eq!(parse_config(r#"{"enabled": false}"#).update_mode, UpdateMode::Disable);
    }

    #[test]
    fn migrates_legacy_enabled_true_to_daily() {
        assert_eq!(parse_config(r#"{"enabled": true}"#).update_mode, UpdateMode::Daily);
    }

    #[test]
    fn explicit_update_mode_wins_over_a_lingering_enabled() {
        let cfg = parse_config(r#"{"update_mode":"customized","enabled":false}"#);
        assert_eq!(cfg.update_mode, UpdateMode::Customized);
    }

    #[test]
    fn new_or_unparseable_config_defaults_to_daily() {
        // New install (no config file → "{}") and any corrupt file both land on
        // the Daily default — so a fresh user opens the app already on Daily.
        assert_eq!(parse_config("{}").update_mode, UpdateMode::Daily);
        assert_eq!(parse_config("not json").update_mode, UpdateMode::Daily);
        assert_eq!(Config::default().update_mode, UpdateMode::Daily);
    }

    #[test]
    fn custom_pin_round_trips() {
        let cfg =
            parse_config(r#"{"update_mode":"customized","custom":{"lat":-16.5,"lon":-68.17}}"#);
        assert_eq!(cfg.update_mode, UpdateMode::Customized);
        assert_eq!(cfg.custom, Some(CustomCity { lat: -16.5, lon: -68.17 }));
    }
}
