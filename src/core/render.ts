import type { AirportKind, Bbox, Geom, Osm, RailwayStyle, Style, StylePreset, Way } from "./types";
import type { LayerId } from "./osm/layers";
import { project } from "./bbox";
import { WATER_ALPHA, RUNWAY_ALPHA } from "./constants";
import { fillMondrianBlocks, MONDRIAN_BACKGROUND, MONDRIAN_FOREGROUND } from "./mondrian";

// Pure canvas-drawing logic, decoupled from any IO. Takes a 2D context so it
// works with a DOM canvas (desktop renderer + website) and with a headless
// canvas (e.g. node-canvas / OffscreenCanvas in CI). The caller owns creating
// the canvas and exporting the PNG. `drawScene` is the entry point; the
// per-layer `drawX` functions are exported for reuse/testing.

// ─────────────────────────────────────────────────────────────────────────────
// Visual design tokens — the whole visual language as plain data, tunable in one
// place instead of across five drawing functions. Every value is a *weight* in
// "px at 1000px tall": multiply by `strokeScale(height)` at draw time so strokes
// read the same at any canvas size. Layer opacities the Lab-tab UI also reads
// live in constants.ts; the aerialway ones are render-only and stay here.
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

/**
 * Runway/taxiway *centerline* stroke weights (fixed, not scaled by preset — see
 * drawAirports). Area-mapped runways/taxiways carry their own width and are
 * filled, not stroked.
 */
const AIRPORT_WIDTHS = { taxiway: 1.5, runway: 5 } as const;

// ── The railway layer's three drawing modes ───────────────────────────────────
//
// Which one is used is the user's choice ({@link RailwayStyle}, the Lab-tab
// selector); `"off"` draws nothing and has no knobs. Each mode carries its own
// `alpha` rather than sharing one railway opacity, because the three spend their
// ink very differently — `banded` on two hairline edges, `ties` on a centerline
// plus ticks, `plain` on a single stroke — so a tint that balances one is not
// guaranteed to balance the next. They all happen to sit at 0.6 today; the knob
// is per-mode so that retuning one can't drag the other two with it. Every other
// value is a weight in "px at 1000px tall", scaled by {@link strokeScale}.
//
// A useful yardstick when tuning any of them: in `standard` at 1664px tall the
// widest roads are motorway 4.16px and trunk 3.33px. A railway wider than those
// takes the map over — that is a width problem, not a color one, and lowering
// alpha barely touches it.

/**
 * `plain` — one solid stroke, no pattern. The quiet option: reads as "a line that
 * isn't a road" purely by tint, with nothing to catch the eye. It is also where an
 * upgrading user lands (see `parse_config` in src-tauri/src/config.rs), being the
 * nearest survivor of the single rail line InkCity drew before the selector — that
 * one was dashed `[4.5, 3.5]` at alpha 0.7, so the width carries over but the dash
 * does not; `banded` is now what carries a pattern.
 */
const RAILWAY_PLAIN = {
  alpha: 0.6,
  width: 0.9,
} as const;

/**
 * `banded` — an ink band with paper-colored blocks cut into it, so the line reads
 * as two thin ink edges enclosing alternating light/dark blocks. The classic
 * cartographic railway, and what openstreetmap-carto draws for `railway=rail`
 * (a `#707070` casing under a white `8,8` dash).
 *
 *   ┌─── one repeat ───┐
 *   ────────────────────────────────────────  ← edge
 *   ░░░░░░░░░░▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░▓▓▓▓▓▓▓▓▓▓  ← inner
 *   ────────────────────────────────────────  ← edge
 *   └─ light ┘└─ dark ─┘
 *
 *   edge   thickness of ONE of the two thin lines flanking the middle stripe
 *   inner  width of the middle light/dark stripe
 *   light  length of a light (paper) block
 *   dark   length of a dark (solid ink) block
 *
 * So the band is `inner + 2 * edge` wide and repeats every `light + dark`.
 * `light` vs `dark` is the cheapest lever for weight: raising `light` cuts ink
 * coverage while the edges keep the symbol legible, so it quiets the layer
 * without narrowing it. `light == dark` is carto's own 50/50.
 */
