#!/usr/bin/env -S npx tsx
// Verifies the persisted daily city schedule (src/core/schedule.ts, issue #1):
//   • the pools merge/dedupe by id into one candidate list,
//   • the day-count constants still satisfy the retention invariant,
//   • over a multi-year run: no city within CITY_COOLDOWN_DAYS (30) and no
//     country within COUNTRY_COOLDOWN_DAYS (5) of each other, *in either
//     direction*, checked pairwise on the full emitted sequence,
//   • picking happens before pruning — the one ordering whose only symptom is a
//     rare exactly-30-day repeat, so inspection can't catch it,
//   • each run appends exactly the one day at today+6 and trims by date,
//   • a hand-pinned day sticks and is honoured by later picks, however far ahead,
//   • the state file round-trips and rejects a mangled hand-edit (including a
//     well-formed but nonexistent date),
//   • the manifest window is today-2 … today+6 by date, not by entry count,
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
  scheduleInvariant,
  serializeState,
  shiftStamp,
  stamps,
  CITY_COOLDOWN_DAYS,
  COUNTRY_COOLDOWN_DAYS,
  HISTORY_BACK_DAYS,
  LOOKAHEAD_DAYS,
  MANIFEST_BACK_DAYS,
  SCHEDULE_DATA_DIR,
  SCHEDULE_DAYS,
  SCHEDULE_POOL_RE,
  SCHEDULE_ROOT,
  SCHEDULE_STATE_FILE,
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

/** Calendar days between two stamps, for the pairwise cooldown audit. */
const dayNum = (s: string): number =>
  Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86_400_000;

// ---- the constants themselves ----

scheduleInvariant();
check(
  CITY_COOLDOWN_DAYS === HISTORY_BACK_DAYS + 1 + LOOKAHEAD_DAYS,
  `retention invariant broken: ${CITY_COOLDOWN_DAYS} !== ${HISTORY_BACK_DAYS}+1+${LOOKAHEAD_DAYS}`,
);
check(SCHEDULE_DAYS === 30, `steady-state schedule should be 30 days, got ${SCHEDULE_DAYS}`);
console.log(
  `✓ constants: history ${HISTORY_BACK_DAYS}d + today + lookahead ${LOOKAHEAD_DAYS}d ` +
    `= ${SCHEDULE_DAYS}d, exactly covering the ${CITY_COOLDOWN_DAYS}d city cooldown`,
);

// ---- the layout's copies in Rust and YAML ----

// SCHEDULE_ROOT / SCHEDULE_DATA_DIR / SCHEDULE_STATE_FILE define the published
// layout, but the two consumers that can't import them — the client
// (src-tauri/src/cdn.rs) and the workflow that publishes the branch
// (.github/workflows/precache.yml) — repeat the strings literally. Until this
// check existed the only thing holding the five copies together was a comment,
// and it had already drifted: cdn.rs grew a second pair of constants the comment
// never mentioned, one of which stores the state file *without* its extension and
// so matched neither `grep osm-v2` nor `grep city-list.json`.
//
// So parse the real declarations and compare the values. Substring-searching the
// files would let a stale comment mentioning `osm-v2` satisfy the check — which is
// the exact failure mode this replaces.

/** The one capture group of `re` in `text`, or a failed run naming what's missing. */
function capture(text: string, re: RegExp, what: string): string {
  const m = text.match(re);
  if (m === null) fail(`${what} — schedule-test can no longer verify the layout`);
  return m[1];
}

function readSibling(...parts: string[]): string {
  try {
    return readFileSync(join(ROOT, ...parts), "utf8");
  } catch {
    return fail(`cannot read ${parts.join("/")}, which the layout check needs`);
  }
}

// cdn.rs keeps the state file as a stem and re-adds the extension per attempt
// (`.json.gz` then `.json`), so the split is only valid while this holds.
const STATE_STEM = SCHEDULE_STATE_FILE.replace(/\.json$/, "");
check(
  STATE_STEM !== SCHEDULE_STATE_FILE,
  `SCHEDULE_STATE_FILE must end in .json — cdn.rs stores it as a stem and re-adds the extension`,
);

const cdnRs = readSibling("src-tauri", "src", "cdn.rs");
for (const [name, expected] of [
  ["SCHEDULE_PATH", `${SCHEDULE_ROOT}/${SCHEDULE_DATA_DIR}`],
  ["SCHEDULE_STATE_DIR", SCHEDULE_ROOT],
  ["SCHEDULE_STATE_STEM", STATE_STEM],
] as const) {
  const actual = capture(
    cdnRs,
    new RegExp(`const ${name}:\\s*&str\\s*=\\s*"([^"]*)"`),
    `cdn.rs no longer declares ${name}`,
  );
  check(actual === expected, `cdn.rs ${name} is "${actual}", schedule.ts says "${expected}"`);
}

