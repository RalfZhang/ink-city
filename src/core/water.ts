// polygon-clipping's ESM build only has a default export (its .d.ts wrongly
// declares named ones), so destructure union/difference off the default —
// named value imports throw at runtime under Node/tsx ESM. Types are erased.
import polygonClipping, { type MultiPolygon, type Ring } from "polygon-clipping";
const { difference, union } = polygonClipping;

import type { Bbox, Geom, WaterFeature, WaterLineClass, WaterPolygon } from "./types";
import { fetchOverpass, MIRRORS, type FetchOptions } from "./overpass";

// Water layer extraction. Runs at PRECACHE/FETCH time (Node/Deno/Bun — CI's
// batch precache and the desktop app's live sidecar fallback alike), never on
// the client: it fetches OSM water + coastline for a bbox and assembles it
// into ready-to-fill polygons (+ thin waterway lines) so the renderer
// (src/core/render.ts) only has to fill/stroke them. All the fiddly geometry
// lives here, in geographic (lat/lon) space where OSM's "land on the left,
// water on the right" rule for coastlines holds as written. Mirrors the road
// path in overpass.ts. The "water" layer implementation dispatched by
// fetch-city.ts's fetchCityData().
//
// This module is deliberately NOT re-exported from ./index (the client barrel):
// it depends on `polygon-clipping`, which we keep out of the desktop/website
// bundle. fetch-city.ts imports it directly.
//
// Scope: area water = natural=water + waterway=riverbank + water=* +
// landuse=reservoir/basin; ocean from natural=coastline (robustly, via
// polygon difference); linear waterway=river/canal/stream as thin strokes.

// --- raw Overpass `out geom` shapes (only the fields we read) ---

type RawGeom = { lat: number; lon: number };
type RawWay = { type: "way"; id?: number; tags?: Record<string, string>; geometry?: RawGeom[] };
type RawMember = { type?: string; ref?: number; role?: string; geometry?: RawGeom[] };
type RawRel = { type: "relation"; id?: number; tags?: Record<string, string>; members?: RawMember[] };
type RawElement = RawWay | RawRel;
type RawOsm = { elements?: RawElement[] };

const LINE_CLASSES = new Set<WaterLineClass>(["river", "canal", "stream", "drain", "ditch"]);

/** Overpass QL fetching area water, coastline, and linear waterways. */
export function buildWaterQuery(b: Bbox): string {
  const bb = `${b.south},${b.west},${b.north},${b.east}`;
  return (
    `[out:json][timeout:90];(` +
    `way[natural=water](${bb});way[waterway=riverbank](${bb});` +
    `way[water](${bb});way[landuse=reservoir](${bb});way[landuse=basin](${bb});` +
    `relation[natural=water](${bb});relation[waterway=riverbank](${bb});` +
    `relation[water](${bb});relation[landuse=reservoir](${bb});relation[landuse=basin](${bb});` +
    `way[natural=coastline](${bb});` +
    `way[waterway=river](${bb});way[waterway=canal](${bb});way[waterway=stream](${bb});` +
    `way[waterway=drain](${bb});way[waterway=ditch](${bb});` +
    `);out geom;`
  );
}

/** Fetch the water layer for `b`. Shares overpass.ts mirror/retry handling. */
export async function fetchWater(
  b: Bbox,
  mirrors: readonly string[] = MIRRORS,
  opts: FetchOptions = {},
): Promise<RawOsm> {
  return (await fetchOverpass(buildWaterQuery(b), mirrors, opts)) as RawOsm;
}

// --- geometry helpers ---

const TOL = 1e-7; // ~1cm; endpoint-match precision (before final coord rounding)
const qkey = (p: RawGeom) => `${Math.round(p.lat / TOL)},${Math.round(p.lon / TOL)}`;
const samePt = (a: RawGeom, b: RawGeom) => Math.abs(a.lat - b.lat) < TOL && Math.abs(a.lon - b.lon) < TOL;

/** Drop consecutive duplicate points (cheap, avoids zero-length segments). */
function dedupeAdjacent(pts: RawGeom[]): RawGeom[] {
  const out: RawGeom[] = [];
  for (const p of pts) if (out.length === 0 || !samePt(out[out.length - 1], p)) out.push(p);
  return out;
}