const RAILWAY_BANDED = {
  alpha: 0.6,
  edge: 0.5,
  inner: 0.5,
  light: 5.0,
  dark: 5.0,
} as const;

/**
 * `ties` — a thin continuous rail with short perpendicular sleeper ticks strung
 * along it at even arc-length spacing. The hand-drawn / topographic convention;
 * no openstreetmap-carto equivalent.
 *
 *      │         │         │         │      ← tickLength (centered on the rail)
 *   ───┼─────────┼─────────┼─────────┼───   ← lineWidth
 *      └ spacing ┘
 *
 *   lineWidth   weight of the continuous centerline
 *   tickLength  total length of a tick — it straddles the line, half per side
 *   tickWidth   weight of one tick
 *   spacing     arc length between ticks
 *
 * Unlike `banded` this mode only ever adds ink, so it can't erase anything —
 * but for the same reason its ticks collide where tracks run parallel, and a
 * dense yard goes fuzzy. Widening `spacing` is the lever for that.
 */
const RAILWAY_TIES = {
  alpha: 0.6,
  lineWidth: 0.8,
  tickLength: 1.8,
  tickWidth: 0.8,
  spacing: 18,
} as const;

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

/** Trace an already-projected screen polyline (≥2 points) onto the current path. */
function traceScreen(ctx: CanvasRenderingContext2D, pts: [number, number][]): void {
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
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

// ─────────────────────────────────────────────────────────────────────────────
// The optional layers. Each self-gates twice and returns how many features it
// drew: on its own Style toggle (all default off) and on the data actually
// carrying its key — absent only for payloads cached before that layer shipped,
// which is what lets old data degrade to "none of that layer" instead of failing.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Draw the water layer: filled bodies (lakes, sea) plus thin linear waterways
 * (creeks/canals). Polygon holes (islands) are punched out with the even-odd
 * rule, which is winding-direction agnostic — water.ts only guarantees rings are
 * closed, not their orientation.
 */
export function drawWater(ctx: CanvasRenderingContext2D, req: DrawReq): number {
  const water = req.osm.water;
  if (!req.style.showWater || !water || water.length === 0) return 0;
  const { bbox, width, height, style } = req;
  const color = mixColor(style.foreground, style.background);
  let drawn = 0;

  // Filled bodies.
  ctx.fillStyle = color;
  for (const f of water) {
    if (f.kind === "line" || !f.polygon?.outer || f.polygon.outer.length < 3) continue;
    ctx.beginPath();
    addRing(ctx, f.polygon.outer, bbox, width, height);
    for (const hole of f.polygon.holes ?? []) addRing(ctx, hole, bbox, width, height);
    ctx.fill("evenodd");
    drawn++;
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
    drawn++;
  }
  for (const [lw, lines] of Array.from(buckets.entries()).sort((a, b) => a[0] - b[0])) {
    ctx.lineWidth = lw;
    ctx.beginPath();
    for (const line of lines) tracePolyline(ctx, line, bbox, width, height);
    ctx.stroke();
  }
  return drawn;
}

/**
 * Draw the airport layer, in both of the shapes OSM maps runways/taxiways in
 * (`AirportFeature` in core/types.ts): closed ways are *filled* at their true
 * footprint, open ones are *stroked* as centerlines. Areas go down first, then
 * the centerlines, and within each pass taxiways precede runways so a runway
 * crossing a taxiway stays unbroken — the same ordering openstreetmap-carto gets
 * from its `highway-area-fill` (areas, below) / `aeroways` (lines, above, runways
 * last) layer split. Both share one color, as carto's `@aeroway-fill` does.
 *
 * Areas are filled at true size with no minimum width, also matching carto, which
 * leans on the centerline's fixed width for legibility and simply hides areas
 * below z14. This canvas sits at roughly z14 anyway (a 20km bbox over a ~2560px
 * screen is ~7.8 m/px), where a 45m runway fills ~6px.
 *
 * Stroke widths are fixed rather than preset-scaled: OSM rarely tags `width` on
 * these, and unlike roads there's no hierarchy to differentiate by. Square
 * (`butt`) caps, unlike roads' round ones — a runway/taxiway is a rectangular
 * strip, not a network of joined lines.
 */
export function drawAirports(ctx: CanvasRenderingContext2D, req: DrawReq): number {
  const airports = req.osm.airports;
  if (!req.style.showAirports || !airports || airports.length === 0) return 0;
  const { bbox, width, height, style } = req;
  const inkColor = mixColor(style.foreground, style.background, RUNWAY_ALPHA);
  const scale = strokeScale(height);

  ctx.fillStyle = inkColor;
  const fillKind = (kind: AirportKind): number => {
    ctx.beginPath();
    let n = 0;
    for (const f of airports) {
      if (f.kind !== kind || !("area" in f) || f.area.length < 3) continue;
      addRing(ctx, f.area, bbox, width, height);
      n++;
    }
    if (n > 0) ctx.fill();
    return n;
  };

  ctx.strokeStyle = inkColor;
  ctx.lineCap = "butt";
  ctx.lineJoin = "round";
  const strokeKind = (kind: AirportKind, weight: number): number => {
    ctx.lineWidth = scale * weight;
    ctx.beginPath();
    let n = 0;
    for (const f of airports) {
      if (f.kind !== kind || !("line" in f) || f.line.length < 2) continue;
      tracePolyline(ctx, f.line, bbox, width, height);
      n++;
    }
    if (n > 0) ctx.stroke();
    return n;
  };

  return (
    fillKind("taxiway") +
    fillKind("runway") +
    strokeKind("taxiway", AIRPORT_WIDTHS.taxiway) +
    strokeKind("runway", AIRPORT_WIDTHS.runway)
  );
}

/**
 * Stitch railway ways into maximal continuous chains.
 *
 * OSM splits one line into many short ways — in Leipzig the median way is 91 m,
 * and two thirds are shorter than a single `light + dark` repeat — while a canvas
 * dash pattern restarts its phase at every `moveTo`. Drawn per way, most features
 * would show only the head of their first block and the alternating rhythm would
 * be gone entirely. Joining first makes the phase run the length of the real line
 * (Leipzig: 1545 ways → 144 chains, median 12px → 151px on a 2560x1664 canvas).
 *
 * Ways are joined only where exactly two of them meet, so a chain breaks at a
 * switch or junction — a real topological feature — rather than at an arbitrary
 * data split. Endpoints are matched on coordinates quantized to ~1cm: consecutive
 * ways share one OSM node, so the values are already identical, and the payload
 * has usually been coordinate-rounded on top of that (see osm/railways.ts).
 *
 * Done at draw time rather than baked into the payload, so the fix applies to
 * already-cached cities and needs no OSM_SCHEMA_VERSION bump.
 *
 * Exported for `pnpm railway-test` (scripts/railway-test.ts) — it's the one piece of
 * the railway layer that's pure graph work rather than canvas calls, so it's also the
 * one piece testable without a canvas.
 */
export function chainRailways(features: readonly { line: Geom[] }[]): Geom[][] {
  const ways = features.map((f) => f.line).filter((l) => l.length >= 2);
  const key = (p: Geom) => `${Math.round(p.lat * 1e7)},${Math.round(p.lon * 1e7)}`;

  // node → indices of the ways that have an endpoint there
  const at = new Map<string, number[]>();
  ways.forEach((w, i) => {
    for (const k of [key(w[0]), key(w[w.length - 1])]) {
      const list = at.get(k);
      if (list) list.push(i);
      else at.set(k, [i]);
    }
  });

  const used = new Uint8Array(ways.length);
  /** The one unjoined way continuing at node `k`; -1 at a junction or dead end. */
  const next = (k: string): number => {
    const list = at.get(k);
    if (!list || list.length !== 2) return -1;
    const free = list.filter((j) => !used[j]);
    return free.length === 1 ? free[0] : -1;
  };

  const chains: Geom[][] = [];
  for (let i = 0; i < ways.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    let chain = ways[i].slice();
    // Grow at the tail, then at the head, orienting each joined way to match.
    for (;;) {
      const k = key(chain[chain.length - 1]);
      const j = next(k);
      if (j < 0) break;
      used[j] = 1;
      const w = ways[j];
      chain = chain.concat(key(w[0]) === k ? w.slice(1) : w.slice(0, -1).reverse());
    }
    for (;;) {
      const k = key(chain[0]);
      const j = next(k);
      if (j < 0) break;
      used[j] = 1;
      const w = ways[j];
      chain = (key(w[0]) === k ? w.slice(1).reverse() : w.slice(0, -1)).concat(chain);
    }
    chains.push(chain);
  }
  return chains;
}

/** Length of a projected polyline, in canvas px. */
function screenLength(pts: [number, number][]): number {
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  }
  return total;
}

