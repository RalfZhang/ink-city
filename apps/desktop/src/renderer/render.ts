import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
// The city caption's typeface (core/label.ts). Only loaded here, not drawn with
// until a request carries a caption.
import "@fontsource-variable/geist";

import { drawScene, type DrawReq } from "@inkcity/core";
import { loadLabelFonts } from "@/lib/label-fonts";
import { logError, logInfo } from "@/lib/log";

// Thin Tauri adapter: receive a render request over IPC, draw via the portable
// core, and hand the PNG bytes back to Rust. All drawing logic lives in
// `@inkcity/core` (packages/core/src/render.ts) so the website and CI can reuse it.

type RenderReq = DrawReq & { date: string };

async function render(req: RenderReq): Promise<void> {
  const canvas = document.createElement("canvas");
  canvas.width = req.width;
  canvas.height = req.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d unavailable");

  if (req.label) await loadLabelFonts(req.label, req.width, req.height);
  const counts = drawScene(ctx, req);
  const summary =
    Object.entries(counts)
      .filter(([, n]) => n > 0)
      .map(([layer, n]) => `${n} ${layer}`)
      .join(", ") || "nothing";
  logInfo(`[renderer] drew ${summary} at ${req.width}x${req.height} (preset=${req.style.preset})`);

  const blob: Blob | null = await new Promise((r) => canvas.toBlob((b) => r(b), "image/png"));
  if (!blob) throw new Error("toBlob returned null");
  const buf = new Uint8Array(await blob.arrayBuffer());
  await invoke("submit_render_result", { date: req.date, bytes: Array.from(buf) });
}

(async () => {
  await listen<RenderReq>("render-request", (e) => {
    render(e.payload).catch((err) => {
      logError("[renderer] render failed", err);
    });
  });
  await invoke("renderer_ready");
  logInfo("[renderer] ready");
})();
