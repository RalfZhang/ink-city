#!/usr/bin/env -S npx tsx
// Verifies the guess-the-country game (src/core/guess), which the desktop app and the
// website share:
//   • the hint geometry — distances, rhumb-line bearings, compass points, ink tiers,
//   • the rules — winning, losing, duplicates, the "Daily guess" switch, a city
//     that changes mid-day, and the states a day waits in before it can be played,
//   • lifetime stats and streaks, and the tolerant save-file parser,
//   • the country lookup, in English and in other scripts,
//   • src/data/countries.json covering every country the daily schedule can draw,
//   • the reveal rule against scripts/fixtures/guess-reveal-cases.json — the same
//     file src-tauri/src/guess_store.rs tests its mirror of that rule against.
// Exits non-zero (printing every violation) on failure.
//
//   pnpm guess-test

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DAY_ENDS,
  MAX_GUESSES,
  applyGuess,
  applySwitch,
  compassPoint,
  countryIndex,
  countryName,
  dayState,
  emptyGuessStore,
  exactCountry,
  gameSnapshot,
  guessStats,
  haversineKm,
  isRevealed,
  parseGuessStore,
  proximityTier,
  resetDay,
  rhumbBearingDeg,
  searchCountries,
  serializeGuessStore,
  type Country,
  type DayCity,
  type DayInputs,
  type GuessStore,
} from "../src/core/guess/index.ts";
import { SCHEDULE_POOL_RE } from "../src/core/schedule.ts";
import { LOCALES } from "../src/i18n/locales.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = <T>(rel: string): T => JSON.parse(readFileSync(join(root, rel), "utf8")) as T;

let checks = 0;
let failures = 0;
function check(ok: boolean, what: string, detail?: unknown): void {
  checks++;
  if (!ok) {
    failures++;
    console.error(`✗ ${what}${detail === undefined ? "" : ` — got ${JSON.stringify(detail)}`}`);
  }
}
const near = (got: number, want: number, tol: number) => Math.abs(got - want) <= tol;
/** JSON with object keys sorted, so equal data compares equal whatever order it was built in. */
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b)))
      : x,
  );

// --- hint geometry ---------------------------------------------------------------

check(near(haversineKm(51.5074, -0.1278, 48.8566, 2.3522), 344, 3), "London–Paris ≈ 344 km",
  haversineKm(51.5074, -0.1278, 48.8566, 2.3522));
check(near(haversineKm(0, 0, 0, 180), 20015, 5), "antipodes ≈ 20015 km", haversineKm(0, 0, 0, 180));
check(near(rhumbBearingDeg(10, 20, 30, 20), 0, 1e-9), "due north is 0°");
check(near(rhumbBearingDeg(0, 0, 0, 10), 90, 1e-9), "due east along the equator is 90°");
check(near(rhumbBearingDeg(0, 10, 0, 0), 270, 1e-9), "due west is 270°");
// Fiji (178°E) → Samoa (172°W) is a short hop east across the antimeridian.
const fijiSamoa = rhumbBearingDeg(-17.7, 178, -13.8, -172);
check(fijiSamoa > 45 && fijiSamoa < 90, "Fiji → Samoa heads east-north-east", fijiSamoa);
check(Number.isFinite(rhumbBearingDeg(90, 0, -90, 0)), "pole to pole stays finite");
for (const [deg, want] of [[0, "n"], [22.4, "n"], [22.6, "ne"], [90, "e"], [180, "s"], [247, "sw"], [270, "w"], [337.4, "nw"], [337.6, "n"], [359, "n"], [-45, "nw"], [405, "ne"]] as const) {
  check(compassPoint(deg) === want, `compassPoint(${deg}) = ${want}`, compassPoint(deg));
}
for (const [km, want] of [[0, 5], [300, 5], [301, 4], [1000, 4], [1001, 3], [2500, 3], [2501, 2], [5000, 2], [5001, 1], [10000, 1], [10001, 0], [20000, 0]] as const) {
  check(proximityTier(km) === want, `proximityTier(${km}) = ${want}`, proximityTier(km));
}

// --- rules -----------------------------------------------------------------------

const TEST_COUNTRIES: Country[] = [
  { code: "FR", name: "France", lat: 46.62, lon: 2.45 },
  { code: "DE", name: "Germany", lat: 51.1, lon: 10.4 },
  { code: "ES", name: "Spain", lat: 40.2, lon: -3.6 },
  { code: "IT", name: "Italy", lat: 43.5, lon: 12.2 },
  { code: "BE", name: "Belgium", lat: 50.6, lon: 4.6 },
  { code: "PL", name: "Poland", lat: 52.1, lon: 19.4 },
  { code: "PT", name: "Portugal", lat: 39.6, lon: -8.0 },
  { code: "NL", name: "Netherlands", lat: 52.2, lon: 5.6 },
];
const idx = countryIndex(TEST_COUNTRIES);
const PARIS: DayCity = { id: 2988507, country: "FR", lat: 48.8566, lon: 2.3522 };
const TODAY = "2026-10-16";
const day = (over: Partial<DayInputs> = {}): DayInputs => ({ date: TODAY, city: PARIS, ready: true, ...over });