/**
 * Walk a projected polyline and invoke `at` every `step` px of arc length, starting
 * on the first point.
 *
 * Stepping arc length rather than vertices is what makes the spacing uniform however
 * densely the source geometry happens to be sampled, and carrying the leftover across
 * each segment boundary (`dist -= len`) keeps the rhythm unbroken through the bends
 * instead of restarting at every vertex. Zero-length segments are skipped so a
 * duplicated point can't divide by zero.
 *
 * `ux`/`uy` is the unit vector along the segment the sample landed on — {@link railTies}
 * needs it to lay its tick across the rail; {@link drawAerialways}'s dots ignore it.
 * Shared by those two so the one piece of arithmetic they both depend on exists once.
 */
function walkPolyline(
  pts: readonly [number, number][],
  step: number,
  at: (x: number, y: number, ux: number, uy: number) => void,
): void {
  let dist = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (len === 0) continue;
    const ux = (x1 - x0) / len;
    const uy = (y1 - y0) / len;
    while (dist <= len) {
      at(x0 + ux * dist, y0 + uy * dist, ux, uy);
      dist += step;
    }
    dist -= len;
  }
}

/**
 * What every railway mode's draw fn is handed — the shared geometry prep plus the
 * resolved colors, so all three take the same shape and {@link RAILWAY_MODES} can
 * dispatch on the mode without a per-mode call signature.
 */
