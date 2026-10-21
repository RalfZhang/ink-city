//! The defaults the desktop shares with the TypeScript side — `packages/core/src/defaults.json`,
//! compiled in: each theme's colors and the map a fresh install draws (both are
//! `Config::default()`'s), and the ground every map spans (`pipeline::render_bytes_for`).
//! The website draws with the same values and CI precaches with the last one
//! (`DEFAULT_COLORS`, `DEFAULT_STYLE` and `MAX_HALF_KM` in packages/core/src/defaults.ts),
//! so none of them is restated in Rust.
//!
//! The file is parsed into the config's own types, which makes `cargo test` the check
//! for both languages: an unknown preset or a misspelt key fails here, where the
//! TypeScript side only casts it.

use std::sync::OnceLock;

use serde::Deserialize;

use crate::config::{ColorPair, RailwayStyle, StylePreset, StyleVariant};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Defaults {
    pub colors: Colors,
    pub style: StyleDefaults,
    /// Half the long side of every map, in km — `bbox_for_screen`'s `max_half_km`. Also a
    /// contract with the data already published; see `MAX_HALF_KM` in defaults.ts.
    pub max_half_km: f64,
}

#[derive(Deserialize)]
pub struct Colors {
    pub light: ColorPair,
    pub dark: ColorPair,
}

/// The map a fresh install draws, keyed like the renderer's `Style`
/// (packages/core/src/types.ts) less its colors. Every key is required and no other is
/// accepted: a style setting only one side knows is a failed parse, not a default the
/// other silently lacks.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StyleDefaults {
    pub preset: StylePreset,
    pub show_water: bool,
    pub show_airports: bool,
    pub railway_style: RailwayStyle,
    pub show_aerialways: bool,
    pub variant: StyleVariant,
}

/// The parsed file. It's compiled in, so the only build that could fail to parse it is
/// one `cargo test` has already failed (`the_bundled_defaults_parse`).
pub fn get() -> &'static Defaults {
    static DEFAULTS: OnceLock<Defaults> = OnceLock::new();
    DEFAULTS.get_or_init(|| {
        serde_json::from_str(include_str!("../../../../packages/core/src/defaults.json"))
            .expect("bundled defaults.json invalid")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bundled_defaults_parse() {
        get();
    }

    /// The renderer tints its optional layers by blending the two colors (`mixColor` in
    /// packages/core/src/render.ts), and draws them in raw ink when either isn't hex — so
    /// a named color here would quietly change the map rather than fail anything.
    #[test]
    fn the_default_colors_are_hex_the_renderer_can_blend() {
        let Colors { light, dark } = &get().colors;
        for c in [&light.background, &light.foreground, &dark.background, &dark.foreground] {
            let hex = c.strip_prefix('#').unwrap_or_default();
            assert!(hex.len() == 6 && hex.chars().all(|ch| ch.is_ascii_hexdigit()), "{c:?}");
        }
    }

    /// Pinned because changing it breaks data already published, not just the next
    /// render: see `MAX_HALF_KM` in packages/core/src/defaults.ts before editing either.
    #[test]
    fn every_map_spans_20_km() {
        assert_eq!(get().max_half_km, 10.0);
    }
}
