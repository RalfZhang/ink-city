import { createEngineClient } from "@inkcity/core";
import type { Reply, ShowRequest } from "./engine";

export type MapClient = {
  show(req: ShowRequest): void;
  dispose(): void;
};

/**
 * The page's handle on the map engine: the worker when it can draw, otherwise the
 * same engine on the main thread — where the parse and the draw hold the page up
 * for a moment, but the map still arrives. The switch is core's
 * (ink/engine-link.ts), shared with the desktop's window: once, when the worker
 * reports it can't draw (Safari before 16.4) or fails to start or dies, replaying
 * whatever was last asked of it. The worker starts with the first `show`.
 */
export function createMapClient(onReply: (reply: Reply) => void): MapClient {
  let last: ShowRequest | null = null;
  const engine = createEngineClient<ShowRequest, Reply>({
    spawn: () => new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }),
    inline: async (post) => {
      const [{ createEngine }, { browserDeps }, { paint }] = await Promise.all([
        import("./engine"),
        import("./deps"),
        import("./draw"),
      ]);
      return createEngine({ deps: browserDeps(), render: paint, post });
    },
    // The day is fetched again where the worker had it: what the page asked last is all it needs.
    replay: () => ({ requests: last ? [last] : [] }),
  });
  engine.listen(onReply);
  return {
    show(req) {
      last = req;
      engine.send(req);
    },
    dispose: () => engine.dispose(),
  };
}
