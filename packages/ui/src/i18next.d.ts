// Translation-key types for this package's own type-check (`tsc -p packages/ui`),
// so a typo'd key in a component fails there too. A host declares its own
// augmentation covering this namespace (the desktop's is src/i18n/i18next.d.ts),
// and this file must never be imported: two augmentations in one program clash.
// Nothing imports it, so only this package's tsconfig `include` picks it up.
import "i18next";
import type { UiResources } from "./i18n";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "ui";
    resources: {
      ui: UiResources;
    };
  }
}
