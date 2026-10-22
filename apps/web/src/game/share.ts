import { MAX_GUESSES, MAX_TIER, type CompassPoint, type GameSnapshot } from "@inkcity/core";
import { formatCount } from "./format";

const ARROWS: Record<CompassPoint, string> = { n: "↑", ne: "↗", e: "→", se: "↘", s: "↓", sw: "↙", w: "←", nw: "↖" };

/**
 * Today's result as text to pass on, giving nothing away: the date and the score,
 * then per guess the ink scale as squares and the way it pointed — never a
 * country's name. The squares are the ink and the paper, as on the page.
 */
export function shareText(snapshot: GameSnapshot, date: string, lang: string, url: string): string {
  const won = snapshot.state === "won";
  const lines = snapshot.guesses.map((g) => {
    const cells = "■".repeat(g.tier) + "□".repeat(MAX_TIER - g.tier);
    return g.correct ? `${cells} ✓` : `${cells} ${ARROWS[g.dir]} ${formatCount(g.km, lang)} km`;
  });
  return [`InkCity ${date} ${won ? snapshot.guesses.length : "✕"}/${MAX_GUESSES}`, ...lines, url].join("\n");
}
