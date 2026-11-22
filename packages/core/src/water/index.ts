// `@inkcity/core/water` — the water layer generalized for the map's scale, for
// `drawScene` to draw in place of the water as mapped (`DrawReq.waterShapes`).
//
// Kept out of the package's barrel, as ./schedule is: it pulls in polygon-clipping
// (for the land between bodies, ./generalize.ts), which stays out of the apps' main
// bundles. Only what draws a real map imports it — the map engines (in their
// workers, or loaded lazily where a worker can't draw), the wallpaper's renderer,
// and the scripts; a map drawn without it (the Lab tab's made-up samples) shows its
// water as mapped.

import { bboxForScreen, M_PER_DEG_LAT as M } from "../bbox";
import { MAX_HALF_KM } from "../defaults";
import { widthFor } from "../render";
import type { Bbox, Geom, Osm, WaterShapes } from "../types";
import { clipLine, clipRing } from "./clip";
import { generalize, type Generalized } from "./generalize";
import { grow } from "./geom";

export { clipLine, clipRing } from "./clip";
export { generalize } from "./generalize";

/** m: what is handed to the renderer reaches this far past the map, where no screen shows it. */
const VIEW_MARGIN = 250;

/** Where each map's generalized water was worked out from, and what came of it (undefined: it failed). */
const done = new WeakMap<object, { lat: number; lon: number; shapes: WaterShapes | undefined }>();

/**
 * The last map worked out, by what it was worked out from ({@link dataKey}): for a
 * host that parses the same data anew — the wallpaper's renderer, on each request;
 * the window, reopened after letting its map go — which `done` can't tell is the same.
 */
let last: { key: string; shapes: WaterShapes | undefined } | null = null;

/** What `waterShapes` works out from, cheaply: the place, the data's counts, and the coordinates it reads summed. */
function dataKey(osm: Osm, lat: number, lon: number): string {
  let n = 0, sum = 0;
  const add = (pts: readonly Geom[]) => { for (const g of pts) { n++; sum += 3 * g.lat + g.lon; } };
  for (const f of osm.water ?? []) {
    if (f.kind === "line") add(f.line);
    else { add(f.polygon.outer); for (const h of f.polygon.holes ?? []) add(h); }
  }
  for (const f of osm.minorWater ?? []) add(f.line);
  for (const w of osm.elements ?? []) if (w.tags?.highway && w.geometry) add(w.geometry);
  return `${lat},${lon}|${osm.v}|${osm.water?.length}|${osm.minorWater?.length}|${osm.elements?.length}|${n}|${sum}`;
}

/**
 * `osm`'s water generalized for the map's scale. `bbox` is the map's ground, or any
 * crop of it around the same place (the wallpaper's): its centre gives the plane the
 * work is done on and the square the data was fetched for (`MAX_HALF_KM` around
 * it), whose edges the water runs on past, and its longer side must span that
 * square — the scale the work is tuned for. Worked out once per map — a second
 * call, for another size or theme, or for the same data parsed anew, is free. Undefined when there is no water, when
 * `bbox` is a map of another span, or when working it out failed: the water is
 * then drawn as mapped, rather than the map not at all, and the failure is told to
 * `report` (once per map) — the console's, unless the host keeps a log of its own.
 */
export function waterShapes(osm: Osm, bbox: Bbox, report: (message: string) => void = (m) => console.error(m)): WaterShapes | undefined {
  const water = osm.water;
  if (!water?.length) return undefined;
  const lat = (bbox.south + bbox.north) / 2, lon = (bbox.west + bbox.east) / 2;
  const k = Math.cos((lat * Math.PI) / 180);
  if (Math.abs(Math.max((bbox.east - bbox.west) * M * k, (bbox.north - bbox.south) * M) - 2000 * MAX_HALF_KM) > 1) return undefined;
  const had = done.get(water);
  if (had && Math.abs(had.lat - lat) < 1e-9 && Math.abs(had.lon - lon) < 1e-9) return had.shapes;
  let shapes: WaterShapes | undefined;
  try {
    const key = dataKey(osm, lat, lon);
    if (last?.key !== key) {
      last = { key, shapes: undefined }; // a failure, should it fail: not worked out (or told) again
      const roads: Geom[][] = [], drawn: Geom[][] = [];
      for (const w of osm.elements ?? []) {
        const h = w.tags?.highway;
        if (!h || !w.geometry || w.geometry.length < 2) continue;
        roads.push(w.geometry);
        // the roads the map draws in its standard preset: what a line or a bank can be seen to run along
        if (widthFor(h, "standard", 1) !== null) drawn.push(w.geometry);
      }
      const sq = bboxForScreen(lat, lon, MAX_HALF_KM, 1);
      last.shapes = toShapes(generalize(water, lat, sq, roads, drawn, osm.minorWater ?? []), lat, sq);
    }
    shapes = last.shapes;
  } catch (e) {
    // a case the generalizer doesn't handle, or rasters it couldn't allocate — with
    // its stack, which WebKit's doesn't start with the message as V8's does
    const why = e instanceof Error ? `${e.name}: ${e.message}\n${e.stack ?? ""}` : String(e);
    report(`couldn't generalize the water, so it's drawn as mapped: ${why}`);
  }
  done.set(water, { lat, lon, shapes });
  return shapes;
}

/** The shapes cut to the map and a margin (`sq`, the map's ground), and the plane's metres back to lat/lon. */
function toShapes(g: Generalized, lat0: number, sq: Bbox): WaterShapes {
  const k = Math.cos((lat0 * Math.PI) / 180);
  const view = grow({ x0: sq.west * M * k, y0: sq.south * M, x1: sq.east * M * k, y1: sq.north * M }, VIEW_MARGIN);
  const geo = (v: { x: number; y: number }): Geom => ({ lat: v.y / M, lon: v.x / (M * k) });
  const fills: Geom[][][] = [];
  for (const rs of g.fills) {
    const body = rs.map((r) => clipRing(r, view)).filter((r) => r.length >= 3);
    if (body.length) fills.push(body.map((r) => r.map(geo)));
  }
  const lines: WaterShapes["lines"] = [];
  for (const l of g.lines) for (const pts of clipLine(l.pts, view)) lines.push({ cls: l.cls, line: pts.map(geo), corner: pts.map((v) => v.corner) });
  return { fills, lines };
}
