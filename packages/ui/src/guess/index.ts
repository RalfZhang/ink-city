// The guess-the-country game's state, shared by the desktop app and the website:
// the hook both hosts run the day's game through. Free of any host API — storage
// and the day's inputs come in as arguments. The rules themselves live in
// `@inkcity/core`; the game as both hosts draw it is `@inkcity/ui/game`.
export { useGuessGame, type GameError, type GuessGame } from "./useGuessGame";
