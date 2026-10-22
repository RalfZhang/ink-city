// The ink front's pace (./growth.ts), on its own: what moves with the front on the
// page needs only this, and the layout would bring the renderer into the main
// bundle with it.

/** Seconds for the front to cross the screen. */
export const SPREAD_S = 1.6;
/** The front's pace: a road starts at SPREAD_S × (its distance from the top / the screen's height) ^ this — a touch quicker as it goes. */
export const SPREAD_CURVE = 0.85;
/**
 * Where the front has got to over SPREAD_S, as a CSS easing — the inverse of the
 * curve above — for anything that moves with it: the curtain the map is drawn out
 * from under (game/Curtain.tsx) keeps its edge on the ink's. A cubic-bezier fitted
 * to it (within 0.1% all the way; scripts/web-test.ts holds it to the curve) rather
 * than `linear()`, which a browser without it drops along with the whole animation —
 * and a curtain that never goes down is a game that never starts.
 */
export const FRONT_EASE = "cubic-bezier(0.16, 0.08, 0.56, 0.48)";
