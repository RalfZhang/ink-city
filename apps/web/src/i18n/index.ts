import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import {
  LOCALES,
  SUPPORTED,
  UI_NS,
  detectLocale,
  dirForLocale,
  isLocaleCode,
  uiResources,
  type LocaleCode,
} from "@inkcity/ui/i18n";
import ar from "./ar.json";
import de from "./de.json";
import en from "./en.json";
import es from "./es.json";
import fr from "./fr.json";
import hi from "./hi.json";
import id from "./id.json";
import it from "./it.json";
import ja from "./ja.json";
import ko from "./ko.json";
import nl from "./nl.json";
import pl from "./pl.json";
import pt from "./pt.json";
import ru from "./ru.json";
import th from "./th.json";
import tr from "./tr.json";
import uk from "./uk.json";
import vi from "./vi.json";
import zhHans from "./zh-Hans.json";
import zhHant from "./zh-Hant.json";

export { LOCALES, dirForLocale, type LocaleCode } from "@inkcity/ui/i18n";

// The site's strings, per shipped locale (the shared table, @inkcity/ui/i18n), next
// to the shared components' `ui` namespace — the desktop's i18n, minus everything
// tied to its window.
const TRANSLATIONS = {
  ar, de, en, es, fr, hi, id, it, ja, ko, nl, pl, pt, ru, th, tr, uk, vi,
  "zh-Hans": zhHans,
  "zh-Hant": zhHant,
} satisfies Record<LocaleCode, typeof en>;

const STORAGE_KEY = "inkcity:lang";

/**
 * `?lang=` first — a link can carry its language — then the visitor's own pick from
 * an earlier visit, then the browser's language. Storage can be unreadable (blocked
 * site data), which reads as no pick.
 */
function initialLanguage(): LocaleCode {
  const fromUrl = new URLSearchParams(location.search).get("lang");
  if (isLocaleCode(fromUrl)) return fromUrl;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isLocaleCode(stored)) return stored;
  } catch {
    // no stored pick
  }
  return detectLocale(navigator.language);
}

i18n.use(initReactI18next).init({
  resources: Object.fromEntries(
    LOCALES.map((l) => [l.code, { translation: TRANSLATIONS[l.code], [UI_NS]: uiResources[l.code] }]),
  ),
  lng: initialLanguage(),
  fallbackLng: "en",
  supportedLngs: SUPPORTED as string[],
  interpolation: { escapeValue: false },
});

/**
 * Put the language on the document: `lang` and `dir` on <html> (the layout mirrors
 * under RTL through logical properties; Radix reads direction from the provider in
 * App.tsx), and the title and description in that language.
 */
function applyToDocument(lng: string): void {
  const root = document.documentElement;
  root.lang = lng;
  root.dir = dirForLocale(lng);
  document.title = i18n.t("meta.title");
  document.querySelector('meta[name="description"]')?.setAttribute("content", i18n.t("meta.description"));
}
applyToDocument(i18n.language);
i18n.on("languageChanged", applyToDocument);

/** Switch language and remember the pick for the next visit. */
export function setLanguage(code: LocaleCode): void {
  try {
    localStorage.setItem(STORAGE_KEY, code);
  } catch {
    // remembered for this visit only
  }
  void i18n.changeLanguage(code);
}

export default i18n;