const precacheYml = readSibling(".github", "workflows", "precache.yml");

// The gzip pass has to sweep the manifest dir (the client asks for `.gz` first)…
const glob = capture(precacheYml, /^\s*files=\((.*)\)\s*$/m, "precache.yml has no `files=(...)` gzip glob");
check(
  glob.includes(`${SCHEDULE_ROOT}/${SCHEDULE_DATA_DIR}/*.json`),
  `precache.yml gzip glob doesn't cover ${SCHEDULE_ROOT}/${SCHEDULE_DATA_DIR}/: ${glob}`,
);
// …and must not reach one level up, which is the whole reason the state file sits
// beside `data/` instead of inside it.
check(
  !glob.includes(`${SCHEDULE_ROOT}/*.json`),
  `precache.yml gzip glob would compress ${SCHEDULE_STATE_FILE}; it must sweep ${SCHEDULE_DATA_DIR}/ only`,
);

// The publish guard has to count the schedule as something worth publishing, or a
// run that fetched schedule days but no rotation cities is discarded while green.
const guarded = [...precacheYml.matchAll(/ls -A (\S+)/g)].map((m) => m[1]);
check(
  guarded.includes(SCHEDULE_ROOT),
  `precache.yml publish guard checks [${guarded.join(", ")}], none of them ${SCHEDULE_ROOT}`,
);
console.log(
  `✓ layout: cdn.rs (3 constants) + precache.yml (gzip glob, publish guard) agree on ` +
    `${SCHEDULE_ROOT}/{${SCHEDULE_STATE_FILE}, ${SCHEDULE_DATA_DIR}/}`,
);

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

// ---- helpers over the real flow ----

/**
 * Run `days` consecutive daily runs from `start`, recording every day the
 * schedule ever emitted (the state itself only keeps a 30-day slice).
 */
function runDays(days: number, start: string, seed: ScheduleState = { list: {} }) {
  const state = seed;
  const emitted = new Map<string, City>(stamps(state).map((k) => [k, state.list[k]]));
  const relaxations: string[] = [];
  for (let i = 0; i < days; i++) {
    const { added } = advanceSchedule(state, pool, shiftStamp(start, i));
    if (added !== undefined) {
      emitted.set(added.stamp, added.city);
      if (added.relaxed !== "none") relaxations.push(`${added.stamp}: ${added.relaxed}`);
    }
  }
  return { state, emitted, relaxations };
}

/** Every pairwise cooldown violation in an emitted sequence, both directions. */
function auditCooldowns(emitted: Map<string, City>): string[] {
  const byDay = new Map<number, City>([...emitted].map(([k, c]) => [dayNum(k), c]));
  const bad: string[] = [];
  for (const [d, c] of byDay) {
    for (let gap = 1; gap <= CITY_COOLDOWN_DAYS; gap++) {
      const other = byDay.get(d + gap);
      if (other === undefined) continue;
      if (other.id === c.id) bad.push(`city ${c.name} repeated with a ${gap}-day gap`);
      if (gap <= COUNTRY_COOLDOWN_DAYS && other.country === c.country) {
        bad.push(`country ${c.country} repeated with a ${gap}-day gap`);
      }
    }
  }
  return bad;
}

// ---- a long simulated run over the real pool ----

const DAYS = 365 * 3;
const long = runDays(DAYS, "2026-01-01");
check(long.relaxations.length === 0, `cooldowns had to be relaxed on the real pool: ${long.relaxations[0]}`);
check(long.emitted.size === DAYS, `expected ${DAYS} emitted days, got ${long.emitted.size}`);

const violations = auditCooldowns(long.emitted);
check(violations.length === 0, `${violations.length} cooldown violation(s), first: ${violations[0]}`);

const seq = [...long.emitted.keys()].sort();
for (let i = 1; i < seq.length; i++) {
  check(seq[i] === shiftStamp(seq[i - 1], 1), `schedule is not contiguous: ${seq[i - 1]} → ${seq[i]}`);
}
check(
  stamps(long.state).length === SCHEDULE_DAYS,
  `steady state should hold ${SCHEDULE_DAYS} days, got ${stamps(long.state).length}`,
);
console.log(
  `✓ ${long.emitted.size} days, ${new Set([...long.emitted.values()].map((c) => c.id)).size} distinct ` +
    `cities, contiguous, no city within ${CITY_COOLDOWN_DAYS}d and no country within ` +
    `${COUNTRY_COOLDOWN_DAYS}d in either direction`,
);

