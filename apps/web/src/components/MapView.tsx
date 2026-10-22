import { useLayoutEffect, type RefObject } from "react";
import { cn } from "@inkcity/ui/lib/utils";
import { cover } from "../map/size";

type Props = {
  /** The box the map fills — measured by the page to size the drawing. */
  stageRef: RefObject<HTMLDivElement | null>;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  /** Whether today's map has been drawn; until then the page shows bare paper. */
  painted: boolean;
};

/**
 * Today's map, the whole page behind everything. It's drawn as the square of ground
 * that holds the desktop's crop for a screen of any shape, and laid over the stage as
 * `object-fit: cover` lays an image (../map/size.ts): what shows is exactly what the
 * desktop would draw as a wallpaper for this screen. So a resize just lays it again,
 * frame by frame, the city staying put and the map coming no nearer or farther than
 * the stage's longer side says; the drawing follows with a sharper copy once the
 * resize has settled, and a phone turned on its side needs none.
 *
 * `h-lvh`, the large viewport height: a phone's browser chrome showing and hiding
 * as the page scrolls doesn't resize it. While the chrome shows, the stage runs on
 * under it, by the large viewport's height past the dynamic one's; the map slides up
 * by half of that, so the city sits in the middle of what's on screen (none where
 * `dvh` isn't known: the transform is dropped).
 */
export default function MapView({ stageRef, canvasRef, painted }: Props) {
  // Centred on whole device pixels, so a fresh frame lands pixel for pixel.
  useLayoutEffect(() => {
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    if (!stage || !canvas) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      const dpr = window.devicePixelRatio || 1;
      const { css } = cover(width, height, dpr);
      const snap = (v: number) => Math.round(v * dpr) / dpr;
      canvas.style.width = canvas.style.height = `${css}px`;
      canvas.style.left = `${snap((width - css) / 2)}px`;
      canvas.style.top = `${snap((height - css) / 2)}px`;
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, [stageRef, canvasRef]);

  return (
    <div ref={stageRef} aria-hidden className="fixed inset-x-0 top-0 h-lvh overflow-hidden">
      <div
        className="absolute inset-0 transition-transform duration-500 ease-out"
        style={{ transform: "translateY(calc((100dvh - 100lvh) / 2))" }}
      >
        <canvas ref={canvasRef} className={cn("absolute max-w-none", painted ? "opacity-100" : "opacity-0")} />
      </div>
    </div>
  );
}
