#!/usr/bin/env -S npx tsx
// Single entry point for OSM data acquisition — used both as the CI batch
// pre-cacher (publishing to the `data` branch, served by jsDelivr) and, once
// compiled to a standalone binary, as the desktop app's sidecar for live fetches (a
// CDN miss, a user-entered custom location, or Dev Mode's bypass). Both paths go
// through the same src/core/osm/fetch-city.ts, so a live fallback always gets the
// same layers as the CDN.
//
// Usage:
//   osm-cli precache [outDir] [days]
//   osm-cli fetch --south=.. --west=.. --north=.. --east=.. [--precision=5]
//
// `precache` mode publishes TWO flows side by side to the `data` branch:
//
//   osm/<city.id>.json — the legacy population rotation (src/data/cities.json,
//     the same pick_for_date the desktop client computes offline). For the next
//     N days it fetches a 20km square, slimmed for size. Already-present cities
//     are skipped; cities no longer in the window are removed.
//
//   osm-v2/data/<YYYY-MM-DD>.json — the date-keyed schedule (issue #1): the
//     day's city *and* its map data in one payload, so the client needs no
//     rotation logic of its own. Which city each day gets is randomly drawn
//     (under no-repeat cooldowns) and then *persisted* in osm-v2/city-list.json,
//     which is read back on the next run — see src/core/schedule.ts. Editing a
//     future day in that file overrides it; this script re-fetches the map data
//     to match.
//
// Both payloads carry the same `city` envelope. The CI workflow gzips each .json
// into a .json.gz sibling before publishing; why that exists (jsDelivr's per-file
// cap, not bandwidth) is documented in .github/workflows/precache.yml, and the
// client's .gz-then-.json preference in src-tauri/src/cdn.rs.
//
// `fetch` mode: fetch exactly the given bbox and print one JSON payload to
// stdout (nothing else goes to stdout — diagnostics go to stderr). This is
// what the desktop sidecar invokes.

import { readFileSync, readdirSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  pickCityForDate,
  bboxForScreen,
  dateStamp,
  OSM_SCHEMA_VERSION,
  type City,
  type Bbox,
  type Osm,
} from "../src/core/index.ts";
import { fetchCityData } from "../src/core/osm/index.ts";
import {
  advanceSchedule,
  manifestWindow,
  mergePools,
  parseState,
  serializeState,
  shiftStamp,
  stamps,
  HISTORY_BACK_DAYS,
  LOOKAHEAD_DAYS,
  SCHEDULE_DATA_DIR,
  SCHEDULE_POOL_RE,
  SCHEDULE_ROOT,
  SCHEDULE_STATE_FILE,
  type ScheduleState,
} from "../src/core/schedule.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DATA_DIR = join(ROOT, "src", "data");

const COORD_PRECISION = 5;
// Match the client: bbox_for_screen(lat, lon, max_half_km = 10, aspect = 1)
// yields a 20km square that is a superset of every screen-aspect rectangle.
const MAX_HALF_KM = 10;
// Gap between consecutive Overpass fetches, so a run doesn't hammer it back-to-back.
const THROTTLE_MS = 3000;

// GitHub Actions surfaces `::warning::` lines as annotations on the run. A city
// we couldn't fetch is a warning, not a job failure — the client falls back to
// the live sidecar — so the job only goes red on the systemic case (see
// runPrecache's alarm block).
const IN_GHA = process.env.GITHUB_ACTIONS === "true";
function warn(msg: string): void {
  console.log(IN_GHA ? `::warning::${msg}` : `[warn] ${msg}`);
}

function loadCities(): City[] {
  const raw = readFileSync(join(DATA_DIR, "cities.json"), "utf8");
  return JSON.parse(raw) as City[];
}

/** Every city across src/data/cities-*.json, deduped by id (see mergePools). */
function loadSchedulePool(): City[] {
  const files = readdirSync(DATA_DIR).filter((n) => SCHEDULE_POOL_RE.test(n)).sort();
  if (files.length === 0) throw new Error(`no ${SCHEDULE_POOL_RE} pools in ${DATA_DIR}`);
  const pools = files.map((f) => JSON.parse(readFileSync(join(DATA_DIR, f), "utf8")) as City[]);
  const merged = mergePools(pools);
  console.log(
    `[schedule] pool — ${merged.length} cities from ${files.join(", ")} ` +
      `(${pools.reduce((n, p) => n + p.length, 0)} before dedupe by id)`,
  );
  return merged;
}

function parseFlags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of args) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

// ---- fetch mode: one bbox, one JSON payload to stdout ----

