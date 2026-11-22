// Plane geometry for the water generalizer (./generalize.ts): points in metres on
// the map's plane — x east, y north — and the rings and polylines made of them.

/**
 * A point in metres. `corner`: drawn exactly here and kept by every smoothing pass —
 * a seam, the map's edge, a square corner, a line's mouth. `fixed`: a corner put there
 * by the data rather than the shape (a seam, the edge), which no trimming of a built
 * shore takes away.
 */
export type V = { x: number; y: number; corner: boolean; fixed?: boolean };

/** A bare point in metres. */
export type P = [number, number];

/** A box of the plane, in metres. */
export type Box = { x0: number; y0: number; x1: number; y1: number };

/** Whether (x, y) lies outside `b`. */
export function outside(b: Box, x: number, y: number): boolean {
  return x < b.x0 || x > b.x1 || y < b.y0 || y > b.y1;
}

/** Whether every side of the polyline (closing side too, if `closed`) lies outside `b`: no part of it is inside. */
export function allOutside(b: Box, pts: readonly { x: number; y: number }[], closed = false): boolean {
  const n = pts.length;
  if (n === 1) return outside(b, pts[0].x, pts[0].y);
  for (let i = 0; i + (closed ? 0 : 1) < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    if (!(Math.max(p.x, q.x) < b.x0 || Math.min(p.x, q.x) > b.x1 || Math.max(p.y, q.y) < b.y0 || Math.min(p.y, q.y) > b.y1)) return false;
  }
  return true;
}

/** `b` grown by `d` m on every side. */
export function grow(b: Box, d: number): Box {
  return { x0: b.x0 - d, y0: b.y0 - d, x1: b.x1 + d, y1: b.y1 + d };
}

/** Degrees in a radian. */
export const DEG = 180 / Math.PI;

/** Signed area (m²): positive when the ring runs counter-clockwise. */
export function area(r: readonly { x: number; y: number }[]): number {
  let s = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += r[j].x * r[i].y - r[i].x * r[j].y;
  return s / 2;
}

/** The ring without its closing point, if it repeats the first. */
export function open(r: V[]): V[] {
  const n = r.length;
  return n > 1 && r[0].x === r[n - 1].x && r[0].y === r[n - 1].y ? r.slice(0, -1) : r;
}

/** How far the way turns at `v` on its way from `p` to `q`, in degrees: positive to the left. */
export function turnAt(p: V, v: V, q: V): number {
  const a1 = Math.atan2(v.y - p.y, v.x - p.x), a2 = Math.atan2(q.y - v.y, q.x - v.x);
  let t = a2 - a1;
  while (t > Math.PI) t -= 2 * Math.PI;
  while (t < -Math.PI) t += 2 * Math.PI;
  return t * DEG;
}

/** m: how far `p` is from the segment `a`–`b`. */
export function segDist(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

/** Whether (x, y) is inside the ring `r` (even–odd). */
export function pip(r: readonly { x: number; y: number }[], x: number, y: number): boolean {
  let ins = false;
  for (let a = 0, b = r.length - 1; a < r.length; b = a++) if ((r[a].y > y) !== (r[b].y > y) && x < ((r[b].x - r[a].x) * (y - r[a].y)) / (r[b].y - r[a].y) + r[a].x) ins = !ins;
  return ins;
}

/** The box round the points of `r`. */
export function boxOf(r: readonly { x: number; y: number }[]): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const v of r) { x0 = Math.min(x0, v.x); y0 = Math.min(y0, v.y); x1 = Math.max(x1, v.x); y1 = Math.max(y1, v.y); }
  return { x0, y0, x1, y1 };
}

/** How far along the ray from (px, py), direction (nx, ny), it meets the side (x0, y0)–(x1, y1); Infinity if it misses. */
export function rayHit(px: number, py: number, nx: number, ny: number, x0: number, y0: number, x1: number, y1: number): number {
  const ex = x1 - x0, ey = y1 - y0, den = nx * ey - ny * ex;
  if (Math.abs(den) < 1e-12) return Infinity;
  const qx = x0 - px, qy = y0 - py;
  const t = (qx * ey - qy * ex) / den, s = (qx * ny - qy * nx) / den;
  return s >= 0 && s <= 1 ? t : Infinity;
}

