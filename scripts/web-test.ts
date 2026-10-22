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
//     the roads laid out for inking in (map/growth.ts) only for the frame that asks:
//     each road split at its highest point, in the frame's pixels and drawScene's
//     widths, started as the front coming down reaches it,
//   • the save's fallback to memory when the browser won't store it (lib/storage.ts),
//     who counts as a returning player (lib/recent.ts), the result as it's shared
//     (game/share.ts), the globe's projection and zoom (game/globe/sphere.ts), and
//     which wheel events make one gesture, for turning pages (lib/paging.ts),
//   • which installer to lead with for which visitor (lib/platform.ts),
//   • the local date and the countdown (lib/date.ts), the city's name per language
//     (lib/city-name.ts), and the canvas size under its cap and iOS's lower one
//     (map/size.ts),
//   • the page's paper (index.css, index.html) being the map's, from defaults.json.
// Exits non-zero (printing every violation) on failure, so it can gate CI.
//
//   pnpm web-test

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bboxForScreen,
  DEFAULT_COLORS,
  MAX_HALF_KM,
  mirrorUrls,
  normalizeCountryQuery,
  SCHEDULE_DATA_DIR,
  SCHEDULE_ROOT,
  SCHEDULE_STATE_FILE,
  type City,
  type Osm,
} from "@inkcity/core";
import { emptyGuessStore, type GameSnapshot, type GuessStorage, type GuessStore } from "@inkcity/core";
import { shiftStamp } from "@inkcity/core/schedule";
import { cityName } from "../apps/web/src/lib/city-name";
import { formatCountdown, localDate, msUntilMidnight } from "../apps/web/src/lib/date";
import { detectVisitor, refineVisitor, type NavigatorLike, type Visitor } from "../apps/web/src/lib/platform";
import { memoryFallback } from "../apps/web/src/lib/storage";
import { playedWithin, RECENT_DAYS } from "../apps/web/src/lib/recent";
import { follow, NO_GESTURE } from "../apps/web/src/lib/paging";
import { matchSpan } from "../apps/web/src/game/format";
import { shareText } from "../apps/web/src/game/share";
import {
  angle,
  decodeWorld,
  fillRing,
  fitZoom,
  greatArc,
  place,
  turnFor,
  unproject,
  vec,
  viewOf,
  zoomAbout,
  type WorldData,
} from "../apps/web/src/game/globe/sphere";
import type { DayCache } from "../apps/web/src/map/cache";
import { createEngine, type Frame, type Reply, type ShowRequest } from "../apps/web/src/map/engine";
import { FRONT_EASE, SPREAD_CURVE, SPREAD_S } from "../apps/web/src/map/front";
import { growthFor, type Growth } from "../apps/web/src/map/growth";
import { loadDay, type LoadDeps } from "../apps/web/src/map/load";
import { decodeManifest, gzip, isGzip } from "../apps/web/src/map/manifest";
import { cover, IOS_MAX_SIDE, isIOS, MAX_SIDE } from "../apps/web/src/map/size";
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
    type: "show", date: DATE, theme, width, height: 900,
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
    type: "show", date: DATE, theme, width, height: 900,
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

// ---- inking the map in ------------------------------------------------------------