/**
 * Greedily join segments sharing endpoints into maximal chains, tracking which
 * input-segment indices went into each chain. When `directed` (coastline), only
 * forward joins are used so each chain keeps its land-left/water-right
 * orientation; otherwise (area rings) segments may be reversed to close a ring —
 * orientation doesn't matter there (even-odd fill).
 */
function stitchIdx(segs: RawGeom[][], directed: boolean): Array<{ pts: RawGeom[]; idxs: number[] }> {
  const used = new Array(segs.length).fill(false);
  const out: Array<{ pts: RawGeom[]; idxs: number[] }> = [];
  for (let s = 0; s < segs.length; s++) {
    if (used[s] || segs[s].length < 2) continue;
    used[s] = true;
    let chain = segs[s].slice();
    const idxs = [s];
    let extended = true;
    while (extended) {
      extended = false;
      const head = qkey(chain[0]);
      const tail = qkey(chain[chain.length - 1]);
      for (let j = 0; j < segs.length; j++) {
        if (used[j] || segs[j].length < 2) continue;
        const seg = segs[j];
        const f = qkey(seg[0]);
        const l = qkey(seg[seg.length - 1]);
        if (tail === f) chain = chain.concat(seg.slice(1));
        else if (head === l) chain = seg.slice(0, -1).concat(chain);
        else if (!directed && tail === l) chain = chain.concat(seg.slice(0, -1).reverse());
        else if (!directed && head === f) chain = seg.slice(1).reverse().concat(chain);
        else continue;
        used[j] = true;
        idxs.push(j);
        extended = true;
        break;
      }
    }
    out.push({ pts: dedupeAdjacent(chain), idxs });
  }
  return out;
}

const stitch = (segs: RawGeom[][], directed: boolean): RawGeom[][] => stitchIdx(segs, directed).map((g) => g.pts);

const isClosed = (ring: RawGeom[]) => ring.length >= 4 && samePt(ring[0], ring[ring.length - 1]);

