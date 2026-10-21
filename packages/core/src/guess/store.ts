import { DAY_ENDS, type DayEnd, type DayRecord, type Guess, type GuessStore } from "./types";

// The save file: its (de)serialization and the one seam where the two hosts differ.
// The desktop app keeps the JSON in `guess.json` through Rust commands
// (apps/desktop/src/lib/guess-storage.ts → apps/desktop/src-tauri/src/guess_store.rs);
// the website keeps the same JSON in `localStorage` (`localStorageGuessStorage`
// below). Everything else about the game is shared.

/** Bump on any change to `GuessStore`'s shape — additive changes only. */
export const GUESS_STORE_VERSION = 1;

/**
 * Where a host keeps the serialized save file. Async because the desktop's lives
 * behind IPC; a synchronous store (localStorage) just resolves immediately.
 */
export interface GuessStorage {
  /** The stored JSON, or null when nothing has been saved yet. */
  load(): Promise<string | null>;
  /** Persist `raw`. A rejection means the write didn't happen. */
  save(raw: string): Promise<void>;
  /**
   * Set aside an unparseable save before the next `save` overwrites it. Optional:
   * the desktop backend already does this itself when it reads the file.
   */
  backupCorrupt?(raw: string): Promise<void>;
}

export function emptyGuessStore(): GuessStore {
  return { v: GUESS_STORE_VERSION, showCityInfo: false, days: {} };
}

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const CODE = /^[A-Z]{2}$/;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function parseGuess(v: unknown): Guess | null {
  if (!isObject(v)) return null;
  const { code, km, deg } = v;
  if (typeof code !== "string" || !CODE.test(code) || !isFiniteNumber(km) || !isFiniteNumber(deg)) {
    return null;
  }
  return { code, km, deg };
}

function parseRecord(v: unknown): DayRecord | null {
  if (!isObject(v)) return null;
  // Built in `DayRecord`'s field order, which is also the order the file is written in.
  return {
    ...(isFiniteNumber(v.cityId) ? { cityId: v.cityId } : {}),
    ...(typeof v.answer === "string" && CODE.test(v.answer) ? { answer: v.answer } : {}),
    guesses: Array.isArray(v.guesses)
      ? v.guesses.map(parseGuess).filter((g): g is Guess => g !== null)
      : [],
    ...((DAY_ENDS as readonly unknown[]).includes(v.end) ? { end: v.end as DayEnd } : {}),
  };
}

/**
 * Parse a stored save, salvaging what it can: a malformed field falls back to its
 * default and a malformed record or guess is dropped, rather than losing the whole
 * history to one bad entry. `corrupt` is set only when nothing could be read at all
 * (not JSON, or not an object) — the cue for the host to `backupCorrupt` it first.
 *
 * `end` survives on its own even when the rest of a record is damaged; the desktop
 * backend reads exactly that field to decide whether the day is revealed, so the two
 * readings agree (apps/desktop/src-tauri/src/guess_store.rs).
 */
export function parseGuessStore(raw: string | null): { store: GuessStore; corrupt: boolean } {
  if (raw === null || raw.trim() === "") return { store: emptyGuessStore(), corrupt: false };
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return { store: emptyGuessStore(), corrupt: true };
  }
  if (!isObject(v)) return { store: emptyGuessStore(), corrupt: true };
  const store = emptyGuessStore();
  if (typeof v.showCityInfo === "boolean") store.showCityInfo = v.showCityInfo;
  if (isObject(v.days)) {
    for (const [date, rec] of Object.entries(v.days)) {
      if (!DATE_KEY.test(date)) continue;
      const parsed = parseRecord(rec);
      if (parsed) store.days[date] = parsed;
    }
  }
  return { store, corrupt: false };
}

/** Serialize for storage — pretty-printed, since on the desktop it's a file people open. */
export function serializeGuessStore(store: GuessStore): string {
  return JSON.stringify({ ...store, v: GUESS_STORE_VERSION }, null, 2);
}

/** The website's save: its `localStorage` key. */
export const GUESS_STORAGE_KEY = "inkcity:guess";

/**
 * The website's `GuessStorage`: the save file under one `localStorage` key, with an
 * unreadable save copied to `<key>:corrupt` before it can be overwritten. Reads
 * swallow storage errors (private mode, blocked site data) and act as "nothing
 * saved"; writes let them propagate so the game knows the guess wasn't kept.
 */
export function localStorageGuessStorage(key = GUESS_STORAGE_KEY): GuessStorage {
  return {
    async load() {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    async save(raw) {
      localStorage.setItem(key, raw);
    },
    async backupCorrupt(raw) {
      try {
        localStorage.setItem(`${key}:corrupt`, raw);
      } catch {
        // Best effort: losing the backup is no worse than the corrupt save itself.
      }
    },
  };
}
