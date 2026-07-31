import type { AirportFeature, Bbox } from "../types";
import { dedupeAdjacent, roundPts } from "../geom";

// The "airports" layer's selector + slim, dispatched by fetch-city.ts. Runs at
// PRECACHE/FETCH time (Node/Deno/Bun), never on the client.
//
// Scope: standalone ways only — aeroway=runway and aeroway=taxiway, matching how
// the overwhelming majority of OSM data tags them. Aprons and other filled aeroway
// areas are intentionally not collected: the airport reads as pure linework,
// consistent with the road/water styling. (Aprons *were* collected until schema
// v3; a payload that predates it is invalidated by `v`, not read.)

type RawGeom = { lat: number; lon: number };
type RawWay = { type: "way"; tags?: Record<string, string>; geometry?: RawGeom[] };
type RawOsm = { elements?: RawWay[] };

/** Union-query fragment selecting runway/taxiway ways — composed by fetch-city.ts. */
export function airportsSelector(b: Bbox): string {
  const bb = `${b.south},${b.west},${b.north},${b.east}`;
  return `way[aeroway=runway](${bb});way[aeroway=taxiway](${bb});`;
}

/** Slim a raw Overpass response to runway/taxiway centerlines. */
export function slimAirports(raw: RawOsm, coordPrecision?: number): AirportFeature[] {
  const features: AirportFeature[] = [];

  for (const el of raw.elements ?? []) {
    if (el.type !== "way" || !el.geometry || el.geometry.length < 2) continue;
    const pts = dedupeAdjacent(el.geometry);
    if (pts.length < 2) continue;

    if (el.tags?.aeroway === "runway") {
      features.push({ kind: "runway", line: pts });
    } else if (el.tags?.aeroway === "taxiway") {
      features.push({ kind: "taxiway", line: pts });
    }
  }

  return coordPrecision === undefined ? features : roundFeatures(features, coordPrecision);
}

function roundFeatures(features: AirportFeature[], precision: number): AirportFeature[] {
  return features.map((feat) => ({ kind: feat.kind, line: roundPts(feat.line, precision) }));
}