type RailPaint = {
  /** Stitched, projected, shortest-first chains (see {@link drawRailways}). */
  lines: [number, number][][];
  /** The rail tint: foreground at this mode's own alpha, already flattened opaque. */
  ink: string;
  /** The page color, for the blocks `banded` cuts out of its band. */
  paper: string;
  /** Stroke scale for this canvas height ({@link strokeScale}). */
  scale: number;
};

/**
 * `plain` — one solid stroke per chain. Every chain goes into a single path and is
 * stroked once: this mode only lays down ink, so no line can damage another and
 * there is nothing to order.
 */
function railPlain(ctx: CanvasRenderingContext2D, { lines, ink, scale }: RailPaint): void {
  ctx.strokeStyle = ink;
  ctx.lineCap = "round";
  ctx.lineWidth = scale * RAILWAY_PLAIN.width;
  ctx.setLineDash([]);
  ctx.beginPath();
  for (const pts of lines) traceScreen(ctx, pts);
  ctx.stroke();
}

/**
 * `banded` — the ink band with paper blocks cut into it (see {@link RAILWAY_BANDED}).
 *
 * Each chain is stamped complete — band, then the blocks cut into it — before the
 * next one starts. Doing it as two global passes instead (all bands, then all
 * blocks) would let every line's paper blocks eat every *other* line's thin
 * edges, so where tracks run within a few px of each other nothing keeps an
 * intact outline and a station throat turns to mush. Stamping per chain means the
 * last one drawn sits whole on top of its neighbours; `lines` arrives sorted
 * shortest-first, so that last one is the longest — the mainline reads clean and
 * the short sidings beside it are the ones that get overprinted.
 *
 * Round caps on the band close the notch where two chains meet at a junction;
 * butt caps on the blocks keep their ends rectangular. The paper blocks do cut
 * through whatever is underneath, nicking roads at grade crossings — the same
 * thing openstreetmap-carto's casing does, and the reason this layer sits above
 * the roads (see {@link drawScene}).
 */
