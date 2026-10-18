import type { CountryIndex } from "./game";
import type { Country } from "./types";

// Country names in the player's language, and the guess box's lookup. Names come
// from the platform's CLDR data (`Intl.DisplayNames`), so all 20 UI languages are
// covered without a translation table; the English `name` in the country table is
// the fallback where the platform has none (old WebKit) and the label in English.

type Names = { long: Intl.DisplayNames; short: Intl.DisplayNames } | null;
const namesCache = new Map<string, Names>();

function namesFor(lang: string): Names {
  let names = namesCache.get(lang);
  if (names === undefined) {
    try {
      names = {
        long: new Intl.DisplayNames([lang], { type: "region" }),
        short: new Intl.DisplayNames([lang], { type: "region", style: "short" }),
      };
    } catch {
      names = null; // no Intl.DisplayNames (WebKit < 14.1) or an unknown tag
    }
    namesCache.set(lang, names);
  }
  return names;
}

function cldrName(lang: string, code: string, style: "long" | "short"): string | null {
  try {
    const name = namesFor(lang)?.[style].of(code);
    return name && name !== code ? name : null;
  } catch {
    return null;
  }
}

/**
 * A country's display name in `lang` (any BCP-47 tag — the UI's locale code works
 * as is). English uses the table's own `name`, whose few overrides read better than
 * CLDR's ("Hong Kong", not "Hong Kong SAR China"); every other language gets CLDR's
 * standard name.
 */
export function countryName(index: CountryIndex, code: string, lang: string): string {
  const own = index.byCode.get(code)?.name ?? code;
  if (lang.toLowerCase().startsWith("en")) return own;
  return cldrName(lang, code, "long") ?? own;
}

/**
 * Fold a query or a name to its searchable form: compatibility-decomposed with the
 * combining marks dropped (so "cote d ivoire" finds "Côte d’Ivoire"), lower-cased,
 * "&" spelled out, and every run of punctuation collapsed to one space. Applied to
 * both sides, so scripts it simplifies (Devanagari matras, Japanese dakuten) still
 * match consistently.
 */
export function normalizeCountryQuery(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * English names people type that neither CLDR spelling nor the code covers. Kept
 * short on purpose — it's a convenience for the commonest misses, not a gazetteer.
 */
const ALIASES: Record<string, readonly string[]> = {
  US: ["usa", "america", "united states of america"],
  GB: ["uk", "britain", "great britain", "england", "scotland", "wales", "northern ireland"],
  AE: ["uae", "emirates"],
  NL: ["holland"],
  CZ: ["czech republic"],
  CI: ["ivory coast"],
  MM: ["burma"],
  CD: ["drc", "congo kinshasa", "democratic republic of the congo"],
  CG: ["congo brazzaville", "republic of the congo"],
  TR: ["turkey"],
  KR: ["korea", "republic of korea"],
  KP: ["dprk"],
  RU: ["russian federation"],
  SZ: ["swaziland"],
  MK: ["macedonia"],
  CV: ["cape verde"],
  TL: ["east timor"],
  VA: ["vatican", "holy see"],
  BA: ["bosnia"],
  VN: ["viet nam"],
  IR: ["persia"],
};

type Entry = { country: Country; label: string; keys: string[] };
const entryCache = new WeakMap<CountryIndex, Map<string, Entry[]>>();

/** Every way `lang`'s player might type each country, normalized once per index + language. */
function entriesFor(index: CountryIndex, lang: string): Entry[] {
  let byLang = entryCache.get(index);
  if (!byLang) {
    byLang = new Map();
    entryCache.set(index, byLang);
  }
  let entries = byLang.get(lang);
  if (!entries) {
    entries = index.list.map((country) => {
      const raw = [
        countryName(index, country.code, lang),
        cldrName(lang, country.code, "short"),
        country.name,
        cldrName("en", country.code, "long"),
        cldrName("en", country.code, "short"),
        ...(ALIASES[country.code] ?? []),
      ];
      const keys = new Set<string>();
      for (const name of raw) {
        if (!name) continue;
        const key = normalizeCountryQuery(name);
        if (!key) continue;
        keys.add(key);
        // CLDR abbreviates "St." — let "saint lucia" find it too.
        if (key.startsWith("st ")) keys.add(`saint ${key.slice(3)}`);
      }
      return { country, label: countryName(index, country.code, lang), keys: [...keys] };
    });
    byLang.set(lang, entries);
  }
  return entries;
}

/** Lower is better; null = no match. */
function score(entry: Entry, q: string): number | null {
  if (q.length === 2 && entry.country.code.toLowerCase() === q) return 0;
  let best: number | null = null;
  for (const key of entry.keys) {
    const s =
      key === q
        ? 1
        : key.startsWith(q)
          ? 2
          : key.split(" ").some((w) => w.startsWith(q))
            ? 3
            : key.includes(q)
              ? 4
              : null;
    if (s !== null && (best === null || s < best)) best = s;
  }
  return best;
}

/**
 * The guess box's suggestions for `query`: an exact two-letter code first, then
 * whole-name, prefix, word-prefix and substring matches across the player's
 * language, English and the aliases above; ties in `lang`'s collation order. Codes
 * in `exclude` (already guessed) never come back.
 */
export function searchCountries(
  index: CountryIndex,
  query: string,
  lang: string,
  exclude: Iterable<string> = [],
  limit = 6,
): Country[] {
  const q = normalizeCountryQuery(query);
  if (!q) return [];
  const skip = new Set(exclude);
  const hits: [number, Entry][] = [];
  for (const entry of entriesFor(index, lang)) {
    if (skip.has(entry.country.code)) continue;
    const s = score(entry, q);
    if (s !== null) hits.push([s, entry]);
  }
  let collator: Intl.Collator;
  try {
    collator = new Intl.Collator(lang);
  } catch {
    collator = new Intl.Collator();
  }
  hits.sort((a, b) => a[0] - b[0] || collator.compare(a[1].label, b[1].label));
  return hits.slice(0, limit).map(([, e]) => e.country);
}

/**
 * The country a query names outright — a code, or a name/alias typed in full — or
 * null. What lets Enter submit a typed name without picking it from the list first.
 */
export function exactCountry(index: CountryIndex, query: string, lang: string): Country | null {
  const q = normalizeCountryQuery(query);
  if (!q) return null;
  for (const entry of entriesFor(index, lang)) {
    const s = score(entry, q);
    if (s === 0 || s === 1) return entry.country;
  }
  return null;
}
