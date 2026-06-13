// Barrel for the portable core. Consumers can import from "@/core" (desktop)
// or copy/depend on this directory from the CI script and website repos.
export * from "./types";
export * from "./city";
export * from "./bbox";
export * from "./overpass";
// NOTE: ./water is intentionally NOT re-exported here. It is precache-only
// (Node/CI) and pulls in `polygon-clipping`; the desktop/website client must
// not bundle it. Precache imports it directly from "./water".
export * from "./render";
export * from "./constants";
