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
};

// --- OSM Overpass shapes (only the fields we read) ---

export type Geom = { lat: number; lon: number };
export type Way = { type: "way"; geometry?: Geom[]; tags?: { highway?: string } };

// --- Water layer ---
// Pre-assembled at precache time (the heavy stitching lives in src/core/water.ts
// and runs in CI, never on the client) so the renderer just fills polygons.

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

/**
 * The OSM container the renderer reads. `elements` (roads) is the original,
 * always-present shape. `water` and `v` are additive and backward-compatible:
 * old clients ignore unknown keys and render roads only, and new clients treat
 * a missing `water` (only possible for data cached before the water layer
 * shipped) as "no water".
 */
export type Osm = {
  elements?: Way[];
  /** Schema version. Absent ⇒ pre-water data (roads only). Water-aware data is `1`. */
  v?: number;
  /** Pre-assembled fill polygons. Absent ⇒ no water layer. */
  water?: WaterFeature[];
};
