// Single source of truth for the locales InkCity ships. Everything downstream —
// the i18next resource map and detection (index.ts), the language picker
// (tabs/General.tsx), and the parity guard (scripts/check-i18n.ts) — derives
// from this table, so adding a language is a one-line edit here (plus its JSON).
//
// This module is intentionally free of i18next and DOM access so the Node-side
// parity check can import it without pulling in the browser runtime.
import en from "./en.json";
import zhHans from "./zh-Hans.json";
import zhHant from "./zh-Hant.json";
import es from "./es.json";
import fr from "./fr.json";
import de from "./de.json";
import ar from "./ar.json";
import ja from "./ja.json";
import ko from "./ko.json";
import pt from "./pt.json";
import hi from "./hi.json";
import id from "./id.json";
import vi from "./vi.json";
import th from "./th.json";
import it from "./it.json";
import tr from "./tr.json";
import ru from "./ru.json";
import nl from "./nl.json";
import pl from "./pl.json";
import uk from "./uk.json";

type Translation = Record<string, unknown>;

export interface LocaleDef {
  /** BCP-47-ish code; used as the i18next language key and the stored value. */
  code: string;
  /** Native name shown in the language picker. */
  label: string;
  /** The translation bundle. */
  translation: Translation;
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
// fallback is hard-coded in index.ts), so reordering only reshuffles the menu.
export const LOCALES = [
  { code: "id", label: "Bahasa Indonesia", translation: id, detect: (l: string) => l.startsWith("id") },
  { code: "de", label: "Deutsch", translation: de, detect: (l: string) => l.startsWith("de") },
  { code: "en", label: "English", translation: en, detect: (l: string) => l.startsWith("en") },
  { code: "es", label: "Español", translation: es, detect: (l: string) => l.startsWith("es") },
  { code: "fr", label: "Français", translation: fr, detect: (l: string) => l.startsWith("fr") },
  { code: "it", label: "Italiano", translation: it, detect: (l: string) => l.startsWith("it") },
  { code: "nl", label: "Nederlands", translation: nl, detect: (l: string) => l.startsWith("nl") },
  { code: "pl", label: "Polski", translation: pl, detect: (l: string) => l.startsWith("pl") },
  { code: "pt", label: "Português", translation: pt, detect: (l: string) => l.startsWith("pt") },
  { code: "vi", label: "Tiếng Việt", translation: vi, detect: (l: string) => l.startsWith("vi") },
  { code: "tr", label: "Türkçe", translation: tr, detect: (l: string) => l.startsWith("tr") },
  { code: "ru", label: "Русский", translation: ru, detect: (l: string) => l.startsWith("ru") },
  { code: "uk", label: "Українська", translation: uk, detect: (l: string) => l.startsWith("uk") },
  { code: "ar", label: "العربية", translation: ar, dir: "rtl", detect: (l: string) => l.startsWith("ar") },
  { code: "hi", label: "हिन्दी", translation: hi, detect: (l: string) => l.startsWith("hi") },
  { code: "th", label: "ไทย", translation: th, detect: (l: string) => l.startsWith("th") },
  { code: "ko", label: "한국어", translation: ko, detect: (l: string) => l.startsWith("ko") },
  { code: "ja", label: "日本語", translation: ja, detect: (l: string) => l.startsWith("ja") },
  { code: "zh-Hans", label: "简体中文", translation: zhHans, detect: (l: string) => l.startsWith("zh") && !isTraditionalChinese(l) },
  { code: "zh-Hant", label: "繁體中文", translation: zhHant, detect: (l: string) => l.startsWith("zh") && isTraditionalChinese(l) },
] as const satisfies readonly LocaleDef[];

export type LocaleCode = (typeof LOCALES)[number]["code"];

/** All shipped codes, in picker order. The fallback ("en") is hard-coded in index.ts. */
export const SUPPORTED: readonly LocaleCode[] = LOCALES.map((l) => l.code);

/** Locales that render right-to-left (drives the `dir` attribute — see applyDir). */
export const RTL_LOCALES: readonly LocaleCode[] = LOCALES.filter(
  (l) => "dir" in l && l.dir === "rtl",
).map((l) => l.code);

/** Writing direction for a locale — "rtl" for Arabic etc., "ltr" otherwise. */
export function dirForLocale(lng: string): "rtl" | "ltr" {
  return (RTL_LOCALES as readonly string[]).includes(lng) ? "rtl" : "ltr";
}
