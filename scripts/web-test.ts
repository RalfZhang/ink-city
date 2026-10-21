#!/usr/bin/env -S npx tsx
// Verifies the website's own logic (apps/web/src), everything that doesn't need a
// browser to run:
//   • the fetch ladder (map/load.ts): cache first and nothing else on a hit; then
//     every host in cdn.json order, `.gz` before `.json` on each, never from the HTTP
//     cache; a 200 that isn't a day (an HTML error page) skipped; a host that goes
//     quiet given up on, .json and all, while a slow one is waited for; the rebuilt
//     day stamped and cached; nothing in a day's place when everything fails; an
//     Overpass mirror that never answers left for the next,
//   • decoding a day (map/manifest.ts): gzip sniffed, a whole city required,
//   • the engine (map/engine.ts): one load per day, a burst of requests drawn once,
//     a theme switch redrawn from memory, a day that failed reloaded by a retry only,
//   • the save's fallback to memory when the browser won't store it (lib/storage.ts),
//   • which installer to lead with for which visitor (lib/platform.ts),
//   • the local date and the countdown (lib/date.ts), the city's name per language
//     (lib/city-name.ts), and the canvas size under iOS's cap (map/size.ts),
//   • the page's paper (index.css, index.html) being the map's, from defaults.json.
// Exits non-zero (printing every violation) on failure, so it can gate CI.
//
//   pnpm web-test

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_COLORS,
  mirrorUrls,
  SCHEDULE_DATA_DIR,
  SCHEDULE_ROOT,
  SCHEDULE_STATE_FILE,
  type City,
  type Osm,
} from "@inkcity/core";
import type { GuessStorage } from "@inkcity/core";
import { shiftStamp } from "@inkcity/core/schedule";
import { cityName } from "../apps/web/src/lib/city-name";
import { formatCountdown, localDate, msUntilMidnight } from "../apps/web/src/lib/date";
import { detectVisitor, refineVisitor, type NavigatorLike, type Visitor } from "../apps/web/src/lib/platform";
import { memoryFallback } from "../apps/web/src/lib/storage";
import type { DayCache } from "../apps/web/src/map/cache";
import { createEngine, type Reply, type ShowRequest } from "../apps/web/src/map/engine";
import { loadDay, type LoadDeps } from "../apps/web/src/map/load";
import { decodeManifest, gzip, isGzip } from "../apps/web/src/map/manifest";
import { MAX_CANVAS_PIXELS, pixelSize } from "../apps/web/src/map/size";
import { fetchOverpass } from "../packages/osm/src/overpass";

let checks = 0;
let failures = 0;
function check(ok: boolean, msg: string, detail?: unknown): void {
  checks++;
  if (!ok) {
    failures++;
    console.error(`✗ ${msg}`, detail === undefined ? "" : detail);
  }
}

const DATE = "2026-10-20";
const CITY: City = { id: 3176885, name: "Foggia", localName: "Foggia", country: "IT", lat: 41.462, lon: 15.5433, population: 147036 };
const DAY = { v: 8, elements: [{ type: "way", geometry: [] }], date: DATE, city: CITY };
const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

// ---- decoding a day -------------------------------------------------------------

{
  const plain = encode(DAY);
  const gz = await gzip(JSON.stringify(DAY));
  check(isGzip(gz) && !isGzip(plain), "gzip is told by its magic bytes");
  check((await decodeManifest(plain)).city.id === CITY.id, "a plain day decodes");
  check((await decodeManifest(gz)).city.id === CITY.id, "a gzipped day decodes");
  const rejects = async (bytes: Uint8Array, what: string) => {
    try {
      await decodeManifest(bytes);
      check(false, `${what} must be refused`);
    } catch {
      check(true, what);
    }
  };
  await rejects(new TextEncoder().encode("<!doctype html><title>403 Forbidden</title>"), "an HTML error page");
  await rejects(encode({ ...DAY, city: undefined }), "a day without a city");
  await rejects(encode({ ...DAY, city: { ...CITY, localName: undefined } }), "a day whose city is missing a field");
  await rejects(encode({ ...DAY, elements: [] }), "a day without roads");
  await rejects(gz.slice(0, gz.length / 2), "a cut-off gzip");
}

