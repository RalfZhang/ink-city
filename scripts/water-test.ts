#!/usr/bin/env -S npx tsx
// Verifies the water generalizer (packages/core/src/water) on made-up places small
// enough to reason about. What it does to real cities was settled in a lab against
// rendered maps; this pins what must hold however it is retuned:
//   • the raster that tells water from land fills a cell whose centre is inside
//     (nonzero winding), the left edge counting and the right one not, keeps a
//     hole open, and leaves alone a sliver that covers no centre,
//   • a pond under 2.3 ha goes and a lake stays, its outer ring wound
//     counter-clockwise and its hole clockwise, so one nonzero fill draws them,
//   • a river on land is smoothed, yet no point of it moves more than 20 m from
//     where it was mapped, and its two ends stay put,
//   • where another river ends on it, it still runs through that point,
//   • pieces of one canal cut at a bridge are one body (none dropped for being short
//     under the bridge), while a ditch split lengthwise, or glued to a lake, is still
//     too thin to draw,
//   • a lake standing alone is linked to another by the unnamed drain between them
//     (the data's `minorWater`), once — never a loop — by the best-graded route before
//     the shortest, and not beyond 2 km; and the lakes keep the shape they had,
//   • cutting to the map keeps a ring's winding and drops only what lies outside,
//   • `waterShapes` is worked out once per map, though its data be parsed anew; a
//     map without water has none, nor has a map of another span; and a failure
//     leaves the water as mapped.
// Exits non-zero (printing every violation) on failure, so it can gate CI.
//
//   pnpm water-test

import { bboxForScreen, M_PER_DEG_LAT as M, MAX_HALF_KM, type Geom, type Osm, type WaterFeature, type WaterLine } from "@inkcity/core";
import { clipLine, clipRing, generalize, waterShapes } from "@inkcity/core/water";
import { Raster } from "../packages/core/src/water/mask";

let checks = 0;
let failures = 0;
function check(ok: boolean, what: string): void {
  checks++;
  if (!ok) {
    failures++;
    console.error(`✗ ${what}`);
  }
}

// ── the raster ────────────────────────────────────────────────────────────────
{
  // 10×10 cells of 1 m, the top row's top edge at y = 10 (rows run south)
  const ras = new Raster(0, 10, 1, 10, 10);
  const cells = (rings: { x: number; y: number }[][]) => {
    const got = new Set<string>();
    ras.fill(rings.map((r) => r.map((p) => ({ ...p, corner: false }))), (row, c0, c1) => { for (let c = c0; c <= c1; c++) got.add(`${c},${row}`); });
    return got;
  };
  const sq = (x0: number, y0: number, x1: number, y1: number) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
  const box = cells([sq(2, 2, 5, 5)]);
  check(box.size === 9 && ["2,5", "4,5", "2,7", "4,7"].every((c) => box.has(c)), `a 3×3 m square fills its 9 cells (got ${[...box].join(" ")})`);
  const holed = cells([sq(2, 2, 5, 5), sq(3, 3, 4, 4).reverse()]);
  check(holed.size === 8 && !holed.has("3,6"), `a hole wound the other way stays open (got ${holed.size} cells)`);
  check(cells([sq(2.1, 2, 2.4, 5)]).size === 0, "a sliver over no cell's centre fills nothing");
  const edges = cells([sq(2.5, 2, 5.5, 5)]);
  check(edges.has("2,6") && !edges.has("5,6"), "a side through cell centres: the left one counts, the right one not");
  check(cells([sq(-5, 2, 15, 3)]).size === 10, "a shape running off both sides fills the row across the raster");
  // two shapes in one path, 1.8 cells apart in row 4: the canvas the generalizer was
  // tuned on (cairo) fills the cell between them, unless every side is horizontal or vertical
  const pair = (l: number, r: number, lean: number) => cells([
    [{ x: 1, y: 6 }, { x: l - lean, y: 6 }, { x: l + lean, y: 5 }, { x: 1, y: 5 }].reverse(),
    [{ x: r - lean, y: 6 }, { x: 8, y: 6 }, { x: 8, y: 5 }, { x: r + lean, y: 5 }].reverse(),
  ]);
  check(pair(3.54, 5.4, 0.04).has("4,4"), "a gap of one cell between slanted sides is filled, as cairo fills it");
  check(!pair(3.54, 5.4, 0).has("4,4"), "…and left between vertical ones");
}

