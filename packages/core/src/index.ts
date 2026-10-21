// `@inkcity/core` — the portable, client-safe surface, imported by the desktop
// frontend, the CI scripts and the website as a workspace package.
//
// Two modules are deliberately absent from this barrel:
//
//   • ./schedule — CI's picker; scripts (and the website, for reading the
//     schedule) import it as `@inkcity/core/schedule`.
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
// The defaults the desktop's Rust compiles in from the same ./defaults.json: each
// theme's colors, a fresh install's style, and the ground every map spans.
export * from "./defaults";
// Where clients fetch published data from (./cdn.json, also compiled into the
// desktop), and the desktop installers the website offers.
export * from "./cdn";
export * from "./download";
// The guess-the-country game — rules, save format and country lookup, written once
// for the desktop app and the website; only its storage differs per host (see
// ./guess/store.ts).
export * from "./guess";
