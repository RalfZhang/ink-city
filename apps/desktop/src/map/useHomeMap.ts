import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { coverSquare, inkIn, layCover, type LatLon, type Style } from "@inkcity/core";
import { prefersReducedMotion } from "@inkcity/ui/game/motion";
import { useDevicePixelRatio, useElementSize } from "@inkcity/ui/lib/hooks";
import { errorText } from "@/lib/action";
import { logWarn } from "@/lib/log";
import type { MapClient } from "./client";

/** One read of a map's cache file: which map, which writing of the file, and the load its bytes went to the engine as. */
type Ask = { key: string; rev: number; load: number | null };

/**
 * How long the window stays put away before the map it holds is let go of, ms: a
 * quick trip to the tray keeps it, an evening away doesn't.
 */
const RELEASE_AFTER_MS = 10 * 60_000;

/**
 * The current map's data, fetched from the backend's cache once it's there and
 * handed to the engine. `mapRev` is which writing of the cache file that is
 * (`Status.mapRev`), or null while there's none: each writing is read once, so a
 * file the backend writes again — fetched afresh after one that couldn't be read —
 * is read again by itself. `retry` reads the current one again.
 *
 * Only while `active`, the window on screen: a tray app's window is put away most of
 * the time, and a map no one sees is tens of MB parsed and a large picture drawn for
 * nothing. A map that turns up while it's away waits until it's shown; one held
 * through RELEASE_AFTER_MS away is let go of — and with nothing loaded the home lets
 * go of its picture too (`useHomeFrame`) — to be read again when it's next shown.
 * The backend goes on as ever meanwhile: each day's map is still fetched, and set
 * on the desktop, at its hour.
 *
 * Returns which map the engine holds and which writing of it, and why the current
 * map couldn't be read, if it couldn't.
 */
