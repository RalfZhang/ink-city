import { DEFAULT_STYLE, project, strokeScale, widthFor } from "@inkcity/core";
import { SPREAD_CURVE, SPREAD_S } from "./front";
import type { Manifest } from "./manifest";
import { mapBBox, type View } from "./size";

// How today's map arrives: its roads inked in from the top of the screen, the way
// ralfz.com's InkCity screen draws its cities (../www, src/visuals/RoadMap.tsx) — a
// front coming down the screen (./front.ts), and each road growing out from its
// highest point as the front reaches it, at the front's own pace. The map itself is
// still drawScene's (./draw.ts): the page paints the finished frame along these
// lines (./ink-in.ts), so what the ink uncovers is exactly that frame, and the last
// step lays the whole of it down.
//
// This is the part that needs the day's data, so it runs where the frame is drawn
// (the worker, or the main thread where it can't draw), and only for the frame
// that opens a day: a resize or a theme switch just swaps the picture.

/** Vertices that stray less than this (device px) from the line through their neighbours are dropped: the frame itself is drawn from all of them. */
const SIMPLIFY_PX = 0.5;
/** Each road is uncovered this much wider (device px) than it's drawn, so its anti-aliased edge comes with it. */
const EDGE_PX = 1.5;

/**
 * The roads of one frame, in the frame's device pixels, as the page inks them in.
 * Path i is vertices `first[i]` … `first[i + 1] - 1`, oriented the way it grows;
 * flat typed arrays, so the lot crosses from the worker without a copy.
 */
export type Growth = {
  xy: Float32Array;
  first: Uint32Array;
  /** Distance along its path at each vertex. */
  cum: Float32Array;
  /** When each path starts, in seconds. */
  begin: Float32Array;
  /**
   * The paths in runs that share the width they're uncovered at: paths `prev end`
   * … `end - 1`, thinnest run first, each run in order of `begin`.
   */
  strokes: { width: number; end: number }[];
  /** How fast each path grows, px per second — the front's average. */
  speed: number;
};

/** Every buffer behind `g`, to hand over rather than copy. */
export function growthBuffers(g: Growth): ArrayBuffer[] {
  return [g.xy, g.first, g.cum, g.begin].map((a) => a.buffer as ArrayBuffer);
}

/**
 * `pts` (x, y pairs) with every vertex that strays less than `tol` from the chord
 * of its stretch dropped — Douglas–Peucker, on a stack rather than recursion,
 * since a coastline-hugging road can run to thousands of vertices.
 */
function simplify(pts: Float32Array, tol: number): Float32Array {
  const n = pts.length / 2;
  if (n <= 2) return pts;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [0, n - 1];
  const tol2 = tol * tol;
  while (stack.length) {
    const b = stack.pop()!;
    const a = stack.pop()!;
    const ax = pts[2 * a];
    const ay = pts[2 * a + 1];
    const dx = pts[2 * b] - ax;
    const dy = pts[2 * b + 1] - ay;
    const len2 = dx * dx + dy * dy;
    let far = -1;
    let farD = tol2;
    for (let k = a + 1; k < b; k++) {
      const px = pts[2 * k] - ax;
      const py = pts[2 * k + 1] - ay;
      // Squared distance to the chord, or to `a` itself for a closed loop.
      const cross = dx * py - dy * px;
      const d = len2 > 0 ? (cross * cross) / len2 : px * px + py * py;
      if (d > farD) {
        farD = d;
        far = k;
      }
    }
    if (far < 0) continue;
    keep[far] = 1;
    stack.push(a, far, far, b);
  }
  let m = 0;
  for (let k = 0; k < n; k++) m += keep[k];
  const out = new Float32Array(2 * m);
  for (let k = 0, j = 0; k < n; k++) {
    if (!keep[k]) continue;
    out[j++] = pts[2 * k];
    out[j++] = pts[2 * k + 1];
  }
  return out;
}

