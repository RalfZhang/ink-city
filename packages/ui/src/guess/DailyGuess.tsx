import { isRevealed, type CountryIndex } from "@inkcity/core";
import type { GuessGame } from "./useGuessGame";
import GuessCountry from "./GuessCountry";
import GuessResult from "./GuessResult";

type Props = {
  game: GuessGame;
  /** Today; a new date starts the guess card fresh. */
  date: string;
  index: CountryIndex;
  /** See GuessCountry's `paintingLine`. */
  paintingLine: string;
};

/**
 * Today's game in the host's daily view, under its city card: the guess card while
 * the day is waiting or underway, today's result once a played game is over, and
 * nothing before the save has been read, or after a day that was skipped,
 * unavailable, or given up before the first guess.
 */
export default function DailyGuess({ game, date, index, paintingLine }: Props) {
  const { snapshot } = game;
  if (!snapshot) return null;
  if (!isRevealed(snapshot.state)) {
    return (
      <GuessCountry
        key={date}
        snapshot={snapshot}
        index={index}
        saving={game.saving}
        paintingLine={paintingLine}
        onGuess={game.guess}
      />
    );
  }
  const over = snapshot.state === "won" || snapshot.state === "lost" || snapshot.state === "gaveUp";
  return over && snapshot.guesses.length > 0 ? <GuessResult snapshot={snapshot} index={index} /> : null;
}