/** Ray-cast point-in-polygon (treats the ring as implicitly closed). lon=x, lat=y. */
function pointInRing(pt: RawGeom, ring: RawGeom[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i].lat, xi = ring[i].lon, yj = ring[j].lat, xj = ring[j].lon;
    if ((yi > pt.lat) !== (yj > pt.lat) && pt.lon < ((xj - xi) * (pt.lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Build outer rings with inner rings assigned as holes by containment. */
function assemblePolygons(outers: RawGeom[][], inners: RawGeom[][]): WaterPolygon[] {
  const polys = outers.filter((r) => r.length >= 3).map((outer) => ({ outer, holes: [] as RawGeom[][] }));
  for (const hole of inners) {
    if (hole.length < 3) continue;
    const host = polys.find((p) => pointInRing(hole[0], p.outer));
    if (host) host.holes.push(hole);
  }
  return polys.map((p) => (p.holes.length ? p : { outer: p.outer }));
}

// --- coastline → ocean (robust: build land polygons, subtract from bbox) ---

/** Clip segment p0→p1 to the bbox (Liang–Barsky). Returns the inside portion. */
function clipSeg(
  p0: RawGeom,
  p1: RawGeom,
  b: Bbox,
): { a: RawGeom; c: RawGeom; entered: boolean; exited: boolean } | null {
  const dx = p1.lon - p0.lon, dy = p1.lat - p0.lat;
  const p = [-dx, dx, -dy, dy];
  const q = [p0.lon - b.west, b.east - p0.lon, p0.lat - b.south, b.north - p0.lat];
  let t0 = 0, t1 = 1;
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return null;
    } else {
      const r = q[i] / p[i];
      if (p[i] < 0) {
        if (r > t1) return null;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return null;
        if (r < t1) t1 = r;
      }
    }
  }
  return {
    a: { lon: p0.lon + t0 * dx, lat: p0.lat + t0 * dy },
    c: { lon: p0.lon + t1 * dx, lat: p0.lat + t1 * dy },
    entered: t0 > 0,
    exited: t1 < 1,
  };
}

/** Clip a polyline to the bbox, returning the inside runs (in original order). */
function clipPolyline(poly: RawGeom[], b: Bbox): RawGeom[][] {
  const runs: RawGeom[][] = [];
  let cur: RawGeom[] | null = null;
  for (let i = 0; i + 1 < poly.length; i++) {
    const r = clipSeg(poly[i], poly[i + 1], b);
    if (!r) {
      if (cur) { runs.push(cur); cur = null; }
      continue;
    }
    if (!cur) cur = [r.a, r.c];
    else if (r.entered) { runs.push(cur); cur = [r.a, r.c]; }
    else cur.push(r.c);
    if (r.exited) { runs.push(cur); cur = null; }
  }
  if (cur) runs.push(cur);
  return runs.map(dedupeAdjacent).filter((r) => r.length >= 2);
}

const BTOL = 1e-9;
/**
 * Position of a boundary point along the bbox perimeter, in [0,4), increasing
 * clockwise (geographic y-up) from the NW corner: N→E→S→W edge.
 */
function perimeterParam(p: RawGeom, b: Bbox): number {
  const w = b.east - b.west, h = b.north - b.south;
  if (Math.abs(p.lat - b.north) < BTOL) return (p.lon - b.west) / w; // N: W→E  [0,1)
  if (Math.abs(p.lon - b.east) < BTOL) return 1 + (b.north - p.lat) / h; // E: N→S  [1,2)
  if (Math.abs(p.lat - b.south) < BTOL) return 2 + (b.east - p.lon) / w; // S: E→W  [2,3)
  return 3 + (p.lat - b.south) / h; // W: S→N  [3,4)
}

const onBoundary = (p: RawGeom, b: Bbox) =>
  Math.abs(p.lat - b.north) < BTOL || Math.abs(p.lat - b.south) < BTOL ||
  Math.abs(p.lon - b.east) < BTOL || Math.abs(p.lon - b.west) < BTOL;

function corner(idx: number, b: Bbox): RawGeom {
  switch (((idx % 4) + 4) % 4) {
    case 0: return { lat: b.north, lon: b.west }; // NW
    case 1: return { lat: b.north, lon: b.east }; // NE
    case 2: return { lat: b.south, lon: b.east }; // SE
    default: return { lat: b.south, lon: b.west }; // SW
  }
}

/** Corner points crossed walking clockwise from param `from` to `to`. */
function cornersBetween(from: number, to: number, b: Bbox): RawGeom[] {
  let end = to;
  if (end < from + BTOL) end += 4;
  const out: RawGeom[] = [];
  for (let k = Math.ceil(from + BTOL); k < end - BTOL; k++) out.push(corner(k, b));
  return out;
}

const toRing = (pts: RawGeom[]): Ring => pts.map((p) => [p.lon, p.lat]);
const ringToGeom = (r: Ring): Geom[] => r.map(([lon, lat]) => ({ lat, lon }));

/**
 * Trace ocean outer rings from the open coastline runs (each crossing the bbox,
 * land on the left / water on the right). From each run's exit point we walk the
 * bbox perimeter clockwise — keeping water on the right — to the next run's
 * entry, inserting the bbox corners crossed, and chain runs until the loop
 * closes. Walking all runs together (rather than per-run) is what gets
 * multi-bay coasts like Sydney Harbour right.
 */
function oceanOutlines(open: RawGeom[][], b: Bbox): RawGeom[][] {
  const runs = open.map((pts) => ({
    pts,
    entry: perimeterParam(pts[0], b),
    exit: perimeterParam(pts[pts.length - 1], b),
  }));
  const nextOf = runs.map((r) => {
    let best = -1, bestGap = Infinity;
    for (let j = 0; j < runs.length; j++) {
      const gap = (((runs[j].entry - r.exit) % 4) + 4) % 4;
      if (gap < bestGap) { bestGap = gap; best = j; }
    }
    return best;
  });

  const rings: RawGeom[][] = [];
  const used = new Array(runs.length).fill(false);
  for (let s = 0; s < runs.length; s++) {
    if (used[s]) continue;
    const ring: RawGeom[] = [];
    let cur = s;
    for (let guard = 0; guard <= runs.length; guard++) {
      used[cur] = true;
      ring.push(...runs[cur].pts);
      const nxt = nextOf[cur];
      ring.push(...cornersBetween(runs[cur].exit, runs[nxt].entry, b));
      if (nxt === s) break;
      cur = nxt;
    }
    if (ring.length >= 3) rings.push(ring);
  }
  return rings;
}

/**
 * Turn coastline ways into ocean fill polygons. Ocean outer rings come from the
 * perimeter walk (oceanOutlines); islands are subtracted as holes with a
 * polygon-boolean so even overlapping/awkward cases resolve cleanly. Islands
 * are found with an UNDIRECTED stitch so a loop with an OSM direction error
 * still closes — that is the fix for islands (e.g. Macau's Taipa) being filled
 * as sea. When no coastline crosses the bbox, `seaIfEmpty` (from the road
 * count) decides whether the whole bbox is sea.
 */
function buildOcean(coastWays: RawGeom[][], b: Bbox, seaIfEmpty: boolean): WaterPolygon[] {
  const rectRing: RawGeom[] = [
    { lat: b.south, lon: b.west }, { lat: b.south, lon: b.east },
    { lat: b.north, lon: b.east }, { lat: b.north, lon: b.west },
  ];
  if (coastWays.length === 0) return seaIfEmpty ? [{ outer: rectRing }] : [];

  // Separate coastline into closed loops (= islands, even if they poke slightly
  // past the bbox edge) and open chains (= mainland coast that exits the bbox).
  // Undirected stitch so a loop with an OSM direction error still closes. We
  // track way membership so island ways are excluded from the ocean perimeter
  // walk below — otherwise an island poking past the edge would be mistaken for
  // a mainland crossing and its land filled as sea (the Macau/Taipa bug).
  const islands: RawGeom[][] = [];
  const islandWays = new Set<number>();
  for (const g of stitchIdx(coastWays, false)) {
    if (isClosed(g.pts) && g.pts.length >= 4) {
      islands.push(g.pts);
      for (const i of g.idxs) islandWays.add(i);
    }
  }
  const mainland = coastWays.filter((_, i) => !islandWays.has(i));

  // Open mainland crossings → ocean outer rings (perimeter walk).
  const open: RawGeom[][] = [];
  for (const chain of stitch(mainland, true)) {
    for (const run of clipPolyline(chain, b)) {
      if (!isClosed(run) && onBoundary(run[0], b) && onBoundary(run[run.length - 1], b)) open.push(run);
    }
  }
  // Ocean outer rings: trace them from the open mainland crossings. If there are
  // none — or tracing degenerates to nothing — the whole bbox is sea exactly when
  // we expect open water here: a coastless, roadless tile (`seaIfEmpty`) or one
  // holding islands that must sit in sea. Otherwise there's no ocean to fill.
  let oceanRings = open.length > 0 ? oceanOutlines(open, b) : [];
  if (oceanRings.length === 0) {
    if (!seaIfEmpty && islands.length === 0) return [];
    oceanRings = [rectRing];
  }

  // No islands: emit ocean rings directly.
  if (islands.length === 0) return oceanRings.map((r) => ({ outer: ringToGeom(toRing(r)) }));

  // Punch islands out of the ocean via polygon difference (robust holes).
  let result: MultiPolygon;
  try {
    const oceanMP = oceanRings.map((r) => [toRing(r)]);
    const oceanU = union(oceanMP[0], ...oceanMP.slice(1));
    result = difference(oceanU, ...islands.map((r) => [toRing(r)]));
  } catch {
    // polygon-clipping can throw on degenerate input; fall back to ocean
    // outlines without island holes rather than dropping the sea entirely.
    return oceanRings.map((r) => ({ outer: ringToGeom(toRing(r)) }));
  }

  const out: WaterPolygon[] = [];
  for (const poly of result) {
    const outer = ringToGeom(poly[0]);
    if (outer.length < 3) continue;
    const holes = poly.slice(1).map(ringToGeom).filter((h) => h.length >= 3);
    out.push(holes.length ? { outer, holes } : { outer });
  }
  return out;
}

// --- top-level: raw Overpass response → slim WaterFeature[] ---

const AREA_TAGS: Array<[string, string | null]> = [
  ["natural", "water"],
  ["waterway", "riverbank"],
  ["water", null],
  ["landuse", "reservoir"],
  ["landuse", "basin"],
];

const isAreaTagged = (tags?: Record<string, string>) =>
  !!tags && AREA_TAGS.some(([k, v]) => tags[k] !== undefined && (v === null || tags[k] === v));

/**
 * Assemble a raw water/coastline/waterway Overpass response into slim,
 * render-ready features. `roadCount` feeds the no-coastline sea heuristic.
 * Coordinates are rounded to `coordPrecision` decimals at the end (after
 * endpoint matching, which needs full precision).
 */
export function slimWater(raw: RawOsm, b: Bbox, roadCount: number, coordPrecision?: number): WaterFeature[] {
  const elements = raw.elements ?? [];

  const memberIds = new Set<number>();
  const relations: RawRel[] = [];
  for (const el of elements) {
    if (el.type === "relation" && isAreaTagged(el.tags)) {
      relations.push(el);
      for (const m of el.members ?? []) if (m.type === "way" && m.ref !== undefined) memberIds.add(m.ref);
    }
  }

  const features: WaterFeature[] = [];

  // Multipolygon relations → outer rings with holes.
  for (const rel of relations) {
    const outers: RawGeom[][] = [];
    const inners: RawGeom[][] = [];
    for (const m of rel.members ?? []) {
      if (m.type !== "way" || !m.geometry || m.geometry.length < 2) continue;
      (m.role === "inner" ? inners : outers).push(m.geometry);
    }
    for (const poly of assemblePolygons(stitch(outers, false), stitch(inners, false))) {
      features.push({ kind: "area", polygon: poly });
    }
  }

  // Standalone ways: coastline, closed area polygons, and linear waterways.
  const coastWays: RawGeom[][] = [];
  for (const el of elements) {
    if (el.type !== "way" || !el.geometry || el.geometry.length < 2) continue;
    if (el.tags?.natural === "coastline") {
      coastWays.push(el.geometry);
      continue;
    }
    if (el.id !== undefined && memberIds.has(el.id)) continue;
    if (isAreaTagged(el.tags)) {
      if (isClosed(el.geometry)) features.push({ kind: "area", polygon: { outer: dedupeAdjacent(el.geometry) } });
      continue;
    }
    const wt = el.tags?.waterway as WaterLineClass | undefined;
    if (wt && LINE_CLASSES.has(wt) && el.tags?.tunnel !== "yes") {
      // drain/ditch are usually anonymous roadside/field channels; keep only
      // the named ones — that captures urban rivers loosely tagged as drain
      // (e.g. Nanyang's 三里河) without flooding other cities with every ditch.
      // river/canal/stream are kept regardless of name.
      const minor = wt === "drain" || wt === "ditch";
      if (!minor || el.tags?.name) {
        features.push({ kind: "line", cls: wt, line: dedupeAdjacent(el.geometry) });
      }
    }
  }

  for (const poly of buildOcean(coastWays, b, roadCount === 0)) {
    features.push({ kind: "ocean", polygon: poly });
  }

  return coordPrecision === undefined ? features : roundFeatures(features, coordPrecision);
}

function roundFeatures(features: WaterFeature[], precision: number): WaterFeature[] {
  const f = 10 ** precision;
  const r = (v: number) => Math.round(v * f) / f;
  const ring = (pts: Geom[]) => pts.map((p) => ({ lat: r(p.lat), lon: r(p.lon) }));
  return features.map((feat) => {
    if (feat.kind === "line") return { kind: "line", cls: feat.cls, line: ring(feat.line) };
    return {
      kind: feat.kind,
      polygon: {
        outer: ring(feat.polygon.outer),
        ...(feat.polygon.holes ? { holes: feat.polygon.holes.map(ring) } : {}),
      },
    };
  });
}
