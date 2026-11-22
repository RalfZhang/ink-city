// The water layer generalized for the map's scale (about 7.8 m a pixel on a 2560 px
// screen): what is kept, how each shore and line is smoothed, and where built water
// keeps its corners. Worked out in a lab over fourteen rounds against real cities;
// this is the outcome, its numbers as they were settled there.
//
//  0. Merge: pieces of one water mapped side by side (sharing a side) are one body,
//     unless a piece is too thin to draw, measured across its banks (./normalize.ts).
//  1. Keep: a body of at least {@link MIN_AREA}; or a smaller one at least
//     {@link MIN_WIDTH} wide (twice its area over its free shore) that is part of a
//     group that big (bodies touching, or canal pieces joined across a bridge), a
//     chain of such pieces, or a long strip (two parallel banks); or a smaller one
//     that lines drawn whole end in at two points or more (a reservoir on a stream).
//     Not water narrower than {@link NARROW_MIN}, too thin to be drawn.
//  2. Corners: vertices on a seam (two bodies' shared side), on the map's edge, or
//     where a drawn line meets the water stay; so do the square corners of built
//     water (./corners.ts). On built shores, a small step, bump or recess between
//     two straight sides in line goes, unless a road runs onto it.
//  3. Shores: smoothed between their corners by the body's size — more for big
//     water, as far as the local width allows; thin water by its centre line and
//     width, both banks together; canals (narrow, straight-banked) only between
//     their straight sides (./shores.ts); a ring the first smoothing would fold flat
//     stays as mapped. Water too thin to see is widened.
//  4. Land shut in by two or more kept bodies, thinner than {@link NARROW_MIN} and
//     small, is filled, and so is an island under {@link MIN_HOLE}; not one a drawn
//     road runs on.
//  5. Lines: every river, and every canal, stream, drain or ditch with a name, whole;
//     an unnamed canal or stream only where it links two kept bodies, reaching water
//     that is still drawn, or for at most {@link LINK_MAX} where it carries on from a
//     drawn line's loose end to other drawn water, or runs between a drawn line and a
//     body. All are smoothed where they run on land (./lines.ts), a stretch that
//     carries on a line end to end as one line with it.
//  6. Connect: water standing alone is joined to the water the data links it to —
//     through unnamed lines (the unnamed drains and ditches the data keeps for this
//     alone among them, `minor`) and bodies not kept — by the best route of at most
//     2 km that joins two systems still apart (./connect.ts). Its bodies are shaped
//     as in 2–4, its lines drawn whole and smoothed with the lines they carry on;
//     what was drawn before stays exactly as it was.

import polygonClipping from "polygon-clipping";
import { M_PER_DEG_LAT as M } from "../bbox";
import type { Bbox, Geom, WaterFeature, WaterLine, WaterLineClass } from "../types";
import { clipRing } from "./clip";
import { connect, type Drawn, type NetBody, type NetLine } from "./connect";
import { markLineCorners, markShoreCorners, RIGHT_LEG, RIGHT_TOL } from "./corners";
import { area, awayFrom, boxOf, Grid, grow, JOIN_TURN, open, outside, PairMap, pip, pointKey, segDist, simplifyKeep, simplifyRingKeep, stripWidth, strokes, turnAt, type Box, type P, type V } from "./geom";
import { sampledVertices, sampleLine, smoothLine, STEP } from "./lines";
import { Raster } from "./mask";
import { normalize } from "./normalize";
import { smoothBig, smoothSoft, smoothThin, widenDense, type Body } from "./shores";

/** m: one pixel at zoom 10. */
const ZRES10 = 40075016.6855785 / (256 * 2 ** 10);
/** m²: a body this big is kept on its own (about 2.3 ha, one zoom-10 pixel). */
const MIN_AREA = ZRES10 ** 2;
/** m²: a hole (an island) smaller than this is filled, unless a drawn road runs on it. */
const MIN_HOLE = MIN_AREA;
/** m: a smaller body must be at least this wide to be kept. */
const MIN_WIDTH = 10;
/** A strip is at least this many times as long as it is wide… */
const STRIP_LEN = 6;
/** m: …and at least this long. */
const STRIP_MIN = 200;
/** The share of its area a ring must keep through the first smoothing, or it stays as mapped. */
const SOFT_KEEP = 0.5;
/** m: water narrower than this is too thin to draw, and land between two bodies thinner than this is filled. */
const NARROW_MIN = 14;
/** m: narrower than this on average, and mostly straight-banked: a canal or a basin, smoothed only between its straight sides. */
const CANAL_WIDTH = 60;
/** The share of its shore on straight sides a canal has. */
const CANAL_STRAIGHT = 0.5;
/** m: how straight a straight side is (Douglas–Peucker). */
const STRAIGHT_TOL = 1.5;
/** m: the widest gap two canal pieces may have between their ends (a bridge). */
const BRIDGE_GAP = 30;
/** m: no other water this close beside a piece (a field of ponds, not a canal). */
const SIDE_CLEAR = 25;
/** A canal piece is at least this many times as long as it is wide. */
const PIECE_RATIO = 2.5;
/** m: an unnamed line carrying on from a drawn line's loose end, or between a drawn line and a body, is drawn this long at most. */
const LINK_MAX = 1000;
/** m: a link back into the same body is drawn only this long (a bridge, not a detour). */
const LINK_SAME_MAX = 100;
/** m: the shore within this of where a drawn line meets the water stays. */
const PROTECT_R = 20;
/** Cells (5 m): a stroke ending this close to kept water counts as reaching it. */
const END_SNAP = 4;
/** m: lines are simplified at this, then drawn rounded. */
const LINE_TOL = 20;
/** m: two kept bodies whose shores run together this close, the other way round, meet there: a seam. */
const SEAM_SNAP = 2;
/** m: on built shores, a step, bump or recess shallower than this between two straight sides in line goes… */
const BUILT_TRIM = 60;
/** m: …if it is no longer than this. */
const BUILT_LEN = 100;
/** m: the cells of the "is it water" rasters. */
const CELL = 5;
/**
 * m: a stretch of shore or line (between two corners) lying wholly further than this
 * outside the map is left as mapped. No screen shows it, and nothing done to it
 * reaches this far in (the widest smoothing reaches 480 m) — but the data often runs
 * on for tens of kilometres past the map (a river's banks, a lake), and smoothing it
 * all would be most of the work. A stretch reaching nearer is smoothed whole, as it
 * would be anyway, since how it is simplified depends on all of it.
 */
const WORK_MARGIN = 2000;

/** The water as drawn, in metres on the map's plane. */
export type Generalized = {
  /** The bodies' rings: an outer ring counter-clockwise, then its holes clockwise. */
  fills: V[][][];
  /** The lines; a corner is drawn sharp, the rest rounded. */
  lines: { cls: WaterLineClass; pts: V[] }[];
};

/**
 * `water` generalized. `lat0` is the map's centre (the plane is x = lon·cos(lat0),
 * y = lat, in metres); `sq` the map's ground (the square the data was fetched for),
 * which the rasters cover and past which, by {@link WORK_MARGIN}, water is left as
 * mapped; `roadGeoms` every road and path, as a bank's check for a road along it;
 * `drawnRoads` the roads the map draws, which keep a bump they run onto and keep a
 * line beside them from being smoothed away from them; `minor` the unnamed drains and
 * ditches, which only link water (step 6).
 */
