// Which vertices of a shore or a line are corners — kept sharp, where they are, by
// every smoothing pass after: the square corners of built water (a basin, a pier's
// end, a quay) and the ends of its long straight sides.

import { DEG, turnAt, type V } from "./geom";

/** m: a straight side is at least this long, and so are the sides of a right angle or a U-turn. */
export const RIGHT_LEG = 30;
/** °: a right angle is 90° ± this; a U-turn at least 180° − this. */
export const RIGHT_TOL = 20;
/** m: both ends of a straight side this long are kept. */
const LONG_SIDE = 100;
/** m: the most of shore between two straight sides that is kept as one corner. */
const SPAN = 60;
/** °: no single vertex of a kept corner turns more than this — that is a spike. */
const MAX_CORNER_TURN = 110;
/** °: a square turn is 0°, 90° or 180° ± this. */
const SQUARE_TOL = 8;
/** °: a line turning less than this goes on straight. */
const STRAIGHT_ON = 3;
/** m: how far along the shore a corner's neighbours are looked for. */
const CTX_DIST = 600;

/**
 * A line's corners (the lines' rule, before the shores had their own): a right angle
 * or a U-turn between two straight sides at least {@link RIGHT_LEG} long, at most
 * {@link SPAN} apart; both ends of a side at least {@link LONG_SIDE} long; and the
 * stretch between two such sides. A corner that is not itself square is kept only
 * where the line around it is built square: of its two nearest straight-sided
 * vertices on either side, at least half turn square or not at all.
 */
export function markLineCorners(pts: V[]): void {
  const n = pts.length;
  const segs = n - 1;
  const nx = (i: number) => (i + 1) % n;
  const pv = (i: number) => (i - 1 + n) % n;
  const len = (i: number) => { const a = pts[i], b = pts[nx(i)]; return Math.hypot(b.x - a.x, b.y - a.y); };
  const dir = (i: number) => { const a = pts[i], b = pts[nx(i)]; return Math.atan2(b.y - a.y, b.x - a.x); };
  const inner = (i: number) => i > 0 && i < n - 1;
  const turn = (i: number) => (inner(i) ? Math.abs(turnAt(pts[pv(i)], pts[i], pts[nx(i)])) : 0);
  const spike = (i: number) => turn(i) > MAX_CORNER_TURN;
  const square = (t: number) => t < STRAIGHT_ON || Math.abs(t - 90) <= SQUARE_TOL || t > 180 - SQUARE_TOL;
  const sided = (i: number) => inner(i) && len(pv(i)) >= RIGHT_LEG && len(i) >= RIGHT_LEG;
  // the nearest two straight-sided vertices before side a and after side b
  const context = (a: number, b: number) => {
    let reg = 0, all = 0;
    for (const [from, step] of [[a, pv], [nx(b), nx]] as const) {
      let i = from, got = 0, walked = 0;
      for (let guard = 0; guard < n && got < 2 && walked < CTX_DIST; guard++) {
        if (sided(i)) { got++; all++; if (square(turn(i))) reg++; }
        walked += len(step === pv ? pv(i) : i);
        i = step(i);
        if (i === 0 || i === n - 1) break;
      }
    }
    return all === 0 || reg * 2 >= all;
  };
  const mark = (a: number, b: number, sq: boolean) => {
    const list: number[] = [];
    for (let i = nx(a); ; i = nx(i)) { list.push(i); if (i === b) break; }
    if (list.some(spike)) return;
    if (!sq && !context(a, b)) return;
    for (const i of list) pts[i].corner = true;
  };
  const sides = (min: number) => { const s: number[] = []; for (let i = 0; i < segs; i++) if (len(i) >= min) s.push(i); return s; };
  const between = (a: number, b: number) => { let s = 0; for (let i = nx(a); i !== b; i = nx(i)) s += len(i); return s; };
  const turnBetween = (a: number, b: number) => { let t = Math.abs(dir(b) - dir(a)) * DEG; return t > 180 ? 360 - t : t; };

  const right = sides(RIGHT_LEG);
  for (let p = 0; p < right.length - 1; p++) {
    const a = right[p], b = right[p + 1];
    if (a === b || between(a, b) > SPAN) continue;
    const t = turnBetween(a, b);
    if (Math.abs(t - 90) > RIGHT_TOL && t < 180 - RIGHT_TOL) continue;
    mark(a, b, t >= 180 - SQUARE_TOL);
  }
  const long = sides(LONG_SIDE);
  for (const a of long) {
    if (inner(a)) mark(pv(a), a, false);
    if (inner(nx(a))) mark(a, nx(a), false);
  }
  for (let p = 0; p < long.length - 1; p++) {
    const a = long[p], b = long[p + 1];
    if (a !== b && between(a, b) <= SPAN) mark(a, b, square(turnBetween(a, b)));
  }
}

