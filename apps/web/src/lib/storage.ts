import { useEffect, useMemo, useState } from "react";
import { GUESS_STORAGE_KEY, localStorageGuessStorage, type GuessStorage } from "@inkcity/core";

/**
 * `inner`, except that a write it refuses (storage full, site data blocked, a
 * private window) doesn't fail the guess: the save moves into memory instead and
 * `onMemoryOnly` fires, so the page can say the game won't outlive the tab.
 * Without this, core's `useGuessGame` would reject the guess as unsaved — the right
 * call on the desktop, where a failed write is rare and worth retrying, but on the
 * web a browser that won't store anything would leave the game unplayable.
 */
export function memoryFallback(inner: GuessStorage, onMemoryOnly: () => void): GuessStorage {
  let memory: string | null | undefined;
  return {
    load: async () => (memory !== undefined ? memory : inner.load()),
    async save(raw) {
      if (memory === undefined) {
        try {
          await inner.save(raw);
          return;
        } catch {
          onMemoryOnly();
        }
      }
      memory = raw;
    },
    backupCorrupt: inner.backupCorrupt,
  };
}

/**
 * The website's save: localStorage, falling back to memory (`memoryOnly`), and
 * re-read whenever another tab writes it — `useGuessGame` reloads on a new storage
 * object, so a guess made in one tab shows up in the others.
 */
export function useGuessStorage(): { storage: GuessStorage; memoryOnly: boolean } {
  const [memoryOnly, setMemoryOnly] = useState(false);
  const base = useMemo(() => memoryFallback(localStorageGuessStorage(), () => setMemoryOnly(true)), []);
  const [storage, setStorage] = useState<GuessStorage>(base);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === GUESS_STORAGE_KEY || e.key === null) setStorage({ ...base });
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [base]);

  return { storage, memoryOnly };
}
