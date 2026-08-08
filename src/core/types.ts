// Portable type definitions shared across the desktop client, the CI
// pre-cache script, and the (separate-repo) marketing website. Keep this layer
// free of Tauri / React / DOM-specific imports so it stays reusable.

export type City = {
  id: number;
  name: string;
  localName: string;
  country: string;
  lat: number;
  lon: number;
  population: number;
};

export type Bbox = { south: number; west: number; north: number; east: number };

export type ThemeMode = "light" | "dark" | "system";
export type StylePreset = "minimal" | "standard" | "bold";

/**
 * Which visual language the map is drawn in — one dimension, not a set of
 * independent flags, so exactly one variant is ever in effect:
 *   • `ink`      — the default ink-on-paper map, drawn in the theme's colors.
 *   • `mondrian` — a De Stijl repaint of the same real street grid (issue #18,
 *                  see core/mondrian.ts).
 */
export type StyleVariant = "ink" | "mondrian";

export type ColorPair = {
  background: string;
  foreground: string;
};

/** Visual style used when drawing roads to a canvas. */
export type Style = {
  background: string;
  foreground: string;
  preset: StylePreset;
  /** Whether to draw the water layer. Absent ⇒ off (matches the config default). */
  showWater?: boolean;
  /** Whether to draw the airport layer. Absent ⇒ off (matches the config default). */
  showAirports?: boolean;
  /** Whether to draw the railway layer. Absent ⇒ off (matches the config default). */
  showRailways?: boolean;
  /** Whether to draw the aerialway (cable car / ropeway) layer. Absent ⇒ off. */
  showAerialways?: boolean;
  /**
   * Which visual language to draw in (see {@link StyleVariant}). Absent ⇒
   * `"ink"`. `"mondrian"` overrides the theme colors — `background`/`foreground`
   * are replaced by the Mondrian paper/ink pair — but the layer toggles above
   * still apply, tinted from that ink. Issue #18.
   */
  variant?: StyleVariant;
};

// --- OSM Overpass shapes (only the fields we read) ---

export type Geom = { lat: number; lon: number };
export type Way = { type: "way"; geometry?: Geom[]; tags?: { highway?: string } };

// --- Water layer ---
// Pre-assembled at precache time (the heavy stitching lives in
// src/core/osm/water.ts and runs in CI, never on the client) so the renderer
// just fills polygons.

/** A polygon ready to fill: one outer ring + zero or more holes (islands). */
export type WaterPolygon = { outer: Geom[]; holes?: Geom[][] };

/** Classes of linear waterway we render as strokes (centerlines, no area). */
export type WaterLineClass = "river" | "canal" | "stream" | "drain" | "ditch";

/**
 * A slimmed water feature. `area` = a real polygon water body (lake, reservoir,
 * wide river); `ocean` = sea derived from coastline; `line` = a linear waterway
 * centerline (e.g. a creek/canal) stroked thinly. Filled kinds carry `polygon`,
 * the line kind carries `line` + its `cls` (mapped to a stroke width at render).
 */
export type WaterFeature =
  | { kind: "area" | "ocean"; polygon: WaterPolygon }
  | { kind: "line"; cls: WaterLineClass; line: Geom[] };

// --- The airport / railway / aerialway layers ---
// Railways and aerialways are bare centerlines; airports carry both centerlines
// and closed areas (below). Unlike water's `ocean` kind, none of them can span the
// whole bbox, so no edge-of-bbox clipping is needed: a feature only partly inside
// the requested area is passed through as-is and clips at the canvas edge when
// drawn. Which OSM tags each layer collects (and what it deliberately leaves out)
// lives in core/osm/{airports,railways,aerialways}.ts; how each is drawn lives in
// core/render.ts.

/** Runway or taxiway — selects the stroke width (lines) and draw order at render time. */
export type AirportKind = "runway" | "taxiway";

/**
 * An airport feature in one of the two shapes OSM maps them in, split the way
 * openstreetmap-carto splits them:
 *   • `line` — a centerline way, stroked at a fixed weight that reads as the
 *              runway/taxiway at any canvas size.
 *   • `area` — a closed way mapped as the paved surface itself, filled at its
 *              true footprint (no width fudging, matching carto).
 * Which one a way becomes is decided at slim time — see core/osm/airports.ts.
 * The union is additive: payloads cached before areas shipped carry only `line`
 * features and still parse.
 */
export type AirportFeature =
  | { kind: AirportKind; line: Geom[] }
  | { kind: AirportKind; area: Geom[] };

/** Surface rail centerlines. The `railway` subtype isn't kept — all render alike. */
export type RailwayFeature = { line: Geom[] };

/** Cable car / ropeway centerlines. The lift kind isn't kept — all render alike. */
export type AerialwayFeature = { line: Geom[] };

/**
 * The OSM container the renderer reads. `elements` (roads) is the original,
 * always-present shape. Every other key — `v` and each optional layer below — is
 * additive and backward-compatible: old clients ignore unknown keys and render
 * roads only, and new clients treat a missing layer (only possible for data
 * cached before that layer shipped) as "none of that layer".
 */
export type Osm = {
  elements?: Way[];
  /**
   * Schema version. Absent ⇒ the oldest payloads (roads only); otherwise see
   * OSM_SCHEMA_VERSION in core/constants.ts, which owns the history and the
   * rule for bumping it. Don't infer which layers a payload carries from `v` —
   * read the keys below. `v` is for cache invalidation and forward-compat, and
   * one version has covered more than one change to the payload.
   */
  v?: number;
  /** Pre-assembled fill polygons. Absent ⇒ no water layer. */
  water?: WaterFeature[];
  /** Pre-assembled runway/taxiway centerlines + areas. Absent ⇒ no airport layer. */
  airports?: AirportFeature[];
  /** Pre-assembled railway centerlines. Absent ⇒ no railway layer. */
  railways?: RailwayFeature[];
  /** Pre-assembled cable car / ropeway centerlines. Absent ⇒ no aerialway layer. */
  aerialways?: AerialwayFeature[];
};
