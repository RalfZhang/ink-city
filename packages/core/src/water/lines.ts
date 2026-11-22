// The lines smoothed where they run on land.

import { WATER_LINE_ROUND } from "../render";
import { gaussWeights, simplifyKeep, type P, type V } from "./geom";

/** m: the lines are sampled this often. */
export const STEP = 2.5;
/** m: a stretch on land is smoothed by a Gaussian of this sigma… */
const LINE_SIGMA = 60;
/** m: …and no sample moves further than this from where it was mapped. */
const LINE_MOVE = 20;
/** m: beside a drawn road or drawn water, only this light smoothing. */
const LINE_LIGHT_SIGMA = 15;
/** m: where the smoothing would move the line further than {@link LINE_MOVE}, it is bent back over about this. */
const LINE_BEND_SIGMA = 30;
/** m: the switch between the light and the full smoothing is itself smoothed over this. */
const LINE_BLEND_SIGMA = 30;
/** m: two pins on a line closer than this are one. */
const PIN_GAP = 5;
/** m: within this of a joint every sample stays: how far the renderer rounds a vertex over, at most. */
const JOINT_KEEP = WATER_LINE_ROUND;

/** How many samples {@link sampleLine} puts on the side a–b (b left to the next side). */
const samplesOn = (a: P, b: P) => Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / STEP));

/** A point every {@link STEP} m or less along the polyline, its vertices among them. */
export function sampleLine(line: P[]): P[] {
  const smp: P[] = [];
  for (let j = 0; j + 1 < line.length; j++) {
    const [x1, y1] = line[j], [x2, y2] = line[j + 1], k = samplesOn(line[j], line[j + 1]);
    for (let q = 0; q < k; q++) smp.push([x1 + ((x2 - x1) * q) / k, y1 + ((y2 - y1) * q) / k]);
  }
  smp.push(line[line.length - 1]);
  return smp;
}

/** Which of the `m` samples {@link sampleLine} takes of `line` are its vertices. */
export function sampledVertices(line: P[], m: number): Uint8Array {
  const v = new Uint8Array(m);
  for (let i = 0, j = 0; j + 1 < line.length; j++) { v[i] = 1; i += samplesOn(line[j], line[j + 1]); }
  v[m - 1] = 1;
  return v;
}

/**
 * Smooth one channel of a stretch of `m` samples: a Gaussian of sigma `g` (in
 * samples), the stretch mirrored through its two ends; then, where the stretch has
 * pins inside it (`P` beyond its two ends), the smoothing undone at each pin by
 * Gaussian bumps (solved for exactly), so the line still runs through them.
 */
function smoothPinned(g: number, src: Float64Array, P: number[]): Float64Array {
  const m = src.length, K = Math.ceil(3 * g);
  const at = (j: number): number => {
    if (j < 0) return 2 * src[0] - src[Math.min(-j, m - 1)];
    if (j > m - 1) return 2 * src[m - 1] - src[Math.max(2 * (m - 1) - j, 0)];
    return src[j];
  };
  const { w: wk, sum: ws } = gaussWeights(g, K);
  const sm = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    let x = 0;
    if (i - K >= 0 && i + K <= m - 1) for (let d = -K; d <= K; d++) x += src[i + d] * wk[d + K];
    else for (let d = -K; d <= K; d++) x += at(i + d) * wk[d + K];
    sm[i] = x / ws;
  }
  if (P.length > 2) {
    const kern = (i: number, j: number) => Math.exp(-((i - j) ** 2) / (2 * g * g));
    const N = P.length;
    // the bumps' heights: A·c = how far the smoothing moved each pin (Gauss–Jordan, partial pivoting)
    const M = P.map((pi, i) => { const row = P.map((pj) => kern(pi, pj)); row[i] += 1e-9; row.push(sm[pi] - src[pi]); return row; });
    for (let c = 0; c < N; c++) {
      let p = c;
      for (let r = c + 1; r < N; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      [M[c], M[p]] = [M[p], M[c]];
      for (let r = 0; r < N; r++) {
        if (r === c) continue;
        const f = M[r][c] / M[c][c];
        for (let k = c; k <= N; k++) M[r][k] -= f * M[c][k];
      }
    }
    const cc = M.map((r, i) => r[N] / r[i]);
    for (let i = 0; i < m; i++) {
      let dx = 0;
      for (let j = 0; j < N; j++) dx += cc[j] * kern(i, P[j]);
      sm[i] = sm[i] - dx;
    }
  }
  return sm;
}

type LineEnv = {
  /** Drawn water at this point (the 5 m mask of the bodies as drawn). */
  drawnAt: (x: number, y: number) => boolean;
  /** A drawn road runs along here, within 15 m and 30° of (ux, uy). */
  hugAt: (x: number, y: number, ux: number, uy: number) => boolean;
  /** Drawn water within 15 m. */
  wetNear: (x: number, y: number) => boolean;
  /** A stretch in the water as drawn: simplified, its corners marked. */
  toV: (pts: P[]) => V[];
  /** Too far off the map to be worth smoothing: a stretch wholly this far is left as mapped. */
  far: (x: number, y: number) => boolean;
};

