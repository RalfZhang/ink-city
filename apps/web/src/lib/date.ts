// The visitor's day. The schedule is keyed by calendar date and the website, like
// the desktop (which reads the OS's local date), plays the date the visitor is on —
// so two people on either side of midnight see different cities, each their own
// "today". Not core's `dateStamp`, which is UTC.

const pad = (n: number) => String(n).padStart(2, "0");

/** `YYYY-MM-DD` in the browser's own time zone. */
export function localDate(now = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Milliseconds from `now` to the next local midnight — a DST day's 23 or 25 hours included. */
export function msUntilMidnight(now = new Date()): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return next.getTime() - now.getTime();
}

/** `hh:mm:ss`, for the countdown to the next city. */
export function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}