export function useMapData(client: MapClient, mapKey: string | null, mapRev: number | null, active: boolean) {
  const [loaded, setLoaded] = useState<{ key: string; rev: number } | null>(null);
  const [failed, setFailed] = useState<{ key: string; message: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  // The read under way. An answer about any other — the day turned, the pin moved,
  // the file was written again — is dropped.
  const asked = useRef<Ask | null>(null);
  const loads = useRef(0);
  // What the engine holds: a writing already in hand isn't read again when the
  // window comes back.
  const held = useRef<{ key: string; rev: number } | null>(null);

  useEffect(
    () =>
      client.listen((reply) => {
        const ask = asked.current;
        if (!ask || reply.type === "frame" || reply.id === undefined || reply.id !== ask.load) return;
        if (reply.type === "loaded") {
          held.current = { key: ask.key, rev: ask.rev };
          setLoaded(held.current);
          setFailed(null);
        } else {
          setFailed({ key: ask.key, message: reply.message });
        }
      }),
    [client],
  );

  useEffect(() => {
    if (!active || !mapKey || mapRev === null) return;
    const have = held.current;
    if (have && have.key === mapKey && have.rev === mapRev) return;
    const ask: Ask = { key: mapKey, rev: mapRev, load: null };
    asked.current = ask;
    invoke<ArrayBuffer>("get_map_data")
      .then((bytes) => {
        if (asked.current !== ask) return;
        // Numbered before it's handed over: the engine on the main thread answers at once.
        ask.load = ++loads.current;
        client.load(mapKey, ask.load, bytes);
      })
      .catch((e) => {
        logWarn("[map] couldn't read the map data", e);
        if (asked.current === ask) setFailed({ key: mapKey, message: errorText(e) });
      });
  }, [client, mapKey, mapRev, attempt, active]);

  useEffect(() => {
    if (active) return;
    const id = window.setTimeout(() => {
      asked.current = null;
      held.current = null;
      client.unload();
      setLoaded(null);
    }, RELEASE_AFTER_MS);
    return () => window.clearTimeout(id);
  }, [active, client]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return {
    key: loaded?.key ?? null,
    rev: loaded?.rev ?? null,
    error: failed !== null && failed.key === mapKey ? failed.message : null,
    retry,
  };
}

type HomeFrame = {
  client: MapClient;
  /** The box the map fills: the frame. */
  stage: RefObject<HTMLElement | null>;
  canvas: RefObject<HTMLCanvasElement | null>;
  /** The map loaded, or null. */
  mapKey: string | null;
  /** Which writing of its file the engine holds (`useMapData`): a new one is drawn again. */
  rev: number | null;
  /** Whether the window is on screen: nothing is drawn while it's put away. */
  visible: boolean;
  center: LatLon | null;
  /** What to draw it in, or null before there's a status to say. */
  style: Style | null;
};

/** How long a resize holds still before the map is drawn again for it, ms — the website's wait (`useElementSize`). Until then it's only laid again. */
const SETTLE_MS = 300;

/**
 * Keep the home's canvas showing the map, laid as the website lays its own (core's
 * ink/cover.ts): drawn as the square of ground that holds the wallpaper's crop for
 * every screen shape, and laid over the frame as `object-fit: cover` lays an image —
 * so the window shows what the desktop would draw as a wallpaper of the window's
 * shape, and a resize only lays it again, frame by frame, a sharper copy following
 * once it has held still. Drawn in the draft's style, again whenever it changes. A
 * map's first frame is inked in (the website's ink-in); every frame after just
 * replaces the picture. Returns which map the canvas shows, from the moment a frame
 * of it goes on — the game waits for it — and which is all there, ink and all.
 */
export function useHomeFrame({ client, stage, canvas, mapKey, rev, visible, center, style }: HomeFrame): {
  shown: string | null;
  landed: string | null;
  redraw: () => void;
} {
  const [shown, setShown] = useState<string | null>(null);
  const [landed, setLanded] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const seq = useRef(0);
  // The picture on the canvas, and the map it's to be of: anything older is dropped.
  const onCanvas = useRef(0);
  const current = useRef(mapKey);
  current.current = mapKey;
  const inked = useRef(new Set<string>());
  const stop = useRef<(() => void) | null>(null);

  // The screen's pixel ratio, kept current: a move to a screen of another density
  // resizes nothing, so it's what lays the map again and draws it sharp for there.
  const dpr = useDevicePixelRatio();
  // Laid again on every step of a resize, as the website lays its own…
  useLayoutEffect(() => {
    const frame = stage.current;
    const el = canvas.current;
    if (!frame || !el) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) layCover(el, width, height, dpr);
    });
    observer.observe(frame);
    return () => observer.disconnect();
  }, [stage, canvas, dpr]);
  // …and drawn again once it has held still: the square's side in device pixels is
  // all a resize changes for the drawing; the frame's own shape is read when a
  // picture is asked for, for where the ink sets out.
  const size = useElementSize(stage, SETTLE_MS);
  const side = size && size.width > 0 && size.height > 0 ? coverSquare(size.width, size.height, dpr).px : 0;

  useEffect(
    () =>
      client.listen((reply) => {
        if (reply.type === "error" && reply.seq !== undefined) {
          if (reply.key === current.current && reply.seq === seq.current) logWarn("[map] couldn't draw the map", reply.message);
          return;
        }
        if (reply.type !== "frame") return;
        const el = canvas.current;
        const ctx = el?.getContext("2d");
        // Any picture newer than the one up goes on — while a colour is dragged, the
        // map follows it — but none of a map that's no longer the one to show.
        if (!el || !ctx || reply.seq <= onCanvas.current || reply.key !== current.current) {
          reply.bitmap.close();
          return;
        }
        onCanvas.current = reply.seq;
        stop.current?.();
        stop.current = null;
        el.width = reply.bitmap.width;
        el.height = reply.bitmap.height;
        setShown(reply.key);
        // Inked in once a picture of it is up, not once one is asked for: a request
        // the queue drops for a newer one, or one that fails, would take the ink
        // with it.
        inked.current.add(reply.key);
        if (reply.growth && !prefersReducedMotion()) {
          setLanded(null);
          stop.current = inkIn(ctx, reply.bitmap, reply.growth, () => {
            stop.current = null;
            setLanded(reply.key);
          });
        } else {
          ctx.drawImage(reply.bitmap, 0, 0);
          reply.bitmap.close();
          setLanded(reply.key);
        }
      }),
    [client, canvas],
  );

  // No map at all (Customized with no pin yet, or one let go of while the window was
  // put away): bare paper, not the last map shown — and the picture's memory given
  // back, a canvas of no size being the paper anyway. Nothing's shown either, so the
  // game waits for the next map to be on screen rather than opening over paper.
  useEffect(() => {
    if (mapKey) return;
    stop.current?.();
    stop.current = null;
    setShown(null);
    setLanded(null);
    const el = canvas.current;
    if (el) {
      el.width = 0;
      el.height = 0;
    }
  }, [mapKey, canvas]);

  // Every change of style is drawn full size, a colour dragged across Style too: the
  // engine draws only the newest picture asked for, so the map follows the hand at
  // the pace it can be drawn. Not a smaller copy first — Mondrian picks its blocks
  // afresh at each size, so one would flash another composition before the real one.
  const styleKey = JSON.stringify(style);

  useEffect(() => {
    if (!visible || !mapKey || !center || !side || !style || !size) return;
    const grow = !inked.current.has(mapKey);
    client.draw({
      key: mapKey,
      seq: ++seq.current,
      style,
      center,
      side,
      // With motion turned down nothing is inked in: the worker isn't asked to lay it out.
      grow: grow && !prefersReducedMotion() ? { view: coverSquare(size.width, size.height, dpr).view } : undefined,
    });
    // `style` is compared by value, so an unchanged draft doesn't redraw.
  }, [client, mapKey, rev, visible, center?.lat, center?.lon, side, styleKey, attempt]);

  useEffect(() => () => stop.current?.(), []);
  const redraw = useCallback(() => setAttempt((n) => n + 1), []);
  return { shown, landed, redraw };
}
