import { useEffect, useRef, useState, type RefObject } from "react";
import { drawLabel, type ColorPair, type MapLabel } from "@inkcity/core";
import { useDevicePixelRatio, useElementSize } from "@inkcity/ui/lib/hooks";
import { loadLabelFonts } from "@/lib/label-fonts";

/**
 * The wallpaper's city caption, on the window's map: drawn by the renderer that
 * draws it on the desktop, in its own layer over the map, in `label`'s corner of
 * the frame — where it stays, whatever comes and goes at the foot, which simply
 * lies over it, as a window lies over the desktop. Drawn once `on` (the map is all
 * there) and redrawn as the frame's size or the caption changes, without asking the
 * map for another frame.
 *
 * It keeps clear of the bar along the frame's top (home.css's `--top-h`: its chips,
 * and as much again below them as above). Unlike the wallpaper's menu bar, the bar
 * doesn't push the margin down: the margin counts from the frame's edge, and the bar
 * only pushes the caption in as far as it must to clear it (`insetsMode: "min"`).
 *
 * Its own component, so its size following every step of a resize re-renders only
 * this canvas, not the window around it.
 */
export default function MapCaption({
  stage,
  label,
  pair,
  on,
}: {
  /** The frame it's drawn over, and measured by. */
  stage: RefObject<HTMLElement | null>;
  /** What it says, and in which corner; null for none. */
  label: MapLabel | null;
  /** The paper and ink it's written in, or null before there's a status to say. */
  pair: ColorPair | null;
  on: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  // Every step of a resize: the caption stays in its corner of the frame throughout.
  const size = useElementSize(stage);
  const dpr = useDevicePixelRatio();
  const [drawn, setDrawn] = useState(false);

  const what = on && label && pair ? JSON.stringify([label, pair]) : "";
  useEffect(() => {
    const el = canvas.current;
    const frame = stage.current;
    if (!el || !frame || !size || !size.width || !size.height) return;
    if (!what || !label || !pair) {
      // Faded out where it is; cleared the next time it's drawn.
      setDrawn(false);
      return;
    }
    let live = true;
    const width = Math.round(size.width * dpr);
    const height = Math.round(size.height * dpr);
    const bar = parseFloat(getComputedStyle(frame).getPropertyValue("--top-h")) || 0;
    const placed: MapLabel = { ...label, insets: { top: bar * dpr, right: 0, bottom: 0, left: 0 }, insetsMode: "min" };
    void loadLabelFonts(placed, width, height).then(() => {
      if (!live) return;
      el.width = width;
      el.height = height;
      const ctx = el.getContext("2d");
      if (!ctx) return;
      drawLabel(ctx, placed, pair, width, height);
      setDrawn(true);
    });
    return () => {
      live = false;
    };
    // `what` stands for the label and the pair, compared by value.
  }, [stage, size, dpr, what]);

  return <canvas ref={canvas} className={`map-caption${drawn ? " is-on" : ""}`} aria-hidden />;
}
