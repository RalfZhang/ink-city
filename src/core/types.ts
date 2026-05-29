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
};

// --- OSM Overpass shapes (only the fields we read) ---

export type Geom = { lat: number; lon: number };
export type Way = { type: "way"; geometry?: Geom[]; tags?: { highway?: string } };
export type Osm = { elements?: Way[] };