export function generalize(water: readonly WaterFeature[], lat0: number, sq: Bbox, roadGeoms: readonly Geom[][], drawnRoads: readonly Geom[][], minor: readonly WaterLine[] = []): Generalized {
  const k = Math.cos((lat0 * Math.PI) / 180);
  const fwd = (g: Geom): V => ({ x: g.lon * M * k, y: g.lat * M, corner: false });
  // too thin to draw, from a body's area and width over its free shore, and its width across its banks if known
  const tooThin = (A: number, w: number, across: () => number | null) => (A < MIN_AREA && w < MIN_WIDTH) || ((w < 60 || A < MIN_AREA) && (across() ?? w) < NARROW_MIN);
  // 0. pieces of one water mapped side by side, one body
  const polys = normalize(water.filter((f) => f.kind !== "line" && f.polygon?.outer) as Extract<WaterFeature, { polygon: unknown }>[], k, tooThin);
  // outer rings counter-clockwise, holes clockwise
  const rings = polys.map((f) =>
    [f.polygon.outer, ...(f.polygon.holes ?? [])].map((r, ri) => {
      const v = open(r.map(fwd));
      return (area(v) > 0) === (ri === 0) ? v : v.reverse();
    }),
  );
  const n = polys.length;

  // ── shared vertices, seams ─────────────────────────────────────────────────
  let ox = Infinity, oy = Infinity;
  for (const rs of rings) for (const v of rs[0]) { if (v.x < ox) ox = v.x; if (v.y < oy) oy = v.y; }
  let nv = 0;
  for (const rs of rings) for (const r of rs) nv += r.length;
  // each distinct vertex (to 10 cm), numbered; every ring's vertices by number
  const vid = new PairMap(nv);
  const idsOf = new Map<V[], Int32Array>();
  for (const rs of rings) for (const r of rs) {
    const ids = new Int32Array(r.length);
    for (let j = 0; j < r.length; j++) {
      const a = Math.round((r[j].x - ox) * 10), b = Math.round((r[j].y - oy) * 10);
      let id = vid.get(a, b);
      if (id < 0) { id = vid.size; vid.set(a, b, id); }
      ids[j] = id;
    }
    idsOf.set(r, ids);
  }
  const uses = new Int32Array(vid.size), owner = new Int32Array(vid.size).fill(-2); // owner: the body, -1 if several
  const seen = new Int32Array(vid.size).fill(-1);
  let ringNo = 0;
  rings.forEach((rs, i) => {
    for (const r of rs) {
      const ids = idsOf.get(r)!, me = ringNo++;
      for (let j = 0; j < ids.length; j++) {
        const id = ids[j];
        if (seen[id] === me) continue;
        seen[id] = me;
        uses[id]++;
        const ow = owner[id];
        if (ow === -2) owner[id] = i;
        else if (ow !== i) owner[id] = -1;
      }
    }
  });
  // how many times each side runs from one vertex to the next
  const edges = new PairMap(nv);
  for (const r of idsOf.values()) for (let j = 0; j < r.length; j++) { const a = r[j], b = r[(j + 1) % r.length], c = edges.get(a, b); edges.set(a, b, c < 0 ? 1 : c + 1); }
  const sides = (a: number, b: number) => Math.max(0, edges.get(a, b));

  // ── the ground the data covers, for the rasters and the map's edge ────────
  const sw = fwd({ lat: sq.south, lon: sq.west }), ne = fwd({ lat: sq.north, lon: sq.east });
  const bx0 = sw.x, by0 = sw.y, bx1 = ne.x, by1 = ne.y;
  const work: Box = grow({ x0: bx0, y0: by0, x1: bx1, y1: by1 }, WORK_MARGIN);
  // The sea is cut to that square (in CI, its coordinates then rounded to about a
  // metre): a vertex on the sea's extent is on the map's edge — on each side where
  // that extent lies along the square, not one the sea stops short of in the map.
  let sx0 = Infinity, sx1 = -Infinity, sy0 = Infinity, sy1 = -Infinity;
  polys.forEach((f, i) => {
    if (f.kind === "ocean") for (const v of rings[i][0]) { sx0 = Math.min(sx0, v.x); sx1 = Math.max(sx1, v.x); sy0 = Math.min(sy0, v.y); sy1 = Math.max(sy1, v.y); }
  });
  const along = (s: number, b: number) => (Math.abs(s - b) < 1 ? s : NaN); // NaN: no vertex is on it
  const ex0 = along(sx0, bx0), ex1 = along(sx1, bx1), ey0 = along(sy0, by0), ey1 = along(sy1, by1);
  const onEdge = (v: V) => Math.abs(v.x - ex0) < 0.5 || Math.abs(v.x - ex1) < 0.5 || Math.abs(v.y - ey0) < 0.5 || Math.abs(v.y - ey1) < 0.5;
  const nearSeam = new PairMap(); // (body, vertex) on a seam not glued vertex to vertex (filled in once the kept bodies are known)
  // a vertex of body `body` that stays: on the map's edge, on a seam, or where shared shores part
  const hardAt = (r: V[], ids: Int32Array, j: number, body: number) => {
    const v = r[j];
    if (onEdge(v)) return true;
    const id = ids[j];
    if (nearSeam.size && nearSeam.get(body, id) >= 0) return true;
    if (uses[id] <= 1) return false;
    const p = ids[(j - 1 + r.length) % r.length], q = ids[(j + 1) % r.length];
    if (sides(id, p) > 0 || sides(q, id) > 0) return true;
    return !(sides(p, id) > 1 && sides(id, q) > 1);
  };

  // ── per-body measures ──────────────────────────────────────────────────────
  // the shore not shared with another body
  const freePerimeter = (r: V[]) => {
    const ids = idsOf.get(r)!;
    let s = 0;
    for (let a = 0, b = r.length - 1; a < r.length; b = a++) {
      if (owner[ids[a]] === -1 && owner[ids[b]] === -1) continue;
      s += Math.hypot(r[a].x - r[b].x, r[a].y - r[b].y);
    }
    return s;
  };
  const netArea: number[] = [], width: number[] = [];
  polys.forEach((f, i) => {
    let a = 0, p = 0;
    for (const r of rings[i]) { a += area(r); p += freePerimeter(r); }
    netArea[i] = f.kind === "ocean" ? Infinity : a;
    width[i] = f.kind === "ocean" ? Infinity : (2 * a) / Math.max(p, 1);
  });
  const strips = new Map<number, ReturnType<typeof stripWidth>>();
  const stripOf = (i: number) => {
    if (!strips.has(i)) strips.set(i, stripWidth(rings[i]));
    return strips.get(i)!;
  };

  // ── groups: bodies touching (2 m) ──────────────────────────────────────────
  const parent = polys.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a: number, b: number) => { parent[find(a)] = find(b); };
  {
    // the first body with an outer vertex in each 2 m cell; every other one there joins it
    const C2 = 2, first = new PairMap(nv);
    rings.forEach((rs, i) => {
      for (const v of rs[0]) {
        const cx = Math.floor(v.x / C2), cy = Math.floor(v.y / C2), f = first.get(cx, cy);
        if (f < 0) first.set(cx, cy, i);
        else if (f !== i) union(i, f);
      }
    });
    // and bodies in neighbouring cells join
    const join = (cx: number, cy: number, f: number) => { const other = first.get(cx, cy); if (other >= 0) union(other, f); };
    first.forEach((cx, cy, f) => { join(cx + 1, cy, f); join(cx, cy + 1, f); join(cx + 1, cy + 1, f); join(cx + 1, cy - 1, f); });
  }

  // ── canal pieces joined end to end across a bridge ────────────────────────
  // every side of every ring by 25 m cells, for "how far is the nearest other water"
  // and for seams — all but the sea's sides along the map's edge, which are no shore
  const EC = 25;
  const egrid = new Grid(EC);
  const eBody: number[] = [], eA: V[] = [], eB: V[] = [];
  const onOneEdge = (a: V, b: V) =>
    (Math.abs(a.x - ex0) < 0.5 && Math.abs(b.x - ex0) < 0.5) || (Math.abs(a.x - ex1) < 0.5 && Math.abs(b.x - ex1) < 0.5) ||
    (Math.abs(a.y - ey0) < 0.5 && Math.abs(b.y - ey0) < 0.5) || (Math.abs(a.y - ey1) < 0.5 && Math.abs(b.y - ey1) < 0.5);
  rings.forEach((rs, i) => {
    const sea = polys[i].kind === "ocean";
    for (const r of rs) for (let j = 0; j < r.length; j++) {
      const a = r[j], b = r[(j + 1) % r.length];
      if (sea && onOneEdge(a, b)) continue;
      const x0 = Math.floor(Math.min(a.x, b.x) / EC), x1 = Math.floor(Math.max(a.x, b.x) / EC);
      const y0 = Math.floor(Math.min(a.y, b.y) / EC), y1 = Math.floor(Math.max(a.y, b.y) / EC);
      const e = eBody.length;
      eBody.push(i); eA.push(a); eB.push(b);
      // a long side, slanting, would fill its box with cells it never comes near (a 45° one
      // of 700 m, 400 of them): entered only in those it passes through — every cell whose
      // centre is within half a diagonal of it
      const long = (x1 - x0 + 1) * (y1 - y0 + 1) > 400;
      for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
        if (long && segDist({ x: (cx + 0.5) * EC, y: (cy + 0.5) * EC }, a, b) > EC * Math.SQRT1_2) continue;
        egrid.add(cx, cy, e);
      }
    }
  });
  egrid.build();
  const nearest = (px: number, py: number, r: number, not: number): { d: number; body: number; x: number; y: number } => {
    let best = { d: Infinity, body: -1, x: 0, y: 0 };
    const c0x = Math.floor((px - r) / EC), c1x = Math.floor((px + r) / EC), c0y = Math.floor((py - r) / EC), c1y = Math.floor((py + r) / EC);
    for (let cx = c0x; cx <= c1x; cx++) for (let cy = c0y; cy <= c1y; cy++) {
      if (!egrid.lookup(cx, cy)) continue;
      const arr = egrid.arr, hi = egrid.hi;
      for (let q = egrid.lo; q < hi; q++) {
        const e = arr[q], i = eBody[e];
        if (i === not) continue;
        const a = eA[e], b = eB[e];
        const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy;
        const t = L ? Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / L)) : 0;
        const qx = a.x + t * dx, qy = a.y + t * dy, d = Math.hypot(px - qx, py - qy);
        if (d < best.d) best = { d, body: i, x: qx, y: qy };
      }
    }
    return best;
  };
  const pieceLen: number[] = new Array(n).fill(0);
  const isPiece: boolean[] = new Array(n).fill(false);
  const ends: { i: number; ccx: number; ccy: number; ux: number; uy: number; nx: number; ny: number; L: number; W: number }[] = [];
  // a small canal-like body (narrow, long, two parallel and mostly straight banks) with
  // nothing beside it is judged with what it leads into
  polys.forEach((f, i) => {
    if (f.kind === "ocean" || width[i] < MIN_WIDTH || width[i] >= CANAL_WIDTH || netArea[i] >= MIN_AREA) return;
    const r = rings[i][0];
    let cx = 0, cy = 0;
    for (const v of r) { cx += v.x; cy += v.y; }
    cx /= r.length; cy /= r.length;
    let sxx = 0, syy = 0, sxy = 0;
    for (const v of r) { const dx = v.x - cx, dy = v.y - cy; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
    const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const ux = Math.cos(th), uy = Math.sin(th), nx = -uy, ny = ux;
    let lo = Infinity, hi = -Infinity;
    for (const v of r) { const t = (v.x - cx) * ux + (v.y - cy) * uy; if (t < lo) lo = t; if (t > hi) hi = t; }
    const L = hi - lo, W = width[i];
    if (L < PIECE_RATIO * W) return;
    if (r.length > 400) return; // a long winding canal: its ends are not found this way
    const mid = (lo + hi) / 2;
    const ccx = cx + mid * ux, ccy = cy + mid * uy;
    if (!stripOf(i)) return; // two parallel banks, not a pond
    if (straightShare([simplifyRingKeep(r, STRAIGHT_TOL)]) < CANAL_STRAIGHT) return;
    for (const t of [-L / 4, 0, L / 4]) for (const sd of [-1, 1]) {
      const px = ccx + t * ux + sd * (W / 2) * nx, py = ccy + t * uy + sd * (W / 2) * ny;
      if (nearest(px, py, SIDE_CLEAR + W, i).d < SIDE_CLEAR) return;
    }
    isPiece[i] = true;
    pieceLen[i] = L;
    ends.push({ i, ccx, ccy, ux, uy, nx, ny, L, W });
  });
  // link the pieces: across the bridge there must be a waterway about as wide
  for (const { i, ccx, ccy, ux, uy, nx, ny, L, W } of ends) {
    for (const s of [-1, 1]) {
      const ex = ccx + s * (L / 2 - W / 2) * ux, ey = ccy + s * (L / 2 - W / 2) * uy;
      const hit = nearest(ex, ey, BRIDGE_GAP + W, i);
      if (hit.body < 0 || hit.d > BRIDGE_GAP + W / 2) continue;
      const ax = (hit.x - ex) * ux * s + (hit.y - ey) * uy * s; // ahead
      const sd = Math.abs((hit.x - ex) * nx + (hit.y - ey) * ny); // sideways
      if (ax <= 0 || sd > W) continue;
      // over the bridge: a waterway about as wide, not a lake or the sea
      const px = hit.x + s * W * ux, py = hit.y + s * W * uy;
      if (nearest(px, py, W, i).d > 0.8 * W) continue;
      union(i, hit.body);
    }
  }
  const gArea = new Map<number, number>(), gLen = new Map<number, number>(), gW = new Map<number, number[]>();
  polys.forEach((f, i) => {
    const g = find(i);
    gArea.set(g, (gArea.get(g) ?? 0) + (f.kind === "ocean" ? Infinity : Math.max(netArea[i], 0)));
    if (isPiece[i]) { gLen.set(g, (gLen.get(g) ?? 0) + pieceLen[i]); (gW.get(g) ?? gW.set(g, []).get(g)!).push(width[i]); }
  });
  // the median width of each group's canal pieces
  const gMid = new Map<number, number>();
  for (const [g, ws] of gW) gMid.set(g, ws.sort((a, b) => a - b)[ws.length >> 1]);

  // ── which bodies are kept ──────────────────────────────────────────────────
  // too thin to be drawn: small and narrow (dropped whatever its width across, so it isn't measured), or narrower than NARROW_MIN
  const thin = polys.map((f, i) => f.kind !== "ocean" && tooThin(netArea[i], width[i], () => stripOf(i)?.width ?? null));
  const kept: boolean[] = polys.map((f, i) => {
    if (f.kind === "ocean") return true;
    if (thin[i]) return false;
    if (netArea[i] >= MIN_AREA) return true;
    // smaller, yet wide enough: kept in a group that big, a chain of canal pieces, or as a strip
    const g = find(i);
    if ((gArea.get(g) ?? 0) >= MIN_AREA) return true;
    const len = gLen.get(g) ?? 0, wm = gMid.get(g) ?? 0;
    if (isPiece[i] && len >= STRIP_LEN * wm && len >= STRIP_MIN) return true;
    const s = stripOf(i);
    if (!s || s.width < MIN_WIDTH || s.len < STRIP_LEN * s.width || s.len < STRIP_MIN) return false;
    return true;
  });
  // A small body (not a thin one) that lines drawn whole (rivers, named lines) end in at two
  // points or more (within 20 m of it) — a reservoir on a stream — is kept: without it they
  // would break off there.
  {
    const R = END_SNAP * CELL, EG = 50, eg = new Grid(EG), lineEnds: P[] = [];
    for (const f of water) {
      if (f.kind !== "line" || f.line.length < 2 || !(f.cls === "river" || f.named)) continue;
      for (const g of [f.line[0], f.line[f.line.length - 1]]) { const v = fwd(g); eg.add(Math.floor(v.x / EG), Math.floor(v.y / EG), lineEnds.length); lineEnds.push([v.x, v.y]); }
    }
    eg.build();
    polys.forEach((f, i) => {
      if (kept[i] || thin[i] || f.kind === "ocean") return;
      const r = rings[i][0], { x0, y0, x1, y1 } = boxOf(r);
      const places: P[] = [];
      for (let cx = Math.floor((x0 - R) / EG); cx <= Math.floor((x1 + R) / EG); cx++) for (let cy = Math.floor((y0 - R) / EG); cy <= Math.floor((y1 + R) / EG); cy++) {
        if (!eg.lookup(cx, cy)) continue;
        for (let q = eg.lo; q < eg.hi; q++) {
          const p = lineEnds[eg.arr[q]];
          if (places.some((o) => Math.hypot(o[0] - p[0], o[1] - p[1]) < 1)) continue; // the same point: one line's ways meeting there
          let near = pip(r, p[0], p[1]);
          for (let a = 0, b = r.length - 1; !near && a < r.length; b = a++) near = segDist({ x: p[0], y: p[1] }, r[b], r[a]) <= R;
          if (near) places.push(p);
        }
      }
      if (places.length >= 2) kept[i] = true;
    });
  }

  // ── seams not glued vertex to vertex ─────────────────────────────────────
  // Two kept bodies often meet along a side they both map, the other way round (a
  // seam), without sharing its vertices exactly: one end is a metre off. A run of
  // sides whose ends all lie within SEAM_SNAP of another kept body's side running the
  // other way, at least NARROW_MIN long, is a seam all the same: its vertices stay.
  const dSeg = (x: number, y: number, a: V, c: V) => {
    const ex = c.x - a.x, ey = c.y - a.y, L = ex * ex + ey * ey;
    const t = L ? Math.max(0, Math.min(1, ((x - a.x) * ex + (y - a.y) * ey) / L)) : 0;
    return Math.hypot(a.x + t * ex - x, a.y + t * ey - y);
  };
  // body i's vertices on such a seam with a body `partner` accepts
  const seamsOf = (i: number, partner: (b: number) => boolean) => {
    const SN = SEAM_SNAP;
    for (const r of rings[i]) {
      const nr = r.length, ids = idsOf.get(r)!;
      const hit = new Uint8Array(nr);
      for (let j = 0; j < nr; j++) {
        const v = r[j], q = r[(j + 1) % nr], ex = q.x - v.x, ey = q.y - v.y, l = Math.hypot(ex, ey);
        if (l < 1e-6) continue;
        for (let cx = Math.floor((Math.min(v.x, q.x) - SN) / EC); cx <= Math.floor((Math.max(v.x, q.x) + SN) / EC) && !hit[j]; cx++) {
          for (let cy = Math.floor((Math.min(v.y, q.y) - SN) / EC); cy <= Math.floor((Math.max(v.y, q.y) + SN) / EC) && !hit[j]; cy++) {
            if (!egrid.lookup(cx, cy)) continue;
            const arr = egrid.arr, hi = egrid.hi;
            for (let qe = egrid.lo; qe < hi; qe++) {
              const e = arr[qe], b = eBody[e];
              if (b === i || !partner(b)) continue;
              const a = eA[e], c = eB[e];
              const fx = c.x - a.x, fy = c.y - a.y, mm = Math.hypot(fx, fy);
              if (mm < 1e-6 || (ex * fx + ey * fy) / (l * mm) > -0.9) continue; // the other way round, within 25°
              // the shorter side lies along the longer one, both its ends within SEAM_SNAP
              const [s0, s1, t0, t1] = l <= mm ? [v, q, a, c] : [a, c, v, q];
              if (dSeg(s0.x, s0.y, t0, t1) > SN || dSeg(s1.x, s1.y, t0, t1) > SN) continue;
              hit[j] = 1;
              break;
            }
          }
        }
      }
      // runs of such sides, as long as drawn water is wide at least; a run glued vertex to vertex is a seam already
      if (!hit.some(Boolean)) continue;
      const start = hit.every(Boolean) ? 0 : hit.findIndex((h, j) => h > 0 && !hit[(j - 1 + nr) % nr]);
      for (let kk = 0, j = start; kk < nr; ) {
        if (!hit[j]) { j = (j + 1) % nr; kk++; continue; }
        const run: number[] = [];
        while (hit[j] && kk < nr) { run.push(j); j = (j + 1) % nr; kk++; }
        let len = 0, glued = true;
        for (const e of run) {
          const a = r[e], c = r[(e + 1) % nr];
          len += Math.hypot(c.x - a.x, c.y - a.y);
          if (sides(ids[(e + 1) % nr], ids[e]) === 0) glued = false;
        }
        if (len < NARROW_MIN || glued) continue;
        for (const e of run) { nearSeam.set(i, ids[e], 1); nearSeam.set(i, ids[(e + 1) % nr], 1); }
      }
    }
  };
  polys.forEach((_, i) => { if (kept[i]) seamsOf(i, (b) => kept[b]); });

  // ── lines, first pass: where they meet the kept water as mapped ───────────
  // a raster of the kept bodies as mapped, each cell holding its body's index + 1
  const MW = Math.ceil((bx1 - bx0) / CELL) + 2, MH = Math.ceil((by1 - by0) / CELL) + 2;
  const raster = new Raster(bx0, by1, CELL, MW, MH);
  let od: Uint16Array | Uint32Array | null = n < 65535 ? new Uint16Array(MW * MH) : new Uint32Array(MW * MH);
  for (let i = 0; i < n; i++) {
    if (!kept[i]) continue;
    const id = i + 1, cells = od;
    raster.fill(rings[i], (row, c0, c1) => cells.fill(id, row * MW + c0, row * MW + c1 + 1));
  }
  const bodyAt = (x: number, y: number) => { const q = raster.index(x, y); return q < 0 ? 0 : od![q]; };
  type Cand = { cls: WaterLineClass; st: P[]; smp: P[]; body: number[]; whole: boolean; runs: [number, number][] };
  const cands: Cand[] = [];
  const snapped = new Set<P>();
  // points by 25 m cells, and whether a shore vertex lies within PROTECT_R of one
  const CC = 25;
  const pointsNear = () => {
    const grid = new Grid(CC), at: P[] = [];
    return {
      add: (p: P) => { grid.add(Math.floor(p[0] / CC), Math.floor(p[1] / CC), at.length); at.push(p); },
      build: () => { grid.build(); },
      near: (v: V) => {
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
          if (!grid.lookup(Math.floor((v.x + dx * CC) / CC), Math.floor((v.y + dy * CC) / CC))) continue;
          const arr = grid.arr, hi = grid.hi;
          for (let q = grid.lo; q < hi; q++) { const [x, y] = at[arr[q]]; if (Math.hypot(x - v.x, y - v.y) <= PROTECT_R) return true; }
        }
        return false;
      },
    };
  };
  // where the drawn lines meet the water
  const contacts = pointsNear();
  // whether two points of body b lie in one piece of those it was merged from (step 0; the nearest to each)
  const samePiece = (b: number, p: P, q: P) => {
    const mem = polys[b].members;
    if (!mem) return true;
    const which = (pt: P) => {
      let best = -1, bd = Infinity;
      mem.forEach((r, mi) => {
        let ins = false, d = Infinity;
        for (let a = 0, c = r.length - 1; a < r.length; c = a++) {
          if ((r[a][1] > pt[1]) !== (r[c][1] > pt[1]) && pt[0] < ((r[c][0] - r[a][0]) * (pt[1] - r[a][1])) / (r[c][1] - r[a][1]) + r[a][0]) ins = !ins;
          d = Math.min(d, segDist({ x: pt[0], y: pt[1] }, { x: r[c][0], y: r[c][1] }, { x: r[a][0], y: r[a][1] }));
        }
        if (ins) d = 0;
        if (d < bd) { bd = d; best = mi; }
      });
      return best;
    };
    return which(p) === which(q);
  };
  // the stretches of a stroke between two kept bodies (a gap of a sample or two is a
  // seam between touching bodies, not a link)
  const linkRuns = (smp: P[], body: number[]) => {
    const runs: [number, number][] = [];
    for (let j = 0; j < smp.length;) {
      if (body[j]) { j++; continue; }
      let e = j;
      while (e < smp.length && !body[e]) e++;
      if (j > 0 && e < smp.length && (e - j) * STEP > 5 && (body[j - 1] !== body[e] || (e - j) * STEP <= LINK_SAME_MAX || !samePiece(body[e] - 1, smp[j - 1], smp[e]))) runs.push([j, e]);
      j = e;
    }
    return runs;
  };
  const lineWays = water.filter((f) => f.kind === "line") as WaterLine[];
  // drawn whole: every river, and any other line with a name; an unnamed canal or
  // stream only where it links two kept bodies, an unnamed drain or ditch not at all.
  // Named and unnamed ways are joined apart, so one stroke is all one or the other.
  const groups: { cls: WaterLineClass; whole: boolean; ways: typeof lineWays }[] = [];
  for (const cls of ["river", "canal", "stream", "drain", "ditch"] as const) {
    const of = lineWays.filter((f) => f.cls === cls);
    if (cls === "river") { groups.push({ cls, whole: true, ways: of }); continue; }
    groups.push({ cls, whole: true, ways: of.filter((f) => f.named) });
    if (cls === "canal" || cls === "stream") groups.push({ cls, whole: false, ways: of.filter((f) => !f.named) });
  }
  for (const { cls, whole, ways } of groups) {
    for (const st of strokes(ways.map((f) => f.line.map((g) => { const v = fwd(g); return [v.x, v.y] as P; })))) {
      const smp = sampleLine(st);
      const body = smp.map(([x, y]) => bodyAt(x, y));
      // an end this close to kept water reaches it
      for (const q of [0, smp.length - 1]) {
        if (body[q]) continue;
        const [x, y] = smp[q], cx = Math.floor((x - bx0) / CELL), cy = Math.floor((by1 - y) / CELL);
        let bd = Infinity;
        for (let dy = -END_SNAP; dy <= END_SNAP; dy++) for (let dx = -END_SNAP; dx <= END_SNAP; dx++) {
          const X = cx + dx, Y = cy + dy, d = dx * dx + dy * dy;
          if (X < 0 || Y < 0 || X >= MW || Y >= MH || d > END_SNAP * END_SNAP || d >= bd) continue;
          const id = od[Y * MW + X];
          if (id) { bd = d; body[q] = id; }
        }
        if (body[q]) snapped.add(smp[q]);
      }
      const runs = whole ? [] : linkRuns(smp, body);
      cands.push({ cls, st, smp, body, whole, runs });
      if (whole) { for (let kq = 1; kq < smp.length; kq++) if (!body[kq] !== !body[kq - 1]) contacts.add(smp[body[kq] ? kq : kq - 1]); }
      else for (const [j, e] of runs) { contacts.add(smp[j - 1]); contacts.add(smp[e]); }
    }
  }
  od = null;
  contacts.build();

  // ── shores ─────────────────────────────────────────────────────────────────
  // a ring of body `body` (`w` wide) with its corners marked: fixed by the data (seams, the edge, a line's mouth), or square
  const prep = (r: V[], body: number, w: number, mouth: (v: V) => boolean): V[] => {
    const ids = idsOf.get(r)!;
    r = r.map((v, j) => { const h = hardAt(r, ids, j, body); return { x: v.x, y: v.y, corner: h, fixed: h }; });
    r = simplifyRingKeep(r, STRAIGHT_TOL);
    markShoreCorners(r, w);
    for (const v of r) if (!v.corner && mouth(v)) v.corner = true;
    return r;
  };
  // the roads the map draws, by 50 m cells: a bump that a road runs onto (a jetty, a
  // turning loop) stays, and a line a road runs along is smoothed only lightly
  const drawnSegs = segments(drawnRoads, k);
  const RGC = 50, rgrid = new Grid(RGC);
  for (let e = 0; 4 * e < drawnSegs.length; e++) {
    const ax = drawnSegs[4 * e], ay = drawnSegs[4 * e + 1], bx = drawnSegs[4 * e + 2], by = drawnSegs[4 * e + 3];
    rgrid.addBox(Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by), e);
  }
  rgrid.build();
  const inPoly = (pl: V[], x: number, y: number) => {
    let ins = false;
    for (let i = 0, j = pl.length - 1; i < pl.length; j = i++) { const a = pl[j], b = pl[i]; if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) ins = !ins; }
    return ins;
  };
  // a drawn road on the island or bump `pl` (a point of one inside it, every 3 m along) —
  // with `bank`, the side the bump stands on, not one along that side's line (a bank road)
  const roadIn = (pl: V[], bank?: { A: V; B: V }) => {
    const { x0, y0, x1, y1 } = boxOf(pl);
    const ex = bank ? bank.B.x - bank.A.x : 0, ey = bank ? bank.B.y - bank.A.y : 0, L = Math.hypot(ex, ey) || 1;
    for (let cx = Math.floor(x0 / RGC); cx <= Math.floor(x1 / RGC); cx++) for (let cy = Math.floor(y0 / RGC); cy <= Math.floor(y1 / RGC); cy++) {
      if (!rgrid.lookup(cx, cy)) continue;
      const arr = rgrid.arr, hi = rgrid.hi;
      for (let qs = rgrid.lo; qs < hi; qs++) {
        const e = arr[qs], s0 = drawnSegs[4 * e], s1 = drawnSegs[4 * e + 1], s2 = drawnSegs[4 * e + 2], s3 = drawnSegs[4 * e + 3];
        const kq = Math.max(1, Math.ceil(Math.hypot(s2 - s0, s3 - s1) / 3));
        for (let q = 0; q <= kq; q++) {
          const x = s0 + ((s2 - s0) * q) / kq, y = s1 + ((s3 - s1) * q) / kq;
          if (x < x0 || x > x1 || y < y0 || y > y1) continue;
          if (bank && Math.abs((x - bank.A.x) * ey - (y - bank.A.y) * ex) / L <= 3) continue; // along the side's line: a bank road
          if (inPoly(pl, x, y)) return true;
        }
      }
    }
    return false;
  };
  // Built shores: a recess, bump or step shallower than BUILT_TRIM, no longer than
  // BUILT_LEN, between two kept straight sides that run on in one line (within 10°,
  // and off each other's line by less than 10 m) goes: the first side's end joins the
  // second side's start. A seam, the map's edge or a line's mouth in between stays.
  const trimBuilt = (r: V[], mouth: (v: V) => boolean): V[] => {
    const nr = r.length, LEN = BUILT_LEN, ANG = Math.cos((10 * Math.PI) / 180);
    const DEPTH = BUILT_TRIM, OFF = Math.min(DEPTH / 2, 10);
    if (nr < 6) return r;
    const L = (i: number) => { const a = r[i % nr], b = r[(i + 1) % nr]; return Math.hypot(b.x - a.x, b.y - a.y); };
    const stuck = (v: V) => !!v.fixed || mouth(v);
    const drop = new Uint8Array(nr), used = new Uint8Array(nr);
    for (let a = 0; a < nr; a++) {
      const la = L(a);
      if (la < RIGHT_LEG || used[a]) continue;
      const A0 = r[a], A1 = r[(a + 1) % nr];
      if (!A0.corner || !A1.corner) continue; // a kept straight side
      const ux = (A1.x - A0.x) / la, uy = (A1.y - A0.y) / la;
      const off = (p: V) => (p.x - A0.x) * uy - (p.y - A0.y) * ux; // across the side's line
      let best = -1;
      for (let kq = 2; kq < nr - 1; kq++) {
        const b = (a + kq) % nr, Pb = r[b];
        if (Math.abs(off(Pb)) >= DEPTH || stuck(Pb) || Math.hypot(Pb.x - A1.x, Pb.y - A1.y) > LEN) break;
        const lb = L(b);
        if (lb < RIGHT_LEG) continue;
        const B1 = r[(b + 1) % nr];
        if (((B1.x - Pb.x) * ux + (B1.y - Pb.y) * uy) / lb >= ANG && Math.abs(off(Pb)) <= OFF && Math.abs(off(B1)) <= OFF && B1.corner) best = b;
      }
      if (best < 0) continue;
      // a bump out into the water that a road runs onto stays
      {
        const pl: V[] = [];
        let land = 0;
        for (let q = 1; ; q++) { const i = (a + q) % nr; pl.push(r[i]); if (i === best) break; land = Math.min(land, off(r[i])); }
        if (land < -3 && drawnRoads.length && roadIn(pl, { A: A1, B: r[best] })) continue;
      }
      let kq = 2;
      for (; ; kq++) { const i = (a + kq) % nr; if (i === best) break; drop[i] = 1; }
      for (let q = 0; q < kq; q++) used[(a + q) % nr] = 1; // the second side may start the next stretch
    }
    return drop.some(Boolean) ? r.filter((_, i) => !drop[i]) : r;
  };
  // one ring smoothed by the body's width; a canal only between its straight sides
  const ring = (r: V[], w: number, canal: boolean): V[] | null => {
    if (r.length < 3) return null;
    if (canal) {
      // a vertex stays where a straight side goes on straight or turns square; a ragged turn is smoothed
      r = r.map((v) => ({ ...v }));
      const N = r.length, long = r.map((a, j) => Math.hypot(r[(j + 1) % N].x - a.x, r[(j + 1) % N].y - a.y) >= RIGHT_LEG);
      for (let j = 0; j < N; j++) {
        if (!long[j] && !long[(j - 1 + N) % N]) continue;
        const t = Math.abs(turnAt(r[(j - 1 + N) % N], r[j], r[(j + 1) % N]));
        if (t <= 12 || Math.abs(t - 90) <= RIGHT_TOL || t >= 160) r[j].corner = true;
      }
    }
    const out = smoothSoft(r, w, work);
    // thin winding water with a corner at each mouth: each bank simplified on its own between
    // them can cut across its bends and fold it flat; then it stays as mapped, and only the
    // thin-water pass smooths it
    if (out.length < 3 || Math.abs(area(out)) < SOFT_KEEP * Math.abs(area(r))) return r;
    return out;
  };

  // land the merging shut in (between pieces, step 0) stays as land between two bodies would (step 4)
  const landStays = (h: V[]) => {
    const A = Math.abs(area(h));
    let Pm = 0;
    for (let j = 0; j < h.length; j++) { const a = h[j], b = h[(j + 1) % h.length]; Pm += Math.hypot(b.x - a.x, b.y - a.y); }
    const lw = (2 * A) / Pm, L = Pm / 2 - lw;
    return !(lw < NARROW_MIN && A < MIN_HOLE && !(L >= STRIP_LEN * lw && L >= STRIP_MIN)) || roadIn(h);
  };
  // body i's rings, corners marked and smoothed by the first pass
  const shape = (i: number, mouth: (v: V) => boolean): { i: number; kind: string; body: Body } | null => {
    const f = polys[i], w = width[i];
    if (rings[i][0].length < 3) return null;
    // an island under MIN_HOLE is filled, unless a drawn road runs on it
    const made = f.newHoles;
    const src = [rings[i][0], ...rings[i].slice(1).filter((h, hi) => (made?.[hi] ? landStays(h) : -area(h) >= MIN_HOLE || roadIn(h)))];
    let pre = src.map((r) => prep(r, i, w, mouth));
    // narrow and straight-banked: a canal or a basin
    let canal = false;
    if (f.kind !== "ocean" && w < CANAL_WIDTH) canal = straightShare(pre) >= CANAL_STRAIGHT && !!stripOf(i); // and two parallel banks
    if (!canal) pre = pre.map((r) => trimBuilt(r, mouth));
    const outer = ring(pre[0], w, canal);
    if (!outer) return null;
    const out: V[][] = [outer];
    for (const h of pre.slice(1)) { const rr = ring(h, w, canal); if (rr) out.push(rr); }
    return { i, kind: f.kind, body: { out, w, canal } };
  };
  const roadSegs = segments(roadGeoms, k);
  const fills: V[][][] = [];
  const fillBody: number[] = [];
  // bodies shaped together: smoothed by size and as thin water, then widened where too thin to see
  const shapeAll = (stage: { i: number; kind: string; body: Body }[]) => {
    const bodies = stage.map((s) => s.body);
    smoothBig(bodies, work);
    smoothThin(bodies, roadSegs, work);
    for (const { i, kind, body } of stage) {
      fills.push(kind !== "ocean" ? widenDense(body.out, work) : body.out);
      fillBody.push(i);
    }
  };
  // the shore where a drawn line meets the water stays as mapped
  shapeAll(polys.flatMap((_, i) => (kept[i] ? [shape(i, contacts.near)] : [])).filter((x): x is NonNullable<typeof x> => !!x));

  // ── islands between bodies: land shut in by several kept bodies ─────────
  // A hole in one body is dropped when it is under MIN_HOLE; land shut in by two or
  // more bodies is judged the same way, so a thin one does not stay as a sliver between
  // two shores smoothed apart. A long strip (a breakwater, a dyke) stays.
  // the land to fill between the bodies of each group `only` accepts
  const islands = (only: (g: number) => boolean): { g: number; rings: V[][] }[] => {
    const byGroup = new Map<number, number[]>();
    fillBody.forEach((i, s) => { const g = find(i); if (only(g)) (byGroup.get(g) ?? byGroup.set(g, []).get(g)!).push(s); });
    const add: { g: number; rings: V[][] }[] = [];
    for (const [g, ks] of byGroup) {
      if (ks.length < 2) continue;
      const owners = new Map<string, number>();
      // cut to the work box first: an island small enough to fill that any screen shows lies
      // wholly inside it, and the shores past it are most of the work
      const geoms: [number, number][][][] = [];
      for (const s of ks) {
        const outer = clipRing(fills[s][0], work);
        if (outer.length < 3) continue;
        geoms.push([outer, ...fills[s].slice(1).map((h) => clipRing(h, work)).filter((h) => h.length >= 3)].map((r) => {
          const pr = r.map((v) => [v.x - ox, v.y - oy] as [number, number]);
          for (const p of pr) owners.set(`${p[0]},${p[1]}`, fillBody[s]);
          pr.push(pr[0]);
          return pr;
        }));
      }
      if (geoms.length < 2) continue;
      let u: [number, number][][][];
      try {
        u = polygonClipping.union(geoms[0], ...geoms.slice(1));
      } catch {
        continue; // degenerate input: these islands stay as they are
      }
      for (const poly of u) for (const hole of poly.slice(1)) {
        const by = new Set<number>();
        for (const p of hole) { const b = owners.get(`${p[0]},${p[1]}`); if (b !== undefined) by.add(b); }
        if (by.size < 2) continue; // one body's own hole: already judged
        const isl: V[] = hole.slice(0, -1).map(([x, y]) => ({ x: x + ox, y: y + oy, corner: false }));
        if (landStays(isl)) continue;
        if (area(isl) < 0) isl.reverse();
        add.push({ g, rings: [isl] });
      }
    }
    return add;
  };
  let isles = islands(() => true);

  // ── lines, second pass: a link must reach water that is still drawn ───────
  const dd = new Uint8Array(MW * MH);
  raster.fill([...fills, ...isles.map((x) => x.rings)].flat(), (row, c0, c1) => dd.fill(1, row * MW + c0, row * MW + c1 + 1));
  const drawnAt = (x: number, y: number) => { const q = raster.index(x, y); return q >= 0 && dd[q] > 0; };
  // the nearest drawn water within rc cells, as a point a line can end on
  const nearDrawn = (x: number, y: number, rc: number): P | null => {
    if (drawnAt(x, y)) return [x, y];
    const cx = Math.floor((x - bx0) / CELL), cy = Math.floor((by1 - y) / CELL);
    let best: P | null = null, bd = Infinity;
    for (let dy = -rc; dy <= rc; dy++) for (let dx = -rc; dx <= rc; dx++) {
      const X = cx + dx, Y = cy + dy;
      if (X < 0 || Y < 0 || X >= MW || Y >= MH || !dd[Y * MW + X]) continue;
      const d = dx * dx + dy * dy;
      if (d < bd && d <= rc * rc) { bd = d; best = [bx0 + (X + 0.5) * CELL, by1 - (Y + 0.5) * CELL]; }
    }
    return best;
  };
  const toV = (pts: P[]) => {
    let l: V[] = pts.map(([x, y]) => ({ x, y, corner: false }));
    l[0].corner = l[l.length - 1].corner = true;
    l = simplifyKeep(l, STRAIGHT_TOL);
    markLineCorners(l);
    return simplifyKeep(l, LINE_TOL);
  };
  const rawL: { cls: WaterLineClass; raw: P[] }[] = [];
  // the samples of each unnamed stroke drawn so far
  const drawnOf = new Map<Cand, Uint8Array>();
  // reach into the water until the drawn shape covers the line again: where a stroke
  // at sample q (stepping by `dir`) leaves kept water as mapped, the point it ends on,
  // or null if it reaches no drawn water — within 20 m, 40 m where the stroke was
  // snapped, 150 m where it ends in the water
  const reachWater = ({ smp, body }: Cand, q: number, dir: -1 | 1): [number, P] | null => {
    while (q + dir >= 0 && q + dir < smp.length && body[q + dir] && !drawnAt(...smp[q])) q += dir;
    const end = q === 0 || q === smp.length - 1;
    const p = nearDrawn(...smp[q], snapped.has(smp[q]) ? 8 : end ? 30 : 4);
    return p ? [q, p] : null;
  };
  for (const c of cands) {
    const { cls, st, smp, whole, runs } = c;
    if (whole) { rawL.push({ cls, raw: st }); continue; }
    for (const [j, e] of runs) {
      const ra = reachWater(c, j - 1, -1), rb = reachWater(c, e, 1);
      if (!ra || !rb) continue;
      const [a, na] = ra, [b, nb] = rb;
      rawL.push({ cls, raw: [na, ...smp.slice(a, b + 1), nb] });
      let got = drawnOf.get(c);
      if (!got) drawnOf.set(c, (got = new Uint8Array(smp.length)));
      got.fill(1, a, b + 1);
    }
  }

  // a connector and the line whose loose end it carries on (rawL indices, and which end of each)
  const joins: { a: number; aStart: boolean; b: number; bStart: boolean }[] = [];
  // the line ends joined already (`il,start`)
  const joinedEnd = new Set<string>();

  // ── lines, second pass b: short connectors ────────────────────────────────
  // A stretch of an unnamed canal or stream at most LINK_MAX long is drawn where it
  // carries on from a drawn line's loose end (one that stops on land, joining nothing)
  // to other drawn water, a body or a line, or where it runs between a drawn line and a
  // body: the network doesn't break where the names stop. One between two lines' sides is
  // not (a loop, or a rung between two lines). What it adds is drawn water for the next
  // stretch, round after round; where it meets a drawn line end to end, it joins it.
  {
    const LG = 50;
    const unnamed = cands.filter((c) => !c.whole).map((c) => {
      const cum = new Float64Array(c.smp.length);
      for (let i = 1; i < c.smp.length; i++) cum[i] = cum[i - 1] + Math.hypot(c.smp[i][0] - c.smp[i - 1][0], c.smp[i][1] - c.smp[i - 1][1]);
      return { c, cum, vtx: sampledVertices(c.st, c.smp.length) }; // its own vertices, where another way can join it
    });
    // the loose ends carried on already, by where they are (two lines' ends can share one)
    const used = new Set<string>();
    for (let added = true; added && unnamed.length; ) {
      added = false;
      const isEnd = (p: P, il: number) => { const r = rawL[il].raw; return Math.hypot(r[0][0] - p[0], r[0][1] - p[1]) < 1 || Math.hypot(r[r.length - 1][0] - p[0], r[r.length - 1][1] - p[1]) < 1; };
      // every drawn line's sides, by 50 m cells
      const grid = new Grid(LG), segs: [P, P, number][] = [];
      rawL.forEach((l, il) => {
        for (let q = 0; q + 1 < l.raw.length; q++) {
          const a = l.raw[q], b = l.raw[q + 1];
          grid.addBox(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1]), segs.length);
          segs.push([a, b, il]);
        }
      });
      grid.build();
      // the drawn lines' sides within `tol` m of a point: the nearest point on each, and its line
      const near = (x: number, y: number, tol: number, f: (p: P, il: number, d2: number) => void) => {
        for (let X = Math.floor((x - tol) / LG); X <= Math.floor((x + tol) / LG); X++) for (let Y = Math.floor((y - tol) / LG); Y <= Math.floor((y + tol) / LG); Y++) {
          if (!grid.lookup(X, Y)) continue;
          const arr = grid.arr, hi = grid.hi;
          for (let q = grid.lo; q < hi; q++) {
            const [a, b, il] = segs[arr[q]], dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
            const t = L ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L)) : 0;
            const px = a[0] + dx * t, py = a[1] + dy * t, d = (px - x) ** 2 + (py - y) ** 2;
            if (d <= tol * tol) f([px, py], il, d);
          }
        }
      };
      const onLine = (x: number, y: number, tol: number): P | null => {
        let best: P | null = null, bd = Infinity;
        near(x, y, tol, (p, _, d) => { if (d < bd) { bd = d; best = p; } });
        return best;
      };
      // the drawn lines' loose ends: not in drawn water, nor on another drawn line short of its ends
      const loose: P[] = [], looseGrid = new Grid(LG);
      // the drawn lines ending at each point, and which end of theirs it is
      const endsAt = new Map<string, { il: number; start: boolean }[]>();
      rawL.forEach((l, il) => {
        for (const E of [l.raw[0], l.raw[l.raw.length - 1]]) {
          const k = pointKey(E), o = endsAt.get(k), me = { il, start: E === l.raw[0] };
          if (o) o.push(me); else endsAt.set(k, [me]);
          if (used.has(k) || nearDrawn(E[0], E[1], 1)) continue;
          let onSide = false;
          near(E[0], E[1], 1, (p, jl) => { if (jl !== il && !isEnd(p, jl)) onSide = true; });
          if (onSide) continue;
          looseGrid.add(Math.floor(E[0] / LG), Math.floor(E[1] / LG), loose.length);
          loose.push(E);
        }
      });
      looseGrid.build();
      const nearLoose = (x: number, y: number, tol: number): P | null => {
        let best: P | null = null, bd = tol * tol;
        for (let X = Math.floor((x - tol) / LG); X <= Math.floor((x + tol) / LG); X++) for (let Y = Math.floor((y - tol) / LG); Y <= Math.floor((y + tol) / LG); Y++) {
          if (!looseGrid.lookup(X, Y)) continue;
          for (let q = looseGrid.lo; q < looseGrid.hi; q++) { const E = loose[looseGrid.arr[q]], d = (E[0] - x) ** 2 + (E[1] - y) ** 2; if (d <= bd) { bd = d; best = E; } }
        }
        return best;
      };
      const found: { c: Cand; cls: WaterLineClass; raw: P[]; a: number; b: number; len: number; ends: P[] }[] = [];
      for (const { c, cum, vtx } of unnamed) {
        const { cls, smp, body } = c, m = smp.length;
        const got = drawnOf.get(c);
        // what each sample is: 1 in kept water as mapped, 2 on a drawn line (its own drawn
        // stretches, or a vertex on another drawn line — an end of the stroke within 20 m of
        // one), 3 at a drawn line's loose end, 0 neither
        const kind = new Uint8Array(m), at: (P | null)[] = new Array(m).fill(null);
        for (let i = 0; i < m; i++) {
          if (got?.[i]) kind[i] = 2;
          else if (body[i]) kind[i] = 1;
          else if (vtx[i]) {
            // what it touches (1 m) first; only an end touching nothing reaches further
            for (const tol of i === 0 || i === m - 1 ? [1, END_SNAP * CELL] : [1]) {
              const E = nearLoose(smp[i][0], smp[i][1], tol), p = E ?? onLine(smp[i][0], smp[i][1], tol);
              if (p) { kind[i] = E ? 3 : 2; at[i] = p; break; }
            }
          }
        }
        for (let j = 0; j < m;) {
          if (kind[j]) { j++; continue; }
          let e = j;
          while (e < m && !kind[e]) e++;
          const s = j - 1;
          j = e;
          if (s < 0 || e >= m || cum[e] - cum[s] > LINK_MAX) continue;
          // from a loose end, or between a drawn line and a body
          if (kind[s] !== 3 && kind[e] !== 3 && !(kind[s] === 2 && kind[e] === 1) && !(kind[s] === 1 && kind[e] === 2)) continue;
          // a loop out of a loose end and back into it joins nothing
          if (kind[s] === 3 && kind[e] === 3 && pointKey(at[s]!) === pointKey(at[e]!)) continue;
          // each end: on the line it joins, or reaching into the water as the links do
          let a = s, b = e, na: P | null = at[s], nb: P | null = at[e];
          if (kind[s] === 1) { const r = reachWater(c, s, -1); if (!r) continue; [a, na] = r; }
          if (kind[e] === 1) { const r = reachWater(c, e, 1); if (!r) continue; [b, nb] = r; }
          found.push({ c, cls, raw: [...(na ? [na] : []), ...smp.slice(a, b + 1), ...(nb ? [nb] : [])], a, b, len: cum[e] - cum[s], ends: [kind[s] === 3 ? at[s]! : null, kind[e] === 3 ? at[e]! : null].filter((p): p is P => !!p) });
        }
      }
      // a loose end is carried on once, by the shortest stretch that reaches it
      found.sort((p, q) => p.len - q.len);
      for (const f of found) {
        if (f.ends.some((E) => used.has(pointKey(E)))) continue;
        for (const E of f.ends) used.add(pointKey(E));
        // the line it carries on at each end, end to end: where several end there, the one it
        // runs on from straightest, turning less than 60° as ways are joined into strokes
        // (sharper, a V: two lines meeting), and not joined already
        for (const start of [true, false]) {
          const E = f.raw[start ? 0 : f.raw.length - 1], away = awayFrom(f.raw, start);
          let best: { il: number; start: boolean } | null = null, bd = -Math.cos(JOIN_TURN);
          for (const o of endsAt.get(pointKey(E)) ?? []) {
            if (joinedEnd.has(`${o.il},${+o.start}`)) continue;
            const w = awayFrom(rawL[o.il].raw, o.start), d = w[0] * away[0] + w[1] * away[1];
            if (d < bd) { bd = d; best = o; }
          }
          if (!best) continue;
          joins.push({ a: best.il, aStart: best.start, b: rawL.length, bStart: start });
          joinedEnd.add(`${best.il},${+best.start}`);
          joinedEnd.add(`${rawL.length},${+start}`);
        }
        rawL.push({ cls: f.cls, raw: f.raw });
        let g = drawnOf.get(f.c);
        if (!g) drawnOf.set(f.c, (g = new Uint8Array(f.c.smp.length)));
        g.fill(1, f.a, f.b + 1);
        added = true;
      }
    }
  }

  // ── 6. water standing alone, joined to the rest (./connect.ts) ───────────
  // The network: the unnamed lines of every class but river, and the bodies not kept,
  // in reach of the map. The systems: the water drawn so far, bodies and lines touching
  // on the 5 m raster. What the routes bring is added to it — their bodies shaped on
  // their own, their lines drawn whole — and nothing drawn before moves.
  {
    const net: NetLine[] = [];
    for (const f of [...lineWays, ...minor]) if (f.cls !== "river" && !f.named && f.line.length >= 2) net.push({ cls: f.cls, pts: f.line.map((g) => { const v = fwd(g); return [v.x, v.y] as P; }) });
    const netBodies: NetBody[] = [];
    polys.forEach((f, i) => {
      if (!kept[i] && f.kind !== "ocean" && rings[i][0].length >= 3 && !rings[i][0].every((v) => outside(work, v.x, v.y))) netBodies.push({ i, outer: rings[i][0], holes: rings[i].slice(1) });
    });
    if ((net.length || netBodies.length) && rawL.length + fills.length) {
      // the drawn lines' cells too (marked 2, cleared after), for the systems
      const marked: number[] = [];
      for (const l of rawL) for (let q = 0; q + 1 < l.raw.length; q++) {
        const a = l.raw[q], b = l.raw[q + 1], m = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 2));
        for (let t = 0; t <= m; t++) { const id = raster.index(a[0] + ((b[0] - a[0]) * t) / m, a[1] + ((b[1] - a[1]) * t) / m); if (id >= 0 && !dd[id]) { dd[id] = 2; marked.push(id); } }
      }
      // the systems: drawn cells, 8-connected, labelled run by run (a run: a row's cells from r0 to r1)
      const rowAt = new Int32Array(MH + 1), r0: number[] = [], r1: number[] = [], rl: number[] = [], up: number[] = [0];
      const root = (i: number) => { while (up[i] !== i) { up[i] = up[up[i]]; i = up[i]; } return i; };
      for (let y = 0; y < MH; y++) {
        const p0 = y ? rowAt[y - 1] : 0, p1 = r0.length, base = y * MW;
        rowAt[y] = p1;
        let pi = p0;
        for (let x = 0; x < MW; ) {
          if (!dd[base + x]) { x++; continue; }
          let e = x;
          while (e + 1 < MW && dd[base + e + 1]) e++;
          while (pi < p1 && r1[pi] < x - 1) pi++;
          let l = 0;
          for (let q = pi; q < p1 && r0[q] <= e + 1; q++) { const r = root(rl[q]); if (!l) l = r; else if (r !== l) up[r] = l; }
          if (!l) { l = up.length; up.push(l); }
          r0.push(x); r1.push(e); rl.push(l);
          x = e + 1;
        }
      }
      rowAt[MH] = r0.length;
      const sysOf = new Map<number, number>();
      const sys = rl.map((l) => { const r = root(l); let n = sysOf.get(r); if (n === undefined) sysOf.set(r, (n = sysOf.size + 1)); return n; });
      // the system of the nearest drawn cell within rc cells, and the cell's centre
      const near = (x: number, y: number, rc: number): [number, P] | null => {
        const cx = Math.floor((x - bx0) / CELL), cy = Math.floor((by1 - y) / CELL);
        let best = 0, bd = Infinity, bp: P = [x, y];
        for (let dy = -rc; dy <= rc; dy++) {
          const Y = cy + dy;
          if (Y < 0 || Y >= MH) continue;
          let lo = rowAt[Y], hi = rowAt[Y + 1];
          while (lo < hi) { const mid = (lo + hi) >> 1; if (r1[mid] < cx - rc) lo = mid + 1; else hi = mid; }
          for (let q = lo; q < rowAt[Y + 1] && r0[q] <= cx + rc; q++) {
            const X = Math.max(r0[q], Math.min(r1[q], cx)), d = (X - cx) ** 2 + dy * dy;
            if (d > rc * rc + 1 || d >= bd) continue;
            bd = d; best = sys[q]; bp = [bx0 + (X + 0.5) * CELL, by1 - (Y + 0.5) * CELL];
          }
        }
        return best ? [best, bp] : null;
      };
      const inFill = (x: number, y: number) => {
        const cx = Math.floor((x - bx0) / CELL), cy = Math.floor((by1 - y) / CELL);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const X = cx + dx, Y = cy + dy; if (X >= 0 && Y >= 0 && X < MW && Y < MH && dd[Y * MW + X] === 1) return true; }
        return false;
      };
      // the drawn lines' sides by 25 m cells: the nearest point on one within r m
      const LGC = 25, lgrid = new Grid(LGC), lsegs: [P, P, number][] = [];
      const indexLines = () => {
        rawL.forEach((l, il) => { for (let q = 0; q + 1 < l.raw.length; q++) { const a = l.raw[q], b = l.raw[q + 1]; lgrid.addBox(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1]), lsegs.length); lsegs.push([a, b, il]); } });
        lgrid.build();
      };
      indexLines();
      const onLineOf = (x: number, y: number, r: number, not: number): [P, number] | null => {
        let best: P | null = null, bd = r * r;
        for (let X = Math.floor((x - r) / LGC); X <= Math.floor((x + r) / LGC); X++) for (let Y = Math.floor((y - r) / LGC); Y <= Math.floor((y + r) / LGC); Y++) {
          if (!lgrid.lookup(X, Y)) continue;
          for (let q = lgrid.lo; q < lgrid.hi; q++) {
            const [a, b, il] = lsegs[lgrid.arr[q]];
            if (il === not) continue;
            const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy, t = L ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L)) : 0, px = a[0] + dx * t, py = a[1] + dy * t, d = (px - x) ** 2 + (py - y) ** 2;
            if (d <= bd) { bd = d; best = [px, py]; }
          }
        }
        return best ? [best, Math.sqrt(bd)] : null;
      };
      const drawn: Drawn = { near, inFill, onLine: (x, y, r) => onLineOf(x, y, r, -1)?.[0] ?? null, cell: CELL };
      const routes = connect(net, netBodies, drawn, sysOf.size);
      for (const q of marked) dd[q] = 0;

      if (routes.bodies.length || routes.pieces.length) {
        // the routes' lines on the plane: a stretch of a network line, carried on to what it reaches
        const sub = (pts: P[], pa: number, pb: number): P[] => {
          const at = (t: number): P => { const j = Math.min(Math.floor(t), pts.length - 2), u = t - j; return [pts[j][0] + (pts[j + 1][0] - pts[j][0]) * u, pts[j][1] + (pts[j + 1][1] - pts[j][1]) * u]; };
          const out = [at(pa)];
          for (let j = Math.ceil(pa + 1e-9); j < pb - 1e-9; j++) out.push([pts[j][0], pts[j][1]]);
          out.push(at(pb));
          return out;
        };
        const routeLines = routes.pieces.map((p) => {
          const raw = sub(net[p.line].pts, p.pa, p.pb);
          if (p.extA) raw.unshift(p.extA);
          if (p.extB) raw.push(p.extB);
          return { cls: net[p.line].cls, raw };
        });
        // the routes' bodies: their mouths (where a route's line crosses their shore) stay
        // as mapped, their seams with drawn bodies stay; then shaped as the others were
        const added = new Set(routes.bodies);
        const rb = routes.bodies.map((i) => ({ i, ...boxOf(rings[i][0]) }));
        const inRouteBody = (x: number, y: number) => rb.some((b) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1 && inPoly(rings[b.i][0], x, y) && !rings[b.i].slice(1).some((h) => inPoly(h, x, y)));
        const mouths = pointsNear();
        for (const l of routeLines) {
          const smp = sampleLine(l.raw), wet = smp.map(([x, y]) => inRouteBody(x, y));
          for (let q = 1; q < smp.length; q++) if (wet[q] !== wet[q - 1]) mouths.add(smp[wet[q] ? q : q - 1]);
        }
        mouths.build();
        for (const i of routes.bodies) seamsOf(i, (b) => kept[b] || added.has(b));
        const from = fills.length;
        shapeAll(routes.bodies.map((i) => shape(i, mouths.near)).filter((x): x is NonNullable<typeof x> => !!x));
        // the land between bodies, again where the routes' bodies joined a group
        const touched = new Set(routes.bodies.map((i) => find(i)));
        const again = islands((g) => touched.has(g));
        isles = [...isles.filter((x) => !touched.has(x.g)), ...again];
        raster.fill([...fills.slice(from), ...again.map((x) => x.rings)].flat(), (row, c0, c1) => dd.fill(1, row * MW + c0, row * MW + c1 + 1));

        // the routes' lines, drawn whole
        const first = rawL.length;
        rawL.push(...routeLines);
        // A route ends on drawn water as it was before the routes, a cell or so off: an end
        // on neither drawn water nor a drawn line carries on to another line's end within
        // 8 m (so the two are smoothed as one), or else to the nearest drawn water or line (20 m).
        lsegs.length = 0;
        indexLines();
        for (let il = first; il < rawL.length; il++) for (const start of [true, false]) {
          const r = rawL[il].raw, E = r[start ? 0 : r.length - 1];
          if (drawnAt(E[0], E[1]) || onLineOf(E[0], E[1], 1, il)) continue;
          let to: P | null = null, ed = 8;
          for (let jl = 0; jl < rawL.length; jl++) {
            if (jl === il) continue;
            const m = rawL[jl].raw;
            for (const F of [m[0], m[m.length - 1]]) { const d = Math.hypot(F[0] - E[0], F[1] - E[1]); if (d < ed) { ed = d; to = F; } }
          }
          if (!to) {
            const w = nearDrawn(E[0], E[1], 4), o = onLineOf(E[0], E[1], 20, il);
            to = o && o[1] < (w ? Math.hypot(w[0] - E[0], w[1] - E[1]) : Infinity) ? o[0] : w;
          }
          if (!to) continue;
          if (start) r.unshift(to); else r.push(to);
        }
        // Where a route's line ends on another line's end (the route's next piece where its
        // class changes, or the line it carries on), the straightest pair there turning less
        // than JOIN_TURN is joined end to end, as the short connectors are (step 5).
        const ends = new Map<string, { il: number; start: boolean }[]>();
        rawL.forEach((l, il) => { for (const start of [true, false]) { const k2 = pointKey(l.raw[start ? 0 : l.raw.length - 1]); (ends.get(k2) ?? ends.set(k2, []).get(k2)!).push({ il, start }); } });
        for (const at of ends.values()) {
          if (at.length < 2 || !at.some((x) => x.il >= first)) continue;
          const pairs: [number, number, number][] = [];
          for (let a = 0; a < at.length; a++) for (let b = a + 1; b < at.length; b++) {
            if (at[a].il === at[b].il || (at[a].il < first && at[b].il < first)) continue;
            const u = awayFrom(rawL[at[a].il].raw, at[a].start), w = awayFrom(rawL[at[b].il].raw, at[b].start), d = u[0] * w[0] + u[1] * w[1];
            if (d < -Math.cos(JOIN_TURN)) pairs.push([d, a, b]);
          }
          pairs.sort((p, q) => p[0] - q[0]);
          for (const [, a, b] of pairs) {
            const A = at[a], B = at[b], ka = `${A.il},${+A.start}`, kb = `${B.il},${+B.start}`;
            if (joinedEnd.has(ka) || joinedEnd.has(kb)) continue;
            joins.push({ a: A.il, aStart: A.start, b: B.il, bStart: B.start });
            joinedEnd.add(ka); joinedEnd.add(kb);
          }
        }
      }
    }
  }

  // ── lines, third pass: smoothed where they run on land ────────────────────
  // where one drawn line ends on another, the other is pinned there (and by which)
  const pinsOf: { p: P; by: number }[][] = rawL.map(() => []);
  {
    const segD2 = (x: number, y: number, a: P, b: P) => {
      const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
      let t = L ? ((x - a[0]) * dx + (y - a[1]) * dy) / L : 0;
      t = Math.max(0, Math.min(1, t));
      const px = a[0] + dx * t - x, py = a[1] + dy * t - y;
      return px * px + py * py;
    };
    // every line's segments by 50 m cells
    const SG = 50, sgrid = new Grid(SG);
    const segs: [number, number][] = []; // line, segment
    rawL.forEach((B, ib) => {
      for (let q = 0; q + 1 < B.raw.length; q++) {
        const a = B.raw[q], b = B.raw[q + 1];
        sgrid.addBox(Math.min(a[0], b[0]) - 1, Math.min(a[1], b[1]) - 1, Math.max(a[0], b[0]) + 1, Math.max(a[1], b[1]) + 1, segs.length);
        segs.push([ib, q]);
      }
    });
    sgrid.build();
    rawL.forEach((A, ia) => {
      for (const E of [A.raw[0], A.raw[A.raw.length - 1]]) {
        // the lines E lies on (within 1 m), in their order
        const on = new Set<number>();
        if (!sgrid.lookup(Math.floor(E[0] / SG), Math.floor(E[1] / SG))) continue;
        const arr = sgrid.arr, hi = sgrid.hi;
        for (let qs = sgrid.lo; qs < hi; qs++) {
          const [ib, q] = segs[arr[qs]];
          if (ib === ia || on.has(ib)) continue;
          if (segD2(E[0], E[1], rawL[ib].raw[q], rawL[ib].raw[q + 1]) < 1) on.add(ib);
        }
        for (const ib of [...on].sort((p, q) => p - q)) pinsOf[ib].push({ p: E, by: ia });
      }
    });
  }
  // a drawn road running along the line here (the roads' 50 m grid, above)
  const HUG = 15, cos30 = Math.cos(Math.PI / 6);
  const hugAt = (x: number, y: number, ux: number, uy: number) => {
    for (let X = Math.floor((x - HUG) / RGC); X <= Math.floor((x + HUG) / RGC); X++) for (let Y = Math.floor((y - HUG) / RGC); Y <= Math.floor((y + HUG) / RGC); Y++) {
      if (!rgrid.lookup(X, Y)) continue;
      const arr = rgrid.arr, hi = rgrid.hi;
      for (let q = rgrid.lo; q < hi; q++) {
        const e = arr[q], ax = drawnSegs[4 * e], ay = drawnSegs[4 * e + 1], bx = drawnSegs[4 * e + 2], by = drawnSegs[4 * e + 3];
        const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy);
        if (L < 1e-6) continue;
        if (Math.abs((dx * ux + dy * uy) / L) < cos30) continue;
        let t = ((x - ax) * dx + (y - ay) * dy) / (L * L);
        t = Math.max(0, Math.min(1, t));
        if (Math.hypot(ax + dx * t - x, ay + dy * t - y) <= HUG) return true;
      }
    }
    return false;
  };
  // drawn water within 15 m of a point
  const WR = Math.ceil(15 / CELL);
  const wetNear = (x: number, y: number) => {
    const cx = Math.floor((x - bx0) / CELL), cy = Math.floor((by1 - y) / CELL);
    for (let dy = -WR; dy <= WR; dy++) for (let dx = -WR; dx <= WR; dx++) {
      if (dx * dx + dy * dy > WR * WR) continue;
      const X = cx + dx, Y = cy + dy;
      if (X >= 0 && Y >= 0 && X < MW && Y < MH && dd[Y * MW + X]) return true;
    }
    return false;
  };
  const env = { drawnAt, hugAt, wetNear, toV, far: (x: number, y: number) => outside(work, x, y) };
  const pts: V[][] = new Array(rawL.length);
  // a connector and the line it carries on, end to end, are smoothed as one line, pinned at
  // the joint so it stays where it was (and smooth through it), then cut back there; a chain
  // can run through several (a line carried on at both ends, a connector between two lines)
  const nextOf = new Map<string, [number, boolean]>();
  for (const j of joins) { nextOf.set(`${j.a},${+j.aStart}`, [j.b, j.bStart]); nextOf.set(`${j.b},${+j.bStart}`, [j.a, j.aStart]); }
  for (let il = 0; il < rawL.length; il++) {
    if (pts[il]) continue;
    if (!nextOf.has(`${il},1`) && !nextOf.has(`${il},0`)) { pts[il] = smoothLine(rawL[il].raw, pinsOf[il].map((q) => q.p), env); continue; }
    // back to the chain's free end, then along it
    let head = il, free = true;
    for (let k = 0; k <= rawL.length; k++) { const nb = nextOf.get(`${head},${+free}`); if (!nb || nb[0] === il) break; [head, free] = [nb[0], !nb[1]]; }
    const chain: { il: number; fwd: boolean }[] = [], seen = new Set<number>();
    for (let cur: [number, boolean] | undefined = [head, free]; cur && !seen.has(cur[0]); ) {
      seen.add(cur[0]);
      chain.push({ il: cur[0], fwd: cur[1] });
      cur = nextOf.get(`${cur[0]},${+!cur[1]}`);
    }
    // one line: its members don't pin each other, so a joint moves as any point of a line
    // would, unless a line from elsewhere ends there too (a confluence) and pins it
    const merged: P[] = [], joints: P[] = [], pins: P[] = [];
    for (const { il: m, fwd } of chain) {
      const r = fwd ? rawL[m].raw : rawL[m].raw.slice().reverse();
      if (merged.length) joints.push(r[0]);
      for (let q = merged.length ? 1 : 0; q < r.length; q++) merged.push(r[q]);
      for (const q of pinsOf[m]) if (!seen.has(q.by)) pins.push(q.p);
    }
    const cutAt: (V | null)[] = joints.map(() => null);
    const sm = smoothLine(merged, pins, env, joints, cutAt);
    // cut at each joint: its sample's vertex, or else the nearest point of the line
    const cuts: number[] = [];
    let from = 0;
    for (const [k, J] of joints.entries()) {
      const at0 = cutAt[k] ? sm.indexOf(cutAt[k]!, from) : -1;
      if (at0 > from) { cuts.push(at0); from = at0; continue; }
      let bi = -1, bd = Infinity, bt = 0;
      for (let q = from; q + 1 < sm.length; q++) {
        const a = sm[q], b = sm[q + 1], dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy;
        const t = L ? Math.max(0, Math.min(1, ((J[0] - a.x) * dx + (J[1] - a.y) * dy) / L)) : 0, d = Math.hypot(a.x + dx * t - J[0], a.y + dy * t - J[1]);
        if (d < bd) { bd = d; bi = q; bt = t; }
      }
      if (bi < 0) break;
      const at = bt < 1e-6 ? bi : bt > 1 - 1e-6 ? bi + 1 : -1;
      if (at >= 0) { sm[at] = { x: J[0], y: J[1], corner: true }; cuts.push(at); from = at; }
      else { sm.splice(bi + 1, 0, { x: J[0], y: J[1], corner: true }); cuts.push(bi + 1); from = bi + 1; }
    }
    const bounds = [0, ...cuts, sm.length - 1];
    const ok = cuts.length === joints.length && bounds.every((v, k) => k === 0 || bounds[k - 1] < v);
    chain.forEach(({ il: m }, k) => { pts[m] = ok ? sm.slice(bounds[k], bounds[k + 1] + 1).map((v) => ({ ...v })) : smoothLine(rawL[m].raw, pinsOf[m].map((q) => q.p), env); });
  }
  const lines: Generalized["lines"] = rawL.map(({ cls }, il) => ({ cls, pts: pts[il] }));
  return { fills: [...fills, ...isles.map((x) => x.rings)], lines };
}

/** The share of the rings' shore on straight sides, {@link RIGHT_LEG} long at least (0 with no shore). */
function straightShare(rs: readonly V[][]): number {
  let st = 0, all = 0;
  for (const r of rs) for (let j = 0; j < r.length; j++) { const a = r[j], b = r[(j + 1) % r.length]; const l = Math.hypot(b.x - a.x, b.y - a.y); all += l; if (l >= RIGHT_LEG) st += l; }
  return all ? st / all : 0;
}

/** Every side of the polylines as a segment ax, ay, bx, by on the plane of `generalize` (k = cos(lat0)). */
function segments(geoms: readonly Geom[][], k: number): Float64Array {
  let n = 0;
  for (const g of geoms) n += Math.max(0, g.length - 1);
  const out = new Float64Array(4 * n);
  let at = 0;
  for (const g of geoms) for (let j = 0; j + 1 < g.length; j++) {
    out[at++] = g[j].lon * M * k; out[at++] = g[j].lat * M; out[at++] = g[j + 1].lon * M * k; out[at++] = g[j + 1].lat * M;
  }
  return out;
}
