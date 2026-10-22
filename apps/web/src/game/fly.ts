import { prefersReducedMotion } from "../lib/hooks";

// A guess's name, carried from the line it was written on into its place in the
// log: the page lays a copy of the text over the input, then moves and scales it
// onto the log line's name while that one waits hidden — the word seems to rise
// out of the box into the row above it.

/** Where a word starts from, and how it was set there. */
export type Flight = { text: string; from: DOMRect; font: string; size: number; color: string; rtl: boolean };

/** The box `text` takes, written at the start of `input`'s line (its own font and padding). */
export function flightFrom(input: HTMLInputElement, text: string): Flight {
  const cs = getComputedStyle(input);
  const box = input.getBoundingClientRect();
  const rtl = cs.direction === "rtl";
  const size = parseFloat(cs.fontSize) || 16;
  const ctx = document.createElement("canvas").getContext("2d");
  if (ctx) ctx.font = cs.font;
  const width = ctx ? ctx.measureText(text).width : text.length * size * 0.55;
  const start = parseFloat(rtl ? cs.paddingRight : cs.paddingLeft) + parseFloat(rtl ? cs.borderRightWidth : cs.borderLeftWidth);
  const height = size * 1.25;
  const left = rtl ? box.right - start - width : box.left + start;
  return { text, from: new DOMRect(left, box.top + (box.height - height) / 2, width, height), font: cs.font, size, color: cs.color, rtl };
}

/**
 * Fly `flight`'s word onto `to`, which stays hidden until it lands. Not at all for
 * anyone who'd rather nothing moved, or where the browser can't animate it.
 */
export function fly(flight: Flight, to: HTMLElement): void {
  const word = document.createElement("span");
  if (prefersReducedMotion() || typeof word.animate !== "function") return;
  const target = to.getBoundingClientRect();
  const size = parseFloat(getComputedStyle(to).fontSize) || flight.size;
  const scale = size / flight.size;
  word.className = "flight";
  word.textContent = flight.text;
  word.style.font = flight.font;
  word.style.lineHeight = "1.25";
  word.style.color = flight.color;
  word.style.left = `${flight.from.left}px`;
  word.style.top = `${flight.from.top}px`;
  word.style.transformOrigin = flight.rtl ? "right top" : "left top";
  document.body.append(word);
  to.style.visibility = "hidden";
  // Aligned by the line's start edge and its middle, whatever the two sizes.
  const dx = flight.rtl ? target.right - flight.from.right : target.left - flight.from.left;
  const dy = target.top + target.height / 2 - (flight.from.top + (flight.from.height * scale) / 2);
  const done = () => {
    word.remove();
    to.style.visibility = "";
  };
  const motion = word.animate(
    [
      { transform: "none" },
      { transform: `translate(${dx}px, ${dy}px) scale(${scale})` },
    ],
    { duration: 520, easing: "cubic-bezier(0.3, 0.7, 0.2, 1)" },
  );
  motion.onfinish = done;
  motion.oncancel = done;
}
