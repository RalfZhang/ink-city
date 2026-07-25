import type { AirportFeature, Bbox, Geom } from "./types";
import { fetchOverpass, MIRRORS, type FetchOptions } from "./overpass";

// Airport layer extraction. Runs at PRECACHE/FETCH time (Node/Deno/Bun — CI's
// batch precache and the desktop app's live sidecar fallback alike), never on
// the client — mirrors water.ts, but far simpler: unlike coastline-derived
// ocean fill, a runway/taxiway never spans the whole bbox, so there's no
// edge-tracing/clipping to do. The "airports" layer implementation dispatched
// by fetch-city.ts's fetchCityData().
//
// Scope: standalone ways only — aeroway=runway and aeroway=taxiway, both
// rendered as stroked centerlines (matching how the overwhelming majority of OSM
// data tags them; taxiways draw thinner and beneath runways). Aprons and other
// filled aeroway areas are intentionally not collected — the airport reads as
// pure linework, consistent with the road/water styling.

type RawGeom = { lat: number; lon: number };
type RawWay = { type: "way"; tags?: Record<string, string>; geometry?: RawGeom[] };
type RawOsm = { elements?: RawWay[] };

/** Overpass QL fetching runway and taxiway ways. */
export function buildAirportsQuery(b: Bbox): string {
  const bb = `${b.south},${b.west},${b.north},${b.east}`;
  return (
    `[out:json][timeout:90];(` +
    `way[aeroway=runway](${bb});way[aeroway=taxiway](${bb});` +
    `);out geom;`
  );
}

/** Fetch the airports layer for `b`. Shares overpass.ts mirror/retry handling. */
export async function fetchAirports(
  b: Bbox,
  mirrors: readonly string[] = MIRRORS,
  opts: FetchOptions = {},
): Promise<RawOsm> {
  return (await fetchOverpass(buildAirportsQuery(b), mirrors, opts)) as RawOsm;
}

const TOL = 1e-7; // ~1cm; matches water.ts's endpoint-match precision
const samePt = (a: RawGeom, b: RawGeom) => Math.abs(a.lat - b.lat) < TOL && Math.abs(a.lon - b.lon) < TOL;

/** Drop consecutive duplicate points (cheap, avoids zero-length segments). */
function dedupeAdjacent(pts: RawGeom[]): RawGeom[] {
  const out: RawGeom[] = [];
  for (const p of pts) if (out.length === 0 || !samePt(out[out.length - 1], p)) out.push(p);
  return out;
}

/**
 * Assemble a raw runway/taxiway Overpass response into slim, render-ready
 * features. Coordinates are optionally rounded to `coordPrecision` decimals —
 * mirrors slimWater.
 */
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
  const f = 10 ** precision;
  const r = (v: number) => Math.round(v * f) / f;
  const ring = (pts: Geom[]) => pts.map((p) => ({ lat: r(p.lat), lon: r(p.lon) }));
  return features.map((feat) => ({ kind: feat.kind, line: ring(feat.line) }));
}
