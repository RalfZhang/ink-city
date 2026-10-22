// The globe's geometry, drawn as a pen would draw it: an orthographic view of the
// sphere, every line clipped where it goes round the back. Points are unit vectors
// (x towards 0° 0°, y towards 0° 90°E, z to the north pole); a view turns them so
// its centre faces the viewer, along +x, and the screen reads y to the right and
// z up.

const RAD = Math.PI / 180;

export type Vec = [number, number, number];

/** Where the globe faces: the point in its middle. */
export type View = { lat: number; lon: number };

export function vec(lat: number, lon: number): Vec {
  const φ = lat * RAD;
  const λ = lon * RAD;
  return [Math.cos(φ) * Math.cos(λ), Math.cos(φ) * Math.sin(λ), Math.sin(φ)];
}

/** The view facing `v`. */
export function viewOf(v: Vec): View {
  return { lat: Math.asin(Math.max(-1, Math.min(1, v[2]))) / RAD, lon: Math.atan2(v[1], v[0]) / RAD };
}

/** A view's turn: `v` as the viewer sees it, into `out`. */
export type Turn = (v: ArrayLike<number>, at: number, out: Vec) => Vec;

export function turnFor(view: View): Turn {
  const cl = Math.cos(-view.lon * RAD);
  const sl = Math.sin(-view.lon * RAD);
  const cp = Math.cos(view.lat * RAD);
  const sp = Math.sin(view.lat * RAD);
  return (v, at, out) => {
    // Spun about the poles by the view's longitude, then tilted by its latitude.
    const x = v[at] * cl - v[at + 1] * sl;
    out[0] = x * cp + v[at + 2] * sp;
    out[1] = v[at] * sl + v[at + 1] * cl;
    out[2] = -x * sp + v[at + 2] * cp;
    return out;
  };
}

/**
 * The world point seen `dx`, `dy` px from the centre of a globe of radius `r` turned
 * to `view` (screen axes: x to the right, y down), or null off its edge — the turn
 * of `turnFor` undone.
 */
export function unproject(dx: number, dy: number, r: number, view: View): Vec | null {
  const o1 = dx / r;
  const o2 = -dy / r;
  const rim = o1 * o1 + o2 * o2;
  if (rim > 1) return null;
  const o0 = Math.sqrt(1 - rim);
  const cl = Math.cos(-view.lon * RAD);
  const sl = Math.sin(-view.lon * RAD);
  const cp = Math.cos(view.lat * RAD);
  const sp = Math.sin(view.lat * RAD);
  const x1 = o0 * cp - o2 * sp;
  const z1 = o0 * sp + o2 * cp;
  return [x1 * cl + o1 * sl, -x1 * sl + o1 * cl, z1];
}

/**
 * The view that keeps the world point under the pointer where it is as the globe's
 * radius goes from `r` to `next` — zooming in or out about the pointer, as a map
 * does — `dx`, `dy` px from the centre. Solved exactly: the tilt is the one that
 * gives the point its height on the screen (a view's spin leaves a point's height
 * above the equator alone), the spin then the one that lines it up sideways. Off
 * the globe, or where no view could put it there, the view stays.
 */
export function zoomAbout(view: View, r: number, next: number, dx: number, dy: number): View {
  const p = unproject(dx, dy, r, view);
  if (!p) return view;
  // Where the point has to be, turned: as `turnFor` leaves it.
  const o1 = dx / next;
  const o2 = -dy / next;
  const rim = o1 * o1 + o2 * o2;
  if (rim > 1) return view;
  const o0 = Math.sqrt(1 - rim);
  // Untilting by `lat` takes its height to o0·sin(lat) + o2·cos(lat), which has to be the point's own.
  const reach = Math.hypot(o0, o2);
  if (Math.abs(p[2]) > reach) return view;
  const phase = Math.atan2(o2, o0);
  const base = Math.asin(p[2] / reach);
  const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
  const now = view.lat * RAD;
  const lat = [wrap(base - phase), wrap(Math.PI - base - phase)]
    .filter((a) => Math.abs(a) <= Math.PI / 2)
    .reduce((best, a) => (Math.abs(a - now) < Math.abs(best - now) ? a : best), Infinity);
  if (!Number.isFinite(lat)) return view;
  const x1 = o0 * Math.cos(lat) - o2 * Math.sin(lat);
  const lon = wrap(Math.atan2(p[1], p[0]) - Math.atan2(o1, x1));
  return { lat: lat / RAD, lon: lon / RAD };
}