function play(store: GuessStore, codes: string[], inputs = day()): GuessStore {
  for (const code of codes) store = applyGuess(store, inputs, idx, code).store;
  return store;
}

{
  const s0 = emptyGuessStore();
  check(dayState(s0, day({ city: null }), idx) === "resolving", "no city yet → resolving");
  check(dayState(s0, day({ ready: false }), idx) === "painting", "map not showing yet → painting");
  check(applyGuess(s0, day({ ready: false }), idx, "FR").outcome === "notPlaying", "can't guess while painting");
  check(dayState(s0, day(), idx) === "playing", "fresh day → playing");
  check(dayState(s0, day({ city: { ...PARIS, country: "ZZ" } }), idx) === "unavailable", "unknown answer country → unavailable");
  check(isRevealed("unavailable") && !isRevealed("playing") && !isRevealed("painting") && !isRevealed("resolving"), "isRevealed partitions the states");

  const r = applyGuess(s0, day(), idx, "de");
  check(r.outcome === "accepted", "lower-case code accepted", r.outcome);
  check(s0.days[TODAY] === undefined, "applyGuess doesn't mutate its input");
  const g = r.store.days[TODAY].guesses[0];
  check(g.code === "DE" && near(g.km, 627, 5) && compassPoint(g.deg) === "sw", "Germany → Paris ≈ 627 km, heading south-west", g);
  check(r.store.days[TODAY].cityId === PARIS.id && r.store.days[TODAY].answer === "FR", "first guess binds city + answer");
  check(applyGuess(r.store, day(), idx, "DE").outcome === "alreadyGuessed", "duplicate rejected");
  check(applyGuess(r.store, day(), idx, "XX").outcome === "unknownCountry", "unknown code rejected");

  const won = applyGuess(r.store, day(), idx, "FR").store;
  check(won.days[TODAY].end === "won", "answer → won");
  const snap = gameSnapshot(won, day(), idx);
  check(snap.state === "won" && snap.answer === "FR" && snap.guesses.length === 2, "won snapshot", snap);
  check(snap.guesses[1].correct && snap.guesses[1].tier === 5, "correct row: full ink", snap.guesses[1]);
  check(applyGuess(won, day(), idx, "ES").outcome === "notPlaying", "no guesses after a win");

  const lost = play(s0, ["DE", "ES", "IT", "BE", "PL", "PT"]);
  check(lost.days[TODAY].end === "lost" && lost.days[TODAY].guesses.length === MAX_GUESSES, "six misses → lost");
  check(applyGuess(lost, day(), idx, "NL").outcome === "notPlaying", "seventh guess rejected");
  check(gameSnapshot(play(s0, ["DE"]), day(), idx).answer === null, "answer withheld while playing");

  // The day's city changing under an unfinished game starts it over; a finished one stands.
  const other: DayCity = { id: 1, country: "DE", lat: 52.52, lon: 13.4 };
  const midway = play(s0, ["ES"]);
  check(gameSnapshot(midway, day({ city: other }), idx).guesses.length === 0, "city changed mid-game → fresh game");
  check(dayState(lost, day({ city: other }), idx) === "lost", "city changed after the end → result kept");
}

// --- the "Daily guess" switch (the `showCityInfo` preference, inverted) --------------

