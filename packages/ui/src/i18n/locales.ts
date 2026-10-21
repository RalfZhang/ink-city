// The locales InkCity ships, for every host: each one's code, native name,
// direction, and which browser/OS language tags resolve to it. An app pairs these
// with its own strings (apps/desktop/src/i18n and apps/web/src/i18n), and this
// package's `ui` namespace covers every one of them too — `pnpm check:i18n` holds
// all three catalogs to this list, so adding a language is a line here plus its
// JSON in each.
//
// Intentionally free of i18next, the DOM and the locale JSON, so the Node-side
// parity check can import it.

export interface LocaleDef {
  /** BCP-47-ish code; used as the i18next language key and the stored value. */
  code: string;
  /** Native name shown in the language picker. */
  label: string;
  /** Writing direction; omit for the default "ltr". */
  dir?: "rtl";
  /**
   * Whether a lowercased OS/browser language tag resolves to this locale. Each
   * predicate is self-contained (Chinese branches on script/region), so the
   * table order below never affects detection — it only drives the picker order.
   */
  detect: (lang: string) => boolean;
}

const isTraditionalChinese = (l: string) =>
  l.includes("hant") || l.includes("tw") || l.includes("hk") || l.includes("mo");

// Order here is the picker order: every locale sorted by its native name via
// Unicode collation — Latin-script languages A→Z (English sits between Deutsch
// and Español), then Cyrillic, Arabic, Devanagari, Thai, and CJK. Detection and
// the "en" fallback are order-independent (each `detect` is self-contained; the
// fallback is `detectLocale`'s), so reordering only reshuffles the menu.
export const LOCALES = [
  { code: "id", label: "Bahasa Indonesia", detect: (l: string) => l.startsWith("id") },
  { code: "de", label: "Deutsch", detect: (l: string) => l.startsWith("de") },
  { code: "en", label: "English", detect: (l: string) => l.startsWith("en") },
  { code: "es", label: "Español", detect: (l: string) => l.startsWith("es") },
  { code: "fr", label: "Français", detect: (l: string) => l.startsWith("fr") },
  { code: "it", label: "Italiano", detect: (l: string) => l.startsWith("it") },
  { code: "nl", label: "Nederlands", detect: (l: string) => l.startsWith("nl") },
  { code: "pl", label: "Polski", detect: (l: string) => l.startsWith("pl") },
  { code: "pt", label: "Português", detect: (l: string) => l.startsWith("pt") },
  { code: "vi", label: "Tiếng Việt", detect: (l: string) => l.startsWith("vi") },
  { code: "tr", label: "Türkçe", detect: (l: string) => l.startsWith("tr") },
  { code: "ru", label: "Русский", detect: (l: string) => l.startsWith("ru") },
  { code: "uk", label: "Українська", detect: (l: string) => l.startsWith("uk") },
  { code: "ar", label: "العربية", dir: "rtl", detect: (l: string) => l.startsWith("ar") },
  { code: "hi", label: "हिन्दी", detect: (l: string) => l.startsWith("hi") },
  { code: "th", label: "ไทย", detect: (l: string) => l.startsWith("th") },
  { code: "ko", label: "한국어", detect: (l: string) => l.startsWith("ko") },
  { code: "ja", label: "日本語", detect: (l: string) => l.startsWith("ja") },
  { code: "zh-Hans", label: "简体中文", detect: (l: string) => l.startsWith("zh") && !isTraditionalChinese(l) },
  { code: "zh-Hant", label: "繁體中文", detect: (l: string) => l.startsWith("zh") && isTraditionalChinese(l) },
] as const satisfies readonly LocaleDef[];

export type LocaleCode = (typeof LOCALES)[number]["code"];

/** All shipped codes, in picker order. */
export const SUPPORTED: readonly LocaleCode[] = LOCALES.map((l) => l.code);

/** Locales that render right-to-left (drives the `dir` attribute). */
export const RTL_LOCALES: readonly LocaleCode[] = LOCALES.filter(
  (l) => "dir" in l && l.dir === "rtl",
).map((l) => l.code);

/** Writing direction for a locale — "rtl" for Arabic etc., "ltr" otherwise. */
export function dirForLocale(lng: string): "rtl" | "ltr" {
  return (RTL_LOCALES as readonly string[]).includes(lng) ? "rtl" : "ltr";
}

export function isLocaleCode(v: unknown): v is LocaleCode {
  return typeof v === "string" && (SUPPORTED as readonly string[]).includes(v);
}

/**
 * Resolve a browser/OS language tag to one of the shipped codes via each locale's
 * `detect` predicate. Predicates are mutually exclusive, so the first match wins;
 * nothing matching falls back to English. Chinese branches on script/region:
 * Traditional for Taiwan / Hong Kong / Macau (or an explicit `Hant` script),
 * Simplified otherwise. Spanish / French / German match on the primary subtag (any
 * region — `es-419`, `fr-CA`, `de-AT`, … all collapse).
 */
export function detectLocale(tag: string): LocaleCode {
  const lang = (tag || "en").toLowerCase();
  return LOCALES.find((l) => l.detect(lang))?.code ?? "en";
}
