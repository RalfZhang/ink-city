// How a map lies over a screen of any shape, the website's page and the desktop's
// window alike: drawn as the square of ground that holds the wallpaper's crop for
// every screen shape (`bboxForScreen` spans the longer side), and laid over the
// screen as `object-fit: cover` lays an image — as wide as its longer side, centred.
// What shows is then exactly what the desktop would draw as a wallpaper for that
// shape, and a resize only lays the square again: the city stays put, and the map
// comes no nearer or farther than the longer side says.

/** The part of a frame that's on screen, in the frame's device pixels. */
export type View = { x: number; y: number; width: number; height: number };

/**
 * The longest side the square is drawn at, device px. Past any screen's needs
 * (16384² and up is what browsers allow): it only keeps a frame's memory in
 * bounds — 144 MB a copy — while a 6K display still gets its full resolution.
 */
export const MAX_SQUARE_SIDE = 6144;

/**
 * The square for a `width`×`height` screen (CSS px) at `dpr`: its side in CSS px,
 * in device px — drawn at the pixel ratio (one device pixel a CSS px at the least),
 * up to `max` across — and the part of it that's on screen.
 */
export function coverSquare(
  width: number,
  height: number,
  dpr: number,
  max = MAX_SQUARE_SIDE,
): { css: number; px: number; view: View } {
  // Rounded up to whole device pixels, so it covers.
  const css = Math.ceil(Math.max(1, width, height) * dpr - 1e-6) / dpr;
  const px = Math.min(Math.round(css * Math.max(1, dpr)), max);
  const k = px / css;
  return { css, px, view: { x: ((css - width) / 2) * k, y: ((css - height) / 2) * k, width: width * k, height: height * k } };
}

/**
 * Lay `el` — the canvas the square is drawn on — over a `width`×`height` stage (CSS
 * px) as `coverSquare` says: as wide as the stage's longer side, centred on whole
 * device pixels, so a fresh frame lands pixel for pixel.
 */
export function layCover(el: HTMLElement, width: number, height: number, dpr: number, max?: number): void {
  const { css } = coverSquare(width, height, dpr, max);
  const snap = (v: number) => Math.round(v * dpr) / dpr;
  el.style.width = el.style.height = `${css}px`;
  el.style.left = `${snap((width - css) / 2)}px`;
  el.style.top = `${snap((height - css) / 2)}px`;
}
