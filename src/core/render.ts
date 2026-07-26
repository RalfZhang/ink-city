import type { Bbox, Geom, Osm, Style, StylePreset, Way } from "./types";
import { project } from "./bbox";
import { WATER_ALPHA, RUNWAY_ALPHA, RAILWAY_ALPHA } from "./constants";

// Pure canvas-drawing logic, decoupled from any IO. Takes a 2D context so it
// works with a DOM canvas (desktop renderer + website) and with a headless
// canvas (e.g. node-canvas / OffscreenCanvas in CI). The caller owns creating
// the canvas and exporting the PNG. `drawScene` is the entry point; the
// per-layer `drawX` functions are exported for reuse/testing.

// ─────────────────────────────────────────────────────────────────────────────
// Visual design tokens
//
// The product's whole visual language lives here as plain data, so it can be
// read and tuned in one place instead of being chased through five drawing
// functions. Every value is a *weight* in "px at 1000px tall"; multiply by
// `strokeScale(height)` at draw time so strokes stay consistent across canvas
// sizes. Layer opacities that the Lab-tab UI also reads live in constants.ts
// (WATER_ALPHA / RUNWAY_ALPHA / RAILWAY_ALPHA); the aerialway opacities are
// render-only and stay here with the rest of its knobs.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Road stroke weight per OSM `highway` class, per preset — the road hierarchy as
 * pure design data. `null` = don't draw that class. A class not listed falls
 * back to {@link ROAD_WEIGHT_DEFAULT} for the preset (for `minimal` that default
 * is `null`, i.e. minimal draws *only* the majors listed here).
 */
const ROAD_WEIGHTS: Record<StylePreset, Partial<Record<string, number | null>>> = {
  minimal: {
    motorway: 1.4, trunk: 1.4, primary: 1.4, secondary: 1.4, tertiary: 1.4,
  },
  standard: {
    motorway: 2.5, trunk: 2.0, primary: 1.5, secondary: 1.2, tertiary: 1.0,
    residential: 0.7, living_street: 0.7, service: 0.5, pedestrian: 0.4,
    footway: 0.3, cycleway: 0.3, path: 0.3,
    proposed: null, construction: null,
  },
  bold: {
    motorway: 4.0, trunk: 3.5, primary: 2.5, secondary: 1.8, tertiary: 1.2,
    residential: 0.5, living_street: 0.5, service: 0.3,
    footway: 0.2, cycleway: 0.2, path: 0.2,
    proposed: null, construction: null,
  },
};

/** Weight for a `highway` class not listed in {@link ROAD_WEIGHTS} for the preset. */
const ROAD_WEIGHT_DEFAULT: Record<StylePreset, number | null> = {
  minimal: null, // minimal draws only the majors it lists explicitly
  standard: 0.4,
  bold: 0.25,
};

/** Linear-waterway stroke weight per class; unlisted classes (stream/drain/ditch) use the default. */
const WATER_LINE_WEIGHTS: Record<string, number> = { river: 1.6, canal: 1.3 };
const WATER_LINE_WEIGHT_DEFAULT = 0.7;

/** Runway/taxiway stroke weights (fixed, not scaled by preset — see drawAirports). */
const AIRPORT_WIDTHS = { taxiway: 1.5, runway: 5 } as const;

/** Railway dashed-line stroke weight and [dash, gap] pattern. */
const RAILWAY_WIDTH = 0.9;
const RAILWAY_DASH: readonly [number, number] = [4.5, 3.5];

/** Aerialway (cable car / ropeway) knobs: the cable line and the cabin dots. */
const AERIALWAY = {
  lineAlpha: 0.5,
  lineWidth: 0.6,
  dotAlpha: 0.7,
  dotRadius: 1.1,
  dotSpacing: 12,
} as const;

/**
 * DPR-style stroke scale: ~1.0 at 1000px tall, floored at 1 so small canvases
 * keep legible strokes. Every layer multiplies its px-at-1000 weight by this.
 */
function strokeScale(height: number): number {
  return Math.max(1, height / 1000);
}

/**
 * Stroke width (in canvas pixels) for an OSM `highway` tag under `preset`.
 * `null` skips drawing. `scale` is a DPR-style factor (see {@link strokeScale}).
 * Looks the class up in the {@link ROAD_WEIGHTS} table; `_link` ramps are
 * normalized to their base class first.
 */
