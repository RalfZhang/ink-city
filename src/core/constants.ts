// Opacity of the water fill/lines, composited over the background as a tint of
// the foreground "ink" color (see mixColor in core/render.ts). Kept here so the
// renderer and any future water UI share one source of truth.
export const WATER_ALPHA = 0.3;

// Schema version stamped on the precached OSM payload (`{ v, elements, water }`).
// Bump this whenever the `water` shape changes in a non-additive way, so a client
// can recognize data newer than it understands and fall back instead of
// mis-rendering it. Absent ⇒ pre-water data (roads only). Single source of truth
// for both the producer (scripts/precache-osm.ts) and any future consumer.
export const OSM_SCHEMA_VERSION = 1;

export const GITHUB_REPO = "https://github.com/RalfZhang/ink-city";
export const GITHUB_ISSUES = `${GITHUB_REPO}/issues`;

export const WIKIPEDIA_BASE = "https://en.wikipedia.org/wiki/";

export function wikipediaUrl(cityName: string): string {
  return WIKIPEDIA_BASE + encodeURIComponent(cityName.replace(/ /g, "_"));
}

// Data-source attribution (legal obligation; also used by the website). Road
// geometry is OpenStreetMap under ODbL; the city list is GeoNames under CC BY 4.0.
export const OSM_COPYRIGHT_URL = "https://www.openstreetmap.org/copyright";
export const ODBL_URL = "https://opendatacommons.org/licenses/odbl/";
export const GEONAMES_URL = "https://www.geonames.org/";
export const CC_BY_URL = "https://creativecommons.org/licenses/by/4.0/";
