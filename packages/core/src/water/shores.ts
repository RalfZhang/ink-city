// The passes that move a kept body's shore: every shore between its corners
// smoothed by its size (smoothSoft), big water smoothed more as far as the local
// width allows (smoothBig), thin water smoothed by its centre line and its width
// (smoothThin), and water too thin to see widened (widenDense).

import { METERS_PER_WEIGHT, WATER_LINE_WEIGHT_DEFAULT, WATER_LINE_WEIGHTS } from "../render";
import { allOutside, gauss, Grid, rayHit, resample, simplify, simplifyClosed, simplifyRingKeep, vwSimplify, type Box, type V } from "./geom";

/** m: how far the first smoothing of every shore reaches (a Gaussian's sigma), at most. */
const SHORE_SIGMA = 40;
/** m²: before it, bumps and dents smaller than this go (Visvalingam–Whyatt). */
const SHORE_VW_AREA = 1200;

/** m: the sigma of {@link smoothSoft} on water `w` m wide on average. */
const softSigma = (w: number) => Math.min(SHORE_SIGMA, w / 2);

/**
 * Every stretch of the ring between two corners, on water `w` m wide on average:
 * small bumps and dents removed by size, a point every 4 m, then a Gaussian of
 * {@link softSigma}. The corners stay.
 */
export function smoothSoft(r: V[], w: number, work: Box): V[] {
  const vw = Math.min(SHORE_VW_AREA, 2 * w * w), sigma = softSigma(w);
  const first = r.findIndex((v) => v.corner);
  if (first < 0) return allOutside(work, r, true) ? r : simplifyClosed(gauss(resample(vwSimplify(r, vw, true), 4, true), sigma / 4, true), 0.8);
  const rot = [...r.slice(first), ...r.slice(0, first), r[first]];
  const out: V[] = [];
  let s = 0;
  for (let i = 1; i < rot.length; i++) {
    if (!rot[i].corner) continue;
    const part = rot.slice(s, i + 1);
    let done: V[];
    if (part.length <= 2 || allOutside(work, part)) done = part;
    else {
      const sm = gauss(resample(vwSimplify(part, vw, false), 4, false), sigma / 4, false);
      done = simplify(sm, 0.8);
      done[0] = part[0];
      done[done.length - 1] = part[part.length - 1];
    }
    out.push(...(out.length ? done.slice(1) : done));
    s = i;
  }
  return out.slice(0, -1);
}

/**
 * Which vertices of the ring lie on a stretch between two corners (or on a ring with
 * no corner) wholly off the work box, ends included — what the passes leave as it is.
 */
function farStretches(r: V[], work: Box): boolean[] {
  const n = r.length, res = new Array<boolean>(n).fill(false);
  const first = r.findIndex((v) => v.corner);
  if (first < 0) return allOutside(work, r, true) ? res.fill(true) : res;
  for (let k = 0, a = first; k < n; ) {
    let b = (a + 1) % n, len = 1;
    while (!r[b].corner) { b = (b + 1) % n; len++; }
    const part: V[] = [];
    for (let j = 0, i = a; j <= len; j++, i = (i + 1) % n) part.push(r[i]);
    if (allOutside(work, part)) for (let j = 0, i = a; j <= len; j++, i = (i + 1) % n) res[i] = true;
    k += len;
    a = b;
  }
  return res;
}

/** A kept body as the shore passes see it: its rings, its average width (m), and whether it is a canal. */
export type Body = { out: V[][]; w: number; canal: boolean };

/**
 * Every ring of every body, a point every 8 m, by 48 m cells: for "where is the
 * shore across from here". Each point has its ring, its place along the ring (m),
 * and the way the ring runs there.
 */
class ShoreIndex {
  static readonly CELL = 48;
  readonly grid: Grid;
  readonly X: number[] = [];
  readonly Y: number[] = [];
  readonly ring: number[] = [];
  readonly at: number[] = [];
  readonly tx: number[] = [];
  readonly ty: number[] = [];
  /** Each ring's length and body. */
  readonly ringLen: number[] = [];
  readonly ringBody: number[] = [];
  /** Each point's body. */
  readonly body: number[] = [];
  readonly ids = new Map<V[], number>();

