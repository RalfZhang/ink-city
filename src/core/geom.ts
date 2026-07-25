// Shared lat/lon geometry primitives for the layer-extraction modules
// (water.ts / airports.ts / railways.ts). These run at PRECACHE/FETCH time
// (Node/Deno/Bun), never on the client — same rule as the modules that use
// them, so this stays out of ./index (the client barrel).

/** A raw or slimmed point; `Geom` and Overpass `out geom` shapes both match. */
export type Pt = { lat: number; lon: number };

/** Endpoint-match precision (~1cm), applied before any final coord rounding. */
export const TOL = 1e-7;

export const samePt = (a: Pt, b: Pt): boolean =>
  Math.abs(a.lat - b.lat) < TOL && Math.abs(a.lon - b.lon) < TOL;

/** Drop consecutive duplicate points (cheap, avoids zero-length segments). */
export function dedupeAdjacent<T extends Pt>(pts: T[]): T[] {
  const out: T[] = [];
  for (const p of pts) if (out.length === 0 || !samePt(out[out.length - 1], p)) out.push(p);
  return out;
}

/** Round each point's lat/lon to `precision` decimals, returning new points. */
export function roundPts(pts: Pt[], precision: number): Pt[] {
  const f = 10 ** precision;
  const r = (v: number) => Math.round(v * f) / f;
  return pts.map((p) => ({ lat: r(p.lat), lon: r(p.lon) }));
}
