// Step 6 of the generalizer: water standing alone is joined to the water it is
// connected to in the data.
//
// A system is drawn water that touches: a body, the lines in it or on it, the bodies
// they reach. The water not drawn — unnamed lines of any class (unnamed drains and
// ditches come in their own layer, `minorWater`, for this alone), and bodies dropped
// as too thin or too small whose shape is one channel — is a network between them. A
// route is a way through that network from one system to another, and it is drawn
// when the two are still apart, so a route never closes a loop. The best one first:
// the highest grade — a route's grade is its lowest piece's: body > river > canal >
// stream > drain = ditch — then the shortest, at most CAP long. What a route adds is
// part of its system for the next one, so a third system can join it midway.

import type { WaterLineClass } from "../types";
import { boxOf, Grid, Heap, PairMap, pip, type P, type V } from "./geom";
import { Raster } from "./mask";

const GRADE: Record<WaterLineClass, number> = { river: 4, canal: 3, stream: 2, drain: 1, ditch: 1 };
const BODY = 5;
/** m: the longest route. */
const CAP = 2000;
/** m: line nodes at most this far apart. */
const SUB = 5;
/** m: a line's dead end this close to drawn water, or to a body of the network, reaches it. */
const END_R = 20;
/** m: two bodies of the network this close are joined. */
const BODY_GAP = 12;
/** m: the cells bodies and their shores are indexed by. */
const GC = 50;

/** A line of the network, on the generalizer's plane. */
export type NetLine = { cls: WaterLineClass; pts: P[] };
/** A body of the network: a body not kept (its index), and its rings. */
export type NetBody = { i: number; outer: V[]; holes: V[][] };
/** Where the water drawn so far is. */
export type Drawn = {
  /** The system of the nearest drawn cell within `rc` cells, and that cell's centre. */
  near: (x: number, y: number, rc: number) => [number, P] | null;
  /** Whether (x, y) lies in a drawn body (a cell off at most). */
  inFill: (x: number, y: number) => boolean;
  /** The nearest point on a drawn line within `r` m. */
  onLine: (x: number, y: number, r: number) => P | null;
  /** m: the cells `near` counts in. */
  cell: number;
};
/**
 * A stretch of a network line a route runs along: line `line`, from `pa` to `pb`
 * (vertex index plus fraction), and where an end reaches drawn water or a body short
 * of it, the point it carries on to (`extA`, `extB`).
 */
export type Piece = { line: number; pa: number; pb: number; extA: P | null; extB: P | null };
/** The routes: the network bodies they run through (their indices), and the stretches of line. */
export type Routes = { bodies: number[]; pieces: Piece[] };


/** The nearest point of ring `r` to (x, y), and how far it is. */
const nearOn = (r: V[], x: number, y: number): [number, P] => {
  let bd = Infinity, bp: P = [x, y];
  for (let a = 0, b = r.length - 1; a < r.length; b = a++) {
    const ax = r[b].x, ay = r[b].y, dx = r[a].x - ax, dy = r[a].y - ay, L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L)) : 0;
    const px = ax + dx * t, py = ay + dy * t, d = Math.hypot(px - x, py - y);
    if (d < bd) { bd = d; bp = [px, py]; }
  }
  return [bd, bp];
};

/**
 * Whether a body (its area `A` and shore length `Pm`) is one channel (or a pond): its
 * skeleton, on a grid of a fifth of its width, has no branch once spurs shorter than
 * 1.5 widths are pruned. `buf.g` is the grid it works on, kept between calls: all zero
 * but while one runs.
 */
function oneChannel({ outer, holes, A, Pm }: { outer: V[]; holes: V[][]; A: number; Pm: number }, buf: { g: Uint8Array }): boolean {
  if (!(A > 0) || !(Pm > 0)) return false;
  const w = (2 * A) / Pm, c = Math.max(0.75, Math.min(4, w / 5));
  const { x0, y0, x1, y1 } = boxOf(outer);
  const W = Math.ceil((x1 - x0) / c) + 3, H = Math.ceil((y1 - y0) / c) + 3;
  if (W * H > 4e6) return false;
  if (buf.g.length < W * H) buf.g = new Uint8Array(Math.max(W * H, 2 * buf.g.length));
  const g = buf.g;
  // the body's cells (the grid's border, a cell wide, stays empty)
  const cells: number[] = [];
  new Raster(x0 - c, y1 + c, c, W, H).fill([outer, ...holes], (row, a, b) => {
    if (row < 1 || row > H - 2) return;
    for (let x = Math.max(1, a); x <= Math.min(W - 2, b); x++) { g[row * W + x] = 1; cells.push(row * W + x); }
  });
  try {
    return skeletonHasNoBranch(g, W, cells, Math.ceil((1.5 * w) / c));
  } finally {
    for (const i of cells) g[i] = 0;
  }
}

