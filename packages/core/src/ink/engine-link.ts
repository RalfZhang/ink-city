import { canDrawOffscreen } from "./offscreen";

// How a page reaches its map engine — the website's and the desktop window's alike,
// each with its own requests and replies: in a worker, so a parse of tens of MB and
// a draw of seconds never hold the page up; or, where a worker can't draw, the same
// engine on the main thread, where they do, but the map still arrives. The worker
// side is `runEngineWorker`, the page's `createEngineClient`; each app writes the
// two lines a bundler has to see itself (`new Worker(new URL(…))`, `import("./engine")`).

/** Where an engine replies: each reply, with the buffers to hand over rather than copy. */
export type Post<Rep> = (reply: Rep, transfer?: Transferable[]) => void;

/**
 * What a map worker posts: its engine's replies; or, first thing, whether it can draw
 * there — `ready`, or `unsupported` (no 2D OffscreenCanvas), so the page takes over.
 */
export type WorkerMessage<Rep> = Rep | { type: "ready" } | { type: "unsupported" };

/**
 * The body of a map worker: if it can draw here, the engine `start` makes, fed every
 * message; otherwise only `unsupported`, for the page to draw instead.
 */
export function runEngineWorker<Req, Rep>(start: (post: Post<Rep>) => (req: Req) => void): void {
  // Typed by hand rather than through the WebWorker lib, which clashes with the DOM
  // lib the apps compile against.
  const scope = self as unknown as {
    postMessage(message: WorkerMessage<Rep>, transfer?: Transferable[]): void;
    onmessage: ((event: MessageEvent<Req>) => void) | null;
  };
  if (!canDrawOffscreen()) {
    scope.postMessage({ type: "unsupported" });
    return;
  }
  const handle = start((reply, transfer) => scope.postMessage(reply, transfer));
  scope.onmessage = (event) => handle(event.data);
  scope.postMessage({ type: "ready" });
}

export type EngineClient<Req, Rep> = {
  /** Hand `req` to the engine, wherever it runs; a worker takes `transfer`'s buffers without a copy. */
  send(req: Req, transfer?: Transferable[]): void;
  /** Whether an engine has been started — a worker, or the main thread's — since the client was made or disposed. */
  running(): boolean;
  /** Hear every reply; returns the way to stop. Kept through `dispose`. */
  listen(fn: (reply: Rep) => void): () => void;
  /** Stop the engine, worker or not. Used again, the client starts another. */
  dispose(): void;
};

export type EngineClientOptions<Req, Rep> = {
  /** Start the map worker: `new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })`, written where the bundler sees it. */
  spawn: () => Worker;
  /** The same engine on the main thread, replying through `post`: imported on demand, as most pages never need it. */
  inline: (post: (reply: Rep) => void) => Promise<(req: Req) => void>;
  /**
   * As the main thread takes over: what the worker had been asked that still matters,
   * to ask its engine again first. Whatever is sent while the engine is on its way is
   * handed to it after these.
   */
  replay: () => { requests: Req[] };
  /**
   * Each request on its way to the worker, while its buffers are still here, and
   * whether the worker has said it can draw (`ready`) — after which taking over is
   * a crash's doing, and almost never comes.
   */
  toWorker?: (req: Req, ready: boolean) => void;
};

/**
 * The page's handle on its map engine: the worker when it can draw, otherwise the
 * same engine on the main thread. The switch happens once, when the worker reports
 * it can't draw (WebKit before 16.4) or fails to start or dies, and replays what
 * `replay` says. The worker is started on first use rather than when the client is
 * made: one made and thrown away — StrictMode builds everything twice in dev —
 * leaves no worker running.
 */
export function createEngineClient<Req, Rep extends { type: string }>(
  opts: EngineClientOptions<Req, Rep>,
): EngineClient<Req, Rep> {
  const listeners = new Set<(reply: Rep) => void>();
  const emit = (reply: Rep) => listeners.forEach((fn) => fn(reply));
  let worker: Worker | null = null;
  let ready = false;
  let inline: ((req: Req) => void) | null = null;
  // While the main thread's engine is being imported: what's sent meanwhile, in order.
  let held: Req[] | null = null;
  // Moved on by `dispose`: a takeover still importing the engine then isn't set up,
  // and an engine let go of can't be heard from.
  let generation = 0;

  const fallBack = () => {
    if (held || inline) return;
    worker?.terminate();
    worker = null;
    ready = false;
    held = [];
    held.unshift(...opts.replay().requests);
    const at = generation;
    void opts
      .inline((reply) => {
        if (at === generation) emit(reply);
      })
      .then((engine) => {
        // Handed over in order, `held` still standing meanwhile: a reply heard at once
        // that asks for more joins the end rather than jumping the queue.
        for (let i = 0; at === generation && held && i < held.length; i++) engine(held[i]);
        if (at !== generation) return;
        held = null;
        inline = engine;
      });
  };

  const start = () => {
    if (worker || inline || held) return;
    let w: Worker;
    try {
      w = opts.spawn();
    } catch {
      return fallBack();
    }
    worker = w;
    w.onmessage = (event: MessageEvent<WorkerMessage<Rep>>) => {
      // A message still on its way from a worker since let go of.
      if (worker !== w) return;
      const message = event.data;
      if (message.type === "unsupported") return fallBack();
      if (message.type === "ready") {
        ready = true;
        return;
      }
      emit(message as Rep);
    };
    w.onerror = () => {
      if (worker === w) fallBack();
    };
  };

  return {
    send(req, transfer) {
      start();
      if (inline) return inline(req);
      if (held) return void held.push(req);
      opts.toWorker?.(req, ready);
      worker?.postMessage(req, transfer ?? []);
    },
    running: () => worker !== null || inline !== null || held !== null,
    listen(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    dispose() {
      generation++;
      worker?.terminate();
      worker = null;
      ready = false;
      inline = null;
      held = null;
    },
  };
}
