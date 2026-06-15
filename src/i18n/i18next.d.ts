// Type-safety for translation keys. Augments i18next so `t("...")`, `<Trans
// i18nKey="...">` and `i18n.t("...")` autocomplete and fail to compile on a
// typo'd or missing key.
//
// `en.json` is the source of truth for the key shape (it's also `fallbackLng`),
// so the resource type is derived from it. `zh-Hans.json` is kept in lockstep at
// build time by `scripts/check-i18n.ts` — that script, not the type system,
// guarantees every key here also has a translation in every other locale.
import "i18next";
import type en from "./en.json";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    resources: {
      translation: typeof en;
    };
  }
}
