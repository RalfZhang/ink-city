// Shared primitives live in the portable core; re-export them so existing
// `../types` imports keep working. `Status` is desktop-specific (it mirrors the
// Rust `get_status` command output), so it stays here.
export type { City, ColorPair, StylePreset, ThemeMode } from "./core";

import type { City, ColorPair, StylePreset, ThemeMode } from "./core";

export type UpdateCheck = "daily" | "weekly" | "monthly" | "never";

export type Status = {
  enabled: boolean;
  hide_tray: boolean;
  running: boolean;
  city: City;
  date: string;
  theme: ThemeMode;
  effectiveTheme: "light" | "dark";
  light: ColorPair;
  dark: ColorPair;
  style: StylePreset;
  updateCheck: UpdateCheck;
  showWater: boolean;
  /** Whether the current city's data has a water layer (gates the water toggle). */
  hasWater: boolean;
};
