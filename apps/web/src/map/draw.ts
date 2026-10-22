import { DEFAULT_COLORS, DEFAULT_STYLE, drawScene } from "@inkcity/core";
import type { Manifest } from "./manifest";
import { mapBBox } from "./size";

export type Theme = "light" | "dark";

/**
 * Draw `manifest` as the desktop would draw it for a `width`×`height` screen: the
 * same crop around the city (`bboxForScreen` with the shared `MAX_HALF_KM`), and
 * a fresh install's style in the theme's colors (packages/core/src/defaults.json).
 * No city caption — the page says where it is, once the game is over.
 */
export function drawMap(
  ctx: CanvasRenderingContext2D,
  manifest: Manifest,
  theme: Theme,
  width: number,
  height: number,
): void {
  drawScene(ctx, {
    bbox: mapBBox(manifest, width, height),
    width,
    height,
    style: { ...DEFAULT_COLORS[theme], ...DEFAULT_STYLE },
    osm: manifest,
  });
}
