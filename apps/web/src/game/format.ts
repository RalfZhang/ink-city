import { COMPASS_POINTS, normalizeCountryQuery, type CompassPoint } from "@inkcity/core";

/** A compass point's bearing, degrees clockwise from north: the points go round in 45° steps. */
export function bearing(point: CompassPoint): number {
  return COMPASS_POINTS.indexOf(point) * 45;
}

/** `1,234 km`, in the player's language where the platform knows how. */
export function formatKm(km: number, lang: string): string {
  try {
    return new Intl.NumberFormat(lang, { style: "unit", unit: "kilometer", maximumFractionDigits: 0 }).format(km);
  } catch {
    return `${Math.round(km)} km`;
  }
}

/** A count in the player's language: its own digits, where it has them. */
export function formatCount(n: number, lang: string): string {
  try {
    return new Intl.NumberFormat(lang).format(n);
  } catch {
    return String(n);
  }
}

/**
 * Where in `text` the folded `query` is, as typed — folded the same way as the
 * search, so "cote" is found in "Côte d’Ivoire" — as [start, end) in `text`, or null
 * where it isn't: a match the search found some other way (an alias, the English
 * name, the code).
 */
export function matchSpan(text: string, query: string): [number, number] | null {
  if (!query) return null;
  // Fold character by character, keeping where each folded character came from. A
  // combining mark (an accent, a matra, a Thai vowel or tone) folds away, leaving
  // nothing; what else folds to nothing (spaces, punctuation) is one space per run,
  // as it is in the folded query.
  const folded: string[] = [];
  const from: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const f = normalizeCountryQuery(text[i]);
    if (!f && /^\p{M}+$/u.test(text[i].normalize("NFKD"))) continue;
    const g = f || " ";
    if (g === " " && (folded.length === 0 || folded[folded.length - 1] === " ")) continue;
    for (const ch of g) {
      folded.push(ch);
      from.push(i);
    }
  }
  const at = folded.join("").indexOf(query);
  return at < 0 ? null : [from[at], from[at + query.length - 1] + 1];
}
