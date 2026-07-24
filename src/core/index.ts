// Barrel for the portable core. Consumers can import from "@/core" (desktop)
// or copy/depend on this directory from the CI script and website repos.
export * from "./types";
export * from "./city";
export * from "./bbox";
export * from "./overpass";
export * from "./layers";
// NOTE: ./water, ./airports, and ./fetch-city are intentionally NOT
// re-exported here. All three are precache/sidecar-only (Node/Deno/Bun, never
// the client): ./water pulls in `polygon-clipping`, and ./fetch-city imports
// both ./water and ./airports directly. scripts/osm-cli.ts imports
// ./fetch-city (not ./water or ./airports). The client only needs the
// `AirportFeature`/`Osm` types (from ./types, exported above) and the
// `drawAirports` renderer (from ./render, exported below).
export * from "./render";
export * from "./constants";
