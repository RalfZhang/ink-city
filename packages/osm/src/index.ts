// `@inkcity/osm` — the OSM acquisition subsystem: the Overpass transport
// (overpass.ts) plus each layer's selector/slim (roads/water/airports/railways/
// aerialways) and the union-query orchestrator (fetch-city.ts). The public entry
// point is fetchCityData; the per-layer modules are internal composition details
// it wires together. A package of its own rather than part of `@inkcity/core` so
// that nothing depending on core alone can pull it into a client bundle: it runs
// in the precache and the sidecar (Node/Bun), and on the web only in the website's
// map worker, loaded lazily for the one rung that needs it. scripts/osm-cli.ts and
// scripts/render.ts import fetchCityData from here.
export * from "./fetch-city";