/** Whether the shape set in `g` (`W` wide; its cells `cells`), thinned and its spurs under `spur` cells pruned, has no branch. */
function skeletonHasNoBranch(g: Uint8Array, W: number, cells: number[], spur: number): boolean {
  // the 8 neighbours, clockwise from north
  const off = [-W, -W + 1, 1, W + 1, W, W - 1, -1, -W - 1];
  const p = new Uint8Array(8);
  const look = (i: number) => { let B = 0, tr = 0; for (let q = 0; q < 8; q++) { p[q] = g[i + off[q]]; B += p[q]; } for (let q = 0; q < 8; q++) if (!p[q] && p[(q + 1) & 7]) tr++; return B * 16 + tr; };
  let fg = Int32Array.from(cells);
  const del = new Int32Array(fg.length);
  const keep = () => { let m = 0; for (let q = 0; q < fg.length; q++) if (g[fg[q]]) fg[m++] = fg[q]; fg = fg.subarray(0, m); };
  // Zhang–Suen thinning
  for (let changed = true; changed; ) {
    changed = false;
    for (let step = 0; step < 2; step++) {
      let nd = 0;
      for (let q = 0; q < fg.length; q++) {
        const i = fg[q];
        if (!g[i]) continue;
        const bt = look(i), B = bt >> 4, tr = bt & 15;
        if (B < 2 || B > 6 || tr !== 1) continue;
        if (step === 0 ? p[0] * p[2] * p[4] || p[2] * p[4] * p[6] : p[0] * p[2] * p[6] || p[0] * p[4] * p[6]) continue;
        del[nd++] = i;
      }
      for (let q = 0; q < nd; q++) g[del[q]] = 0;
      if (nd) changed = true;
    }
    keep();
  }
  // spurs pruned end pixel by end pixel; then a branch is a pixel with three ways out
  for (let r = 0; r < spur; r++) {
    let nd = 0;
    for (let q = 0; q < fg.length; q++) if (look(fg[q]) >> 4 <= 1) del[nd++] = fg[q];
    if (!nd) break;
    for (let q = 0; q < nd; q++) g[del[q]] = 0;
    keep();
  }
  for (let q = 0; q < fg.length; q++) if ((look(fg[q]) & 15) >= 3) return false;
  return true;
}