function railBanded(ctx: CanvasRenderingContext2D, { lines, ink, paper, scale }: RailPaint): void {
  const { edge, inner, light, dark } = RAILWAY_BANDED;
  const band = scale * (inner + 2 * edge);
  const stripe = scale * inner;
  const blocks = [scale * light, scale * dark];

  for (const pts of lines) {
    ctx.strokeStyle = ink;
    ctx.lineCap = "round";
    ctx.setLineDash([]);
    ctx.lineWidth = band;
    ctx.beginPath();
    traceScreen(ctx, pts);
    ctx.stroke();

    ctx.strokeStyle = paper;
    ctx.lineCap = "butt";
    ctx.lineWidth = stripe;
    ctx.setLineDash(blocks);
    ctx.beginPath();
    traceScreen(ctx, pts);
    ctx.stroke();
  }
}

/**
 * `ties` — a continuous rail plus perpendicular sleeper ticks (see
 * {@link RAILWAY_TIES}).
 *
 * Ticks are placed by {@link walkPolyline}, so their spacing is uniform however
 * densely the source geometry is sampled and the rhythm survives the bends — and,
 * because the chains are already stitched, runs unbroken along a line that OSM split
 * into dozens of ways. Same walk as {@link drawAerialways}'s cabin dots, one tick
 * per step instead of a dot; each tick is laid across the rail on the perpendicular
 * of the walk's unit vector, half its length either side.
 *
 * Both passes are single batched strokes: like `plain`, this mode only adds ink.
 */
function railTies(ctx: CanvasRenderingContext2D, { lines, ink, scale }: RailPaint): void {
  const { lineWidth, tickLength, tickWidth, spacing } = RAILWAY_TIES;
  ctx.strokeStyle = ink;
  ctx.setLineDash([]);
  ctx.lineCap = "round";

  ctx.lineWidth = scale * lineWidth;
  ctx.beginPath();
  for (const pts of lines) traceScreen(ctx, pts);
  ctx.stroke();

  const half = (scale * tickLength) / 2;
  ctx.lineWidth = scale * tickWidth;
  ctx.beginPath();
  for (const pts of lines) {
    walkPolyline(pts, scale * spacing, (x, y, ux, uy) => {
      const nx = -uy * half;
      const ny = ux * half;
      ctx.moveTo(x - nx, y - ny);
      ctx.lineTo(x + nx, y + ny);
    });
  }
  ctx.stroke();
}

/**
 * Every drawable railway mode, paired with the opacity its own `RAILWAY_*` block
 * was tuned at. `Record<…>` over the mode union rather than an if/else chain in
 * {@link drawRailways}, so adding a mode to {@link RailwayStyle} is a type error
 * here until it has an implementation — an `else` fallback would instead have
 * quietly drawn the new mode as whichever branch it landed in. `"off"` is excluded:
 * it isn't a way of drawing the layer, it's not drawing it.
 */
const RAILWAY_MODES: Record<
  Exclude<RailwayStyle, "off">,
  { alpha: number; draw: (ctx: CanvasRenderingContext2D, paint: RailPaint) => void }
