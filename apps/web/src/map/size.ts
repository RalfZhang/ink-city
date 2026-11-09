import { bboxForScreen, coverSquare, MAX_HALF_KM, MAX_SQUARE_SIDE, type Bbox, type View } from "@inkcity/core";
import type { Manifest } from "./manifest";

// Kept apart from ./draw.ts so the page can size its canvas without pulling the
// renderer into the main bundle — the drawing happens in the worker.

/**
 * The longest side the map's square is drawn at on iOS and iPadOS, device px: their
 * WebKit (every browser there) caps a canvas at 4096² pixels, and enforces it by
 * drawing nothing at all. A bigger window gets a lower resolution, not a blank.
 */
export const IOS_MAX_SIDE = 4096;

/** iOS or iPadOS — which asks for desktop sites as a Mac; only its touchscreen gives it away. */
export function isIOS(nav: { userAgent: string; maxTouchPoints?: number }): boolean {
  return /iPhone|iPad|iPod/.test(nav.userAgent) || (/Macintosh/.test(nav.userAgent) && (nav.maxTouchPoints ?? 0) > 1);
}

/** The longest side the square is drawn at in this browser. */
export const maxSide = typeof navigator !== "undefined" && isIOS(navigator) ? IOS_MAX_SIDE : MAX_SQUARE_SIDE;

/**
 * The ground a `width`×`height` frame of `manifest` shows: the desktop's crop around
 * the city — what ./draw.ts draws, and the engine lays out for inking in.
 */
export function mapBBox(manifest: Manifest, width: number, height: number): Bbox {
  return bboxForScreen(manifest.city.lat, manifest.city.lon, MAX_HALF_KM, width / height);
}

/**
 * The square the map is drawn as, for a `width`×`height` stage (CSS px), and how it
 * lies over it — the desktop's window lays its map the same way (core's
 * `coverSquare`): what shows is exactly the wallpaper's crop for this shape.
 */
export function cover(width: number, height: number, dpr: number, max = maxSide): { css: number; px: number; view: View } {
  return coverSquare(width, height, dpr, max);
}