async function runFetch(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const need = (k: string): number => {
    const v = flags[k];
    if (v === undefined) throw new Error(`missing --${k}`);
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`--${k} must be a number`);
    return n;
  };
  const bbox: Bbox = { south: need("south"), west: need("west"), north: need("north"), east: need("east") };
  const precision = flags.precision !== undefined ? Number(flags.precision) : COORD_PRECISION;

  const data = await fetchCityData(bbox, { coordPrecision: precision });
  process.stdout.write(JSON.stringify(data));
}

// ---- precache mode: batch over the rotation window, publish to outDir ----

/** Unique city ids the client will need over the next `days` days. */
function windowCities(cities: City[], days: number): Map<number, City> {
  const out = new Map<number, City>();
  const today = new Date();
  for (let k = -2; k < days; k++) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + k));
    const c = pickCityForDate(d, cities);
    out.set(c.id, c);
  }
  return out;
}

function existingIds(dir: string): Set<number> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return new Set();
  }
  const ids = new Set<number>();
  for (const n of names) {
    const m = n.match(/^(\d+)\.json$/);
    if (m) ids.add(Number(m[1]));
  }
  return ids;
}

/** The envelope fields both published flows stamp onto a cached payload. */
type CachedMeta = { v: number | undefined; city: { id?: unknown; name?: unknown } | undefined };

/**
 * Read the `v` + `city` envelope off a cached payload in **one** parse, or
 * `undefined` when the file is missing / unreadable / corrupt. Both callers need
 * both fields, and these payloads run to tens of MB, so parsing once per file
 * per run matters.
 *
 * A missing/unreadable file (and a `v` that isn't a number) is treated as stale
 * by every caller → re-fetch, which is what we want: a version-less file
 * predates the `v` stamp entirely, and a corrupt one shouldn't be trusted.
 */
function readCachedMeta(path: string): CachedMeta | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { v?: unknown; city?: unknown };
    return {
      v: typeof parsed.v === "number" ? parsed.v : undefined,
      city:
        typeof parsed.city === "object" && parsed.city !== null
          ? (parsed.city as { id?: unknown; name?: unknown })
          : undefined,
    };
  } catch {
    return undefined;
  }
}

/**
 * Stamp `city` into an already-cached `osm/<id>.json` that predates the field,
 * so both flows' payloads carry the same envelope without re-fetching just to
 * add it. Only called for files `readCachedMeta` found to be readable but
 * city-less, so this is a one-time migration per file, not a per-run cost. The
 * gzip step re-runs with `-f` every run, so the .gz sibling can't drift out of
 * sync with the rewrite.
 */
function backfillCity(path: string, city: City): void {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...parsed, city }));
  } catch {
    // unreadable — leave it; the schema-version prune above already handles it.
  }
}

/**
 * Fetch each job's 20km square, spacing requests out so we don't hammer
 * Overpass, and hand the payload to `onFetched` to write however that flow
 * publishes it. Shared by the id-keyed and date-keyed flows so both throttle and
 * count failures identically.
 *
 * A city that fails is a `::warning::` and a counter, never a throw: the client
 * falls back to the live sidecar for anything missing from the CDN, and the job
 * retries in 6 hours. Whether a run is allowed to go red is decided once, in
 * `runPrecache`'s alarm block, from these counts.
 */
async function fetchEach<K>(
  tag: string,
  jobs: readonly (readonly [K, City])[],
  describe: (key: K, city: City) => string,
  onFetched: (key: K, city: City, osm: Osm) => void,
): Promise<{ fetched: number; failed: number }> {
  let fetched = 0;
  let failed = 0;
  let first = true;
  for (const [key, city] of jobs) {
    if (!first) await new Promise((r) => setTimeout(r, THROTTLE_MS));
    first = false;
    const bbox = bboxForScreen(city.lat, city.lon, MAX_HALF_KM, 1);
    try {
      onFetched(key, city, await fetchCityData(bbox, { coordPrecision: COORD_PRECISION }));
      fetched++;
    } catch (e) {
      failed++;
      warn(`[${tag}] failed to fetch ${describe(key, city)}: ${String(e)}`);
    }
  }
  return { fetched, failed };
}