{
  const s0 = emptyGuessStore();
  const on = applySwitch(s0, day(), true);
  check(on.showCityInfo && on.days[TODAY] === undefined && dayState(on, day(), idx) === "skipped",
    "on, unplayed → skipped by the preference alone", on);
  check(dayState(on, day({ date: "2026-10-17" }), idx) === "skipped", "on → every later day skipped too");

  const midway = play(s0, ["DE", "ES"]);
  const gaveUp = applySwitch(midway, day(), true);
  check(gaveUp.days[TODAY].end === "gaveUp" && gaveUp.days[TODAY].guesses.length === 2, "on mid-game → gave up");

  const won = play(s0, ["FR"]);
  check(applySwitch(won, day(), true).days[TODAY].end === "won", "on after a win keeps the win");

  const off = applySwitch(on, day(), false);
  check(!off.showCityInfo && off.days[TODAY].end === "skipped", "off → today recorded as skipped", off);
  check(gameSnapshot(off, day(), idx).resumesTomorrow, "off → resumes tomorrow");
  check(dayState(off, day({ date: "2026-10-17" }), idx) === "playing", "off → tomorrow is playable");
  const offEarly = applySwitch(on, day({ city: null }), false);
  check(offEarly.days[TODAY].end === "skipped" && offEarly.days[TODAY].cityId === undefined,
    "off before the city resolves → skipped, unbound");
  check(applySwitch(on, day(), true) === on, "no-op when unchanged");

  // Dev Mode's reset: today is playable again, other days untouched.
  const history = applySwitch(play(play(s0, ["FR"], day({ date: "2026-10-15" })), ["DE", "ES"]), day(), true);
  const reset = resetDay(history, TODAY);
  check(!reset.showCityInfo && !(TODAY in reset.days) && reset.days["2026-10-15"]?.end === "won",
    "resetDay clears today and the preference, keeps the past", reset);
  check(dayState(reset, day(), idx) === "playing", "after resetDay today is playable");
  check(history.days[TODAY]?.end === "gaveUp", "resetDay doesn't mutate its input");
}

// --- stats -----------------------------------------------------------------------

{
  const won = (n: number) => ({ guesses: Array.from({ length: n }, () => ({ code: "DE", km: 1, deg: 0 })), end: "won" as const });
  const store: GuessStore = {
    v: 1,
    showCityInfo: false,
    days: {
      "2026-10-01": won(3),
      "2026-10-02": won(1),
      "2026-10-03": won(2), // 3-day run
      "2026-10-04": { guesses: [], end: "lost" },
      "2026-10-05": won(4),
      // 10-06 never opened — breaks the run
      "2026-10-07": won(6),
      "2026-10-08": { guesses: [], end: "skipped" }, // skipping breaks it too
      "2026-10-09": { guesses: [{ code: "DE", km: 1, deg: 0 }] }, // abandoned → played
      "2026-10-10": { guesses: [], end: "gaveUp" },
      "2026-10-14": won(2),
      "2026-10-15": won(5),
      // 10-16 (today) not played yet
    },
  };
  const s = guessStats(store, TODAY);
  check(s.played === 10, "played counts won/lost/gave up + past abandoned, not skipped", s.played);
  check(s.wins === 7, "wins", s.wins);
  check(s.maxStreak === 3, "max streak", s.maxStreak);
  check(s.currentStreak === 2, "today open → streak runs to yesterday", s.currentStreak);
  check(JSON.stringify(s.distribution) === JSON.stringify([1, 2, 1, 1, 1, 1]), "distribution", s.distribution);
  const lostToday = guessStats({ ...store, days: { ...store.days, [TODAY]: { guesses: [], end: "lost" } } }, TODAY);
  check(lostToday.currentStreak === 0, "lost today → streak 0", lostToday.currentStreak);
  const wonToday = guessStats({ ...store, days: { ...store.days, [TODAY]: won(1) } }, TODAY);
  check(wonToday.currentStreak === 3 && wonToday.maxStreak === 3, "won today extends the streak", wonToday);
  const inProgress = guessStats({ ...store, days: { ...store.days, [TODAY]: { guesses: [{ code: "DE", km: 1, deg: 0 }] } } }, TODAY);
  check(inProgress.played === 10, "today's open game isn't played yet", inProgress.played);
}

// --- save file -------------------------------------------------------------------

{
  check(!parseGuessStore(null).corrupt && Object.keys(parseGuessStore(null).store.days).length === 0, "nothing saved → empty");
  check(parseGuessStore("{oops").corrupt, "not JSON → corrupt");
  check(parseGuessStore("[1]").corrupt, "not an object → corrupt");
  const messy = parseGuessStore(JSON.stringify({
    v: 1,
    showCityInfo: true,
    days: {
      "2026-10-15": { cityId: 7, answer: "FR", guesses: [{ code: "DE", km: 1, deg: 2 }, { code: "nope" }, 5], end: "lost" },
      "2026-10-16": { guesses: "bad", end: "victory" },
      "not-a-date": { guesses: [], end: "won" },
      "2026-10-14": "won",
    },
    future: { kept: false },
  }));
  const d = messy.store.days;
  check(!messy.corrupt && messy.store.showCityInfo, "salvageable save parses", messy);
  check(d["2026-10-15"]?.guesses.length === 1 && d["2026-10-15"].end === "lost" && d["2026-10-15"].cityId === 7,
    "bad guesses dropped, the rest kept", d["2026-10-15"]);
  check(d["2026-10-16"] !== undefined && d["2026-10-16"].end === undefined && d["2026-10-16"].guesses.length === 0,
    "unknown end ignored", d["2026-10-16"]);
  check(!("not-a-date" in d) && !("2026-10-14" in d), "bad keys and non-object records dropped", Object.keys(d));
  const store = applySwitch(play(emptyGuessStore(), ["DE", "FR"]), day({ date: "2026-10-17" }), true);
  const back = parseGuessStore(serializeGuessStore(store));
  check(!back.corrupt && canonical(back.store) === canonical({ ...store, v: 1 }), "serialize ↔ parse round-trips", back);
}