/**
 * A line, smoothed where it runs on land. The line is sampled every
 * {@link STEP} m and cut where it enters or leaves drawn water; a stretch in the
 * water is drawn as before ({@link LineEnv.toV}). A stretch on land is smoothed by a
 * Gaussian of {@link LINE_SIGMA}, mirrored through its ends, so a mouth or a line's
 * end stays where it is; where another drawn line ends on it (`pins`), it is pulled
 * back onto that point. Beside a drawn road running along it, or near drawn water,
 * it is only smoothed lightly ({@link LINE_LIGHT_SIGMA}), full smoothing coming back
 * over {@link LINE_SIGMA}; that blend is itself smoothed ({@link LINE_BLEND_SIGMA}).
 * Where the smoothing would move a sample more than {@link LINE_MOVE} from where it
 * was mapped, the smoothed line is bent back sideways by a smooth amount, just
 * enough: what is still too far is spread to the neighbours with a Gaussian falloff
 * of {@link LINE_BEND_SIGMA}, smoothed by the same Gaussian and added, round after
 * round. The push is a sum of smooth terms, so the line stays smooth (its second
 * derivative continuous); below the cap nothing is held back.
 */
export function smoothLine(raw: P[], pins: P[], env: LineEnv, joints: P[] = [], cutAt: (V | null)[] = []): V[] {
  const smp = sampleLine(raw);
  const n = smp.length;
  const nearest = (px: number, py: number) => {
    let bi = -1, bd = Infinity;
    for (let i = 0; i < n; i++) { const d = (smp[i][0] - px) ** 2 + (smp[i][1] - py) ** 2; if (d < bd) { bd = d; bi = i; } }
    return bd < 4 ? bi : -1;
  };
  // the pins, snapped to their nearest sample; of two within PIN_GAP of each other only the
  // first stays (the line still passes about through the other), since bumps pulling the line
  // through both would be solved from all but the same equation twice, and swing it into a loop
  const pinAt = new Set<number>();
  for (const [px, py] of pins) {
    const bi = nearest(px, py);
    if (bi < 0 || [...pinAt].some((j) => Math.abs(j - bi) * STEP < PIN_GAP)) continue;
    smp[bi] = [px, py];
    pinAt.add(bi);
  }
  // the joints' samples: each stays a vertex, handed back in `cutAt` where the line is to be cut
  const jointAt = joints.map(([px, py]) => nearest(px, py));
  cutAt.fill(null);
  const wet = smp.map(([x, y]) => env.drawnAt(x, y));
  // runs: maximal stretches in the water or on land; each starts on the previous one's last sample
  const runs: { a: number; b: number; wet: boolean; far: boolean }[] = [];
  for (let i = 0; i < n;) {
    let e = i, far = env.far(smp[i][0], smp[i][1]);
    while (e + 1 < n && wet[e + 1] === wet[i]) { e++; far &&= env.far(smp[e][0], smp[e][1]); }
    // a stretch on land wholly far off the map is left as mapped
    runs.push({ a: i, b: e, wet: wet[i], far: !wet[i] && far });
    i = e + 1;
  }
  for (let k = 1; k < runs.length; k++) runs[k].a = runs[k - 1].b;
  const out: V[] = [];
  const sig = LINE_SIGMA / STEP, D = LINE_MOVE;
  for (const run of runs) {
    const seg = smp.slice(run.a, run.b + 1);
    let part: V[];
    if (run.far) {
      part = simplifyKeep(seg.map(([x, y], i) => ({ x, y, corner: i === 0 || i === seg.length - 1 })), 1);
    } else if (run.wet || seg.length < 3) {
      part = seg.length >= 2 ? env.toV(seg) : seg.map(([x, y]) => ({ x, y, corner: true }));
    } else {
      const m = seg.length;
      // pins: the run's ends and the junctions in it
      const P = [0, m - 1, ...[...pinAt].filter((i) => i > run.a && i < run.b).map((i) => i - run.a)];
      const sx = Float64Array.from(seg, (p) => p[0]), sy = Float64Array.from(seg, (p) => p[1]);
      const smx = smoothPinned(sig, sx, P), smy = smoothPinned(sig, sy, P);
      // beside a road that runs along it, or near drawn water, only a light smoothing
      const hug = seg.map((p, i) => {
        if (env.wetNear(p[0], p[1])) return true;
        const a = seg[Math.max(0, i - 2)], b = seg[Math.min(m - 1, i + 2)], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        return L > 1e-6 && env.hugAt(p[0], p[1], (b[0] - a[0]) / L, (b[1] - a[1]) / L);
      });
      const dist = new Float64Array(m);
      for (let i = 0; i < m; i++) dist[i] = hug[i] ? 0 : i ? dist[i - 1] + STEP : Infinity;
      for (let i = m - 2; i >= 0; i--) dist[i] = Math.min(dist[i], dist[i + 1] + STEP);
      const free = new Float64Array(m);
      for (let i = 0; i < m; i++) { const t = Math.min(1, dist[i] / LINE_SIGMA); free[i] = t * t * (3 - 2 * t); }
      // the blend itself smoothed, so it has no corner where two road stretches are close
      {
        const gb = LINE_BLEND_SIGMA / STEP, KB = Math.ceil(3 * gb), wb = gaussWeights(gb, KB).w;
        const f0 = Float64Array.from(free);
        for (let i = 0; i < m; i++) {
          let a = 0, ws = 0;
          for (let k = -KB; k <= KB; k++) { const j = Math.min(m - 1, Math.max(0, i + k)); a += f0[j] * wb[k + KB]; ws += wb[k + KB]; }
          free[i] = a / ws;
        }
      }
      if (free.some((f) => f < 1)) {
        const lg = LINE_LIGHT_SIGMA / STEP, lox = smoothPinned(lg, sx, P), loy = smoothPinned(lg, sy, P);
        for (let i = 0; i < m; i++) { smx[i] = lox[i] + (smx[i] - lox[i]) * free[i]; smy[i] = loy[i] + (smy[i] - loy[i]) * free[i]; }
      }
      // bent back where the smoothing moves a sample further than D: pushed along the smoothed line's own normal by kap
      const g = LINE_BEND_SIGMA / STEP;
      const nx = new Float64Array(m), ny = new Float64Array(m), lo = new Float64Array(m), hi = new Float64Array(m);
      let any = false;
      for (let i = 0; i < m; i++) {
        const a = Math.max(0, i - 1), b = Math.min(m - 1, i + 1), L = Math.hypot(smx[b] - smx[a], smy[b] - smy[a]) || 1;
        const tx = (smx[b] - smx[a]) / L, ty = (smy[b] - smy[a]) / L;
        nx[i] = -ty;
        ny[i] = tx;
        const dx = smx[i] - sx[i], dy = smy[i] - sy[i];
        const dn = dx * nx[i] + dy * ny[i], dt = dx * tx + dy * ty, De = D - 0.01, w = Math.sqrt(Math.max(0, De * De - dt * dt));
        // the push kap must lie in [lo, hi] for this sample to stay within D of where it was mapped
        lo[i] = dn - w;
        hi[i] = dn + w;
        if (lo[i] > 0 || hi[i] < 0) any = true;
      }
      let kap = new Float64Array(m);
      if (any) {
        const KW = Math.ceil(3 * g), prof = gaussWeights(g, KW).w;
        // signed spread: each sample takes the neighbour's shortfall that reaches it strongest
        // (either side), so a push one way never cancels a nearby push the other way
        const dil = (r: Float64Array) => {
          const o = new Float64Array(m);
          for (let j = 0; j < m; j++) {
            if (!r[j]) continue;
            for (let k = -KW; k <= KW; k++) {
              const i = j + k;
              if (i < 0 || i >= m) continue;
              const v = r[j] * prof[k + KW];
              if (Math.abs(v) > Math.abs(o[i])) o[i] = v;
            }
          }
          return o;
        };
        for (let it = 0; it < 200; it++) {
          const r = new Float64Array(m);
          let worst = 0;
          for (let i = 0; i < m; i++) { const u = Math.max(0, lo[i] - kap[i]), d = Math.max(0, kap[i] - hi[i]); r[i] = u - d; worst = Math.max(worst, u, d); }
          if (worst < 0.01) break;
          const Dr = dil(r);
          for (const p of P) Dr[p] = 0;
          const s = smoothPinned(g, Dr, P);
          const next = new Float64Array(m);
          for (let i = 0; i < m; i++) next[i] = kap[i] + s[i];
          kap = next;
        }
      }
      part = [];
      for (let i = 0; i < m; i++) part.push({ x: smx[i] - kap[i] * nx[i], y: smy[i] - kap[i] * ny[i], corner: false });
      part[0] = { x: seg[0][0], y: seg[0][1], corner: true };
      part[m - 1] = { x: seg[m - 1][0], y: seg[m - 1][1], corner: true };
      for (const i of P) part[i].corner = true;
      // near a joint, where the line will be cut in two, every sample stays: the two pieces
      // then meet along the curve, where a vertex left far off would show a corner
      if (joints.length) for (const v of part) if (joints.some(([jx, jy]) => Math.hypot(v.x - jx, v.y - jy) < JOINT_KEEP)) v.corner = true;
      jointAt.forEach((ji, k) => { if (ji > run.a && ji < run.b) { const v = part[ji - run.a]; v.corner = true; cutAt[k] = v; } });
      part = simplifyKeep(part, 1);
    }
    if (out.length) { out[out.length - 1].corner = true; part = part.slice(1); }
    out.push(...part);
  }
  return out.length >= 2 ? out : env.toV(raw);
}