// ---- the fetch ladder -----------------------------------------------------------

type Call = { url: string; cache: RequestCache | undefined };

/** A fetch that answers from `routes` (by exact URL; a function for anything fancier) and records every call. */
function fakeFetch(routes: Record<string, () => Response | Promise<Response>>, calls: Call[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, cache: init?.cache });
    const route = routes[url];
    if (!route) throw new TypeError("network error");
    return route();
  }) as typeof fetch;
}

function memoryCache(initial: Record<string, Uint8Array> = {}): DayCache & { days: Record<string, Uint8Array>; kept: string[][] } {
  const days = { ...initial };
  const kept: string[][] = [];
  return {
    days,
    kept,
    read: async (date) => days[date] ?? null,
    write: async (date, bytes) => void (days[date] = bytes),
    prune: async (keep) => {
      kept.push([...keep]);
      for (const d of Object.keys(days)) if (!keep.includes(d)) delete days[d];
    },
  };
}

const deps = (over: Partial<LoadDeps>): LoadDeps => ({
  fetch: fakeFetch({}, []),
  cache: memoryCache(),
  reconstruct: async () => {
    throw new Error("rung 3 not expected here");
  },
  gzip: true,
  stallTimeoutMs: 50,
  ...over,
});

const manifests = mirrorUrls(`${SCHEDULE_ROOT}/${SCHEDULE_DATA_DIR}`);
const schedules = mirrorUrls(`${SCHEDULE_ROOT}/${SCHEDULE_STATE_FILE}`);

{
  // A cached day is the whole answer.
  const calls: Call[] = [];
  const got = await loadDay(DATE, deps({ fetch: fakeFetch({}, calls), cache: memoryCache({ [DATE]: encode(DAY) }) }));
  check(got.source === "cache" && calls.length === 0, "a cached day is served without a single request", calls);
}

{
  // The first host serves an error page with a 200, the second refuses the .gz but
  // has the .json; everything before is down. Order, `.gz` first, and no-store.
  const calls: Call[] = [];
  const cache = memoryCache({ "2026-10-01": encode(DAY) });
  const html = () => new Response("<html>quota exceeded</html>", { status: 200, headers: { "content-type": "text/html" } });
  const routes = {
    [`${manifests[0]}/${DATE}.json.gz`]: html,
    [`${manifests[0]}/${DATE}.json`]: html,
    [`${manifests[1]}/${DATE}.json.gz`]: () => new Response("nope", { status: 403 }),
    [`${manifests[1]}/${DATE}.json`]: () => new Response(JSON.stringify(DAY)),
  };
  const got = await loadDay(DATE, deps({ fetch: fakeFetch(routes, calls), cache }));
  check(got.source === "cdn" && got.manifest.city.id === CITY.id, "the ladder lands on the first host serving a real day");
  const want = [
    `${manifests[0]}/${DATE}.json.gz`,
    `${manifests[0]}/${DATE}.json`,
    `${manifests[1]}/${DATE}.json.gz`,
    `${manifests[1]}/${DATE}.json`,
  ];
  check(JSON.stringify(calls.map((c) => c.url)) === JSON.stringify(want), "hosts in cdn.json order, .gz before .json", calls);
  check(calls.every((c) => c.cache === "no-store"), "no request may be answered from the HTTP cache");
  await new Promise((r) => setTimeout(r, 0)); // the write isn't awaited by the ladder
  check(cache.days[DATE] !== undefined, "the day that was fetched is cached");
  check(cache.days["2026-10-01"] === undefined, "days other than today and yesterday are pruned");
  check(JSON.stringify(cache.kept.at(-1)) === JSON.stringify([DATE, shiftStamp(DATE, -1)]), "prune keeps today and yesterday", cache.kept);
}

