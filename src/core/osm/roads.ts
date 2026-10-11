import type { Bbox, Geom, Osm } from "../types";
import { isClosed } from "../geom";

// The road network — the always-present base layer every city has (unlike the
// optional water/airports/railways/aerialways layers). Selector + slim only;
// the Overpass HTTP transport it relies on lives in ./overpass, shared with
// every other layer. Like the other layer modules, this contributes a selector
// to fetch-city.ts's single union query and slims that query's raw response
// down to what the renderer reads.
//
// Area-mapped highways are dropped, following openstreetmap-carto. A closed way
// that carto's `is_area()` calls a polygon lands in planet_osm_polygon, which no
// roads layer reads: only `highway-area-fill`/`-casing` pick it up (pedestrian,
// footway, service, living_street, platform — as fills, from z14–z16), or
// `landcover` (services, rest_area — a landuse-pink block), and every other class
// isn't drawn at all. Our ~z14 canvas would show at most a few of those fills,
// which the ink style doesn't do; stroking their outline instead, as we used to,
// drew each pedestrian square as a ring (a 50km Xi'an crop had ~2,900, which
// smudged plazas like 大唐不夜城 into dark tangles). The test is carto's whole
// `is_area()`, not just `area=yes`: highway=services is a polygon by value and
// is mostly mapped without `area=yes`. A closed way that isn't an area (a
// roundabout, a loop road) is still a line.

type RawWay = { type: string; tags?: Record<string, string>; geometry?: Geom[] };
type RawOsm = { elements?: RawWay[] };

// openstreetmap-carto-flex.lua's tables behind `is_area()`, verbatim.
const POLYGON_KEYS = new Set([
  "abandoned:aeroway", "abandoned:amenity", "abandoned:building", "abandoned:landuse",
  "abandoned:power", "aeroway", "allotments", "amenity", "area:highway", "craft",
  "building", "building:part", "club", "golf", "emergency", "harbour", "healthcare",
  "historic", "landuse", "leisure", "man_made", "military", "natural", "office",
  "place", "power", "public_transport", "shop", "tourism", "water", "wetland",
]);
const LINESTRING_VALUES: Record<string, ReadonlySet<string>> = {
  golf: new Set(["cartpath", "hole", "path"]),
  emergency: new Set(["designated", "destination", "no", "official", "yes"]),
  historic: new Set(["citywalls"]),
  leisure: new Set(["track", "slipway"]),
  man_made: new Set(["breakwater", "cutline", "embankment", "groyne", "pipeline"]),
  natural: new Set(["cliff", "earth_bank", "tree_row", "ridge", "arete"]),
  power: new Set(["cable", "line", "minor_line"]),
  tourism: new Set(["yes"]),
};
const POLYGON_VALUES: Record<string, ReadonlySet<string>> = {
  aerialway: new Set(["station"]),
  boundary: new Set(["aboriginal_lands", "national_park", "protected_area"]),
  highway: new Set(["services", "rest_area"]),
  junction: new Set(["yes"]),
  railway: new Set(["station"]),
  waterway: new Set(["boatyard", "dam", "dock", "fuel", "riverbank"]),
};

/** carto's `is_area()`: `area=*` decides outright, else any polygon key/value does. */
function isAreaTags(tags: Record<string, string>): boolean {
  if (tags.area !== undefined) return tags.area === "yes";
  for (const [k, v] of Object.entries(tags)) {
    if (v === "no") continue;
    if (POLYGON_KEYS.has(k) && !LINESTRING_VALUES[k]?.has(v)) return true;
    if (POLYGON_VALUES[k]?.has(v)) return true;
  }
  return false;
}

/** Union-query fragment selecting the road network — composed by fetch-city.ts. */
export function roadsSelector(b: Bbox): string {
  return `way[highway](${b.south},${b.west},${b.north},${b.east});`;
}

/**
 * Strip an Overpass response down to only what the renderer reads: `way`
 * elements with a `highway` tag and a 2+ point geometry, minus area-mapped ones
 * (see the header). Drops node ids, bounds and every other tag. Optionally
 * rounds coordinates to `coordPrecision` decimals (5 ≈ 1m, sub-pixel at our 20km
 * scale) to shrink the payload further. Used to keep the CDN-served cache small
 * for slow/blocked networks.
 */
export function slimRoads(osm: RawOsm, coordPrecision?: number): Osm {
  const round = (v: number) =>
    coordPrecision === undefined
      ? v
      : Math.round(v * 10 ** coordPrecision) / 10 ** coordPrecision;
  const elements = (osm.elements ?? [])
    .filter(
      (el) =>
        el.type === "way" &&
        !!el.tags?.highway &&
        !!el.geometry &&
        el.geometry.length >= 2 &&
        !(isClosed(el.geometry) && isAreaTags(el.tags)),
    )
    .map((el) => ({
      type: "way" as const,
      geometry: el.geometry!.map((g) => ({ lat: round(g.lat), lon: round(g.lon) })),
      tags: { highway: el.tags!.highway },
    }));
  return { elements };
}
