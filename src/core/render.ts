import type { Bbox, Osm, Style, StylePreset, Way } from "./types";
import { project } from "./bbox";

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

/** Draw the road network onto `ctx`. Returns the number of ways drawn. */
export function drawRoads(ctx: CanvasRenderingContext2D, req: DrawReq): number {
  const { bbox, width, height, style, osm } = req;

  ctx.fillStyle = style.background;
  ctx.fillRect(0, 0, width, height);
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
  return drawn;
}
