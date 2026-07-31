// Mondrian-style map (issue #18). Takes the REAL city road network and paints a
// De Stijl composition on top of it: the enclosed city blocks (the polygons the
// streets carve the map into) are the canvas, a small random subset of them is
// filled with Mondrian primaries (red / blue / yellow, plus rare black/gray
// accents), and everything else — the road lines and the unfilled blocks — is
// left black-on-white. It is a recoloring of the actual map geometry, NOT an
// abstract full-canvas grid.
//
// The heart of it is extracting those enclosed blocks: we build a graph from the
// road polylines and walk its half-edges with the "clockwise-most turn" rule,
// which traces every minimal face — i.e. every block — exactly once. We keep
// only blocks whose area falls in a sane range (dropping slivers and the huge
// outer/unclosed regions), then deterministically pick a fraction to color.
//
// Two properties of that graph are worth knowing before trusting its output:
//
//   • It is NOT a planar embedding, and the face walk assumes one. Grade
//     separation — a bridge/tunnel/interchange crossing another street with no
//     shared OSM node — puts two edges that cross on screen into the graph
//     without an intersection vertex. The walk then stitches the regions on
//     either side of the crossing into a single self-intersecting face, which
//     fills as an ink-blot rather than a clean plane. Highway corridors and
//     river valleys are where this shows up; it is the known cost of not
//     running a real segment-intersection pass over ~10^5 edges in the client.
//   • Vertices are merged by rounding to whole pixels, not by node identity
//     (Overpass `geometry` carries no node ids). That is mostly a feature — the
//     shared junction nodes of adjoining ways collapse into one vertex, and so
//     do the near-duplicates OSM is full of — but at ~8 m/px it also invents a
//     junction wherever a flyover passes within a pixel of the road beneath it.
//
// Determinism: seeded from the bbox, so re-rendering the *same payload* at the
// *same canvas size* reproduces the poster exactly (the wallpaper must be stable
// across a theme switch or a restart). It is not stable across a refetch that
// reorders `osm.elements`, nor across canvas sizes — both change which faces are
// eligible and in what order.
//
// Runs on the CLIENT (in the renderer window), same as the rest of ./render.
// Kept dependency-free and canvas-agnostic.

import type { DrawReq } from "./render";
import { project } from "./bbox";

/** Warm off-white paper and near-black ink — the Mondrian "black/white". Named
 *  for the `Style` fields they replace (see `drawScene`). */
export const MONDRIAN_BACKGROUND = "#F5F2EA";
export const MONDRIAN_FOREGROUND = "#141414";

/** De Stijl fill palette, weighted toward blue → red → yellow like the
 *  reference posters; black/gray are rare accents. */
const PALETTE: { color: string; weight: number }[] = [
  { color: "#1652C0", weight: 36 }, // blue
  { color: "#D62828", weight: 30 }, // red
  { color: "#F5C400", weight: 23 }, // yellow
  { color: "#141414", weight: 5 }, // black accent
  { color: "#D9D5CB", weight: 6 }, // light-gray accent
];
const TOTAL_WEIGHT = PALETTE.reduce((s, p) => s + p.weight, 0);

/** Fraction of eligible blocks to fill with color; the rest stay white. */
const COLOR_FRAC = 0.16;

/** Keep only blocks whose area is within this fraction-of-canvas range. Below
 *  the min are slivers/noise. The max is there for the huge outer face of each
 *  connected component (and anything left unenclosed), but it is a heuristic,
 *  not a classifier: it also drops the genuinely large blocks just under it,
 *  which are the most poster-like ones. (The exact test would be the winding
 *  direction — the walk traces outer faces with the opposite sign — should this
 *  ever be tuned toward fewer, bigger planes.)
 *  Fractions of the canvas rather than absolute px² on purpose: block area
 *  scales with canvas area, so the composition reads the same at 2K and 5K. */
const MIN_AREA_FRAC = 1.5e-5;
const MAX_AREA_FRAC = 4e-3;

/** OSM `highway` classes that bound city blocks (vehicular streets). Footways,
 *  paths, cycleways, steps and tracks are excluded — they cut through blocks
 *  rather than delimit them, and would shatter the composition into confetti. */
const BLOCK_ROADS = new Set([
  "motorway", "trunk", "primary", "secondary", "tertiary",
  "unclassified", "residential", "living_street", "service", "road",
]);

/** Does the scene's road style actually stroke this `highway` class? */
export type StrokeTest = (highway: string | undefined) => boolean;

/**
 * Whether a way both bounds a block and is actually inked by the current style.
 * The second half matters: a color plane is only legible as a plane because the
 * streets around it are stroked on top of its edges, so a block bounded by a
 * class the preset doesn't draw (`minimal` strokes only motorway…tertiary) would
 * leave a colored shape floating in empty paper. `isStroked` comes from the
 * caller's own width table (see `drawScene`), so extraction and stroking can't
 * drift apart.
 */
function isBlockRoad(highway: string | undefined, isStroked: StrokeTest): boolean {
  if (!highway) return false;
  if (!BLOCK_ROADS.has(highway.replace(/_link$/, ""))) return false;
  return isStroked(highway);
}

/** Small deterministic PRNG (mulberry32) so a location renders the same poster
 *  every time — the wallpaper must be stable across re-renders. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a hash of the bbox corners → a stable seed per location. */
