import type { City } from "../types";

// Types for the daily "guess the country" game. The game is written once, here, for
// both hosts it runs on — the desktop app and the website — so nothing in this
// directory may know which one it's in: the host supplies the day's inputs
// (`DayInputs`) and a place to keep the save file (`GuessStorage`, store.ts), and
// everything between is shared.

/**
 * One row of `packages/core/data/countries.json`: a country or region the game accepts as a
 * guess. Like every core consumer of `packages/core/data`, the table is passed in by the
 * caller rather than imported here (see `countryIndex`).
 */
export type Country = {
  /** ISO 3166-1 alpha-2 (plus the user-assigned `XK`) — the same code space as `City.country`. */
  code: string;
  /** English display name: CLDR's, with a few overridden for captions (packages/core/data/README.md). */
  name: string;
  /** Reference point distances and bearings are measured from. */
  lat: number;
  lon: number;
};

/** Guesses per day. */
export const MAX_GUESSES = 6;

/**
 * How a day ended, as persisted in its `DayRecord`:
 *   • `won`     — the answer was guessed.
 *   • `lost`    — `MAX_GUESSES` misses.
 *   • `gaveUp`  — the game was switched off mid-game (counts as a loss).
 *   • `skipped` — the city was shown without being played (the preference was
 *                 turned *off* that day, so the day stays revealed — see `applySwitch`).
 * A const tuple so the parser can validate against it (the `LAYER_IDS` pattern).
 */
export const DAY_ENDS = ["won", "lost", "gaveUp", "skipped"] as const;
export type DayEnd = (typeof DAY_ENDS)[number];

/** One submitted guess, frozen at submit time so history never re-scores. */
export type Guess = {
  code: string;
  /** Great-circle distance from the guessed country's reference point to the city. */
  km: number;
  /** Rhumb-line bearing from the guessed country to the city, degrees from north. */
  deg: number;
};

/** One day of the save file, keyed by its `YYYY-MM-DD` date in `GuessStore.days`. */
export type DayRecord = {
  /** The city this record was played against — bound at the first guess. */
  cityId?: number;
  /** That city's country code, so a finished day is still scorable after the city is gone. */
  answer?: string;
  guesses: Guess[];
  /** Absent while the day is unplayed or in progress. */
  end?: DayEnd;
};

/**
 * The whole save file — `guess.json` on the desktop, a `localStorage` entry on the
 * website. This shape *is* the cross-host contract, so it only ever changes
 * additively, with `v` bumped (the OSM payload rule). The desktop backend also reads
 * two fields of it (`showCityInfo`, `days[*].end`) to decide whether the wallpaper
 * may show the city — see `isRevealed` and src-tauri/src/guess_store.rs.
 */
export type GuessStore = {
  v: number;
  /**
   * Skip the game and reveal every day. The UI shows it inverted, as the "Daily
   * guess" switch (on by default); stored this way round so that an absent field —
   * every save before the player touches the switch — means "play".
   */
  showCityInfo: boolean;
  days: Record<string, DayRecord>;
};

/** The subset of a `City` the game reads — a website can pass anything this shaped. */
export type DayCity = Pick<City, "id" | "country" | "lat" | "lon">;

/** What the host knows about today. */
export type DayInputs = {
  /** Today as `YYYY-MM-DD`, in the host's own notion of "today" (the desktop's comes from Rust). */
  date: string;
  /** Today's city, or null while it's still being resolved. */
  city: DayCity | null;
  /**
   * Whether the city's map is actually in front of the player — on the desktop, that
   * today's wallpaper has been set. The game waits for it, so nobody plays against a
   * map they can't see yet.
   */
  ready: boolean;
};

/**
 * Where a day stands, derived from the save file plus `DayInputs` (`dayState`):
 *   • `resolving`   — no city yet.
 *   • `painting`    — the city is known but its map isn't showing yet.
 *   • `playing`     — guesses accepted.
 *   • a `DayEnd`    — finished (or skipped).
 *   • `unavailable` — the answer's country isn't in the country table, so the day
 *                     can't be played; it's simply revealed.
 */
export type GameState = "resolving" | "painting" | "playing" | "unavailable" | DayEnd;

/** The eight compass points a bearing is reported as. */
export const COMPASS_POINTS = ["n", "ne", "e", "se", "s", "sw", "w", "nw"] as const;
export type CompassPoint = (typeof COMPASS_POINTS)[number];

/** A guess as the UI draws it. */
export type GuessView = {
  code: string;
  km: number;
  /** Which way today's city lies from the guessed country — not drawn for the correct guess. */
  dir: CompassPoint;
  /** Proximity on the 0–5 ink scale (5 = closest), `MAX_TIER` for the correct guess. */
  tier: number;
  correct: boolean;
};

export type GuessStats = {
  /** Finished games: won + lost + gave up, plus past days abandoned mid-game. */
  played: number;
  wins: number;
  /** Consecutive won calendar days, ending today (if won) or yesterday. */
  currentStreak: number;
  maxStreak: number;
  /** Wins by guess count — index 0 is a first-guess win. Length `MAX_GUESSES`. */
  distribution: number[];
};

/** Everything the UI needs to draw today's game, from `gameSnapshot`. */
export type GameSnapshot = {
  state: GameState;
  guesses: GuessView[];
  /** The answer's country code — only once the day is revealed. */
  answer: string | null;
  stats: GuessStats;
  showCityInfo: boolean;
  /**
   * The preference is off but today was already given away (skipped, or given up),
   * so today stays revealed and the game resumes tomorrow — what the switch's
   * caption says.
   */
  resumesTomorrow: boolean;
};
