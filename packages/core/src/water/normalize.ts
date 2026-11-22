// Step 0 of the generalizer: pieces of one water mapped side by side become one body.
//
// OSM often maps one water as several polygons that share a side: a canal cut at
// every bridge, a pond split where two imports meet. Judged one by one, a short piece
// under a bridge looks too narrow to draw and goes, and the river breaks there; kept
// apart, each piece's shore is smoothed on its own and the seams part. Merged first,
// the generalizer sees the water as it is.
//
// A piece too thin to draw takes no part — its width measured across its banks: from
// its own free shore to the nearest free shore of the pieces it is glued to, a shared
// side being no bank. A bridge's cut is no shore, so the short piece under a bridge
// measures as wide as the river; a ditch split lengthwise still measures as a ditch,
// and is judged (and dropped) on its own, as before. Without this, every polder ditch
// glued to a canal would become part of the canal.

import polygonClipping from "polygon-clipping";
import { M_PER_DEG_LAT as M } from "../bbox";
import type { Geom, WaterFeature } from "../types";
import { Grid, PairMap, rayHit } from "./geom";

type XY = [number, number];

/** A filled water feature: a body. */
type WaterArea = Extract<WaterFeature, { polygon: unknown }>;

/** A body after step 0: as mapped, or merged from pieces ({@link normalize}). */
export type Normalized = WaterArea & { members?: XY[][]; newHoles?: boolean[] };

/** m: rays across a piece reach this far; water wider than this is wide enough whatever else it is. */
const RAY = 120;
/** m: the cells the free shores are indexed by. */
const SG = 25;

/**
 * `polys` with the pieces mapped side by side (sharing a side, vertex to vertex, to
 * 10 cm) merged, the sea apart. `thin(area, width, across)` is the generalizer's own
 * "too thin to draw", given a piece's area and width over its free shore (m², m) and
 * its width across its banks (m, null when that can't be told; worked out only when
 * asked for, as it is the costly part). A merged body carries
 * its pieces' outer rings on the plane (`members`, x = lon·M·k, y = lat·M) and, per
 * hole, whether the merging made it (`newHoles`: land between pieces).
 */