  constructor(bodies: Body[]) {
    const IC = ShoreIndex.CELL;
    this.grid = new Grid(IC);
    for (const [bi, b] of bodies.entries()) for (const r of b.out) {
      const id = this.ringLen.length;
      this.ids.set(r, id);
      this.ringBody.push(bi);
      let s = 0;
      for (let j = 0; j < r.length; j++) {
        const a = r[j], c = r[(j + 1) % r.length], L = Math.hypot(c.x - a.x, c.y - a.y), k = Math.max(1, Math.ceil(L / 8));
        for (let q = 0; q < k; q++) {
          const x = a.x + ((c.x - a.x) * q) / k, y = a.y + ((c.y - a.y) * q) / k;
          this.grid.add(Math.floor(x / IC), Math.floor(y / IC), this.X.length);
          this.body.push(bi);
          this.X.push(x);
          this.Y.push(y);
          this.ring.push(id);
          this.at.push(s + (L * q) / k);
          this.tx.push((c.x - a.x) / (L || 1));
          this.ty.push((c.y - a.y) / (L || 1));
        }
        s += L;
      }
      this.ringLen.push(s);
    }
    this.grid.build();
  }
}

/**
 * A ring cut at its corners into runs, each sampled every `step` m: the samples,
 * their place along the ring, and the run's ends. A ring with no corner is one
 * closed run.
 */
type Run = { vs: V[]; xs: number[]; ys: number[]; ss: number[]; closed: boolean; far: boolean };
function runsOf(r: V[], step: number, cum: number[], work: Box): Run[] {
  const n = r.length, L = cum[n];
  const hard = r.map((v, j) => (v.corner ? j : -1)).filter((j) => j >= 0);
  const spans: [number, number][] = hard.length ? hard.map((a, k) => [a, hard[(k + 1) % hard.length]] as [number, number]) : [[0, n]];
  const closed = !hard.length;
  return spans.map(([a, bEnd]) => {
    const vs: V[] = [];
    for (let j = a; ; j = (j + 1) % n) { vs.push(r[j]); if (vs.length > 1 && j === bEnd % n) break; if (closed && vs.length === n) break; }
    if (closed) vs.push(r[0]);
    const xs: number[] = [], ys: number[] = [], ss: number[] = [];
    // wholly off the work box: left as it is, not even sampled
    const far = allOutside(work, vs);
    if (far) return { vs, xs, ys, ss, closed, far };
    let s = cum[a];
    for (let j = 0; j + 1 < vs.length; j++) {
      const p = vs[j], q = vs[j + 1], l = Math.hypot(q.x - p.x, q.y - p.y), k = Math.max(1, Math.round(l / step));
      for (let t = 0; t < k; t++) { xs.push(p.x + ((q.x - p.x) * t) / k); ys.push(p.y + ((q.y - p.y) * t) / k); ss.push((s + (l * t) / k) % L); }
      s += l;
    }
    if (!closed) { const e = vs[vs.length - 1]; xs.push(e.x); ys.push(e.y); ss.push(cum[bEnd % n] % L); }
    return { vs, xs, ys, ss, closed, far };
  });
}

function cumulative(r: V[]): number[] {
  const n = r.length, cum: number[] = [0];
  for (let j = 0; j < n; j++) cum.push(cum[j] + Math.hypot(r[(j + 1) % n].x - r[j].x, r[(j + 1) % n].y - r[j].y));
  return cum;
}

/** The way the run goes at sample q, from the sample before to the one after. */
function tangent(run: Run, q: number): [number, number] {
  const { xs, ys, closed } = run, m = xs.length;
  const a = closed ? (q - 1 + m) % m : Math.max(0, q - 1), c = closed ? (q + 1) % m : Math.min(m - 1, q + 1);
  return [xs[c] - xs[a], ys[c] - ys[a]];
}

/** How far a smoothing reaches, kept from growing faster than `dk` per sample, and nil at an open run's ends. */
function fadeIn(se: Float64Array | number[], m: number, closed: boolean, dk: number): void {
  if (!closed) { se[0] = 0; se[m - 1] = 0; }
  for (let pass = 0; pass < (closed ? 2 : 1); pass++) {
    for (let i = 1; i < (closed ? m + 1 : m); i++) { const a2 = i % m, p = (i - 1) % m; se[a2] = Math.min(se[a2], se[p] + dk); }
    for (let i = closed ? m : m - 2; i >= 0; i--) { const a2 = ((i % m) + m) % m, p = (i + 1) % m; se[a2] = Math.min(se[a2], se[p] + dk); }
  }
}

