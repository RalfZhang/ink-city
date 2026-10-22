import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { City } from "@inkcity/core";
import { createMapClient, type MapClient } from "./client";
import type { Theme } from "./draw";
import type { Frame, ShowRequest } from "./engine";
import { inkIn } from "./ink-in";
import type { Stage } from "./load";
import { cover } from "./size";

export type MapStatus = {
  /** Today's city, once its day has loaded — what the game plays against. */
  city: City | null;
  /** Whether today's map is on screen: the game's `ready`, as the desktop's is its wallpaper. */
  painted: boolean;
  /** Which rung of the fetch ladder is running, while one is. */
  stage: Stage | null;
  error: string | null;
};

const IDLE: MapStatus = { city: null, painted: false, stage: null, error: null };

/** A status, and the day it's about. */
type DayStatus = MapStatus & { date: string };

/** `patch` applied to `day`'s status — to a fresh one, if what's held is another day's. */
const forDay =
  (day: string, patch: Partial<MapStatus>) =>
  (s: DayStatus): DayStatus => ({ ...(s.date === day ? s : IDLE), ...patch, date: day });

/** How soon after the page opens the map may appear, ms: the words over it come first. */
const MAP_DELAY_MS = 300;

/**
 * Put a frame on `canvas` — no sooner than MAP_DELAY_MS into the visit; `onShown` as
 * it goes on. Where the canvas lies, and how big, is the page's
 * (components/MapView.tsx). A plain 2D canvas takes a copy of the bitmap: a
 * `bitmaprenderer` one could take it without the copy, but it's one more context
 * type with its own support story, for a copy that costs nothing next to the draw
 * that made it. A frame laid out for growing (the day's first) is inked in instead
 * (./ink-in.ts), `onDone` once it's all there. Returns a function that stops it,
 * whichever stage it's at.
 */
function show(canvas: HTMLCanvasElement, frame: Frame, onShown: () => void, onDone: () => void): () => void {
  let stopInk: (() => void) | null = null;
  const put = () => {
    onShown();
    canvas.width = frame.width;
    canvas.height = frame.height;
    const ctx = canvas.getContext("2d");
    if (ctx && frame.growth) {
      stopInk = inkIn(ctx, frame.bitmap, frame.growth, onDone);
      return;
    }
    ctx?.drawImage(frame.bitmap, 0, 0);
    frame.bitmap.close();
    onDone();
  };
  const wait = MAP_DELAY_MS - performance.now();
  if (wait <= 0) {
    put();
    return () => stopInk?.();
  }
  const timer = setTimeout(put, wait);
  return () => {
    clearTimeout(timer);
    if (stopInk) stopInk();
    else frame.bitmap.close();
  };
}

/**
 * Today's map in `canvas`, for a stage of `size` (CSS px, null until the page has
 * measured it), in `theme`: drawn as the square that covers it (./size.ts), which
 * the page lays over the stage. A theme, or a size that needs another resolution,
 * redraws from the day already in memory — the same ground, so it only sharpens; a
 * new date loads that day, and blanks the map until it's drawn. With `grow`, a day's
 * first frame is inked in from the top of the stage; without (reduced motion), it
 * simply appears.
 */
export function useDailyMap(
  date: string,
  theme: Theme,
  size: { width: number; height: number } | null,
  canvas: RefObject<HTMLCanvasElement | null>,
  grow: boolean,
): MapStatus & { retry: () => void } {
  const [status, setStatus] = useState<DayStatus>(() => ({ ...IDLE, date }));
  const client = useRef<MapClient | null>(null);
  const lastRequest = useRef<ShowRequest | null>(null);
  // Replies name their day; one for a day the page has moved past is dropped.
  const today = useRef(date);
  today.current = date;
  // Read when a request goes out, not depended on: a day's first frame asks to
  // grow, and nothing after it should redraw for that having happened.
  const shown = useRef<string | null>(null);
  const growing = useRef(grow);
  growing.current = grow;
  const stopShow = useRef<(() => void) | null>(null);

  useEffect(() => {
    const c = createMapClient((reply) => {
      if (reply.date !== today.current) return;
      if (reply.type === "stage") setStatus(forDay(reply.date, { stage: reply.stage, error: null }));
      else if (reply.type === "city") setStatus(forDay(reply.date, { city: reply.city, error: null }));
      else if (reply.type === "error") setStatus(forDay(reply.date, { stage: null, error: reply.message }));
      else {
        stopShow.current?.();
        stopShow.current = null;
        if (!canvas.current) {
          reply.bitmap.close();
          return;
        }
        shown.current = reply.date;
        // Painted from the moment it goes on, not when it arrives: what waits on the
        // map (the game, the curtain over it) starts with the ink. Once it's all
        // there, nothing's left to stop — and the frame and its roads are let go.
        stopShow.current = show(
          canvas.current,
          reply,
          () => setStatus(forDay(reply.date, { painted: true, stage: null, error: null })),
          () => {
            stopShow.current = null;
          },
        );
      }
    });
    client.current = c;
    if (lastRequest.current) c.show(lastRequest.current);
    return () => {
      c.dispose();
      client.current = null;
      stopShow.current?.();
      stopShow.current = null;
    };
  }, [canvas]);

  // The square's side in device pixels is all a size changes; the stage's own shape is
  // read when a request goes out, for where the ink sets out from.
  const stage = useRef(size);
  stage.current = size;
  const side = size && size.width > 0 && size.height > 0 ? cover(size.width, size.height, window.devicePixelRatio || 1).px : 0;
  useEffect(() => {
    const box = stage.current;
    if (!side || !box) return;
    const req: ShowRequest = { type: "show", date, theme, width: side, height: side };
    if (shown.current !== date && growing.current) {
      req.grow = { view: cover(box.width, box.height, window.devicePixelRatio || 1).view };
    }
    lastRequest.current = req;
    client.current?.show(req);
  }, [date, theme, side]);

  const retry = useCallback(() => {
    setStatus(forDay(today.current, { error: null }));
    if (lastRequest.current) client.current?.show({ ...lastRequest.current, retry: true });
  }, []);

  // Read against the date being rendered, not reset after it: a new date is IDLE from
  // its first frame, never today's date beside yesterday's city and painted map.
  const { date: about, ...current } = status;
  return { ...(about === date ? current : IDLE), retry };
}
