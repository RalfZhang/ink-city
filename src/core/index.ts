// Barrel for the portable core. Consumers can import from "@/core" (desktop)
// or copy/depend on this directory from the CI script and website repos.
export * from "./types";
export * from "./city";
export * from "./bbox";
export * from "./overpass";
export * from "./layers";
// NOTE: ./water and ./fetch-city are intentionally NOT re-exported here. Both
// are precache/sidecar-only (Node/Deno/Bun, never the client): ./water pulls
// in `polygon-clipping`, and ./fetch-city imports ./water directly.
// scripts/osm-cli.ts imports ./fetch-city (not ./water).
export * from "./render";
export * from "./constants";
