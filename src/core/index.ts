// Barrel for the portable core. Consumers can import from "@/core" (desktop)
// or copy/depend on this directory from the CI script and website repos.
export * from "./types";
export * from "./city";
export * from "./bbox";
export * from "./overpass";
export * from "./layers";
// NOTE: ./water, ./airports, ./railways, ./aerialways, and ./fetch-city are
// intentionally NOT re-exported here. All are precache/sidecar-only
// (Node/Deno/Bun, never the client): ./water pulls in `polygon-clipping`, and
// ./fetch-city imports every layer module directly. scripts/osm-cli.ts imports
// ./fetch-city (not the individual layer modules). The client only needs the
// layer feature types (e.g. `AirportFeature`) and `Osm` (from ./types, exported
// above) plus the renderers (from ./render, exported below).
export * from "./render";
export * from "./constants";
