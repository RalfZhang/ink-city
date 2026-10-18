import { invoke } from "@tauri-apps/api/core";
import type { GuessStorage } from "@/core";

/**
 * The desktop's `GuessStorage` — the one platform-specific piece of the
 * guess-the-country game (the website swaps in core's `localStorageGuessStorage`).
 * The save lives in `app_data_dir/guess.json`, read and written by the backend
 * (src-tauri/src/guess_store.rs), which also moves a corrupt file aside before it is
 * ever handed back here — hence no `backupCorrupt`.
 */
export const tauriGuessStorage: GuessStorage = {
  load: () => invoke<string | null>("guess_store_read"),
  save: async (raw) => {
    await invoke("guess_store_write", { raw });
  },
};
