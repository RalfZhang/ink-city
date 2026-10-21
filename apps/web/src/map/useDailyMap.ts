import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { City } from "@inkcity/core";
import { createMapClient, type MapClient } from "./client";
import type { Theme } from "./draw";
import type { Frame, ShowRequest } from "./engine";
import type { Stage } from "./load";
import { pixelSize } from "./size";

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

/**
 * Show a frame: copied onto a plain 2D canvas. A `bitmaprenderer` canvas could
 * take the bitmap without the copy, but it's one more context type with its own
 * support story, for a copy that costs nothing next to the draw that made it.
 */
function paint(canvas: HTMLCanvasElement, frame: Frame) {
  canvas.width = frame.width;
  canvas.height = frame.height;
  canvas.style.width = `${frame.cssWidth}px`;
  canvas.style.height = `${frame.cssHeight}px`;
  canvas.getContext("2d")?.drawImage(frame.bitmap, 0, 0);
  frame.bitmap.close();
}

/**
 * Today's map in `canvas`, at `size` (CSS px, null until the page has measured it)
 * and in `theme`. A new size or theme redraws from the day already in memory; a new
 * date loads that day, and blanks the map until it's drawn.
 */
export function useDailyMap(
  date: string,
  theme: Theme,
  size: { width: number; height: number } | null,
  canvas: RefObject<HTMLCanvasElement | null>,
): MapStatus & { retry: () => void } {
  const [status, setStatus] = useState<DayStatus>(() => ({ ...IDLE, date }));
  const client = useRef<MapClient | null>(null);
  const lastRequest = useRef<ShowRequest | null>(null);
  // Replies name their day; one for a day the page has moved past is dropped.
  const today = useRef(date);
  today.current = date;

  useEffect(() => {
    const c = createMapClient((reply) => {
      if (reply.date !== today.current) return;
      if (reply.type === "stage") setStatus(forDay(reply.date, { stage: reply.stage, error: null }));
      else if (reply.type === "city") setStatus(forDay(reply.date, { city: reply.city, error: null }));
      else if (reply.type === "error") setStatus(forDay(reply.date, { stage: null, error: reply.message }));
      else {
        if (canvas.current) paint(canvas.current, reply);
        setStatus(forDay(reply.date, { painted: true, stage: null, error: null }));
      }
    });
    client.current = c;
    if (lastRequest.current) c.show(lastRequest.current);
    return () => {
      c.dispose();
      client.current = null;
    };
  }, [canvas]);

  const width = size?.width;
  const height = size?.height;
  useEffect(() => {
    if (!width || !height) return;
    const px = pixelSize(width, height, window.devicePixelRatio || 1);
    const req: ShowRequest = { type: "show", date, theme, ...px, cssWidth: width, cssHeight: height };
    lastRequest.current = req;
    client.current?.show(req);
  }, [date, theme, width, height]);

  const retry = useCallback(() => {
    setStatus(forDay(today.current, { error: null }));
    if (lastRequest.current) client.current?.show({ ...lastRequest.current, retry: true });
  }, []);

  // Read against the date being rendered, not reset after it: a new date is IDLE from
  // its first frame, never today's date beside yesterday's city and painted map.
  const { date: about, ...current } = status;
  return { ...(about === date ? current : IDLE), retry };
}
