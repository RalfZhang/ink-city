import type { View } from "./cover";

// A frame the machine can't hold a canvas for — out of memory, no 2D context at
// that size: a GPU short of memory, a browser with a lower cap than ours — is drawn
// smaller rather than not at all. Both hosts lay their frame over the screen by CSS
// (./cover.ts), whatever its pixel size, so a smaller one lies the same, only softer.

/** The longest side a frame is halved down to before its error is given up on, device px. */
export const MIN_FIT_SIDE = 1024;

/**
 * `render` at `width`×`height`, or — if that throws — at half of each, and half again,
 * as long as the longer side stays at MIN_FIT_SIDE or more; then the last error is
 * thrown. Returns the frame and the size it was drawn at, with `scale`, that size
 * over the one asked for: anything laid out in the frame's pixels — a view to ink
 * in from — scales by it.
 */
export async function renderFitting<B>(
  width: number,
  height: number,
  render: (width: number, height: number) => Promise<B>,
): Promise<{ bitmap: B; width: number; height: number; scale: number }> {
  for (let scale = 1; ; scale /= 2) {
    const w = Math.max(1, Math.floor(width * scale));
    const h = Math.max(1, Math.floor(height * scale));
    try {
      return { bitmap: await render(w, h), width: w, height: h, scale: w / width };
    } catch (e) {
      if (Math.max(w, h) / 2 < MIN_FIT_SIDE) throw e;
    }
  }
}

/** `view` scaled by `k`, for a frame drawn at `k` times the size it was asked at. */
export function scaleView(view: View, k: number): View {
  if (k === 1) return view;
  return { x: view.x * k, y: view.y * k, width: view.width * k, height: view.height * k };
}