/** The routes joining the separate systems of `drawn` (numbered 1 to `nSys`) through the network. */
export function connect(lines: NetLine[], netBodies: NetBody[], drawn: Drawn, nSys: number): Routes {
  // ── the network: line nodes (shared where ways share a vertex), body nodes, and
  // a source node where it meets a system ──────────────────────────────────────
  const nx: number[] = [], ny: number[] = [], nBody: number[] = [], src: number[] = [];
  let ox = Infinity, oy = Infinity;
  for (const l of lines) for (const p of l.pts) { if (p[0] < ox) ox = p[0]; if (p[1] < oy) oy = p[1]; }
  let nv = 0;
  for (const l of lines) nv += l.pts.length;
  const keyed = new PairMap(nv);
  const node = (x: number, y: number, shared: boolean) => {
    if (shared) {
      const a = Math.round((x - ox) * 10), b = Math.round((y - oy) * 10), o = keyed.get(a, b);
      if (o >= 0) return o;
      keyed.set(a, b, nx.length);
    }
    nx.push(x); ny.push(y); nBody.push(-1);
    return nx.length - 1;
  };
  // edges: its ends, length, grade, its line (-1: none) and stretch, and the bodies it enters (their half lengths are added)
  const ea: number[] = [], eb: number[] = [], elen: number[] = [], egr: number[] = [], eline: number[] = [], epa: number[] = [], epb: number[] = [], eBa: number[] = [], eBb: number[] = [];
  const eExt = new Map<number, [number, P]>(); // edge → the line node off the body, and where it reaches the body
  const edge = (a: number, b: number, len: number, gr: number, line: number, pa: number, pb: number, Ba: number, Bb: number) => {
    ea.push(a); eb.push(b); elen.push(len); egr.push(gr); eline.push(line); epa.push(pa); epb.push(pb); eBa.push(Ba); eBb.push(Bb);
    return ea.length - 1;
  };
  lines.forEach(({ cls, pts }, li) => {
    for (let j = 0; j + 1 < pts.length; j++) {
      const L = Math.hypot(pts[j + 1][0] - pts[j][0], pts[j + 1][1] - pts[j][1]);
      if (L < 1e-6) continue;
      const m = Math.max(1, Math.ceil(L / SUB));
      let prev = node(pts[j][0], pts[j][1], true);
      for (let s = 1; s <= m; s++) {
        const t = s / m;
        const cur = s === m ? node(pts[j + 1][0], pts[j + 1][1], true) : node(pts[j][0] + (pts[j + 1][0] - pts[j][0]) * t, pts[j][1] + (pts[j + 1][1] - pts[j][1]) * t, false);
        edge(prev, cur, L / m, GRADE[cls], li, j + (s - 1) / m, j + t, -1, -1);
        prev = cur;
      }
    }
  });
  const nLine = nx.length;
  const deg = new Int32Array(nLine);
  for (let e = 0; e < ea.length; e++) { deg[ea[e]]++; deg[eb[e]]++; }
  // A line node meets a system in a drawn body, or on a drawn line itself (where the
  // ways share a node) — not merely near one, so a route starts right at a line's end.
  // A dead end near drawn water reaches it: the nearest point of a drawn line, or of a body.
  const srcExt = new Map<number, P>();
  const endCells = Math.round(END_R / drawn.cell);
  for (let u = 0; u < nLine; u++) {
    const x = nx[u], y = ny[u];
    if (drawn.inFill(x, y) || drawn.onLine(x, y, 1)) { const l = drawn.near(x, y, 1); if (l) { src[u] = l[0]; continue; } }
    if (deg[u] !== 1) continue;
    const q = drawn.onLine(x, y, END_R);
    if (q) { const l = drawn.near(q[0], q[1], 1); if (l) { src[u] = l[0]; srcExt.set(u, q); continue; } }
    const f = drawn.near(x, y, endCells);
    if (f) { src[u] = f[0]; srcExt.set(u, f[1]); }
  }
  // the bodies: a node each, worth half its length (its centre line, near enough) on the way in and on the way out
  const bodies = netBodies.map((b) => {
    let A = 0, Pm = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, cx = 0, cy = 0;
    for (const r of [b.outer, ...b.holes]) for (let j = 0; j < r.length; j++) { const p = r[j], q = r[(j + 1) % r.length]; A += p.x * q.y - q.x * p.y; Pm += Math.hypot(q.x - p.x, q.y - p.y); }
    for (const v of b.outer) { x0 = Math.min(x0, v.x); y0 = Math.min(y0, v.y); x1 = Math.max(x1, v.x); y1 = Math.max(y1, v.y); cx += v.x; cy += v.y; }
    A = Math.abs(A) / 2;
    const nd = node(cx / b.outer.length, cy / b.outer.length, false);
    return { ...b, A, Pm, half: Math.max(Math.sqrt(A), Pm / 2 - (2 * A) / Math.max(Pm, 1)) / 2, nd, box: [x0, y0, x1, y1] as const };
  });
  bodies.forEach((b, bi) => { nBody[b.nd] = bi; });
  const bgrid = new Grid(GC);
  bodies.forEach((b, bi) => bgrid.addBox(b.box[0] - END_R, b.box[1] - END_R, b.box[2] + END_R, b.box[3] + END_R, bi));
  bgrid.build();
  // a line node in a body (or on its shore) enters it; a dead end within END_R of one reaches it
  for (let u = 0; u < nLine; u++) {
    const x = nx[u], y = ny[u];
    if (!bgrid.lookup(Math.floor(x / GC), Math.floor(y / GC))) continue;
    const arr = bgrid.arr, hi = bgrid.hi;
    for (let q = bgrid.lo; q < hi; q++) {
      const bi = arr[q], b = bodies[bi];
      if (x < b.box[0] - END_R || x > b.box[2] + END_R || y < b.box[1] - END_R || y > b.box[3] + END_R) continue;
      if (x >= b.box[0] && x <= b.box[2] && y >= b.box[1] && y <= b.box[3] && pip(b.outer, x, y) && !b.holes.some((h) => pip(h, x, y))) { edge(u, b.nd, 0, BODY, -1, 0, 0, -1, bi); continue; }
      if (deg[u] !== 1 && (x < b.box[0] - 2 || x > b.box[2] + 2 || y < b.box[1] - 2 || y > b.box[3] + 2)) continue;
      const [d, p] = nearOn(b.outer, x, y);
      if (d <= 2) edge(u, b.nd, 0, BODY, -1, 0, 0, -1, bi);
      else if (deg[u] === 1 && d <= END_R) eExt.set(edge(u, b.nd, 0, BODY, -1, 0, 0, -1, bi), [u, p]);
    }
  }
  // bodies within BODY_GAP of each other: each vertex against the other's sides nearby
  {
    const sg = new Grid(GC), sb: number[] = [], sa: V[] = [], sc: V[] = [];
    bodies.forEach((b, bi) => {
      const r = b.outer;
      for (let j = 0; j < r.length; j++) {
        const a = r[j], c = r[(j + 1) % r.length];
        sg.addBox(Math.min(a.x, c.x), Math.min(a.y, c.y), Math.max(a.x, c.x), Math.max(a.y, c.y), sb.length);
        sb.push(bi); sa.push(a); sc.push(c);
      }
    });
    sg.build();
    const near = new Set<number>();
    bodies.forEach((b, bi) => {
      for (const v of b.outer) {
        for (let X = Math.floor((v.x - BODY_GAP) / GC); X <= Math.floor((v.x + BODY_GAP) / GC); X++)
          for (let Y = Math.floor((v.y - BODY_GAP) / GC); Y <= Math.floor((v.y + BODY_GAP) / GC); Y++) {
            if (!sg.lookup(X, Y)) continue;
            const arr = sg.arr, hi = sg.hi;
            for (let q = sg.lo; q < hi; q++) {
              const id = arr[q], bj = sb[id], pk = Math.min(bi, bj) * bodies.length + Math.max(bi, bj);
              if (bj === bi || near.has(pk)) continue;
              const a = sa[id], c = sc[id], dx = c.x - a.x, dy = c.y - a.y, L = dx * dx + dy * dy;
              const t = L ? Math.max(0, Math.min(1, ((v.x - a.x) * dx + (v.y - a.y) * dy) / L)) : 0;
              if (Math.hypot(a.x + dx * t - v.x, a.y + dy * t - v.y) <= BODY_GAP) near.add(pk);
            }
          }
      }
    });
    for (const k of near) { const a = Math.floor(k / bodies.length), b = k % bodies.length; edge(bodies[a].nd, bodies[b].nd, 0, BODY, -1, 0, 0, a, b); }
  }
  // a body touching drawn water: a source node for each system it touches
  bodies.forEach((b, bi) => {
    const seen = new Set<number>(), r = b.outer;
    for (let j = 0; j < r.length; j++) {
      const a = r[j], c = r[(j + 1) % r.length], m = Math.max(1, Math.ceil(Math.hypot(c.x - a.x, c.y - a.y) / drawn.cell));
      for (let s = 0; s < m; s++) {
        const l = drawn.near(a.x + ((c.x - a.x) * s) / m, a.y + ((c.y - a.y) * s) / m, 1);
        if (!l || seen.has(l[0])) continue;
        seen.add(l[0]);
        const v = node(a.x, a.y, false);
        src[v] = l[0];
        edge(v, b.nd, 0, BODY, -1, 0, 0, -1, bi);
      }
    }
  });
  const N = nx.length, E = ea.length;
  const adjS = new Int32Array(N + 1);
  for (let e = 0; e < E; e++) { adjS[ea[e] + 1]++; adjS[eb[e] + 1]++; }
  for (let u = 0; u < N; u++) adjS[u + 1] += adjS[u];
  const adj = new Int32Array(2 * E), at = adjS.slice(0, N);
  for (let e = 0; e < E; e++) { adj[at[ea[e]]++] = e; adj[at[eb[e]]++] = e; }

  // ── the search: grade by grade, from the highest; at each, the shortest route
  // between two systems still apart, again and again (Kruskal's, with what a route
  // adds becoming part of its system) ────────────────────────────────────────────
  const par = new Int32Array(nSys + 1).map((_, i) => i);
  const find = (i: number): number => (par[i] === i ? i : (par[i] = find(par[i])));
  // a body is judged by its shape the first time a route could run through it
  const shape = new Int8Array(bodies.length); // 0: not judged yet, 1: one channel, -1: not
  const buf = { g: new Uint8Array(0) }; // the grid that's judged on, freed with this run
  const usable = (bi: number) => {
    if (bi < 0) return true;
    if (!shape[bi]) shape[bi] = oneChannel(bodies[bi], buf) ? 1 : -1;
    return shape[bi] > 0;
  };
  const drawnB = new Uint8Array(bodies.length);
  const wOf = (e: number) => elen[e] + (eBa[e] >= 0 && !drawnB[eBa[e]] ? bodies[eBa[e]].half : 0) + (eBb[e] >= 0 && !drawnB[eBb[e]] ? bodies[eBb[e]].half : 0);
  const isSrc = Int32Array.from({ length: N }, (_, i) => src[i] ?? 0);
  const d = new Float64Array(N), lab = new Int32Array(N), pe = new Int32Array(N);
  const routeEdges: number[][] = [], ends: number[] = [];
  for (let t = BODY; t >= 1; t--) {
    d.fill(Infinity); pe.fill(-1); lab.fill(0);
    const heap = new Heap(), cand = new Heap();
    for (let u = 0; u < N; u++) if (isSrc[u]) { d[u] = 0; lab[u] = isSrc[u]; heap.push(0, u); }
    const relax = () => {
      while (heap.size) {
        const u = heap.pop(), du = heap.top;
        if (du > d[u]) continue;
        for (let q = adjS[u]; q < adjS[u + 1]; q++) {
          const e = adj[q];
          if (egr[e] < t || !usable(eBa[e]) || !usable(eBb[e])) continue;
          const v = ea[e] === u ? eb[e] : ea[e], we = wOf(e), nd = du + we;
          if (nd < d[v] && nd <= CAP) { d[v] = nd; lab[v] = lab[u]; pe[v] = e; heap.push(nd, v); }
          else if (d[v] < Infinity && find(lab[v]) !== find(lab[u]) && nd + d[v] <= CAP) cand.push(nd + d[v], e);
        }
      }
    };
    relax();
    while (cand.size) {
      const e = cand.pop(), val = cand.top, u = ea[e], v = eb[e];
      if (d[u] === Infinity || d[v] === Infinity) continue;
      const ru = find(lab[u]), rv = find(lab[v]);
      if (ru === rv) continue;
      const cur = d[u] + wOf(e) + d[v];
      if (Math.abs(cur - val) > 1e-6 || cur > CAP) continue; // a stale entry
      const es = [e], ns = [u, v];
      for (const s of [u, v]) {
        let x = s;
        while (pe[x] >= 0) { const f = pe[x]; es.push(f); x = ea[f] === x ? eb[f] : ea[f]; ns.push(x); }
        ends.push(x);
      }
      par[ru] = rv;
      for (const x of ns) if (nBody[x] >= 0) drawnB[nBody[x]] = 1;
      for (const x of ns) { isSrc[x] = rv; d[x] = 0; lab[x] = rv; pe[x] = -1; heap.push(0, x); }
      routeEdges.push(es);
      relax();
    }
  }

  // ── what the routes draw: the stretches of line, merged per line ────────────
  const ext = new Map<number, P>();
  for (const x of ends) { const p = srcExt.get(x); if (p) ext.set(x, p); }
  const byLine = new Map<number, [number, number, number, number][]>();
  for (const es of routeEdges) for (const e of es) {
    const x = eExt.get(e);
    if (x) ext.set(x[0], x[1]);
    if (eline[e] < 0) continue;
    const s = byLine.get(eline[e]);
    if (s) s.push([epa[e], epb[e], ea[e], eb[e]]); else byLine.set(eline[e], [[epa[e], epb[e], ea[e], eb[e]]]);
  }
  const pieces: Piece[] = [];
  for (const [line, segs] of byLine) {
    segs.sort((p, q) => p[0] - q[0]);
    let cur: [number, number, number, number] | null = null;
    const flush = () => { if (cur) pieces.push({ line, pa: cur[0], pb: cur[1], extA: ext.get(cur[2]) ?? null, extB: ext.get(cur[3]) ?? null }); };
    for (const s of segs) {
      if (cur && Math.abs(s[0] - cur[1]) < 1e-9) { cur = [cur[0], s[1], cur[2], s[3]]; continue; }
      if (cur && s[0] < cur[1] - 1e-9) { if (s[1] > cur[1]) cur = [cur[0], s[1], cur[2], s[3]]; continue; } // two routes along one stretch
      flush();
      cur = [...s];
    }
    flush();
  }
  return { bodies: bodies.filter((_, bi) => drawnB[bi]).map((b) => b.i), pieces };
}
