import type { City } from "./types";

// Daily city selection. This MUST stay byte-for-byte equivalent to the Rust
// implementation in `src-tauri/src/city.rs` (the desktop daemon picks the city
// in Rust; the website / CI pick it here). If they diverge, the website would
// show a different city than the user's wallpaper.

/** Epoch day 0 of the rotation: 2023-03-03 (UTC). */
export const EPOCH_UTC = Date.UTC(2023, 2, 3);
const MS_PER_DAY = 86_400_000;

// A prime coprime to N makes `(days * MULTIPLIER) % N` a permutation of
// 0..N-1, so the population-sorted cities list yields a random-feeling,
// non-repeating daily sequence. 379 is prime, so it stays coprime to most N as
// the list grows. Keep in sync with MULTIPLIER in src-tauri/src/city.rs.
export const MULTIPLIER = 379;

/** Whole days from the epoch to `date` (UTC, can be negative). */
export function daysSinceEpoch(date: Date): number {
  const day = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return Math.floor((day - EPOCH_UTC) / MS_PER_DAY);
}

/** Index into a list of `n` cities for the given date. */
export function dayIndex(date: Date, n: number): number {
  const days = daysSinceEpoch(date);
  const raw = ((days % n) + n) % n;
  return (raw * MULTIPLIER) % n;
}

/** Pick the city for `date` from a population-sorted list. */
export function pickCityForDate(date: Date, cities: readonly City[]): City {
  return cities[dayIndex(date, cities.length)];
}

/** `YYYY-MM-DD` (UTC) — the cache key for a day's artifacts. */
export function dateStamp(date: Date): string {
  return date.toISOString().slice(0, 10);
}
