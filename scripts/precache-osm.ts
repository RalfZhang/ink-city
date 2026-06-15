#!/usr/bin/env -S npx tsx
// Daily OSM pre-cache. For the next N days, pick the rotation's city (same
// logic the desktop client uses) and fetch a 40km-square road network, slimmed
// for size, into <outDir>/<city.id>.json. Already-present cities are skipped;
// cities no longer in the window are removed. The CI workflow then publishes
// <outDir> to the `data` branch, which jsDelivr serves as a CDN.
//
// Keyed by city id (not date) so the file is intrinsically tied to the city the
// client renders, dedups across the rotation, and is reusable by a future
// custom-city-list feature. Run with: npm run precache -- [outDir] [days]

import { readFileSync, readdirSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  pickCityForDate,
  bboxForScreen,
  fetchRoads,
  slimRoads,
  OSM_SCHEMA_VERSION,
  type City,
} from "../src/core/index.ts";
// water.ts is precache-only (pulls in polygon-clipping); import it directly,
// not via the client barrel.
import { fetchWater, slimWater } from "../src/core/water.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const OUT_DIR = process.argv[2] ?? join(ROOT, "data", "osm");
const DAYS = Number(process.argv[3] ?? 7);

// Match the client: bbox_for_screen(lat, lon, max_half_km = 10, aspect = 1)
// yields a 20km square that is a superset of every screen-aspect rectangle.
const MAX_HALF_KM = 10;
const COORD_PRECISION = 5;

function loadCities(): City[] {
  const raw = readFileSync(join(ROOT, "src", "data", "cities.json"), "utf8");
  return JSON.parse(raw) as City[];
}

/** Unique city ids the client will need over the next `days` days. */
function windowCities(cities: City[], days: number): Map<number, City> {
  const out = new Map<number, City>();
  const today = new Date();
  for (let k = 0; k < days; k++) {
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

async function main() {
  const cities = loadCities();
  const wanted = windowCities(cities, DAYS);
  mkdirSync(OUT_DIR, { recursive: true });
  const present = existingIds(OUT_DIR);

  // Prune cities that have rolled out of the window.
  for (const id of present) {
    if (!wanted.has(id)) {
      rmSync(join(OUT_DIR, `${id}.json`));
      console.log(`[precache] pruned ${id}.json`);
    }
  }

  // Track what's on disk after this run: start from what was restored, add each
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
      const osm = await fetchRoads(bbox);
      const slim = slimRoads(osm, COORD_PRECISION);
      // Water is a separate fetch; space it out so we don't hammer Overpass.
      await new Promise((r) => setTimeout(r, 1500));
      const rawWater = await fetchWater(bbox);
      const water = slimWater(rawWater, bbox, slim.elements?.length ?? 0, COORD_PRECISION);
      // Additive, backward-compatible: old clients read only `elements`.
      const out = { v: OSM_SCHEMA_VERSION, elements: slim.elements ?? [], water };
      writeFileSync(join(OUT_DIR, `${id}.json`), JSON.stringify(out));
      cached.add(id);
      fetched++;
      console.log(
        `[precache] cached ${id} (${city.name}) — ${out.elements.length} ways, ${water.length} water`,
      );
    } catch (e) {
      // Don't fail the whole run for one city; the client falls back to
      // Overpass for any city missing from the CDN. Persistent failure is
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

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
