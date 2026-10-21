import type { City } from "@inkcity/core";
import { isLocaleCode, type LocaleCode } from "@inkcity/ui/i18n";

/**
 * The script each UI language reads, for `cityName` — null for the Latin-script
 * ones. Every shipped locale is listed, so a new one can't go unconsidered.
 */
const SCRIPT_OF: Record<LocaleCode, RegExp | null> = {
  id: null,
  de: null,
  en: null,
  es: null,
  fr: null,
  it: null,
  nl: null,
  pl: null,
  pt: null,
  vi: null,
  tr: null,
  ru: /\p{Script=Cyrillic}/u,
  uk: /\p{Script=Cyrillic}/u,
  ar: /\p{Script=Arabic}/u,
  hi: /\p{Script=Devanagari}/u,
  th: /\p{Script=Thai}/u,
  ko: /\p{Script=Hangul}/u,
  ja: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u,
  "zh-Hans": /\p{Script=Han}/u,
  "zh-Hant": /\p{Script=Han}/u,
};

/**
 * What to call `city` in a sentence in `lang`: its own name where that's written in
 * the script the language reads — 深圳 to a Chinese reader, Москва to a Russian one —
 * and its English name otherwise, which is what a Latin-script language would mostly
 * say anyway. The data holds those two names and no third, so it's a choice between
 * them.
 */
export function cityName(city: Pick<City, "name" | "localName">, lang: string): string {
  const script = isLocaleCode(lang) ? SCRIPT_OF[lang] : null;
  const local = city.localName.trim();
  return script && local && script.test(local) ? local : city.name;
}
