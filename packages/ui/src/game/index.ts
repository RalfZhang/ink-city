// `@inkcity/ui/game` — the guess-the-country game as both hosts draw it, in the
// map's ink: the stage (the day's game over its map, then the result — the city,
// the record, the guesses, the globe), and the messages that rise from its foot.
// Its styles are `@inkcity/ui/ink.css` (the pen's components) and
// `@inkcity/ui/game.css`; each host lays its own paper and ink under them as custom
// properties, and says where the foot sits (--stage-top, --stage-bottom,
// --toast-bottom). Its strings are the `ui` namespace. The pure
// helpers are importable on their own too (`@inkcity/ui/game/time`, …).
export { default as Stage, type StageMap } from "./Stage";
export type { OpenLink } from "./CityCard";
export { ToastProvider, useToast } from "./toast";
