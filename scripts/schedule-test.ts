#!/usr/bin/env -S npx tsx
// Verifies the persisted daily city schedule (src/core/schedule.ts, issue #1):
//   • the pools merge/dedupe by id into one candidate list,
//   • no city repeats while it's inside the 30-day history,
//   • no country repeats within COUNTRY_COOLDOWN_DAYS (5),
//   • the schedule advances to today+6 and trims to 30 entries,
//   • existing entries are never re-rolled (so a hand-edit sticks),
//   • the state file survives a round-trip and tolerates a mangled hand-edit,
//   • candidate selection degrades instead of failing on a tiny pool.
// Exits non-zero (printing the first violation) on any failure, so it can gate CI.
//
//   npm run schedule-test

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { City } from "../src/core/index.ts";
import {
  advanceSchedule,
  candidatesFor,
  manifestWindow,
  mergePools,
  parseState,
  pruneHistory,
  serializeState,
  shiftStamp,
  stamps,
  COUNTRY_COOLDOWN_DAYS,
  HISTORY_DAYS,
  LOOKAHEAD_DAYS,
  MANIFEST_DAYS,
  SCHEDULE_POOL_RE,
  type ScheduleState,
} from "../src/core/schedule.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = join(ROOT, "src", "data");

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function check(cond: boolean, msg: string): void {
  if (!cond) fail(msg);
}

// ---- the real pools ----

// The same constant osm-cli.ts globs with, so the test can't drift from it.
const files = readdirSync(DATA_DIR).filter((n) => SCHEDULE_POOL_RE.test(n)).sort();
check(files.length > 0, "no src/data/cities-*.json pools found");
check(!files.includes("cities.json"), "cities.json must not be part of the schedule pool");

const pools = files.map((f) => JSON.parse(readFileSync(join(DATA_DIR, f), "utf8")) as City[]);
const pool = mergePools(pools);
const rawTotal = pools.reduce((n, p) => n + p.length, 0);

check(new Set(pool.map((c) => c.id)).size === pool.length, "merged pool still contains duplicate ids");
check(pool.length <= rawTotal, "merge produced more cities than the inputs held");
for (const c of pool) {
  check(
    typeof c.id === "number" && typeof c.name === "string" && typeof c.country === "string" &&
      typeof c.lat === "number" && typeof c.lon === "number",
    `merged pool has a malformed entry: ${JSON.stringify(c)}`,
  );
}
console.log(`✓ pools: ${files.join(" + ")} → ${pool.length} cities (${rawTotal} before dedupe by id)`);

// ---- a long simulated run over the real pool ----
//
// Advance one day at a time for ~3 years, pruning as the real flow does, and
// assert the cooldowns on the full emitted sequence.

const DAYS = 365 * 3;
let state: ScheduleState = { list: {} };
let day = "2026-01-01";
const emitted: { stamp: string; city: City }[] = [];
const seen = new Set<string>();

for (let i = 0; i < DAYS; i++) {
  for (const a of advanceSchedule(state, pool, day)) {
    if (!seen.has(a.stamp)) {
      seen.add(a.stamp);
      emitted.push({ stamp: a.stamp, city: a.city });
    }
    check(a.relaxed === "none", `${a.stamp}: cooldowns had to be relaxed on the real pool (${a.relaxed})`);
  }
  pruneHistory(state);
  check(
    stamps(state).length <= HISTORY_DAYS,
    `history grew past ${HISTORY_DAYS} entries (${stamps(state).length}) on ${day}`,
  );
  day = shiftStamp(day, 1);
}

check(emitted.length >= DAYS, `expected a multi-year run, got ${emitted.length} days`);
emitted.sort((a, b) => (a.stamp < b.stamp ? -1 : 1));

// Constraint 1: a city may not reappear while it's still inside the history window.
for (let i = 0; i < emitted.length; i++) {
  for (let j = Math.max(0, i - HISTORY_DAYS); j < i; j++) {
    if (emitted[j].city.id === emitted[i].city.id) {
      fail(
        `city ${emitted[i].city.name} repeated on ${emitted[i].stamp} (also ${emitted[j].stamp}, gap ${i - j} < ${HISTORY_DAYS})`,
      );
    }
  }
}

// Constraint 2: no country within the last COUNTRY_COOLDOWN_DAYS days.
for (let i = 0; i < emitted.length; i++) {
  for (let j = Math.max(0, i - COUNTRY_COOLDOWN_DAYS); j < i; j++) {
    if (emitted[j].city.country === emitted[i].city.country) {
      fail(
        `country ${emitted[i].city.country} repeated on ${emitted[i].stamp} (also ${emitted[j].stamp}, gap ${i - j} < ${COUNTRY_COOLDOWN_DAYS})`,
      );
    }
  }
}

