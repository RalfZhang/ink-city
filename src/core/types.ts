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
  /** Whether to draw the airport layer. Absent ⇒ off (matches the config default). */
  showAirports?: boolean;
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

// --- Airport layer ---
// Standalone ways only (no multipolygon relations — real-world aprons/runways
// are overwhelmingly simple ways; see core/airports.ts). Unlike water's
// `ocean` kind, these never span the whole bbox, so no edge-of-bbox clipping
// is needed: a runway/apron that only partially falls inside the requested
// area is passed through as-is and simply clips at the canvas edge when drawn.

/** `apron` = paved area (filled polygon); `runway` = centerline (stroked). */
export type AirportFeature =
  | { kind: "apron"; polygon: WaterPolygon }
  | { kind: "runway"; line: Geom[] };

/**
 * The OSM container the renderer reads. `elements` (roads) is the original,
 * always-present shape. `water`, `airports`, and `v` are additive and
 * backward-compatible: old clients ignore unknown keys and render roads only,
 * and new clients treat a missing `water`/`airports` (only possible for data
 * cached before that layer shipped) as "none of that layer".
 */
export type Osm = {
  elements?: Way[];
  /** Schema version. Absent ⇒ pre-water data (roads only). Water-aware data is `1`. */
  v?: number;
  /** Pre-assembled fill polygons. Absent ⇒ no water layer. */
  water?: WaterFeature[];
  /** Pre-assembled runway/apron shapes. Absent ⇒ no airport layer. */
  airports?: AirportFeature[];
};
