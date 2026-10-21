#!/usr/bin/env -S npx tsx
// Verifies the website's own logic (apps/web/src), everything that doesn't need a
// browser to run:
//   • the fetch ladder (map/load.ts): cache first and nothing else on a hit; then
//     every host in cdn.json order, `.gz` before `.json` on each, never from the HTTP
//     cache; a 200 that isn't a day (an HTML error page) skipped; a host that never
//     answers given up on; the rebuilt day stamped and cached; nothing in a day's
//     place when everything fails,
//   • decoding a day (map/manifest.ts): gzip sniffed, a whole city required,
//   • the engine (map/engine.ts): one load per day, a burst of requests drawn once,
//     a theme switch redrawn from memory,
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
import { detectVisitor, type NavigatorLike, type Visitor } from "../apps/web/src/lib/platform";
import { memoryFallback } from "../apps/web/src/lib/storage";
import type { DayCache } from "../apps/web/src/map/cache";
import { createEngine, type Reply, type ShowRequest } from "../apps/web/src/map/engine";
import { loadDay, type LoadDeps } from "../apps/web/src/map/load";
import { decodeManifest, gzip, isGzip } from "../apps/web/src/map/manifest";
import { MAX_CANVAS_PIXELS, pixelSize } from "../apps/web/src/map/size";

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
  headersTimeoutMs: 50,
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
  // A host that never starts answering is given up on.
  const calls: Call[] = [];
  const hang = () => new Promise<Response>(() => {});
  const routes: Record<string, () => Response | Promise<Response>> = {
    [`${manifests[0]}/${DATE}.json.gz`]: hang,
    [`${manifests[0]}/${DATE}.json`]: hang,
    [`${manifests[1]}/${DATE}.json.gz`]: async () => new Response(await gzip(JSON.stringify(DAY))),
  };
  // A fetch that honours its abort signal, as the browser's does.
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) =>
    Promise.race([
      fakeFetch(routes, calls)(input, init),
      new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))),
    ])) as typeof fetch;
  const t0 = Date.now();
  const got = await loadDay(DATE, deps({ fetch: fetchFn, headersTimeoutMs: 40 }));
  check(got.source === "cdn" && Date.now() - t0 < 1000, "a stalled host costs its timeout, then the next one answers");
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
    chromeOS: "Mozilla/5.0 (X11; CrOS x86_64 16181.61.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  };
  const cases: [string, NavigatorLike, Visitor][] = [
    ["macOS Safari", { userAgent: UA.macSafari, maxTouchPoints: 0 }, "macos"],
    ["iPadOS (a Mac with a touchscreen)", { userAgent: UA.macSafari, maxTouchPoints: 5 }, "mobile"],
    ["iPhone", { userAgent: UA.iPhone, maxTouchPoints: 5 }, "mobile"],
    ["Android phone", { userAgent: UA.android }, "mobile"],
    ["Windows Chrome", { userAgent: UA.windows }, "windows"],
    ["Ubuntu Firefox", { userAgent: UA.linuxFirefox }, "linux"],
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
