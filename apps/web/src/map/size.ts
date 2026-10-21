// Kept apart from ./draw.ts so the page can size its canvas without pulling the
// renderer into the main bundle — the drawing happens in the worker.

/**
 * The most pixels one canvas gets — iOS Safari's limit (4096²), which it enforces
 * by drawing nothing at all. A bigger screen gets a lower resolution, not a blank.
 */
export const MAX_CANVAS_PIXELS = 4096 * 4096;

/** The device-pixel size to draw a `cssWidth`×`cssHeight` canvas at, `dpr` capped by area. */
export function pixelSize(cssWidth: number, cssHeight: number, dpr: number): { width: number; height: number } {
  const area = Math.max(1, cssWidth * cssHeight);
  const scale = Math.min(Math.max(1, dpr), Math.sqrt(MAX_CANVAS_PIXELS / area));
  return {
    width: Math.max(1, Math.floor(cssWidth * scale)),
    height: Math.max(1, Math.floor(cssHeight * scale)),
  };
}
