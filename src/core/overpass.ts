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