// ── the generalizer, on a made-up place ─────────────────────────────────────
const LAT = 50, LON = 10, K = Math.cos((LAT * Math.PI) / 180);
/** Metres east and north of the centre, as lat/lon. */
const geo = (x: number, y: number): Geom => ({ lat: LAT + y / M, lon: LON + x / (M * K) });
/** And back. */
const plane = (g: { lat: number; lon: number }) => ({ x: (g.lon - LON) * M * K, y: (g.lat - LAT) * M });
/** A point of the generalizer's plane (x = lon·cos(lat₀), y = lat, in metres), as metres from the centre. */
const local = (p: { x: number; y: number }) => ({ x: p.x - LON * M * K, y: p.y - LAT * M });
const ring = (pts: [number, number][]) => [...pts, pts[0]].map(([x, y]) => geo(x, y));
const square = (cx: number, cy: number, h: number): [number, number][] => [[cx - h, cy - h], [cx + h, cy - h], [cx + h, cy + h], [cx - h, cy + h]];
const signedArea = (r: { x: number; y: number }[]) => { let s = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += r[j].x * r[i].y - r[i].x * r[j].y; return s / 2; };
const distToLine = (p: { x: number; y: number }, l: [number, number][]) => {
  let best = Infinity;
  for (let i = 0; i + 1 < l.length; i++) {
    const [ax, ay] = l[i], [bx, by] = l[i + 1], dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.y - ay) * dy) / L)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx - p.x, ay + t * dy - p.y));
  }
  return best;
};

// a river on land, 3 km across the map's north, zigzagging 40 m either way every 100 m
const river: [number, number][] = Array.from({ length: 31 }, (_, i) => [-1500 + 100 * i, 3000 + (i % 2 ? 40 : -40)]);
// another river, coming from the south, ending on the first one halfway along one of its sides
const join: [number, number] = [-1450, 3000];
const branch: [number, number][] = [[-1450, 1400], [-1440, 2200], [-1452, 2600], join];
const water: WaterFeature[] = [
  // a pond of 0.25 ha, and a lake of 9 ha with a 4 ha island in it
  { kind: "area", polygon: { outer: ring(square(-2000, 0, 25)) } },
  { kind: "area", polygon: { outer: ring(square(2000, 0, 150)), holes: [ring(square(2000, 0, 100)).reverse()] } },
  { kind: "line", cls: "river", line: river.map(([x, y]) => geo(x, y)) },
  { kind: "line", cls: "river", line: branch.map(([x, y]) => geo(x, y)) },
];
const sq = bboxForScreen(LAT, LON, MAX_HALF_KM, 1);
{
  const g = generalize(water, LAT, sq, [], []);
  check(g.fills.length === 1, `the pond goes, the lake stays (${g.fills.length} bodies)`);
  const lake = g.fills[0] ?? [];
  check(lake.length === 2, `the lake keeps its island (${lake.length} rings)`);
  check(signedArea(lake[0] ?? []) > 0 && signedArea(lake[1] ?? []) < 0, "the outer ring winds counter-clockwise, the hole clockwise");

  const main = g.lines.map((l) => l.pts.map(local)).find((pts) => Math.hypot(pts[0].x - river[0][0], pts[0].y - river[0][1]) < 1e-6);
  check(!!main, "the river is drawn, from where it starts");
  if (main) {
    const last = main[main.length - 1];
    check(Math.hypot(last.x - river[30][0], last.y - river[30][1]) < 1e-6, "…and to where it ends");
    let most = 0;
    for (const p of main) most = Math.max(most, distToLine(p, river));
    check(most <= 20, `no point of it moves more than 20 m from the river as mapped (at most ${most.toFixed(2)} m)`);
    check(most > 10, `it is smoothed, not left as mapped (it moves at most ${most.toFixed(2)} m)`);
    check(main.some((p) => Math.hypot(p.x - join[0], p.y - join[1]) < 1e-6), "it still runs through where the other river ends on it");
  }
}

