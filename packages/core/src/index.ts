// `@inkcity/core` — the portable, client-safe surface, imported by the desktop
// frontend, the CI scripts and (later) the website as a workspace package.
//
// Two modules are deliberately absent from this barrel:
//
//   • ./schedule — CI-only; scripts import it as `@inkcity/core/schedule`.
//   • ./mondrian — no standalone consumer, reached only through `drawScene`'s
//     `variant`, but ./render imports it directly.
//
// OSM acquisition isn't here at all: it lives in `@inkcity/osm`, so its
// `polygon-clipping` dependency can never reach a client bundle.
export * from "./types";
export * from "./city";
export * from "./bbox";
export * from "./coords";
// LAYER_IDS/LayerId only: the client and website use them for UI gating.
export * from "./layers";
export * from "./render";
export * from "./label";
export * from "./constants";
// The guess-the-country game — rules, save format and country lookup, written once
// for the desktop app and the website; only its storage differs per host (see
// ./guess/store.ts).
export * from "./guess";
