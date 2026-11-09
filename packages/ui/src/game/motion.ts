import { useCallback, useEffect, useState, type KeyboardEvent } from "react";

/** Anyone who'd rather nothing moved. */
export const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

/** Whether motion should be left out right now — for what's animated from script, once. */
export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia(REDUCED_MOTION).matches;
}

/** A line's "no": it shakes its head, once — unless motion is left out. */
export function shake(el: Element | null | undefined): void {
  if (!el || prefersReducedMotion()) return;
  el.animate(
    [{ translate: "0" }, { translate: "-6px" }, { translate: "5px" }, { translate: "-3px" }, { translate: "2px" }, { translate: "0" }],
    { duration: 380, easing: "ease-out" },
  );
}

/** Whether a key is the IME's, mid-composition — a line's own keys leave it alone. keyCode 229 covers WebKit's composition keys. */
export function isComposing(e: KeyboardEvent): boolean {
  return e.nativeEvent.isComposing || e.keyCode === 229;
}

/**
 * A value that clears itself `ms` after it's set: a word up for a moment. Set again —
 * even to the same word — it stays its full time from then.
 */
export function useTransient<T>(ms: number): [T | null, (value: T | null) => void] {
  // Boxed, so every set is a change, and restarts the clock.
  const [held, setHeld] = useState<{ value: T } | null>(null);
  useEffect(() => {
    if (held === null) return;
    const id = setTimeout(() => setHeld(null), ms);
    return () => clearTimeout(id);
  }, [held, ms]);
  const set = useCallback((value: T | null) => setHeld(value === null ? null : { value }), []);
  return [held === null ? null : held.value, set];
}
