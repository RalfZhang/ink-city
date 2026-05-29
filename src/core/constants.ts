export const GITHUB_REPO = "https://github.com/RalfZhang/ink-city";
export const GITHUB_ISSUES = `${GITHUB_REPO}/issues`;

export const WIKIPEDIA_BASE = "https://en.wikipedia.org/wiki/";

export function wikipediaUrl(cityName: string): string {
  return WIKIPEDIA_BASE + encodeURIComponent(cityName.replace(/ /g, "_"));
}
