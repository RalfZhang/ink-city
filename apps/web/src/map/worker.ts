import { runEngineWorker } from "@inkcity/core";
import { browserDeps } from "./deps";
import { paint } from "./draw";
import { createEngine, type Reply, type ShowRequest } from "./engine";

// The map worker: download, gunzip, a 25 MB JSON.parse and the whole draw happen
// here, on an OffscreenCanvas, so the page stays responsive while they do; the
// finished frame crosses back as an ImageBitmap, without a copy. See ./engine.ts;
// the worker's side of the talk is core's (ink/engine-link.ts).

runEngineWorker<ShowRequest, Reply>((post) => createEngine({ deps: browserDeps(), render: paint, post }));
