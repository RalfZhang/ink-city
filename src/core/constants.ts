// Opacity of the water fill/lines, composited over the background as a tint of
// the foreground "ink" color (see mixColor in core/render.ts). Kept here so the
// renderer and the Lab-tab water UI share one source of truth.
export const WATER_ALPHA = 0.3;

// Opacity of the airport centerlines (runways + taxiways), baked into an opaque
// color the same way as WATER_ALPHA (see mixColor). Both share one alpha and
// differ only in stroke width; the airport is pure linework, with no filled
// surfaces.
export const RUNWAY_ALPHA = 0.6;

// Opacity of the railway centerlines, baked into an opaque color like the
// others (see mixColor). Railways are drawn as a dashed line on top of the
// roads; a slightly-under-full tint keeps them clearly present without competing
// with the major roads.
export const RAILWAY_ALPHA = 0.7;

// Schema version stamped on the OSM payload
// (`{ v, elements, water, airports, railways, aerialways }`), whether precached to
// the `data` branch or fetched live via the sidecar (both go through
// fetch-city.ts). Absent ⇒ pre-water data (roads only).
//
// Bump on ANY change to what the payload carries — an additive new layer as much
// as a non-additive reshape. The additive case is the one that looks skippable and
// isn't: precache CI (scripts/osm-cli.ts) discards and re-fetches a cached payload
// whose `v` differs, so without a bump a newly added layer never backfills into
// already-cached cities. Clients only strictly need the bump for a reshape, since
// they ignore unknown keys and read a missing layer as "off".
//
// One number can cover more than one payload change, so don't infer a payload's
// layers from `v` — read its keys. Version 5 is such a case: it adds aerialways
// *and* drops `service=*` from railways (why: osm/railways.ts). Aerialways shipped
// while this constant still read 4 and so invalidated nothing; the railway change
// bumped it, and that one bump backfills both.
export const OSM_SCHEMA_VERSION = 5;

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
