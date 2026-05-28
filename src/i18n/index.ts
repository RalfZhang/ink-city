import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./en.json";
import zhHans from "./zh-Hans.json";

export const STORAGE_KEY = "inkcity:lang";

export type LocaleCode = "en" | "zh-Hans";
export type LocaleChoice = "auto" | LocaleCode;

const SUPPORTED: LocaleCode[] = ["en", "zh-Hans"];

function isLocaleCode(v: unknown): v is LocaleCode {
  return typeof v === "string" && (SUPPORTED as string[]).includes(v);
}

/**
 * Resolve the OS locale to one of our supported codes.
 * All `zh-*` variants currently collapse to `zh-Hans`; when `zh-Hant` is added
 * we'll branch here.
 */
function detectFromNavigator(): LocaleCode {
  const lang = (navigator.language || "en").toLowerCase();
  if (lang.startsWith("zh")) return "zh-Hans";
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
  },
  lng: initialLanguage(),
  fallbackLng: "en",
  supportedLngs: SUPPORTED,
  interpolation: { escapeValue: false },
});

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
