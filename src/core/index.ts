// Barrel for the portable core — the client-safe surface. Consumers import from
// "@/core" (desktop) or vendor this directory into the CI script / website repos.
//
// Two parts of this directory are deliberately absent, and vendoring must still
// include them:
//
//   • ./osm/* beyond ./osm/layers — precache/sidecar-only (Node/Deno/Bun).
//     ./osm/water pulls in `polygon-clipping`, which we keep out of the client
//     bundle; the acquisition path is reached only via scripts/osm-cli.ts → ./osm.
//   • ./mondrian — no standalone consumer, reached only through `drawScene`'s
//     `variant`, but ./render imports it directly.
export * from "./types";
export * from "./city";
export * from "./bbox";
export * from "./coords";
// LAYER_IDS/LayerId only: the client and website use them for UI gating.
export * from "./osm/layers";
export * from "./render";
export * from "./constants";
