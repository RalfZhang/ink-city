import type { Bbox, RailwayFeature } from "../types";
import { dedupeAdjacent, roundPts } from "../geom";

// The "railways" layer's selector + slim, dispatched by fetch-city.ts. Runs at
// PRECACHE/FETCH time (Node/Deno/Bun), never on the client.
//
// Scope: surface heavy/light rail only — railway=rail | light_rail |
// narrow_gauge. All three are collected as one undifferentiated centerline: no kind
// tag is carried through, because the renderer draws the whole layer in a single
// user-chosen symbol (see RailwayStyle / RAILWAY_MODES) and has nothing to vary per
// kind. Deliberately excluded:
//   • subway  — underground; the wallpaper shows above-ground features only.
//   • tram    — runs in the street, so it would just retrace the road network.
//   • service tracks — any `service=*` (yard, siding, spur, crossover, …), the
//     parallel yard/siding clutter around stations. Dropping them matches OSM's
//     standard rendering (openstreetmap-carto hides service track at low/mid
//     zoom, so a station reads as a few mainline tracks instead of a tangle of
//     sidings). Enforced twice — see isServiceTrack.
// These match the roads/water/airports convention of drawing what's visible on
// the ground.

type RawGeom = { lat: number; lon: number };
type RawWay = { type: "way"; tags?: Record<string, string>; geometry?: RawGeom[] };
type RawOsm = { elements?: RawWay[] };

/** OSM `railway` values we collect (surface heavy/light rail). */
const RAIL_TYPES = ["rail", "light_rail", "narrow_gauge"] as const;

/**
 * Is this a service track? The slim-side twin of `railwaysSelector`'s
 * `[!service]`: both ask only whether the key is *present*, whatever its value,
 * so the two can't drift apart on some `service=` value nobody enumerated. See
 * the header for why these are excluded.
 */
const isServiceTrack = (tags: RawWay["tags"]) => tags?.service !== undefined;

/**
 * Union-query fragment selecting surface railway ways — composed by
 * fetch-city.ts. `[!service]` drops service tracks at query time, so their
 * geometry never crosses the wire (see the header, and isServiceTrack for the
 * slim-side guarantee).
 */
export function railwaysSelector(b: Bbox): string {
  const bb = `${b.south},${b.west},${b.north},${b.east}`;
  const re = `^(${RAIL_TYPES.join("|")})$`;
  return `way[railway~"${re}"][!service](${bb});`;
}

/**
 * Slim a raw Overpass response to surface railway centerlines. Service tracks are
 * skipped here as well as in the query, so any payload is cleaned even if it
 * carried them (see isServiceTrack).
 */
export function slimRailways(raw: RawOsm, coordPrecision?: number): RailwayFeature[] {
  const features: RailwayFeature[] = [];

  for (const el of raw.elements ?? []) {
    if (el.type !== "way" || !el.geometry || el.geometry.length < 2) continue;
    const rail = el.tags?.railway;
    if (!rail || !(RAIL_TYPES as readonly string[]).includes(rail)) continue;
    if (isServiceTrack(el.tags)) continue;
    const pts = dedupeAdjacent(el.geometry);
    if (pts.length < 2) continue;
    features.push({ line: pts });
  }

  return coordPrecision === undefined ? features : roundFeatures(features, coordPrecision);
}

function roundFeatures(features: RailwayFeature[], precision: number): RailwayFeature[] {
  return features.map((feat) => ({ line: roundPts(feat.line, precision) }));
}