export function normalize(polys: WaterArea[], k: number, thin: (area: number, width: number, across: () => number | null) => boolean): Normalized[] {
  const fw = (g: Geom): XY => [g.lon * M * k, g.lat * M];
  const bw = ([x, y]: XY): Geom => ({ lat: y / M, lon: x / (M * k) });
  const R: XY[][][] = polys.map((f) => [f.polygon.outer, ...(f.polygon.holes ?? [])].map((r) => {
    const v = r.map(fw);
    if (v.length > 1 && v[0][0] === v[v.length - 1][0] && v[0][1] === v[v.length - 1][1]) v.pop();
    return v;
  }));
  // each vertex (to 10 cm) numbered, each side keyed by its two vertices
  let ox = Infinity, oy = Infinity;
  for (const rs of R) for (const v of rs[0] ?? []) { if (v[0] < ox) ox = v[0]; if (v[1] < oy) oy = v[1]; }
  let nv = 0;
  for (const rs of R) for (const r of rs) nv += r.length;
  const vids = new PairMap(nv);
  const key = (p: XY) => Math.round((p[0] - ox) * 10) * 4194304 + Math.round((p[1] - oy) * 10);
  const vid = (p: XY) => {
    const a = Math.round((p[0] - ox) * 10), b = Math.round((p[1] - oy) * 10);
    let id = vids.get(a, b);
    if (id < 0) vids.set(a, b, (id = vids.size));
    return id;
  };
  const ids: Int32Array[][] = R.map((rs) => rs.map((r) => Int32Array.from(r, vid)));
  // which pieces map each side: the first, and every pair glued
  const first = new PairMap(nv), sharedSides = new PairMap(64), pairs: [number, number][] = [];
  ids.forEach((rs, i) => {
    if (polys[i].kind === "ocean") return;
    for (const r of rs) for (let j = 0; j < r.length; j++) {
      const p = r[j], q = r[(j + 1) % r.length], a = Math.min(p, q), b = Math.max(p, q), o = first.get(a, b);
      if (o < 0) first.set(a, b, i);
      else if (o !== i) { sharedSides.set(a, b, 1); pairs.push([o, i]); }
    }
  });
  const shared = (i: number, ri: number, j: number) => { const r = ids[i][ri], p = r[j], q = r[(j + 1) % r.length]; return sharedSides.get(Math.min(p, q), Math.max(p, q)) >= 0; };
  // the glued pieces, by what they are glued into
  const gp = polys.map((_, i) => i);
  const gf = (i: number): number => (gp[i] === i ? i : (gp[i] = gf(gp[i])));
  const glued = new Set<number>();
  for (const [a, b] of pairs) { glued.add(a); glued.add(b); gp[gf(b)] = gf(a); }
  if (!glued.size) return polys;

  // every free side of a glued piece, water on its left, by 25 m cells
  const sides: number[] = [], comp: number[] = [];
  const mine = new Map<number, number[]>();
  const cells = new Grid(SG);
  for (const i of glued) {
    const own: number[] = [];
    mine.set(i, own);
    for (const [ri, r] of R[i].entries()) {
      // outer rings counter-clockwise, holes clockwise
      let a2 = 0;
      for (let j = 0; j < r.length; j++) { const a = r[j], b = r[(j + 1) % r.length]; a2 += a[0] * b[1] - b[0] * a[1]; }
      const flip = (a2 > 0) !== (ri === 0);
      for (let j = 0; j < r.length; j++) {
        let a = r[j], b = r[(j + 1) % r.length];
        if (shared(i, ri, j)) continue;
        if (flip) [a, b] = [b, a];
        const id = comp.length;
        sides.push(a[0], a[1], b[0], b[1]);
        comp.push(gf(i));
        own.push(id);
        cells.addBox(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1]), id);
      }
    }
  }
  cells.build();
  // a piece's width across its banks: rays from its free sides, inward, to the nearest
  // free side of what it is glued into (as stripWidth: the median, if most agree)
  const seen = new Int32Array(comp.length); // the free sides tried already, by the ray that tried them
  let ray = 0;
  const across = (i: number): number | null => {
    const own = mine.get(i)!, c = gf(i);
    let per = 0;
    for (const id of own) per += Math.hypot(sides[4 * id + 2] - sides[4 * id], sides[4 * id + 3] - sides[4 * id + 1]);
    const step = Math.max(2, per / 160), ws: number[] = [];
    for (const e of own) {
      const x0 = sides[4 * e], y0 = sides[4 * e + 1], x1 = sides[4 * e + 2], y1 = sides[4 * e + 3], L = Math.hypot(x1 - x0, y1 - y0);
      if (L < 1e-6) continue;
      const ux = (x1 - x0) / L, uy = (y1 - y0) / L, nx = -uy, ny = ux;
      for (let t = step / 2; t < L; t += step) {
        if (t < 1 || L - t < 1) continue;
        const px = x0 + ux * t, py = y0 + uy * t, qx = px + nx * RAY, qy = py + ny * RAY;
        let best = Infinity;
        ray++;
        for (let X = Math.floor(Math.min(px, qx) / SG); X <= Math.floor(Math.max(px, qx) / SG); X++)
          for (let Y = Math.floor(Math.min(py, qy) / SG); Y <= Math.floor(Math.max(py, qy) / SG); Y++) {
            if (!cells.lookup(X, Y)) continue;
            const arr = cells.arr, hi = cells.hi;
            for (let q = cells.lo; q < hi; q++) {
              const f = arr[q];
              if (f === e || comp[f] !== c || seen[f] === ray) continue;
              seen[f] = ray;
              const tt = rayHit(px, py, nx, ny, sides[4 * f], sides[4 * f + 1], sides[4 * f + 2], sides[4 * f + 3]);
              if (tt > 0.05 && tt < best) best = tt;
            }
          }
        ws.push(best);
      }
    }
    if (ws.length < 8) return null;
    ws.sort((p, q) => p - q);
    const med = ws[ws.length >> 1];
    if (med === Infinity) return RAY;
    return ws.filter((w) => w > med * 0.6 && w < med * 1.6).length / ws.length < 0.7 ? null : med;
  };
  // the pieces too thin to draw: left out of the merging
  const out = new Set<number>();
  for (const i of glued) {
    let A = 0, P = 0;
    for (const [ri, r] of R[i].entries()) {
      let a2 = 0;
      for (let j = 0; j < r.length; j++) {
        const a = r[j], b = r[(j + 1) % r.length];
        a2 += a[0] * b[1] - b[0] * a[1];
        if (!shared(i, ri, j)) P += Math.hypot(b[0] - a[0], b[1] - a[1]);
      }
      A += ri === 0 ? Math.abs(a2 / 2) : -Math.abs(a2 / 2);
    }
    if (thin(A, (2 * A) / Math.max(P, 1), () => across(i))) out.add(i);
  }

  // merge the rest, glued piece to glued piece
  const par = polys.map((_, i) => i);
  const find = (i: number): number => (par[i] === i ? i : (par[i] = find(par[i])));
  for (const [a, b] of pairs) if (!out.has(a) && !out.has(b)) par[find(b)] = find(a);
  const groups = new Map<number, number[]>();
  polys.forEach((_, i) => { const r = find(i), g = groups.get(r); if (g) g.push(i); else groups.set(r, [i]); });
  const res: Normalized[] = [];
  const ring = (r: XY[]) => { const q = r.slice(); if (q.length > 1 && q[0][0] === q[q.length - 1][0] && q[0][1] === q[q.length - 1][1]) q.pop(); return q.map(bw); };
  for (const ps of groups.values()) {
    if (ps.length === 1) { res.push(polys[ps[0]]); continue; }
    let u: XY[][][];
    try {
      u = polygonClipping.union(...(ps.map((i) => R[i].map((r) => [...r, r[0]])) as [XY[][], ...XY[][][]]));
    } catch {
      for (const i of ps) res.push(polys[i]); // degenerate: the pieces stay as they are
      continue;
    }
    const oldHole = new Set<number>();
    for (const i of ps) for (const h of R[i].slice(1)) for (const v of h) oldHole.add(key(v));
    const members = ps.map((i) => R[i][0]);
    for (const poly of u) {
      res.push({
        kind: "area",
        polygon: { outer: ring(poly[0]), ...(poly.length > 1 ? { holes: poly.slice(1).map(ring) } : {}) },
        newHoles: poly.slice(1).map((h) => !h.every((v) => oldHole.has(key(v)))),
        members,
      });
    }
  }
  return res;
}
