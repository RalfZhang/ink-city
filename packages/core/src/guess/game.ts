import { compassPoint, haversineKm, MAX_TIER, proximityTier, rhumbBearingDeg } from "./geo";
import {
  MAX_GUESSES,
  type Country,
  type DayInputs,
  type DayRecord,
  type GameSnapshot,
  type GameState,
  type GuessStats,
  type GuessStore,
  type GuessView,
} from "./types";

// The game's rules, as pure functions over the save file: each takes a `GuessStore`
// and returns a new one (never mutating its argument), so a host can compute the
// next state, persist it, and only then commit it — a failed write leaves nothing
// half-applied.

/** The country table, indexed for lookup. Built once by the host from `packages/core/data/countries.json`. */
export type CountryIndex = {
  readonly list: readonly Country[];
  readonly byCode: ReadonlyMap<string, Country>;
};

export function countryIndex(countries: readonly Country[]): CountryIndex {
  return { list: countries, byCode: new Map(countries.map((c) => [c.code, c])) };
}

/**
 * Today's record as far as play is concerned. An unfinished record bound to a
 * *different* city doesn't count — the day's city changed under it (a cache wipe plus
 * a hand-edited schedule, say), so its guesses were about another map and the player
 * starts over. A finished record always stands: its result was earned.
 */
function liveRecord(store: GuessStore, inputs: DayInputs): DayRecord | undefined {
  const rec = store.days[inputs.date];
  if (!rec) return undefined;
  if (rec.end) return rec;
  if (rec.cityId !== undefined && inputs.city && rec.cityId !== inputs.city.id) return undefined;
  return rec;
}

/**
 * Where today stands. Order matters, and the first three rungs are mirrored by the
 * desktop backend's `guess_store::is_revealed` (which decides whether the wallpaper
 * may show the city while no window is open) — a shared fixture,
 * scripts/fixtures/guess-reveal-cases.json, pins the two readings together:
 *
 *   1. a finished record decides;
 *   2. the `showCityInfo` preference (the "Daily guess" switch off) skips the game;
 *   3. no city yet → resolving; a city whose country we don't know → unavailable
 *      (revealed, since it can't be played);
 *   4. a known city whose map isn't showing yet → painting; else playing.
 */
export function dayState(store: GuessStore, inputs: DayInputs, index: CountryIndex): GameState {
  const end = store.days[inputs.date]?.end;
  if (end) return end;
  if (store.showCityInfo) return "skipped";
  const { city } = inputs;
  if (!city) return "resolving";
  if (!index.byCode.has(city.country)) return "unavailable";
  if (!inputs.ready) return "painting";
  return "playing";
}

/** Whether the day's city may be shown: anything but a game still waiting or underway. */
export function isRevealed(state: GameState): boolean {
  return state !== "resolving" && state !== "painting" && state !== "playing";
}

export type GuessOutcome = "accepted" | "notPlaying" | "unknownCountry" | "alreadyGuessed";

/**
 * Submit a guess (a country code, any case). Binds the record to today's city on the
 * first guess, and ends the day as `won` on the answer or `lost` on the last miss.
 * Distance and bearing are measured from the guessed country's reference point to
 * the city itself — the one place on Earth the answer is known exactly.
 */
export function applyGuess(
  store: GuessStore,
  inputs: DayInputs,
  index: CountryIndex,
  code: string,
): { store: GuessStore; outcome: GuessOutcome } {
  const { city } = inputs;
  if (!city || dayState(store, inputs, index) !== "playing") return { store, outcome: "notPlaying" };
  const country = index.byCode.get(code.trim().toUpperCase());
  if (!country) return { store, outcome: "unknownCountry" };
  const prior = liveRecord(store, inputs)?.guesses ?? [];
  if (prior.some((g) => g.code === country.code)) return { store, outcome: "alreadyGuessed" };

  const guesses = [
    ...prior,
    {
      code: country.code,
      km: Math.round(haversineKm(country.lat, country.lon, city.lat, city.lon)),
      deg: Math.round(rhumbBearingDeg(country.lat, country.lon, city.lat, city.lon) * 10) / 10,
    },
  ];
  const record: DayRecord = { cityId: city.id, answer: city.country, guesses };
  if (country.code === city.country) record.end = "won";
  else if (guesses.length >= MAX_GUESSES) record.end = "lost";
  return { store: { ...store, days: { ...store.days, [inputs.date]: record } }, outcome: "accepted" };
}

