// Re-export from the portable core so existing `../constants` imports keep
// working. The canonical definitions live in `@/core/constants`.
export { GITHUB_REPO, GITHUB_ISSUES, WIKIPEDIA_BASE, wikipediaUrl } from "./core";
