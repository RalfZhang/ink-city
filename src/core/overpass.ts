import type { Bbox, Osm } from "./types";

// Overpass road-geometry fetch with mirror fallback. Uses the global `fetch`,
// so it runs in the browser, in Node 18+ (the CI pre-cache script), and in
// Deno. The only Overpass client in the codebase — src-tauri's live fallback
// shells out to this via scripts/osm-cli.ts (see src-tauri/src/osm_sidecar.rs)
// instead of maintaining a separate Rust implementation.

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type FetchOptions = {
  /** Extra retry rounds over the whole mirror list after the first. */
  retries?: number;
  /** Base backoff between rounds (doubles each round). */
  backoffMs?: number;
};

/**
 * Fetch road geometry for `b`, trying each mirror in turn. Overpass returns 429
 * ("rate limited — slow down") and 504 ("no free slot") under load, especially
 * from shared IPs like CI runners, so when a whole round of mirrors fails on
 * those we wait and retry rather than giving up. Honors the server's
 * `Retry-After` header when present, otherwise uses exponential backoff with
 * jitter. Throws only after all retries are exhausted.
 */
export async function fetchRoads(
  b: Bbox,
  mirrors: readonly string[] = MIRRORS,
  opts: FetchOptions = {},
): Promise<Osm> {
  return (await fetchOverpass(buildQuery(b), mirrors, opts)) as Osm;
}

/**
 * POST an arbitrary Overpass QL `query` to the mirrors with the same rate-limit
 * handling as {@link fetchRoads}. Returns the parsed JSON untyped — callers
 * shape it (roads, water, …). Shared by `fetchRoads` and the water fetch.
 */
export async function fetchOverpass(
  query: string,
  mirrors: readonly string[] = MIRRORS,
  opts: FetchOptions = {},
): Promise<unknown> {
  const retries = opts.retries ?? 4;
  const backoffMs = opts.backoffMs ?? 15_000;
  let lastErr: unknown;

  for (let round = 0; round <= retries; round++) {
    let retryAfterMs = 0;
    for (const url of mirrors) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            // Overpass rejects requests without a User-Agent (HTTP 406). Node's
            // fetch sends none by default; browsers ignore this header (the
            // website fetches from the CDN, not Overpass, so it's moot there).
            "User-Agent": "InkCity/0.1 (https://github.com/RalfZhang/ink-city)",
          },
          body: `data=${encodeURIComponent(query)}`,
        });
        if (res.status === 429 || res.status === 504) {
          const ra = Number(res.headers.get("retry-after"));
          if (Number.isFinite(ra) && ra > 0) retryAfterMs = Math.max(retryAfterMs, ra * 1000);
          lastErr = new Error(`HTTP ${res.status}`);
          continue; // overloaded — try the next mirror, then back off
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      } catch (e) {
        lastErr = e;
      }
    }
    if (round < retries) {
      const backoff = backoffMs * 2 ** round;
      const wait = Math.max(retryAfterMs, backoff) + Math.random() * 1000;
      console.warn(
        `[overpass] all mirrors failed (${String(lastErr)}); retrying in ${Math.round(wait / 1000)}s ` +
          `(round ${round + 1}/${retries})`,
      );
      await sleep(wait);
    }
  }
  throw new Error(`all Overpass mirrors failed: ${String(lastErr)}`);
}
