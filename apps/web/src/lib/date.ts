// The visitor's day. The schedule is keyed by calendar date and the website, like
// the desktop (which reads the OS's local date), plays the date the visitor is on —
// so two people on either side of midnight see different cities, each their own
// "today". Not core's `dateStamp`, which is UTC.

const pad = (n: number) => String(n).padStart(2, "0");

// The time to midnight, and the countdown, are the game's (@inkcity/ui/game/time).

/** `YYYY-MM-DD` in the browser's own time zone. */
export function localDate(now = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