// ---- pick-then-prune: the ordering the invariant protects ----
//
// Deterministic, because the natural symptom is one repeat per ~1200 days. Two
// cities and a forced rng: the day at `today-24` holds city A, and A must be
// excluded from `today+6` — which is only true if that day is still in the state
// when the pick happens. Pruning first would remove it and leave A eligible.

const A: City = { id: 1, name: "A", localName: "A", country: "AA", lat: 0, lon: 0, population: 1 };
const B: City = { id: 2, name: "B", localName: "B", country: "BB", lat: 1, lon: 1, population: 1 };
const today = "2027-06-15";
const edge: ScheduleState = { list: { [shiftStamp(today, -(HISTORY_BACK_DAYS + 1))]: A } };
const { added: edgeAdded, dropped: edgeDropped } = advanceSchedule(edge, [A, B], today, () => 0);
check(edgeAdded !== undefined, "the edge-case run appended nothing");
check(
  edgeAdded!.city.id === B.id,
  `picked ${edgeAdded!.city.name} for today+6 while ${A.name} sat exactly ` +
    `${CITY_COOLDOWN_DAYS} days earlier — the prune must run *after* the pick`,
);
check(edgeAdded!.relaxed === "none", "the edge case should not need relaxed cooldowns");
check(
  edgeDropped.includes(shiftStamp(today, -(HISTORY_BACK_DAYS + 1))),
  "today-24 should be pruned once the pick that needed it is done",
);
console.log(`✓ pick-then-prune: today-24 still guards today+6, then gets dropped in the same run`);

// ---- one run appends exactly one day, and trims by date ----

const steady = runDays(SCHEDULE_DAYS + 10, today).state;
const before = stamps(steady).length;
const { added: one, dropped } = advanceSchedule(steady, pool, shiftStamp(today, SCHEDULE_DAYS + 10));
check(one !== undefined, "a fresh calendar day should append its today+6");
check(dropped.length === 1, `a steady-state run should drop exactly 1 day, got ${dropped.length}`);
check(stamps(steady).length === before, "steady state should keep a constant number of days");
const again = advanceSchedule(steady, pool, shiftStamp(today, SCHEDULE_DAYS + 10));
check(again.added === undefined, "re-running the same calendar day must append nothing");
check(again.dropped.length === 0, "re-running the same calendar day must drop nothing");
const keys = stamps(steady);
check(
  keys[keys.length - 1] === shiftStamp(shiftStamp(today, SCHEDULE_DAYS + 10), LOOKAHEAD_DAYS),
  "newest key should be today+6",
);
check(
  keys[0] === shiftStamp(shiftStamp(today, SCHEDULE_DAYS + 10), -HISTORY_BACK_DAYS),
  "oldest key should be today-23",
);
console.log(`✓ one run = one appended day (today+6) + one dropped day (older than today-23); reruns are no-ops`);

// ---- a hand-pinned day sticks, however far ahead ----

const pinDay = shiftStamp(today, 90);
const pinned: ScheduleState = { list: {} };
runDays(1, today, pinned);
const pin = pool.find((c) => !Object.values(pinned.list).some((v) => v.country === c.country))!;
pinned.list[pinDay] = pin;

// Runs that don't reach it leave it completely alone, and don't hand it a manifest.
for (let i = 1; i < 60; i++) advanceSchedule(pinned, pool, shiftStamp(today, i));
check(pinned.list[pinDay]?.id === pin.id, "a far-future pinned day was overwritten");
check(
  !manifestWindow(pinned, shiftStamp(today, 59)).includes(pinDay),
  "a day 30+ days out must not be inside the manifest window",
);

// And once the calendar comes within range, the pin is honoured by the picks
// around it rather than being competed with. Stop while the pin is still inside
// the retained window — pinDay leaves it for good at today+113 (pinDay+23), which
// is checked separately below.
for (let i = 60; i < 96; i++) advanceSchedule(pinned, pool, shiftStamp(today, i));
check(pinned.list[pinDay]?.id === pin.id, "the pinned day was re-rolled once it came into range");
const around = stamps(pinned).filter(
  (k) => Math.abs(dayNum(k) - dayNum(pinDay)) <= COUNTRY_COOLDOWN_DAYS && k !== pinDay,
);
check(around.length > 0, "the pinned day's neighbours should have been scheduled by now");
for (const k of around) {
  check(
    pinned.list[k].country !== pin.country,
    `${k} reused the pinned day's country (${pin.country}) ${Math.abs(dayNum(k) - dayNum(pinDay))} days away`,
  );
}
console.log(`✓ a day pinned 90 days out survives every run and is honoured by its neighbours' picks`);

