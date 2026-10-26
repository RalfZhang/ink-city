import type { ColorPair, Style, Theme } from "./types";
import defaults from "./defaults.json";

// The defaults the TypeScript side shares with the desktop's Rust, kept once in
// ./defaults.json: Rust compiles that file in (apps/desktop/src-tauri/src/defaults.rs)
// and everything here imports it, so neither language restates a value.
//
// A JSON import's types are widened (`preset: string`), so DEFAULT_STYLE is cast
// to its real type — after a `satisfies` that has tsc insist on every key `Style`
// has, so a new layer toggle can't go without a default. What each key holds is
// vetted on the Rust side, which parses the file into its own enums, rejects keys
// it doesn't know and pins every value in `cargo test`: a bad edit fails CI for
// both languages.

/** Each theme's paper (`background`) and ink (`foreground`) on a fresh install. */
export const DEFAULT_COLORS: Readonly<Record<Theme, Readonly<ColorPair>>> = defaults.colors;

/** Everything in a {@link Style} but its colors and the theme they're for, every key present. */
type StyleDefaults = Readonly<Required<Omit<Style, "background" | "foreground" | "theme">>>;

/**
 * The map a fresh install draws: the `standard` weights, every optional layer
 * off, the `ink` variant. Spread a theme's {@link DEFAULT_COLORS} over it for a
 * whole `Style`.
 */
export const DEFAULT_STYLE = (defaults.style satisfies Record<keyof StyleDefaults, unknown>) as StyleDefaults;

/**
 * Half the long side of every map, in km — `bboxForScreen`'s `maxHalfKm`, so a
 * screen's longer side spans 20 km of ground and its shorter side less, by the
 * aspect ratio.
 *
 * Also a contract with data already published. CI precaches each day as the
 * square `bboxForScreen(lat, lon, MAX_HALF_KM, 1)` (scripts/osm-cli.ts), which has
 * to contain every screen-aspect crop a client takes of it, and every shipped
 * client has its own value compiled in. Raise it and new clients draw bare
 * margins on the days published before the change, until they're re-fetched —
 * which only an OSM_SCHEMA_VERSION bump makes CI do. Lower it and every older
 * client draws them, for good.
 */
export const MAX_HALF_KM: number = defaults.maxHalfKm;
