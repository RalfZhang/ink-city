import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { LOCALES, SUPPORTED, dirForLocale, type LocaleCode } from "./locales";

export { LOCALES, RTL_LOCALES, dirForLocale, type LocaleCode } from "./locales";

export const STORAGE_KEY = "inkcity:lang";

export type LocaleChoice = "auto" | LocaleCode;

function isLocaleCode(v: unknown): v is LocaleCode {
  return typeof v === "string" && (SUPPORTED as readonly string[]).includes(v);
}

/**
 * Resolve the OS locale to one of our supported codes via each locale's own
 * `detect` predicate (see locales.ts). Predicates are mutually exclusive, so
 * the first match wins; nothing matching falls back to English. Chinese branches
 * on script/region: Traditional for Taiwan / Hong Kong / Macau (or an explicit
 * `Hant` script), Simplified otherwise. Spanish / French / German match on the
 * primary subtag (any region — `es-419`, `fr-CA`, `de-AT`, … all collapse).
 */
function detectFromNavigator(): LocaleCode {
  const lang = (navigator.language || "en").toLowerCase();
  return LOCALES.find((l) => l.detect(lang))?.code ?? "en";
}

function initialLanguage(): LocaleCode {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (isLocaleCode(stored)) return stored;
  return detectFromNavigator();
}

i18n.use(initReactI18next).init({
  resources: Object.fromEntries(
    LOCALES.map((l) => [l.code, { translation: l.translation }]),
  ),
  lng: initialLanguage(),
  fallbackLng: "en",
  supportedLngs: SUPPORTED as string[],
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
