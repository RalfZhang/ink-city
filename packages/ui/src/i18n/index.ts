// Strings for the shared components, as their own i18next namespace (`UI_NS`).
// A host registers `uiResources[code]` under that namespace for every locale it
// ships, next to its own resources — see src/i18n/index.ts in the desktop app.
// `pnpm check:i18n` holds these files to the same parity rule as the desktop's:
// every key of en.json in every locale, nothing extra.
//
// What the components can't word for every host stays with the host and comes in
// as a prop instead — e.g. GuessCountry's `paintingLine`, which on the desktop is
// about painting the wallpaper.
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

export { UI_NS } from "./ns";

/** The namespace's shape, for a host's i18next type augmentation. */
export type UiResources = typeof en;

export const uiResources = {
  ar,
  de,
  en,
  es,
  fr,
  hi,
  id,
  it,
  ja,
  ko,
  nl,
  pl,
  pt,
  ru,
  th,
  tr,
  uk,
  vi,
  "zh-Hans": zhHans,
  "zh-Hant": zhHant,
} as const;
