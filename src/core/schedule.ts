import type { City } from "./types";
import { dateStamp } from "./city";

// The daily city schedule (issue #1) — carried forward as CI *state*, not derived
// from a formula.
//
// An earlier revision picked each day from a seeded PRNG, so the whole sequence
// was a pure function of (date, pool) and needed no storage. That bought
// reproducibility but made the schedule impossible to steer: pinning a chosen
// city on a chosen day meant bending the seed, and any edit to the pool
// retroactively rewrote every past day (the picks are pool *indices*).
//
// This module inverts that. Picks are genuinely random (`Math.random`) and the
// *result* is persisted to `osm-v2/city-list.json` on the `data` branch. That
// file is the schedule: CI reads it back each run, honors whatever is already in
// it, and only ever *appends* the days still missing. So editing a future day by
// hand is the supported way to override it — the next run notices the manifest
// no longer matches and re-fetches that day's map data.
//
// The persisted history is also what makes the cooldowns possible: "no repeat
// within 30 days" needs to know the last 30 days, and with random picks that
// can't be recomputed — only remembered.
//
// PRODUCER-ONLY (CI). The client just reads `osm-v2/data/<date>.json`; it never
// recomputes a pick, so there is no Rust port to keep in lockstep. Deliberately
// NOT re-exported from ./index (the client barrel), same rule as ./osm.

// The cooldown constants below count *entries*, which equals days for as long as
// the schedule is contiguous — the normal case, since every run fills the gap up
// to today+6. They diverge only while a long CI outage's backfill is clamped
// (see `advanceSchedule`), and then only in the harmless direction: an older,
// discontiguous tail makes the window reach *further* back, never less far.

/** A city won't be scheduled again while it's still in the persisted history. */
export const HISTORY_DAYS = 30;
/** A country won't be scheduled again within this many of the latest entries. */
export const COUNTRY_COOLDOWN_DAYS = 5;
/** How far past today the schedule is filled in (so the last key is today+6). */
export const LOOKAHEAD_DAYS = 6;
/** Days that get a published `<date>.json` manifest: today-2 … today+6. */
export const MANIFEST_DAYS = 9;

/**
 * Which `src/data/*.json` city pools the schedule draws from. The hyphen keeps
 * `cities.json` — the legacy population rotation's list — out on purpose.
 * Shared so the precache script and its test agree on one definition.
 */
export const SCHEDULE_POOL_RE = /^cities-.+\.json$/;

/**
 * Where the schedule is published on the `data` branch:
 *
 *     <SCHEDULE_ROOT>/<SCHEDULE_STATE_FILE>          the schedule itself
 *     <SCHEDULE_ROOT>/<SCHEDULE_DATA_DIR>/<date>.json[.gz]
 *
 * The state file sits *beside* the manifest dir rather than inside it because
 * the manifest prune and the workflow's gzip pass both sweep that dir — one
 * level up is what keeps them off it.
 *
 * Two consumers can't import these and repeat the strings literally:
 * `src-tauri/src/cdn.rs` (`SCHEDULE_PATH`) and
 * `.github/workflows/precache.yml` (the gzip glob and the publish guard).
 * Changing the layout means changing all three — grep for `osm-v2`.
 */
export const SCHEDULE_ROOT = "osm-v2";
export const SCHEDULE_STATE_FILE = "city-list.json";
export const SCHEDULE_DATA_DIR = "data";

/**
 * `osm-v2/city-list.json` — the schedule itself, keyed by `YYYY-MM-DD`.
 * Hand-editable: replace a day's city object to override it.
 */
export type ScheduleState = { list: Record<string, City> };

/** How far the cooldown filters had to be loosened to find any candidate. */
export type Relaxation = "none" | "country" | "all";

