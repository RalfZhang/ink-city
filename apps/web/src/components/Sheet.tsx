import type { ReactNode } from "react";
import Brand from "./Brand";

/**
 * The sheet of tracing paper that lies under the first page: ruled along its top
 * edge, the name at its head and whatever it carries below. It's the second page
 * (./AppPage.tsx), and — with nothing below the name — the curtain a visit opens
 * on, which slides down off the map as the map is drawn (game/Stage.tsx): the
 * page scrolled to its sheet, then back up. One component for both, so the name
 * sits in exactly the same place on each.
 */
export default function Sheet({ children }: { children?: ReactNode }) {
  return (
    <div className="sheet">
      <div className="sheet__inner">
        <Brand size="large" />
        {children}
      </div>
    </div>
  );
}
