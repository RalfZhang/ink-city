import { MAX_GUESSES, MAX_TIER, type CompassPoint, type GameSnapshot } from "@inkcity/core";
import { formatCount } from "./format";

/**
 * The arrows, forced to text with U+FE0E: as emoji most platforms paint them blue,
 * which isn't the ink. Their width still differs from one platform to the next, so
 * each sits at the end of its line, where it can't push anything out of line.
 */
const ARROWS: Record<CompassPoint, string> = {
  n: "↑︎",
  ne: "↗︎",
  e: "→︎",
  se: "↘︎",
  s: "↓︎",
  sw: "↙︎",
  w: "←︎",
  nw: "↖︎",
};

/** The ink scale's cells as emoji, which every platform draws the same width — ■ and □ it doesn't. */
const CELL_ON = "⬛";
const CELL_OFF = "⬜";

/**
 * Today's result as text to pass on, giving nothing away: the date and the score,
 * then per guess the ink scale as squares, how far, and the way it pointed — never a
 * country's name. The squares are the ink and the paper, as on the page.
 */
export function shareText(snapshot: GameSnapshot, date: string, lang: string, url: string): string {
  const won = snapshot.state === "won";
  const lines = snapshot.guesses.map((g) => {
    const cells = CELL_ON.repeat(g.tier) + CELL_OFF.repeat(MAX_TIER - g.tier);
    return g.correct ? `${cells} ✓` : `${cells} ${formatCount(g.km, lang)} km ${ARROWS[g.dir]}`;
  });
  return [`InkCity ${date} ${won ? snapshot.guesses.length : "✕"}/${MAX_GUESSES}`, ...lines, url].join("\n");
}