{
  // A 500×1000 frame round a city on the equator, so screen and ground line up; each
  // road is given in the frame's pixels and turned back into the lat/lon it'd be.
  const W = 500;
  const H = 1000;
  const at = { ...CITY, lat: 0, lon: 0 };
  const b = bboxForScreen(at.lat, at.lon, MAX_HALF_KM, W / H);
  const way = (highway: string, pts: [number, number][]) => ({
    type: "way" as const,
    tags: { highway },
    geometry: pts.map(([x, y]) => ({ lon: b.west + (x / W) * (b.east - b.west), lat: b.north - (y / H) * (b.north - b.south) })),
  });
  const day = {
    v: 8,
    city: at,
    elements: [
      way("residential", [[100, 800], [250, 200], [400, 800]]), // a Λ, highest in its middle
      way("primary", [[50, 100], [50, 500], [50, 900]]), // straight: its middle vertex adds nothing
      way("tertiary", [[300, 0], [300, 300]]), // from the very top
      way("footway", [[450, 300], [450, 600]]), // a class the map doesn't draw
      way("residential", [[100, 1200], [200, 1400]]), // off the frame
    ],
  };
  const paths = (g: Growth) =>
    Array.from({ length: g.first.length - 1 }, (_, i) => {
      const pts: [number, number][] = [];
      for (let k = g.first[i]; k < g.first[i + 1]; k++) pts.push([Math.round(g.xy[2 * k]), Math.round(g.xy[2 * k + 1])]);
      return { pts, begin: g.begin[i], length: g.cum[g.first[i + 1] - 1], cum0: g.cum[g.first[i]] };
    });
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-3;
  const delay = (d: number) => SPREAD_S * Math.pow(d / H, 0.85);

  const frame = growthFor(day, W, H);
  const got = paths(frame);
  check(got.length === 4, "every drawn road on the frame is laid out, the Λ as two halves; a footway and an off-frame road are not", got);
  const halves = got.filter((p) => p.pts[0][0] === 250 && p.pts[0][1] === 200);
  check(
    halves.length === 2 && halves.every((p) => near(p.begin, delay(200))),
    "a road highest partway along splits there, both halves growing out from it at once",
    halves,
  );
  const straight = got.find((p) => p.pts[0][0] === 50);
  check(
    straight !== undefined && straight.pts.length === 2 && near(straight.begin, delay(100)),
    "a road highest at its end grows from that end, its collinear vertices dropped",
    straight,
  );
  const edge = got.find((p) => p.pts[0][1] === 0);
  check(edge !== undefined && edge.begin === 0, "a road on the top edge starts at once", edge);
  check(
    got.every((p) => p.cum0 === 0 && p.length > 0) && near(straight!.length, 800),
    "each path measures its length from its start",
    got.map((p) => p.length),
  );
  check(
    got.every((p) => p.pts.every(([, y]) => y >= p.pts[0][1])),
    "each road grows from its highest point",
    got,
  );
  const widths = frame.strokes.map((s) => s.width);
  check(
    widths.every((w, i) => i === 0 || w > widths[i - 1]) && frame.strokes.at(-1)!.end === got.length,
    "the paths run thinnest width first, one run per width",
    frame.strokes,
  );
  let ordered = true;
  frame.strokes.forEach((s, r) => {
    for (let i = (r === 0 ? 0 : frame.strokes[r - 1].end) + 1; i < s.end; i++) ordered &&= frame.begin[i] >= frame.begin[i - 1];
  });
  check(ordered, "within a run, paths come in the order they start");
  check(near(frame.speed, H / SPREAD_S), "a path grows at the front's average pace down the frame", frame.speed);

  // The curtain's edge keeps to the front: t into SPREAD_S, the front is down to
  // (t / SPREAD_S) ^ (1 / SPREAD_CURVE) of the screen, and so is FRONT_EASE.
  const [x1, y1, x2, y2] = /^cubic-bezier\((.+)\)$/.exec(FRONT_EASE)![1].split(",").map(Number);
  const bezier = (a: number, b: number, s: number) => 3 * (1 - s) ** 2 * s * a + 3 * (1 - s) * s ** 2 * b + s ** 3;
  let off = 0;
  for (let i = 0; i <= 1000; i++) off = Math.max(off, Math.abs(bezier(y1, y2, i / 1000) - bezier(x1, x2, i / 1000) ** (1 / SPREAD_CURVE)));
  check(off < 2e-3, "the curtain's easing follows the ink front down the screen", off);

  // The page draws the square that holds every screen's crop, and inks it from the
  // top of the part on screen: that's this frame inked from its own top — the same
  // roads from the same points at the same times, just further along the square. One
  // beside the screen, on the square but off what shows, is left to the last step.
  const beside = { ...day, elements: [...day.elements, way("residential", [[-150, 100], [-100, 300]])] };
  const onSquare = growthFor(beside, H, H, { x: (H - W) / 2, y: 0, width: W, height: H });
  const moved = got.map((p) => ({ ...p, pts: p.pts.map(([x, y]) => [x + (H - W) / 2, y]) }));
  const same = paths(onSquare).every((p, i) => {
    const q = moved[i];
    return q && near(p.begin, q.begin) && near(p.length, q.length) && JSON.stringify(p.pts) === JSON.stringify(q.pts);
  });
  check(
    same && paths(onSquare).length === moved.length && near(onSquare.speed, frame.speed),
    "the square inked from the screen's top is the screen's frame inked from its own",
    { square: paths(onSquare), frame: moved },
  );
}

