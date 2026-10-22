import { useLayoutEffect, useRef, type ReactNode } from "react";

/** How long folding takes, ms — play.css's .fold. */
const FOLD_MS = 450;

/**
 * What folds away under the city card: the record and the guesses. Closing, its
 * height runs down to nothing — explicitly, from its measured height, so every
 * browser lays the page out again each frame and the stack, held at its foot, comes
 * down with it: what's inside slides down behind the bar, the card above following
 * it. Opening is the same, the other way, and the height is let go again once it's
 * open, so the guesses can keep coming. `onSettled` once either has run.
 */
export default function Fold({ open, onSettled, children }: { open: boolean; onSettled?: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  // What the fold was last laid out as: only a change from that is animated (an
  // effect run again with nothing changed — React's dev double run, say — isn't).
  const laid = useRef<boolean | null>(null);
  // Read when the run ends, so a new callback each render doesn't restart it.
  const settled = useRef(onSettled);
  settled.current = onSettled;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (laid.current === null || laid.current === open) {
      laid.current = open;
      el.style.height = open ? "" : "0px";
      return;
    }
    laid.current = open;
    const full = el.scrollHeight;
    el.style.height = `${open ? 0 : full}px`;
    // The start of the run laid out before its end is set, so there's a run to animate.
    void el.getBoundingClientRect();
    el.style.height = `${open ? full : 0}px`;
    // Settled once it's run — or in a moment regardless, should the run not end as a
    // transition (nothing to show, or cut short); open, the height is let go.
    const settle = () => {
      clearTimeout(timer);
      if (open) el.style.height = "";
      settled.current?.();
    };
    const onEnd = (e: TransitionEvent) => {
      if (e.target === el && e.propertyName === "height") settle();
    };
    el.addEventListener("transitionend", onEnd);
    const timer = setTimeout(settle, FOLD_MS + 100);
    return () => {
      el.removeEventListener("transitionend", onEnd);
      clearTimeout(timer);
    };
  }, [open]);

  return (
    <div ref={ref} className="fold" inert={!open}>
      <div className="fold__inner">{children}</div>
    </div>
  );
}
