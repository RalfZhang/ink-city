// The generalized water cut down to the ground a map can show, before it is handed
// to the renderer: the data often runs on for tens of kilometres past the map, and
// every vertex of it would be traced on every frame.

import { allOutside, type Box, type V } from "./geom";

/**
 * A ring cut to the box (Sutherland–Hodgman): what lies outside goes, stretches of
 * the box's edges standing in for it. Its winding is kept, so rings cut this way
 * still fill together as one nonzero path inside the box.
 */
export function clipRing(r: V[], b: Box): V[] {
  let pts = r;
  const sides: [(p: V) => boolean, (p: V, q: V) => V][] = [
    [(p) => p.x >= b.x0, (p, q) => cut(p, q, (q.x === p.x ? 0 : (b.x0 - p.x) / (q.x - p.x)))],
    [(p) => p.x <= b.x1, (p, q) => cut(p, q, (q.x === p.x ? 0 : (b.x1 - p.x) / (q.x - p.x)))],
    [(p) => p.y >= b.y0, (p, q) => cut(p, q, (q.y === p.y ? 0 : (b.y0 - p.y) / (q.y - p.y)))],
    [(p) => p.y <= b.y1, (p, q) => cut(p, q, (q.y === p.y ? 0 : (b.y1 - p.y) / (q.y - p.y)))],
  ];
  for (const [inside, at] of sides) {
    if (!pts.length) break;
    const out: V[] = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length], pi = inside(p), qi = inside(q);
      if (pi) out.push(p);
      if (pi !== qi) out.push(at(p, q));
    }
    pts = out;
  }
  return pts;
}

function cut(p: V, q: V, t: number): V {
  return { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t, corner: true };
}

/**
 * A line cut to the box: the pieces of it with a side reaching into the box, each
 * from the start of its first such side to the end of its last, so everything drawn
 * in the box is drawn as before.
 */
export function clipLine(pts: V[], b: Box): V[][] {
  const pieces: V[][] = [];
  let from = -1;
  for (let i = 0; i + 1 < pts.length; i++) {
    const inside = !allOutside(b, [pts[i], pts[i + 1]]);
    if (inside && from < 0) from = i;
    if (!inside && from >= 0) { pieces.push(pts.slice(from, i + 1)); from = -1; }
  }
  if (from >= 0) pieces.push(pts.slice(from));
  return pieces;
}
