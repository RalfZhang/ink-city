/** `YYYY-MM-DD` (UTC) — the cache key for a day's artifacts. */
export function dateStamp(date: Date): string {
  return date.toISOString().slice(0, 10);
}
