import { bboxForScreen, MAX_HALF_KM, type City } from "@inkcity/core";
import { cacheStorageDayCache, noDayCache } from "./cache";
import type { LoadDeps } from "./load";
import { gzipSupported } from "./manifest";

/**
 * Rung 3's map data: the day's square straight from Overpass, through the same
 * `fetchCityData` the precache and the desktop's sidecar use. Imported on demand —
 * it's the only place this site needs `@inkcity/osm` (and its polygon clipping),
 * and most visits never get here. Far less patient than the sidecar, whose user has
 * a wallpaper to wait for: one retry round, a short backoff, and a mirror that hasn't
 * delivered within 90 s left for the next (a city's whole query has taken ~35 s).
 * And no User-Agent of our own, which a browser would turn into a CORS preflight
 * (see `userAgent`).
 */
async function reconstruct(city: City) {
  const { fetchCityData, PUBLISHED_COORD_PRECISION } = await import("@inkcity/osm");
  return fetchCityData(bboxForScreen(city.lat, city.lon, MAX_HALF_KM, 1), {
    coordPrecision: PUBLISHED_COORD_PRECISION,
    overpass: { retries: 1, backoffMs: 5_000, requestTimeoutMs: 90_000, userAgent: null },
  });
}

/** What the ladder runs on in a browser — the worker's and the main thread's alike. */
export function browserDeps(): Omit<LoadDeps, "onStage"> {
  return {
    fetch: (input, init) => fetch(input, init),
    // Cache Storage exists only on a secure origin; anywhere else, every visit fetches.
    cache: typeof caches === "undefined" ? noDayCache : cacheStorageDayCache(caches, location.origin),
    reconstruct,
    gzip: gzipSupported,
  };
}
