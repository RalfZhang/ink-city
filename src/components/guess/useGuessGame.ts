import { useEffect, useRef, useState } from "react";
import {
  applyGuess,
  applySwitch,
  gameSnapshot,
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
  /** Today's game, or null until the save has been read — draw nothing that could reveal the city yet. */
  snapshot: GameSnapshot | null;
  /** A write is in flight; input waits, so saves land in the order they were made. */
  saving: boolean;
  /** Submit a guess. `"failed"` means it couldn't be saved, and so didn't count. */
  guess: (code: string) => Promise<GuessOutcome | "failed">;
  /**
   * The "Daily guess" switch: `false` opts out of the game, i.e. turns the save's
   * `showCityInfo` preference on (see `applySwitch`).
   */
  setPlaying: (playing: boolean) => Promise<void>;
};

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
  // The load effect reports through this rather than depending on `onError`, which a
  // host may well pass as a fresh closure every render.
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const raw = await storage.load();
        const parsed = parseGuessStore(raw);
        if (parsed.corrupt && raw !== null) await storage.backupCorrupt?.(raw);
        if (live) setStore(parsed.store);
      } catch (e) {
        // Leave `store` null: playing on would overwrite a save we merely failed to
        // read. The error banner says what went wrong.
        onErrorRef.current(e);
      }
    })();
    return () => {
      live = false;
    };
  }, [storage]);

  /** Save `next`, then show it. `false` if the write failed — already reported. */
  const commit = async (next: GuessStore): Promise<boolean> => {
    setSaving(true);
    try {
      await storage.save(serializeGuessStore(next));
      setStore(next);
      return true;
    } catch (e) {
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
    if (next !== store) await commit(next);
  };

  const snapshot = store ? gameSnapshot(store, inputs, index) : null;
  return { snapshot, saving, guess, setPlaying };
}
