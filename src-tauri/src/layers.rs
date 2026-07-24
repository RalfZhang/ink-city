//! Declarative manifest of optional OSM data layers (beyond the
//! always-present `elements`/roads), mirroring `src/core/layers.ts`. Adding a
//! new layer (e.g. "rail", "airports") to the fetch side means adding one
//! entry to that TS file; the Rust side never fetches a layer itself (see
//! `osm_sidecar.rs`) — it only needs to know the layer exists so it can detect
//! presence and gate the corresponding UI toggle. Add the same id here to get
//! that for free, instead of writing a new detection function per layer the
//! way `has_water` used to require.

use std::collections::HashSet;

/// Top-level JSON keys of optional layers an OSM payload may carry, beyond
/// the always-present `elements`.
pub const LAYER_KEYS: &[&str] = &["water", "airports"];

/// Which of `LAYER_KEYS` are present (as non-empty arrays) in an already
/// parsed JSON value. Used right after a fetch, when we already hold a parsed
/// `Value` and a re-scan of raw text would be wasted work.
pub fn detect_present_value(v: &serde_json::Value) -> HashSet<String> {
    LAYER_KEYS
        .iter()
        .filter(|key| v.get(**key).and_then(|w| w.as_array()).is_some_and(|a| !a.is_empty()))
        .map(|k| k.to_string())
        .collect()
}

/// Which of `LAYER_KEYS` are present (as non-empty arrays) in a JSON
/// document's raw text. Deliberately a byte scan, not a `serde_json` parse:
/// these payloads reach tens of MB for dense cities, and materializing a full
/// `Value` tree just to read a few presence bits would cost hundreds of ms on
/// the async worker. Tolerates whitespace around `:` and `[`, so it survives
/// even if the cache is ever written pretty-printed instead of compact.
pub fn detect_present_text(s: &str) -> HashSet<String> {
    LAYER_KEYS.iter().filter(|key| key_has_nonempty_array(s, key)).map(|k| k.to_string()).collect()
}

fn key_has_nonempty_array(s: &str, key: &str) -> bool {
    let needle = format!("\"{}\"", key);
    let Some(i) = s.find(&needle) else { return false };
    let after_key = s[i + needle.len()..].trim_start();
    let Some(after_colon) = after_key.strip_prefix(':') else { return false };
    let Some(in_array) = after_colon.trim_start().strip_prefix('[') else { return false };
    // Non-empty iff the next non-space char isn't the array's closing bracket.
    in_array.trim_start().starts_with(|c| c != ']')
}
