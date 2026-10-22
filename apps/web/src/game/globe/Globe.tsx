import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { countryName, type City, type CountryIndex, type GuessView } from "@inkcity/core";
import { cityName } from "../../lib/city-name";
import { prefersReducedMotion } from "../../lib/hooks";
import { formatCount } from "../format";
import data from "./world.json";
import {
  angle,
  decodeWorld,
  fillRing,
  fitZoom,
  graticule,
  greatArc,
  place,
  trace,
  turnFor,
  vec,
  viewOf,
  zoomAbout,
  type Disc,
  type Vec,
  type View,
  type WorldData,
} from "./sphere";

// The result's details (loaded only when they're asked for): the day's guesses on a
// globe drawn in ink — every country washed in, with its borders and coasts
// (world-atlas's 110m countries, from Natural Earth; ./WORLD-ATLAS-LICENSE.txt), and
// the day's own, each guessed and the answer, a shade deeper and outlined. The
// guesses are numbered at the points their distances were measured from, joined in
// the order they were made by great circles, and the last leg goes on to the city
// itself, marked as a target and named (dashed, if the guesses never got there). It opens by travelling
// that path, closing in on it until the whole of it just fits; then a drag turns
// it, and the wheel, a pinch or +/− zooms it about the pointer, as a map does (the
// arrow keys turn it too) — closer in, the Earth fills the square frame it's in.

const WORLD = decodeWorld(data as unknown as WorldData);
const LAND = [...WORLD.rings.values()].flat();
const GRATICULE = graticule();
/** How long the opening journey takes, ms. */
const TOUR_MS = 1800;
/** A drag's spin dies away by this much a frame once it's let go. */
const DRAG_DECAY = 0.92;
/** The closest the globe comes, as a multiple of its whole-globe size: past this, the 110m borders show their corners. */
const MAX_ZOOM = 12;
/** How much a wheel's pixel of scroll zooms: a notch of a mouse wheel (~100px) is about a third. */
const WHEEL_ZOOM = 0.003;

type Props = {
  guesses: readonly GuessView[];
  city: City;
  index: CountryIndex;
  /** Redrawn in the page's paper and ink when the theme changes. */
  theme: "light" | "dark";
};

type Stop = { code: string; at: Vec; correct: boolean };