// --- country table + lookup --------------------------------------------------------

const countries = readJson<Country[]>("src/data/countries.json");
const real = countryIndex(countries);
{
  const codes = countries.map((c) => c.code);
  check(new Set(codes).size === codes.length, "country codes unique");
  check(codes.every((c) => /^[A-Z]{2}$/.test(c)), "country codes are two upper-case letters");
  check(countries.every((c) => Math.abs(c.lat) <= 90 && Math.abs(c.lon) <= 180 && c.name.length > 0), "coordinates in range, names present");
  type Pin = { country: string };
  const poolFiles = readdirSync(join(root, "src/data")).filter((n) => SCHEDULE_POOL_RE.test(n));
  check(poolFiles.length > 0, "found the schedule's city pools", poolFiles);
  const pools = poolFiles.flatMap((n) => readJson<Pin[]>(`src/data/${n}`));
  const missing = [...new Set(pools.map((p) => p.country))].filter((c) => !real.byCode.has(c));
  check(missing.length === 0, "countries.json covers every country the schedule draws from", missing);

  const first = (q: string, lang: string) => searchCountries(real, q, lang)[0]?.code;
  check(first("cote d ivoire", "en") === "CI", "diacritics folded", searchCountries(real, "cote d ivoire", "en"));
  check(first("usa", "en") === "US" && first("uk", "en") === "GB" && first("turkey", "en") === "TR", "English aliases");
  check(first("fr", "en") === "FR", "an exact code ranks first");
  check(first("saint lucia", "en") === "LC", "\"saint\" finds CLDR's \"St.\"");
  check(first("美国", "zh-Hans") === "US", "Simplified Chinese name");
  check(first("アメリカ", "ja") === "US", "Japanese short name");
  check(first("france", "zh-Hans") === "FR", "English still matches under another UI language");
  check(!searchCountries(real, "ger", "en", ["DE"]).some((c) => c.code === "DE"), "already-guessed excluded");
  check(searchCountries(real, "  ", "en").length === 0, "blank query → nothing");
  check(searchCountries(real, "a", "en").length === 6, "results capped");
  check(exactCountry(real, "法国", "zh-Hans")?.code === "FR" && exactCountry(real, "fra", "en") === null, "exactCountry");
  check(countryName(real, "HK", "en") === "Hong Kong", "English uses the table's own names");
  const nameless: string[] = [];
  for (const { code: lang } of LOCALES) {
    for (const c of countries) {
      const n = countryName(real, c.code, lang);
      if (!n || n === c.code) nameless.push(`${lang}:${c.code}`);
    }
  }
  check(nameless.length === 0, "every country has a name in every UI language", nameless.slice(0, 20));
}

// --- the reveal rule, shared with the Rust backend -------------------------------------

{
  type Case = { name: string; store: unknown; city: DayCity | null; revealed: boolean };
  const fixture = readJson<{ date: string; cases: Case[] }>("scripts/fixtures/guess-reveal-cases.json");
  const pinnedEnds = new Set<string>();
  for (const c of fixture.cases) {
    const { store } = parseGuessStore(c.store === null ? null : JSON.stringify(c.store));
    const end = store.days[fixture.date]?.end;
    if (end && c.revealed) pinnedEnds.add(end);
    for (const ready of [true, false]) {
      const state = dayState(store, { date: fixture.date, city: c.city, ready }, real);
      check(isRevealed(state) === c.revealed, `reveal fixture: ${c.name} (ready=${ready})`, state);
      // The backend's `is_playing` (the tray's "Open Game") is this same reading.
      const playing = !c.revealed && c.city !== null && ready;
      check((state === "playing") === playing, `playing fixture: ${c.name} (ready=${ready})`, state);
    }
  }
  // Every way a day can end needs a revealed case ending today: a `DayEnd` added here
  // then fails this check until the fixture pins it, and the fixture fails
  // `cargo test` until the backend's own `DAY_ENDS` knows it too.
  const unpinned = DAY_ENDS.filter((e) => !pinnedEnds.has(e));
  check(unpinned.length === 0, "the reveal fixture pins every DayEnd", unpinned);
}

if (failures > 0) {
  console.error(`✗ ${failures}/${checks} guess-game checks failed`);
  process.exit(1);
}
console.log(`✓ guess game: ${checks} checks (geometry, rules, switch, stats, save file, lookup, reveal fixture)`);
