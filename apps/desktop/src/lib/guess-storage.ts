import { invoke } from "@tauri-apps/api/core";
import type { GuessStorage } from "@inkcity/core";

/**
 * The desktop's `GuessStorage` — the one platform-specific piece of the
 * guess-the-country game (the website swaps in core's `localStorageGuessStorage`).
 * The save lives in `app_data_dir/guess.json`, read and written by the backend
 * (apps/desktop/src-tauri/src/guess_store.rs).
 *
 * `onRun` hears, after each save, the ticket of the run it started, or null when it
 * started none: a save that reveals the day starts the render that captions the
 * wallpaper (`guess_store_write`), and the home says when that's on the desktop.
 */
export function guessStorage(onRun?: (ticket: number | null) => void): GuessStorage {
  return {
    load: () => invoke<string | null>("guess_store_read"),
    save: async (raw) => {
      const ticket = await invoke<number | null>("guess_store_write", { raw });
      onRun?.(ticket);
    },
  };
}

/** The same, for a caller that doesn't wait on the run (Dev Mode). */
export const tauriGuessStorage: GuessStorage = guessStorage();