// It is not special-cased forever: once the calendar has moved HISTORY_BACK_DAYS
// past it, it ages out like any other day.
for (let i = 96; i <= HISTORY_BACK_DAYS + 91; i++) advanceSchedule(pinned, pool, shiftStamp(today, i));
check(
  pinned.list[pinDay] === undefined,
  `the pinned day should have aged out of the retained window by today+${HISTORY_BACK_DAYS + 91}`,
);
console.log(`✓ …and then ages out normally once it is older than today-${HISTORY_BACK_DAYS}`);

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

const sample = steady.list[stamps(steady)[0]];
const mangled = parseState(
  JSON.stringify({
    list: {
      "2027-01-01": sample,
      "2027-01-02": { id: 1, name: "Broken" }, // missing required fields
      "not-a-date": sample,
      "2026-02-30": sample, // well-formed, but no such day
      "9999-99-99": sample, // ditto, and would sort to the end forever
    },
  }),
);
check(stamps(mangled.state).length === 1, `parseState should keep only the one valid entry, kept ${stamps(mangled.state).length}`);
check(mangled.rejected.length === 4, `expected 4 rejected entries, got ${mangled.rejected.length}`);
check(!mangled.unreadable, "a file with bad *entries* is still readable — only bad JSON is not");
check(parseState('{"list":{"2028-02-29":' + JSON.stringify(sample) + "}}").rejected.length === 0,
  "2028-02-29 is a real leap day and must be accepted");

// A broken *file* must be distinguishable from an empty one: the caller aborts on
// `unreadable` rather than appending to `{}` and overwriting the only copy.
check(parseState("{ not json").unreadable, "unparseable state must report unreadable");
check(parseState('{"list":[]}').unreadable, "a non-object `list` must report unreadable");
check(parseState("{}").unreadable, "state with no `list` at all must report unreadable");
check(!parseState('{"list":{}}').unreadable, "a legitimately empty schedule is readable, not broken");
console.log("✓ state file: round-trips, sorted, rejects impossible dates, bad entry ≠ bad file");

// ---- the manifest window is by date, not by entry count ----

const mw = manifestWindow(steady, shiftStamp(today, SCHEDULE_DAYS + 10));
const base = shiftStamp(today, SCHEDULE_DAYS + 10);
check(
  mw.length === MANIFEST_BACK_DAYS + 1 + LOOKAHEAD_DAYS,
  `manifest window should be ${MANIFEST_BACK_DAYS + 1 + LOOKAHEAD_DAYS} days, got ${mw.length}`,
);
check(mw[0] === shiftStamp(base, -MANIFEST_BACK_DAYS), `window should start at today-${MANIFEST_BACK_DAYS}`);
check(mw[mw.length - 1] === shiftStamp(base, LOOKAHEAD_DAYS), "window should end at today+6");

// With a far-future pin present, an entry-count window would have handed it a
// manifest and pushed today-2 out. By date it can't.
const withPin: ScheduleState = { list: { ...steady.list, [shiftStamp(base, 200)]: pin } };
const mwPinned = manifestWindow(withPin, base);
check(
  JSON.stringify(mwPinned) === JSON.stringify(mw),
  "a far-future pinned day must not change the manifest window",
);
console.log(`✓ manifest window: today-${MANIFEST_BACK_DAYS} … today+${LOOKAHEAD_DAYS} by date, unaffected by a far pin`);

// ---- graceful degradation on a pool too small for the cooldowns ----

const tiny: City[] = [
  { id: 1, name: "A", localName: "A", country: "XX", lat: 0, lon: 0, population: 1 },
  { id: 2, name: "B", localName: "B", country: "XX", lat: 1, lon: 1, population: 1 },
];
const smallState: ScheduleState = { list: {} };
const smallRelaxed: string[] = [];
for (let i = 0; i < 10; i++) {
  const { added } = advanceSchedule(smallState, tiny, shiftStamp(today, i));
  if (added !== undefined) smallRelaxed.push(added.relaxed);
}
check(smallRelaxed.length === 10, "a tiny pool should still fill a day per run");
check(smallRelaxed.some((r) => r !== "none"), "a 2-city single-country pool must report relaxed cooldowns");
const exhausted = candidatesFor(tiny, smallState, shiftStamp(today, LOOKAHEAD_DAYS + 10));
check(exhausted.cities.length > 0, "candidatesFor must never return an empty list");
console.log("✓ degrades gracefully: a tiny pool still yields a city every run");

console.log("✓ schedule behaves correctly for all pools");
