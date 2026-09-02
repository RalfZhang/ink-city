use std::fs;
use std::path::PathBuf;

use anyhow::Result;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ThemeMode {
    Light,
    Dark,
    #[default]
    System,
}

/// How the wallpaper is refreshed — the "How to update?" selector in the City
/// tab. `Daily` rotates through the city list at midnight (the classic
/// behavior); `Customized` pins the wallpaper to a user-entered location and
/// never rotates; `Disable` turns automatic updates off entirely (the wallpaper
/// stays whatever it currently is).
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum UpdateMode {
    Disable,
    #[default]
    Daily,
    Customized,
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
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum UpdateCheck {
    #[default]
    Daily,
    Weekly,
    Monthly,
    Never,
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

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum StylePreset {
    Minimal,
    #[default]
    Standard,
    Bold,
}

/// Which visual language the map is drawn in — one dimension rather than a set
/// of independent flags, so exactly one variant is ever in effect and a second
/// art style is a new arm here instead of another boolean that can contradict
/// this one. `Ink` is the default ink-on-paper map in the theme's colors;
/// `Mondrian` is the De Stijl repaint of the same real street grid (issue #18).
/// Mirrors `StyleVariant` in src/core/types.ts and is serialized straight into
/// the renderer's `Style` payload.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum StyleVariant {
    #[default]
    Ink,
    Mondrian,
}

/// How the railway layer is drawn — the Lab-tab selector. One dimension rather
/// than a `show_railways` boolean plus a separate style field, so "hidden" and
/// "which symbol" can never contradict each other. `Off` by default, like every
/// other optional layer. Mirrors `RailwayStyle` in src/core/types.ts and is
/// serialized straight into the renderer's `Style` payload; the drawable modes are
/// dispatched through `RAILWAY_MODES` in src/core/render.ts, where each one's
/// weights and opacity live too.
///
/// Replaces the legacy `show_railways: bool`, which `parse_config` migrates.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RailwayStyle {
    #[default]
    Off,
    Plain,
    Banded,
    Ties,
}

/// Which map service the City tab's map button opens. Mirrors `MAP_PROVIDERS` in
/// src/core/constants.ts, which holds each service's label key and URL template.
///
/// `Osm` by default.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MapProvider {
    #[default]
    Osm,
    Here,
    Google,
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
    /// The optional data layers, all off by default. Each is offered
    /// unconditionally in the Lab tab — a city whose data lacks the layer simply
    /// renders nothing for it, so nothing probes the payload first.
    pub show_water: bool,
    /// Runways + taxiways, as centerlines or areas (no aprons — see core/osm/airports.ts).
    pub show_airports: bool,
    /// Surface rail centerlines, and which symbol they're drawn in (see
    /// `RailwayStyle`). Not a `show_*` bool like its neighbours because the user
    /// picks a style, with "don't draw" as one of the choices.
    ///
    /// Upgrading from the old `show_railways` boolean is deliberately render-free
    /// (see `parse_config`), so the wallpaper on disk can lag the setting until
    /// something re-renders. In `Daily` mode that's the next date rollover at the
    /// latest. In `Customized` mode there is no rollover — the target signature is
    /// `custom:<coords>:<theme>` with no date in it — so a pinned user keeps the
    /// pre-upgrade drawing until the theme flips, the pin moves, or any Lab/Style
    /// save forces a regen. Harmless (it's a stale image, not stale state), but
    /// it's why "the next day fixes it" isn't true for every mode.
    pub railway_style: RailwayStyle,
    /// Cable car / ropeway centerlines.
    pub show_aerialways: bool,
    /// Which visual language the wallpaper is drawn in (see `StyleVariant`).
    /// `Ink` by default. A Lab-tab experiment for now: `Mondrian` replaces the
    /// theme colors with the Mondrian paper/ink pair, but the layer toggles above
    /// still apply. See src/core/mondrian.ts.
    pub variant: StyleVariant,
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
    pub map_provider: MapProvider,
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
            railway_style: RailwayStyle::default(),
            show_aerialways: false,
            variant: StyleVariant::default(),
            dev_mode: false,
            proxy_enabled: false,
            proxy_url: String::new(),
            map_provider: MapProvider::default(),
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