function bboxSeed(b: { south: number; west: number; north: number; east: number }): number {
  const s = `${b.south.toFixed(5)},${b.west.toFixed(5)},${b.north.toFixed(5)},${b.east.toFixed(5)}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Shoelace signed area of a projected polygon (pixel² ). */
function signedArea(pts: [number, number][]): number {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % n];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

/**
 * Extract the enclosed blocks (minimal faces) of the road network as projected
 * pixel polygons. Vertices are snapped to whole pixels (which is what merges the
 * junctions — see the caveats at the top of this file); edges come from
 * consecutive way points. Faces are traced by following, at each vertex, the
 * neighbor one step clockwise from the edge we arrived on — the standard
 * planar-subdivision face walk, which visits every directed half-edge once and
 * so every face (bounded blocks + one outer face per component) exactly once.
 * Callers filter out the outer faces by area.
 */
function extractFaces(req: DrawReq, isStroked: StrokeTest): [number, number][][] {
  const { bbox, width, height, osm } = req;

  const vid = new Map<string, number>();
  const vx: number[] = [];
  const vy: number[] = [];
  const vkey = (x: number, y: number) => `${Math.round(x)}_${Math.round(y)}`;
  const getV = (x: number, y: number): number => {
    const k = vkey(x, y);
    let id = vid.get(k);
    if (id === undefined) {
      id = vx.length;
      vx.push(x);
      vy.push(y);
      vid.set(k, id);
    }
    return id;
  };

  const nbr: Set<number>[] = [];
  const addEdge = (a: number, b: number) => {
    if (a === b) return;
    (nbr[a] ??= new Set()).add(b);
    (nbr[b] ??= new Set()).add(a);
  };

  for (const el of osm.elements ?? []) {
    if (el.type !== "way" || !el.geometry || el.geometry.length < 2) continue;
    if (!isBlockRoad(el.tags?.highway, isStroked)) continue;
    let prev = -1;
    for (const p of el.geometry) {
      const [x, y] = project(p.lat, p.lon, bbox, width, height);
      const id = getV(x, y);
      if (prev !== -1) addEdge(prev, id);
      prev = id;
    }
  }

  const n = vx.length;
  // Per-vertex neighbors sorted by angle, plus a neighbor→index lookup for the
  // clockwise-turn step.
  const order: number[][] = new Array(n);
  const idxOf: Map<number, number>[] = new Array(n);
  for (let v = 0; v < n; v++) {
    const set = nbr[v];
    if (!set) {
      order[v] = [];
      idxOf[v] = new Map();
      continue;
    }
    // Angle per neighbor computed once, not inside the comparator — the sort
    // calls it O(k log k) times per vertex, and there are ~10^5 vertices.
    const arr = [...set];
    const angle = new Map<number, number>();
    for (const a of arr) angle.set(a, Math.atan2(vy[a] - vy[v], vx[a] - vx[v]));
    arr.sort((a, b) => angle.get(a)! - angle.get(b)!);
    order[v] = arr;
    const m = new Map<number, number>();
    for (let i = 0; i < arr.length; i++) m.set(arr[i], i);
    idxOf[v] = m;
  }

  const visited = new Set<number>();
  const heId = (a: number, b: number) => a * n + b; // < 2^53 for any realistic n
  const faces: [number, number][][] = [];

  for (let v = 0; v < n; v++) {
    for (const w of order[v]) {
      if (visited.has(heId(v, w))) continue;
      const pts: [number, number][] = [];
      let a = v;
      let b = w;
      let guard = 0;
      // Walk half-edges until we return to the starting one, tracing one face.
      while (true) {
        visited.add(heId(a, b));
        pts.push([vx[a], vy[a]]);
        const ord = order[b];
        const i = idxOf[b].get(a)!; // a is always a neighbor of b (undirected edges)
        const c = ord[(i - 1 + ord.length) % ord.length];
        a = b;
        b = c;
        if (a === v && b === w) break;
        if (++guard > 2_000_000) break; // pathological-data safety valve
      }
      if (pts.length >= 3) faces.push(pts);
    }
  }

  return faces;
}

/**
 * Fill a random subset of the road network's enclosed blocks with Mondrian
 * colors onto `ctx`, and return how many planes were painted (the scene's
 * `blocks` count — the only window onto a layer whose output is otherwise hard
 * to tell apart from bad data). Assumes the background is already painted; the
 * road lines are drawn on top afterward (see render.ts `drawScene`), which masks
 * the block boundaries so the fills read as clean color planes between the
 * streets. `isStroked` gates which classes bound a block — see {@link isBlockRoad}.
 */
export function fillMondrianBlocks(
  ctx: CanvasRenderingContext2D,
  req: DrawReq,
  isStroked: StrokeTest,
): number {
  const { width, height } = req;
  const canvasArea = width * height;
  const minA = MIN_AREA_FRAC * canvasArea;
  const maxA = MAX_AREA_FRAC * canvasArea;

  const eligible: [number, number][][] = [];
  for (const f of extractFaces(req, isStroked)) {
    const area = Math.abs(signedArea(f));
    if (area >= minA && area <= maxA) eligible.push(f);
  }

  const rng = mulberry32(bboxSeed(req.bbox));
  // Deterministic Fisher–Yates shuffle, then take the first COLOR_FRAC of them.
  for (let i = eligible.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = eligible[i];
    eligible[i] = eligible[j];
    eligible[j] = tmp;
  }
  const count = Math.floor(eligible.length * COLOR_FRAC);

  for (let i = 0; i < count; i++) {
    const f = eligible[i];
    ctx.fillStyle = pickColor(rng);
    ctx.beginPath();
    ctx.moveTo(f[0][0], f[0][1]);
    for (let k = 1; k < f.length; k++) ctx.lineTo(f[k][0], f[k][1]);
    ctx.closePath();
    ctx.fill();
  }
  return count;
}

/** Weighted pick from {@link PALETTE}. */
function pickColor(rng: () => number): string {
  const r = rng() * TOTAL_WEIGHT;
  let acc = 0;
  for (const p of PALETTE) {
    acc += p.weight;
    if (r < acc) return p.color;
  }
  return PALETTE[0].color;
}