/**
 * Lay out `manifest`'s roads for inking in, from the top of `view` (the part of the
 * frame on screen), on a `width`×`height` frame: projected and widened exactly as
 * drawScene draws them for that frame (the same crop and the same width table),
 * anything off the view dropped — the last step lays all of the frame down, the
 * rest of it with it. A road whose highest point lies partway along it is split
 * there, both halves growing outward from it, so the ink runs along a street rather
 * than waiting at its far end.
 */
export function growthFor(manifest: Manifest, width: number, height: number, view: View = { x: 0, y: 0, width, height }): Growth {
  const bbox = mapBBox(manifest, width, height);
  const scale = strokeScale(bbox, height);
  const { x: left, y: top } = view;
  const right = left + view.width;
  const bottom = top + view.height;
  const delay = (y: number) => SPREAD_S * Math.pow(Math.min(1, Math.max(0, y - top) / view.height), SPREAD_CURVE);

  // Paths collected per width, as plain arrays first: how many there will be isn't
  // known until the culling and the splits are done.
  type Path = { pts: number[]; begin: number };
  const byWidth = new Map<number, Path[]>();
  let vertices = 0;

  for (const el of manifest.elements ?? []) {
    if (el.type !== "way" || !el.geometry || el.geometry.length < 2) continue;
    const w = widthFor(el.tags?.highway, DEFAULT_STYLE.preset, scale);
    if (w === null) continue;
    const geom = el.geometry;
    const raw = new Float32Array(geom.length * 2);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let k = 0; k < geom.length; k++) {
      const [x, y] = project(geom[k].lat, geom[k].lon, bbox, width, height);
      raw[2 * k] = x;
      raw[2 * k + 1] = y;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    if (maxX < left - w || minX > right + w || maxY < top - w || minY > bottom + w) continue;
    const pts = simplify(raw, SIMPLIFY_PX);
    const n = pts.length / 2;
    let start = 0;
    for (let k = 1; k < n; k++) if (pts[2 * k + 1] < pts[2 * start + 1]) start = k;
    const begin = delay(pts[2 * start + 1]);
    const list = byWidth.get(w) ?? [];
    // Out from `start` towards each end; a half that's only `start` itself is no path.
    for (const step of [1, -1]) {
      const end = step === 1 ? n - 1 : 0;
      if (start === end) continue;
      const half: number[] = [];
      for (let k = start; ; k += step) {
        half.push(pts[2 * k], pts[2 * k + 1]);
        if (k === end) break;
      }
      list.push({ pts: half, begin });
      vertices += half.length / 2;
    }
    byWidth.set(w, list);
  }

  const widths = [...byWidth.keys()].sort((a, b) => a - b);
  const count = widths.reduce((n, w) => n + byWidth.get(w)!.length, 0);
  const xy = new Float32Array(vertices * 2);
  const first = new Uint32Array(count + 1);
  const cum = new Float32Array(vertices);
  const begin = new Float32Array(count);
  const strokes: Growth["strokes"] = [];
  let i = 0;
  let v = 0;
  for (const w of widths) {
    const paths = byWidth.get(w)!;
    // Each run in the order its paths start in, so the page can take them up as the front reaches them.
    paths.sort((a, b) => a.begin - b.begin);
    for (const p of paths) {
      first[i] = v;
      begin[i] = p.begin;
      for (let k = 0; k < p.pts.length; k += 2, v++) {
        xy[2 * v] = p.pts[k];
        xy[2 * v + 1] = p.pts[k + 1];
        cum[v] = k === 0 ? 0 : cum[v - 1] + Math.hypot(p.pts[k] - p.pts[k - 2], p.pts[k + 1] - p.pts[k - 1]);
      }
      i++;
    }
    strokes.push({ width: w + EDGE_PX, end: i });
  }
  first[count] = v;
  return { xy, first, cum, begin, strokes, speed: view.height / SPREAD_S };
}