{
  // The engine lays a frame's roads out only when asked: the day's first frame.
  const frames: Frame[] = [];
  const show = createEngine({
    deps: deps({ cache: memoryCache({ [DATE]: encode(DAY) }) }),
    render: async () => ({}) as ImageBitmap,
    post: (reply) => reply.type === "frame" && frames.push(reply),
  });
  const req: ShowRequest = { type: "show", date: DATE, theme: "light", width: 800, height: 600 };
  show({ ...req, grow: { view: { x: 0, y: 0, width: 800, height: 600 } } });
  await new Promise((r) => setTimeout(r, 50));
  show({ ...req, width: 900 });
  await new Promise((r) => setTimeout(r, 50));
  check(
    frames.length === 2 && frames[0].growth !== undefined && frames[1].growth === undefined,
    "a frame asked to grow comes with its roads laid out, and one that isn't, without",
    frames.map((f) => f.growth !== undefined),
  );
}

// ---- who's been playing, and what they pass on ---------------------------------------

{
  // Any guess in the last week, today's included, right or wrong, makes a player a
  // returning one; a week and a day ago doesn't, and nor does a day without a guess.
  const day = (guesses: number, end?: "won" | "lost" | "skipped") => ({
    guesses: Array.from({ length: guesses }, () => ({ code: "FR", km: 1, deg: 0 })),
    ...(end ? { end } : {}),
  });
  const store = (days: GuessStore["days"]): GuessStore => ({ ...emptyGuessStore(), days });
  const today = "2026-10-21";
  check(!playedWithin(emptyGuessStore(), today), "a new player hasn't played");
  check(playedWithin(store({ [today]: day(1) }), today), "a guess today counts");
  check(playedWithin(store({ "2026-10-15": day(2, "lost") }), today), `a lost game ${RECENT_DAYS - 1} days ago counts`);
  check(!playedWithin(store({ "2026-10-14": day(1, "won") }), today), `a game ${RECENT_DAYS} days ago doesn't`);
  check(!playedWithin(store({ "2026-10-20": day(0, "skipped") }), today), "a day with no guess doesn't");
  check(!playedWithin(store({ "2026-10-22": day(1) }), today), "a day after today doesn't");
}

{
  // The shared result gives the score and every guess's warmth and direction, and no country.
  const snapshot: GameSnapshot = {
    state: "won",
    guesses: [
      { code: "JP", km: 8991, dir: "w", tier: 1, correct: false },
      { code: "BG", km: 155, dir: "w", tier: 5, correct: true },
    ],
    answer: "BG",
    stats: { played: 1, wins: 1, currentStreak: 1, maxStreak: 1, distribution: [0, 1, 0, 0, 0, 0] },
    showCityInfo: false,
    resumesTomorrow: false,
  };
  const text = shareText(snapshot, DATE, "en", "https://inkcity.ralfz.com/");
  const want = ["InkCity 2026-10-20 2/6", "■□□□□ ← 8,991 km", "■■■■■ ✓", "https://inkcity.ralfz.com/"].join("\n");
  check(text === want, "the shared result is the score, the squares and the arrows", text);
  check(!/Japan|Bulgaria|JP|BG/.test(text), "and names no country");
  const lost = shareText({ ...snapshot, state: "lost", guesses: snapshot.guesses.slice(0, 1) }, DATE, "en", "x");
  check(lost.startsWith("InkCity 2026-10-20 ✕/6"), "a lost day scores ✕", lost);
}

