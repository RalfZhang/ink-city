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
        UpdateCheck::Weekly
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

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Config {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub hide_tray: bool,
    #[serde(default)]
    pub theme: ThemeMode,
    #[serde(default = "ColorPair::light_default")]
    pub light: ColorPair,
    #[serde(default = "ColorPair::dark_default")]
    pub dark: ColorPair,
    #[serde(default)]
    pub style: StylePreset,
    #[serde(default)]
    pub update_check: UpdateCheck,
    /// Draw the water layer on the wallpaper. Off by default; only surfaced in
    /// the UI when the current city's data actually has water.
    #[serde(default)]
    pub show_water: bool,
}

fn default_true() -> bool {
    true
}

impl Default for Config {
    fn default() -> Self {
        Self {
            enabled: true,
            hide_tray: false,
            theme: ThemeMode::System,
            light: ColorPair::light_default(),
            dark: ColorPair::dark_default(),
            style: StylePreset::Standard,
            update_check: UpdateCheck::Weekly,
            show_water: false,
        }
    }
}

fn config_path(app: &AppHandle) -> Result<PathBuf> {
    let dir = app.path().app_config_dir()?;
    fs::create_dir_all(&dir)?;
    Ok(dir.join("config.json"))
}

pub fn load(app: &AppHandle) -> Config {
    let Ok(path) = config_path(app) else { return Config::default() };
    let Ok(raw) = fs::read_to_string(&path) else { return Config::default() };
    serde_json::from_str(&raw).unwrap_or_default()
}

pub fn save(app: &AppHandle, cfg: &Config) -> Result<()> {
    let path = config_path(app)?;
    fs::write(path, serde_json::to_string_pretty(cfg)?)?;
    Ok(())
}
