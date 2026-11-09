import { useEffect, useState, type RefObject } from "react";

// The page's measures both hosts read off the browser: the website's page and the
// desktop's window alike.

/** Whether `query` matches, kept current. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const update = () => setMatches(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [query]);
  return matches;
}

/**
 * The screen's device pixel ratio, kept current. It moves when the window goes to a
 * screen of another density, or the display's scaling changes — neither resizes
 * anything, so without this a canvas drawn for the old ratio stays soft (or
 * oversized) until something else redraws it. A query for the ratio as it stands
 * stops matching the moment it changes; it's asked again for the new one.
 */
export function useDevicePixelRatio(): number {
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1);
  useEffect(() => {
    const mq = window.matchMedia(`(resolution: ${dpr}dppx)`);
    const update = () => setDpr(window.devicePixelRatio || 1);
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [dpr]);
  return dpr;
}

/**
 * `ref`'s content-box size in CSS px, or null before it's laid out. With `settleMs`,
 * a new size is taken up only once it has held still that long — except the first,
 * which passes straight through, so the map's first draw doesn't wait out a resize
 * delay — and a drag-resize re-renders the caller once, not on every frame.
 */
export function useElementSize(
  ref: RefObject<HTMLElement | null>,
  settleMs = 0,
): { width: number; height: number } | null {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let first = true;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      const take = () => setSize((s) => (s && s.width === width && s.height === height ? s : { width, height }));
      clearTimeout(timer);
      if (first || settleMs <= 0) take();
      else timer = setTimeout(take, settleMs);
      first = false;
    });
    observer.observe(el);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [ref, settleMs]);
  return size;
}
