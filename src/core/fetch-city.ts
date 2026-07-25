// Single entry point for acquiring one city's OSM data. The only place that
// decides which optional layers to fetch and assembles the final payload —
// used by both of scripts/osm-cli.ts's modes (batch "precache" and single-shot
// "fetch", the latter invoked live by the desktop app's sidecar). Precache and
// the live fallback therefore always produce the same shape for the same
// bbox/layers, instead of the old split where the Rust-side live fallback was
// a separate, roads-only reimplementation.
//
// Runs in Node/Deno/Bun — never on the client (see water.ts's note on
// polygon-clipping) — so this module is deliberately NOT re-exported from
// ./index (the client barrel), same rule as ./water.

import type { Bbox, Osm } from "./types";
import { fetchRoads, slimRoads } from "./overpass";
import { fetchWater, slimWater } from "./water";
import { fetchAirports, slimAirports } from "./airports";
import { fetchRailways, slimRailways } from "./railways";
import { OSM_SCHEMA_VERSION } from "./constants";
import { LAYER_IDS, type LayerId } from "./layers";

export type FetchCityOptions = {
  /** Which optional layers to fetch, beyond roads. Default: all of them. */
  layers?: readonly LayerId[];
  coordPrecision?: number;
  /** Delay before each optional-layer fetch, so we don't hammer Overpass back-to-back. */
  spacingMs?: number;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch + slim every requested layer for `bbox`, returning one payload shaped
 * exactly like a precached CDN file: `{ v, elements, water?, airports? }`.
 */
export async function fetchCityData(bbox: Bbox, opts: FetchCityOptions = {}): Promise<Osm> {
  const layers = opts.layers ?? LAYER_IDS;
  const precision = opts.coordPrecision;

  const rawRoads = await fetchRoads(bbox);
  const slim = slimRoads(rawRoads, precision);
  const out: Osm = { v: OSM_SCHEMA_VERSION, elements: slim.elements ?? [] };

  if (layers.includes("water")) {
    if (opts.spacingMs) await sleep(opts.spacingMs);
    const rawWater = await fetchWater(bbox);
    out.water = slimWater(rawWater, bbox, out.elements?.length ?? 0, precision);
  }

  if (layers.includes("airports")) {
    if (opts.spacingMs) await sleep(opts.spacingMs);
    const rawAirports = await fetchAirports(bbox);
    out.airports = slimAirports(rawAirports, precision);
  }

  if (layers.includes("railways")) {
    if (opts.spacingMs) await sleep(opts.spacingMs);
    const rawRailways = await fetchRailways(bbox);
    out.railways = slimRailways(rawRailways, precision);
  }

  return out;
}
