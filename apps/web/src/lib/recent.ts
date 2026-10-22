import type { GuessStore } from "@inkcity/core";
import { shiftStamp } from "@inkcity/core/schedule";

/** How far back a visit to the game still makes a player a returning one, in days (today included). */
export const RECENT_DAYS = 7;

/**
 * Whether the save has a guess — any guess, right or wrong — on one of the
 * `days` days up to and including `today`. A player who has played lately knows
 * the game: the page takes them straight to it rather than offering the choice of
 * playing (game/Stage.tsx).
 */
export function playedWithin(store: GuessStore, today: string, days = RECENT_DAYS): boolean {
  const from = shiftStamp(today, -(days - 1));
  return Object.entries(store.days).some(([date, rec]) => date >= from && date <= today && rec.guesses.length > 0);
}
