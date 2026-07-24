// Declarative manifest of optional OSM data layers — everything beyond the
// always-present `elements` (roads). This is the one file to touch when
// adding a new layer (e.g. "rail", "airports"): add its id/JSON key here, give
// it a fetch+slim implementation (mirroring water.ts), and wire it into
// fetch-city.ts's dispatch. Nothing else in the acquisition path changes,
// because both precache and the live sidecar fallback go through fetch-city.ts.
//
// Mirrored (by hand, as a short declarative list — not fetch logic) by
// src-tauri/src/layers.rs, which uses it only for presence detection/UI
// gating; the Rust side never fetches a layer itself.

export const LAYER_IDS = ["water"] as const;
export type LayerId = (typeof LAYER_IDS)[number];

/** Top-level JSON key each layer's data is stored under in the `Osm` payload. */
export const LAYER_KEYS: Record<LayerId, string> = {
  water: "water",
};

export function isLayerId(s: string): s is LayerId {
  return (LAYER_IDS as readonly string[]).includes(s);
}