> = {
  plain: { alpha: RAILWAY_PLAIN.alpha, draw: railPlain },
  banded: { alpha: RAILWAY_BANDED.alpha, draw: railBanded },
  ties: { alpha: RAILWAY_TIES.alpha, draw: railTies },
};

/**
 * Draw the railway layer in whichever mode `style.railwayStyle` selects, and
 * return the number of chains drawn (not source ways — see {@link chainRailways});
 * `"off"` or absent draws nothing and returns 0.
 *
 * The geometry prep here is shared by all three modes: stitch the ways into chains,
 * project them, and sort shortest-first so the longest line is drawn last (which
 * only matters for `banded`, but costs nothing and keeps the order deterministic).
 * Lengths are measured once per chain and sorted on the side, since the comparator
 * runs O(n log n) times and re-walking every vertex inside it would be wasted work.
 * The dash is reset before returning so it can't leak into a later layer's path.
 */
export function drawRailways(ctx: CanvasRenderingContext2D, req: DrawReq): number {
  const mode = req.style.railwayStyle ?? "off";
  const railways = req.osm.railways;
  if (mode === "off" || !railways || railways.length === 0) return 0;
  const { bbox, width, height, style } = req;
  const { alpha, draw } = RAILWAY_MODES[mode];

  const lines = chainRailways(railways)
    .map((chain) => {
      const pts = chain.map((p) => project(p.lat, p.lon, bbox, width, height));
      return { pts, len: screenLength(pts) };
    })
    .sort((a, b) => a.len - b.len)
    .map((c) => c.pts);

  ctx.lineJoin = "round";
  draw(ctx, {
    lines,
    ink: mixColor(style.foreground, style.background, alpha),
    paper: style.background,
    scale: strokeScale(height),
  });

  ctx.setLineDash([]); // don't leak the dash into later layers
  return lines.length;
}

/**
 * Draw the aerialway layer (cable cars / ropeways) in OSM's default symbol: a thin
 * continuous "cable" line with round "cabin" dots strung along it at even
 * arc-length spacing — distinct from the solid roads and from every railway mode.
 *
 * Dots are placed by {@link walkPolyline}, so spacing is uniform however densely the
 * source vertices are sampled and the rhythm survives the bends. Tuning knobs:
 * {@link AERIALWAY}.
 */
export function drawAerialways(ctx: CanvasRenderingContext2D, req: DrawReq): number {
  const aerialways = req.osm.aerialways;
  if (!req.style.showAerialways || !aerialways || aerialways.length === 0) return 0;
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
  for (const pts of lines) traceScreen(ctx, pts);
  ctx.stroke();

  // 2) evenly spaced cabin dots along each cable, the first one on its start point.
  ctx.fillStyle = dotColor;
  for (const pts of lines) {
    walkPolyline(pts, dotSpacing, (x, y) => {
      ctx.beginPath();
      ctx.arc(x, y, dotRadius, 0, Math.PI * 2);
      ctx.fill();
    });
  }
  return lines.length;
}

/**
 * Draw only the road network onto `ctx` and return the number of ways drawn.
 * Assumes the background (and any under-road layers) are already painted —
 * {@link drawScene} owns compositing order. Ways are bucketed by stroke width and
 * drawn thinnest-first, so heavier roads layer on top and `lineWidth` is set once
 * per bucket rather than per way.
 */