export function widthFor(highway: string | undefined, preset: StylePreset, scale: number): number | null {
  const t = (highway ?? "").replace(/_link$/, "");
  const raw = ROAD_WEIGHTS[preset][t];
  const weight = raw === undefined ? ROAD_WEIGHT_DEFAULT[preset] : raw;
  return weight == null ? null : scale * weight;
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

/**
 * Trace an open polyline (≥2 points) onto the current path, projecting each
 * lat/lon to canvas space. The caller owns `beginPath()` (so many polylines can
 * share one path/stroke) and the final `stroke()`/`fill()`.
 */
function tracePolyline(ctx: CanvasRenderingContext2D, pts: Geom[], bbox: Bbox, width: number, height: number): void {
  const [x0, y0] = project(pts[0].lat, pts[0].lon, bbox, width, height);
  ctx.moveTo(x0, y0);
  for (let i = 1; i < pts.length; i++) {
    const [x, y] = project(pts[i].lat, pts[i].lon, bbox, width, height);
    ctx.lineTo(x, y);
  }
}

/** Trace one closed ring onto the current path (a polyline plus `closePath`). */
function addRing(ctx: CanvasRenderingContext2D, ring: Geom[], bbox: Bbox, width: number, height: number): void {
  if (ring.length < 2) return;
  tracePolyline(ctx, ring, bbox, width, height);
  ctx.closePath();
}

/** Stroke width (px) for a linear waterway, scaled like roads. */
function waterLineWidth(cls: string, scale: number): number {
  return scale * (WATER_LINE_WEIGHTS[cls] ?? WATER_LINE_WEIGHT_DEFAULT);
}

/**
 * Draw the water layer: filled bodies (lakes, sea) plus thin linear waterways
 * (creeks/canals). Gated by the user's "show water" setting (default off) and a
 * no-op when the data has no `water` key (only possible for data cached before
 * the water layer shipped), so older payloads degrade gracefully. Polygon holes
 * (islands) are punched out with the even-odd rule, which is winding-direction
 * agnostic — water.ts only guarantees rings are closed, not their orientation.
 */
export function drawWater(ctx: CanvasRenderingContext2D, req: DrawReq): void {
  const water = req.osm.water;
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
  const scale = strokeScale(height);
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
    for (const line of lines) tracePolyline(ctx, line, bbox, width, height);
    ctx.stroke();
  }
}

/**
 * Draw the airport layer: taxiways (thin) drawn first, then runways (thick) on
 * top so a runway crossing a taxiway stays unbroken. Both are stroked
 * centerlines sharing one color, differing only in width. Square (`butt`) caps,
 * unlike roads' round ones — a runway/taxiway is a rectangular strip, not a
 * network of joined lines. Gated by the "show airports" Lab toggle (default
 * off), and a no-op when the data has no `airports` key. Runways/taxiways use
 * fixed widths rather than a real-world scale: OSM rarely tags `width` on them,
 * and unlike roads there's no hierarchy to differentiate by preset.
 */
export function drawAirports(ctx: CanvasRenderingContext2D, req: DrawReq): void {
  const airports = req.osm.airports;
  if (!req.style.showAirports || !airports || airports.length === 0) return;
  const { bbox, width, height, style } = req;
  const lineColor = mixColor(style.foreground, style.background, RUNWAY_ALPHA);
  const scale = strokeScale(height);

  ctx.strokeStyle = lineColor;
  ctx.lineCap = "butt";
  ctx.lineJoin = "round";
  const strokeKind = (kind: "runway" | "taxiway", weight: number) => {
    ctx.lineWidth = scale * weight;
    ctx.beginPath();
    for (const f of airports) {
      if (f.kind !== kind || f.line.length < 2) continue;
      tracePolyline(ctx, f.line, bbox, width, height);
    }
    ctx.stroke();
  };
  strokeKind("taxiway", AIRPORT_WIDTHS.taxiway);
  strokeKind("runway", AIRPORT_WIDTHS.runway);
}

/**
 * Draw the railway layer: surface rail centerlines as a dashed line — the
 * classic cartographic railway symbol, visually distinct from the solid road
 * network. Gated by the "show railways" Lab toggle (default off), and a no-op
 * when the data has no `railways` key. Butt caps give clean rectangular dash
 * segments; the dash is reset before returning so it can't leak into a later
 * layer's path.
 */
export function drawRailways(ctx: CanvasRenderingContext2D, req: DrawReq): void {
  const railways = req.osm.railways;
  if (!req.style.showRailways || !railways || railways.length === 0) return;
  const { bbox, width, height, style } = req;
  const color = mixColor(style.foreground, style.background, RAILWAY_ALPHA);
  const scale = strokeScale(height);

  ctx.strokeStyle = color;
  ctx.lineCap = "butt";
  ctx.lineJoin = "round";
  ctx.lineWidth = scale * RAILWAY_WIDTH;
  ctx.setLineDash([scale * RAILWAY_DASH[0], scale * RAILWAY_DASH[1]]);
  ctx.beginPath();
  for (const f of railways) {
    if (f.line.length < 2) continue;
    tracePolyline(ctx, f.line, bbox, width, height);
  }
  ctx.stroke();
  ctx.setLineDash([]); // don't leak the dash into later layers
}

