import type { Growth } from "./growth";

/** The longest step one animation frame may take: a tab in the background pauses the ink rather than letting it all land at once on return. */
const MAX_STEP_S = 1 / 20;

/**
 * Ink `bitmap` into `ctx` along `growth`'s roads (./growth.ts): every frame, each
 * road that the front has reached is stroked a little further — with the finished
 * frame as its pattern, so the pixels it uncovers are the frame's own, whatever
 * order the strokes land in. Once every road has grown, the whole frame goes down
 * on top, exact to the pixel, and `onDone` runs.
 *
 * Returns a stop function, for a newer frame that replaces this one (a resize, a
 * theme switch, the next day) — the caller paints that one itself.
 */
export function inkIn(
  ctx: CanvasRenderingContext2D,
  bitmap: ImageBitmap,
  growth: Growth,
  onDone: () => void,
): () => void {
  const { xy, first, cum, begin, strokes, speed } = growth;
  const pattern = ctx.createPattern(bitmap, "no-repeat");
  const settle = () => {
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    onDone();
  };
  if (!pattern) {
    settle();
    return () => {};
  }
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.strokeStyle = pattern;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  const paths = first.length - 1;
  /** How far along each path is inked. */
  const drawn = new Float32Array(paths);
  /** The segment each path's inked stretch ends on, by the vertex it starts at. */
  const at = first.slice(0, paths);
  /** Per run, the next path to take up, and those growing. */
  const next = strokes.map((_, r) => (r === 0 ? 0 : strokes[r - 1].end));
  const live: number[][] = strokes.map(() => []);

  /** Onto the current path: the point `c` along path segment v → v + 1. */
  const point = (v: number, c: number, move: boolean) => {
    const f = (c - cum[v]) / (cum[v + 1] - cum[v] || 1);
    const x = xy[2 * v] + (xy[2 * v + 2] - xy[2 * v]) * f;
    const y = xy[2 * v + 1] + (xy[2 * v + 3] - xy[2 * v + 1]) * f;
    if (move) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  };

  let raf = 0;
  let t = 0;
  let last: number | null = null;
  const frame = (now: number) => {
    // The clock starts with the first frame shown, so a page opened in a background
    // tab inks its map in when it's looked at.
    t += last === null ? 0 : Math.min(MAX_STEP_S, (now - last) / 1000);
    last = now;
    let pending = false;
    strokes.forEach((run, r) => {
      const growing = live[r];
      while (next[r] < run.end && begin[next[r]] <= t) growing.push(next[r]++);
      if (next[r] < run.end) pending = true;
      if (growing.length === 0) return;
      ctx.lineWidth = run.width;
      ctx.beginPath();
      for (let j = growing.length - 1; j >= 0; j--) {
        const i = growing[j];
        const end = first[i + 1] - 1;
        const length = cum[end];
        const from = drawn[i];
        const to = Math.min(length, (t - begin[i]) * speed);
        if (to > from) {
          let v = at[i];
          point(v, from, true);
          while (v < end && cum[v + 1] <= to) {
            v++;
            ctx.lineTo(xy[2 * v], xy[2 * v + 1]);
          }
          if (v < end) point(v, to, false);
          at[i] = v;
          drawn[i] = to;
        }
        if (to >= length) {
          growing[j] = growing[growing.length - 1];
          growing.pop();
        } else pending = true;
      }
      ctx.stroke();
    });
    if (pending) raf = requestAnimationFrame(frame);
    else {
      raf = 0;
      settle();
    }
  };
  raf = requestAnimationFrame(frame);

  return () => {
    if (!raf) return;
    cancelAnimationFrame(raf);
    raf = 0;
    bitmap.close();
  };
}