{
  // Without DecompressionStream there's no .gz to ask for.
  const calls: Call[] = [];
  await loadDay(DATE, deps({ gzip: false, fetch: fakeFetch({ [`${manifests[2]}/${DATE}.json`]: () => new Response(JSON.stringify(DAY)) }, calls) }));
  check(calls.every((c) => c.url.endsWith(".json")), "a browser that can't gunzip never asks for .gz", calls);
}

{
  // A host gone quiet — before its headers, or partway through its body — is given up
  // on, without being asked for its .json; one that's slow but keeps sending is waited for.
  const calls: Call[] = [];
  const gz = await gzip(JSON.stringify(DAY));
  const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const aborted = () => new DOMException("aborted", "AbortError");
  // A body as the browser streams it: `parts`, `gapMs` apart, then the end — or, if
  // it never `ends`, silence. The request's abort errors it, as it does the browser's.
  const streamed = (signal: AbortSignal | undefined, parts: Uint8Array[], gapMs: number, ends: boolean) =>
    new Response(
      new ReadableStream<Uint8Array>({
        async start(c) {
          signal?.addEventListener("abort", () => c.error(aborted()));
          for (const part of parts) {
            await tick(gapMs);
            if (signal?.aborted) return;
            c.enqueue(part);
          }
          if (ends) c.close();
        },
      }),
    );
  const quarter = Math.ceil(gz.length / 4);
  const routes: Record<string, (signal: AbortSignal | undefined) => Response | Promise<Response>> = {
    [`${manifests[0]}/${DATE}.json.gz`]: (signal) => new Promise((_, reject) => signal?.addEventListener("abort", () => reject(aborted()))),
    [`${manifests[1]}/${DATE}.json.gz`]: (signal) => streamed(signal, [gz.slice(0, quarter)], 0, false),
    [`${manifests[2]}/${DATE}.json.gz`]: (signal) => streamed(signal, [0, 1, 2, 3].map((i) => gz.slice(i * quarter, (i + 1) * quarter)), 25, true),
  };
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, cache: init?.cache });
    const route = routes[url];
    if (!route) throw new TypeError("network error");
    return route(init?.signal ?? undefined);
  }) as typeof fetch;
  const t0 = Date.now();
  const got = await loadDay(DATE, deps({ fetch: fetchFn, stallTimeoutMs: 40 }));
  check(got.source === "cdn" && Date.now() - t0 < 1000, "a stalled host costs its timeout, then the next one answers");
  check(got.manifest.city.id === CITY.id, "a body that takes longer than the timeout but keeps coming is waited for");
  const quiet = [manifests[0], manifests[1]].map((m) => `${m}/${DATE}.json`);
  check(!calls.some((c) => quiet.includes(c.url)), "a host that went quiet isn't asked for its .json", calls.map((c) => c.url));
}

{
  // Every host misses the manifest: the schedule names the city, Overpass draws it.
  const calls: Call[] = [];
  const cache = memoryCache();
  let asked: City | null = null;
  const routes = {
    [schedules[0]]: () => new Response("<html>error</html>", { status: 200 }),
    [schedules[1]]: () => new Response(JSON.stringify({ list: { [DATE]: CITY } })),
  };
  const rebuilt: Osm = { v: 8, elements: [{ type: "way" }] };
  const got = await loadDay(DATE, deps({ fetch: fakeFetch(routes, calls), cache, reconstruct: async (c) => ((asked = c), rebuilt) }));
  check(got.source === "overpass", "every manifest missing falls through to rebuilding the day");
  check(asked !== null && (asked as City).id === CITY.id, "the rebuild is of the city the schedule names");
  check(got.manifest.date === DATE && got.manifest.city.id === CITY.id, "a rebuilt day is stamped like a published one");
  check(cache.days[DATE] !== undefined && isGzip(cache.days[DATE]), "a rebuilt day is cached, gzipped");
  const manifestCalls = calls.filter((c) => c.url.includes(`/${SCHEDULE_DATA_DIR}/`));
  check(manifestCalls.length === manifests.length * 2, "the rebuild only starts once every host has missed both files", manifestCalls.length);
}

