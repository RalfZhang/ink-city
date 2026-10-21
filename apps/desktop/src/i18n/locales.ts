// The desktop's locales: the shipped-locale table every host shares
// (`@inkcity/ui/i18n/locales` — codes, native names, direction, detection), each
// paired with the app's own strings. Everything downstream — the i18next resource
// map and detection (index.ts) and the language picker (tabs/General.tsx) —
// derives from it, so adding a language is a line in the shared table plus a JSON
// here.
//
// This module is intentionally free of i18next and DOM access, like the table it
// builds on.
import { LOCALES as SHIPPED, type LocaleCode } from "@inkcity/ui/i18n/locales";
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

export {
  RTL_LOCALES,
  SUPPORTED,
  detectLocale,
  dirForLocale,
  isLocaleCode,
  type LocaleCode,
} from "@inkcity/ui/i18n/locales";

type Translation = Record<string, unknown>;

const TRANSLATIONS = {
  id, de, en, es, fr, it, nl, pl, pt, vi, tr, ru, uk, ar, hi, th, ko, ja,
  "zh-Hans": zhHans,
  "zh-Hant": zhHant,
} satisfies Record<LocaleCode, Translation>;

/** Every shipped locale, in picker order, with the desktop's strings for it. */
export const LOCALES = SHIPPED.map((l) => ({ ...l, translation: TRANSLATIONS[l.code] }));
