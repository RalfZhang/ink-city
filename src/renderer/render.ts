import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
// The city caption's typeface (core/label.ts). Only loaded here, not drawn with
// until a request carries a caption.
import "@fontsource-variable/geist";

import { drawScene, labelFonts, type DrawReq, type MapLabel } from "@/core";
import { logError, logInfo, logWarn } from "@/lib/log";

// Thin Tauri adapter: receive a render request over IPC, draw via the portable
// core, and hand the PNG bytes back to Rust. All drawing logic lives in
// `@/core/render` so the website and CI can reuse it.

type RenderReq = DrawReq & { date: string };

/** How long a caption waits for its fonts before drawing with whatever has loaded. */
const FONT_WAIT_MS = 3000;

/**
 * Make sure the caption's faces are loaded before the canvas sets them — canvas
 * text never waits for a font, it silently falls back. Bounded, so a font that
 * can't load costs the caption its typeface, never the render.
 */
async function loadLabelFonts(label: MapLabel, width: number, height: number): Promise<void> {
  const loads = Promise.all(
    labelFonts(label, width, height).map(({ font, text }) => document.fonts.load(font, text)),
  );
  const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), FONT_WAIT_MS));
  try {
    if ((await Promise.race([loads, timeout])) === "timeout") {
      logWarn("[renderer] caption fonts still loading after 3s; drawing with fallbacks");
    }
  } catch (err) {
    logWarn("[renderer] caption fonts failed to load; drawing with fallbacks", err);
  }
}

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
