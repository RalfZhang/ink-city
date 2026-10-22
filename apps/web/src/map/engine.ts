import type { City } from "@inkcity/core";
import type { Theme } from "./draw";
import { growthBuffers, growthFor, type Growth } from "./growth";
import { loadDay, type LoadDeps, type Stage } from "./load";
import type { Manifest } from "./manifest";
import type { View } from "./size";

// The map's work, wherever it runs: in the map worker (./worker.ts) normally, on
// the main thread where a worker can't draw (./client.ts). Asked to `show` a day
// at a size and theme, it loads the day once, then draws it as often as the page
// asks — a resize or a theme switch redraws from memory and never refetches.

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
  /** The page's retry: load the day again though it failed — the one thing that does. */
  retry?: boolean;
  /**
   * Lay the roads out for inking in (./growth.ts), from the top of `view`, the part
   * of the frame on screen: asked for until the day's first frame is on screen.
   */
  grow?: { view: View };
};

export type Frame = Omit<ShowRequest, "type"> & { type: "frame"; bitmap: ImageBitmap; growth?: Growth };

export type Reply =
  | { type: "stage"; date: string; stage: Stage }
  | { type: "city"; date: string; city: City }
  | Frame
  | { type: "error"; date: string; message: string };

export type EngineEnv = {
  deps: Omit<LoadDeps, "onStage">;
  render: (manifest: Manifest, theme: Theme, width: number, height: number) => Promise<ImageBitmap>;
  post: (reply: Reply, transfer?: Transferable[]) => void;
};

/**
 * The engine's one entry point. Requests coalesce: only the newest is ever served,
 * so a burst of resizes costs one redraw, and a request for another day while one
 * is loading is taken up as soon as that load ends.
 */
export function createEngine(env: EngineEnv): (req: ShowRequest) => void {
  let latest: ShowRequest | null = null;
  let running = false;
  let day: { date: string; manifest: Manifest } | null = null;
  // The day whose load failed, until another day or a retry is asked for.
  let failed: string | null = null;
  // Kept apart from the request, which a resize may coalesce over before it's served.
  let retryAsked = false;

  const load = async (date: string) => {
    try {
      const { manifest } = await loadDay(date, {
        ...env.deps,
        onStage: (stage) => env.post({ type: "stage", date, stage }),
      });
      env.post({ type: "city", date, city: manifest.city });
      return { date, manifest };
    } catch (e) {
      env.post({ type: "error", date, message: e instanceof Error ? e.message : String(e) });
      return null;
    }
  };

  const run = async () => {
    if (running) return;
    running = true;
    try {
      while (latest) {
        const req = latest;
        if (day?.date !== req.date) {
          if (req.date === failed && !retryAsked) {
            // A resize or a theme switch over a day that couldn't be loaded: climbing
            // the whole ladder again for it would clear the error unasked.
            if (latest === req) latest = null;
            continue;
          }
          // Let go of the old day (tens of MB parsed) before parsing the next one.
          day = null;
          failed = null;
          retryAsked = false;
          const loaded = await load(req.date);
          if (!loaded) {
            // Nothing to draw; wait to be asked again (the page's retry).
            failed = req.date;
            if (latest === req) latest = null;
            continue;
          }
          day = loaded;
          if (latest.date !== day.date) continue;
        }
        const draw = latest;
        latest = null;
        try {
          const bitmap = await env.render(day.manifest, draw.theme, draw.width, draw.height);
          const growth = draw.grow ? growthFor(day.manifest, draw.width, draw.height, draw.grow.view) : undefined;
          env.post({ ...draw, type: "frame", bitmap, growth }, [bitmap, ...(growth ? growthBuffers(growth) : [])]);
        } catch (e) {
          env.post({ type: "error", date: draw.date, message: e instanceof Error ? e.message : String(e) });
        }
      }
    } finally {
      running = false;
    }
  };

  return (req) => {
    latest = req;
    if (req.retry) retryAsked = true;
    void run();
  };
}
