import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { detectLocale, dirForLocale, hostI18nOptions, isLocaleCode, type LocaleCode } from "@inkcity/ui/i18n";
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

export { LOCALES, dirForLocale, type LocaleCode } from "@inkcity/ui/i18n";

// The app's strings, per shipped locale. The locales themselves — codes, native
// names, direction, detection — are the table every host shares (@inkcity/ui/i18n),
// which the language picker (tabs/General.tsx) lists too, so adding a language is
// a line there plus a JSON here.
const TRANSLATIONS = {
  id, de, en, es, fr, it, nl, pl, pt, vi, tr, ru, uk, ar, hi, th, ko, ja,
  "zh-Hans": zhHans,
  "zh-Hant": zhHant,
} satisfies Record<LocaleCode, Record<string, unknown>>;

export const STORAGE_KEY = "inkcity:lang";

export type LocaleChoice = "auto" | LocaleCode;

/** The OS locale, resolved to a shipped code (see `detectLocale`). */
function detectFromNavigator(): LocaleCode {
  return detectLocale(navigator.language);
}

function initialLanguage(): LocaleCode {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (isLocaleCode(stored)) return stored;
  return detectFromNavigator();
}

// Two namespaces per locale: the app's own strings, and the shared components'
// (`@inkcity/ui`), which read theirs from `UI_NS`.
i18n.use(initReactI18next).init(hostI18nOptions(TRANSLATIONS, initialLanguage()));

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
