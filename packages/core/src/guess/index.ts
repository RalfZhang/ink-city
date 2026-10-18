// The daily "guess the country" game, shared by the desktop app and the website.
// Hosts supply today's inputs (`DayInputs`), the country table
// (packages/core/data/countries.json → `countryIndex`) and a `GuessStorage`; the rules, the
// save-file format, the hint geometry, stats and the country lookup all live here.
export * from "./types";
export * from "./geo";
export * from "./store";
export * from "./game";
export * from "./search";
