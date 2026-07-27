// Single entry point for acquiring one city's OSM data. Fetches every layer
// (roads plus all optional ones) in ONE Overpass request and assembles the
// final payload — used by both of scripts/osm-cli.ts's modes (batch "precache"
// and single-shot "fetch", the latter invoked live by the desktop app's
// sidecar). Precache and the live fallback therefore always produce the same
// shape for the same bbox, instead of the old split where the Rust-side live
// fallback was a separate, roads-only reimplementation.
//
// Runs in Node/Deno/Bun — never on the client (see water.ts's note on
// polygon-clipping) — so this module is deliberately NOT re-exported from
// ./index (the client barrel), same rule as ./water.

import type { Bbox, Osm } from "../types";
import { fetchOverpass } from "./overpass";
import { roadsSelector, slimRoads } from "./roads";
import { waterSelector, slimWater } from "./water";
import { airportsSelector, slimAirports } from "./airports";
import { railwaysSelector, slimRailways } from "./railways";
import { aerialwaysSelector, slimAerialways } from "./aerialways";
import { OSM_SCHEMA_VERSION } from "../constants";

export type FetchCityOptions = {
  coordPrecision?: number;
};

// One union query does, in a single timeout budget, the work the five per-layer
// queries used to split across five budgets of 90s each — so give it more room.
const OVERPASS_TIMEOUT_S = 180;

/**
 * Fetch + slim every layer for `bbox` in a single Overpass round trip,
 * returning one payload shaped exactly like a precached CDN file:
 * `{ v, elements, water, airports, railways, aerialways }`.
 */
export async function fetchCityData(bbox: Bbox, opts: FetchCityOptions = {}): Promise<Osm> {
  const precision = opts.coordPrecision;

  // One request for every layer: a single Overpass union query, so the live
  // sidecar path (a user waiting on a CDN miss / custom city) pays one round
  // trip and one rate-limit slot instead of five. Each slimX below re-reads the
  // shared response and keeps only the elements carrying its own tags; the
  // layers' tag namespaces are disjoint, so every element is claimed by exactly
  // one (and Overpass unions dedupe by id, so nothing repeats). The casts hand
  // each slimX the same raw response under its own expected shape.
  const query =
    `[out:json][timeout:${OVERPASS_TIMEOUT_S}];(` +
    roadsSelector(bbox) +
    waterSelector(bbox) +
    airportsSelector(bbox) +
    railwaysSelector(bbox) +
    aerialwaysSelector(bbox) +
    `);out geom;`;
  const raw = await fetchOverpass(query);

  const elements = slimRoads(raw as Osm, precision).elements ?? [];
  return {
    v: OSM_SCHEMA_VERSION,
    elements,
    water: slimWater(raw as Parameters<typeof slimWater>[0], bbox, elements.length, precision),
    airports: slimAirports(raw as Parameters<typeof slimAirports>[0], precision),
    railways: slimRailways(raw as Parameters<typeof slimRailways>[0], precision),
    aerialways: slimAerialways(raw as Parameters<typeof slimAerialways>[0], precision),
  };
}