/** Douglas–Peucker at `tol` m; both ends stay. */
export function simplify(pts: V[], tol: number): V[] {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const st: [number, number][] = [[0, pts.length - 1]];
  while (st.length) {
    const [a, b] = st.pop()!;
    let max = 0, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = segDist(pts[i], pts[a], pts[b]);
      if (d > max) { max = d; idx = i; }
    }
    if (max > tol && idx > 0) { keep[idx] = 1; st.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/** {@link simplify} for a ring: split at its first point and the point farthest from it. */
function simplifyRing(r: V[], tol: number): V[] {
  let far = 0, fd = 0;
  for (let i = 1; i < r.length; i++) {
    const d = Math.hypot(r[i].x - r[0].x, r[i].y - r[0].y);
    if (d > fd) { fd = d; far = i; }
  }
  const a = simplify(r.slice(0, far + 1), tol), b = simplify([...r.slice(far), r[0]], tol);
  return [...a, ...b.slice(1, -1)];
}

/** {@link simplify} between corners: every corner stays. */
export function simplifyKeep(pts: V[], tol: number): V[] {
  const out: V[] = [];
  let s = 0;
  for (let i = 1; i < pts.length; i++) {
    if (!pts[i].corner && i < pts.length - 1) continue;
    const part = simplify(pts.slice(s, i + 1), tol);
    out.push(...(out.length ? part.slice(1) : part));
    s = i;
  }
  return out.length ? out : pts;
}

/** {@link simplifyKeep} for a ring. */
export function simplifyRingKeep(r: V[], tol: number): V[] {
  const first = r.findIndex((p) => p.corner);
  if (first < 0) return simplifyRing(r, tol);
  const rot = [...r.slice(first), ...r.slice(0, first), r[first]];
  return simplifyKeep(rot, tol).slice(0, -1);
}

/** {@link simplify} for a ring of samples: split in two halves. */
export function simplifyClosed(r: V[], tol: number): V[] {
  if (r.length < 8) return r;
  const h = r.length >> 1;
  const a = simplify(r.slice(0, h + 1), tol), b = simplify([...r.slice(h), r[0]], tol);
  return [...a, ...b.slice(1, -1)];
}

/** A point every `step` m along the line (or ring). */
export function resample(pts: V[], step: number, closed: boolean): V[] {
  const src = closed ? [...pts, pts[0]] : pts;
  const out: V[] = [{ ...src[0] }];
  let carry = 0;
  for (let i = 1; i < src.length; i++) {
    const a = src[i - 1], b = src[i];
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    let t = step - carry;
    while (t < L) { out.push({ x: a.x + ((b.x - a.x) * t) / L, y: a.y + ((b.y - a.y) * t) / L, corner: false }); t += step; }
    carry = L - (t - step);
  }
  if (closed) {
    if (out.length > 1 && Math.hypot(out[out.length - 1].x - out[0].x, out[out.length - 1].y - out[0].y) < step / 2) out.pop();
  } else out.push({ ...src[src.length - 1] });
  return out;
}

/** Gaussian weights for offsets -R..R, and their sum. */
export function gaussWeights(sigma: number, R: number): { w: Float64Array; sum: number } {
  const w = new Float64Array(2 * R + 1);
  let sum = 0;
  for (let j = -R; j <= R; j++) { const v = Math.exp(-(j * j) / (2 * sigma * sigma)); w[j + R] = v; sum += v; }
  return { w, sum };
}

/**
 * Point `i` of an open line run on past its ends by point reflection through them
 * (as often as it takes), so a smoothing of the line keeps its ends where they are.
 */
function mirrored(xs: ArrayLike<number>, ys: ArrayLike<number>, n: number, i: number, out: P): P {
  if (i < 0) {
    mirrored(xs, ys, n, -i, out);
    out[0] = 2 * xs[0] - out[0];
    out[1] = 2 * ys[0] - out[1];
  } else if (i > n - 1) {
    mirrored(xs, ys, n, 2 * (n - 1) - i, out);
    out[0] = 2 * xs[n - 1] - out[0];
    out[1] = 2 * ys[n - 1] - out[1];
  } else {
    out[0] = xs[i];
    out[1] = ys[i];
  }
  return out;
}

/** Gaussian along the line, sigma in samples. An open line is mirrored through its ends, so they stay put. */
export function gauss(pts: V[], sigma: number, closed: boolean): V[] {
  const n = pts.length;
  if (sigma < 0.5 || n < 3) return pts;
  const R = Math.ceil(3 * sigma);
  const { w, sum: ws } = gaussWeights(sigma, R);
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  // the points from -R to n-1+R, run on round the ring or mirrored through the ends
  const ex = new Float64Array(n + 2 * R), ey = new Float64Array(n + 2 * R), q: P = [0, 0];
  for (let i = -R; i < n + R; i++) {
    if (closed) { const k = ((i % n) + n) % n; ex[i + R] = xs[k]; ey[i + R] = ys[k]; }
    else { mirrored(xs, ys, n, i, q); ex[i + R] = q[0]; ey[i + R] = q[1]; }
  }
  const out: V[] = [];
  for (let i = 0; i < n; i++) {
    let x = 0, y = 0;
    for (let j = -R; j <= R; j++) { x += w[j + R] * ex[i + j + R]; y += w[j + R] * ey[i + j + R]; }
    out.push({ x: x / ws, y: y / ws, corner: false });
  }
  if (!closed) { out[0] = { ...pts[0] }; out[n - 1] = { ...pts[n - 1] }; }
  return out;
}

/**
 * Visvalingam–Whyatt: points go, smallest first, while the triangle they make with
 * their neighbours is under `minArea` m² — weighted by the angle there, so a sharp
 * point counts for less and a flat one for more.
 */
export function vwSimplify(pts: V[], minArea: number, closed: boolean): V[] {
  const n = pts.length;
  if (n < (closed ? 4 : 3)) return pts;
  const prev = new Int32Array(n), next = new Int32Array(n), alive = new Uint8Array(n).fill(1);
  for (let i = 0; i < n; i++) { prev[i] = i - 1; next[i] = i + 1; }
  if (closed) { prev[0] = n - 1; next[n - 1] = 0; }
  const tri = (i: number) => {
    const p = prev[i], q = next[i];
    if (p < 0 || q >= n || q < 0) return Infinity;
    const a = pts[p], b = pts[i], c = pts[q];
    const A = Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
    const ux = a.x - b.x, uy = a.y - b.y, vx = c.x - b.x, vy = c.y - b.y;
    const cos = (ux * vx + uy * vy) / ((Math.hypot(ux, uy) * Math.hypot(vx, vy)) || 1);
    return A * Math.max(0.25, (1 - cos) ** 2);
  };
  const areas = new Float64Array(n);
  const heap = new Heap();
  for (let i = 0; i < n; i++) { areas[i] = tri(i); if (areas[i] < Infinity) heap.push(areas[i], i); }
  let left = n, floor = 0;
  while (heap.size && left > (closed ? 3 : 2)) {
    const i = heap.pop(), a = heap.top;
    if (!alive[i] || a !== areas[i]) continue;
    if (a >= minArea) break;
    floor = Math.max(floor, a);
    alive[i] = 0;
    left--;
    const p = prev[i], q = next[i];
    if (p >= 0) next[p] = q;
    if (q < n && q >= 0) prev[q] = p;
    for (const j of [p, q]) {
      if (j >= 0 && j < n && alive[j]) { const na = Math.max(tri(j), floor); areas[j] = na; if (na < Infinity) heap.push(na, j); }
    }
  }
  return pts.filter((_, i) => alive[i]);
}

/**
 * Two parallel banks: from points along the shore, the distance straight across the
 * water to the other side. A strip is where most of those distances agree; its width
 * is their median, and it is about half the shore long.
 */
export function stripWidth(rs: V[][]): { width: number; len: number } | null {
  let E = 0;
  for (const r of rs) E += r.length;
  const X0 = new Float64Array(E), Y0 = new Float64Array(E), X1 = new Float64Array(E), Y1 = new Float64Array(E);
  let per = 0;
  for (let f = 0, ri = 0; ri < rs.length; ri++) {
    const r = rs[ri];
    for (let i = 0; i < r.length; i++, f++) {
      const a = r[i], b = r[(i + 1) % r.length];
      X0[f] = a.x; Y0[f] = a.y; X1[f] = b.x; Y1[f] = b.y;
      per += Math.hypot(b.x - a.x, b.y - a.y);
    }
  }
  const step = Math.max(2, per / 160);
  // where the ray from (px, py) along (nx, ny) meets side f
  const hitAt = (px: number, py: number, nx: number, ny: number, f: number) => rayHit(px, py, nx, ny, X0[f], Y0[f], X1[f], Y1[f]);
  // the nearest side straight across, not side e: every side, or with many of them,
  // those in the cells the ray walks through (the nearest hit is the same either way)
  const C = 20, grid = E > 256 ? new Grid(C) : null;
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  if (grid) {
    for (let f = 0; f < E; f++) {
      grid.addBox(Math.min(X0[f], X1[f]), Math.min(Y0[f], Y1[f]), Math.max(X0[f], X1[f]), Math.max(Y0[f], Y1[f]), f);
      bx0 = Math.min(bx0, X0[f]); bx1 = Math.max(bx1, X0[f]); by0 = Math.min(by0, Y0[f]); by1 = Math.max(by1, Y0[f]);
    }
    grid.build();
  }
  const tried = grid ? new Int32Array(E).fill(-1) : null;
  let rayNo = 0;
  const across = (px: number, py: number, nx: number, ny: number, e: number) => {
    let best = Infinity;
    if (!grid || !tried) {
      for (let f = 0; f < E; f++) {
        if (f === e) continue;
        const hit = hitAt(px, py, nx, ny, f);
        if (hit > 0.05 && hit < best) best = hit;
      }
      return best;
    }
    const me = rayNo++;
    for (let t = 0; ; t += C / 2) {
      const x = px + nx * t, y = py + ny * t;
      if (t > best + C || x < bx0 - C || x > bx1 + C || y < by0 - C || y > by1 + C) break;
      const cx = Math.floor(x / C), cy = Math.floor(y / C);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        if (!grid.lookup(cx + dx, cy + dy)) continue;
        const arr = grid.arr, hi = grid.hi;
        for (let q = grid.lo; q < hi; q++) {
          const f = arr[q];
          if (f === e || tried[f] === me) continue;
          tried[f] = me;
          const hit = hitAt(px, py, nx, ny, f);
          if (hit > 0.05 && hit < best) best = hit;
        }
      }
    }
    return best;
  };
  const ws: number[] = [];
  for (let e = 0; e < E; e++) {
    const L = Math.hypot(X1[e] - X0[e], Y1[e] - Y0[e]);
    if (L < 1e-6) continue;
    const ux = (X1[e] - X0[e]) / L, uy = (Y1[e] - Y0[e]) / L, nx = -uy, ny = ux; // left = the water
    for (let t = step / 2; t < L; t += step) {
      if (t < 1 || L - t < 1) continue;
      const best = across(X0[e] + ux * t, Y0[e] + uy * t, nx, ny, e);
      if (best < Infinity) ws.push(best);
    }
  }
  if (ws.length < 8) return null;
  ws.sort((p, q) => p - q);
  const med = ws[ws.length >> 1];
  const agree = ws.filter((w) => w > med * 0.6 && w < med * 1.6).length / ws.length;
  if (agree < 0.7) return null;
  return { width: med, len: per / 2 - med };
}

/** A polyline's length (m). */
function lineLength(l: P[]): number {
  let s = 0;
  for (let i = 1; i < l.length; i++) s += Math.hypot(l[i][0] - l[i - 1][0], l[i][1] - l[i - 1][1]);
  return s;
}

/** A line goes on through a joint that bends it less than this (60°); sharper, it is two lines meeting. */
export const JOIN_TURN = Math.PI / 3;

/** A point to 10 cm, as a key: where ways' ends meet. */
export function pointKey(p: P): string {
  return `${Math.round(p[0] * 10)},${Math.round(p[1] * 10)}`;
}

/** The way a line runs from one of its ends, over its first 15 m: a unit vector. */
export function awayFrom(raw: P[], start: boolean): P {
  const n = raw.length, E = raw[start ? 0 : n - 1];
  let q = E;
  for (let i = 1; i < n; i++) { q = raw[start ? i : n - 1 - i]; if (Math.hypot(q[0] - E[0], q[1] - E[1]) >= 15) break; }
  const L = Math.hypot(q[0] - E[0], q[1] - E[1]) || 1;
  return [(q[0] - E[0]) / L, (q[1] - E[1]) / L];
}

/**
 * Ways joined into strokes: where several ways meet, a stroke goes on through the
 * one that bends least (under {@link JOIN_TURN}), as a cartographer follows a river
 * through its confluences. The longest ways go first, so the main channel claims its own.
 */
export function strokes(ways: P[][]): P[][] {
  ways = ways.filter((w) => w.length >= 2);
  const at = new Map<string, number[]>();
  ways.forEach((w, i) => {
    for (const k of [pointKey(w[0]), pointKey(w[w.length - 1])]) (at.get(k) ?? at.set(k, []).get(k)!).push(i);
  });
  const used = new Uint8Array(ways.length);
  const dir = (a: P, b: P) => Math.atan2(b[1] - a[1], b[0] - a[0]);
  // the best unused way going on from a chain whose last segment is a→b
  const next = (a: P, b: P): { j: number; rev: boolean } | null => {
    const k = pointKey(b);
    const d0 = dir(a, b);
    let best: { j: number; rev: boolean } | null = null, bestDev = JOIN_TURN;
    for (const j of at.get(k) ?? []) {
      if (used[j]) continue;
      const w = ways[j];
      const rev = pointKey(w[0]) !== k;
      const p0 = rev ? w[w.length - 1] : w[0];
      const p1 = rev ? w[w.length - 2] : w[1];
      let dev = Math.abs(dir(p0, p1) - d0);
      if (dev > Math.PI) dev = 2 * Math.PI - dev;
      if (dev < bestDev) { bestDev = dev; best = { j, rev }; }
    }
    return best;
  };
  const order = ways.map((w, i) => [lineLength(w), i] as const).sort((a, b) => b[0] - a[0]).map((x) => x[1]);
  const out: P[][] = [];
  for (const i of order) {
    if (used[i]) continue;
    used[i] = 1;
    let chain = ways[i].slice();
    for (;;) {
      const n = next(chain[chain.length - 2], chain[chain.length - 1]);
      if (!n) break;
      used[n.j] = 1;
      const w = n.rev ? ways[n.j].slice().reverse() : ways[n.j];
      chain = chain.concat(w.slice(1));
    }
    for (;;) {
      const n = next(chain[1], chain[0]);
      if (!n) break;
      used[n.j] = 1;
      const w = n.rev ? ways[n.j] : ways[n.j].slice().reverse();
      chain = w.slice(0, -1).concat(chain);
    }
    out.push(chain);
  }
  return out;
}

/**
 * Numbers (indices into whatever the caller keeps) by square cells of `size` m, for
 * "what is near here", each cell's in the order they were added. The cells come in
 * blocks of 8×8, laid out flat and kept only where something was added, so a lookup
 * is a few array reads however far the data runs on past the map. Fill it with
 * {@link add} / {@link addBox}, {@link build} it, then {@link lookup} a cell and read
 * `arr[lo]` to `arr[hi - 1]` (copy them out before the next lookup).
 */
export class Grid {
  private pend: number[] = []; // cx, cy, item, …
  private bx0 = 0;
  private by0 = 0;
  private nbx = 0;
  private nby = 0;
  private table = new Int32Array(0); // block → its number, or -1
  private from = new Int32Array(1);
  arr = new Int32Array(0);
  lo = 0;
  hi = 0;

  constructor(readonly size: number) {}

  /** `v` in cell (cx, cy). */
  add(cx: number, cy: number, v: number): void {
    this.pend.push(cx, cy, v);
  }

  /** `v` in every cell the box from (x0, y0) to (x1, y1) m touches, column by column. */
  addBox(x0: number, y0: number, x1: number, y1: number, v: number): void {
    const S = this.size;
    for (let cx = Math.floor(x0 / S); cx <= Math.floor(x1 / S); cx++) {
      for (let cy = Math.floor(y0 / S); cy <= Math.floor(y1 / S); cy++) this.pend.push(cx, cy, v);
    }
  }

  /** Done adding: lay the items out by block and cell. */
  build(): this {
    const p = this.pend, n = p.length / 3;
    if (!n) return this;
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (let i = 0; i < n; i++) { const bx = p[3 * i] >> 3, by = p[3 * i + 1] >> 3; if (bx < bx0) bx0 = bx; if (bx > bx1) bx1 = bx; if (by < by0) by0 = by; if (by > by1) by1 = by; }
    this.bx0 = bx0;
    this.by0 = by0;
    this.nbx = bx1 - bx0 + 1;
    this.nby = by1 - by0 + 1;
    const table = new Int32Array(this.nbx * this.nby).fill(-1);
    let blocks = 0;
    const cellOf = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const cx = p[3 * i], cy = p[3 * i + 1], t = ((cx >> 3) - bx0) * this.nby + ((cy >> 3) - by0);
      if (table[t] < 0) table[t] = blocks++;
      cellOf[i] = table[t] * 64 + (cx & 7) * 8 + (cy & 7);
    }
    const from = new Int32Array(blocks * 64 + 1);
    for (let i = 0; i < n; i++) from[cellOf[i] + 1]++;
    for (let c = 0; c < blocks * 64; c++) from[c + 1] += from[c];
    const at = from.slice(0, blocks * 64), items = new Int32Array(n);
    for (let i = 0; i < n; i++) items[at[cellOf[i]]++] = p[3 * i + 2];
    this.table = table;
    this.from = from;
    this.arr = items;
    this.pend = [];
    return this;
  }

  /** Point `arr`, `lo` and `hi` at cell (cx, cy)'s items; false if it has none. */
  lookup(cx: number, cy: number): boolean {
    const x = (cx >> 3) - this.bx0, y = (cy >> 3) - this.by0;
    if (x < 0 || y < 0 || x >= this.nbx || y >= this.nby) return false;
    const b = this.table[x * this.nby + y];
    if (b < 0) return false;
    const c = b * 64 + (cx & 7) * 8 + (cy & 7);
    this.lo = this.from[c];
    this.hi = this.from[c + 1];
    return this.hi > this.lo;
  }
}

