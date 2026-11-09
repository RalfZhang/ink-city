// How both map engines take their requests — the website's `show`s and the desktop's
// draws: one at a time, and only the newest. A draw of the square is seconds of
// work at 6144², and the page asks for another on every settled resize, theme
// switch or colour dragged across Style; drawing each in turn would leave the map
// further behind with every one.

/** A queue that serves only the newest request, one at a time. */
export type NewestQueue<T> = {
  /** Ask for `req`, in place of whatever was waiting. */
  push(req: T): void;
  /**
   * Whether a request is waiting behind the one being served: a serve that has been
   * away a while (a day loading) gives way to it rather than finishing for a request
   * that's out of date.
   */
  waiting(): boolean;
  /** Drop whatever is waiting. The serve under way, if any, runs on. */
  clear(): void;
};

/** One turn of the event loop: whatever was delivered meanwhile — a worker's messages — is handled first. */
const yieldToEvents = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Serve requests through `serve`, one at a time and only the newest. Before taking
 * each one up — the first too — the queue yields a turn of the event loop: a draw
 * holds the thread, so what's asked meanwhile is only delivered once it lets go, and
 * taken in first it costs one draw, the newest, rather than one apiece.
 *
 * `serve` answers its own failures (both engines post them as replies). One that
 * escapes is a bug: it's reported as unhandled, and the queue goes on to whatever
 * is waiting.
 */
export function newestOnly<T>(serve: (req: T) => void | Promise<void>): NewestQueue<T> {
  let next: { req: T } | null = null;
  let running = false;

  const run = async () => {
    if (running) return;
    running = true;
    try {
      for (;;) {
        await yieldToEvents();
        const taken = next;
        if (!taken) return;
        next = null;
        await serve(taken.req);
      }
    } finally {
      running = false;
      // Left waiting only by a serve that threw: the normal way out is an empty queue.
      if (next) void run();
    }
  };

  return {
    push(req) {
      next = { req };
      void run();
    },
    waiting: () => next !== null,
    clear() {
      next = null;
    },
  };
}