/**
 * How far to zoom in (1: the whole globe fills its box) for every one of `points`
 * to show around `center`, within `fill` of the box's half-width: a point θ from the
 * centre lands r·sin θ out, so the farthest sets it. Points as close together as
 * `minDeg` are given that much room — a country's worth — and a set that reaches
 * round the back gets the whole globe.
 */
export function fitZoom(center: Vec, points: readonly Vec[], fill = 0.8, minDeg = 14, max = 24): number {
  let far = 0;
  for (const p of points) far = Math.max(far, angle(center, p));
  if (far >= 80 * RAD) return 1;
  return Math.min(max, Math.max(1, fill / Math.sin(Math.max(far, minDeg * RAD))));
}

/** A disc on the screen: its centre and radius, px. */
export type Disc = { cx: number; cy: number; r: number };

/**
 * Trace the polyline `xyz` (unit vectors, flat) onto the current path, as far as
 * it's on the near side: where it goes over the horizon it stops at the rim, and
 * starts again where it comes back. Segments are short (a 110m map, or sampled
 * arcs), so the crossing is found on the chord.
 */
export function trace(ctx: CanvasRenderingContext2D, xyz: ArrayLike<number>, turn: Turn, d: Disc, upTo = xyz.length / 3): void {
  const a: Vec = [0, 0, 0];
  const b: Vec = [0, 0, 0];
  const n = Math.min(xyz.length / 3, Math.ceil(upTo));
  let was = false;
  for (let i = 0; i < n; i++) {
    turn(xyz, 3 * i, b);
    const is = b[0] >= 0;
    if (i > 0 && is !== was) {
      // Over the rim between a and b: the chord's point there, pushed out to the sphere.
      const f = a[0] / (a[0] - b[0]);
      const y = a[1] + (b[1] - a[1]) * f;
      const z = a[2] + (b[2] - a[2]) * f;
      const len = Math.hypot(y, z) || 1;
      const sx = d.cx + (d.r * y) / len;
      const sy = d.cy - (d.r * z) / len;
      if (is) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    }
    if (is) {
      if (i === 0) ctx.moveTo(d.cx + d.r * b[1], d.cy - d.r * b[2]);
      else ctx.lineTo(d.cx + d.r * b[1], d.cy - d.r * b[2]);
    }
    a[0] = b[0];
    a[1] = b[1];
    a[2] = b[2];
    was = is;
  }
  // A path cut short (`upTo` partway): the last bit, to the fraction.
  const rest = upTo - Math.floor(upTo);
  if (rest > 0 && n < xyz.length / 3 && was) {
    turn(xyz, 3 * n, b);
    if (b[0] >= 0) {
      ctx.lineTo(d.cx + d.r * (a[1] + (b[1] - a[1]) * rest), d.cy - d.r * (a[2] + (b[2] - a[2]) * rest));
    }
  }
}

/** `t` brought into (−π, π]: the short way round, for a step from one angle to the next. */
const wrap = (t: number) => t - 2 * Math.PI * Math.round(t / (2 * Math.PI));

/**
 * Add the closed ring `xyz` (unit vectors, flat, its last point its first) to the
 * current path, for filling, as much of what it encloses as is on the near side:
 * each stretch of it that goes round the back is replaced by the rim, from where it
 * went over to where it came back, round the way the hidden stretch went (seen from
 * the front). That keeps what the ring encloses for anything that doesn't reach right
 * round behind the globe to the point opposite its middle — anything under a quarter
 * of the world across, as every country is. Filled "evenodd", a hole stays open.
 */
export function fillRing(ctx: CanvasRenderingContext2D, xyz: ArrayLike<number>, turn: Turn, d: Disc): void {
  const m = xyz.length / 3 - 1;
  if (m < 3) return;
  const a: Vec = [0, 0, 0];
  const b: Vec = [0, 0, 0];
  // Setting off from a point on the near side; a ring with none is all round the back.
  let s = 0;
  while (s < m && turn(xyz, 3 * s, a)[0] < 0) s++;
  if (s === m) return;
  ctx.moveTo(d.cx + d.r * a[1], d.cy - d.r * a[2]);
  // Round the back: the rim's angle where it went over, how far round it's gone
  // since, and the angle it was last seen at.
  let over = 0;
  let swept = 0;
  let seen = 0;
  for (let k = 1; k <= m; k++) {
    turn(xyz, 3 * ((s + k) % m), b);
    const near = b[0] >= 0;
    if (near !== a[0] >= 0) {
      // Over the rim between a and b, where the chord meets it.
      const f = a[0] / (a[0] - b[0]);
      const at = Math.atan2(-(a[2] + (b[2] - a[2]) * f), a[1] + (b[1] - a[1]) * f);
      if (near) {
        swept += wrap(at - seen);
        ctx.arc(d.cx, d.cy, d.r, over, over + swept, swept < 0);
      } else {
        ctx.lineTo(d.cx + d.r * Math.cos(at), d.cy + d.r * Math.sin(at));
        over = seen = at;
        swept = 0;
      }
    }
    if (near) ctx.lineTo(d.cx + d.r * b[1], d.cy - d.r * b[2]);
    else {
      const at = Math.atan2(-b[2], b[1]);
      swept += wrap(at - seen);
      seen = at;
    }
    a[0] = b[0];
    a[1] = b[1];
    a[2] = b[2];
  }
  ctx.closePath();
}

