import { COMPASS_POINTS, type CompassPoint } from "./types";

// The game's hint geometry: how far the guessed country is from today's city, which
// way to go, and how warm that is on the five-cell ink scale.

/** Mean Earth radius (IUGG), km. */
const EARTH_RADIUS_KM = 6371.0088;
const RAD = Math.PI / 180;
/** Keeps the Mercator latitude finite — the poles are at infinity on a rhumb line. */
const MAX_LAT = 89.9999;

/** Great-circle distance in km. */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * RAD;
  const dLon = (lon2 - lon1) * RAD;
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Rhumb-line (constant-heading) bearing from point 1 to point 2, in degrees
 * clockwise from north, `[0, 360)`. A rhumb line rather than the great-circle initial
 * bearing because the hint is read off a flat map: from the US to Japan the great
 * circle heads north-west over Alaska, while the answer "west" is what a player
 * looking at a map expects (Worldle does the same). The longitude gap takes the
 * short way round the antimeridian, so Fiji → Samoa points east, not west.
 */
export function rhumbBearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const clamp = (v: number) => Math.max(-MAX_LAT, Math.min(MAX_LAT, v)) * RAD;
  const p1 = clamp(lat1);
  const p2 = clamp(lat2);
  let dLon = (lon2 - lon1) * RAD;
  if (dLon > Math.PI) dLon -= 2 * Math.PI;
  if (dLon < -Math.PI) dLon += 2 * Math.PI;
  const dPsi = Math.log(Math.tan(Math.PI / 4 + p2 / 2) / Math.tan(Math.PI / 4 + p1 / 2));
  const deg = Math.atan2(dLon, dPsi) / RAD;
  return (deg + 360) % 360;
}

/** The nearest of the eight compass points to a bearing (sectors centred on each point). */
export function compassPoint(deg: number): CompassPoint {
  const i = Math.round((((deg % 360) + 360) % 360) / 45) % 8;
  return COMPASS_POINTS[i];
}

/**
 * Upper bounds (km) of the proximity tiers, closest first: within the first bound is
 * tier 5, within the last is tier 1, beyond it 0. Roughly a doubling-plus per step,
 * because "how warm" is felt logarithmically — 300 vs 600 km is a real difference,
 * 9000 vs 9300 km isn't.
 */
export const TIER_BOUNDS_KM = [300, 1000, 2500, 5000, 10000] as const;
/** The full ink scale — also what the correct guess shows. */
export const MAX_TIER = TIER_BOUNDS_KM.length;

/** Proximity tier for a distance: `MAX_TIER` (closest) … 0 (farthest). */
export function proximityTier(km: number): number {
  const i = TIER_BOUNDS_KM.findIndex((bound) => km <= bound);
  return i === -1 ? 0 : MAX_TIER - i;
}