// ── pieces of one water: merged first ───────────────────────────────────────
{
  // a canal 22 m wide and 300 m long, cut into three at two bridges (the middle piece 8 m
  // long), the pieces sharing their cut sides vertex to vertex: alone, each is too short a
  // strip to keep; merged, the canal is one
  const canal: WaterFeature[] = [[-150, -4], [-4, 4], [4, 150]].map(([x0, x1]) => ({ kind: "area", polygon: { outer: ring([[x0, -11], [x1, -11], [x1, 11], [x0, 11]]) } }));
  const g = generalize(canal, LAT, sq, [], []);
  check(g.fills.length === 1, `a canal cut at its bridges is one body (${g.fills.length})`);
  const inside = (r: { x: number; y: number }[], x: number, y: number) => { let ins = false; for (let a = 0, b = r.length - 1; a < r.length; b = a++) if ((r[a].y > y) !== (r[b].y > y) && x < ((r[b].x - r[a].x) * (y - r[a].y)) / (r[b].y - r[a].y) + r[a].x) ins = !ins; return ins; };
  check(g.fills.some((b) => inside(b[0].map(local), 0, 0)), "…drawn under the bridge too");
  // a ditch 8 m wide split lengthwise into two 4 m halves, and another glued end-on to a lake
  const lake: [number, number][] = [[-100, -100], [100, -100], [100, -4], [100, 4], [100, 100], [-100, 100]];
  const thin: WaterFeature[] = [
    { kind: "area", polygon: { outer: ring([[-400, 1000], [0, 1000], [0, 1004], [-400, 1004]]) } },
    { kind: "area", polygon: { outer: ring([[-400, 1004], [0, 1004], [0, 1008], [-400, 1008]]) } },
    { kind: "area", polygon: { outer: ring(lake) } },
    { kind: "area", polygon: { outer: ring([[100, -4], [400, -4], [400, 4], [100, 4]]) } },
  ];
  const t = generalize(thin, LAT, sq, [], []);
  check(t.fills.length === 1 && t.fills[0][0].map(local).every((p) => p.x < 130 && p.y < 500), `the split ditch stays undrawn and the lake doesn't take in the ditch glued to it (${t.fills.length} bodies)`);
}

// ── water standing alone: linked ────────────────────────────────────────────
{
  // two lakes of 4 ha, 500 m apart (their facing shores), and an unnamed drain between them
  const lakeA: WaterFeature = { kind: "area", polygon: { outer: ring(square(-350, -3000, 100)) } };
  const lakeB: WaterFeature = { kind: "area", polygon: { outer: ring(square(350, -3000, 100)) } };
  const line = (cls: "drain" | "ditch" | "stream", pts: [number, number][]): WaterLine => ({ kind: "line", cls, line: pts.map(([x, y]) => geo(x, y)) });
  const drain = line("drain", [[-250, -3000], [0, -3010], [250, -3000]]);
  const drawnOf = (g: ReturnType<typeof generalize>, cls: string) => g.lines.filter((l) => l.cls === cls).map((l) => l.pts.map(local));
  const spans = (pts: { x: number; y: number }[] | undefined) => !!pts && Math.min(...pts.map((p) => p.x)) <= -240 && Math.max(...pts.map((p) => p.x)) >= 240;
  const alone = generalize([lakeA, lakeB], LAT, sq, [], []);
  const linked = generalize([lakeA, lakeB], LAT, sq, [], [], [drain]);
  check(alone.lines.length === 0, "without the drains, the lakes stand alone");
  check(drawnOf(linked, "drain").length === 1 && spans(drawnOf(linked, "drain")[0]), `the unnamed drain between them is drawn, shore to shore (${drawnOf(linked, "drain").length})`);
  const same = alone.fills.length === linked.fills.length && alone.fills.every((b, i) => b[0].length === linked.fills[i][0].length && b[0].every((p, j) => p.x === linked.fills[i][0][j].x && p.y === linked.fills[i][0][j].y));
  check(same, "the lakes keep exactly the shape they had alone");
  // a second, longer drain between the same two: a loop, not drawn
  const around = line("drain", [[-350, -2900], [-350, -2700], [350, -2700], [350, -2900]]);
  const twice = generalize([lakeA, lakeB], LAT, sq, [], [], [around, drain]);
  check(drawnOf(twice, "drain").length === 1 && spans(drawnOf(twice, "drain")[0]) && drawnOf(twice, "drain")[0].every((p) => p.y < -2950), "of two drains between the same lakes, only the shorter is drawn: never a loop");
  // an unnamed stream from A that reaches B through a pond too thin to keep (6 m wide), longer
  // than the drain: the route's lowest piece is a stream, which outranks a drain
  const stream = line("stream", [[-350, -3100], [-350, -3300], [350, -3300], [350, -3150]]);
  const pond: WaterFeature = { kind: "area", polygon: { outer: ring([[347, -3150], [353, -3150], [353, -3100], [347, -3100]]) } };
  const graded = generalize([lakeA, lakeB, pond, stream], LAT, sq, [], [], [drain]);
  check(drawnOf(graded, "stream").length === 1 && drawnOf(graded, "drain").length === 0 && graded.fills.length === 3, `the longer stream (and the pond it runs through) is drawn rather than the shorter drain (${drawnOf(graded, "stream").length} stream, ${drawnOf(graded, "drain").length} drain, ${graded.fills.length} bodies)`);
  // lakes 2.6 km apart: too far
  const far = generalize([lakeA, { kind: "area", polygon: { outer: ring(square(2450, -3000, 100)) } }], LAT, sq, [], [], [line("ditch", [[-250, -3000], [2350, -3000]])]);
  check(far.lines.length === 0, "a link longer than 2 km is not drawn");
}