/** A binary min-heap of numbers by key: `pop` returns the value with the least key (and sets `top` to that key). */
export class Heap {
  private k: number[] = [];
  private v: number[] = [];
  /** The key of what `pop` returned last. */
  top = 0;
  get size(): number { return this.k.length; }
  push(key: number, val: number): void {
    const k = this.k, v = this.v;
    let i = k.length;
    k.push(key); v.push(val);
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
    k[i] = key; v[i] = val;
  }
  pop(): number {
    const k = this.k, v = this.v, val = v[0];
    this.top = k[0];
    const lk = k.pop()!, lv = v.pop()!, n = k.length;
    if (n) {
      let i = 0;
      for (;;) { let c = 2 * i + 1; if (c >= n) break; if (c + 1 < n && k[c + 1] < k[c]) c++; if (k[c] >= lk) break; k[i] = k[c]; v[i] = v[c]; i = c; }
      k[i] = lk; v[i] = lv;
    }
    return val;
  }
}

/**
 * A table from pairs of 32-bit integers to non-negative integers, open addressing in
 * typed arrays: for the generalizer's vertex numbers, sides and cells, where a `Map`
 * keyed by large numbers would box and hash every key.
 */
export class PairMap {
  private ka: Int32Array;
  private kb: Int32Array;
  private vs: Int32Array;
  private mask: number;
  size = 0;

