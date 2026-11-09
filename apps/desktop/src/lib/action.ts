import { useCallback, useRef, useState } from "react";
import { logError } from "./log";

/** A rejection as the user reads it: Tauri commands reject with their message as a plain string. */
export const errorText = (e: unknown): string =>
  e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e);

/**
 * One control's command and how it went: `run` it, and while it's out `busy` is
 * true; if it fails, `error` holds why — kept, next to the control, until the next
 * try succeeds. A failure never becomes a passing message: it's something to be
 * seen.
 */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = useRef(0);

  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    const id = ++live.current;
    setBusy(true);
    try {
      const out = await fn();
      if (id === live.current) setError(null);
      return out;
    } catch (e) {
      logError("[ui] action failed", e);
      if (id === live.current) setError(errorText(e));
      return undefined;
    } finally {
      if (id === live.current) setBusy(false);
    }
  }, []);

  return { run, busy, error };
}
