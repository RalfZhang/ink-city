// `@inkcity/core` — the portable, client-safe surface, imported by the desktop
// frontend, the CI scripts and the website as a workspace package.
//
// Two modules are deliberately absent from this barrel:
//
//   • ./schedule — CI's picker; scripts (and the website, for reading the
//     schedule) import it as `@inkcity/core/schedule`.
//   • ./mondrian — reached through `drawScene`'s `variant`; only its colors are
//     re-exported below, for the desktop window that wears a Mondrian map.
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
// How a map lies over a screen of any shape and is inked in on it — the website's
// page and the desktop's window alike.
export * from "./ink/cover";
export * from "./ink/front";
export * from "./ink/growth";
export * from "./ink/ink-in";
export * from "./ink/offscreen";
// …and the plumbing both hosts' map engines run on: a worker or the main thread
// (./ink/engine-link.ts), the newest request only (./ink/queue.ts), a frame too big
// for the machine drawn smaller (./ink/fit.ts).
export * from "./ink/engine-link";
export * from "./ink/fit";
export * from "./ink/queue";
export { MONDRIAN_COLORS, MONDRIAN_PRIMARIES } from "./mondrian";
export * from "./constants";
// The defaults the desktop's Rust compiles in from the same ./defaults.json: each
// theme's colors, a fresh install's style, and the ground every map spans.
export * from "./defaults";
// Where clients fetch published data from (./cdn.json, also compiled into the
// desktop), and the desktop installers the website offers.
export * from "./cdn";
// The Overpass servers live maps come from (./overpass.json, also compiled into the
// desktop).
export * from "./overpass";
export * from "./download";
// The guess-the-country game — rules, save format and country lookup, written once
// for the desktop app and the website; only its storage differs per host (see
// ./guess/store.ts).
export * from "./guess";
