import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

type Bbox = { south: number; west: number; north: number; east: number };
type Style = { background: string; foreground: string; line_width: number };
type Geom = { lat: number; lon: number };
type Way = { type: "way"; geometry?: Geom[] };
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
  ctx.lineWidth = style.line_width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  const elements = osm.elements ?? [];
  let drawn = 0;
  for (const el of elements) {
    if (el.type !== "way" || !el.geometry || el.geometry.length < 2) continue;
    const pts = el.geometry;
    ctx.beginPath();
    const [x0, y0] = project(pts[0].lat, pts[0].lon, bbox, width, height);
    ctx.moveTo(x0, y0);
    for (let i = 1; i < pts.length; i++) {
      const [x, y] = project(pts[i].lat, pts[i].lon, bbox, width, height);
      ctx.lineTo(x, y);
    }
    ctx.stroke();
    drawn++;
  }
  console.log(`[renderer] drew ${drawn} ways at ${width}x${height}`);

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