async function runPrecache(args: string[]): Promise<void> {
  const OUT_DIR = args[0] ?? join(ROOT, "data", "osm");
  const DAYS = Number(args[1] ?? 7);

  const cities = loadCities();
  const wanted = windowCities(cities, DAYS);
  mkdirSync(OUT_DIR, { recursive: true });
  const onDisk = existingIds(OUT_DIR);

  // Prune restored cache entries we can't reuse, removing both the .json and its
  // gzip sibling (published alongside it — see .github/workflows/precache.yml) so
  // stale ids don't linger in the data branch forever. Two reasons to drop one:
  //
  //   1. Out of window — the city has rolled past the precache horizon.
  //   2. Stale schema — its `v` differs from OSM_SCHEMA_VERSION (e.g. cached
  //      before the airports layer shipped, or ahead of a future non-additive
  //      reshape). We re-fetch these below so a newly added layer backfills into
  //      already-cached cities. The drop happens up front, *before* the fetch, on
  //      purpose: if the re-fetch then fails the known-stale payload stays gone
  //      (absent from the published branch) rather than being kept — a CDN miss
  //      just falls back to the live sidecar, so discarding is always safe.
  // `present` keeps each survivor's envelope from that same parse, so the
  // city-backfill below doesn't have to re-read (and re-parse) the payload.
  const present = new Map<number, CachedMeta>();
  for (const id of onDisk) {
    const outOfWindow = !wanted.has(id);
    const meta = outOfWindow ? undefined : readCachedMeta(join(OUT_DIR, `${id}.json`));
    if (meta !== undefined && meta.v === OSM_SCHEMA_VERSION) {
      present.set(id, meta);
      continue;
    }
    rmSync(join(OUT_DIR, `${id}.json`));
    try {
      rmSync(join(OUT_DIR, `${id}.json.gz`));
    } catch {
      // no gzip sibling to remove (e.g. published before gzip existed) — fine.
    }
    console.log(`[precache] pruned ${id}.json (${outOfWindow ? "out of window" : "stale schema v"})`);
  }

  // Track what's on disk after this run: start from what was restored *and
  // survived pruning* (all in-window and current-version now), then add each
  // city we successfully write. Used below to decide whether to alarm.
  const cached = new Set(present.keys());
  const jobs: [number, City][] = [];
  for (const [id, city] of wanted) {
    const meta = present.get(id);
    if (meta === undefined) {
      jobs.push([id, city]);
      continue;
    }
    if (meta.city === undefined) backfillCity(join(OUT_DIR, `${id}.json`), city);
    console.log(`[precache] keep ${id} (${city.name}) — already cached`);
  }

  const { fetched, failed } = await fetchEach(
    "precache",
    jobs,
    (id, city) => `${id} (${city.name})`,
    (id, city, out) => {
      // Carry the same `city` envelope the schedule manifests use — harmless for
      // existing clients (they key this flow by id and ignore the extra field).
      writeFileSync(join(OUT_DIR, `${id}.json`), JSON.stringify({ ...out, city }));
      cached.add(id);
      console.log(
        `[precache] cached ${id} (${city.name}) — ${out.elements?.length ?? 0} ways, ` +
          `${out.water?.length ?? 0} water, ${out.airports?.length ?? 0} airports, ` +
          `${out.railways?.length ?? 0} railways, ${out.aerialways?.length ?? 0} aerialways`,
      );
    },
  );

  console.log(`[precache] done — ${wanted.size} in window, ${fetched} newly fetched, ${failed} failed`);

  // Also advance + publish the date-keyed schedule (issue #1) into osm-v2/, a
  // sibling of the id-keyed osm/ dir, so the same publish step ships both.
  const schedule = await runScheduleCache(join(dirname(OUT_DIR), SCHEDULE_ROOT));

  // Decide whether this run should fail the CI job (→ GitHub emails on a failed
  // scheduled run).
  //
  // A city we couldn't fetch is a *warning*, not a failure: the client falls
  // back to the live sidecar for anything missing from the CDN, and the job runs
  // again in 6 hours. Letting one stubborn city turn the run red forever would
  // just train us to ignore it.
  //
  // The job fails on one condition — systemic failure: we needed to fetch at
  // least MIN_NEEDED_TO_ALARM cities and every single attempt failed, across both
  // flows (Overpass unreachable, a schema change, a bbox bug, …). That won't fix
  // itself on retry.
  //
  // The threshold is what keeps a *single* stubborn city quiet. Steady state
  // needs about two fetches per calendar day (one rotation city, one schedule
  // day), so the day's first run still catches "Overpass is down" immediately.
  // But once the run has succeeded at everything except one city, later runs that
  // day have nothing else left to try — without the threshold that lone failure
  // would satisfy "all attempts failed" and turn every remaining run red. A real
  // outage escalates past the threshold on its own within a day, as each new day
  // adds another unfetched city and schedule day to the backlog.
  const MIN_NEEDED_TO_ALARM = 2;
  const needed = fetched + failed + schedule.fetched + schedule.failed;
  const totalFetched = fetched + schedule.fetched;
  const totalFailed = failed + schedule.failed;

  // The day the client renders today or tomorrow being uncached is the case
  // precache exists to prevent — worth an annotation, but the schedule/sidecar
  // fallbacks still cover it, so it doesn't fail the job on its own.
  const imminentMissing: City[] = [];
  const today = new Date();
  for (let k = 0; k < Math.min(2, DAYS); k++) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + k));
    const c = pickCityForDate(d, cities);
    if (!cached.has(c.id)) imminentMissing.push(c);
  }
  if (imminentMissing.length > 0) {
    warn(`[precache] rotation city uncached after run: ${imminentMissing.map((c) => `${c.id} (${c.name})`).join(", ")}`);
  }

  if (schedule.aborted) {
    // The schedule's only copy is unreadable — a human has to fix it, so this
    // one *is* worth an email even though nothing was lost (see runScheduleCache).
    process.exitCode = 1;
  } else if (needed >= MIN_NEEDED_TO_ALARM && totalFetched === 0) {
    console.error(
      `[precache] ALARM systemic failure — ${totalFailed} cities needed fetching across both flows and all failed`,
    );
    process.exitCode = 1;
  } else if (totalFailed > 0) {
    warn(`[precache] ${totalFailed} of ${needed} needed cities failed this run; will retry in 6h`);
  }
}