{
  // The globe: what faces the viewer lands in the middle, a point round the back is
  // hidden, north is up, east is to the right, and a great circle keeps to the sphere.
  const disc = { cx: 100, cy: 100, r: 100 };
  const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;
  const turn = turnFor({ lat: 42.7, lon: 23.3 });
  const mid = place(vec(42.7, 23.3), turn, disc);
  check(mid.near && near(mid.x, 100) && near(mid.y, 100), "the point the globe faces is in its middle", mid);
  check(!place(vec(-42.7, 23.3 - 180), turn, disc).near, "its antipode is round the back");
  const north = place(vec(60, 23.3), turn, disc);
  const east = place(vec(42.7, 40), turn, disc);
  check(north.y < 100 && near(north.x, 100), "north is up", north);
  check(east.x > 100, "east is to the right", east);
  const back = viewOf(vec(42.7, 23.3));
  check(near(back.lat, 42.7) && near(back.lon, 23.3), "a view turns back into the point it faces", back);
  const arc = greatArc(vec(35.7, 139.7), vec(42.7, 23.3), 32);
  let onSphere = true;
  for (let i = 0; i < arc.length; i += 3) onSphere &&= near(Math.hypot(arc[i], arc[i + 1], arc[i + 2]), 1, 1e-9);
  const ends = [arc.slice(0, 3), arc.slice(-3)].map((v) => [v[0], v[1], v[2]] as [number, number, number]);
  check(onSphere, "a great circle stays on the sphere");
  check(near(angle(ends[0], vec(35.7, 139.7)), 0) && near(angle(ends[1], vec(42.7, 23.3)), 0), "and runs from one point to the other");

  // Zooming: the point under the pointer comes back off the screen as it went on,
  // and stays under the pointer as the globe grows; the fit takes in every point.
  const view = { lat: 42.7, lon: 23.3 };
  const paris = vec(48.86, 2.35);
  const onScreen = place(paris, turnFor(view), disc);
  const back2 = unproject(onScreen.x - disc.cx, onScreen.y - disc.cy, disc.r, view);
  // Angles to within a millionth of a radian: acos is coarse next to 1.
  check(back2 !== null && angle(back2, paris) < 1e-6, "a point on screen unprojects to where it is on the Earth", back2);
  check(angle(unproject(0, 0, disc.r, view)!, vec(42.7, 23.3)) < 1e-6, "the middle of the globe is the point it faces");
  check(unproject(disc.r, disc.r, disc.r, view) === null, "past the rim is off the globe");
  for (const [dx, dy, from, to] of [[60, -40, 100, 300], [-80, 55, 400, 260], [5, 90, 120, 1200]]) {
    const under = unproject(dx, dy, from, view)!;
    const after = unproject(dx, dy, to, zoomAbout(view, from, to, dx, dy))!;
    check(angle(under, after) < 1e-6, `zooming ${from}→${to}px keeps the point under the pointer under it`, angle(under, after));
  }
  const home = vec(42.7, 23.3);
  check(near(fitZoom(home, [home]), 0.8 / Math.sin((14 * Math.PI) / 180)), "a lone point is given a country's room", fitZoom(home, [home]));
  check(near(fitZoom(home, [vec(42.7, 23.3 + 30)]), 0.8 / Math.sin(Math.acos(Math.cos((42.7 * Math.PI) / 180) ** 2 * Math.cos(Math.PI / 6) + Math.sin((42.7 * Math.PI) / 180) ** 2)), 1e-9), "the fit is set by the farthest point");
  check(fitZoom(home, [vec(-42.7, 23.3 - 180)]) === 1, "points round the back get the whole globe");

  // Land: a ring's near side filled, closed along the rim where it goes round the
  // back. The path is taken down as polygons — an arc walked in small steps, the way
  // a canvas draws it — and a point is filled if it's inside an odd number of them.
  const fill = (rings: Float64Array[], view: { lat: number; lon: number }) => {
    const polys: [number, number][][] = [];
    let poly: [number, number][] = [];
    const ctx = {
      moveTo: (x: number, y: number) => polys.push((poly = [[x, y]])),
      lineTo: (x: number, y: number) => poly.push([x, y]),
      arc: (cx: number, cy: number, r: number, from: number, to: number, ccw = false) => {
        const whole = 2 * Math.PI;
        const span = ccw
          ? from - to >= whole ? -whole : -((((from - to) % whole) + whole) % whole)
          : to - from >= whole ? whole : (((to - from) % whole) + whole) % whole;
        for (let k = 0; k <= 90; k++) poly.push([cx + r * Math.cos(from + (span * k) / 90), cy + r * Math.sin(from + (span * k) / 90)]);
      },
      closePath: () => {},
    } as unknown as CanvasRenderingContext2D;
    for (const ring of rings) fillRing(ctx, ring, turnFor(view), disc);
    const filled = (x: number, y: number) => {
      let odd = false;
      for (const p of polys) {
        for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
          const [xi, yi] = p[i];
          const [xj, yj] = p[j];
          if (yi > y !== yj > y && x < xj + ((y - yj) * (xi - xj)) / (yi - yj)) odd = !odd;
        }
      }
      return odd;
    };
    const at = (lat: number, lon: number) => {
      const p = place(vec(lat, lon), turnFor(view), disc);
      return filled(p.x, p.y);
    };
    return { polys, filled, at };
  };
  // A ring through `pts` ([lat, lon] corners), each side in steps of a degree or less.
  const ring = (pts: [number, number][]) => {
    const out: number[] = [];
    pts.forEach(([lat, lon], i) => {
      const [lat2, lon2] = pts[(i + 1) % pts.length];
      const n = Math.max(1, Math.ceil(Math.max(Math.abs(lat2 - lat), Math.abs(lon2 - lon))));
      for (let k = 0; k < n; k++) out.push(...vec(lat + ((lat2 - lat) * k) / n, lon + ((lon2 - lon) * k) / n));
    });
    out.push(...out.slice(0, 3));
    return new Float64Array(out);
  };
  const face = { lat: 0, lon: 0 };
  // Just inside the rim, `deg` round from the right (down is positive, as on a canvas).
  const rim = (deg: number): [number, number] => [100 + 98 * Math.cos((deg * Math.PI) / 180), 100 + 98 * Math.sin((deg * Math.PI) / 180)];
  // A block from 70°E to 110°E, over the rim at 90°E as seen from 0° 0°.
  const block = fill([ring([[20, 70], [20, 110], [-20, 110], [-20, 70]])], face);
  check(block.at(0, 80) && block.filled(...rim(0)) && block.filled(...rim(15)), "a country going over the rim is filled out to it", block.polys);
  check(!block.at(0, 60) && !block.filled(100, 100) && !block.filled(...rim(30)) && !block.filled(...rim(90)), "and nowhere else");
  check(fill([ring([[20, 70], [20, 110], [-20, 110], [-20, 70]])], { lat: 0, lon: -90 }).polys.length === 0, "one all round the back adds nothing");
  const whole = fill([ring([[20, -20], [20, 20], [-20, 20], [-20, -20]]), ring([[5, -5], [-5, -5], [-5, 5], [5, 5]])], face);
  check(whole.at(10, 0) && !whole.at(0, 0) && !whole.filled(...rim(0)), "one in full view is filled, a hole in it left open");
  // A U lying on its side, its bend round the back and its arms coming forward over the
  // rim: two stretches round the back, each closed by the rim, and the rim between the
  // arms, which both run along, cancelling out.
  const u = fill([ring([[20, 70], [20, 110], [-20, 110], [-20, 70], [-10, 70], [-10, 100], [10, 100], [10, 70]])], face);
  check(u.at(15, 80) && u.at(-15, 80) && u.filled(...rim(-15)) && u.filled(...rim(15)), "a country over the rim in two places is filled in both", u.polys);
  check(!u.at(0, 80) && !u.filled(...rim(0)), "and not between them, though the rim is drawn along there");
  // Antarctica, from the world itself: one ring round the pole, over the rim from the south.
  const world = decodeWorld(JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "web", "src", "game", "globe", "world.json"), "utf8")) as WorldData);
  for (const lat of [0, -10]) {
    const south = fill(world.rings.get("AQ")!, { lat, lon: 0 });
    check(
      south.at(-89, 0) && south.at(-75, 60) && !south.at(lat, 0) && !south.at(-55, 0),
      `Antarctica from ${lat}° 0°, its far coast round the back, is filled round the pole and no further`,
    );
  }
  check([...world.rings.values()].flat().every((r) => Math.hypot(r[0] - r[r.length - 3], r[1] - r[r.length - 2], r[2] - r[r.length - 1]) < 1e-9), "every country's rings close");
}

