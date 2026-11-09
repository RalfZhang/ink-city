import { useEffect, useState } from "react";
import { msUntilMidnight } from "@inkcity/ui/game/time";
import { localDate } from "./date";

// The motion and countdown hooks the game uses too are the game's own (@inkcity/ui/game/motion, /time);
// the page's measures the desktop reads too are @inkcity/ui/lib/hooks.

/**
 * Today's local date, rolling over at midnight. Checked on a timer aimed at the
 * next midnight and again whenever the tab comes back into view: background tabs
 * have their timers throttled and a sleeping laptop has none at all, so the timer
 * alone could wake up a day late.
 */
export function useLocalDate(): string {
  const [date, setDate] = useState(localDate);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const check = () => {
      setDate(localDate());
      clearTimeout(timer);
      timer = setTimeout(check, msUntilMidnight() + 500);
    };
    check();
    const onVisible = () => {
      if (document.visibilityState === "visible") check();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", check);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", check);
    };
  }, []);
  return date;
}

/**
 * How much of the page an on-screen keyboard covers, px, kept as `--kb` on the root
 * for what has to stay above it (play.css's foot): the layout viewport's height past
 * the bottom of the visual one, while a text field has the focus. Nothing for a
 * pinch-zoomed page, whose visual viewport is small for another reason.
 */
export function useKeyboardInset(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const update = () => {
      const typing = document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement;
      const covered = typing && Math.abs(vv.scale - 1) < 0.01 ? window.innerHeight - vv.height - vv.offsetTop : 0;
      root.style.setProperty("--kb", `${Math.max(0, Math.round(covered))}px`);
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    window.addEventListener("focusin", update);
    window.addEventListener("focusout", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      window.removeEventListener("focusin", update);
      window.removeEventListener("focusout", update);
      root.style.removeProperty("--kb");
    };
  }, []);
}
