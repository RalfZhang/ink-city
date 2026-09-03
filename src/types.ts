// Shared primitives live in the portable core; re-export them so existing
// `../types` imports keep working. `Status` is desktop-specific (it mirrors the
// Rust `get_status` command output), so it stays here.
export type {
  City,
  ColorPair,
  MapProvider,
  RailwayStyle,
  StylePreset,
  StyleVariant,
  ThemeMode,
} from "./core";

import type {
  City,
  ColorPair,
  MapProvider,
  RailwayStyle,
  StylePreset,
  StyleVariant,
  ThemeMode,
} from "./core";

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
  /**
   * The city today's Daily wallpaper depicts — null until the backend has resolved
   * one (see `pipeline::city_for_status`). Nothing recomputes it here.
   */
  city: City | null;
  /**
   * Why today's Daily render failed, or null if it succeeded / hasn't run yet.
   * Only meaningful next to `city`: both null means "still resolving", while
   * `city: null` + a message means the day can't be resolved at all. See the Rust
   * `Status::last_error` — it's scoped to the Daily flow and to today, so it can't
   * be a Customized pin's failure or yesterday's.
   */
  lastError: string | null;
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
  /**
   * Whether the in-app updater can apply an update to this install. False only
   * for a Linux .deb/.rpm, where updates come from the system package manager —
   * see the Rust `updates::supported`. The About tab hides its update section
   * entirely when false, rather than offering a check that always fails.
   */
  updaterSupported: boolean;
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
  mapProvider: MapProvider;
};
