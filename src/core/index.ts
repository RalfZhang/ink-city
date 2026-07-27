// Barrel for the portable core. Consumers can import from "@/core" (desktop)
// or copy/depend on this directory from the CI script and website repos.
export * from "./types";
export * from "./city";
export * from "./bbox";
// The OSM layer manifest (LAYER_IDS/LayerId) — client/website use it for UI
// gating; kept in the client barrel even though its module now lives under ./osm.
export * from "./osm/layers";
// NOTE: the rest of ./osm (the Overpass transport, the per-layer selector/slim
// modules, and the fetch-city orchestrator) is intentionally NOT re-exported
// here — it's all precache/sidecar-only (Node/Deno/Bun, never the client):
// ./osm/water pulls in `polygon-clipping`, and the acquisition path is reached
// only through scripts/osm-cli.ts → ./osm. The client only needs the layer
// feature types (e.g. `AirportFeature`) and `Osm` (from ./types, exported
// above) plus the renderers (from ./render, exported below).
export * from "./render";
export * from "./constants";
