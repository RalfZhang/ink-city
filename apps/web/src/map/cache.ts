// The first rung of the fetch ladder: each day's payload, kept in the browser
// exactly as it arrived (gzip, usually — a few MB rather than the 25 that it
// parses into). Once a day is in here it's never fetched again, so the day keeps
// the city it started with even if the schedule is edited later — one day, one
// city, as on the desktop (its day cache, `<date>.osm.json`). Only today and
// yesterday are kept; yesterday covers the visitor who stays past midnight.

export interface DayCache {
  read(date: string): Promise<Uint8Array | null>;
  write(date: string, bytes: Uint8Array): Promise<void>;
  /** Drop every day but `keep`. */
  prune(keep: readonly string[]): Promise<void>;
}

const NAME = "inkcity-days-v1";

/**
 * A `DayCache` over Cache Storage, keyed by a URL on this site's own origin that
 * nothing serves — the Cache API needs a URL, not a fetchable one.
 */
export function cacheStorageDayCache(caches: CacheStorage, origin: string): DayCache {
  const url = (date: string) => `${origin}/__inkcity/day/${date}`;
  const dateOf = (url: string) => url.slice(url.lastIndexOf("/") + 1);
  return {
    async read(date) {
      const res = await (await caches.open(NAME)).match(url(date));
      return res ? new Uint8Array(await res.arrayBuffer()) : null;
    },
    async write(date, bytes) {
      await (await caches.open(NAME)).put(url(date), new Response(bytes));
    },
    async prune(keep) {
      const cache = await caches.open(NAME);
      for (const req of await cache.keys()) {
        if (!keep.includes(dateOf(req.url))) await cache.delete(req);
      }
    },
  };
}

/** No Cache Storage (an insecure origin, or a browser without it): every visit fetches. */
export const noDayCache: DayCache = {
  read: async () => null,
  write: async () => {},
  prune: async () => {},
};
