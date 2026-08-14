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
// it, and appends exactly one day — the one that just came into range at
// `today + LOOKAHEAD_DAYS`. So editing a future day by hand is the supported way
// to override it, however far ahead: nothing re-rolls an entry that exists, and
// the next run notices the manifest no longer matches and re-fetches that day's
// map data.
//
// The persisted history is also what makes the cooldowns possible: "no repeat
// within 30 days" needs to know the surrounding 30 days, and with random picks
// that can't be recomputed — only remembered.
//
// PRODUCER-ONLY (CI). The client normally just reads `osm-v2/data/<date>.json`
// (city + map data in one request); the one exception is Dev Mode's "bypass cache
// & CDN", which reads `city-list.json` for the day's city precisely *because* it
// carries no map data (see `pipeline::resolve_daily`). Either way the client never
// recomputes a pick, so there is no Rust port to keep in lockstep. Deliberately
// NOT re-exported from ./index (the client barrel), same rule as ./osm.

// Every window below is measured in *calendar days off a date key*, never in
// entry counts. That distinction is what lets a hand-pinned day sit arbitrarily
// far in the future without distorting anything: it's simply outside every
// window until the calendar reaches it.

/** How much past history is kept, for the city cooldown to read. */
export const HISTORY_BACK_DAYS = 23;
/** How far past today the schedule is filled in (so the newest key is today+6). */
export const LOOKAHEAD_DAYS = 6;
/** No repeat of the same city within this many days *either side* of a pick. */
export const CITY_COOLDOWN_DAYS = 30;
/** No repeat of the same country within this many days *either side* of a pick. */
export const COUNTRY_COOLDOWN_DAYS = 5;
/** How far back the published `<date>.json` manifests reach (today-2 … today+6). */
export const MANIFEST_BACK_DAYS = 2;

/** Entries a steady-state schedule holds: today-23 … today+6. */
export const SCHEDULE_DAYS = HISTORY_BACK_DAYS + 1 + LOOKAHEAD_DAYS;

// INVARIANT: CITY_COOLDOWN_DAYS === HISTORY_BACK_DAYS + 1 + LOOKAHEAD_DAYS.
//
// This is what makes the retained history *exactly* long enough, with nothing to
// spare. Filling `today+6` looks back CITY_COOLDOWN_DAYS to `today-24`; the
// previous run pruned to `(today-1) - HISTORY_BACK_DAYS`, which is that same
// `today-24`. Shorten the history (or prune before picking) and `today-24` is
// gone — and it is precisely the day sitting 30 apart from `today+6`, so the only
// symptom is an occasional exactly-30-day repeat. `scheduleInvariant` asserts it;
// `schedule-test.ts` checks it too, because it can't be caught by inspection.

/**
 * Which `src/data/*.json` city pools the schedule draws from. The hyphen keeps
 * `cities.json` — the legacy population rotation's list, now only the desktop
 * name-search index — out on purpose.
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
 * Two files outside TypeScript repeat this layout literally, because neither can
 * import it:
 *
 *   - `src-tauri/src/cdn.rs` — `SCHEDULE_PATH` (root + data dir),
 *     `SCHEDULE_STATE_DIR` (the root) and `SCHEDULE_STATE_STEM` (the state file
 *     *without* its `.json`, which `fetch_from_mirrors` re-adds along with the
 *     `.gz` variant).
 *   - `.github/workflows/precache.yml` — the gzip glob and the publish guard.
 *
 * Don't go looking for those five copies by grep — the stem above matches neither
 * `osm-v2` nor `city-list.json`. `pnpm schedule-test` parses all five
 * declarations out of the two files and fails if any disagrees with the values
 * here, so a layout change is caught rather than merely documented.
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
 * spell names (`Bogotá` vs `Bogota`). `country` is *not* one of the divergences:
 * all pools carry the same ISO 3166-1 alpha-2 code per id, so which pool wins
 * never shifts whose country cooldown a city shares.
 */
export function mergePools(pools: readonly (readonly City[])[]): City[] {
  const byId = new Map<number, City>();
  for (const pool of pools) {
    for (const city of pool) byId.set(city.id, city);
  }
  return [...byId.values()];
}

/**
 * The entries within `days` calendar days *either side* of `stamp`, excluding
 * `stamp` itself.
 */
function neighbours(state: ScheduleState, stamp: string, days: number): City[] {
  const lo = shiftStamp(stamp, -days);
  const hi = shiftStamp(stamp, days);
  return stamps(state)
    .filter((k) => k !== stamp && k >= lo && k <= hi)
    .map((k) => state.list[k]);
}

/**
 * Cities eligible for `stamp`: everything in `pool` minus every city scheduled
 * within CITY_COOLDOWN_DAYS of it, minus every country scheduled within
 * COUNTRY_COOLDOWN_DAYS of it.
 *
 * Both windows are **symmetric**, and that symmetry alone is what enforces the
 * guarantee globally: for any two days closer than a cooldown, whichever was
 * filled *second* saw the other one inside its own window and excluded it. So no
 * separate "protect the future" rule is needed — a day pinned by hand months
 * ahead is honoured by every pick that later comes within range of it. The one
 * case symmetry can't cover is two days that were *both* pinned by hand; nothing
 * re-rolls an existing entry, so that conflict stands as written.
 *
 * Degrades rather than failing — the schedule must always produce a city. If
 * both filters leave nothing it drops the (softer) country rule, and if even the
 * city rule can't be met it allows the whole pool. Neither should happen for a
 * ~1000-city pool against a 30-day window, but a shrunken pool or a hand-edited
 * file could get there.
 */
