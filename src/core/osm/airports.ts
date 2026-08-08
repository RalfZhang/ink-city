import type { AirportFeature, AirportKind, Bbox } from "../types";
import { dedupeAdjacent, isClosed, roundPts } from "../geom";

// The "airports" layer's selector + slim, dispatched by fetch-city.ts. Runs at
// PRECACHE/FETCH time (Node/Deno/Bun), never on the client.
//
// Scope: standalone ways only — aeroway=runway and aeroway=taxiway. Aprons and
// other filled aeroway areas are intentionally not collected: the airport reads
// as runway/taxiway alone, consistent with the road/water styling. (Aprons *were*
// collected until schema v3; a payload that predates it is invalidated by `v`,
// not read.)
//
// Both of OSM's mappings are kept, because both are in real use: a way is either
// a centerline (stroked) or a closed way standing for the paved surface itself
// (filled). Which one it is follows openstreetmap-carto, where the split happens
// at import: osm2pgsql's default.style flags `aeroway` as a `polygon` tag, so a
// *closed* aeroway way lands in planet_osm_polygon (carto's `highway-area-fill`
// layer) and an open one in planet_osm_line (carto's `aeroways` layer). Hence the
// rule below is geometric, with `area=no` as the mapper's opt-out — deliberately
// not "area=yes only", which would miss the real-world case that motivated this:
// Ceuta's runway (OSM way 112574209) is a closed way tagged nothing but
// aeroway=runway + ref + surface, and stroking it as a centerline draws a fat
// outlined ring instead of the runway.
//
// The same rule applies to taxiways, again matching carto: a ring-shaped taxiway
// *centerline* has to carry `area=no` to stay a line. Loop taxiways are rare (0 of
// the 639 taxiways across a 9-city sample were closed), so following the upstream
// convention beats second-guessing it.

type RawGeom = { lat: number; lon: number };
type RawWay = { type: "way"; tags?: Record<string, string>; geometry?: RawGeom[] };
type RawOsm = { elements?: RawWay[] };

/** Union-query fragment selecting runway/taxiway ways — composed by fetch-city.ts. */
export function airportsSelector(b: Bbox): string {
  const bb = `${b.south},${b.west},${b.north},${b.east}`;
  return `way[aeroway=runway](${bb});way[aeroway=taxiway](${bb});`;
}

/** Slim a raw Overpass response to runway/taxiway centerlines and areas. */
export function slimAirports(raw: RawOsm, coordPrecision?: number): AirportFeature[] {
  const features: AirportFeature[] = [];

  for (const el of raw.elements ?? []) {
    if (el.type !== "way" || !el.geometry || el.geometry.length < 2) continue;
    const aeroway = el.tags?.aeroway;
    if (aeroway !== "runway" && aeroway !== "taxiway") continue;

    const kind: AirportKind = aeroway;
    const pts = dedupeAdjacent(el.geometry);
    if (pts.length < 2) continue;

    if (isClosed(pts) && el.tags?.area !== "no") features.push({ kind, area: pts });
    else features.push({ kind, line: pts });
  }

  return coordPrecision === undefined ? features : roundFeatures(features, coordPrecision);
}

// Rounding a ring keeps it closed: its first and last points hold the same values
// going in, so they round to the same values coming out.
function roundFeatures(features: AirportFeature[], precision: number): AirportFeature[] {
  return features.map((feat) =>
    "area" in feat
      ? { kind: feat.kind, area: roundPts(feat.area, precision) }
      : { kind: feat.kind, line: roundPts(feat.line, precision) },
  );
}
