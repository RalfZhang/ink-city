import { useCallback, useEffect, useState, type RefObject } from "react";
import { localDate, msUntilMidnight } from "./date";

/** Anyone who'd rather nothing moved. */
export const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

/** Whether motion should be left out right now — for what's animated from script, once. */
export function prefersReducedMotion(): boolean {
  return window.matchMedia(REDUCED_MOTION).matches;
}

/** Whether `query` matches, kept current. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const update = () => setMatches(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [query]);
  return matches;
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

/**
 * Today's local date, rolling over at midnight. Checked on a timer aimed at the
 * next midnight and again whenever the tab comes back into view: background tabs
 * have their timers throttled and a sleeping laptop has none at all, so the timer
 * alone could wake up a day late.
 */
export function useLocalDate(): string {
  const [date, setDate] = useState(localDate);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const check = () => {
      setDate(localDate());
      clearTimeout(timer);
      timer = setTimeout(check, msUntilMidnight() + 500);
    };
    check();
    const onVisible = () => {
      if (document.visibilityState === "visible") check();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", check);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", check);
    };
  }, []);
  return date;
}

/** Milliseconds left until local midnight, ticking every second. */
export function useUntilMidnight(): number {
  const [ms, setMs] = useState(msUntilMidnight);
  useEffect(() => {
    const id = setInterval(() => setMs(msUntilMidnight()), 1000);
    return () => clearInterval(id);
  }, []);
  return ms;
}

/**
 * `ref`'s content-box size in CSS px, or null before it's laid out. With `settleMs`,
 * a new size is taken up only once it has held still that long — except the first,
 * which passes straight through, so the map's first draw doesn't wait out a resize
 * delay — and a drag-resize re-renders the caller once, not on every frame.
 */
export function useElementSize(
  ref: RefObject<HTMLElement | null>,
  settleMs = 0,
): { width: number; height: number } | null {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let first = true;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      const take = () => setSize((s) => (s && s.width === width && s.height === height ? s : { width, height }));
      clearTimeout(timer);
      if (first || settleMs <= 0) take();
      else timer = setTimeout(take, settleMs);
      first = false;
    });
    observer.observe(el);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [ref, settleMs]);
  return size;
}

/**
 * How much of the page an on-screen keyboard covers, px, kept as `--kb` on the root
 * for what has to stay above it (play.css's foot): the layout viewport's height past
 * the bottom of the visual one, while a text field has the focus. Nothing for a
 * pinch-zoomed page, whose visual viewport is small for another reason.
 */
export function useKeyboardInset(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const update = () => {
      const typing = document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement;
      const covered = typing && Math.abs(vv.scale - 1) < 0.01 ? window.innerHeight - vv.height - vv.offsetTop : 0;
      root.style.setProperty("--kb", `${Math.max(0, Math.round(covered))}px`);
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    window.addEventListener("focusin", update);
    window.addEventListener("focusout", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      window.removeEventListener("focusin", update);
      window.removeEventListener("focusout", update);
      root.style.removeProperty("--kb");
    };
  }, []);
}
