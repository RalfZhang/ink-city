import {
  mirrorUrls,
  SCHEDULE_DATA_DIR,
  SCHEDULE_ROOT,
  SCHEDULE_STATE_FILE,
  type City,
  type Osm,
} from "@inkcity/core";
import { parseState, shiftStamp } from "@inkcity/core/schedule";
import type { DayCache } from "./cache";
import { decodeManifest, gzip, type Manifest } from "./manifest";

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
  /**
   * How long a host may send nothing — before its headers, or between chunks of its
   * body — before the ladder gives up on it.
   */
  stallTimeoutMs?: number;
};

export type LoadedDay = { manifest: Manifest; source: Stage };

/**
 * GET `url` without the HTTP cache: the body, `"failed"` for an answer that isn't
 * one (a non-2xx, a network error), or `"stalled"` for a host that went quiet for
 * `stallMs` — a stalled host must not hold up the ones behind it. Silence is what's
 * bounded, not the whole request: a slow connection that keeps sending gets to
 * finish a big day's body.
 */
async function get(fetchFn: typeof fetch, url: string, stallMs: number): Promise<Uint8Array | "failed" | "stalled"> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Restarted by each sign of life. Aborting errors the body stream too, so a read
  // waiting on a host gone quiet ends up in the catch below.
  const alive = () => {
    clearTimeout(timer);
    timer = setTimeout(() => abort.abort(), stallMs);
  };
  try {
    alive();
    const res = await fetchFn(url, { cache: "no-store", signal: abort.signal });
    if (!res.ok) return "failed";
    if (!res.body) return new Uint8Array(await res.arrayBuffer());
    alive();
    const chunks: Uint8Array[] = [];
    const reader = res.body.getReader();
    for (let r = await reader.read(); !r.done; r = await reader.read()) {
      alive();
      chunks.push(r.value);
    }
    return new Uint8Array(await new Blob(chunks).arrayBuffer());
  } catch {
    return abort.signal.aborted ? "stalled" : "failed";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The city the schedule names for `date`, from the first host serving a readable
 * `city-list.json` — the desktop's `cdn::fetch_schedule_city`. Never gzipped (the
 * workflow only compresses the manifest dir), so there's no `.gz` to ask for.
 */
async function scheduledCity(date: string, fetchFn: typeof fetch, stallMs: number): Promise<City> {
  for (const url of mirrorUrls(`${SCHEDULE_ROOT}/${SCHEDULE_STATE_FILE}`)) {
    const bytes = await get(fetchFn, url, stallMs);
    if (typeof bytes === "string") continue;
    const { state, unreadable } = parseState(new TextDecoder().decode(bytes));
    if (unreadable) continue;
    // A readable schedule without today is an answer, not a bad host: the day
    // isn't scheduled, and no other host's copy of the same file will say otherwise.
    const city = state.list[date];
    if (!city) throw new Error(`the schedule has no city for ${date}`);
    return city;
  }
  throw new Error("no host served the schedule");
}

export async function loadDay(date: string, deps: LoadDeps): Promise<LoadedDay> {
  const stallMs = deps.stallTimeoutMs ?? 15_000;
  // Best effort: a cache that can't be written is one the next visit refetches past.
  const keep = async (bytes: Uint8Array) => {
    try {
      await Promise.all([deps.cache.write(date, bytes), deps.cache.prune([date, shiftStamp(date, -1)])]);
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
      const bytes = await get(deps.fetch, `${base}/${file}`, stallMs);
      // A host that went quiet is down, not missing a file: its `.json` would only
      // cost another wait. A quick miss (a 404, a 403) is cheap to follow up.
      if (bytes === "stalled") break;
      if (bytes === "failed") continue;
      try {
        const manifest = await decodeManifest(bytes);
        // Not awaited: the first draw needn't wait on a disk write of several MB.
        void keep(bytes);
        return { manifest, source: "cdn" };
      } catch {
        // Served, but not a day (an HTML error page, a cut-off body): next.
      }
    }
  }

  deps.onStage?.("overpass");
  const city = await scheduledCity(date, deps.fetch, stallMs);
  const manifest: Manifest = { ...(await deps.reconstruct(city)), date, city };
  const text = JSON.stringify(manifest);
  await keep(deps.gzip ? await gzip(text) : new TextEncoder().encode(text));
  return { manifest, source: "overpass" };
}
