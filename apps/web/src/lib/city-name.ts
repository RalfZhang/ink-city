import type { City } from "@inkcity/core";

/** The script each non-Latin UI language reads, for `cityName`. */
const SCRIPT_OF: Partial<Record<string, RegExp>> = {
  "zh-Hans": /\p{Script=Han}/u,
  "zh-Hant": /\p{Script=Han}/u,
  ja: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u,
  ko: /\p{Script=Hangul}/u,
  ru: /\p{Script=Cyrillic}/u,
  uk: /\p{Script=Cyrillic}/u,
  ar: /\p{Script=Arabic}/u,
  hi: /\p{Script=Devanagari}/u,
  th: /\p{Script=Thai}/u,
};

/**
 * What to call `city` in a sentence in `lang`: its own name where that's written in
 * the script the language reads — 深圳 to a Chinese reader, Москва to a Russian one —
 * and its English name otherwise, which is what a Latin-script language would mostly
 * say anyway. The data holds those two names and no third, so it's a choice between
 * them.
 */
export function cityName(city: Pick<City, "name" | "localName">, lang: string): string {
  const script = SCRIPT_OF[lang];
  const local = city.localName.trim();
  return script && local && script.test(local) ? local : city.name;
}
