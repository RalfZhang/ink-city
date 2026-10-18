// The Overpass HTTP transport: mirror rotation + rate-limit retry. Uses the global
// `fetch`, so it runs in the browser, in Node 18+ (the CI pre-cache script), and in
// Deno. This is the codebase's only Overpass client — apps/desktop/src-tauri's live fallback
// shells out to it via scripts/osm-cli.ts (see apps/desktop/src-tauri/src/osm_sidecar.rs) rather
// than carrying a Rust one. fetch-city.ts composes every layer's selector into one
// union query and POSTs it here once.

export const MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.openstreetmap.fr/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
] as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type FetchOptions = {
  /** Extra retry rounds over the whole mirror list after the first. */
  retries?: number;
  /** Base backoff between rounds (doubles each round). */
  backoffMs?: number;
};

/**
 * The runtime error an Overpass response reports in-band, or `undefined`. A query
 * that hits its `[timeout:]` or memory limit still answers HTTP 200 with valid
 * JSON (Overpass's web_output.cc sends every runtime error with status 200); the
 * failure shows only in a `remark` written after `elements` — which is empty if
 * the query died while running and cut short if it died while printing. Taken at
 * face value, that payload gets cached as a city with no roads, or half of them.
 *
 * `remark` is every message of the run concatenated (output_json.cc), so look for
 * "runtime error" anywhere in it; a "runtime remark" on its own is informational.
 */
function runtimeError(json: unknown): string | undefined {
  const remark = (json as { remark?: unknown } | null)?.remark;
  return typeof remark === "string" && remark.includes("runtime error") ? remark : undefined;
}

/**
 * POST an Overpass QL `query` to the mirrors, trying each in turn. Overpass
 * returns 429 ("rate limited — slow down") and 504 ("no free slot") under load,
 * especially from shared IPs like CI runners, so when a whole round of mirrors
 * fails on those we wait and retry rather than giving up. A query that ran out of
 * time or memory counts as a failed mirror too, though it arrives as HTTP 200
 * (see {@link runtimeError}). Honors the server's `Retry-After` header when
 * present, otherwise uses exponential backoff with jitter. Throws only after all
 * retries are exhausted. Returns the parsed JSON untyped — callers shape it
 * (roads, water, …).
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
        const json: unknown = await res.json();
        const err = runtimeError(json);
        if (err !== undefined) throw new Error(err); // another mirror (or round) may finish it
        return json;
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
