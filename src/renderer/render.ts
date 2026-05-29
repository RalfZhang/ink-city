import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

import { drawRoads, type DrawReq } from "@/core";

// Thin Tauri adapter: receive a render request over IPC, draw via the portable
// core, and hand the PNG bytes back to Rust. All drawing logic lives in
// `@/core/render` so the website and CI can reuse it.

type RenderReq = DrawReq & { date: string };

async function render(req: RenderReq): Promise<void> {
  const canvas = document.createElement("canvas");
  canvas.width = req.width;
  canvas.height = req.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d unavailable");

  const drawn = drawRoads(ctx, req);
  console.log(`[renderer] drew ${drawn} ways at ${req.width}x${req.height} (preset=${req.style.preset})`);

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