// ── cut to the map ──────────────────────────────────────────────────────────
{
  const v = (pts: [number, number][]) => pts.map(([x, y]) => ({ x, y, corner: false }));
  const b = { x0: 0, y0: 0, x1: 2, y1: 2 };
  const cut = clipRing(v([[-1, -1], [1, -1], [1, 1], [-1, 1]]), b);
  check(Math.abs(signedArea(cut) - 1) < 1e-9, `a square half off the box keeps the quarter inside, wound the same way (area ${signedArea(cut)})`);
  const hole = clipRing(v([[-1, -1], [-1, 1], [1, 1], [1, -1]]), b);
  check(Math.abs(signedArea(hole) + 1) < 1e-9, "…and a hole the other way");
  check(clipRing(v([[5, 5], [6, 5], [6, 6]]), b).length === 0, "a ring wholly outside goes");
  const pieces = clipLine(v([[-5, 1], [1, 1], [1, 5], [9, 5], [9, 1.5], [1.5, 1.5], [1.5, -5]]), b);
  check(pieces.length === 2 && pieces[0].length === 3 && pieces[1].length === 3, `a line in and out of the box comes in two pieces, each a vertex past the box (${pieces.map((p) => p.length).join(", ")})`);
}

// ── waterShapes ─────────────────────────────────────────────────────────────
{
  const osm: Osm = { v: 8, elements: [], water };
  const first = waterShapes(osm, sq), again = waterShapes(osm, bboxForScreen(LAT, LON, MAX_HALF_KM, 16 / 10));
  check(!!first && first === again, "worked out once per map, whatever crop of it is drawn");
  check(waterShapes(structuredClone(osm), sq) === first, "…and once for the same data parsed anew");
  check(waterShapes({ v: 8, elements: [] }, sq) === undefined, "a map without water has none");
  check(waterShapes(osm, bboxForScreen(LAT, LON, 2 * MAX_HALF_KM, 1)) === undefined, "a map of another span has none: the work is tuned for the apps' square");
  // a case the generalizer doesn't handle (here a line without points) is drawn as mapped, not
  // thrown, and told to the host's log once per map
  const told: string[] = [];
  const bad: Osm = { v: 8, elements: [], water: [...water, { kind: "line", cls: "river", line: null as unknown as Geom[] }] };
  let broken: ReturnType<typeof waterShapes> | "threw";
  try {
    broken = waterShapes(bad, sq, (m) => told.push(m));
    waterShapes(bad, sq, (m) => told.push(m));
  } catch {
    broken = "threw";
  }
  check(broken === undefined, `a failure in the generalizer leaves the water as mapped (got ${broken === "threw" ? "a throw" : "shapes"})`);
  check(told.length === 1 && told[0].includes("TypeError"), `…and is reported once per map, saying what went wrong (${told.length} reports)`);
  // a lake reaching 3 km past the map's east edge is handed over cut 250 m past it
  const east = plane({ lat: LAT, lon: sq.east }).x;
  const wide = waterShapes({ v: 8, elements: [], water: [{ kind: "area", polygon: { outer: ring([[east - 1000, -500], [east + 3000, -500], [east + 3000, 500], [east - 1000, 500]]) } }] }, sq);
  const xs = (wide?.fills ?? []).flat(2).map((p) => plane(p).x);
  check(xs.length > 0 && Math.max(...xs) <= east + 250 + 1e-6, `water past the map is cut 250 m past its edge (reaches ${(Math.max(...xs) - east).toFixed(1)} m)`);
}

if (failures > 0) {
  console.error(`✗ ${failures} of ${checks} water checks failed`);
  process.exit(1);
}
console.log(`✓ water: ${checks} checks (raster, keep and drop, winding, the river's 20 m cap and its ends, junctions, pieces merged, water linked, cutting to the map, caching, the span, failures)`);
