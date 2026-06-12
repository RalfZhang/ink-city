// Re-export from the portable core so existing `../constants` imports keep
// working. The canonical definitions live in `@/core/constants`.
export {
  GITHUB_REPO,
  GITHUB_ISSUES,
  WIKIPEDIA_BASE,
  wikipediaUrl,
  OSM_COPYRIGHT_URL,
  ODBL_URL,
  GEONAMES_URL,
  CC_BY_URL,
} from "./core";

// How often the settings window polls the Rust `get_status` command. Drives
// live UI refresh and the cross-midnight city rollover detection in App.tsx.
// Desktop-specific (Tauri IPC), so it lives here rather than the portable core.
export const STATUS_POLL_MS = 2000;