// ---- wheel gestures (lib/paging.ts) -------------------------------------------------

{
  // A run of events as a wheel or a trackpad sends them, [ms since the last, deltaY]:
  // which gesture each belongs to.
  const ids = (events: [number, number][]) => {
    let g = NO_GESTURE;
    let now = 0;
    return events.map(([gap, deltaY]) => {
      now += gap;
      g = follow(g, { deltaY }, now);
      return g.id;
    });
  };
  const same = (xs: number[]) => xs.every((x) => x === xs[0]);
  const swipe = (start = 16): [number, number][] => [
    [start, 3], [16, 8], [16, 16], [16, 28], [16, 40],
    ...[34, 29, 24, 20, 16, 13, 10, 8, 6, 4].map((d): [number, number] => [16, d]),
  ];
  check(same(ids(swipe(1000))), "a trackpad swipe and its momentum are one gesture", ids(swipe(1000)));
  // Its first, smallest scroll can't be told from the momentum it lands in; by its second it can.
  const two = ids([...swipe(1000), ...swipe()]);
  check(two[16] === two[0] + 1 && same(two.slice(16)), "a swipe begun while the last one's momentum is still coming is a new gesture", two);
  const notches = ids([[1000, 100], [40, 100], [40, 100], [300, 100], [40, 100]]);
  check(
    notches[0] === notches[2] && notches[3] === notches[0] + 1 && notches[4] === notches[3],
    "a mouse wheel's notches close together are one gesture; a pause starts the next",
    notches,
  );
  const back = ids([...swipe(1000), [16, -8], [16, -20]]);
  check(back[15] === back[0] + 1, "a change of direction starts a new gesture", back);
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

  // The part of a match that's underlined: found as typed, folded as the search folds
  // — an accent, a matra or a Thai vowel folding away rather than parting the word.
  const span = (text: string, typed: string) => JSON.stringify(matchSpan(text, normalizeCountryQuery(typed)));
  check(span("Côte d’Ivoire", "cote d") === "[0,6]", "an accent folds away, punctuation is a space", span("Côte d’Ivoire", "cote d"));
  check(span("भारत", "भारत") === "[0,4]" && span("फ्रांस", "फ्र") === "[0,3]", "Devanagari's signs fold away", [span("भारत", "भारत"), span("फ्रांस", "फ्र")]);
  check(span("ฝรั่งเศส", "ฝรั่งเศส") === "[0,8]" && span("ญี่ปุ่น", "ญี่ปุ่น") === "[0,7]", "and Thai's", [span("ฝรั่งเศส", "ฝรั่งเศส"), span("ญี่ปุ่น", "ญี่ปุ่น")]);
  check(span("Germany", "deutschland") === "null", "a match found some other way is just the name");

  // The map's square: the screen's longer side across, with the screen across its middle.
  const wide = cover(1440, 900, 2);
  check(wide.css === 1440 && wide.px === 2880, "the square is the screen's longer side across, at the pixel ratio", wide);
  check(
    wide.view.x === 0 && wide.view.y === 540 && wide.view.width === 2880 && wide.view.height === 1800,
    "and a wide screen lies across its middle",
    wide.view,
  );
  const tall = cover(390, 844, 3);
  check(tall.px === 2532 && tall.view.x === 681 && tall.view.y === 0 && tall.view.width === 1170, "a phone's, down its middle", tall);
  const fiveK = cover(2560, 1440, 2);
  check(fiveK.px === 5120, "a 5K display's is drawn at its full resolution", fiveK);
  const huge = cover(7680, 4320, 2);
  check(huge.px === MAX_SIDE && huge.css === 7680, "an 8K screen's stays under the cap, and still covers it", huge);
  const ipad = cover(3008, 1692, 2, IOS_MAX_SIDE);
  check(ipad.px === IOS_MAX_SIDE && ipad.css === 3008, "under iOS's lower cap, the same", ipad);
  const iPhone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15";
  const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";
  check(
    isIOS({ userAgent: iPhone }) && isIOS({ userAgent: mac, maxTouchPoints: 5 }) && !isIOS({ userAgent: mac, maxTouchPoints: 0 }),
    "iOS's cap is for an iPhone, and for an iPad asking as a Mac — not for a Mac",
  );
  const odd = cover(1535.2, 863.2, 1.25);
  check(
    odd.css >= 1535.2 && Number.isInteger(Math.round(odd.css * 1.25 * 1e6) / 1e6) && odd.px === Math.round(odd.css * 1.25),
    "at a fractional pixel ratio it covers, whole device pixels across",
    odd,
  );
  const low = cover(800, 600, 0.5);
  check(low.px >= 800, "a pixel ratio below 1 never draws it below its CSS size", low);
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
console.log(`✓ website: ${checks} checks (fetch ladder, day decoding, engine, ink-in, returning players, sharing, globe, wheel gestures, save fallback, visitor, dates, names, sizes, paper)`);
