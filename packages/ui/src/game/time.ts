import { useEffect, useState } from "react";

// The time to the next city: local midnight, which is when the day turns over for
// both hosts — the website plays the visitor's own date, the desktop the OS's.

const pad = (n: number) => String(n).padStart(2, "0");

/** Milliseconds from `now` to the next local midnight — a DST day's 23 or 25 hours included. */
export function msUntilMidnight(now = new Date()): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return next.getTime() - now.getTime();
}

/**
 * Milliseconds from `now` to the midnight that ends `date` (`YYYY-MM-DD`, local),
 * or 0 once that's passed. Null for a date that isn't one.
 */
export function msUntilDayEnd(date: string, now = new Date()): number | null {
  const [y, m, d] = date.split("-").map(Number);
  const end = new Date(y, m - 1, d + 1).getTime();
  return Number.isFinite(end) ? Math.max(0, end - now.getTime()) : null;
}

/** `hh:mm:ss`, for the countdown to the next city. */
export function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/**
 * Milliseconds left until local midnight, ticking every second. Given the `date`
 * on screen, the midnight that ends it: past that — the host not on the new day yet
 * — it holds at 0 rather than counting a fresh 24 hours down over the old day.
 */
export function useUntilMidnight(date?: string): number {
  const left = () => (date !== undefined ? msUntilDayEnd(date) : null) ?? msUntilMidnight();
  const [ms, setMs] = useState(left);
  useEffect(() => {
    setMs(left());
    const id = setInterval(() => setMs(left()), 1000);
    return () => clearInterval(id);
    // `left` reads `date`, and only that.
  }, [date]);
  return ms;
}
