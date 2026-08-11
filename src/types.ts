// Shared primitives live in the portable core; re-export them so existing
// `../types` imports keep working. `Status` is desktop-specific (it mirrors the
// Rust `get_status` command output), so it stays here.
export type { City, ColorPair, RailwayStyle, StylePreset, StyleVariant, ThemeMode } from "./core";

import type { City, ColorPair, RailwayStyle, StylePreset, StyleVariant, ThemeMode } from "./core";

export type UpdateCheck = "daily" | "weekly" | "monthly" | "never";

/** How the wallpaper is refreshed — the City-tab "How to update?" selector. */
export type UpdateMode = "disable" | "daily" | "customized";

/** Mirrors the Rust `commands::Status` — see there for the field-by-field contract. */
export type Status = {
  /** How the wallpaper is refreshed (City tab). */
  updateMode: UpdateMode;
  /** The Customized-mode pin, or null until the user applies one. */
  custom: { lat: number; lon: number } | null;
  hideTray: boolean;
  running: boolean;
  city: City;
  date: string;
  theme: ThemeMode;
  effectiveTheme: "light" | "dark";
  light: ColorPair;
  dark: ColorPair;
  style: StylePreset;
  updateCheck: UpdateCheck;
  /** Auto-install detected updates on the cadence above, then relaunch. */
  autoUpdate: boolean;
  /** Version we can update to, or null. Source of truth for the update prompt. */
  updateAvailable: string | null;
  showWater: boolean;
  showAirports: boolean;
  /** Which symbol the railway layer is drawn in, or `"off"`. */
  railwayStyle: RailwayStyle;
  showAerialways: boolean;
  /** Which visual language the map is drawn in (issue #18). */
  variant: StyleVariant;
  /** Whether the hidden Dev Mode tab is unlocked. Persisted across restarts. */
  devMode: boolean;
  /** Dev-only: bypass the local cache and CDN, fetch OSM live from Overpass. In-memory only (off on launch). */
  bypassCache: boolean;
  proxyEnabled: boolean;
  proxyUrl: string;
};