  constructor(capacity = 1024) {
    let n = 16;
    while (n < capacity * 2) n *= 2;
    this.ka = new Int32Array(n);
    this.kb = new Int32Array(n);
    this.vs = new Int32Array(n).fill(-1);
    this.mask = n - 1;
  }

  private slot(a: number, b: number): number {
    let h = (Math.imul(a, 0x9e3779b1) ^ Math.imul(b + 0x7f4a7c15, 0x85ebca77)) & this.mask;
    while (this.vs[h] >= 0 && (this.ka[h] !== a || this.kb[h] !== b)) h = (h + 1) & this.mask;
    return h;
  }

  /** The value for (a, b), or -1. */
  get(a: number, b: number): number {
    return this.vs[this.slot(a, b)];
  }

  /** Set (a, b) to `v` (≥ 0). */
  set(a: number, b: number, v: number): void {
    let h = this.slot(a, b);
    if (this.vs[h] < 0) {
      if ((this.size + 1) * 2 > this.mask + 1) { this.grow(); h = this.slot(a, b); }
      this.ka[h] = a;
      this.kb[h] = b;
      this.size++;
    }
    this.vs[h] = v;
  }

  /** Every pair and its value, in no particular order. */
  forEach(f: (a: number, b: number, v: number) => void): void {
    for (let h = 0; h <= this.mask; h++) if (this.vs[h] >= 0) f(this.ka[h], this.kb[h], this.vs[h]);
  }

  private grow(): void {
    const { ka, kb, vs } = this;
    const n = (this.mask + 1) * 2;
    this.ka = new Int32Array(n);
    this.kb = new Int32Array(n);
    this.vs = new Int32Array(n).fill(-1);
    this.mask = n - 1;
    for (let h = 0; h < vs.length; h++) {
      if (vs[h] < 0) continue;
      const s = this.slot(ka[h], kb[h]);
      this.ka[s] = ka[h];
      this.kb[s] = kb[h];
      this.vs[s] = vs[h];
    }
  }
}
