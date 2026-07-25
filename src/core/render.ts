import type { Bbox, Geom, Osm, Style, StylePreset, Way } from "./types";
import { project } from "./bbox";
import { WATER_ALPHA, RUNWAY_ALPHA, RAILWAY_ALPHA } from "./constants";

// Pure canvas-drawing logic, decoupled from any IO. Takes a 2D context so it
// works with a DOM canvas (desktop renderer + website) and with a headless
// canvas (e.g. node-canvas / OffscreenCanvas in CI). The caller owns creating
// the canvas and exporting the PNG.

/**
 * Stroke width (in canvas pixels) for an OSM `highway` tag under `preset`.
 * `null` skips drawing. `scale` is a DPR-style factor so widths look
 * consistent across screen densities.
 */
export function widthFor(highway: string | undefined, preset: StylePreset, scale: number): number | null {
  const t = (highway ?? "").replace(/_link$/, "");
  if (preset === "minimal") {
    if (["motorway", "trunk", "primary", "secondary", "tertiary"].includes(t)) {
      return scale * 1.4;
    }
    return null;
  }
  if (preset === "bold") {
    switch (t) {
      case "motorway":     return scale * 4.0;
      case "trunk":        return scale * 3.5;
      case "primary":      return scale * 2.5;
      case "secondary":    return scale * 1.8;
      case "tertiary":     return scale * 1.2;
      case "residential":
      case "living_street":return scale * 0.5;
      case "service":      return scale * 0.3;
      case "footway":
      case "cycleway":
      case "path":         return scale * 0.2;
      case "proposed":
      case "construction": return null;
      default:             return scale * 0.25;
    }
  }
  // standard
  switch (t) {
    case "motorway":     return scale * 2.5;
    case "trunk":        return scale * 2.0;
    case "primary":      return scale * 1.5;
    case "secondary":    return scale * 1.2;
    case "tertiary":     return scale * 1.0;
    case "residential":
    case "living_street":return scale * 0.7;
    case "service":      return scale * 0.5;
    case "pedestrian":   return scale * 0.4;
    case "footway":
    case "cycleway":
    case "path":         return scale * 0.3;
    case "proposed":
    case "construction": return null;
    default:             return scale * 0.4;
  }
}

export type DrawReq = {
  bbox: Bbox;
  width: number;
  height: number;
  style: Style;
  osm: Osm;
};

/**
 * Parse a `#rgb` / `#rrggbb` hex string into [r,g,b] (0-255). Returns null for
 * anything we don't recognize (e.g. named colors) so callers can skip blending.
 */
