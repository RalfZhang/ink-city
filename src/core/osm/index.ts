// Barrel for the OSM acquisition subsystem — the Overpass transport (overpass.ts)
// plus each layer's selector/slim (roads/water/airports/railways/aerialways) and
// the union-query orchestrator (fetch-city.ts). The public entry point is
// fetchCityData; the per-layer modules are internal composition details it wires
// together. Precache/sidecar-only (Node/Deno/Bun) — never bundled into the
// client, so this is NOT re-exported from ../index.ts. scripts/osm-cli.ts and
// scripts/render.ts import fetchCityData from here.
export * from "./fetch-city";
