// A raster of the map's plane, for "is there water here": a cell is in a shape
// where its centre is inside it (nonzero winding), as a canvas fills a path with
// antialiasing off. Written out rather than drawn on a canvas, so it is the same
// wherever it runs (a browser's canvas can't turn antialiasing off), and the same,
// cell for cell, as the canvas the generalizer was worked out on — node-canvas,
// i.e. cairo: points held to 1/256 of a cell; each side's crossing with a row taken
// just above the row's centre and down to that grid; and, as cairo's mono scan
// converter does, a gap of a cell or less between two runs of a row filled too —
// except in a path of only horizontal and vertical sides, which cairo fills as
// boxes, leaving it.

import type { V } from "./geom";

/** Fixed-point units per cell. */
const ONE = 256;

/** A coordinate in fixed-point units, rounded to nearest, a tie to even (as cairo's `_cairo_fixed_from_double`). */
function fixed(v: number): number {
  const t = v * ONE, r = Math.round(t);
  return r - t === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** ⌊a / b⌋ for integers (b > 0), exact while a stays within 2⁵³. */
function floorDiv(a: number, b: number): number {
  let q = Math.floor(a / b);
  if (q * b > a) q--;
  else if ((q + 1) * b <= a) q++;
  return q;
}

export class Raster {
  /**
   * `w`×`h` cells of `cell` m, the first row's top-left corner at (`x0`, `y1`) —
   * rows run southward, as a canvas's do.
   */
  constructor(
    readonly x0: number,
    readonly y1: number,
    readonly cell: number,
    readonly w: number,
    readonly h: number,
  ) {}

  /** The cell a point falls in, or -1 off the raster. */
  index(x: number, y: number): number {
    const cx = Math.floor((x - this.x0) / this.cell), cy = Math.floor((this.y1 - y) / this.cell);
    return cx < 0 || cy < 0 || cx >= this.w || cy >= this.h ? -1 : cy * this.w + cx;
  }

  /** Every cell the rings cover, filled as one path (nonzero), as runs of cells: `span(row, first, last)`. */
  fill(rings: readonly V[][], span: (row: number, c0: number, c1: number) => void): void {
    const { x0, y1, cell, w, h } = this;
    // the sides, in fixed-point cell units, top to bottom
    const sx: number[] = [], sy: number[] = [], ex: number[] = [], ey: number[] = [], dirs: number[] = [];
    let top = Infinity, bot = -Infinity, rectilinear = true;
    for (const r of rings) {
      const n = r.length;
      if (n < 2) continue;
      for (let j = 0; j < n; j++) {
        const a = r[j], b = r[(j + 1) % n];
        const Ya = fixed((y1 - a.y) / cell), Yb = fixed((y1 - b.y) / cell);
        if (Ya === Yb) continue;
        const Xa = fixed((a.x - x0) / cell), Xb = fixed((b.x - x0) / cell);
        if (Xa !== Xb) rectilinear = false;
        if (Ya < Yb) { sx.push(Xa); sy.push(Ya); ex.push(Xb); ey.push(Yb); dirs.push(1); }
        else { sx.push(Xb); sy.push(Yb); ex.push(Xa); ey.push(Ya); dirs.push(-1); }
        top = Math.min(top, Ya, Yb);
        bot = Math.max(bot, Ya, Yb);
      }
    }
    if (!dirs.length) return;
    // a row is crossed by a side whose top is at or above its centre line and whose bottom is below it
    const half = ONE / 2;
    const firstRow = (y: number) => Math.max(0, Math.ceil((y - half) / ONE));
    const r0 = firstRow(top), r1 = Math.min(h - 1, Math.ceil((bot - half) / ONE) - 1);
    if (r1 < r0) return;
    const rows = r1 - r0 + 1;
    const count = new Int32Array(rows + 1);
    const E = dirs.length;
    const from = new Int32Array(E), to = new Int32Array(E);
    for (let e = 0; e < E; e++) {
      from[e] = firstRow(sy[e]);
      to[e] = Math.min(r1, Math.ceil((ey[e] - half) / ONE) - 1);
      for (let row = from[e]; row <= to[e]; row++) count[row - r0 + 1]++;
    }
    for (let i = 1; i <= rows; i++) count[i] += count[i - 1];
    const xs = new Float64Array(count[rows]), ds = new Int8Array(count[rows]), next = count.slice(0, rows);
    const xMax = w * ONE;
    for (let e = 0; e < E; e++) {
      const dx = ex[e] - sx[e], dy = ey[e] - sy[e];
      for (let row = from[e]; row <= to[e]; row++) {
        const k = next[row - r0]++;
        // where the side crosses the row, just above its centre line, taken down to the fixed-point grid;
        // past the raster's sides, on them (a canvas clips a path to itself so)
        xs[k] = Math.min(xMax, Math.max(0, sx[e] + floorDiv((row * ONE + half - 1 - sy[e]) * dx, dy)));
        ds[k] = dirs[e];
      }
    }
    const pix = (x: number) => Math.floor((x + half - 1) / ONE);
    const order: number[] = [];
    for (let i = 0; i < rows; i++) {
      const s = count[i], e = count[i + 1];
      if (e - s < 2) continue;
      order.length = 0;
      for (let k = s; k < e; k++) order.push(k);
      order.sort((p, q) => xs[p] - xs[q]);
      let wind = 0, start = -Infinity;
      for (let j = 0; j < order.length; j++) {
        const k = order[j], at = pix(xs[k]);
        wind += ds[k];
        if (wind === 0) {
          // a gap of a cell or less to the next side is filled too (cairo's mono scan converter; a path of
          // only horizontal and vertical sides goes through its boxes instead, which leave it)
          if (rectilinear || j + 1 === order.length || pix(xs[order[j + 1]]) > at + 1) {
            const c0 = Math.max(0, start), c1 = Math.min(w - 1, at - 1);
            if (c1 >= c0) span(r0 + i, c0, c1);
            start = -Infinity;
          }
        } else if (start === -Infinity) start = at;
      }
    }
  }
}