function parseHex(c: string): [number, number, number] | null {
  const m = c.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return null;
  const h = m[1];
  const full = h.length === 3 ? h.replace(/(.)/g, "$1$1") : h;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

const hex2 = (n: number) => Math.round(n).toString(16).padStart(2, "0");

/**
 * Water color: foreground composited over background at {@link WATER_ALPHA},
 * baked into a single opaque color. Drawing water as this solid color (rather
 * than using `globalAlpha`) is mathematically identical here — water always
 * sits directly on the painted background — but it won't darken where two water
 * polygons overlap, and needs no offscreen canvas. Falls back to the raw
 * foreground if either color isn't a hex we can parse.
 */
export function mixColor(foreground: string, background: string, alpha = WATER_ALPHA): string {
  const fg = parseHex(foreground);
  const bg = parseHex(background);
  if (!fg || !bg) return foreground;
  const mix = (i: number) => hex2(fg[i] * alpha + bg[i] * (1 - alpha));
  return `#${mix(0)}${mix(1)}${mix(2)}`;
}

/** Trace one closed ring onto the current path, projecting each lat/lon. */
function addRing(ctx: CanvasRenderingContext2D, ring: Geom[], bbox: Bbox, width: number, height: number): void {
  if (ring.length < 2) return;
  const [x0, y0] = project(ring[0].lat, ring[0].lon, bbox, width, height);
  ctx.moveTo(x0, y0);
  for (let i = 1; i < ring.length; i++) {
    const [x, y] = project(ring[i].lat, ring[i].lon, bbox, width, height);
    ctx.lineTo(x, y);
  }
  ctx.closePath();
}

/** Stroke width (px) for a linear waterway, scaled like roads (see drawRoads). */
function waterLineWidth(cls: string, scale: number): number {
  switch (cls) {
    case "river": return scale * 1.6;
    case "canal": return scale * 1.3;
    default:      return scale * 0.7; // stream / drain / ditch (thinnest)
  }
}

/**
 * Draw the water layer under the roads: filled bodies (lakes, sea) plus thin
 * linear waterways (creeks/canals). No-op when the OSM data has no `water` key
 * (only possible for data cached before the water layer shipped), so older
 * payloads degrade gracefully. Polygon holes (islands) are punched out with
 * the even-odd rule, which is winding-direction agnostic — water.ts only
 * guarantees rings are closed, not their orientation.
 */
export function drawWater(ctx: CanvasRenderingContext2D, req: DrawReq): void {
  const water = req.osm.water;
  // Gated by the user's "show water" setting (default off, see Style tab) and a
  // no-op when the data has no water layer (only possible for pre-water
  // cached data).
  if (!req.style.showWater || !water || water.length === 0) return;
  const { bbox, width, height, style } = req;
  const color = mixColor(style.foreground, style.background);

  // Filled bodies.
  ctx.fillStyle = color;
  for (const f of water) {
    if (f.kind === "line" || !f.polygon?.outer || f.polygon.outer.length < 3) continue;
    ctx.beginPath();
    addRing(ctx, f.polygon.outer, bbox, width, height);
    for (const hole of f.polygon.holes ?? []) addRing(ctx, hole, bbox, width, height);
    ctx.fill("evenodd");
  }

  // Linear waterways, grouped by width so we set lineWidth once per bucket.
  const scale = Math.max(1, height / 1000);
  ctx.strokeStyle = color;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const buckets = new Map<number, Geom[][]>();
  for (const f of water) {
    if (f.kind !== "line" || f.line.length < 2) continue;
    const w = waterLineWidth(f.cls, scale);
    const list = buckets.get(w) ?? [];
    list.push(f.line);
    buckets.set(w, list);
  }
  for (const [lw, lines] of Array.from(buckets.entries()).sort((a, b) => a[0] - b[0])) {
    ctx.lineWidth = lw;
    ctx.beginPath();
    for (const line of lines) {
      const [x0, y0] = project(line[0].lat, line[0].lon, bbox, width, height);
      ctx.moveTo(x0, y0);
      for (let i = 1; i < line.length; i++) {
        const [x, y] = project(line[i].lat, line[i].lon, bbox, width, height);
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
  }
}

/**
 * Draw the airport layer on top of the roads (see the layering note in
 * drawRoads). Two feature kinds, both stroked centerlines: taxiways (thin)
 * drawn first, then runways (thick) on top so a runway crossing a taxiway stays
 * unbroken. Gated by the user's "show airports" Lab toggle (default off), and a
 * no-op when the data has no `airports` key (older cached data, or no airport in
 * this bbox). Runways and taxiways use fixed widths rather than a real-world
 * scale: OSM rarely tags `width` on them, and unlike roads there's no hierarchy
 * to differentiate by preset.
 */
export function drawAirports(ctx: CanvasRenderingContext2D, req: DrawReq): void {
  const airports = req.osm.airports;
  if (!req.style.showAirports || !airports || airports.length === 0) return;
  const { bbox, width, height, style } = req;
  const lineColor = mixColor(style.foreground, style.background, RUNWAY_ALPHA);
  const scale = Math.max(1, height / 1000);

  // Taxiways then runways: stroked centerlines sharing one color, differing only
  // in width. Square (`butt`) caps, unlike roads' round ones — a runway/taxiway
  // is a rectangular strip, not a network of joined lines. Runways go last so
  // they sit on top of the taxiways feeding into them.
  ctx.strokeStyle = lineColor;
  ctx.lineCap = "butt";
  ctx.lineJoin = "round";
  const strokeKind = (kind: "runway" | "taxiway", lineWidth: number) => {
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    for (const f of airports) {
      if (f.kind !== kind || f.line.length < 2) continue;
      const [x0, y0] = project(f.line[0].lat, f.line[0].lon, bbox, width, height);
      ctx.moveTo(x0, y0);
      for (let i = 1; i < f.line.length; i++) {
        const [x, y] = project(f.line[i].lat, f.line[i].lon, bbox, width, height);
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
  };
  strokeKind("taxiway", scale * 1.5);
  strokeKind("runway", scale * 5);
}

/**
 * Draw the railway layer on top of the roads: surface rail centerlines as a
 * dashed line — the classic cartographic railway symbol, and visually distinct
 * from the solid road network. Gated by the user's "show railways" Lab toggle
 * (default off), and a no-op when the data has no `railways` key (older cached
 * data, or no railway in this bbox). Butt caps give clean rectangular dash
 * segments; the dash is reset before returning so it can't leak into the
 * airport layer drawn afterwards.
 */
export function drawRailways(ctx: CanvasRenderingContext2D, req: DrawReq): void {
  const railways = req.osm.railways;
  if (!req.style.showRailways || !railways || railways.length === 0) return;
  const { bbox, width, height, style } = req;
  const color = mixColor(style.foreground, style.background, RAILWAY_ALPHA);
  const scale = Math.max(1, height / 1000);

  ctx.strokeStyle = color;
  ctx.lineCap = "butt";
  ctx.lineJoin = "round";
  ctx.lineWidth = scale * 0.9;
  ctx.setLineDash([scale * 4.5, scale * 3.5]);
  ctx.beginPath();
  for (const f of railways) {
    if (f.line.length < 2) continue;
    const [x0, y0] = project(f.line[0].lat, f.line[0].lon, bbox, width, height);
    ctx.moveTo(x0, y0);
    for (let i = 1; i < f.line.length; i++) {
      const [x, y] = project(f.line[i].lat, f.line[i].lon, bbox, width, height);
      ctx.lineTo(x, y);
    }
  }
  ctx.stroke();
  ctx.setLineDash([]); // don't leak the dash into later layers (airports)
}

/** Draw the road network onto `ctx`. Returns the number of ways drawn. */
export function drawRoads(ctx: CanvasRenderingContext2D, req: DrawReq): number {
  const { bbox, width, height, style, osm } = req;

  ctx.fillStyle = style.background;
  ctx.fillRect(0, 0, width, height);

  // Water sits on the background, under everything. drawWater leaves fillStyle
  // changed, so set stroke state for roads afterwards. (Airports draw last, on
  // top of the roads — see the note at the drawAirports call below.)
  drawWater(ctx, req);

  ctx.strokeStyle = style.foreground;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // Scale stroke widths to canvas size so densities look consistent.
  // ~1.0 baseline at ~1000px tall; larger canvases get wider strokes.
  const scale = Math.max(1, height / 1000);

  // Group draws by stroke width so we don't toggle lineWidth every iteration.
  const buckets = new Map<number, Way[]>();
  for (const el of osm.elements ?? []) {
    if (el.type !== "way" || !el.geometry || el.geometry.length < 2) continue;
    const w = widthFor(el.tags?.highway, style.preset, scale);
    if (w === null) continue;
    const list = buckets.get(w) ?? [];
    list.push(el);
    buckets.set(w, list);
  }

  // Draw thinnest first so heavier roads layer on top.
  const sorted = Array.from(buckets.entries()).sort((a, b) => a[0] - b[0]);
  let drawn = 0;
  for (const [lw, ways] of sorted) {
    ctx.lineWidth = lw;
    ctx.beginPath();
    for (const el of ways) {
      const pts = el.geometry!;
      const [x0, y0] = project(pts[0].lat, pts[0].lon, bbox, width, height);
      ctx.moveTo(x0, y0);
      for (let i = 1; i < pts.length; i++) {
        const [x, y] = project(pts[i].lat, pts[i].lon, bbox, width, height);
        ctx.lineTo(x, y);
      }
      drawn++;
    }
    ctx.stroke();
  }

  // Railways sit on top of the roads (dashed centerlines), then airports on top
  // of everything. Railways-over-roads keeps the rail network reading as one
  // continuous dashed line at grade crossings instead of being chopped up by
  // the roads it crosses.
  drawRailways(ctx, req);

  // Airports go on top: where a road crosses a runway/taxiway the real-world
  // layering is almost always road-under (roads tunnel beneath runways;
  // overpasses across active runways are precluded by airspace clearance).
  // Drawing last makes the runway/taxiway network read as one continuous shape
  // rather than being broken up by the roads underneath.
  drawAirports(ctx, req);
  return drawn;
}
