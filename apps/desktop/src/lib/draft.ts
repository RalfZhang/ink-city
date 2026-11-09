import {
  MONDRIAN_COLORS,
  type ColorPair,
  type RailwayStyle,
  type Style,
  type StylePreset,
  type StyleVariant,
  type Theme,
  type ThemeMode,
} from "@inkcity/core";
import type { CityLabel, Status } from "../types";

/**
 * Everything the Style and Lab tabs set: one draft for both, previewed on the map
 * as it's edited and saved at once (`apply_map_settings`, the Rust `MapSettings`
 * field for field).
 */
export type MapDraft = {
  theme: ThemeMode;
  style: StylePreset;
  variant: StyleVariant;
  light: ColorPair;
  dark: ColorPair;
  cityLabel: CityLabel;
  showWater: boolean;
  showAirports: boolean;
  railwayStyle: RailwayStyle;
  showAerialways: boolean;
};

export function draftFrom(s: Status): MapDraft {
  return {
    theme: s.theme,
    style: s.style,
    variant: s.variant,
    light: s.light,
    dark: s.dark,
    cityLabel: s.cityLabel,
    showWater: s.showWater,
    showAirports: s.showAirports,
    railwayStyle: s.railwayStyle,
    showAerialways: s.showAerialways,
  };
}

const samePair = (a: ColorPair, b: ColorPair) =>
  a.background.toLowerCase() === b.background.toLowerCase() &&
  a.foreground.toLowerCase() === b.foreground.toLowerCase();

/**
 * How each field of a draft compares. Every field is listed — the type has tsc insist
 * on it — so one added to `MapDraft` won't build until it's said here how it's told
 * apart, rather than slipping past `sameDraft` as forever unchanged.
 */
const SAME_FIELD: { [K in keyof MapDraft]: (a: MapDraft[K], b: MapDraft[K]) => boolean } = {
  theme: Object.is,
  style: Object.is,
  variant: Object.is,
  light: samePair,
  dark: samePair,
  cityLabel: Object.is,
  showWater: Object.is,
  showAirports: Object.is,
  railwayStyle: Object.is,
  showAerialways: Object.is,
};

export function sameDraft(a: MapDraft, b: MapDraft): boolean {
  return (Object.keys(SAME_FIELD) as (keyof MapDraft)[]).every((k) =>
    (SAME_FIELD[k] as (x: unknown, y: unknown) => boolean)(a[k], b[k]),
  );
}

/** The theme a draft draws in: its own, or the OS's while it follows the system. */
export function themeOf(d: MapDraft, osDark: boolean): Theme {
  return d.theme === "system" ? (osDark ? "dark" : "light") : d.theme;
}

/** The paper and ink the map is drawn in: the draft's pair for the theme, or Mondrian's. */
export function pairOf(d: MapDraft, theme: Theme): ColorPair {
  return d.variant === "mondrian" ? MONDRIAN_COLORS[theme] : d[theme];
}

/** The renderer's `Style` for a draft — what the wallpaper would be drawn in. */
export function styleOf(d: MapDraft, theme: Theme): Style {
  return {
    ...d[theme],
    preset: d.style,
    showWater: d.showWater,
    showAirports: d.showAirports,
    railwayStyle: d.railwayStyle,
    showAerialways: d.showAerialways,
    variant: d.variant,
    theme,
  };
}