/** The smoothed samples back into the ring: simplified at 0.8 m, the run's ends as they were. */
function settle(sm: V[], run: Run, outPts: V[]): void {
  if (run.closed) { outPts.push(...simplifyClosed(sm, 0.8)); return; }
  const done = simplify(sm, 0.8);
  done[0] = run.vs[0];
  done[done.length - 1] = run.vs[run.vs.length - 1];
  outPts.push(...(outPts.length ? done.slice(1) : done));
}

function keepRun(run: Run, outPts: V[]): void {
  if (run.closed) outPts.push(...run.vs.slice(0, -1));
  else outPts.push(...(outPts.length ? run.vs.slice(1) : run.vs));
}

/** m: big water is smoothed as by a Gaussian of at most this sigma… */
const BIG_SIGMA = 120;
/** …reaching at most this share of the width of the water or the land across (within the body)… */
const BIG_LFS = 0.25;
/** …or of the land between this body and another. */
const BIG_LFS_OTHER = 0.4;
/** The extra smoothing grows by at most this much per metre of shore from a corner. */
const FADE = 0.5;
/** m: and moves the shore at most about this far (tanh), so a pier or a point stays. */
const BIG_MOVE = 20;

/**
 * Big water smoothed more. After {@link smoothSoft} (sigma = min(40, w/2)), a body
 * wider than 80 m on average is smoothed again, so that in all it is smoothed as by
 * 40·√(w/80) m, at most {@link BIG_SIGMA}. Where the water or the land beside it is
 * narrow (a strait, an island, a peninsula), the smoothing reaches at most
 * {@link BIG_LFS} of that width. It is nil at every corner and grows from there by
 * at most {@link FADE} per metre, so nowhere does the shore go from smoothed to not
 * in one step.
 */