{
  // A readable schedule without the day is an answer, not a bad host.
  const calls: Call[] = [];
  const routes = { [schedules[0]]: () => new Response(JSON.stringify({ list: { "2026-10-19": CITY } })) };
  try {
    await loadDay(DATE, deps({ fetch: fakeFetch(routes, calls) }));
    check(false, "an unscheduled day must fail");
  } catch (e) {
    check(String(e).includes(DATE), "an unscheduled day fails, naming the date", String(e));
    check(calls.filter((c) => c.url.endsWith(SCHEDULE_STATE_FILE)).length === 1, "and doesn't ask the other hosts");
  }
}

{
  // Nothing anywhere: an error, and never some other city.
  try {
    await loadDay(DATE, deps({}));
    check(false, "a day nothing can produce must fail");
  } catch {
    check(true, "a day nothing can produce fails");
  }
}

// ---- rung 3's Overpass client ---------------------------------------------------

{
  // A mirror that never answers is left for the next once its time is up.
  const asked: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    asked.push(String(input));
    if (asked.length === 1)
      return new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
      );
    return new Response(JSON.stringify({ elements: [] }));
  }) as typeof fetch;
  try {
    const t0 = Date.now();
    const got = await fetchOverpass("[out:json];", ["https://hangs.test", "https://answers.test"], { retries: 0, requestTimeoutMs: 40, userAgent: null });
    check(asked.length === 2 && Date.now() - t0 < 1000, "an Overpass mirror that never answers is left for the next", asked);
    check(Array.isArray((got as { elements?: unknown }).elements), "and the next one's answer is returned");
  } finally {
    globalThis.fetch = real;
  }
}

// ---- the engine -----------------------------------------------------------------

{
  // Every load starts by reading the cache, so counting reads counts loads — fetches
  // wouldn't, since a second load would find the day cached.
  let loads = 0;
  const cache = memoryCache();
  const drawn: string[] = [];
  const replies: Reply[] = [];
  const show = createEngine({
    deps: deps({
      cache: { ...cache, read: (date) => (loads++, cache.read(date)) },
      fetch: (async () => {
        await new Promise((r) => setTimeout(r, 20));
        return new Response(JSON.stringify(DAY));
      }) as typeof fetch,
    }),
    render: async (_m, theme, width, height) => {
      drawn.push(`${theme}@${width}x${height}`);
      return {} as ImageBitmap;
    },
    post: (reply) => replies.push(reply),
  });
  const req = (theme: "light" | "dark", width: number): ShowRequest => ({
    type: "show", date: DATE, theme, width, height: 900, cssWidth: width, cssHeight: 900,
  });
  show(req("light", 800));
  show(req("light", 1000));
  show(req("dark", 1440)); // the burst while the day loads
  await new Promise((r) => setTimeout(r, 200));
  check(drawn.length === 1 && drawn[0] === "dark@1440x900", "a burst of requests during a load is drawn once, at the newest", drawn);
  check(replies.some((r) => r.type === "city"), "the city is announced once the day loads");
  show(req("light", 1440));
  await new Promise((r) => setTimeout(r, 50));
  check(loads === 1 && drawn.at(-1) === "light@1440x900", "a theme switch redraws from memory", { loads, drawn });
}

{
  // A day that failed stays failed through resizes and theme switches: only the
  // page's retry (or another day) climbs the ladder again.
  let loads = 0;
  const replies: Reply[] = [];
  const show = createEngine({
    deps: deps({ cache: { ...memoryCache(), read: async () => (loads++, null) } }),
    render: async () => {
      throw new Error("nothing should be drawn");
    },
    post: (reply) => replies.push(reply),
  });
  const req = (width: number, theme: "light" | "dark" = "light"): ShowRequest => ({
    type: "show", date: DATE, theme, width, height: 900, cssWidth: width, cssHeight: 900,
  });
  const settle = () => new Promise((r) => setTimeout(r, 50));
  show(req(800));
  show(req(1000)); // a resize while the load fails
  await settle();
  check(loads === 1 && replies.at(-1)?.type === "error", "a resize during a failing load doesn't load the day again", loads);
  const before = replies.length;
  show(req(1200));
  show(req(1200, "dark"));
  await settle();
  check(loads === 1 && replies.length === before, "nor does a resize or a theme switch after it, which leaves the error up", loads);
  show({ ...req(1200), retry: true });
  show(req(1300)); // and one during the retry
  await settle();
  check(loads === 2, "the retry loads it once more, and only once", loads);
}

