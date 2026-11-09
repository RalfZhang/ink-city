// What only the desktop has: `Status` (it mirrors the Rust `get_status` command
// output) and the settings' own unions. Shared primitives are imported from the
// portable core, `@inkcity/core`, where they live.
import type {
  City,
  ColorPair,
  LabelCorner,
  MapProvider,
  RailwayStyle,
  StylePreset,
  StyleVariant,
  ThemeMode,
} from "@inkcity/core";

export type UpdateCheck = "daily" | "weekly" | "monthly" | "never";

/** Which map the app shows — General's "How to update?" selector. */
export type UpdateMode = "daily" | "customized";

/** Where requests go — General's Proxy selector (`config::ProxyMode`). */
export type ProxyMode = "off" | "system" | "custom";

/** Where the wallpaper carries the day's city caption (Style tab) — `config::CityLabel`. */
export type CityLabel = "off" | LabelCorner;

/** Mirrors the Rust `commands::Status` — see there for the field-by-field contract. */
export type Status = {
  /** Which map the app shows (General). */
  updateMode: UpdateMode;
  /** Whether that map is put on the desktop too — the home's "Sync to wallpaper". */
  syncWallpaper: boolean;
  /** The Customized-mode pin, or null until the user applies one. */
  custom: { lat: number; lon: number } | null;
  hideTray: boolean;
  running: boolean;
  /**
   * Today's Daily city — null until the backend has resolved one (see
   * `pipeline::city_for_status`). Nothing recomputes it here. Present even while
   * today's guess-the-country game is underway (the game needs the answer to score
   * guesses), so the home must not show it until the day is revealed.
   */
  city: City | null;
  /** Which map the window draws (`daily:<date>` / `custom:<coords>`), or null with no pin. */
  mapKey: string | null;
  /** Whether `mapKey`'s data is cached, ready for `get_map_data`. */
  mapReady: boolean;
  /** Which writing of that cache file this is (its modification time, ms; 0 when not ready): the window reads it again when this moves. */
  mapRev: number;
  /**
   * Why `mapKey`'s data couldn't be had, or null. Not ready with no error is "still
   * on its way"; not ready with one is "can't be had" — see the Rust `Status::map_error`.
   */
  mapError: string | null;
  /** Why the map didn't make it onto the desktop while syncing, or null. */
  wallError: string | null;
  date: string;
  theme: ThemeMode;
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
  proxyMode: ProxyMode;
  proxyUrl: string;
  mapProvider: MapProvider;
  /** Where the wallpaper carries the city caption (Style tab). */
  cityLabel: CityLabel;
  /** Whether there's a tray icon to quit from; false only on a Linux desktop without one. */
  trayAvailable: boolean;
  /** When updates were last checked for, Unix seconds, or null before the first. */
  lastUpdateCheck: number | null;
};

/** `pipeline:end`'s payload — mirrors the Rust `pipeline::RunEnd`. */
export type RunEnd = {
  /** Every request whose ticket is at or below this was served — the last pass's; null from Dev Mode's preview, which serves none. */
  served: number | null;
  /** Each pass in turn: a ticket was served by the first whose `served` reaches it. */
  passes: PassEnd[];
};

/** How one pass of a run went, for the requests it served — mirrors the Rust `pipeline::PassEnd`. */
export type PassEnd = {
  /** The last ticket the pass served: those above the pass before's, up to this. */
  served: number;
  /** Why it failed, or null. */
  failure: string | null;
  /** Whether it put a map on the desktop: never with syncing off. */
  painted: boolean;
};