export function smoothBig(bodies: Body[], work: Box): void {
  const S0 = SHORE_SIGMA, SM = BIG_SIGMA, K = BIG_LFS, KO = BIG_LFS_OTHER, KMIN = Math.min(K, KO), STEP = 4;
  const sizeSigma = (w: number) => (w <= 2 * S0 ? softSigma(w) : Math.min(SM, S0 * Math.sqrt(w / (2 * S0))));
  const ix = new ShoreIndex(bodies);
  const { grid, X: PX, Y: PY, ring: PR, at: PS, tx: PTX, ty: PTY, ringLen, ringBody: RB, body: PB } = ix;
  const IC = ShoreIndex.CELL;
  // The nearest shore across the water or the land: a point off to the side (not along
  // this shore), facing this one, on another ring or on this ring further round than
  // twice as far. Another body's shore lying on this one (a seam, a body mapped twice)
  // runs along it, so it does not count; another body counts only across the land.
  const across = (x: number, y: number, tx: number, ty: number, id: number, s: number, cap: number) => {
    const maxR = cap / KMIN, cx = Math.floor(x / IC), cy = Math.floor(y / IC), RR = Math.ceil(maxR / IC);
    const tl = Math.hypot(tx, ty) || 1, body = RB[id];
    let best = cap;
    const visit = (cx: number, cy: number) => {
      if (!grid.lookup(cx, cy)) return;
      const arr = grid.arr, hi = grid.hi;
      for (let q = grid.lo; q < hi; q++) {
        const k = arr[q];
        const ex = PX[k] - x, ey = PY[k] - y, d2 = ex * ex + ey * ey;
        // clearly out of reach, before the exact test
        if (d2 * KMIN * KMIN > best * best * 1.000001 || d2 < 3.99) continue;
        const d = Math.hypot(ex, ey);
        if (d * KMIN >= best || d < 2) continue;
        if (Math.abs(ex * tx + ey * ty) / (d * tl) > 0.7) continue; // along the shore, not across
        if ((PTX[k] * tx + PTY[k] * ty) / tl > -0.3) continue; // not facing this shore
        let lim: number;
        if (PB[k] === body) {
          if (PR[k] === id) { const L = ringLen[id]; let a = Math.abs(PS[k] - s); a = Math.min(a, L - a); if (a <= 2 * d + 16) continue; }
          lim = K * d;
        } else {
          if (tx * ey - ty * ex > 0) continue; // on the water's side: the same water mapped twice, not land between
          lim = KO * d;
        }
        if (lim < best) best = lim;
      }
    };
    for (let R = 0; R <= RR; R++) {
      if (R > 0 && (R - 1) * IC * KMIN >= best) break;
      if (R === 0) { visit(cx, cy); continue; }
      // the cells R from this one: the rows above and below, then the columns between
      for (let dx = -R; dx <= R; dx++) { visit(cx + dx, cy - R); visit(cx + dx, cy + R); }
      for (let dy = -R + 1; dy <= R - 1; dy++) { visit(cx - R, cy + dy); visit(cx + R, cy + dy); }
    }
    return best;
  };
  for (const b of bodies) {
    const s1 = softSigma(b.w), sT = sizeSigma(b.w);
    if (sT <= s1 + 0.5) continue;
    b.out = b.out.map((r) => {
      const id = ix.ids.get(r)!;
      const runs = runsOf(r, STEP, cumulative(r), work);
      const outPts: V[] = [];
      for (const run of runs) {
        const { xs, ys, ss, closed } = run, m = xs.length;
        if (run.far || m < 4) { keepRun(run, outPts); continue; }
        // how far the smoothing may reach at each sample: by the body's size, by the local width
        const QS = 8, tq: number[] = [];
        const lim = (q: number) => { const [tx, ty] = tangent(run, q); return across(xs[q], ys[q], tx, ty, id, ss[q], sT); };
        for (let q = 0; q < m; q += QS) tq.push(lim(q));
        const qLast = lim(m - 1);
        const se: number[] = new Array(m);
        for (let i = 0; i < m; i++) {
          const q0 = Math.floor(i / QS), t0 = tq[q0], t1 = q0 + 1 < tq.length ? tq[q0 + 1] : closed ? tq[0] : qLast;
          const t = Math.min(t0, t1);
          se[i] = Math.sqrt(Math.max(0, t * t - s1 * s1));
        }
        fadeIn(se, m, closed, FADE * STEP);
        // a Gaussian whose reach is se at each sample; an open run mirrored through its ends
        const sm: V[] = [];
        for (let i = 0; i < m; i++) {
          const sg = se[i] / STEP;
          if (sg < 0.5 || (!closed && (i === 0 || i === m - 1))) { sm.push({ x: xs[i], y: ys[i], corner: false }); continue; }
          const R = Math.min(Math.ceil(3 * sg), closed ? m >> 1 : m - 1);
          let x = 0, y = 0, ws = 0;
          for (let j = -R; j <= R; j++) {
            const w = Math.exp(-(j * j) / (2 * sg * sg)), q = i + j;
            let px: number, py: number;
            if (closed) { const k = ((q % m) + m) % m; px = xs[k]; py = ys[k]; }
            else if (q < 0) { px = 2 * xs[0] - xs[-q]; py = 2 * ys[0] - ys[-q]; }
            else if (q > m - 1) { const k = 2 * (m - 1) - q; px = 2 * xs[m - 1] - xs[k]; py = 2 * ys[m - 1] - ys[k]; }
            else { px = xs[q]; py = ys[q]; }
            x += w * px; y += w * py; ws += w;
          }
          let nx2 = x / ws, ny2 = y / ws;
          const dx = nx2 - xs[i], dy = ny2 - ys[i], dl = Math.hypot(dx, dy);
          if (dl > 1e-9) { const f = (BIG_MOVE * Math.tanh(dl / BIG_MOVE)) / dl; nx2 = xs[i] + dx * f; ny2 = ys[i] + dy * f; }
          sm.push({ x: nx2, y: ny2, corner: false });
        }
        settle(sm, run, outPts);
      }
      if (!runs[0].closed) outPts.pop(); // the first corner again
      return outPts.length >= 3 ? outPts : r;
    });
  }
}

/** m: thin water's centre line and width are smoothed as by a Gaussian of at most this sigma… */
const THIN_SIGMA = 120;
/** …reaching this many times the local width… */
const THIN_K = 2;
/** m: on water up to this wide in full… */
const THIN_FULL = 120;
/** m: …and from there less and less, until this wide. */
const THIN_MAX = 200;

/**
 * Thin water smoothed by its centre line and its width, both banks together. Each
 * point of the shore is paired with the bank across the water from it (the nearest
 * facing shore of the same body, on the water's side): the pair gives the middle of
 * the water there and half its width. The middles are smoothed along the water, and
 * so are the half-widths; the point then moves by how much its middle moved and its
 * half-width changed. Both banks see about the same middles and widths, so the water
 * keeps its width while its line gets smoother. As with big water: nil at a corner,
 * growing by at most {@link FADE} per metre, moving the shore at most about
 * {@link BIG_MOVE}. Canals (kept as drawn) are left alone, and so is a bank with a
 * road running along it within 12 m (`roads`, as segments): a built bank.
 */