// ---- the save's fallback to memory ----------------------------------------------

{
  let saved = 0;
  let degraded = 0;
  const refusing: GuessStorage = {
    load: async () => "from disk",
    save: async () => {
      saved++;
      throw new DOMException("quota", "QuotaExceededError");
    },
  };
  const storage = memoryFallback(refusing, () => degraded++);
  check((await storage.load()) === "from disk", "the browser's copy is read while it works");
  await storage.save("first"); // must not throw: the guess still counts
  await storage.save("second");
  check(degraded === 1 && saved === 1, "a refused write moves the save to memory, once", { degraded, saved });
  check((await storage.load()) === "second", "and the game reads it back from there");
}

// ---- who's visiting ---------------------------------------------------------------

{
  const UA = {
    macSafari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
    iPhone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
    android: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
    windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    linuxFirefox: "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:142.0) Gecko/20100101 Firefox/142.0",
    armLinuxFirefox: "Mozilla/5.0 (X11; Linux aarch64; rv:142.0) Gecko/20100101 Firefox/142.0",
    linuxChrome: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    chromeOS: "Mozilla/5.0 (X11; CrOS x86_64 16181.61.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  };
  const cases: [string, NavigatorLike, Visitor][] = [
    ["macOS Safari", { userAgent: UA.macSafari, maxTouchPoints: 0 }, "macos"],
    ["iPadOS (a Mac with a touchscreen)", { userAgent: UA.macSafari, maxTouchPoints: 5 }, "mobile"],
    ["iPhone", { userAgent: UA.iPhone, maxTouchPoints: 5 }, "mobile"],
    ["Android phone", { userAgent: UA.android }, "mobile"],
    ["Windows Chrome", { userAgent: UA.windows }, "windows"],
    ["Ubuntu Firefox", { userAgent: UA.linuxFirefox }, "linux"],
    ["Firefox on ARM Linux (no x86_64 package installs there)", { userAgent: UA.armLinuxFirefox }, "unknown"],
    ["ChromeOS", { userAgent: UA.chromeOS }, "unknown"],
    ["an unknown agent", { userAgent: "curl/8.7.1" }, "unknown"],
    ["hints: macOS", { userAgent: UA.windows, userAgentData: { platform: "macOS", mobile: false } }, "macos"],
    ["hints: Windows", { userAgent: UA.macSafari, userAgentData: { platform: "Windows", mobile: false } }, "windows"],
    ["hints: Linux", { userAgent: UA.windows, userAgentData: { platform: "Linux", mobile: false } }, "linux"],
    ["hints: an Android tablet (mobile false)", { userAgent: UA.android, userAgentData: { platform: "Android", mobile: false } }, "mobile"],
    ["hints: mobile", { userAgent: UA.windows, userAgentData: { platform: "Unknown", mobile: true } }, "mobile"],
    ["hints: Chrome OS", { userAgent: UA.chromeOS, userAgentData: { platform: "Chrome OS", mobile: false } }, "unknown"],
  ];
  for (const [name, nav, want] of cases) {
    const got = detectVisitor(nav);
    check(got === want, `visitor: ${name} → ${want}`, got);
  }

  // Chromium says x86_64 in every Linux user agent; only the architecture hint knows.
  const chromium = (architecture: string, platform = "Linux"): NavigatorLike => ({
    userAgent: UA.linuxChrome,
    userAgentData: { platform, mobile: false, getHighEntropyValues: async () => ({ architecture }) },
  });
  const refined: [string, NavigatorLike, Visitor][] = [
    ["Chromium on a Raspberry Pi", chromium("arm"), "unknown"],
    ["Chromium on x86 Linux", chromium("x86"), "linux"],
    ["Chromium on an ARM Windows (x64 installers run there)", { ...chromium("arm", "Windows"), userAgent: UA.windows }, "windows"],
    ["a Linux browser without the hint", { userAgent: UA.linuxFirefox }, "linux"],
  ];
  for (const [name, nav, want] of refined) {
    const got = await refineVisitor(nav, detectVisitor(nav));
    check(got === want, `visitor, refined: ${name} → ${want}`, got);
  }
}

// ---- dates, names, sizes ----------------------------------------------------------

{
  check(localDate(new Date(2026, 9, 20, 23, 59, 59)) === "2026-10-20", "the local date, not UTC's");
  check(msUntilMidnight(new Date(2026, 9, 20, 23, 59, 30)) === 30_000, "msUntilMidnight");
  check(formatCountdown(3_723_000) === "01:02:03" && formatCountdown(-5) === "00:00:00", "formatCountdown");

  const shenzhen = { name: "Shenzhen", localName: "深圳" };
  const moscow = { name: "Moscow", localName: "Москва" };
  const tokyo = { name: "Tokyo", localName: "東京" };
  const munich = { name: "Munich", localName: "München" };
  check(cityName(shenzhen, "zh-Hans") === "深圳" && cityName(shenzhen, "en") === "Shenzhen", "a Chinese city, to Chinese and English readers");
  check(cityName(moscow, "ru") === "Москва" && cityName(moscow, "zh-Hans") === "Moscow", "a Cyrillic name only to Cyrillic readers");
  check(cityName(tokyo, "ja") === "東京" && cityName(tokyo, "ko") === "Tokyo", "kanji to Japanese readers, not Korean");
  check(cityName(munich, "de") === "Munich", "a Latin-script language gets the English name");

  const hi = pixelSize(1440, 900, 2);
  check(hi.width === 2880 && hi.height === 1800, "device pixels follow the pixel ratio", hi);
  const huge = pixelSize(7680, 4320, 2);
  check(huge.width * huge.height <= MAX_CANVAS_PIXELS, "an 8K screen stays under the canvas cap", huge);
  const low = pixelSize(800, 600, 0.5);
  check(low.width === 800, "a pixel ratio below 1 never shrinks the canvas below its CSS size", low);
}

// ---- the page's paper --------------------------------------------------------------

{
  // Before the map is drawn, and in the strip its slide opens under the panel, the
  // page shows bare paper — the map's, so `--background` and the browser's
  // `theme-color` are DEFAULT_COLORS' backgrounds, spelled out because they're
  // needed before any script runs.
  const web = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "web");
  const css = readFileSync(join(web, "src", "index.css"), "utf8");
  const html = readFileSync(join(web, "index.html"), "utf8");
  const tokens = { light: ":root", dark: "\\.dark" };
  for (const theme of ["light", "dark"] as const) {
    const paper = DEFAULT_COLORS[theme].background;
    const background = new RegExp(`^${tokens[theme]} \\{[^}]*--background: (#[0-9a-f]{6});`, "m").exec(css)?.[1];
    const themeColor = new RegExp(`name="theme-color" content="(#[0-9a-f]{6})" media="\\(prefers-color-scheme: ${theme}\\)"`).exec(html)?.[1];
    check(background === paper, `index.css: the ${theme} --background is the map's paper, ${paper}`, background);
    check(themeColor === paper, `index.html: the ${theme} theme-color is the map's paper, ${paper}`, themeColor);
  }
}

if (failures > 0) {
  console.error(`✗ ${failures}/${checks} website checks failed`);
  process.exit(1);
}
console.log(`✓ website: ${checks} checks (fetch ladder, day decoding, engine, save fallback, visitor, dates, names, sizes, paper)`);