/** Remove a published file and its gzip sibling, tolerating either being absent. */
function removePublished(dir: string, name: string): void {
  for (const p of [join(dir, name), join(dir, `${name}.gz`)]) {
    try {
      rmSync(p);
    } catch {
      // not there (e.g. published before the gzip step existed) — fine.
    }
  }
}

/**
 * Advance and publish the date-keyed schedule (issue #1) into `osm-v2/`:
 *
 *   osm-v2/city-list.json        the schedule itself
 *   osm-v2/data/<date>.json[.gz] one day's city + map data
 *
 * `city-list.json` is read back here, given a city for `today + LOOKAHEAD_DAYS`,
 * trimmed of anything older than `today - HISTORY_BACK_DAYS`, and written out
 * again. See src/core/schedule.ts for why it's stored rather than derived, and for
 * the cooldown rules. Because it's stored, **editing a day in that file is the
 * supported way to override it** — at any distance in the future, since nothing
 * re-rolls an entry that exists and the retention window is measured in days off
 * today, not entries: this run notices the published manifest disagrees and
 * re-fetches that day's map data.
 *
 * Every day in `manifestWindow` (today-2 … today+6) gets
 * `osm-v2/data/<YYYY-MM-DD>.json = { v, ...osm, date, city }`, so the client
 * fetches a day's wallpaper (city + map data) in one request. The schedule lives
 * one level up from the manifests so the gzip/prune passes over `data/` can't
 * touch it. Additive: the id-keyed `osm/<id>.json` flow above is untouched, so
 * old clients keep working.
 *
 * Returns fetch counts (plus `aborted`, see below) so the caller can decide
 * whether to alarm. The schedule logic itself is covered by `pnpm schedule-test`.
 */