export function smoothThin(bodies: Body[], roads: Float64Array, work: Box): void {
  const SC = 25, sgrid = new Grid(SC), nRoads = roads.length / 4;
  // only the cells a shore smoothed here passes through are ever looked up: the roads go in those alone
  const wanted = new Grid(SC);
  for (const b of bodies) {
    if (b.canal) continue;
    for (const r of b.out) for (let j = 0; j < r.length; j++) {
      const a = r[j], c = r[(j + 1) % r.length];
      wanted.addBox(Math.min(a.x, c.x), Math.min(a.y, c.y), Math.max(a.x, c.x), Math.max(a.y, c.y), 0);
    }
  }
  wanted.build();
  for (let e = 0; e < nRoads; e++) {
    const ax = roads[4 * e], ay = roads[4 * e + 1], bx = roads[4 * e + 2], by = roads[4 * e + 3];
    for (let cx = Math.floor((Math.min(ax, bx) - 8) / SC); cx <= Math.floor((Math.max(ax, bx) + 8) / SC); cx++) {
      for (let cy = Math.floor((Math.min(ay, by) - 8) / SC); cy <= Math.floor((Math.max(ay, by) + 8) / SC); cy++) if (wanted.lookup(cx, cy)) sgrid.add(cx, cy, e);
    }
  }
  sgrid.build();
  const onRoad = (x: number, y: number, tx: number, ty: number) => {
    const tl = Math.hypot(tx, ty) || 1;
    if (!sgrid.lookup(Math.floor(x / SC), Math.floor(y / SC))) return false;
    const arr = sgrid.arr, hi = sgrid.hi;
    for (let q = sgrid.lo; q < hi; q++) {
      const e = arr[q];
      const ax = roads[4 * e], ay = roads[4 * e + 1], bx = roads[4 * e + 2], by = roads[4 * e + 3], ex = bx - ax, ey = by - ay, L = Math.hypot(ex, ey);
      if (L < 1e-6) continue; // a repeated point (coordinates are rounded): no direction to run along
      const t = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / (L * L)));
      if (Math.hypot(ax + t * ex - x, ay + t * ey - y) > 12) continue;
      if (Math.abs(ex * tx + ey * ty) / (L * tl) < 0.94) continue; // not along it (20°)
      return true;
    }
    return false;
  };
  const SM = THIN_SIGMA, KT = THIN_K, W1 = THIN_FULL, WMAX = THIN_MAX, STEP = 4, CAP = BIG_MOVE;
  const ix = new ShoreIndex(bodies);
  const { grid, X: PX, Y: PY, ring: PR, at: PS, tx: PTX, ty: PTY, ringLen, ringBody: RB, body: PB } = ix;
  const IC = ShoreIndex.CELL;
  // the bank across the water: the nearest facing shore of the same body, on the water's side (the left)
  const partner = (x: number, y: number, tx: number, ty: number, id: number, s: number): [number, number] | null => {
    const cx = Math.floor(x / IC), cy = Math.floor(y / IC), RR = Math.ceil(WMAX / IC);
    const tl = Math.hypot(tx, ty) || 1, body = RB[id];
    let bd = WMAX, bk = -1;
    for (let R = 0; R <= RR; R++) {
      if (R > 0 && (R - 1) * IC >= bd) break;
      for (let dx = -R; dx <= R; dx++) for (let dy = -R; dy <= R; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== R) continue;
        if (!grid.lookup(cx + dx, cy + dy)) continue;
        const arr = grid.arr, hi = grid.hi;
        for (let q = grid.lo; q < hi; q++) {
          const k = arr[q];
          if (PB[k] !== body) continue;
          const ex = PX[k] - x, ey = PY[k] - y, d2 = ex * ex + ey * ey;
          // clearly out of reach, before the exact test
          if (d2 > bd * bd * 1.000001 || d2 < 3.99) continue;
          const d = Math.hypot(ex, ey);
          if (d >= bd || d < 2) continue;
          if (tx * ey - ty * ex <= 0) continue; // not on the water's side
          if (Math.abs(ex * tx + ey * ty) / (d * tl) > 0.7) continue; // along the shore
          if ((PTX[k] * tx + PTY[k] * ty) / tl > -0.3) continue; // not facing
          if (PR[k] === id) { const L = ringLen[id]; let a = Math.abs(PS[k] - s); a = Math.min(a, L - a); if (a <= 2 * d + 16) continue; }
          bd = d;
          bk = k;
        }
      }
    }
    if (bk < 0) return null;
    // onto the bank's own line, between its index points
    let best: [number, number] = [PX[bk], PY[bk]], b2 = bd * bd;
    for (const k2 of [bk - 1, bk + 1]) {
      if (k2 < 0 || k2 >= PX.length || PR[k2] !== PR[bk]) continue;
      const ax = PX[bk], ay = PY[bk], ex = PX[k2] - ax, ey = PY[k2] - ay, L = ex * ex + ey * ey;
      const t = L ? Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / L)) : 0, qx = ax + t * ex, qy = ay + t * ey, dd = (qx - x) ** 2 + (qy - y) ** 2;
      if (dd < b2) { b2 = dd; best = [qx, qy]; }
    }
    return best;
  };
  const target = (d: number) => { const s = Math.min(SM, KT * d); return d <= W1 ? s : d >= WMAX ? 0 : (s * (WMAX - d)) / (WMAX - W1); };
  const mid: [number, number] = [0, 0];
  for (const b of bodies) {
    if (b.canal) continue;
    const s1 = softSigma(b.w);
    b.out = b.out.map((r) => {
      const id = ix.ids.get(r)!;
      const runs = runsOf(r, STEP, cumulative(r), work);
      const outPts: V[] = [];
      let changed = false;
      for (const run of runs) {
        const { xs, ys, ss, closed } = run, m = xs.length;
        if (run.far) changed = true; // it would have been smoothed: the ring is rebuilt, as it would be
        if (run.far || m < 6) { keepRun(run, outPts); continue; }
        // pairs every 4th sample, filled in between where both ends have one
        const QS = 4, cx = new Float64Array(m).fill(NaN), cy = new Float64Array(m).fill(NaN), hh = new Float64Array(m).fill(NaN);
        const qi: number[] = [];
        for (let q = 0; q < m; q += QS) qi.push(q);
        if (qi[qi.length - 1] !== m - 1) qi.push(m - 1);
        for (const q of qi) {
          const [tx, ty] = tangent(run, q);
          const pq = partner(xs[q], ys[q], tx, ty, id, ss[q]);
          if (pq) { cx[q] = (xs[q] + pq[0]) / 2; cy[q] = (ys[q] + pq[1]) / 2; hh[q] = Math.hypot(pq[0] - xs[q], pq[1] - ys[q]) / 2; }
        }
        for (let k = 0; k + 1 < qi.length; k++) {
          const q0 = qi[k], q1 = qi[k + 1];
          if (isNaN(hh[q0]) || isNaN(hh[q1])) continue;
          // the middle between the pairs follows this bank: offset from the bank, filled in
          const o0x = cx[q0] - xs[q0], o0y = cy[q0] - ys[q0], o1x = cx[q1] - xs[q1], o1y = cy[q1] - ys[q1];
          for (let i = q0 + 1; i < q1; i++) { const f = (i - q0) / (q1 - q0); cx[i] = xs[i] + o0x + (o1x - o0x) * f; cy[i] = ys[i] + o0y + (o1y - o0y) * f; hh[i] = hh[q0] + (hh[q1] - hh[q0]) * f; }
        }
        // how far the smoothing reaches at each sample: by the width there, nil at the corners, changing slowly
        const se = new Float64Array(m);
        for (let i = 0; i < m; i++) { if (isNaN(hh[i])) { se[i] = 0; continue; } const t = target(2 * hh[i]); se[i] = Math.sqrt(Math.max(0, t * t - s1 * s1)); }
        if (nRoads) {
          // the share of the shore within 60 m along that runs beside a road: built banks stay
          const on = new Float64Array(m);
          for (let i = 0; i < m; i++) { const [tx, ty] = tangent(run, i); on[i] = onRoad(xs[i], ys[i], tx, ty) ? 1 : 0; }
          const HW = 15; // samples, 60 m
          for (let i = 0; i < m; i++) {
            let sum = 0, c = 0;
            for (let k = -HW; k <= HW; k++) { let j = i + k; if (closed) j = ((j % m) + m) % m; else if (j < 0 || j >= m) continue; sum += on[j]; c++; }
            const share = sum / c, wgt = share >= 0.5 ? 0 : share <= 0.2 ? 1 : (0.5 - share) / 0.3;
            se[i] *= wgt;
          }
        }
        fadeIn(se, m, closed, FADE * STEP);
        // distance along the water's middle (lightly smoothed), the same measure on both banks
        const middle = (j: number) => {
          let x = 0, y = 0, c = 0;
          for (let k = j - 1; k <= j + 1; k++) { const kk = closed ? (k + m) % m : Math.max(0, Math.min(m - 1, k)); if (!isNaN(hh[kk])) { x += cx[kk]; y += cy[kk]; c++; } }
          if (c) { mid[0] = x / c; mid[1] = y / c; } else { mid[0] = cx[j]; mid[1] = cy[j]; }
        };
        const sc = new Float64Array(m);
        for (let i = 1; i < m; i++) {
          const ok = !isNaN(hh[i]) && !isNaN(hh[i - 1]);
          let ax: number, ay: number, bx: number, by: number;
          if (ok) { middle(i - 1); ax = mid[0]; ay = mid[1]; middle(i); bx = mid[0]; by = mid[1]; }
          else { ax = xs[i - 1]; ay = ys[i - 1]; bx = xs[i]; by = ys[i]; }
          sc[i] = sc[i - 1] + Math.max(0.5, Math.hypot(bx - ax, by - ay));
        }
        const total = sc[m - 1] + (closed ? Math.max(0.5, Math.hypot(xs[0] - xs[m - 1], ys[0] - ys[m - 1])) : 0);
        const sm: V[] = [];
        for (let i = 0; i < m; i++) {
          const sg = se[i];
          if (sg < 2 || isNaN(hh[i]) || (!closed && (i === 0 || i === m - 1))) { sm.push({ x: xs[i], y: ys[i], corner: false }); continue; }
          let wx = 0, wy = 0, wh = 0, ws = 0;
          const reach = 3 * sg;
          for (const dir of [-1, 1]) {
            for (let k = dir === -1 ? 0 : 1; ; k++) {
              let j = i + dir * k;
              if (closed) { if (k > m >> 1) break; j = ((j % m) + m) % m; } else if (j < 0 || j >= m) break;
              let dsg = Math.abs(sc[j] - sc[i]);
              if (closed) dsg = Math.min(dsg, total - dsg);
              if (dsg > reach) break;
              if (isNaN(hh[j])) continue;
              const w = Math.exp(-(dsg * dsg) / (2 * sg * sg));
              wx += w * cx[j]; wy += w * cy[j]; wh += w * hh[j]; ws += w;
            }
          }
          const ncx = wx / ws, ncy = wy / ws, nh = wh / ws;
          const ux = (xs[i] - cx[i]) / hh[i], uy = (ys[i] - cy[i]) / hh[i];
          let dx = ncx - cx[i] + (nh - hh[i]) * ux, dy = ncy - cy[i] + (nh - hh[i]) * uy;
          const dl = Math.hypot(dx, dy);
          if (dl > 1e-9) { const f = (CAP * Math.tanh(dl / CAP)) / dl; dx *= f; dy *= f; }
          if (dl > 0.25) changed = true;
          sm.push({ x: xs[i] + dx, y: ys[i] + dy, corner: false });
        }
        settle(sm, run, outPts);
      }
      if (!changed) return r;
      if (!runs[0].closed) outPts.pop();
      return outPts.length >= 3 ? outPts : r;
    });
  }
}