// The dates are contiguous, with no gaps or duplicates.
for (let i = 1; i < emitted.length; i++) {
  check(
    emitted[i].stamp === shiftStamp(emitted[i - 1].stamp, 1),
    `schedule is not contiguous: ${emitted[i - 1].stamp} → ${emitted[i].stamp}`,
  );
}

const distinct = new Set(emitted.map((e) => e.city.id)).size;
console.log(
  `✓ ${emitted.length} days, ${distinct} distinct cities, contiguous, ` +
    `no city repeat < ${HISTORY_DAYS}d, no country repeat < ${COUNTRY_COOLDOWN_DAYS}d`,
);

// ---- the window the run leaves behind ----

const today = "2027-06-15";
const fresh: ScheduleState = { list: {} };
advanceSchedule(fresh, pool, today);
pruneHistory(fresh);
const keys = stamps(fresh);
check(
  keys[keys.length - 1] === shiftStamp(today, LOOKAHEAD_DAYS),
  `last scheduled day should be today+${LOOKAHEAD_DAYS}, got ${keys[keys.length - 1]}`,
);
const window = manifestWindow(fresh);
check(window.length <= MANIFEST_DAYS, `manifest window is ${window.length}, expected ≤ ${MANIFEST_DAYS}`);
check(
  window[window.length - 1] === shiftStamp(today, LOOKAHEAD_DAYS),
  "manifest window should end at today+6",
);
console.log(`✓ first run from empty: ${keys.length} scheduled, manifest window ${window.length} days`);

// A steady-state run: full history, one new day per calendar day.
const steady: ScheduleState = { list: {} };
advanceSchedule(steady, pool, today);
pruneHistory(steady);
for (let i = 0; i < HISTORY_DAYS + 5; i++) {
  advanceSchedule(steady, pool, shiftStamp(today, i + 1));
  pruneHistory(steady);
}
const steadyKeys = stamps(steady);
check(steadyKeys.length === HISTORY_DAYS, `steady state should hold ${HISTORY_DAYS} days, got ${steadyKeys.length}`);
check(manifestWindow(steady).length === MANIFEST_DAYS, "steady-state manifest window should be 9 days");
check(
  steadyKeys[0] === shiftStamp(steadyKeys[steadyKeys.length - 1], -(HISTORY_DAYS - 1)),
  "steady-state history should be a contiguous 30-day window",
);
console.log(`✓ steady state: exactly ${HISTORY_DAYS} days, ${MANIFEST_DAYS}-day manifest window`);

// ---- hand-edits are honored, not re-rolled ----

const pinned: ScheduleState = { list: {} };
advanceSchedule(pinned, pool, today);
const futureKey = shiftStamp(today, 3);
const before = { ...pinned.list };
const override = pool.find((c) => !Object.values(before).some((v) => v.id === c.id));
check(override !== undefined, "pool exhausted while looking for an override city");
pinned.list[futureKey] = override!;

// Re-running the same day must change nothing at all.
const addedAgain = advanceSchedule(pinned, pool, today);
check(addedAgain.length === 0, `re-running the same day appended ${addedAgain.length} entries, expected 0`);
check(pinned.list[futureKey].id === override!.id, "hand-edited day was overwritten by a re-run");
for (const k of stamps(pinned)) {
  if (k === futureKey) continue;
  check(pinned.list[k].id === before[k].id, `re-run re-rolled ${k}, which already had a city`);
}
// Advancing to the next day appends exactly one, and keeps the edit.
const nextDay = advanceSchedule(pinned, pool, shiftStamp(today, 1));
check(nextDay.length === 1, `advancing one day appended ${nextDay.length} entries, expected 1`);
check(pinned.list[futureKey].id === override!.id, "hand-edited day lost when the schedule advanced");
console.log("✓ existing days are never re-rolled — a hand-edited city sticks");

// ---- an interior hole gets re-rolled, not left empty ----

// What `parseState` leaves behind when it drops a malformed hand-edit: a day
// missing from the middle of an otherwise complete window. Appending only past
// the last key would skip it forever, and the client would fall back to the
// rotation on a day the schedule is supposed to own.
const holed: ScheduleState = { list: {} };
advanceSchedule(holed, pool, today);
const holeKey = shiftStamp(today, 2);
const beforeHole = { ...holed.list };
delete holed.list[holeKey];

