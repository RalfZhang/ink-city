import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

type Bbox = { south: number; west: number; north: number; east: number };
type StylePreset = "minimal" | "standard" | "bold";
type Style = { background: string; foreground: string; preset: StylePreset };
type Geom = { lat: number; lon: number };
type Way = { type: "way"; geometry?: Geom[]; tags?: { highway?: string } };
type Osm = { elements?: Way[] };
type RenderReq = {
  date: string;
  bbox: Bbox;
  width: number;
  height: number;
  style: Style;
  osm: Osm;
};

function project(lat: number, lon: number, b: Bbox, w: number, h: number): [number, number] {
  const x = ((lon - b.west) / (b.east - b.west)) * w;
  const y = ((b.north - lat) / (b.north - b.south)) * h;
  return [x, y];
}

// Returns the stroke width (in canvas pixels) for a given OSM highway tag value
// under the chosen preset. Returning `null` skips drawing.
// `scale` is a DPR-style factor so widths look consistent across screen densities.
function widthFor(highway: string | undefined, preset: StylePreset, scale: number): number | null {
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
    default:             return scale * 0.4;
  }
}

async function render(req: RenderReq): Promise<void> {
  const { bbox, width, height, style, osm } = req;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d unavailable");

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
  console.log(`[renderer] drew ${drawn} ways at ${width}x${height} (preset=${style.preset})`);

  const blob: Blob | null = await new Promise((r) => canvas.toBlob((b) => r(b), "image/png"));
  if (!blob) throw new Error("toBlob returned null");
  const buf = new Uint8Array(await blob.arrayBuffer());
  await invoke("submit_render_result", { date: req.date, bytes: Array.from(buf) });
}

(async () => {
  await listen<RenderReq>("render-request", (e) => {
    render(e.payload).catch((err) => {
      console.error("[renderer] render failed", err);
    });
  });
  await invoke("renderer_ready");
  console.log("[renderer] ready");
})();