/**
 * m: water is drawn at least about this wide: as wide as the thinnest line (a
 * stream's, 8.4 m), so thin water keeps about its width and meets the lines that
 * run on from it without a bulge.
 */
const MIN_DRAWN = Math.min(WATER_LINE_WEIGHT_DEFAULT, ...Object.values(WATER_LINE_WEIGHTS)) * METERS_PER_WEIGHT;

/**
 * Thin water widened, measured every 4 m along the shore so a long straight bank is
 * widened too: where the water is w wide, each bank moves out by half of
 * ∛(w³ + W³) − w (W = {@link MIN_DRAWN}), smoothed along the shore over about 12 m.
 * Past 1.6 W the change is under a metre, so it is not measured there.
 */
export function widenDense(rs: V[][], work: Box): V[][] {
  const W = MIN_DRAWN, STEP = 4, MAXR = 1.6 * W;
  const ex0: number[] = [], ey0: number[] = [], ex1: number[] = [], ey1: number[] = [];
  for (const r of rs) for (let i = 0; i < r.length; i++) { const a = r[i], b = r[(i + 1) % r.length]; ex0.push(a.x); ey0.push(a.y); ex1.push(b.x); ey1.push(b.y); }
  const C = 20, grid = new Grid(C);
  for (let e = 0; e < ex0.length; e++) grid.addBox(Math.min(ex0[e], ex1[e]), Math.min(ey0[e], ey1[e]), Math.max(ex0[e], ex1[e]), Math.max(ey0[e], ey1[e]), e);
  grid.build();
  // the edges a ray has tried, by the ray's number
  const seen = new Int32Array(ex0.length).fill(-1);
  let rayNo = 0;
  const ray = (px: number, py: number, nx: number, ny: number): number => {
    let best = Infinity;
    const me = rayNo++;
    for (let t = 0; t <= MAXR + C; t += C / 2) {
      const cx = Math.floor((px + nx * t) / C), cy = Math.floor((py + ny * t) / C);
      for (let n = 0; n < 5; n++) {
        if (!grid.lookup(cx + (n === 1 ? 1 : n === 2 ? -1 : 0), cy + (n === 3 ? 1 : n === 4 ? -1 : 0))) continue;
        const arr = grid.arr, hi = grid.hi;
        for (let q = grid.lo; q < hi; q++) {
          const e = arr[q];
          if (seen[e] === me) continue;
          seen[e] = me;
          const tt = rayHit(px, py, nx, ny, ex0[e], ey0[e], ex1[e], ey1[e]);
          if (tt > 0.3 && tt < best) best = tt;
        }
      }
      if (best < t || t > MAXR) break;
    }
    return best > MAXR ? Infinity : best;
  };
  const target = (w: number) => Math.cbrt(w ** 3 + W ** 3);
  return rs.map((r) => {
    const n = r.length;
    // the shore every STEP m: the vertices as they are, points in between; each with its way into the water
    const P: { x: number; y: number; nx: number; ny: number; v: V | null; cos: number; keep?: boolean }[] = [];
    // the vertices on stretches (corner to corner) wholly off the work box
    const offV = farStretches(r, work);
    if (offV.every(Boolean)) return r;
    for (let i = 0; i < n; i++) {
      const v = r[i], p = r[(i - 1 + n) % n], q = r[(i + 1) % n];
      const l1 = Math.hypot(v.x - p.x, v.y - p.y) || 1, l2 = Math.hypot(q.x - v.x, q.y - v.y) || 1;
      const n1x = -(v.y - p.y) / l1, n1y = (v.x - p.x) / l1, n2x = -(q.y - v.y) / l2, n2y = (q.x - v.x) / l2;
      let bx = n1x + n2x, by = n1y + n2y;
      const bl = Math.hypot(bx, by);
      if (bl < 1e-6) { bx = n1x; by = n1y; } else { bx /= bl; by /= bl; }
      const keep = offV[i] && offV[(i + 1) % n];
      P.push({ x: v.x, y: v.y, nx: bx, ny: by, v, cos: Math.max(0.5, bx * n1x + by * n1y), keep });
      const k = Math.floor(l2 / STEP);
      for (let j = 1; j < k; j++) P.push({ x: v.x + ((q.x - v.x) * j) / k, y: v.y + ((q.y - v.y) * j) / k, nx: n2x, ny: n2y, v: null, cos: 1, keep });
    }
    const m = P.length;
    // a ray is skipped only where it can't reach a sample on a stretch near the map (3 samples)
    const skip = P.map((p) => !!p.keep);
    for (let i = 0; i < m; i++) if (!P[i].keep) for (let j = -3; j <= 3; j++) skip[(i + j + m) % m] = false;
    const d0 = P.map((p, i) => { if (skip[i]) return 0; const w = ray(p.x, p.y, p.nx, p.ny); return w === Infinity ? 0 : Math.max(0, target(w) - w) / 2; });
    if (!d0.some((d) => d > 0.25)) return r;
    // smoothed along the shore, about 12 m each way
    const d = d0.map((_, i) => { let s = 0; for (let j = -3; j <= 3; j++) s += d0[(i + j + m) % m]; return Math.min(s / 7, W / 2); });
    const out: V[] = [];
    for (let i = 0; i < m; i++) {
      const p = P[i];
      if (d[i] < 0.25) { if (p.v) out.push(p.v); continue; }
      // outward = into the land, the other way from nx/ny; at a vertex, mitred
      const mul = 1 / p.cos;
      out.push({ x: p.x - p.nx * d[i] * mul, y: p.y - p.ny * d[i] * mul, corner: p.v?.corner ?? false });
    }
    const sr = simplifyRingKeep(out, 0.3);
    return sr.length >= 3 ? sr : r;
  });
}
