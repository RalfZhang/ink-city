import { useLayoutEffect, useRef } from "react";
import { useDevicePixelRatio, useElementSize } from "@inkcity/ui/lib/hooks";
import {
  AIRPORT_WIDTHS,
  bboxForScreen,
  drawScene,
  METERS_PER_WEIGHT,
  type AirportFeature,
  type Geom,
  type Osm,
  type Style,
} from "@inkcity/core";

// The samples beside Lab's layers: not today's map, which may have no railway or
// airport worth showing, but one small made-up place laid out to show each setting
// at its clearest — water and a railway as a map's legend draws them, a runway, a
// cable car — drawn by the wallpaper's own renderer in the draft's colours, so a
// sample is exactly what the setting does.
//
// The three layers' samples stand one above another, so they're framed alike: what
// each shows sits in the middle of its box, and each scene's span is picked (for
// sheet.css's 120px box) so their thinnest lines — a brook, a taxiway, a cable —
// all come out about 1px wide. A runway needs far more ground than a cable car, so
// the spans differ; the weight of the ink doesn't.

/** Metres east/north of the sample's middle, as the renderer's coordinates (1° ≈ 111.32 km at the equator). */
const M = 1 / 111_320;
const pt = ([x, y]: [number, number]): Geom => ({ lat: y * M, lon: x * M });
const line = (pts: [number, number][]) => pts.map(pt);

/** `pts` rounded off into a legend's soft curve: three rounds of Chaikin's corner cutting. An open line keeps its ends; `closed` rounds a ring. */
function curve(pts: [number, number][], closed = false): Geom[] {
  let p = pts;
  for (let round = 0; round < 3; round++) {
    const out: [number, number][] = closed ? [] : [p[0]];
    const n = closed ? p.length : p.length - 1;
    for (let i = 0; i < n; i++) {
      const [ax, ay] = p[i];
      const [bx, by] = p[(i + 1) % p.length];
      out.push([0.75 * ax + 0.25 * bx, 0.75 * ay + 0.25 * by], [0.25 * ax + 0.75 * bx, 0.25 * ay + 0.75 * by]);
    }
    if (!closed) out.push(p[p.length - 1]);
    p = out;
  }
  return line(p);
}

/**
 * The airport sample's runway: its middle (the sample's metres), its bearing (degrees
 * anticlockwise from east) and half its length. The middle is raised by half the
 * taxiways' reach, so the airfield as a whole sits in the middle of the box.
 */
const RUNWAY = { x: 0, y: 65, deg: 12, half: 560 };

/** A straight, in metres, or `[r, deg]`: a turn of `deg` degrees on a circle of radius `r` m, positive to the right. */
type Step = number | [r: number, deg: number];

/**
 * A taxiway's centreline as one is laid out: off the runway's centreline square on,
 * `u` m along it, then on in straights and the arcs tangent to them. In metres along
 * the runway (u, toward its east end) and across it (v, toward the taxiways, on its
 * right looking east).
 */
function taxiway(u: number, steps: Step[]): [number, number][] {
  let v = 0;
  let heading = Math.PI / 2;
  const pts: [number, number][] = [[u, v]];
  for (const step of steps) {
    if (typeof step === "number") {
      u += step * Math.cos(heading);
      v += step * Math.sin(heading);
      pts.push([u, v]);
      continue;
    }
    const [r, deg] = step;
    const turn = (deg * Math.PI) / 180;
    const side = Math.sign(turn);
    const [cu, cv] = [u - side * r * Math.sin(heading), v + side * r * Math.cos(heading)];
    const n = Math.ceil(Math.abs(deg) / 3);
    for (let i = 1; i <= n; i++) {
      const h = heading + (turn * i) / n;
      u = cu + side * r * Math.sin(h);
      v = cv - side * r * Math.cos(h);
      pts.push([u, v]);
    }
    heading += turn;
  }
  return pts;
}

/** Metres along and across the runway, as `taxiway` walks them, as the renderer's coordinates. */
function fieldLine(pts: [number, number][]): Geom[] {
  const a = (RUNWAY.deg * Math.PI) / 180;
  const [cos, sin] = [Math.cos(a), Math.sin(a)];
  return line(pts.map(([u, v]): [number, number] => [RUNWAY.x + u * cos + v * sin, RUNWAY.y + u * sin - v * cos]));
}

