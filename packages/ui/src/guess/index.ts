// The guess-the-country game's React layer, shared by the desktop app and the
// website: the state hook, the presentational pieces, and `DailyGuess`, which picks
// between them for the day. Free of any host API — storage, the day's inputs and
// host-specific wording all come in as arguments or props. The rules themselves
// live in `@inkcity/core`.
export { useGuessGame, type GuessGame } from "./useGuessGame";
export { default as DailyGuess } from "./DailyGuess";
export { default as GuessCountry } from "./GuessCountry";
export { default as GuessResult } from "./GuessResult";
export { default as GuessRow } from "./GuessRow";