/// Parse persisted config JSON, migrating two legacy fields that were replaced by
/// richer ones. In both cases the new field wins if present, the legacy value is
/// only consulted when it is absent, and the stale key is simply left in the JSON
/// — serde ignores unknown fields, and the next `save` rewrites the file without
/// it.
///
///   • `enabled: bool` → the tri-state `update_mode`, so a user who had daily
///     updates switched *off* stays on `Disable` after upgrading instead of
///     silently reverting to the `Daily` default (`true` ⇒ `Daily`).
///   • `show_railways: bool` → `railway_style`, mapping `true` to `Plain` and
///     `false` to `Off`. No mode reproduces the old drawing exactly — it was a
///     dashed line, and the dash did not survive the rewrite — so an upgrading
///     user's railways do change slightly whatever we pick here. `Plain` is the
///     nearest survivor (same weight, one unadorned stroke, see `RAILWAY_PLAIN` in
///     src/core/render.ts) and the only choice that isn't a deliberate new symbol:
///     landing someone on `Banded` or `Ties` would hand them a look they never
///     opted into. The upgrade does not force a re-render, so on the day of the
///     update the desktop may still show the pre-upgrade drawing while the selector
///     already reads "Plain"; the next render reconciles it (but see the
///     Customized-mode caveat on `railway_style` in `Config`).
///
/// Unparseable or empty input falls back to `Config::default()` (⇒ `Daily`, the
/// new-user default). Pure (no IO) so it's unit-testable — see the tests below.
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
        if !obj.contains_key("railway_style") {
            if let Some(shown) = obj.get("show_railways").and_then(|e| e.as_bool()) {
                let style = if shown { "plain" } else { "off" };
                obj.insert("railway_style".into(), serde_json::Value::String(style.into()));
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
    fn migrates_legacy_show_railways_true_to_plain() {
        // Plain, not Banded/Ties: no mode reproduces the old dashed line, so Plain
        // is the nearest survivor and the only one that isn't a deliberate new
        // symbol — an upgrade must not opt the user into a look they never chose.
        assert_eq!(parse_config(r#"{"show_railways": true}"#).railway_style, RailwayStyle::Plain);
    }

    #[test]
    fn migrates_legacy_show_railways_false_to_off() {
        assert_eq!(parse_config(r#"{"show_railways": false}"#).railway_style, RailwayStyle::Off);
    }

    #[test]
    fn explicit_railway_style_wins_over_a_lingering_show_railways() {
        let cfg = parse_config(r#"{"railway_style":"ties","show_railways":false}"#);
        assert_eq!(cfg.railway_style, RailwayStyle::Ties);
    }

    #[test]
    fn config_without_any_railway_key_defaults_to_off() {
        assert_eq!(parse_config("{}").railway_style, RailwayStyle::Off);
        assert_eq!(Config::default().railway_style, RailwayStyle::Off);
    }

    /// The legacy key must not survive a save, or the file would carry two
    /// sources of truth for the same setting — and a later downgrade-then-upgrade
    /// could resurrect the stale one. `Config` simply has no field for it, so
    /// serialization can't emit it; this pins that.
    #[test]
    fn saving_a_migrated_config_drops_the_legacy_railway_key() {
        let cfg = parse_config(r#"{"show_railways": true}"#);
        let out: serde_json::Value = serde_json::to_value(&cfg).unwrap();
        let obj = out.as_object().unwrap();
        assert_eq!(obj["railway_style"], serde_json::json!("plain"));
        assert!(!obj.contains_key("show_railways"), "legacy key must not be written back");
        // And re-reading what we just wrote is a fixed point.
        assert_eq!(parse_config(&out.to_string()).railway_style, RailwayStyle::Plain);
    }

    #[test]
    fn every_railway_style_round_trips() {
        for (json, expected) in [
            ("off", RailwayStyle::Off),
            ("plain", RailwayStyle::Plain),
            ("banded", RailwayStyle::Banded),
            ("ties", RailwayStyle::Ties),
        ] {
            let cfg = parse_config(&format!(r#"{{"railway_style":"{json}"}}"#));
            assert_eq!(cfg.railway_style, expected, "parsing {json}");
            // And back out again, as the renderer's Style payload will see it.
            let out = serde_json::to_string(&cfg.railway_style).unwrap();
            assert_eq!(out, format!(r#""{json}""#));
        }
    }

    #[test]
    fn a_bad_railway_style_falls_back_to_defaults() {
        // serde rejects the whole document, so this lands on Config::default()
        // rather than on a half-populated config.
        assert_eq!(parse_config(r#"{"railway_style":"bogus"}"#).railway_style, RailwayStyle::Off);
    }

    /// A real pre-migration config, field for field. The failure mode this guards
    /// is quiet and total: `parse_config` ends in `unwrap_or_default()`, so if any
    /// single field failed to deserialize the user would silently lose *every*
    /// setting, not just the railway one. Asserting the neighbours survived proves
    /// we landed on the migrated config and not on `Config::default()`.
    #[test]
    fn a_real_pre_migration_config_migrates_without_losing_anything() {
        // `r##` rather than `r#`: the hex colors below contain `"#`, which would
        // close an `r#"..."#` literal early.
        let cfg = parse_config(
            r##"{"auto_update": true, "custom": {"lat": 36.44297, "lon": 28.22868},
                "dark": {"background": "#000000", "foreground": "#5e5d58"},
                "dev_mode": true, "hide_tray": false,
                "light": {"background": "#eee8d6", "foreground": "#2d2d2d"},
                "proxy_enabled": false, "proxy_url": "", "show_aerialways": true,
                "show_airports": true, "show_railways": true, "show_water": true,
                "style": "standard", "theme": "system", "update_check": "daily",
                "update_mode": "daily", "variant": "ink"}"##,
        );
        assert_eq!(cfg.railway_style, RailwayStyle::Plain);
        // Not Config::default(): these all differ from it.
        assert_eq!(cfg.custom, Some(CustomCity { lat: 36.44297, lon: 28.22868 }));
        assert!(cfg.dev_mode && cfg.show_water && cfg.show_airports && cfg.show_aerialways);
        assert_eq!(cfg.theme, ThemeMode::System);
    }

    #[test]
    fn a_config_predating_the_map_provider_field_reads_as_osm() {
        assert_eq!(parse_config(r#"{"update_mode":"daily"}"#).map_provider, MapProvider::Osm);
        assert_eq!(Config::default().map_provider, MapProvider::Osm);
    }

    #[test]
    fn every_map_provider_round_trips() {
        for (json, expected) in [
            ("osm", MapProvider::Osm),
            ("here", MapProvider::Here),
            ("google", MapProvider::Google),
        ] {
            let cfg = parse_config(&format!(r#"{{"map_provider":"{json}"}}"#));
            assert_eq!(cfg.map_provider, expected, "parsing {json}");
            assert_eq!(serde_json::to_string(&cfg.map_provider).unwrap(), format!(r#""{json}""#));
        }
    }

    #[test]
    fn custom_pin_round_trips() {
        let cfg =
            parse_config(r#"{"update_mode":"customized","custom":{"lat":-16.5,"lon":-68.17}}"#);
        assert_eq!(cfg.update_mode, UpdateMode::Customized);
        assert_eq!(cfg.custom, Some(CustomCity { lat: -16.5, lon: -68.17 }));
    }
}