export function candidatesFor(
  pool: readonly City[],
  state: ScheduleState,
  stamp: string,
): { cities: City[]; relaxed: Relaxation } {
  const usedIds = new Set(neighbours(state, stamp, CITY_COOLDOWN_DAYS).map((c) => c.id));
  const usedCountries = new Set(
    neighbours(state, stamp, COUNTRY_COOLDOWN_DAYS).map((c) => c.country),
  );

  const strict = pool.filter((c) => !usedIds.has(c.id) && !usedCountries.has(c.country));
  if (strict.length > 0) return { cities: strict, relaxed: "none" };

  const cityOnly = pool.filter((c) => !usedIds.has(c.id));
  if (cityOnly.length > 0) return { cities: cityOnly, relaxed: "country" };

  return { cities: [...pool], relaxed: "all" };
}

/** One day's filled-in pick, for logging. */
export type Appended = { stamp: string; city: City; relaxed: Relaxation };

/** Throws if the day-count constants stop satisfying the invariant above. */
export function scheduleInvariant(): void {
  const need = HISTORY_BACK_DAYS + 1 + LOOKAHEAD_DAYS;
  if (CITY_COOLDOWN_DAYS !== need) {
    throw new Error(
      `schedule constants inconsistent: CITY_COOLDOWN_DAYS=${CITY_COOLDOWN_DAYS} but ` +
        `HISTORY_BACK_DAYS+1+LOOKAHEAD_DAYS=${need} — the retained history no longer ` +
        `covers the city cooldown, which shows up only as rare exactly-N-day repeats`,
    );
  }
}

/**
 * Advance the schedule by one run: give `today + LOOKAHEAD_DAYS` a city if it
 * hasn't got one, then drop everything older than `today - HISTORY_BACK_DAYS`.
 *
 * **Only that one day is filled.** Every earlier day in the window was filled by
 * an earlier run, and a day that somehow has no entry — a hand-deletion, or a run
 * that never happened — is deliberately left empty rather than back-filled: the
 * client falls back to the rotation for it, and re-rolling a day the calendar has
 * nearly reached would fight the hand-edits this file exists to carry. Existing
 * entries are never re-rolled, which is what makes a pinned day stick.
 *
 * Pick-then-prune, never the reverse, and the two are one function so the order
 * can't be got wrong at a call site: the pick's 30-day look-back needs
 * `today-24`, which is exactly the day this prune removes. See the INVARIANT note
 * at the top of the file.
 *
 * Days *newer* than `today + LOOKAHEAD_DAYS` are left alone — those are hand-pinned
 * future days, and they simply wait for the calendar to reach them.
 */
export function advanceSchedule(
  state: ScheduleState,
  pool: readonly City[],
  today: string,
  rng: () => number = Math.random,
): { added?: Appended; dropped: string[] } {
  if (pool.length === 0) throw new Error("advanceSchedule: empty city pool");
  scheduleInvariant();

  const stamp = shiftStamp(today, LOOKAHEAD_DAYS);
  let added: Appended | undefined;
  if (state.list[stamp] === undefined) {
    const { cities, relaxed } = candidatesFor(pool, state, stamp);
    const city = cities[Math.min(cities.length - 1, Math.floor(rng() * cities.length))];
    state.list[stamp] = city;
    added = { stamp, city, relaxed };
  }

  const cutoff = shiftStamp(today, -HISTORY_BACK_DAYS);
  const dropped = stamps(state).filter((k) => k < cutoff);
  for (const k of dropped) delete state.list[k];

  return { added, dropped };
}

/**
 * The days that get a published manifest: `today-2 … today+6`, intersected with
 * what the schedule actually holds.
 *
 * Bounded by date rather than by entry count so a hand-pinned future day can't
 * take a slot — counting back from the newest *entry* would hand a manifest to a
 * day months away and push `today-2` out of the window. The two days behind today
 * are not slack: the client resolves its date from `Local::now()` while CI works
 * in UTC, so a user far enough west is still on a date CI has already moved past.
 */
export function manifestWindow(state: ScheduleState, today: string): string[] {
  const lo = shiftStamp(today, -MANIFEST_BACK_DAYS);
  const hi = shiftStamp(today, LOOKAHEAD_DAYS);
  return stamps(state).filter((k) => k >= lo && k <= hi);
}

/**
 * Whether `k` is a real `YYYY-MM-DD` day. The round-trip through `parseStamp` is
 * what rejects a well-formed but nonexistent date (`2026-02-30`, `9999-99-99`):
 * the shape alone would let one through, and JS date arithmetic would silently
 * roll it over into a neighbouring month, so it would sort into the schedule as a
 * day the client can never ask for.
 */
function isStamp(k: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) return false;
  const d = parseStamp(k);
  return !Number.isNaN(d.getTime()) && dateStamp(d) === k;
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
    if (!isStamp(stamp) || !isCity(value)) {
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
