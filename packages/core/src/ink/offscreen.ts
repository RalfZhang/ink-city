/**
 * Whether a map can be drawn on an OffscreenCanvas here — what the website's and the
 * desktop's map workers ask before taking the drawing on, handing it back to the
 * main thread otherwise. WebKit before 16.4 (Safari, an older macOS's webview, an
 * older WebKitGTK) has OffscreenCanvas, but without a 2D context.
 */
export function canDrawOffscreen(): boolean {
  try {
    return typeof OffscreenCanvas !== "undefined" && new OffscreenCanvas(1, 1).getContext("2d") !== null;
  } catch {
    return false;
  }
}

/**
 * A `width`×`height` picture of what `paint` draws, as a bitmap to hand over: on an
 * OffscreenCanvas wherever one can draw — always so in a map worker, which only
 * takes the drawing on if it can — and otherwise on a canvas element, which is why
 * the main thread drew instead. Throws where no 2D context comes at that size, for
 * the engines to try smaller (./fit.ts).
 */
export async function paintBitmap(
  width: number,
  height: number,
  paint: (ctx: CanvasRenderingContext2D) => void,
): Promise<ImageBitmap> {
  if (canDrawOffscreen()) {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error(`no 2D context at ${width}×${height}`);
    paint(ctx as unknown as CanvasRenderingContext2D);
    return canvas.transferToImageBitmap();
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error(`no 2D context at ${width}×${height}`);
  paint(ctx);
  return createImageBitmap(canvas);
}
