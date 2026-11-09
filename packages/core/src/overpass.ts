import overpass from "./overpass.json";

/**
 * The Overpass API servers live map data is fetched from, in the order they're
 * tried (./overpass.json, which the desktop compiles in too: its "Test connection"
 * tries the same servers a live fetch would).
 */
export const OVERPASS_MIRRORS: readonly string[] = overpass.mirrors;
