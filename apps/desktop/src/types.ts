// Shared primitives live in the portable core; re-export them so existing
// `../types` imports keep working. `Status` is desktop-specific (it mirrors the
// Rust `get_status` command output), so it stays here.
export type {
  City,
  ColorPair,
  LabelCorner,
  MapProvider,
  RailwayStyle,
  StylePreset,
  StyleVariant,
  Theme,
  ThemeMode,
} from "@inkcity/core";

import type {
  City,
  ColorPair,
  LabelCorner,
  MapProvider,
  RailwayStyle,
  StylePreset,
  StyleVariant,
  Theme,
  ThemeMode,
} from "@inkcity/core";

export type UpdateCheck = "daily" | "weekly" | "monthly" | "never";

/** How the wallpaper is refreshed — the City-tab "How to update?" selector. */
export type UpdateMode = "disable" | "daily" | "customized";

/** Where the wallpaper carries the day's city caption (Style tab) — `config::CityLabel`. */
export type CityLabel = "off" | LabelCorner;

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
   * one (see `pipeline::city_for_status`). Nothing recomputes it here. Present even
   * while today's guess-the-country game is underway (the game needs the answer to
   * score guesses), so the City tab must not draw it until the day is revealed.
   */
  city: City | null;
  /**
   * Whether today's Daily wallpaper is on the desktop yet — the game's
   * `DayInputs.ready` (packages/core/src/guess/types.ts): it waits for the map it's about.
   */
  todayPainted: boolean;
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
  effectiveTheme: Theme;
  light: ColorPair;
  dark: ColorPair;
  style: StylePreset;
  updateCheck: UpdateCheck;
  /** Auto-install detected updates on the cadence above, then relaunch. */
  autoUpdate: boolean;
  /** Version we can update to, or null. Source of truth for the update prompt. */
  updateAvailable: string | null;
  /**
   * Percent complete of an in-flight update download. Null outside a download,
   * and also during one whose total size the serving host didn't report — the
   * About tab then falls back to a bare "Downloading…". Bundles are tens of MB
   * and a blocked route can take twenty minutes, so without this the spinner is
   * indistinguishable from a hang.
   */
  updateProgress: number | null;
  /**
   * Whether a download/install is in flight, from any path — the tray entry and
   * auto-update both start one with no window involved. The About tab draws its
   * progress from this rather than from its own click, so an install it didn't
   * start still reads as one.
   */
  updateInstalling: boolean;
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
  /** Where the wallpaper carries the city caption (Style tab). */
  cityLabel: CityLabel;
};
