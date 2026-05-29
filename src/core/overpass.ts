import type { Bbox, Osm } from "./types";

// Overpass road-geometry fetch with mirror fallback. Uses the global `fetch`,
// so it runs in the browser, in Node 18+ (the CI pre-cache script), and in
// Deno. Mirrors the mirror list / query in src-tauri/src/overpass.rs.

export const MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
] as const;

export function buildQuery(b: Bbox): string {
  return `[out:json][timeout:90];way[highway](${b.south},${b.west},${b.north},${b.east});out geom;`;
}

/**
 * Strip an Overpass response down to only what the renderer reads: `way`
 * elements with a `highway` tag and a 2+ point geometry. Drops node ids, bounds
 * and every other tag. Optionally rounds coordinates to `coordPrecision`
 * decimals (5 ≈ 1m, sub-pixel at our 40km scale) to shrink the payload further.
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

/**
 * Fetch road geometry for `b`, trying each mirror in turn. Throws only if every
 * mirror fails. `mirrors` is overridable for tests / custom deployments.
 */
export async function fetchRoads(b: Bbox, mirrors: readonly string[] = MIRRORS): Promise<Osm> {
  const query = buildQuery(b);
  let lastErr: unknown;
  for (const url of mirrors) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `data=${encodeURIComponent(query)}`,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as Osm;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`all Overpass mirrors failed: ${String(lastErr)}`);
}
