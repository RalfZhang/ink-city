import {
  DEFAULT_STYLE,
  growthBuffers,
  growthFor,
  newestOnly,
  renderFitting,
  scaleView,
  type City,
  type Growth,
  type NewestQueue,
  type Post,
  type View,
} from "@inkcity/core";
import type { Theme } from "./draw";
import { loadDay, type LoadDeps, type Stage } from "./load";
import type { Manifest } from "./manifest";
import { mapBBox } from "./size";

// The map's work, wherever it runs: in the map worker (./worker.ts) normally, on
// the main thread where a worker can't draw (./client.ts) — the switching is core's
// (ink/engine-link.ts), and so are the queue requests wait in (ink/queue.ts) and the
// halving of a frame too big to draw (ink/fit.ts), all shared with the desktop's
// window. Asked to `show` a day at a size and theme, it loads the day once, then
// draws it as often as the page asks — a resize or a theme switch redraws from
// memory and never refetches.

/**
 * Draw the day at `width`×`height` device pixels, in `theme` — the page asks for
 * the square that holds every screen's crop (./size.ts), and lays it over the screen
 * itself.
 */
export type ShowRequest = {
  type: "show";
  date: string;
  theme: Theme;
  width: number;
  height: number;
  /**
   * Lay the roads out for inking in (core's ink/growth.ts), from the top of `view`, the part
   * of the frame on screen: asked for until the day's first frame is on screen.
   */
  grow?: { view: View };
};

/** A frame as asked for — at the size it was drawn, which is smaller where the one asked for didn't fit (core's ink/fit.ts). */
export type Frame = Omit<ShowRequest, "type"> & { type: "frame"; bitmap: ImageBitmap; growth?: Growth };

export type Reply =
  | { type: "stage"; date: string; stage: Stage }
  | { type: "city"; date: string; city: City }
  | Frame
  | { type: "error"; date: string; message: string };

export type EngineEnv = {
  deps: Omit<LoadDeps, "onStage">;
  render: (manifest: Manifest, theme: Theme, width: number, height: number) => Promise<ImageBitmap>;
  post: Post<Reply>;
};

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The engine's one entry point. Requests coalesce: only the newest is ever served,
 * so a burst of resizes costs one redraw, and a request for another day while one
 * is loading is taken up as soon as that load ends.
 */
export function createEngine(env: EngineEnv): (req: ShowRequest) => void {
  let day: { date: string; manifest: Manifest } | null = null;

  const load = async (date: string) => {
    try {
      const { manifest } = await loadDay(date, {
        ...env.deps,
        onStage: (stage) => env.post({ type: "stage", date, stage }),
      });
      env.post({ type: "city", date, city: manifest.city });
      return { date, manifest };
    } catch (e) {
      env.post({ type: "error", date, message: message(e) });
      return null;
    }
  };

  const requests: NewestQueue<ShowRequest> = newestOnly<ShowRequest>(async (req) => {
    if (day?.date !== req.date) {
      // Let go of the old day (tens of MB parsed) before parsing the next one.
      day = null;
      day = await load(req.date);
      // Nothing to draw; the next request for the day (the page's retry) loads it again.
      if (!day) return;
      // Asked again while the day loaded — a resize, a theme, another day: that's
      // served next, with the day in hand, rather than this one drawn first for a
      // page that has moved on.
      if (requests.waiting()) return;
    }
    const { manifest } = day;
    try {
      const fit = await renderFitting(req.width, req.height, (w, h) => env.render(manifest, req.theme, w, h));
      const growth = req.grow
        ? growthFor(manifest, mapBBox(manifest, fit.width, fit.height), DEFAULT_STYLE.preset, fit.width, fit.height, scaleView(req.grow.view, fit.scale))
        : undefined;
      env.post(
        { ...req, type: "frame", width: fit.width, height: fit.height, bitmap: fit.bitmap, growth },
        [fit.bitmap, ...(growth ? growthBuffers(growth) : [])],
      );
    } catch (e) {
      env.post({ type: "error", date: req.date, message: message(e) });
    }
  });

  return (req) => requests.push(req);
}
