// Type-safety for translation keys, as in the desktop app (its i18next.d.ts): `en.json`
// is the source of truth for the shape of the site's own strings, and `ui` is the
// shared components' namespace. `scripts/check-i18n.ts` — not the type system —
// guarantees every other locale carries the same keys.
import "i18next";
import type en from "./en.json";
import type { UiResources } from "@inkcity/ui/i18n";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    resources: {
      translation: typeof en;
      ui: UiResources;
    };
  }
}