export function drawRoads(ctx: CanvasRenderingContext2D, req: DrawReq): number {
  const { bbox, width, height, style, osm } = req;

  ctx.strokeStyle = style.foreground;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  const scale = strokeScale(height);

  const buckets = new Map<number, Way[]>();
  for (const el of osm.elements ?? []) {
    if (el.type !== "way" || !el.geometry || el.geometry.length < 2) continue;
    const w = widthFor(el.tags?.highway, style.preset, scale);
    if (w === null) continue;
    const list = buckets.get(w) ?? [];
    list.push(el);
    buckets.set(w, list);
  }

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

// A draw fn paired with its id, so drawScene can report per-layer counts.
type LayerDraw = { id: LayerId; draw: (ctx: CanvasRenderingContext2D, req: DrawReq) => number };

// Optional layers, in z-order (bottom → up) within each side of the roads.
const UNDER_ROADS: LayerDraw[] = [{ id: "water", draw: drawWater }];
const OVER_ROADS: LayerDraw[] = [
  { id: "railways", draw: drawRailways },
  { id: "aerialways", draw: drawAerialways },
  { id: "airports", draw: drawAirports },
];

/**
 * Per-feature counts drawn, for logging. `roads` (always present), one entry per
 * optional {@link LayerId} (a disabled or absent layer reports 0), plus `blocks`
 * — the Mondrian color planes, 0 in the `ink` variant.
 *
 * "Feature" is the source feature everywhere except `railways`, which counts the
 * stitched chains it actually strokes and so reads far lower than the payload's way
 * count (see {@link chainRailways}).
 */
export type SceneCounts = { roads: number; blocks: number } & Record<LayerId, number>;

/**
 * Compose the full wallpaper onto `ctx` and return the per-layer feature counts
 * (for logging). This is the single source of truth for layer compositing order:
 *
 *   background ▸ water ▸ [Mondrian blocks] ▸ ROADS ▸ railways ▸ aerialways ▸ airports
 *
 * Roads are the always-present anchor and split the optional layers into those
 * drawn under vs. over them. The over-road layers sit on top on purpose: railways
 * read as one continuous line across grade crossings (in `banded` that costs a
 * small nick out of each road they cross, as in openstreetmap-carto — see
 * {@link drawRailways}); aerialways are overhead cables; runways/taxiways sit over
 * the roads that tunnel beneath them (overpasses across active runways are
 * precluded by airspace clearance), so the airport network reads as one continuous
 * shape instead of being chopped up by the roads underneath. Each optional layer
 * self-gates on its Style toggle + data presence, so a disabled or absent layer
 * is a no-op.
 *
 * The `mondrian` variant (issue #18) is this same pipeline with two
 * substitutions, not a second pipeline: the palette is forced to the Mondrian
 * paper/ink pair — so every optional layer's tint derives from it exactly as the
 * `ink` variant's derives from the theme — and one extra step paints De Stijl
 * color planes into the enclosed city blocks just before the roads are stroked
 * over them (the strokes mask the block boundaries, which is what makes the
 * fills read as planes between the streets). Layer *selection* is untouched:
 * every optional layer still self-gates on its own toggle.
 */
export function drawScene(ctx: CanvasRenderingContext2D, req: DrawReq): SceneCounts {
  const mondrian = req.style.variant === "mondrian";
  const r: DrawReq = mondrian
    ? {
        ...req,
        style: {
          ...req.style,
          background: MONDRIAN_BACKGROUND,
          foreground: MONDRIAN_FOREGROUND,
        },
      }
    : req;
  const { width, height, style } = r;

  ctx.fillStyle = style.background;
  ctx.fillRect(0, 0, width, height);

  // Keys ordered to mirror the compositing pipeline (bottom → top) so the log
  // reads in the same order things are painted.
  const counts: SceneCounts = {
    water: 0, blocks: 0, roads: 0, railways: 0, aerialways: 0, airports: 0,
  };
  for (const { id, draw } of UNDER_ROADS) counts[id] = draw(ctx, r);
  // The block-bounding road set has to match what `drawRoads` actually strokes
  // below, so it's derived from the same width table rather than a second list.
  if (mondrian) {
    counts.blocks = fillMondrianBlocks(ctx, r, (hw) => widthFor(hw, style.preset, 1) !== null);
  }
  counts.roads = drawRoads(ctx, r);
  for (const { id, draw } of OVER_ROADS) counts[id] = draw(ctx, r);
  return counts;
}
