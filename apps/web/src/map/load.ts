import {
  mirrorUrls,
  SCHEDULE_DATA_DIR,
  SCHEDULE_ROOT,
  SCHEDULE_STATE_FILE,
  type City,
  type Osm,
} from "@inkcity/core";
import { shiftDate } from "../lib/date";
import type { DayCache } from "./cache";
import { decodeManifest, gzip, parseCity, type Manifest } from "./manifest";

// Today's map, by the same ladder the desktop climbs (`pipeline::resolve_daily`):
//
//   1. this browser's copy of the day (./cache.ts);
//   2. the day's published manifest, `osm-v2/data/<date>.json[.gz]`, from each host
//      in packages/core/src/cdn.json in order — the `.gz` first on each, because
//      jsDelivr refuses a file over 20 MB and big cities' plain JSON is bigger;
//   3. the day rebuilt: its city from the schedule (`osm-v2/city-list.json`), its
//      map straight from Overpass, stamped with `{ date, city }` like a manifest;
//   4. nothing — an error. Never another city in its place: a day is one city.
//
// Every request is `cache: "no-store"`, so reuse happens on rung 1 and nowhere
// else: jsDelivr tells browsers to keep `city-list.json` for 7 days, and
// statically.io marks what it serves immutable for a year.

export type Stage = "cache" | "cdn" | "overpass";

export type LoadDeps = {
  fetch: typeof fetch;
  cache: DayCache;
  /** Rung 3's map data for `city` — `@inkcity/osm`, loaded lazily (./deps.ts). */
  reconstruct: (city: City) => Promise<Osm>;
  /** Whether the browser can gunzip (`.json.gz` is skipped without it) and gzip what rung 3 caches. */
  gzip: boolean;
  onStage?: (stage: Stage) => void;
  /** How long a host may take to start answering before the ladder moves on. */
  headersTimeoutMs?: number;
};

export type LoadedDay = { manifest: Manifest; source: Stage };

/**
 * GET `url` without the HTTP cache. Null for anything but a 2xx, and for a host
 * that hasn't started answering within `timeoutMs` — a stalled host must not hold
 * up the ones behind it. Only the wait for headers is bounded: once a host is
 * sending, a slow connection gets to finish the body.
 */
async function get(fetchFn: typeof fetch, url: string, timeoutMs: number): Promise<Uint8Array | null> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { cache: "no-store", signal: abort.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The city the schedule names for `date`, from the first host serving a readable
 * `city-list.json` — the desktop's `cdn::fetch_schedule_city`. Never gzipped (the
 * workflow only compresses the manifest dir), so there's no `.gz` to ask for.
 */
export async function scheduledCity(date: string, fetchFn: typeof fetch, timeoutMs = 15_000): Promise<City> {
  for (const url of mirrorUrls(`${SCHEDULE_ROOT}/${SCHEDULE_STATE_FILE}`)) {
    const bytes = await get(fetchFn, url, timeoutMs);
    if (!bytes) continue;
    let list: unknown;
    try {
      list = (JSON.parse(new TextDecoder().decode(bytes)) as { list?: unknown }).list;
    } catch {
      continue;
    }
    if (typeof list !== "object" || list === null || Array.isArray(list)) continue;
    // A readable schedule without today is an answer, not a bad host: the day
    // isn't scheduled, and no other host's copy of the same file will say otherwise.
    const city = parseCity((list as Record<string, unknown>)[date]);
    if (!city) throw new Error(`the schedule has no city for ${date}`);
    return city;
  }
  throw new Error("no host served the schedule");
}

export async function loadDay(date: string, deps: LoadDeps): Promise<LoadedDay> {
  const timeoutMs = deps.headersTimeoutMs ?? 15_000;
  // Best effort: a cache that can't be written is one the next visit refetches past.
  const keep = async (bytes: Uint8Array) => {
    try {
      await deps.cache.write(date, bytes);
      await deps.cache.prune([date, shiftDate(date, -1)]);
    } catch {
      // nothing to do
    }
  };

  deps.onStage?.("cache");
  const cached = await deps.cache.read(date).catch(() => null);
  if (cached) {
    try {
      return { manifest: await decodeManifest(cached), source: "cache" };
    } catch {
      // A copy that no longer decodes is worth nothing; climb past it.
    }
  }

  deps.onStage?.("cdn");
  const files = deps.gzip ? [`${date}.json.gz`, `${date}.json`] : [`${date}.json`];
  for (const base of mirrorUrls(`${SCHEDULE_ROOT}/${SCHEDULE_DATA_DIR}`)) {
    for (const file of files) {
      const bytes = await get(deps.fetch, `${base}/${file}`, timeoutMs);
      if (!bytes) continue;
      try {
        const manifest = await decodeManifest(bytes);
        await keep(bytes);
        return { manifest, source: "cdn" };
      } catch {
        // Served, but not a day (an HTML error page, a cut-off body): next.
      }
    }
  }

  deps.onStage?.("overpass");
  const city = await scheduledCity(date, deps.fetch, timeoutMs);
  const manifest: Manifest = { ...(await deps.reconstruct(city)), date, city };
  const text = JSON.stringify(manifest);
  await keep(deps.gzip ? await gzip(text) : new TextEncoder().encode(text));
  return { manifest, source: "overpass" };
}
