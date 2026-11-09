import {
  bboxForScreen,
  drawScene,
  growthBuffers,
  growthFor,
  MAX_HALF_KM,
  newestOnly,
  paintBitmap,
  renderFitting,
  scaleView,
  type Bbox,
  type Growth,
  type LatLon,
  type Osm,
  type Post,
  type Style,
  type View,
} from "@inkcity/core";

// The window's map work, wherever it runs: in the map worker (./worker.ts)
// normally, on the main thread where a worker can't draw (./client.ts) — the
// switching is core's (ink/engine-link.ts), and so are the queue the pictures wait
// in (ink/queue.ts) and the halving of one too big to draw (ink/fit.ts). It's handed
// a map's data once — the same cached file the wallpaper is drawn from, tens of MB
// of JSON for a big city — then draws it as often as it's asked: the home's frame,
// as the website draws its map — the square of ground that holds the wallpaper's
// crop for every screen shape (core's ink/cover.ts), which the window lays over
// itself. That square is the ground the map's data was had for, so it's drawn whole.

/** One picture of the map. */
export type DrawJob = {
  /** The map it's of (`Status.mapKey`): drawn once that's the map loaded. */
  key: string;
  /** Counts up, so the window can tell a newer picture from an older one. */
  seq: number;
  style: Style;
  center: LatLon;
  /** Device pixels: the square's side. */
  side: number;
  /** Lay the roads out for inking in, too (core's ink/growth.ts), from the top of `view`, the part of the frame on screen. */
  grow?: { view: View };
};

/**
 * A map's data to hold, as the load `id` the window gave it: its answer says which
 * load it's about. Or a picture of it to draw — or the map let go of, while the
 * window has been put away a while (`useMapData`).
 */
export type Request =
  | { type: "load"; key: string; id: number; bytes: ArrayBuffer }
  | { type: "draw"; job: DrawJob }
  | { type: "unload" };

export type Reply =
  | { type: "loaded"; key: string; id: number }
  | { type: "frame"; key: string; seq: number; bitmap: ImageBitmap; growth?: Growth }
  /** The map couldn't be read — the load `id` says which — or, with its picture's `seq`, drawn. */
  | { type: "error"; key: string; id?: number; seq?: number; message: string };

export type EngineEnv = {
  render: (job: DrawJob, bbox: Bbox, osm: Osm) => Promise<ImageBitmap>;
  post: Post<Reply>;
};

/** A picture drawn for real, wherever the engine runs: the worker's and the main thread's `render`. */
export const paint: EngineEnv["render"] = (job, bbox, osm) =>
  paintBitmap(job.side, job.side, (ctx) =>
    drawScene(ctx, { bbox, width: job.side, height: job.side, style: job.style, osm }),
  );

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The engine's one entry point. One map is held at a time, and pictures coalesce: only the newest asked for is drawn. */
export function createEngine(env: EngineEnv): (req: Request) => void {
  let day: { key: string; osm: Osm } | null = null;
  // The newest picture taken up before its map was here — the window asks as soon
  // as it can — drawn once that map loads, unless a newer one is asked for first.
  let early: DrawJob | null = null;

  const pictures = newestOnly<DrawJob>(async (job) => {
    early = null;
    // The map as it was when the picture was taken up: a load or an unload meanwhile
    // (the main thread's draw lets go while its bitmap is made) doesn't pull it away.
    const held = day;
    if (!held || held.key !== job.key) {
      early = job;
      return;
    }
    // The wallpaper's ground: its longer side spans the map's whole width.
    const bbox = bboxForScreen(job.center.lat, job.center.lon, MAX_HALF_KM, 1);
    try {
      const fit = await renderFitting(job.side, job.side, (side) => env.render({ ...job, side }, bbox, held.osm));
      const growth = job.grow
        ? growthFor(held.osm, bbox, job.style.preset, fit.width, fit.height, scaleView(job.grow.view, fit.scale))
        : undefined;
      env.post(
        { type: "frame", key: job.key, seq: job.seq, bitmap: fit.bitmap, growth },
        [fit.bitmap, ...(growth ? growthBuffers(growth) : [])],
      );
    } catch (e) {
      env.post({ type: "error", key: job.key, seq: job.seq, message: message(e) });
    }
  });

  return (req) => {
    if (req.type === "draw") return pictures.push(req.job);
    if (req.type === "unload") {
      day = null;
      early = null;
      pictures.clear();
      return;
    }
    try {
      // Let go of the old map (tens of MB parsed) before parsing the next one.
      day = null;
      day = { key: req.key, osm: JSON.parse(new TextDecoder().decode(req.bytes)) as Osm };
      env.post({ type: "loaded", key: req.key, id: req.id });
      // Its picture, if one was asked for first — and nothing newer is on its way,
      // which drops it once it's taken up.
      if (early?.key === req.key && !pictures.waiting()) pictures.push(early);
    } catch (e) {
      env.post({ type: "error", key: req.key, id: req.id, message: message(e) });
    }
  };
}
