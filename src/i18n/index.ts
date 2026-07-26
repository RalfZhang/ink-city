import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./en.json";
import zhHans from "./zh-Hans.json";
import zhHant from "./zh-Hant.json";
import es from "./es.json";
import fr from "./fr.json";
import de from "./de.json";
import ar from "./ar.json";

export const STORAGE_KEY = "inkcity:lang";

export type LocaleCode = "en" | "zh-Hans" | "zh-Hant" | "es" | "fr" | "de" | "ar";
export type LocaleChoice = "auto" | LocaleCode;

const SUPPORTED: LocaleCode[] = ["en", "zh-Hans", "zh-Hant", "es", "fr", "de", "ar"];

/** Locales that render right-to-left (drives the `dir` attribute — see applyDir). */
export const RTL_LOCALES: readonly LocaleCode[] = ["ar"];

/** Writing direction for a locale — "rtl" for Arabic etc., "ltr" otherwise. */
export function dirForLocale(lng: string): "rtl" | "ltr" {
  return (RTL_LOCALES as readonly string[]).includes(lng) ? "rtl" : "ltr";
}

function isLocaleCode(v: unknown): v is LocaleCode {
  return typeof v === "string" && (SUPPORTED as string[]).includes(v);
}

/**
 * Resolve the OS locale to one of our supported codes. Chinese branches on
 * script/region: Traditional for Taiwan / Hong Kong / Macau (or an explicit
 * `Hant` script), Simplified otherwise. Spanish / French / German match on the
 * primary subtag (any region — `es-419`, `fr-CA`, `de-AT`, … all collapse).
 */
function detectFromNavigator(): LocaleCode {
  const lang = (navigator.language || "en").toLowerCase();
  if (lang.startsWith("zh")) {
    if (lang.includes("hant") || lang.includes("tw") || lang.includes("hk") || lang.includes("mo")) {
      return "zh-Hant";
    }
    return "zh-Hans";
  }
  if (lang.startsWith("es")) return "es";
  if (lang.startsWith("fr")) return "fr";
  if (lang.startsWith("de")) return "de";
  if (lang.startsWith("ar")) return "ar";
  return "en";
}

function initialLanguage(): LocaleCode {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (isLocaleCode(stored)) return stored;
  return detectFromNavigator();
}

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    "zh-Hans": { translation: zhHans },
    "zh-Hant": { translation: zhHant },
    es: { translation: es },
    fr: { translation: fr },
    de: { translation: de },
    ar: { translation: ar },
  },
  lng: initialLanguage(),
  fallbackLng: "en",
  supportedLngs: SUPPORTED,
  interpolation: { escapeValue: false },
});

/**
 * Reflect the active language's writing direction (and code) on the <html>
 * element, so the whole UI mirrors for RTL locales like Arabic. Physical CSS is
 * converted to logical properties across the app (border-s, ps-/pe-, end-…),
 * which resolve against this `dir`. Radix primitives read direction from a
 * `Direction.Provider` (not the DOM), so the app also wraps its tree in one fed
 * by `dirForLocale` — see App.tsx; without it Radix forces `dir="ltr"` on its
 * roots and cancels the mirroring. Called on init and on every language change.
 * Guarded for non-DOM contexts (tests / SSR).
 */
function applyDir(lng: string): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.lang = lng;
  root.dir = dirForLocale(lng);
}
applyDir(i18n.language);
i18n.on("languageChanged", applyDir);

/** Returns the user's stored preference, or "auto" if they haven't pinned one. */
export function getLocaleChoice(): LocaleChoice {
  const v = localStorage.getItem(STORAGE_KEY);
  return isLocaleCode(v) ? v : "auto";
}

/** Switch language. `auto` clears the override and uses the detected language. */
export function setLocaleChoice(choice: LocaleChoice) {
  if (choice === "auto") {
    localStorage.removeItem(STORAGE_KEY);
    i18n.changeLanguage(detectFromNavigator());
  } else {
    localStorage.setItem(STORAGE_KEY, choice);
    i18n.changeLanguage(choice);
  }
}

export default i18n;