/**
 * Flip the `showCityInfo` preference — the UI's "Daily guess" switch, inverted.
 * It's long-lived — on means "don't make me
 * play, just show the city every day" — and reveals today the moment it's on:
 *
 *   • on  — a game already underway is given up (a loss); an unplayed day needs no
 *           record, the preference alone skips it.
 *   • off — today has been on show, so it can't be played any more: it's recorded as
 *           `skipped`, and the game resumes tomorrow.
 */
export function applySwitch(store: GuessStore, inputs: DayInputs, on: boolean): GuessStore {
  if (on === store.showCityInfo) return store;
  const today = store.days[inputs.date];
  const days = { ...store.days };
  if (!today?.end) {
    if (on) {
      const live = liveRecord(store, inputs);
      if (live && live.guesses.length > 0) days[inputs.date] = { ...live, end: "gaveUp" };
    } else {
      const { city } = inputs;
      days[inputs.date] = {
        ...(liveRecord(store, inputs) ?? { guesses: [] }),
        ...(city ? { cityId: city.id, answer: city.country } : {}),
        end: "skipped",
      };
    }
  }
  return { ...store, showCityInfo: on, days };
}

/**
 * Testing aid (Dev Mode's "reset today"): make `date` playable again — its record is
 * dropped and the `showCityInfo` preference turned off (the game back on). Deliberately outside the
 * rules: in play, turning the preference off leaves a revealed day revealed
 * (`applySwitch`), and nothing ever un-ends a day.
 */
export function resetDay(store: GuessStore, date: string): GuessStore {
  const days = { ...store.days };
  delete days[date];
  return { ...store, showCityInfo: false, days };
}

/**
 * `stamp` shifted by `days` calendar days. Formats the date itself rather than
 * borrowing `dateStamp` from ../city, the deprecated rotation module slated for
 * removal — the game shouldn't go with it.
 */
function shiftDay(stamp: string, days: number): string {
  const d = new Date(`${stamp}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Lifetime stats. A game counts as played once it has ended in any way but
 * `skipped` — and so does a *past* day abandoned mid-game, or walking away would be
 * a free way to dodge a loss. A streak is consecutive calendar days won; any day not
 * won breaks it, including one never opened. While today is still open the current
 * streak runs to yesterday, so it doesn't drop to 0 before today has been played.
 */
export function guessStats(store: GuessStore, today: string): GuessStats {
  const distribution = new Array<number>(MAX_GUESSES).fill(0);
  let played = 0;
  let wins = 0;
  let maxStreak = 0;
  let run = 0;
  let prevWin: string | null = null;
  for (const date of Object.keys(store.days).sort()) {
    const rec = store.days[date];
    if (rec.end === "won") {
      played++;
      wins++;
      const n = Math.min(rec.guesses.length, MAX_GUESSES);
      if (n > 0) distribution[n - 1]++;
      run = prevWin !== null && shiftDay(prevWin, 1) === date ? run + 1 : 1;
      prevWin = date;
      maxStreak = Math.max(maxStreak, run);
    } else if (rec.end === "lost" || rec.end === "gaveUp") {
      played++;
    } else if (!rec.end && rec.guesses.length > 0 && date < today) {
      played++;
    }
  }

  const todayEnd = store.days[today]?.end;
  let currentStreak = 0;
  if (todayEnd === undefined || todayEnd === "won") {
    let d = todayEnd === "won" ? today : shiftDay(today, -1);
    while (store.days[d]?.end === "won") {
      currentStreak++;
      d = shiftDay(d, -1);
    }
  }
  return { played, wins, currentStreak, maxStreak, distribution };
}

/** Today's game, ready to draw. */
export function gameSnapshot(store: GuessStore, inputs: DayInputs, index: CountryIndex): GameSnapshot {
  const state = dayState(store, inputs, index);
  const rec = liveRecord(store, inputs);
  const answer = rec?.answer ?? inputs.city?.country ?? null;
  const guesses: GuessView[] = (rec?.guesses ?? []).map((g) => {
    const correct = g.code === answer;
    return {
      code: g.code,
      km: g.km,
      dir: compassPoint(g.deg),
      tier: correct ? MAX_TIER : proximityTier(g.km),
      correct,
    };
  });
  return {
    state,
    guesses,
    answer: isRevealed(state) ? answer : null,
    stats: guessStats(store, inputs.date),
    showCityInfo: store.showCityInfo,
    // Off, yet today is over without having been played to the end — skipped while
    // the preference was on, or given up by turning it on and back off. (With the
    // preference off, either state can only come from the day's own record.)
    resumesTomorrow: !store.showCityInfo && (state === "skipped" || state === "gaveUp"),
  };
}
