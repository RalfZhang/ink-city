import { useEffect, useRef, useState, type RefObject } from "react";
import { localDate, msUntilMidnight } from "./date";

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

/** Milliseconds left until local midnight, ticking every second while `on`. */
export function useUntilMidnight(on: boolean): number {
  const [ms, setMs] = useState(msUntilMidnight);
  useEffect(() => {
    if (!on) return;
    setMs(msUntilMidnight());
    const id = setInterval(() => setMs(msUntilMidnight()), 1000);
    return () => clearInterval(id);
  }, [on]);
  return ms;
}

/** `ref`'s content-box size in CSS px, or null before it's laid out. */
export function useElementSize(ref: RefObject<HTMLElement | null>): { width: number; height: number } | null {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize((s) => (s && s.width === width && s.height === height ? s : { width, height }));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

/**
 * `value`, once it has held still for `ms` — except the first non-null value, which
 * passes straight through, so the map's first draw doesn't wait out a resize delay.
 */
export function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  const passed = useRef(false);
  useEffect(() => {
    if (!passed.current && value != null) {
      passed.current = true;
      setSettled(value);
      return;
    }
    const id = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return settled;
}
