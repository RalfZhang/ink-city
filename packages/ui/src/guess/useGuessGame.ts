import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyGuess,
  applySwitch,
  gameSnapshot,
  isDateStamp,
  parseGuessStore,
  serializeGuessStore,
  type CountryIndex,
  type DayInputs,
  type GameSnapshot,
  type GuessOutcome,
  type GuessStorage,
  type GuessStore,
} from "@inkcity/core";

export type GuessGame = {
  /** Today's game, or null until the save has been read and the day is known — draw nothing that could reveal the city yet. */
  snapshot: GameSnapshot | null;
  /** The whole save, every day of it, as last read or written — or null until it's been read. */
  store: GuessStore | null;
  /** A write is in flight; input waits, so saves land in the order they were made. */
  saving: boolean;
  /** The last write's failure, until a write next goes right: that guess didn't count. */
  error: GameError | null;
  /** Read the save again — the desktop's Dev Mode does, after the file was edited. */
  reload: () => void;
  /** Submit a guess. `"failed"` means it couldn't be saved, and so didn't count. */
  guess: (code: string) => Promise<GuessOutcome | "failed">;
  /**
   * The "Daily guess" switch: `false` opts out of the game, i.e. turns the save's
   * `showCityInfo` preference on (see `applySwitch`). Rejects with what was thrown
   * when the switch couldn't be saved, so the control can say so.
   */
  setPlaying: (playing: boolean) => Promise<void>;
};

/** A failure to write the save, and what was thrown. */
export type GameError = { kind: "save"; cause: unknown };

/**
 * The guess-the-country game as React state: the save file from `storage`, today's
 * inputs from the host, and the shared rules in packages/core/src/guess between them. Free of
 * Tauri on purpose — the desktop passes `tauriGuessStorage` and the Status-derived
 * inputs, the website its localStorage and its own day.
 *
 * Every change is computed, *saved*, and only then committed to state: if the write
 * fails nothing changes on screen, so a guess the player saw count is a guess that
 * was kept.
 */
export function useGuessGame(
  storage: GuessStorage,
  inputs: DayInputs,
  index: CountryIndex,
  onError: (e: unknown) => void,
): GuessGame {
  const [store, setStore] = useState<GuessStore | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<GameError | null>(null);
  const [attempt, setAttempt] = useState(0);
  // The load effect reports through this rather than depending on `onError`, which a
  // host may well pass as a fresh closure every render.
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  // The last write's failure: what `setPlaying` rejects with.
  const lastFailure = useRef<unknown>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const { store } = parseGuessStore(await storage.load());
        if (!live) return;
        setStore(store);
        setError(null);
      } catch (e) {
        onErrorRef.current(e);
      }
    })();
    return () => {
      live = false;
    };
  }, [storage, attempt]);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  /** Save `next`, then show it. `false` if the write failed — already reported. */
  const commit = async (next: GuessStore): Promise<boolean> => {
    setSaving(true);
    try {
      await storage.save(serializeGuessStore(next));
      setStore(next);
      setError(null);
      return true;
    } catch (e) {
      lastFailure.current = e;
      setError({ kind: "save", cause: e });
      onError(e);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const guess = async (code: string): Promise<GuessOutcome | "failed"> => {
    if (!store) return "notPlaying";
    const { store: next, outcome } = applyGuess(store, inputs, index, code);
    if (outcome !== "accepted") return outcome;
    return (await commit(next)) ? outcome : "failed";
  };

  const setPlaying = async (playing: boolean) => {
    if (!store) return;
    const next = applySwitch(store, inputs, !playing);
    if (next !== store && !(await commit(next))) throw lastFailure.current;
  };

  // Worked out once per change rather than on every render of the host — which, on
  // the desktop, re-renders with every status push — and not at all before the host
  // knows its date: a snapshot of no day is nothing to draw.
  const { date, city, ready } = inputs;
  const snapshot = useMemo(
    () => (store && isDateStamp(date) ? gameSnapshot(store, { date, city, ready }, index) : null),
    // The city by what the game reads of it, so a fresh object for the same city doesn't count.
    [store, date, city?.id, city?.country, city?.lat, city?.lon, ready, index],
  );
  return { snapshot, store, saving, error, reload, guess, setPlaying };
}