/** Where `v` lands on the screen, and whether it's on the near side. */
export function place(v: Vec, turn: Turn, d: Disc): { x: number; y: number; near: boolean } {
  const t = turn(v, 0, [0, 0, 0]);
  return { x: d.cx + d.r * t[1], y: d.cy - d.r * t[2], near: t[0] >= 0 };
}

/** The great circle from `a` to `b`, as `steps` + 1 unit vectors (flat). */
export function greatArc(a: Vec, b: Vec, steps = 48): Float64Array {
  const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  const ω = Math.acos(dot);
  const out = new Float64Array((steps + 1) * 3);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // Slerp; two points all but the same are just a line between them.
    const s = Math.sin(ω);
    const p = s < 1e-6 ? 1 - t : Math.sin((1 - t) * ω) / s;
    const q = s < 1e-6 ? t : Math.sin(t * ω) / s;
    out[3 * i] = p * a[0] + q * b[0];
    out[3 * i + 1] = p * a[1] + q * b[1];
    out[3 * i + 2] = p * a[2] + q * b[2];
  }
  return out;
}

/** Angle between two unit vectors, radians: a great circle's length on the unit sphere. */
export function angle(a: Vec, b: Vec): number {
  return Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
}

/** The graticule: meridians and parallels every 30°, as unit-vector polylines. */
export function graticule(): Float64Array[] {
  const lines: Float64Array[] = [];
  const line = (pts: [number, number][]) => {
    const out = new Float64Array(pts.length * 3);
    pts.forEach(([lat, lon], i) => out.set(vec(lat, lon), 3 * i));
    lines.push(out);
  };
  for (let lon = -180; lon < 180; lon += 30) line(Array.from({ length: 61 }, (_, i) => [-90 + i * 3, lon]));
  for (let lat = -60; lat <= 60; lat += 30) line(Array.from({ length: 121 }, (_, i) => [lat, -180 + i * 3]));
  return lines;
}

/** The world as it's stored (./world.json): TopoJSON's quantized, delta-coded arcs, and each country's rings as arc references. */
export type WorldData = {
  scale: [number, number];
  translate: [number, number];
  arcs: number[][];
  countries: Record<string, number[][]>;
};

export type World = {
  /** Every border and coast, once each, as unit-vector polylines. */
  arcs: Float64Array[];
  /**
   * Each country, by ISO alpha-2 code, as its rings — the outline of every piece of
   * it, and of any hole in one — each a closed unit-vector polyline.
   */
  rings: Map<string, Float64Array[]>;
};

export function decodeWorld(data: WorldData): World {
  const [sx, sy] = data.scale;
  const [tx, ty] = data.translate;
  const arcs = data.arcs.map((q) => {
    const out = new Float64Array((q.length / 2) * 3);
    let x = 0;
    let y = 0;
    for (let k = 0; k < q.length; k += 2) {
      x += q[k];
      y += q[k + 1];
      out.set(vec(y * sy + ty, x * sx + tx), (k / 2) * 3);
    }
    return out;
  });
  // A ring is its arcs end to end — one given as ~i taken backwards — each after the
  // first without the point it starts on, the one before's last.
  const ring = (refs: number[]) => {
    const parts = refs.map((ref) => ({ arc: arcs[ref < 0 ? ~ref : ref], back: ref < 0 }));
    const out = new Float64Array(3 * parts.reduce((n, p) => n + p.arc.length / 3 - 1, 1));
    let o = 0;
    parts.forEach(({ arc, back }, j) => {
      const m = arc.length / 3;
      for (let k = j === 0 ? 0 : 1; k < m; k++) {
        const from = 3 * (back ? m - 1 - k : k);
        out[o++] = arc[from];
        out[o++] = arc[from + 1];
        out[o++] = arc[from + 2];
      }
    });
    return out;
  };
  const rings = new Map(Object.entries(data.countries).map(([code, refs]) => [code, refs.map(ring)]));
  return { arcs, rings };
}
