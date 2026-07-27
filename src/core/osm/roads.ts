import type { Bbox, Osm } from "../types";

// The road network — the always-present base layer every city has (unlike the
// optional water/airports/railways/aerialways layers). Selector + slim only;
// the Overpass HTTP transport it relies on lives in ./overpass, shared with
// every other layer. Like the other layer modules, this contributes a selector
// to fetch-city.ts's single union query and slims that query's raw response
// down to what the renderer reads.

/** Union-query fragment selecting the road network — composed by fetch-city.ts. */
export function roadsSelector(b: Bbox): string {
  return `way[highway](${b.south},${b.west},${b.north},${b.east});`;
}

/**
 * Strip an Overpass response down to only what the renderer reads: `way`
 * elements with a `highway` tag and a 2+ point geometry. Drops node ids, bounds
 * and every other tag. Optionally rounds coordinates to `coordPrecision`
 * decimals (5 ≈ 1m, sub-pixel at our 20km scale) to shrink the payload further.
 * Used to keep the CDN-served cache small for slow/blocked networks.
 */
export function slimRoads(osm: Osm, coordPrecision?: number): Osm {
  const round = (v: number) =>
    coordPrecision === undefined
      ? v
      : Math.round(v * 10 ** coordPrecision) / 10 ** coordPrecision;
  const elements = (osm.elements ?? [])
    .filter(
      (el) => el.type === "way" && !!el.tags?.highway && !!el.geometry && el.geometry.length >= 2,
    )
    .map((el) => ({
      type: "way" as const,
      geometry: el.geometry!.map((g) => ({ lat: round(g.lat), lon: round(g.lon) })),
      tags: { highway: el.tags!.highway },
    }));
  return { elements };
}
