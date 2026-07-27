import type { AerialwayFeature, Bbox, Geom } from "../types";

// Aerialway layer extraction — cable cars, gondolas, chair/drag lifts, etc.
// (OSM aerialway=*). Runs at PRECACHE/FETCH time (Node/Deno/Bun — CI's batch
// precache and the desktop app's live sidecar fallback alike), never on the
// client — mirrors airports.ts. An aerialway is a plain polyline (no filled
// areas), so like airports there's no edge-tracing/clipping to do. The
// "aerialways" layer implementation dispatched by fetch-city.ts's fetchCityData().
//
// Scope: the aerialway *lift lines* — each cable's centerline. Rather than take
// every `aerialway=*` way and blacklist the non-lines, we WHITELIST the lift
// kinds (AERIALWAY_LIFT_KINDS) to exactly match what openstreetmap.org draws.
// Blacklisting was too leaky — it let through, and painted, things the standard
// map never shows:
//   • `station` / `pylon` — station buildings and support towers, not lines. A
//     station is very often a closed way (a building footprint), which `way
//     [aerialway]` would trace as a spurious little outline (e.g. La Paz's Mi
//     Teleférico stations); a pylon is usually a node but can be a way.
//   • `magic_carpet` — the ground "carpet" conveyor lift at ski schools; short,
//     numerous, and not rendered by osm-carto either (the stray short lines seen
//     around ski areas like Altay).
//   • lifecycle / junk values — `yes`, `abandoned`, `razed`, `proposed`,
//     `construction`, `no`, …
// All whitelisted kinds render identically as one dotted line (see render.ts).

type RawGeom = { lat: number; lon: number };
type RawWay = { type: "way"; tags?: Record<string, string>; geometry?: RawGeom[] };
type RawOsm = { elements?: RawWay[] };

// The aerialway=* values we render — the lift *lines*. Matches openstreetmap.org
// (openstreetmap-carto) exactly: every kind it draws as a line, and only those.
// See the header for what this deliberately leaves out (station/pylon,
// magic_carpet, lifecycle values). All render identically (see drawAerialways).
export const AERIALWAY_LIFT_KINDS = [
  "cable_car", "gondola", "mixed_lift", "chair_lift", // overhead passenger transport
  "drag_lift", "t-bar", "j-bar", "platter", "rope_tow", // surface drag lifts
  "goods", "zip_line", // cargo ropeway / gravity zip line
] as const;

/** Union-query fragment selecting aerialway (cable car / ropeway) lift ways — composed by fetch-city.ts. */
export function aerialwaysSelector(b: Bbox): string {
  const bb = `${b.south},${b.west},${b.north},${b.east}`;
  // Positive whitelist: only the AERIALWAY_LIFT_KINDS lines, matching osm-carto.
  const kinds = AERIALWAY_LIFT_KINDS.join("|");
  return `way[aerialway~"^(${kinds})$"](${bb});`;
}

const TOL = 1e-7; // ~1cm; matches airports.ts/water.ts endpoint-match precision
const samePt = (a: RawGeom, b: RawGeom) => Math.abs(a.lat - b.lat) < TOL && Math.abs(a.lon - b.lon) < TOL;

/** Drop consecutive duplicate points (cheap, avoids zero-length segments). */
function dedupeAdjacent(pts: RawGeom[]): RawGeom[] {
  const out: RawGeom[] = [];
  for (const p of pts) if (out.length === 0 || !samePt(out[out.length - 1], p)) out.push(p);
  return out;
}

/**
 * Assemble a raw aerialway Overpass response into slim, render-ready features.
 * Coordinates are optionally rounded to `coordPrecision` decimals — mirrors
 * slimAirports. The lift subtype isn't kept: all render identically, so a single
 * polyline shape is enough. The query already restricts to `way[aerialway]`, so
 * every element here carries the tag; we only guard geometry.
 */
export function slimAerialways(raw: RawOsm, coordPrecision?: number): AerialwayFeature[] {
  const features: AerialwayFeature[] = [];

  for (const el of raw.elements ?? []) {
    if (el.type !== "way" || !el.geometry || el.geometry.length < 2) continue;
    if (!el.tags?.aerialway) continue;
    const pts = dedupeAdjacent(el.geometry);
    if (pts.length < 2) continue;
    features.push({ line: pts });
  }

  return coordPrecision === undefined ? features : roundFeatures(features, coordPrecision);
}

function roundFeatures(features: AerialwayFeature[], precision: number): AerialwayFeature[] {
  const f = 10 ** precision;
  const r = (v: number) => Math.round(v * f) / f;
  const ring = (pts: Geom[]) => pts.map((p) => ({ lat: r(p.lat), lon: r(p.lon) }));
  return features.map((feat) => ({ line: ring(feat.line) }));
}
