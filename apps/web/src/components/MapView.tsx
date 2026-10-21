import type { RefObject } from "react";
import { cn } from "@inkcity/ui/lib/utils";

type Props = {
  /** The box the map fills — measured by the page to size the drawing. */
  stageRef: RefObject<HTMLDivElement | null>;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  /** How far to slide the map (CSS px) so the city sits in the middle of what the panel leaves free. */
  shift: { x: number; y: number };
  /** Whether today's map has been drawn; until then the page shows bare paper. */
  painted: boolean;
};

/**
 * Today's map, the whole page behind the panel. It's drawn at the size of the
 * screen, exactly as the desktop would draw a wallpaper for it, then slid by half
 * the panel's size: the city lands in the middle of the space left free, and the
 * bare strip the slide opens up lies under the panel. Hiding the panel slides it
 * back — no redraw.
 *
 * `h-lvh`, the large viewport height: a phone's browser chrome showing and hiding
 * as the page scrolls doesn't resize it, so it doesn't redraw for that either.
 */
export default function MapView({ stageRef, canvasRef, shift, painted }: Props) {
  return (
    <div ref={stageRef} aria-hidden className="fixed inset-x-0 top-0 h-lvh overflow-hidden">
      <div
        className="absolute inset-0 transition-transform duration-500 ease-out motion-reduce:transition-none"
        style={{ transform: `translate(${shift.x}px, ${shift.y}px)` }}
      >
        {/* Centred at the size it was drawn for, so while a resize waits for its
            redraw the old frame stays sharp instead of stretching. */}
        <canvas
          ref={canvasRef}
          className={cn(
            "absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 max-w-none transition-opacity duration-700 motion-reduce:transition-none",
            painted ? "opacity-100" : "opacity-0",
          )}
        />
      </div>
    </div>
  );
}
