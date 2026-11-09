import { runEngineWorker } from "@inkcity/core";
import { createEngine, paint, type Reply, type Request } from "./engine";

// The map worker: the JSON.parse of a map's data and every draw of it happen here,
// on an OffscreenCanvas, so the window stays responsive while they do — a colour
// picker dragged across Style redraws the map behind it many times a second. The
// finished frame crosses back as an ImageBitmap, without a copy. See ./engine.ts;
// the worker's side of the talk is core's (ink/engine-link.ts).

runEngineWorker<Request, Reply>((post) => createEngine({ render: paint, post }));
