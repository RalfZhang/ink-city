import type { Bbox, RailwayFeature } from "./types";
import { fetchOverpass, MIRRORS, type FetchOptions } from "./overpass";
import { dedupeAdjacent, roundPts } from "./geom";

// Railway layer extraction. Runs at PRECACHE/FETCH time (Node/Deno/Bun — CI's
// batch precache and the desktop app's live sidecar fallback alike), never on
// the client — mirrors airports.ts. A railway is a plain polyline (no filled
// areas), so like airports there's no edge-tracing/clipping to do. The
// "railways" layer implementation dispatched by fetch-city.ts's fetchCityData().
//
// Scope: surface heavy/light rail only — railway=rail | light_rail |
// narrow_gauge, all rendered as one dashed centerline. Deliberately excluded:
//   • subway  — underground; the wallpaper shows above-ground features only.
//   • tram    — runs in the street, so it would just retrace the road network.
// These match the roads/water/airports convention of drawing what's visible on
// the ground.

type RawGeom = { lat: number; lon: number };
type RawWay = { type: "way"; tags?: Record<string, string>; geometry?: RawGeom[] };
type RawOsm = { elements?: RawWay[] };

/** OSM `railway` values we collect (surface heavy/light rail). */
const RAIL_TYPES = ["rail", "light_rail", "narrow_gauge"] as const;

/** Overpass QL fetching surface railway ways. */
export function buildRailwaysQuery(b: Bbox): string {
  const bb = `${b.south},${b.west},${b.north},${b.east}`;
  const re = `^(${RAIL_TYPES.join("|")})$`;
  return `[out:json][timeout:90];(way[railway~"${re}"](${bb}););out geom;`;
}

/** Fetch the railway layer for `b`. Shares overpass.ts mirror/retry handling. */
export async function fetchRailways(
  b: Bbox,
  mirrors: readonly string[] = MIRRORS,
  opts: FetchOptions = {},
): Promise<RawOsm> {
  return (await fetchOverpass(buildRailwaysQuery(b), mirrors, opts)) as RawOsm;
}

/**
 * Assemble a raw railway Overpass response into slim, render-ready features.
 * Coordinates are optionally rounded to `coordPrecision` decimals — mirrors
 * slimAirports. The `railway` subtype isn't kept: all collected types render
 * identically, so a single polyline shape is enough.
 */
export function slimRailways(raw: RawOsm, coordPrecision?: number): RailwayFeature[] {
  const features: RailwayFeature[] = [];

  for (const el of raw.elements ?? []) {
    if (el.type !== "way" || !el.geometry || el.geometry.length < 2) continue;
    const rail = el.tags?.railway;
    if (!rail || !(RAIL_TYPES as readonly string[]).includes(rail)) continue;
    const pts = dedupeAdjacent(el.geometry);
    if (pts.length < 2) continue;
    features.push({ line: pts });
  }

  return coordPrecision === undefined ? features : roundFeatures(features, coordPrecision);
}

function roundFeatures(features: RailwayFeature[], precision: number): RailwayFeature[] {
  return features.map((feat) => ({ line: roundPts(feat.line, precision) }));
}
