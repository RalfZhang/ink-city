#!/usr/bin/env -S npx tsx
// Single entry point for OSM data acquisition — used both as the CI batch
// pre-cacher (publishing to the `data` branch, served by jsDelivr) and, once
// compiled to a standalone binary, as the desktop app's sidecar for live fetches (a
// CDN miss, a user-entered custom location, or Dev Mode's bypass). Both paths go
// through the same packages/osm/src/fetch-city.ts, so a live fallback always gets the
// same layers as the CDN.
//
// Usage:
//   osm-cli precache [outDir]
//   osm-cli fetch --south=.. --west=.. --north=.. --east=..
//
// `precache` mode publishes the date-keyed schedule (issue #1) under
// `<outDir>/osm-v2/`, which CI pushes to the `data` branch:
// osm-v2/data/<YYYY-MM-DD>.json is the day's city *and* its map data in one
// payload, so the client needs no rotation logic of its own. Which city each day
// gets is randomly drawn (under no-repeat cooldowns) and then *persisted* in
// osm-v2/city-list.json, which is read back on the next run — see
// packages/core/src/schedule.ts. Editing a future day in that file overrides it;
// this script re-fetches the map data to match.
//
// (The legacy id-keyed `osm/<city.id>.json` rotation that used to be published
// next to it was retired after its 2026-11-01 deprecation date.)
//
// Each payload carries a `city` envelope. The CI workflow gzips each .json
// into a .json.gz sibling before publishing; why that exists (jsDelivr's per-file
// cap, not bandwidth) is documented in .github/workflows/precache.yml, and the
// client's .gz-then-.json preference in apps/desktop/src-tauri/src/cdn.rs.
//
// `fetch` mode: fetch exactly the given bbox and print one JSON payload to
// stdout (nothing else goes to stdout — diagnostics go to stderr). This is
// what the desktop sidecar invokes.

import { readFileSync, readdirSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  bboxForScreen,
  dateStamp,
  MAX_HALF_KM,
  OSM_SCHEMA_VERSION,
  type City,
  type Bbox,
  type Osm,
} from "@inkcity/core";
import { fetchCityData } from "@inkcity/osm";
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
} from "@inkcity/core/schedule";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DATA_DIR = join(ROOT, "packages", "core", "data");

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

/** Every city across packages/core/data/cities-*.json, deduped by id (see mergePools). */
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

  const data = await fetchCityData(bbox);
  process.stdout.write(JSON.stringify(data));
}

// ---- precache mode: advance the schedule, publish to outDir ----

/** The envelope fields a published manifest carries. */
type CachedMeta = { v: number | undefined; city: { id?: unknown; name?: unknown } | undefined };

/**
 * Read the `v` + `city` envelope off a cached payload in **one** parse, or
 * `undefined` when the file is missing / unreadable / corrupt. These payloads run
 * to tens of MB, so parsing once per file per run matters.
 *
 * A missing/unreadable file (and a `v` that isn't a number) is treated as stale
 * → re-fetch, which is what we want: a version-less file predates the `v` stamp
 * entirely, and a corrupt one shouldn't be trusted.
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
 * Fetch each job's 20km square, spacing requests out so we don't hammer
 * Overpass, and hand the payload to `onFetched` to write.
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
    // The 20km square around the city (aspect 1): the client crops its screen's
    // rectangle out of it with the same MAX_HALF_KM, and the square contains every
    // such crop (`pnpm bbox-test`), so one payload serves every screen.
    const bbox = bboxForScreen(city.lat, city.lon, MAX_HALF_KM, 1);
    try {
      onFetched(key, city, await fetchCityData(bbox));
      fetched++;
    } catch (e) {
      failed++;
      warn(`[${tag}] failed to fetch ${describe(key, city)}: ${String(e)}`);
    }
  }
  return { fetched, failed };
}

async function runPrecache(args: string[]): Promise<void> {
  const OUT_DIR = args[0] ?? join(ROOT, "data");

  const { fetched, failed, aborted } = await runScheduleCache(join(OUT_DIR, SCHEDULE_ROOT));

  // Decide whether this run should fail the CI job (→ GitHub emails on a failed
  // scheduled run).
  //
  // A day we couldn't fetch is a *warning*, not a failure: the client falls back
  // to the live sidecar for anything missing from the CDN, and the job runs again
  // in 6 hours. Letting one stubborn city turn the run red forever would just
  // train us to ignore it.
  //
  // The job fails on one condition — systemic failure: we needed to fetch at
  // least MIN_NEEDED_TO_ALARM days and every single attempt failed (Overpass
  // unreachable, a schema change, a bbox bug, …). That won't fix itself on retry.
  //
  // The threshold is what keeps a *single* stubborn city quiet: once a run has
  // fetched everything but that one day, later runs have nothing else to try, and
  // without the threshold that lone failure would turn every one of them red.
  // Steady state is one new day per calendar day, so a real outage reaches the
  // threshold on its second day, when that day's city joins the backlog.
  const MIN_NEEDED_TO_ALARM = 2;
  const needed = fetched + failed;

  if (aborted) {
    // The schedule's only copy is unreadable — a human has to fix it, so this
    // one *is* worth an email even though nothing was lost (see runScheduleCache).
    process.exitCode = 1;
  } else if (needed >= MIN_NEEDED_TO_ALARM && fetched === 0) {
    console.error(`[precache] ALARM systemic failure — ${failed} days needed fetching and all failed`);
    process.exitCode = 1;
  } else if (failed > 0) {
    warn(`[precache] ${failed} of ${needed} needed days failed this run; will retry in 6h`);
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
 * again. See packages/core/src/schedule.ts for why it's stored rather than derived, and for
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
 * touch it.
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
    const { stamp, city } = added;
    console.log(`[schedule] scheduled ${stamp} → ${city.name}, ${city.country}`);
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
  throw new Error(`usage: osm-cli <precache|fetch> ...\n  precache [outDir]\n  fetch --south=.. --west=.. --north=.. --east=..`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
