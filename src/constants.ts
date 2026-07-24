// Re-export from the portable core so existing `../constants` imports keep
// working. The canonical definitions live in `@/core/constants`.
export {
  GITHUB_REPO,
  GITHUB_ISSUES,
  WIKIPEDIA_BASE,
  wikipediaUrl,
  GOOGLE_MAPS_BASE,
  googleMapsUrl,
  OSM_COPYRIGHT_URL,
  ODBL_URL,
  GEONAMES_URL,
  CC_BY_URL,
} from "./core";
