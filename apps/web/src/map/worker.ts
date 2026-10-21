import { browserDeps } from "./deps";
import { drawMap } from "./draw";
import { createEngine, type Reply, type ShowRequest } from "./engine";

// The map worker: download, gunzip, a 25 MB JSON.parse and the whole draw happen
// here, on an OffscreenCanvas, so the page stays responsive while they do; the
// finished frame crosses back as an ImageBitmap, without a copy. See ./engine.ts.

// Typed by hand rather than through the WebWorker lib, which clashes with the DOM
// lib the rest of the app compiles against.
const scope = self as unknown as {
  postMessage(message: Reply, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<ShowRequest>) => void) | null;
};

/** Safari before 16.4 has OffscreenCanvas, but without a 2D context. */
function canDraw(): boolean {
  try {
    return typeof OffscreenCanvas !== "undefined" && new OffscreenCanvas(1, 1).getContext("2d") !== null;
  } catch {
    return false;
  }
}

if (!canDraw()) {
  scope.postMessage({ type: "unsupported" });
} else {
  const show = createEngine({
    deps: browserDeps(),
    render: async (manifest, theme, width, height) => {
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error(`no 2D context at ${width}×${height}`);
      drawMap(ctx as unknown as CanvasRenderingContext2D, manifest, theme, width, height);
      return canvas.transferToImageBitmap();
    },
    post: (reply, transfer) => scope.postMessage(reply, transfer),
  });
  scope.onmessage = (event) => show(event.data);
}
