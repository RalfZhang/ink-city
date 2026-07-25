#!/usr/bin/env -S npx tsx
// Single entry point for OSM data acquisition — used both as the CI batch
// pre-cacher (publishing to the `data` branch, served by jsDelivr) and, once
// compiled to a standalone binary, as the desktop app's sidecar for live
// fetches (a CDN miss on the daily rotation, or a user-entered custom
// city/coordinates, which are never precached). Both paths go through the same
// src/core/fetch-city.ts, so the live fallback always gets the same layers
// (water included) as the CDN — see that module's header for why.
//
// Usage:
//   osm-cli precache [outDir] [days]
//   osm-cli fetch --south=.. --west=.. --north=.. --east=.. [--layers=water] [--precision=5]
//
// `precache` mode: for the next N days, pick the rotation's city (same logic
// the desktop client uses) and fetch a 20km-square, slimmed for size, into
// <outDir>/<city.id>.json. Already-present cities are skipped; cities no
// longer in the window are removed. The CI workflow gzip-compresses each
// <city.id>.json into a <city.id>.json.gz sibling before publishing (both are
// served from the `data` branch — jsDelivr enforces a per-file size cap that
// the plain JSON can exceed for large/dense cities, so the client prefers the
// .gz and falls back to the plain .json for older data/clients — see
// src-tauri/src/cdn.rs).
//
// `fetch` mode: fetch exactly the given bbox and print one JSON payload to
// stdout (nothing else goes to stdout — diagnostics go to stderr). This is
// what the desktop sidecar invokes.

import { readFileSync, readdirSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { pickCityForDate, bboxForScreen, OSM_SCHEMA_VERSION, type City, type Bbox } from "../src/core/index.ts";
import { fetchCityData } from "../src/core/fetch-city.ts";
import { LAYER_IDS, isLayerId, type LayerId } from "../src/core/layers.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const COORD_PRECISION = 5;
// Match the client: bbox_for_screen(lat, lon, max_half_km = 10, aspect = 1)
// yields a 20km square that is a superset of every screen-aspect rectangle.
const MAX_HALF_KM = 10;

function loadCities(): City[] {
  const raw = readFileSync(join(ROOT, "src", "data", "cities.json"), "utf8");
  return JSON.parse(raw) as City[];
}

function parseFlags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of args) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function parseLayers(spec: string | undefined): LayerId[] {
  if (spec === undefined) return [...LAYER_IDS];
  return spec
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((id) => {
      if (!isLayerId(id)) throw new Error(`unknown layer "${id}" (known: ${LAYER_IDS.join(", ")})`);
      return id;
    });
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
  const layers = parseLayers(flags.layers);
  const precision = flags.precision !== undefined ? Number(flags.precision) : COORD_PRECISION;

  const data = await fetchCityData(bbox, { layers, coordPrecision: precision, spacingMs: 1500 });
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

/**
 * The schema version stamped on a cached payload, or `undefined` when the file
 * is missing / unreadable / corrupt / has no numeric `v`. The caller treats
 * every `undefined` as stale (→ re-fetch), which is what we want: a version-less
 * file predates the `v` stamp entirely, and a corrupt one shouldn't be trusted.
 */
function readSchemaVersion(path: string): number | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { v?: unknown };
    return typeof parsed.v === "number" ? parsed.v : undefined;
  } catch {
    return undefined;
  }
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
  const present = new Set<number>();
  for (const id of onDisk) {
    const outOfWindow = !wanted.has(id);
    const staleSchema = !outOfWindow && readSchemaVersion(join(OUT_DIR, `${id}.json`)) !== OSM_SCHEMA_VERSION;
    if (outOfWindow || staleSchema) {
      rmSync(join(OUT_DIR, `${id}.json`));
      try {
        rmSync(join(OUT_DIR, `${id}.json.gz`));
      } catch {
        // no gzip sibling to remove (e.g. published before gzip existed) — fine.
      }
      console.log(`[precache] pruned ${id}.json (${outOfWindow ? "out of window" : "stale schema v"})`);
      continue;
    }
    present.add(id);
  }

  // Track what's on disk after this run: start from what was restored *and
  // survived pruning* (all in-window and current-version now), then add each
  // city we successfully write. Used below to decide whether to alarm.
  const cached = new Set(present);
  let fetched = 0;
  let failed = 0;
  let first = true;
  for (const [id, city] of wanted) {
    if (present.has(id)) {
      console.log(`[precache] keep ${id} (${city.name}) — already cached`);
      continue;
    }
    // Space out requests so we don't hammer Overpass back-to-back.
    if (!first) await new Promise((r) => setTimeout(r, 3000));
    first = false;
    const bbox = bboxForScreen(city.lat, city.lon, MAX_HALF_KM, 1);
    try {
      const out = await fetchCityData(bbox, { coordPrecision: COORD_PRECISION, spacingMs: 1500 });
      writeFileSync(join(OUT_DIR, `${id}.json`), JSON.stringify(out));
      cached.add(id);
      fetched++;
      console.log(
        `[precache] cached ${id} (${city.name}) — ${out.elements?.length ?? 0} ways, ${out.water?.length ?? 0} water, ${out.railways?.length ?? 0} railways`,
      );
    } catch (e) {
      // Don't fail the whole run for one city; the client falls back to the
      // sidecar for any city missing from the CDN. Persistent failure is
      // surfaced via the alarm conditions below, not here.
      failed++;
      console.error(`[precache] FAILED ${id} (${city.name}): ${String(e)}`);
    }
  }

  console.log(`[precache] done — ${wanted.size} in window, ${fetched} newly fetched, ${failed} failed`);

  // Decide whether this run should fail the CI job (→ GitHub emails on a failed
  // scheduled run). Two conditions, both signalling a real problem rather than a
  // transient single-city blip that the next 6-hourly run will retry:
  //
  //   1. Systemic: we needed to fetch new cities but every attempt failed
  //      (Overpass unreachable, schema change, bbox bug, …).
  //   2. Imminent: the city the client renders today or tomorrow is still
  //      uncached after this run — exactly the case precache exists to prevent.
  const systemic = fetched === 0 && failed > 0;
  const imminentMissing: City[] = [];
  const today = new Date();
  for (let k = 0; k < Math.min(2, DAYS); k++) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + k));
    const c = pickCityForDate(d, cities);
    if (!cached.has(c.id)) imminentMissing.push(c);
  }

  if (systemic || imminentMissing.length > 0) {
    if (systemic) {
      console.error(`[precache] ALARM systemic failure — ${failed} cities needed fetching and all failed`);
    }
    if (imminentMissing.length > 0) {
      const names = imminentMissing.map((c) => `${c.id} (${c.name})`).join(", ");
      console.error(`[precache] ALARM imminent city uncached after run: ${names}`);
    }
    process.exitCode = 1;
  }
}

async function main() {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode === "fetch") return runFetch(rest);
  if (mode === "precache") return runPrecache(rest);
  throw new Error(`usage: osm-cli <precache|fetch> ...\n  precache [outDir] [days]\n  fetch --south=.. --west=.. --north=.. --east=.. [--layers=water] [--precision=5]`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
