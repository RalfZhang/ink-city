// `@inkcity/osm` — the OSM acquisition subsystem: the Overpass transport
// (overpass.ts) plus each layer's selector/slim (roads/water/airports/railways/
// aerialways) and the union-query orchestrator (fetch-city.ts). The public entry
// point is fetchCityData; the per-layer modules are internal composition details
// it wires together. Precache/sidecar-only (Node/Deno/Bun), which is why it is a
// package of its own rather than part of `@inkcity/core`: nothing that depends on
// core alone — the desktop frontend, the website — can pull it into a client
// bundle. scripts/osm-cli.ts and scripts/render.ts import fetchCityData from here.
export * from "./fetch-city";