/** m: a dead-end inlet narrower than this is shore detail (a slip), not a basin. */
const INLET_MIN = 5;
/** m: …if it is no deeper than this. */
const INLET_DEEP = 100;
/** m: on water at least this wide on average (narrower, the end of the body itself is no slip). */
const INLET_BODY = 60;

/**
 * A shore's corners. Corner units — the vertices between two straight sides at least
 * {@link RIGHT_LEG} long, at most {@link SPAN} apart — are kept when they make a
 * U-turn, or a right angle or a long side's end where the shore around them is
 * built square (of the nearest units, at least half square or straight on); so is
 * the end of a pier or a basin (two right angles the same way with a short side
 * between), and both ends of a side at least {@link LONG_SIDE} long. On water at
 * least {@link INLET_BODY} wide, the end of a slip (a dead-end inlet narrower than
 * {@link INLET_MIN} and no deeper than {@link INLET_DEEP}) and a little land finger
 * between two slips are not kept, whatever else would mark them. Corners already
 * set (seams, the map's edge) stay.
 */
export function markShoreCorners(pts: V[], bodyW: number): void {
  const n = pts.length;
  if (n < 3) return;
  const nx = (i: number) => (i + 1) % n, pv = (i: number) => (i - 1 + n) % n;
  const len = (i: number) => Math.hypot(pts[nx(i)].x - pts[i].x, pts[nx(i)].y - pts[i].y);
  const dir = (i: number) => Math.atan2(pts[nx(i)].y - pts[i].y, pts[nx(i)].x - pts[i].x);
  const sturn = (i: number) => turnAt(pts[pv(i)], pts[i], pts[nx(i)]);
  const turn = (i: number) => Math.abs(sturn(i));
  const pos: number[] = [];
  let total = 0;
  for (let i = 0; i < n; i++) { pos[i] = total; total += len(i); }
  const turnBetween = (a: number, b: number) => { let t = Math.abs(dir(b) - dir(a)) * DEG; return t > 180 ? 360 - t : t; };
  const between = (a: number, b: number) => { let s = 0; for (let i = nx(a); i !== b; i = nx(i)) s += len(i); return s; };
  type Unit = { a: number; b: number; T: number; sign: number; verts: number[]; spike: boolean; at: number };
  const longE: number[] = [];
  for (let i = 0; i < n; i++) if (len(i) >= RIGHT_LEG) longE.push(i);
  const units: Unit[] = [];
  for (let p = 0; p < longE.length; p++) {
    const a = longE[p], b = longE[(p + 1) % longE.length];
    if (a === b || between(a, b) > SPAN) continue;
    const verts: number[] = [];
    for (let i = nx(a); ; i = nx(i)) { verts.push(i); if (i === b) break; }
    units.push({
      a, b, T: turnBetween(a, b), sign: Math.sign(verts.reduce((acc, v) => acc + sturn(v), 0)), verts,
      spike: verts.some((v) => turn(v) > MAX_CORNER_TURN), at: pos[verts[0]],
    });
  }
  const regular = (T: number) => Math.abs(T - 90) <= SQUARE_TOL || T >= 180 - SQUARE_TOL || T < STRAIGHT_ON * 0.5;
  const arc = (x: number, y: number) => Math.min(Math.abs(x - y), total - Math.abs(x - y));
  // units are in shore order: the nearest ones are the neighbours in the list
  const contextAt = (at: number, skip: number) => {
    const U = units.length;
    if (!U) return true;
    let lo = 0, hi = U; // the first unit past `at`
    while (lo < hi) { const m = (lo + hi) >> 1; if (units[m].at > at) hi = m; else lo = m + 1; }
    const picks = new Set<number>();
    const add = (j: number) => { j = ((j % U) + U) % U; if (j !== skip) picks.add(j); };
    if (skip >= 0) { add(skip - 1); add(skip - 2); add(skip + 1); add(skip + 2); }
    else { add(lo); add(lo + 1); add(lo - 1); add(lo - 2); }
    let reg = 0, all = 0;
    for (const j of picks) { if (arc(units[j].at, at) > CTX_DIST) continue; all++; if (regular(units[j].T)) reg++; }
    return all === 0 || reg * 2 >= all;
  };
  const inUnit = new Set<number>();
  const soft = new Set<number>();
  const was = pts.map((p) => p.corner); // seams and the map's edge, from before
  {
    const chord = (u: Unit) => Math.hypot(pts[u.b].x - pts[nx(u.a)].x, pts[u.b].y - pts[nx(u.a)].y);
    const uturnOf = (u: Unit) => !u.spike && u.T >= 180 - RIGHT_TOL;
    const LIM = INLET_DEEP + 20, GAP = 1.5 * INLET_MIN;
    // one side of the inlet, walked outward from its end
    const side = (start: number, step: (i: number) => number): number[] => {
      const out = [start];
      let s = 0;
      for (let i = start, k = 0; s < LIM && k < n >> 1; k++) { const j = step(i); s += Math.hypot(pts[j].x - pts[i].x, pts[j].y - pts[i].y); out.push(j); i = j; }
      return out;
    };
    const distTo = (x: number, y: number, pl: number[], upTo: number) => {
      let d = Infinity, at = 0;
      for (let j = 0; j + 1 < pl.length && j < upTo; j++) {
        const a = pts[pl[j]], b = pts[pl[j + 1]], ex = b.x - a.x, ey = b.y - a.y, L = ex * ex + ey * ey;
        const t = L ? Math.max(0, Math.min(1, ((x - a.x) * ex + (y - a.y) * ey) / L)) : 0;
        const dd = Math.hypot(a.x + t * ex - x, a.y + t * ey - y);
        if (dd < d) { d = dd; at = j; }
      }
      return [d, at];
    };
    // both sides walked outward together, as far as they stay within `gap` of each
    // other: how deep that is, and whether a seam lies on the way
    const run = (u: Unit, gap: number) => {
      const A = side(nx(u.a), pv), B = side(u.b, nx);
      let s = 0, seam = false, far = 0;
      for (let j = 0; j + 1 < A.length; j++) {
        const a = pts[A[j]], b = pts[A[j + 1]], L = Math.hypot(b.x - a.x, b.y - a.y), k = Math.max(1, Math.ceil(L / 4));
        if (was[A[j]]) seam = true;
        for (let q = 0; q < k; q++) {
          const [d, at] = distTo(a.x + ((b.x - a.x) * q) / k, a.y + ((b.y - a.y) * q) / k, B, B.length);
          far = Math.max(far, at);
          if (d > gap) { for (let m = 0; m <= far; m++) if (was[B[m]]) seam = true; return { d: s + (L * q) / k, seam }; }
        }
        s += L;
        if (s >= LIM) break;
      }
      for (let m = 0; m <= far; m++) if (was[B[m]]) seam = true;
      return { d: s, seam };
    };
    const slipSide = new Set<number>();
    if (bodyW >= INLET_BODY) {
      for (const u of units) {
        if (!uturnOf(u) || u.sign <= 0 || chord(u) >= INLET_MIN) continue;
        const r = run(u, GAP);
        if (r.d >= INLET_DEEP || r.seam) continue;
        for (const v of u.verts) soft.add(v);
        slipSide.add(u.a);
        slipSide.add(u.b);
      }
    }
    // a little land finger beside a slip: as short as one, all of it this body's shore
    for (const u of units) {
      if (!uturnOf(u) || u.sign >= 0 || !(slipSide.has(u.a) || slipSide.has(u.b))) continue;
      const r = run(u, 1.5 * chord(u));
      if (r.d >= INLET_DEEP || r.seam) continue;
      for (const v of u.verts) soft.add(v);
    }
  }
  const isSoft = (u: Unit) => u.verts.some((v) => soft.has(v));
  // the end of a pier or a basin: two right angles turning the same way, a short side
  // between them, both sides beside them much longer
  for (let k = 0; k < units.length; k++) {
    const u = units[k], w = units[(k + 1) % units.length];
    if (u === w || u.b !== w.a || u.spike || w.spike || isSoft(u) || isSoft(w)) continue;
    if (Math.abs(u.T - 90) > RIGHT_TOL || Math.abs(w.T - 90) > RIGHT_TOL || u.sign !== w.sign) continue;
    const end = len(u.b);
    if (end > 150 || len(u.a) < 1.5 * end || len(w.b) < 1.5 * end) continue;
    for (const v of [...u.verts, ...w.verts]) { pts[v].corner = true; inUnit.add(v); }
    pts[u.a].corner = true;
    pts[nx(w.b)].corner = true;
  }
  units.forEach((u, k) => {
    if (u.spike || isSoft(u)) return;
    const uturn = u.T >= 180 - RIGHT_TOL;
    const right = Math.abs(u.T - 90) <= RIGHT_TOL;
    const long = len(u.a) >= LONG_SIDE || len(u.b) >= LONG_SIDE;
    if (uturn || ((right || long) && contextAt(u.at, k))) {
      for (const v of u.verts) { pts[v].corner = true; inUnit.add(v); }
      // a kept corner keeps its two straight sides whole
      pts[u.a].corner = true;
      pts[nx(u.b)].corner = true;
    }
  });
  for (let i = 0; i < n; i++) {
    if (len(i) < LONG_SIDE) continue;
    for (const v of [i, nx(i)]) {
      if (inUnit.has(v) || soft.has(v) || turn(v) > MAX_CORNER_TURN) continue;
      if (contextAt(pos[v], -1)) pts[v].corner = true;
    }
  }
  // a neighbour's kept side may have reached into a slip: only seams and the edge stay there
  for (const v of soft) pts[v].corner = was[v];
}
