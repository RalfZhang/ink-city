import type { CSSProperties } from "react";
import { cn } from "@inkcity/ui/lib/utils";
import Sheet from "../components/Sheet";
import { FRONT_EASE, SPREAD_S } from "../map/front";

/**
 * What a visit opens on: the second page's sheet over the whole screen, as if the
 * page were scrolled down to it, with only the name on it. When the map starts to
 * be drawn it slides down off the map — the page scrolling back up to its first
 * page — its top edge keeping pace with the ink front (map/front.ts), so the
 * roads come out from under it — and with them the first page, the question in its
 * middle. Once it's down, `onGone`: the page takes it away for good.
 */
export default function Curtain({ open, onGone }: { open: boolean; onGone: () => void }) {
  return (
    <div
      className={cn("curtain", open && "is-open")}
      style={{ "--spread": `${SPREAD_S}s`, "--front-ease": FRONT_EASE } as CSSProperties}
      onAnimationEnd={(e) => {
        if (e.target === e.currentTarget) onGone();
      }}
      aria-hidden
    >
      <Sheet />
    </div>
  );
}
