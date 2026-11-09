import { createEngineClient } from "@inkcity/core";
import type { DrawJob, Reply, Request } from "./engine";

export type MapClient = {
  /** Hand over a map's data as load `id`: its `loaded` or `error` reply carries the same id. */
  load(key: string, id: number, bytes: ArrayBuffer): void;
  draw(job: DrawJob): void;
  /** Let go of the map held, until another is loaded. */
  unload(): void;
  /** Stop the worker, if one runs. Used again, the client starts another. */
  dispose(): void;
  /** Hear every reply; returns the way to stop. */
  listen(fn: (reply: Reply) => void): () => void;
};

/**
 * The window's handle on the map engine: the worker when it can draw, otherwise
 * the same engine on the main thread — where the parse and the draws hold the
 * window up for a moment, but the map still arrives. The switch is core's
 * (ink/engine-link.ts): once, when the worker reports it can't draw (WebKit before
 * 16.4, an older WebKitGTK) or fails to start or dies, replaying the map and the
 * picture last asked for.
 */
export function createMapClient(): MapClient {
  // What a takeover has to replay: the map until the worker has it (its bytes are
  // handed over to the worker, so they're copied first), and the last picture. Once
  // the worker has said it can draw, a load isn't copied any more: tens of MB copied
  // on the main thread for a takeover that, by then, almost never comes.
  let lastLoad: { key: string; id: number; bytes: ArrayBuffer } | null = null;
  let lastJob: DrawJob | null = null;

  const engine = createEngineClient<Request, Reply>({
    spawn: () => new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }),
    inline: async (post) => {
      const { createEngine, paint } = await import("./engine");
      return createEngine({ render: paint, post });
    },
    toWorker: (req, ready) => {
      if (req.type !== "load") return;
      lastLoad = ready ? null : { key: req.key, id: req.id, bytes: req.bytes.slice(0) };
    },
    replay: () => {
      const requests: Request[] = [];
      if (lastLoad) requests.push({ type: "load", ...lastLoad });
      if (lastJob) requests.push({ type: "draw", job: lastJob });
      lastLoad = null;
      return { requests };
    },
  });
  // The worker has the map now, or can't read it: the copy kept for a takeover can go.
  engine.listen((reply) => {
    if (reply.type === "loaded" || (reply.type === "error" && reply.seq === undefined)) lastLoad = null;
  });

  return {
    load(key, id, bytes) {
      engine.send({ type: "load", key, id, bytes }, [bytes]);
    },
    draw(job) {
      lastJob = job;
      engine.send({ type: "draw", job });
    },
    unload() {
      lastLoad = null;
      lastJob = null;
      // Not a worker started just to be told: a window put away since launch has nothing to let go of.
      if (engine.running()) engine.send({ type: "unload" });
    },
    dispose() {
      engine.dispose();
      lastLoad = null;
      lastJob = null;
    },
    listen: engine.listen,
  };
}