const filled = advanceSchedule(holed, pool, today);
check(filled.length === 1, `filling one hole should append exactly 1 day, got ${filled.length}`);
check(filled[0].stamp === holeKey, `expected ${holeKey} to be re-rolled, got ${filled[0].stamp}`);
check(holed.list[holeKey] !== undefined, "the hole is still empty after a run");
for (const k of stamps(holed)) {
  if (k === holeKey) continue;
  check(holed.list[k].id === beforeHole[k].id, `re-rolling a hole disturbed ${k}`);
}
check(
  !stamps(holed).some((k) => k !== holeKey && holed.list[k].id === holed.list[holeKey].id),
  "the re-rolled hole duplicates a city already in the window",
);
console.log("✓ an interior hole (dropped malformed entry) is re-rolled, neighbours untouched");

// ---- gap after a CI outage ----

// Build a full history first — a gap only matters once there's something to gap.
const gapped: ScheduleState = { list: {} };
let cursor = today;
for (let i = 0; i < HISTORY_DAYS + 5; i++) {
  advanceSchedule(gapped, pool, cursor);
  pruneHistory(gapped);
  cursor = shiftStamp(cursor, 1);
}
const lastRun = shiftStamp(cursor, -1);
check(stamps(gapped).length === HISTORY_DAYS, "pre-gap history should already be full");

const resumed = advanceSchedule(gapped, pool, shiftStamp(lastRun, 10));
check(resumed.length === 10, `a 10-day outage should append 10 days, got ${resumed.length}`);
pruneHistory(gapped);
check(stamps(gapped).length === HISTORY_DAYS, "history should be back to 30 after a gap");

// A very long outage must not mint hundreds of days just to prune them.
const longGap: ScheduleState = { list: {} };
advanceSchedule(longGap, pool, today);
pruneHistory(longGap);
const afterYear = advanceSchedule(longGap, pool, shiftStamp(today, 400));
check(
  afterYear.length <= HISTORY_DAYS,
  `a 400-day outage appended ${afterYear.length} days, expected ≤ ${HISTORY_DAYS}`,
);
console.log(`✓ outages: 10-day gap backfilled, 400-day gap capped at ${afterYear.length} days`);

// ---- state file round-trip + tolerance for a mangled hand-edit ----

const round = parseState(serializeState(steady));
check(round.rejected.length === 0, `clean round-trip rejected ${round.rejected.join(", ")}`);
check(
  JSON.stringify(stamps(round.state).map((k) => round.state.list[k].id)) ===
    JSON.stringify(stamps(steady).map((k) => steady.list[k].id)),
  "state did not survive a serialize → parse round-trip",
);
check(
  serializeState(steady).indexOf(stamps(steady)[0]) < serializeState(steady).indexOf(stamps(steady)[1]),
  "serialized state should list days in chronological order",
);

const mangled = parseState(
  JSON.stringify({
    list: {
      "2027-01-01": steady.list[stamps(steady)[0]],
      "2027-01-02": { id: 1, name: "Broken" }, // missing required fields
      "not-a-date": steady.list[stamps(steady)[1]],
    },
  }),
);
check(stamps(mangled.state).length === 1, "parseState should keep only the one valid entry");
check(mangled.rejected.length === 2, `expected 2 rejected entries, got ${mangled.rejected.length}`);
check(!mangled.unreadable, "a file with bad *entries* is still readable — only bad JSON is not");

// A broken *file* must be distinguishable from an empty one: the caller aborts on
// `unreadable` rather than appending to `{}` and overwriting the only copy.
check(parseState("{ not json").unreadable, "unparseable state must report unreadable");
check(parseState('{"list":[]}').unreadable, "a non-object `list` must report unreadable");
check(parseState("{}").unreadable, "state with no `list` at all must report unreadable");
check(!parseState('{"list":{}}').unreadable, "a legitimately empty schedule is readable, not broken");
console.log("✓ state file: round-trips, sorted, distinguishes a bad entry from a bad file");

// ---- graceful degradation on a pool too small for the cooldowns ----

const tiny: City[] = [
  { id: 1, name: "A", localName: "A", country: "XX", lat: 0, lon: 0, population: 1 },
  { id: 2, name: "B", localName: "B", country: "XX", lat: 1, lon: 1, population: 1 },
];
const small: ScheduleState = { list: {} };
const smallAdded = advanceSchedule(small, tiny, today);
check(smallAdded.length === LOOKAHEAD_DAYS + 1, "tiny pool should still fill every day");
check(
  smallAdded.some((a) => a.relaxed !== "none"),
  "a 2-city single-country pool must report relaxed cooldowns",
);
for (const a of smallAdded) check(a.city !== undefined, `${a.stamp} got no city from the tiny pool`);
const exhausted = candidatesFor(tiny, small);
check(exhausted.cities.length > 0, "candidatesFor must never return an empty list");
check(exhausted.relaxed === "all", `expected full relaxation on an exhausted pool, got ${exhausted.relaxed}`);
console.log("✓ degrades gracefully: a tiny pool still yields a city every day");

console.log("✓ schedule behaves correctly for all pools");
