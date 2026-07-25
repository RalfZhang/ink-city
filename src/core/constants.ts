// Opacity of the water fill/lines, composited over the background as a tint of
// the foreground "ink" color (see mixColor in core/render.ts). Kept here so the
// renderer and the Lab-tab water UI share one source of truth.
export const WATER_ALPHA = 0.3;

// Opacity of the airport centerlines (runways + taxiways), baked into an opaque
// color the same way as WATER_ALPHA (see mixColor). Both share one alpha and
// differ only in stroke width; the airport is pure linework, with no filled
// surfaces.
export const RUNWAY_ALPHA = 0.6;

// Schema version stamped on the OSM payload (`{ v, elements, water, airports }`),
// whether precached to the `data` branch or fetched live via the sidecar (both
// go through fetch-city.ts). Two consumers rely on it, so bump it on ANY change
// to what the payload carries — a non-additive reshape of an existing layer AND
// an additive new layer alike:
//   • client (forward-compat): a bump lets a client recognize data newer than
//     it understands. Purely additive layers stay backward-compatible anyway —
//     old clients ignore unknown keys and a missing layer reads as "off" — so
//     this side only strictly needs a bump on a non-additive reshape.
//   • precache CI (cache invalidation, scripts/osm-cli.ts): a cached
//     `<id>.json` whose `v` differs from this constant is discarded and
//     re-fetched. This is why even an additive layer bumps `v`: without it, a
//     newly added layer would never backfill into already-cached cities.
// Absent ⇒ pre-water data (roads only). Single source of truth for the producer
// (scripts/osm-cli.ts) and every consumer.
// History: 1 = roads + water; 2 = adds the airports layer (runway + apron);
// 3 = airports layer reshaped to runway + taxiway centerlines (apron dropped).
export const OSM_SCHEMA_VERSION = 3;

export const GITHUB_REPO = "https://github.com/RalfZhang/ink-city";
export const GITHUB_ISSUES = `${GITHUB_REPO}/issues`;

export const WIKIPEDIA_BASE = "https://en.wikipedia.org/wiki/";

export function wikipediaUrl(cityName: string): string {
  return WIKIPEDIA_BASE + encodeURIComponent(cityName.replace(/ /g, "_"));
}

export const GOOGLE_MAPS_BASE = "https://www.google.com/maps/@";
const GOOGLE_MAPS_ZOOM = "13";

export function googleMapsUrl(lat: number, lon: number): string {
  return `${GOOGLE_MAPS_BASE}${lat},${lon},${GOOGLE_MAPS_ZOOM}z`;
}

// Data-source attribution (legal obligation; also used by the website). Road
// geometry is OpenStreetMap under ODbL; the city list is GeoNames under CC BY 4.0.
export const OSM_COPYRIGHT_URL = "https://www.openstreetmap.org/copyright";
export const ODBL_URL = "https://opendatacommons.org/licenses/odbl/";
export const GEONAMES_URL = "https://www.geonames.org/";
export const CC_BY_URL = "https://creativecommons.org/licenses/by/4.0/";
