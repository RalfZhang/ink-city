import { useEffect, type RefObject } from "react";

/** A gesture's events come closer together than this, ms; a gap this long starts a new one. */
const QUIET_MS = 160;
/** A trackpad's momentum only ever slows: after this many slowing events, a scroll that picks up again is a new swipe. */
const SLOWING = 3;
/** The least time between two page turns, ms: the smooth scroll's, about. */
const TURN_MS = 650;

/**
 * Which wheel gesture an event belongs to. A new one starts after a pause, on a
 * change of direction, or — since a trackpad's momentum keeps sending ever smaller
 * scrolls for a second or more after the fingers have lifted — when the scroll
 * picks up again after slowing: the next swipe, begun before the last one has died
 * away. A mouse wheel's notches come at a steady size, so for it a pause is what
 * parts two scrolls.
 */
export type Gesture = { id: number; at: number; size: number; sign: number; slowing: number };

export const NO_GESTURE: Gesture = { id: 0, at: -Infinity, size: 0, sign: 0, slowing: 0 };

export function follow(g: Gesture, e: Pick<WheelEvent, "deltaY">, now: number): Gesture {
  const size = Math.abs(e.deltaY);
  const sign = Math.sign(e.deltaY);
  const fresh = now - g.at > QUIET_MS || sign !== g.sign || (g.slowing >= SLOWING && size > g.size * 1.5 + 2);
  const slowing = fresh ? 0 : size < g.size ? g.slowing + 1 : size > g.size ? 0 : g.slowing;
  return { id: fresh ? g.id + 1 : g.id, at: now, size, sign, slowing };
}

/**
 * Whether something between `from` and `root` would scroll itself `dir` (1 down, −1
 * up) — the stack of cards, a list of matches — and so should take the wheel.
 */
function scrollsItself(from: EventTarget | null, root: HTMLElement, dir: number): boolean {
  for (let el = from instanceof Element ? from : null; el && el !== root; el = el.parentElement) {
    const { overflowY } = getComputedStyle(el);
    if (overflowY !== "auto" && overflowY !== "scroll") continue;
    if (el.scrollHeight <= el.clientHeight + 1) continue;
    if (dir > 0 ? el.scrollTop + el.clientHeight < el.scrollHeight - 1 : el.scrollTop > 0) return true;
  }
  return false;
}

/**
 * Where turning the page `dir` (1 down, −1 up) from `root`'s scroll goes: the next
 * page's top — going up, the foot of the page above, if it's taller than the screen.
 * "more" while a page taller than the screen has more to scroll through that way
 * first; null with no page that way.
 */
function turnTo(root: HTMLElement, dir: number): number | "more" | null {
  const pages = [...root.children] as HTMLElement[];
  const top = root.scrollTop;
  const at = pages.reduce((found, p, i) => (p.offsetTop <= top + 1 ? i : found), 0);
  const page = pages[at];
  const more = dir > 0 ? top + root.clientHeight < page.offsetTop + page.offsetHeight - 1 : top > page.offsetTop + 1;
  if (more) return "more";
  const next = pages[at + dir];
  if (!next) return null;
  return dir > 0 ? next.offsetTop : Math.max(next.offsetTop, next.offsetTop + next.offsetHeight - root.clientHeight);
}

/** The keys that scroll, and which way. */
const KEY_DIR: Record<string, number> = { PageDown: 1, PageUp: -1, ArrowDown: 1, ArrowUp: -1, " ": 1 };

/**
 * Whole pages, a turn at a time, from a wheel or a trackpad, over the scroller
 * `ref` whose children are the pages. Scroll-snapping alone would do for a mouse
 * wheel, but snaps a trackpad's short scroll back to where it started, and turns a
 * page the moment the stack of cards in it runs out.
 *
 * So: a wheel over something that scrolls itself scrolls that, natively, as long as
 * it can; the gesture that took it to its end stays there, and it's the next one
 * that turns the page — "scroll to the bottom, then once more". One turn per
 * gesture (`follow`), too: what a trackpad keeps sending after a turn is let go by.
 * A page taller than the screen is scrolled through before it's turned from.
 *
 * Touch and the keyboard are left to scroll-snapping, which does them well — but a
 * key only scrolls what holds the focus, and the page itself can't scroll: before
 * anything in the pages has been focused, or with the focus in a corner, the keys
 * would move nothing. From there they're taken here, a page a key.
 */
export function usePaging(ref: RefObject<HTMLElement | null>, smooth: boolean): void {
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const behavior = smooth ? "smooth" : "auto";
    let g = NO_GESTURE;
    // The gesture that last scrolled something inside, and the one that last turned the page.
    let inner = -1;
    let turned = -1;
    let turnedAt = -Infinity;
    const onWheel = (e: WheelEvent) => {
      // Zooming (a pinch on a trackpad comes as a wheel with Ctrl), or taken already (the globe).
      if (e.defaultPrevented || e.ctrlKey || e.deltaY === 0 || Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;
      const now = performance.now();
      const dir = e.deltaY > 0 ? 1 : -1;
      g = follow(g, e, now);
      // The rest of a gesture that turned the page goes nowhere — not into the cards
      // that the turn has just brought under the pointer — and so does anything while
      // the turn is still scrolling.
      if (g.id === turned || now - turnedAt < TURN_MS) {
        e.preventDefault();
        return;
      }
      if (scrollsItself(e.target, root, dir)) {
        inner = g.id;
        return;
      }
      const to = turnTo(root, dir);
      // Within a page taller than the screen, the wheel scrolls it as usual.
      if (to === "more") return;
      e.preventDefault();
      if (g.id === inner || to === null) return;
      turned = g.id;
      turnedAt = now;
      root.scrollTo({ top: to, behavior });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || root.contains(e.target as Node)) return;
      const dir = (KEY_DIR[e.key] ?? 0) * (e.key === " " && e.shiftKey ? -1 : 1);
      // Space on a button presses it.
      if (!dir || (e.key === " " && e.target instanceof HTMLButtonElement)) return;
      e.preventDefault();
      const to = turnTo(root, dir);
      if (to === "more") root.scrollBy({ top: dir * root.clientHeight * 0.85, behavior });
      else if (to !== null) root.scrollTo({ top: to, behavior });
    };
    root.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKey);
    return () => {
      root.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKey);
    };
  }, [ref, smooth]);
}
