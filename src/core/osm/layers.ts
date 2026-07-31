// Declarative manifest of optional OSM data layers — everything beyond the
// always-present `elements` (roads). This is the one file to touch when adding a
// layer: add its id here, give it a fetch+slim implementation (mirroring
// water.ts/airports.ts), and wire it into fetch-city.ts's dispatch. Nothing else
// in the acquisition path changes, because both precache and the live sidecar
// fallback go through fetch-city.ts.
//
// The Rust side has no mirror of this list — it never fetches a layer itself, and
// tracks the user's per-layer toggles as independent `show_*` fields
// (config.rs / state.rs / commands.rs), which must each gain a field by hand.

export const LAYER_IDS = ["water", "airports", "railways", "aerialways"] as const;
export type LayerId = (typeof LAYER_IDS)[number];
