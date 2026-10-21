import type { Reply, ShowRequest } from "./engine";

export type MapClient = {
  show(req: ShowRequest): void;
  dispose(): void;
};

/**
 * The page's handle on the map engine: the worker when it can draw, otherwise the
 * same engine on the main thread — where the parse and the draw hold the page up
 * for a moment, but the map still arrives. The switch happens once, when the
 * worker reports it can't draw (Safari before 16.4) or fails to start at all, and
 * replays whatever was last asked of it.
 */
export function createMapClient(onReply: (reply: Reply) => void): MapClient {
  let worker: Worker | null = null;
  let inline: ((req: ShowRequest) => void) | null = null;
  let pending: ShowRequest | null = null;
  let disposed = false;
  let fellBack = false;

  const fallBack = async () => {
    if (fellBack) return;
    fellBack = true;
    worker?.terminate();
    worker = null;
    const [{ createEngine }, { browserDeps }, { drawMap }] = await Promise.all([
      import("./engine"),
      import("./deps"),
      import("./draw"),
    ]);
    if (disposed) return;
    inline = createEngine({
      deps: browserDeps(),
      render: async (manifest, theme, width, height) => {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error(`no 2D context at ${width}×${height}`);
        drawMap(ctx, manifest, theme, width, height);
        return createImageBitmap(canvas);
      },
      post: onReply,
    });
    if (pending) inline(pending);
  };

  try {
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<Reply>) => {
      if (event.data.type === "unsupported") void fallBack();
      else onReply(event.data);
    };
    worker.onerror = () => void fallBack();
  } catch {
    void fallBack();
  }

  return {
    show(req) {
      pending = req;
      if (inline) inline(req);
      else worker?.postMessage(req);
    },
    dispose() {
      disposed = true;
      worker?.terminate();
    },
  };
}