export default function Globe({ guesses, city, index, theme }: Props) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const canvas = useRef<HTMLCanvasElement>(null);

  // The guesses as they stand, by value: the snapshot hands over a new array each
  // render, and the globe mustn't start its journey over for that.
  const trail = guesses.map((g) => `${g.code}${g.correct ? "!" : ""}`).join(",");
  const { stops, target, legs, total, home, fit, found, marked } = useMemo(() => {
    const stops: Stop[] = guesses.flatMap((g) => {
      const c = index.byCode.get(g.code);
      return c ? [{ code: g.code, at: vec(c.lat, c.lon), correct: g.correct }] : [];
    });
    const target = vec(city.lat, city.lon);
    // The path: from each guess to the next, and on to the city — straight to it from
    // the one before, when the last guess was right: that country's own point isn't
    // a stop on the way.
    const found = guesses.some((g) => g.correct);
    const points = [...stops.filter((s) => !s.correct).map((s) => s.at), target];
    // A great circle from each point to the next.
    const legs = points.slice(1).map((b, i) => {
      const a = points[i];
      const len = angle(a, b);
      return { line: greatArc(a, b, Math.max(8, Math.ceil((len * 180) / Math.PI / 2))), len };
    });
    const total = legs.reduce((sum, l) => sum + l.len, 0);
    // Facing the middle of it all, so as much of the path as can be is on the near side.
    const sum = points.reduce<Vec>((m, p) => [m[0] + p[0], m[1] + p[1], m[2] + p[2]], [0, 0, 0]);
    const n = Math.hypot(...sum);
    const center: Vec = n > 1e-6 ? [sum[0] / n, sum[1] / n, sum[2] / n] : target;
    const home = viewOf(center);
    // Close enough in that all of it — the guesses, the city, the arcs between — just fits.
    const along = legs.flatMap((l) => Array.from({ length: l.line.length / 3 }, (_, k) => [l.line[3 * k], l.line[3 * k + 1], l.line[3 * k + 2]] as Vec));
    const fit = fitZoom(center, [...points, ...along]);
    // The day's countries: each one guessed, and the answer, guessed or not.
    const marked = [...new Set([...stops.map((s) => s.code), city.country])].flatMap((code) => WORLD.rings.get(code) ?? []);
    return { stops, target, legs, total, home, fit, found, marked };
    // `trail` stands for `guesses`.
  }, [trail, city, index]);

  // Its words are read as it's drawn, as are the theme's colours: another language or
  // theme draws the globe again where it's been turned to, rather than setting off on
  // its journey again.
  const names = stops.map((s) => countryName(index, s.code, lang));
  const numbers = stops.map((_, i) => formatCount(i + 1, lang));
  const words = useRef({ names, numbers, city: cityName(city, lang) });
  words.current = { names, numbers, city: cityName(city, lang) };
  const repaint = useRef(() => {});

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx) return;
    const still = prefersReducedMotion();
    // Setting off from the first guess — or, for a first-time win, from a quarter turn away.
    const start: View = stops.length > 1 ? viewOf(stops[0].at) : { lat: home.lat, lon: home.lon - 90 };
    const view: View = still ? { ...home } : { ...start };
    let zoom = still ? fit : 1;
    let drawn = still ? 1 : 0;
    let raf = 0;
    /** The whole globe's radius in its square, px: zoom 1, a margin of paper round it. */
    const whole = () => el.clientWidth / 2 - 16;

    const draw = () => {
      raf = 0;
      const { names, numbers, city: cityLabel } = words.current;
      const size = el.clientWidth;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (el.width !== Math.round(size * dpr)) el.width = el.height = Math.round(size * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size, size);
      const cs = getComputedStyle(el);
      const color = (name: string) => cs.getPropertyValue(name).trim();
      const ink = color("--ink");
      const d: Disc = { cx: size / 2, cy: size / 2, r: whole() * zoom };
      const turn = turnFor(view);
      ctx.lineJoin = ctx.lineCap = "round";

      ctx.beginPath();
      ctx.arc(d.cx, d.cy, d.r, 0, Math.PI * 2);
      ctx.fillStyle = color("--pop");
      ctx.fill();

      const stroke = (lines: Iterable<ArrayLike<number>>, style: string, width: number) => {
        ctx.beginPath();
        for (const line of lines) trace(ctx, line, turn, d);
        ctx.strokeStyle = style;
        ctx.lineWidth = width;
        ctx.stroke();
      };
      // Each wash is one fill, so neighbours meet without a seam.
      const wash = (rings: Iterable<ArrayLike<number>>, style: string) => {
        ctx.beginPath();
        for (const ring of rings) fillRing(ctx, ring, turn, d);
        ctx.fillStyle = style;
        ctx.fill("evenodd");
      };
      // The graticule on the sea; the land over it, the day's countries deeper.
      stroke(GRATICULE, color("--hair"), 0.7);
      wash(LAND, color("--land-2"));
      wash(marked, color("--land"));
      stroke(WORLD.arcs, color("--ink-3"), 0.7);
      stroke(marked, ink, 1.4);

      // The path, as far as the journey has got: each leg whole, then the one it's on.
      let left = drawn * total;
      ctx.strokeStyle = ink;
      ctx.lineWidth = 1.6;
      legs.forEach((leg, i) => {
        if (left <= 0 && total > 0) return;
        const part = total > 0 ? Math.min(1, left / (leg.len || 1)) : 1;
        left -= leg.len;
        // The last leg, to the city, dashed where the guesses never reached it.
        const last = i === legs.length - 1;
        ctx.setLineDash(last && !found ? [4, 4] : []);
        ctx.beginPath();
        trace(ctx, leg.line, turn, d, part * (leg.line.length / 3 - 1) + 1);
        ctx.stroke();
      });
      ctx.setLineDash([]);

      // The city: a target, when the path has reached it, named; the guess that found
      // it is the target's, so it gets no dot of its own on top of its neighbours'.
      const taken: [number, number, number, number][] = [];
      if (drawn >= 1 || total === 0) {
        const c = place(target, turn, d);
        if (c.near) {
          for (const [r, w] of [[11, 1], [5.5, 1.6]] as const) {
            ctx.beginPath();
            ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
            ctx.lineWidth = w;
            ctx.strokeStyle = ink;
            ctx.stroke();
          }
          ctx.beginPath();
          ctx.arc(c.x, c.y, 2.2, 0, Math.PI * 2);
          ctx.fillStyle = ink;
          ctx.fill();
          ctx.font = `600 12px ${cs.fontFamily}`;
          ctx.textAlign = "left";
          ctx.textBaseline = "middle";
          ctx.lineWidth = 3;
          ctx.strokeStyle = color("--pop");
          const w = ctx.measureText(cityLabel).width;
          taken.push([c.x + 15, c.y - 8, c.x + 15 + w, c.y + 8], [c.x - 12, c.y - 12, c.x + 12, c.y + 12]);
          ctx.strokeText(cityLabel, c.x + 15, c.y);
          ctx.fillStyle = ink;
          ctx.fillText(cityLabel, c.x + 15, c.y);
        }
      }

      // Each guess: its number at the point it was measured from, its name beside
      // it where that doesn't fall on a name already set.
      ctx.font = `600 9px ${cs.fontFamily}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      stops.forEach((s, i) => {
        const p = place(s.at, turn, d);
        if (!p.near || s.correct) return;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 7.5, 0, Math.PI * 2);
        ctx.fillStyle = ink;
        ctx.fill();
        ctx.fillStyle = color("--on-ink");
        ctx.fillText(numbers[i], p.x, p.y + 0.5);
      });
      ctx.font = `500 11px ${cs.fontFamily}`;
      ctx.textAlign = "left";
      ctx.lineWidth = 3;
      ctx.strokeStyle = color("--pop");
      stops.forEach((s, i) => {
        const p = place(s.at, turn, d);
        if (!p.near || s.correct) return;
        const w = ctx.measureText(names[i]).width;
        const box: [number, number, number, number] = [p.x + 11, p.y - 7, p.x + 11 + w, p.y + 7];
        if (taken.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) return;
        taken.push(box);
        ctx.strokeText(names[i], box[0], p.y);
        ctx.fillStyle = ink;
        ctx.fillText(names[i], box[0], p.y);
      });

      // The rim last, crisp over whatever ran to it — out past the frame, once it's zoomed in.
      ctx.beginPath();
      ctx.arc(d.cx, d.cy, d.r, 0, Math.PI * 2);
      ctx.strokeStyle = color("--line");
      ctx.lineWidth = 1.2;
      ctx.stroke();
    };
    const redraw = () => {
      if (!raf) raf = requestAnimationFrame(draw);
    };
    repaint.current = redraw;

    // The journey: along the path, the globe turning from the first guess to face it all.
    let tour = 0;
    if (!still) {
      const t0 = performance.now();
      const from = vec(start.lat, start.lon);
      const to = vec(home.lat, home.lon);
      const arc = greatArc(from, to, 64);
      const step = (now: number) => {
        const f = Math.min(1, (now - t0) / TOUR_MS);
        const e = f < 0.5 ? 4 * f * f * f : 1 - Math.pow(-2 * f + 2, 3) / 2;
        const k = Math.min(63, Math.floor(e * 64));
        Object.assign(view, viewOf([arc[3 * k], arc[3 * k + 1], arc[3 * k + 2]]));
        // Closing in evenly to the eye: the zoom's logarithm, not the zoom, goes evenly.
        zoom = Math.exp(Math.log(fit) * e);
        drawn = e;
        draw();
        tour = f < 1 ? requestAnimationFrame(step) : 0;
        if (f >= 1) {
          Object.assign(view, home);
          zoom = fit;
          drawn = 1;
          draw();
        }
      };
      tour = requestAnimationFrame(step);
    } else draw();

    // By hand: a drag spins it under the pointer, carrying on a little when let go;
    // two fingers pinch it closer or farther about their middle; the wheel zooms about
    // the pointer. Everything turns by the globe's size on screen, so a pixel of drag
    // covers less of the Earth the closer in it is.
    const pointers = new Map<number, { x: number; y: number }>();
    let drag: { x: number; y: number; from: View; t: number } | null = null;
    let pinch: { dist: number; zoom: number } | null = null;
    let spin = { lon: 0, lat: 0 };
    let coast = 0;
    const settle = () => {
      cancelAnimationFrame(tour);
      cancelAnimationFrame(coast);
      tour = coast = 0;
      drawn = 1;
    };
    const perPx = () => 180 / Math.PI / (whole() * zoom);
    const clampLat = (lat: number) => Math.max(-80, Math.min(80, lat));
    /** Zoom to `next` about the point at client x, y. */
    const zoomTo = (next: number, x: number, y: number) => {
      next = Math.max(1, Math.min(MAX_ZOOM, next));
      if (next === zoom) return;
      const box = el.getBoundingClientRect();
      const dx = x - box.left - box.width / 2;
      const dy = y - box.top - box.height / 2;
      Object.assign(view, zoomAbout(view, whole() * zoom, whole() * next, dx, dy));
      view.lat = clampLat(view.lat);
      zoom = next;
      redraw();
    };
    const twoFingers = () => {
      const [a, b] = [...pointers.values()];
      return { dist: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    };
    const onDown = (e: PointerEvent) => {
      settle();
      el.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      spin = { lon: 0, lat: 0 };
      if (pointers.size === 2) {
        drag = null;
        pinch = { dist: twoFingers().dist || 1, zoom };
      } else if (pointers.size === 1) drag = { x: e.clientX, y: e.clientY, from: { ...view }, t: performance.now() };
    };
    const onMove = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pointers.size === 2) {
        const f = twoFingers();
        zoomTo(pinch.zoom * (f.dist / pinch.dist), f.x, f.y);
        return;
      }
      if (!drag) return;
      const k = perPx();
      const lon = drag.from.lon - (e.clientX - drag.x) * k;
      const lat = clampLat(drag.from.lat + (e.clientY - drag.y) * k);
      const now = performance.now();
      const dt = Math.max(1, now - drag.t);
      spin = { lon: ((lon - view.lon) / dt) * 16, lat: ((lat - view.lat) / dt) * 16 };
      drag.t = now;
      view.lon = lon;
      view.lat = lat;
      redraw();
    };
    const onUp = (e: PointerEvent) => {
      if (!pointers.delete(e.pointerId)) return;
      if (pinch) {
        // The finger left behind after a pinch picks the drag up from where it is.
        pinch = null;
        const [rest] = [...pointers.values()];
        drag = rest ? { x: rest.x, y: rest.y, from: { ...view }, t: performance.now() } : null;
        return;
      }
      if (!drag) return;
      drag = null;
      if (still) return;
      const glide = () => {
        spin = { lon: spin.lon * DRAG_DECAY, lat: spin.lat * DRAG_DECAY };
        view.lon += spin.lon;
        view.lat = clampLat(view.lat + spin.lat);
        draw();
        coast = Math.abs(spin.lon) + Math.abs(spin.lat) > 0.02 ? requestAnimationFrame(glide) : 0;
      };
      coast = requestAnimationFrame(glide);
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      settle();
      // Lines (Firefox's mouse wheel) to pixels; a trackpad's pinch comes as a wheel
      // with Ctrl, in small steps, so it's taken more strongly.
      const px = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1);
      zoomTo(zoom * Math.exp(-px * (e.ctrlKey ? 0.01 : WHEEL_ZOOM)), e.clientX, e.clientY);
    };
    const onKey = (e: KeyboardEvent) => {
      const turns: Record<string, [number, number]> = {
        ArrowLeft: [-15, 0],
        ArrowRight: [15, 0],
        ArrowUp: [0, 10],
        ArrowDown: [0, -10],
      };
      const zooms: Record<string, number> = { "+": 1.4, "=": 1.4, "-": 1 / 1.4, _: 1 / 1.4 };
      const by = turns[e.key];
      const z = zooms[e.key];
      if (!by && !z) return;
      e.preventDefault();
      settle();
      if (z) {
        const box = el.getBoundingClientRect();
        zoomTo(zoom * z, box.left + box.width / 2, box.top + box.height / 2);
        return;
      }
      const k = 1 / Math.sqrt(zoom);
      view.lon += by[0] * k;
      view.lat = clampLat(view.lat + by[1] * k);
      redraw();
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    // Not passive: the wheel zooms the globe, and mustn't scroll the page as well.
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("keydown", onKey);
    const resize = new ResizeObserver(redraw);
    resize.observe(el);
    return () => {
      repaint.current = () => {};
      cancelAnimationFrame(raf);
      cancelAnimationFrame(tour);
      cancelAnimationFrame(coast);
      resize.disconnect();
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("keydown", onKey);
    };
  }, [stops, target, legs, total, home, fit, found, marked]);
  // On the next frame, by when the page has taken the theme's colours on.
  useEffect(() => repaint.current(), [theme, lang]);

  const label = `${t("globe.label")} ${names.map((name, i) => `${i + 1}. ${name}`).join(", ")}`;
  // Its frame is the page's (../Stage.tsx), up before this has loaded.
  return <canvas ref={canvas} className="globe__canvas" role="img" aria-label={label} tabIndex={0} />;
}
