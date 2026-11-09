import { labelFonts, type MapLabel } from "@inkcity/core";

/**
 * Make sure the caption's faces are loaded before a canvas sets them — canvas text
 * never waits for a font, it silently falls back: the wallpaper's
 * (renderer/render.ts) or the window's (map/useHomeMap.ts).
 */
export async function loadLabelFonts(label: MapLabel, width: number, height: number): Promise<void> {
  await Promise.all(labelFonts(label, width, height).map(({ font, text }) => document.fonts.load(font, text)));
}
