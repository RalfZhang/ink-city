import { bboxForScreen, MAX_HALF_KM, type Bbox } from "@inkcity/core";
import type { Manifest } from "./manifest";

// Kept apart from ./draw.ts so the page can size its canvas without pulling the
// renderer into the main bundle — the drawing happens in the worker.

/**
 * The longest side the map's square is drawn at on iOS and iPadOS, device px: their
 * WebKit (every browser there) caps a canvas at 4096² pixels, and enforces it by
 * drawing nothing at all. A bigger window gets a lower resolution, not a blank.
 */
export const IOS_MAX_SIDE = 4096;

/**
 * The longest side elsewhere, where the browsers' own limits are far past any
 * screen (16384² and up): this only keeps a frame's memory in bounds — 144 MB a copy
 * — while a 6K display still gets its full resolution.
 */
export const MAX_SIDE = 6144;

/** iOS or iPadOS — which asks for desktop sites as a Mac; only its touchscreen gives it away. */
export function isIOS(nav: { userAgent: string; maxTouchPoints?: number }): boolean {
  return /iPhone|iPad|iPod/.test(nav.userAgent) || (/Macintosh/.test(nav.userAgent) && (nav.maxTouchPoints ?? 0) > 1);
}

const maxSide = typeof navigator !== "undefined" && isIOS(navigator) ? IOS_MAX_SIDE : MAX_SIDE;

/**
 * The ground a `width`×`height` frame of `manifest` shows: the desktop's crop around
 * the city — what ./draw.ts draws, and ./growth.ts inks in.
 */
export function mapBBox(manifest: Manifest, width: number, height: number): Bbox {
  return bboxForScreen(manifest.city.lat, manifest.city.lon, MAX_HALF_KM, width / height);
}

/** The part of a frame that's on screen, in the frame's device pixels. */
export type View = { x: number; y: number; width: number; height: number };

/**
 * The square the map is drawn as, for a `width`×`height` stage (CSS px), and how it
 * lies over it. The desktop's crop spans the longer side of the screen
 * (`bboxForScreen`), so the square of ground that side spans holds the crop for a
 * screen of any shape, and laid over the stage as `object-fit: cover` lays an image
 * — as wide as the stage's longer side, centred — it shows exactly that crop.
 */
export function cover(
  width: number,
  height: number,
  dpr: number,
  max = maxSide,
): { css: number; px: number; view: View } {
  // The side in CSS px, rounded up to whole device pixels so it covers; drawn at the
  // pixel ratio (one device pixel a CSS px at the least), up to `max` across.
  const css = Math.ceil(Math.max(1, width, height) * dpr - 1e-6) / dpr;
  const px = Math.min(Math.round(css * Math.max(1, dpr)), max);
  const k = px / css;
  return { css, px, view: { x: ((css - width) / 2) * k, y: ((css - height) / 2) * k, width: width * k, height: height * k } };
}