/** The airport sample's runway and taxiways (see `SCENES.airport`). */
function airport(): AirportFeature[] {
  // In by half a taxiway's drawn width, so an end connector's outer edge lines up with the runway's end.
  const end = RUNWAY.half - (AIRPORT_WIDTHS.taxiway * METERS_PER_WEIGHT) / 2;
  const west = taxiway(-end, [100, [30, -60], 140, [200, -30]]);
  const east = taxiway(end, [100, [30, 60], 140, [200, 30]]);
  // Where the end connectors land: the parallel taxiway, ~300 m off the runway.
  const parallel = west[west.length - 1][1];
  return [
    { kind: "runway", line: fieldLine([[-RUNWAY.half, 0], [RUNWAY.half, 0]]) },
    // One way: off the runway at its west end, along the parallel, and back onto it at the east end.
    { kind: "taxiway", line: fieldLine([...west, ...east.reverse()]) },
    { kind: "taxiway", line: fieldLine(taxiway(-240, [parallel - 135, [135, -90]])) },
    { kind: "taxiway", line: fieldLine(taxiway(240, [parallel - 135, [135, 90]])) },
  ];
}

type Scene = { osm: Osm; halfKm: number };

export const SCENES = {
  /**
   * A legend's sample: a river in from the left, a brook joining it, the lake it
   * runs into in the middle of the box, and on out to the right — a little wider
   * below the lake than above it. The renderer widths a waterway by its class
   * (core's `WATER_LINE_WEIGHTS`), so the brook is a stream, the river a canal's
   * width above the lake and a river's below it.
   */
  water: {
    halfKm: 0.44,
    osm: {
      v: 8,
      elements: [],
      water: [
        {
          kind: "line",
          cls: "stream",
          line: curve([[-445, 180], [-410, 167], [-393, 162], [-370, 150], [-350, 130], [-330, 115], [-315, 105], [-300, 100], [-282, 97], [-264, 90], [-240, 77], [-214, 56], [-194, 32], [-168, 6], [-143, -11], [-114, -22]]),
        },
        {
          kind: "line",
          cls: "canal",
          line: curve([[-437, 16], [-395, -8], [-336, -2], [-252, -8], [-218, -25], [-185, -35], [-151, -34], [-114, -22], [-67, -13], [0, -16]]),
        },
        {
          kind: "line",
          cls: "river",
          line: curve([[132, -30], [202, -41], [252, -61], [294, -78], [336, -98], [378, -104], [437, -114]]),
        },
        {
          kind: "area",
          polygon: {
            outer: curve([[-18, -13], [-5, 20], [34, 37], [90, 52], [125, 44], [154, 11], [170, -26], [146, -66], [104, -55], [12, -48], [-13, -31]], true),
          },
        },
      ],
    },
  },
  /**
   * A runway and its parallel taxiway, laid out as an airfield is: every taxiway
   * leaves the runway square on, running straight past where an aircraft holds
   * short (a pilot there sees both ways along the runway), and turns only on arcs
   * tangent to its straights. Each end's connector reaches the parallel by a 30°
   * diagonal; between them, two exits turn onto it toward the middle. The radii
   * (120–200 m) are several times a real airfield's, whose turns at ~22 m to the
   * sample's pixel would read as corners.
   */
  airport: {
    halfKm: 0.58,
    osm: { v: 8, elements: [], airports: airport() },
  },
  /** A legend's sample: one stretch of track, straight across. */
  rail: {
    halfKm: 0.25,
    osm: { v: 8, elements: [], railways: [{ line: line([[-400, 0], [400, 0]]) }] },
  },
  /**
   * One cable, rising across. Cabins hang every 144 m from its start (AERIALWAY's
   * spacing), so a half-length of five of those puts one on the middle, and at
   * this span just it and two either side fall inside the box, the next pair clear
   * of its edges.
   */
  cable: {
    halfKm: 0.45,
    osm: { v: 8, elements: [], aerialways: [{ line: line([[-683, -227], [683, 227]]) }] },
  },
} satisfies Record<string, Scene>;

/** One sample, filling its box: `scene`, drawn in `style`. */
export default function Sample({ scene, style }: { scene: keyof typeof SCENES; style: Style }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  // The canvas fills its tile (sheet.css), so its own size is the tile's.
  const size = useElementSize(canvas);
  const dpr = useDevicePixelRatio();

  const styleKey = JSON.stringify(style);
  useLayoutEffect(() => {
    const el = canvas.current;
    if (!el || !size || size.width <= 0 || size.height <= 0) return;
    const width = Math.round(size.width * dpr);
    const height = Math.round(size.height * dpr);
    el.width = width;
    el.height = height;
    const ctx = el.getContext("2d");
    if (!ctx) return;
    const { osm, halfKm } = SCENES[scene];
    drawScene(ctx, { bbox: bboxForScreen(0, 0, halfKm, width / height), width, height, style, osm });
    // `style` is compared by value.
  }, [scene, size, dpr, styleKey]);

  return <canvas ref={canvas} aria-hidden />;
}
