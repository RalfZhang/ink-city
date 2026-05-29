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