async function runScheduleCache(root: string): Promise<{ fetched: number; failed: number; aborted?: boolean }> {
  const dataDir = join(root, SCHEDULE_DATA_DIR);
  mkdirSync(dataDir, { recursive: true });
  const pool = loadSchedulePool();
  const statePath = join(root, SCHEDULE_STATE_FILE);

  // --- read the schedule we published last run (hand-edits included) ---
  let state: ScheduleState = { list: {} };
  let raw: string | undefined;
  try {
    raw = readFileSync(statePath, "utf8");
  } catch {
    console.log(`[schedule] no ${SCHEDULE_STATE_FILE} yet — starting a fresh schedule`);
  }
  if (raw !== undefined) {
    const { state: parsed, rejected, unreadable } = parseState(raw);
    // A file that exists but won't parse is *not* an empty schedule. This is the
    // schedule's only copy, so carrying on from `{}` would append a whole new
    // rotation, write it over the broken file, and silently discard every
    // hand-pinned day. Leave everything exactly as restored — the publish step
    // republishes it untouched, and the manifests already on the branch keep the
    // client going for up to six more days — and go red so a human fixes the JSON.
    if (unreadable) {
      console.error(
        `::error::[schedule] ${SCHEDULE_STATE_FILE} is not valid JSON (or has no \`list\` object) — ` +
          `leaving the schedule and its manifests untouched this run. Fix it on the data branch.`,
      );
      return { fetched: 0, failed: 0, aborted: true };
    }
    state = parsed;
    for (const k of rejected) warn(`[schedule] ${SCHEDULE_STATE_FILE}: dropped malformed entry ${k}`);
  }

  // --- give today+6 a city, then drop anything older than today-23 ---
  // One day per run; days already present (including any pinned by hand, however
  // far ahead) are left exactly as they are. `advanceSchedule` does both halves so
  // the pick can't be starved of the history it needs — see its doc.
  const today = dateStamp(new Date());
  const { added, dropped } = advanceSchedule(state, pool, today);
  if (added === undefined) {
    console.log(`[schedule] ${shiftStamp(today, LOOKAHEAD_DAYS)} already scheduled — nothing to pick`);
  } else {
    const { stamp, city, relaxed } = added;
    const note =
      relaxed === "none"
        ? ""
        : relaxed === "country"
          ? " (country cooldown relaxed — no candidate satisfied both)"
          : " (all cooldowns relaxed — pool exhausted)";
    console.log(`[schedule] scheduled ${stamp} → ${city.name}, ${city.country}${note}`);
    if (relaxed !== "none") warn(`[schedule] ${stamp} picked with relaxed cooldowns${note}`);
  }
  if (dropped.length > 0) {
    console.log(
      `[schedule] dropped ${dropped.length} day(s) older than ${shiftStamp(today, -HISTORY_BACK_DAYS)}: ${dropped.join(", ")}`,
    );
  }
  writeFileSync(statePath, serializeState(state));
  console.log(`[schedule] ${SCHEDULE_STATE_FILE} now holds ${stamps(state).length} days`);

  // --- reconcile the published manifests against the schedule ---
  // A manifest is reusable only if it's for a wanted day, carries the city that
  // day is now scheduled for (id *and* name — this is what makes a hand-edit take
  // effect), and matches the current schema version. Everything else is dropped,
  // out-of-window days here and unusable ones in the loop below.
  const wanted = manifestWindow(state, today);
  const wantedSet = new Set(wanted);
  for (const name of readdirSync(dataDir)) {
    const m = name.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
    if (!m) continue; // leaves the .gz siblings to removePublished
    const stamp = m[1];
    if (!wantedSet.has(stamp)) {
      removePublished(dataDir, name);
      console.log(`[schedule] pruned ${stamp} (out of window)`);
    }
  }

  const missing: [string, City][] = [];
  for (const stamp of wanted) {
    const name = `${stamp}.json`;
    const city = state.list[stamp];
    const meta = readCachedMeta(join(dataDir, name));
    const reason =
      meta === undefined || meta.city === undefined
        ? "unreadable or city-less"
        : meta.city.id !== city.id || meta.city.name !== city.name
          ? `rescheduled → ${city.name} (was ${String(meta.city.name)})`
          : meta.v !== OSM_SCHEMA_VERSION
            ? "stale schema v"
            : undefined;
    if (reason === undefined) {
      console.log(`[schedule] keep ${stamp} (${city.name}) — already cached`);
      continue;
    }
    // Delete before re-fetching (both the .json and its .gz sibling) so a failed
    // re-fetch leaves the day absent rather than wrong: a CDN miss falls back to
    // the live sidecar, but a stale manifest would silently render the wrong city.
    removePublished(dataDir, name);
    console.log(`[schedule] ${stamp} ${reason} — refetching`);
    missing.push([stamp, city]);
  }

  // --- fetch what's missing ---
  const { fetched, failed } = await fetchEach(
    "schedule",
    missing,
    (stamp, city) => `${stamp} (${city.name}, ${city.country})`,
    (stamp, city, osm) => {
      // City + date envelope on top of the OSM payload; `v` stays at top level so
      // readCachedMeta / the client can validate it like any cached payload.
      writeFileSync(join(dataDir, `${stamp}.json`), JSON.stringify({ ...osm, date: stamp, city }));
      console.log(`[schedule] cached ${stamp} → ${city.name}, ${city.country}`);
    },
  );

  console.log(
    `[schedule] done — ${wanted.length} days in window, ${fetched} newly fetched, ${failed} failed`,
  );
  return { fetched, failed };
}

async function main() {
  // pnpm forwards `--` through to the script instead of stripping it, so a habitual
  // `pnpm precache -- data/osm 7` would otherwise read `--` as the output directory
  // and write the whole cache into a directory of that name. `--` is never a
  // meaningful argument here, so drop it wherever it appears (as render.ts does).
  const [mode, ...rest] = process.argv.slice(2).filter((a) => a !== "--");
  if (mode === "fetch") return runFetch(rest);
  if (mode === "precache") return runPrecache(rest);
  throw new Error(`usage: osm-cli <precache|fetch> ...\n  precache [outDir] [days]\n  fetch --south=.. --west=.. --north=.. --east=.. [--precision=5]`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