function parseStamp(stamp: string): Date {
  const [y, m, d] = stamp.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** `stamp` shifted by `days` (may be negative), as another `YYYY-MM-DD`. */
export function shiftStamp(stamp: string, days: number): string {
  const d = parseStamp(stamp);
  d.setUTCDate(d.getUTCDate() + days);
  return dateStamp(d);
}

/**
 * The state's date keys, oldest first. ISO `YYYY-MM-DD` sorts lexicographically
 * in chronological order, so this also repairs a hand-edited file whose keys
 * ended up out of insertion order.
 */
export function stamps(state: ScheduleState): string[] {
  return Object.keys(state.list).sort();
}

/**
 * Every city across the pools, deduped by `id`, with *later pools winning*.
 * Callers pass `src/data/cities-*.json` in glob (alphabetical) order, so
 * `cities-famous.json` overrides `cities-countries.json` — the two carry the
 * same ids for shared cities but differ in coordinate precision and in how they
 * spell names (`Bogotá` vs `Bogota`) and attribute dependencies (`Hong Kong` as
 * CN vs HK, which also decides whose country cooldown it shares).
 */
export function mergePools(pools: readonly (readonly City[])[]): City[] {
  const byId = new Map<number, City>();
  for (const pool of pools) {
    for (const city of pool) byId.set(city.id, city);
  }
  return [...byId.values()];
}

/**
 * Cities eligible for the next pick: everything in `pool` minus every city
 * already in the schedule, minus every city whose country appears in the last
 * `COUNTRY_COOLDOWN_DAYS` entries.
 *
 * Degrades rather than failing — the schedule must always produce a city. If
 * both filters leave nothing it drops the (softer) country rule, and if even
 * the city rule can't be met it allows the whole pool. Neither should happen
 * for a ~1000-city pool against a 30-entry history, but a shrunken pool or a
 * hand-edited file could get there.
 */
export function candidatesFor(
  pool: readonly City[],
  state: ScheduleState,
): { cities: City[]; relaxed: Relaxation } {
  const keys = stamps(state);
  const usedIds = new Set(keys.map((k) => state.list[k].id));
  const recentCountries = new Set(
    keys.slice(-COUNTRY_COOLDOWN_DAYS).map((k) => state.list[k].country),
  );

  const strict = pool.filter((c) => !usedIds.has(c.id) && !recentCountries.has(c.country));
  if (strict.length > 0) return { cities: strict, relaxed: "none" };

  const cityOnly = pool.filter((c) => !usedIds.has(c.id));
  if (cityOnly.length > 0) return { cities: cityOnly, relaxed: "country" };

  return { cities: [...pool], relaxed: "all" };
}

/** One day's filled-in pick, for logging. */
export type Appended = { stamp: string; city: City; relaxed: Relaxation };

/**
 * Give every day in the window a city, up to `today` + `LOOKAHEAD_DAYS`, picking
 * from `pool` under the cooldowns. Existing entries are never re-rolled — that's
 * what makes a hand-edited day stick.
 *
 * Sweeps the whole window rather than only appending past the last entry, so
 * three cases fall out of one loop:
 *
 *   - the normal one — append the day that just came into range;
 *   - a gap left by a CI outage — backfill it, but never from earlier than the
 *     oldest day the 30-entry window can still hold, so a long outage doesn't
 *     mint dozens of days only to prune them again;
 *   - an *interior* hole, left by `parseState` dropping a malformed entry —
 *     re-roll it, instead of leaving a day the client can only fall back on.
 *
 * An empty/first-run state starts at `today`. Note the country cooldown reads
 * the latest entries rather than the ones bracketing the day being filled, so a
 * backfilled hole is checked against its rough neighbourhood, not its exact one.
 */
export function advanceSchedule(
  state: ScheduleState,
  pool: readonly City[],
  today: string,
  rng: () => number = Math.random,
): Appended[] {
  if (pool.length === 0) throw new Error("advanceSchedule: empty city pool");

  const target = shiftStamp(today, LOOKAHEAD_DAYS);
  const earliest = shiftStamp(target, -(HISTORY_DAYS - 1));
  const first = stamps(state)[0];

  let cursor = first !== undefined ? first : today;
  if (cursor < earliest) cursor = earliest;

  const added: Appended[] = [];
  while (cursor <= target) {
    if (state.list[cursor] === undefined) {
      const { cities, relaxed } = candidatesFor(pool, state);
      const city = cities[Math.min(cities.length - 1, Math.floor(rng() * cities.length))];
      state.list[cursor] = city;
      added.push({ stamp: cursor, city, relaxed });
    }
    cursor = shiftStamp(cursor, 1);
  }
  return added;
}

/**
 * Trim `state` (in place) to the newest `HISTORY_DAYS` entries, returning the
 * dropped keys. Run after `advanceSchedule`, so the history stays exactly as
 * long as the city cooldown needs.
 */
export function pruneHistory(state: ScheduleState): string[] {
  const keys = stamps(state);
  const drop = keys.slice(0, Math.max(0, keys.length - HISTORY_DAYS));
  for (const k of drop) delete state.list[k];
  return drop;
}

/**
 * The days that get a published manifest — the newest `MANIFEST_DAYS` entries
 * (today-2 … today+6 once the schedule is full, fewer on the first runs).
 */
export function manifestWindow(state: ScheduleState): string[] {
  return stamps(state).slice(-MANIFEST_DAYS);
}

/** Whether a parsed value is usable as a `City` (guards the hand-edited file). */
function isCity(v: unknown): v is City {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.id === "number" &&
    typeof c.name === "string" &&
    typeof c.localName === "string" &&
    typeof c.country === "string" &&
    typeof c.lat === "number" &&
    typeof c.lon === "number" &&
    typeof c.population === "number"
  );
}

/**
 * Parse `city-list.json`. A bad *entry* is dropped rather than thrown on — the
 * file is hand-editable, and a typo in one day shouldn't stop the run from
 * scheduling every other day — and comes back in `rejected` so the caller can
 * warn about it.
 *
 * A bad *file* is a different thing entirely and is reported as `unreadable`:
 * either the JSON doesn't parse (one stray comma is enough) or there's no `list`
 * object at all. Since this file is the schedule's only storage, the caller must
 * not treat that as "empty" — appending to an empty state and writing it back
 * would silently discard every hand-pinned day. See `runScheduleCache`, which
 * bails out instead.
 */
export function parseState(raw: string): {
  state: ScheduleState;
  rejected: string[];
  unreadable: boolean;
} {
  const state: ScheduleState = { list: {} };
  const rejected: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state, rejected, unreadable: true };
  }
  // An array is `typeof "object"` too, and would iterate to zero entries — i.e.
  // look exactly like a legitimately empty schedule. Reject it as broken.
  const list = (parsed as { list?: unknown })?.list;
  if (typeof list !== "object" || list === null || Array.isArray(list)) {
    return { state, rejected, unreadable: true };
  }

  for (const [stamp, value] of Object.entries(list as Record<string, unknown>)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(stamp) || !isCity(value)) {
      rejected.push(stamp);
      continue;
    }
    state.list[stamp] = value;
  }
  return { state, rejected, unreadable: false };
}

/** Serialize the state with keys in chronological order (stable diffs). */
export function serializeState(state: ScheduleState): string {
  const list: Record<string, City> = {};
  for (const k of stamps(state)) list[k] = state.list[k];
  return JSON.stringify({ list }, null, 2) + "\n";
}