/**
 * Draw the aerialway layer (cable cars / ropeways) in OSM's default symbol: a
 * thin continuous "cable" line with round "cabin" dots strung along it at even
 * arc-length spacing — the line reads as the cable, the dots as the cars,
 * distinct from both the solid roads and the dashed railways. Gated by the
 * "show cable cars" Lab toggle (default off), and a no-op when the data has no
 * `aerialways` key.
 *
 * Dots are placed by walking each polyline in screen space and stepping a
 * running distance so spacing is uniform regardless of how densely the source
 * vertices are sampled; the carry across segments keeps the rhythm unbroken
 * through the bends. See the {@link AERIALWAY} tokens for the tuning knobs.
 */
export function drawAerialways(ctx: CanvasRenderingContext2D, req: DrawReq): void {
  const aerialways = req.osm.aerialways;
  if (!req.style.showAerialways || !aerialways || aerialways.length === 0) return;
  const { bbox, width, height, style } = req;
  const lineColor = mixColor(style.foreground, style.background, AERIALWAY.lineAlpha);
  const dotColor = mixColor(style.foreground, style.background, AERIALWAY.dotAlpha);
  const scale = strokeScale(height);
  const dotRadius = scale * AERIALWAY.dotRadius;
  const dotSpacing = scale * AERIALWAY.dotSpacing;

  // Project once and reuse for both the line and the dots.
  const lines: [number, number][][] = [];
  for (const f of aerialways) {
    if (f.line.length < 2) continue;
    lines.push(f.line.map((p) => project(p.lat, p.lon, bbox, width, height)));
  }

  // 1) the continuous cable line.
  ctx.strokeStyle = lineColor;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = scale * AERIALWAY.lineWidth;
  ctx.beginPath();
  for (const pts of lines) {
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  }
  ctx.stroke();

  // 2) evenly spaced cabin dots along each cable. `dist` is the arc length until
  // the next dot: start at 0 (dot at the cable's start), and carry the remainder
  // across segment boundaries so spacing stays uniform through the bends.
  ctx.fillStyle = dotColor;
  for (const pts of lines) {
    let dist = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[i + 1];
      const segLen = Math.hypot(x1 - x0, y1 - y0);
      if (segLen === 0) continue;
      while (dist <= segLen) {
        const t = dist / segLen;
        ctx.beginPath();
        ctx.arc(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, dotRadius, 0, Math.PI * 2);
        ctx.fill();
        dist += dotSpacing;
      }
      dist -= segLen;
    }
  }
}

/**
 * Draw only the road network onto `ctx` and return the number of ways drawn.
 * Assumes the background (and any under-road layers) are already painted —
 * {@link drawScene} owns compositing order. Ways are grouped by stroke width and
 * drawn thinnest-first so heavier roads layer on top.
 */
export function drawRoads(ctx: CanvasRenderingContext2D, req: DrawReq): number {
  const { bbox, width, height, style, osm } = req;

  ctx.strokeStyle = style.foreground;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // Scale stroke widths to canvas size so densities look consistent.
  const scale = strokeScale(height);

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
      tracePolyline(ctx, el.geometry!, bbox, width, height);
      drawn++;
    }
    ctx.stroke();
  }
  return drawn;
}

// Optional layers drawn under the road network (z-order, bottom → up).
const UNDER_ROADS: ((ctx: CanvasRenderingContext2D, req: DrawReq) => void)[] = [drawWater];
// Optional layers drawn over the road network (z-order, bottom → up).
const OVER_ROADS: ((ctx: CanvasRenderingContext2D, req: DrawReq) => void)[] = [
  drawRailways,
  drawAerialways,
  drawAirports,
];

/**
 * Compose the full wallpaper onto `ctx` and return the number of road ways drawn
 * (for logging). This is the single source of truth for layer compositing order:
 *
 *   background ▸ water ▸ ROADS ▸ railways ▸ aerialways ▸ airports
 *
 * Roads are the always-present anchor and split the optional layers into those
 * drawn under vs. over them. The over-road layers sit on top on purpose:
 * railways (dashed) read as one continuous line across grade crossings;
 * aerialways are overhead cables; runways/taxiways sit over the roads that
 * tunnel beneath them (overpasses across active runways are precluded by
 * airspace clearance), so the airport network reads as one continuous shape
 * instead of being chopped up by the roads underneath. Each optional layer
 * self-gates on its Style toggle + data presence, so a disabled or absent layer
 * is a no-op.
 */
export function drawScene(ctx: CanvasRenderingContext2D, req: DrawReq): number {
  const { width, height, style } = req;

  ctx.fillStyle = style.background;
  ctx.fillRect(0, 0, width, height);

  for (const draw of UNDER_ROADS) draw(ctx, req);
  const drawn = drawRoads(ctx, req);
  for (const draw of OVER_ROADS) draw(ctx, req);
  return drawn;
}
