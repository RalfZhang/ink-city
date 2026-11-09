import { MONDRIAN_PRIMARIES, type ColorPair, type Theme } from "@inkcity/core";

// The game wears the map's own colours: its paper is the map's paper, its text the
// map's ink — darkened or lightened where the ink is too faint to read (a dim night
// palette is the usual case) — and everything else is worked out from those two.
// One formula for both hosts. The desktop window lays it at run time, from the
// palette in use, so a palette edit in Style recolours the window as it recolours
// the map; the website's page draws only the default palette, so its tables in
// apps/web/src/index.css are this formula's output for DEFAULT_COLORS, written out
// for the first paint and held to it by `pnpm web-test` — as is the desktop's
// pre-status fallback (apps/desktop/src/styles/ink.css).

type Rgb = [number, number, number];

const hexToRgb = (hex: string): Rgb => {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.replace(/./g, "$&$&");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as Rgb;
};
const rgbToHex = (c: Rgb) =>
  "#" + c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0")).join("");
const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const gamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const luminance = (c: Rgb) => {
  const [r, g, b] = c.map(linear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: Rgb, b: Rgb) => {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
const mix = (a: Rgb, b: Rgb, t: number) => a.map((v, i) => v + (b[i] - v) * t) as Rgb;
const rgba = (c: Rgb, alpha: number) => `rgb(${c.map((v) => Math.round(v * 255)).join(" ")} / ${alpha})`;

function toOklab(c: Rgb): Rgb {
  const [r, g, b] = c.map(linear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function fromOklab([L, a, b]: Rgb): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((v) => gamma(Math.min(1, Math.max(0, v)))) as Rgb;
}

/**
 * `ink` as it is when it reads at `target` contrast on `paper`; otherwise moved
 * toward black or white in OKLab — its hue kept, its colour easing off as it goes —
 * just far enough that it does.
 */
function readableInk(ink: Rgb, paper: Rgb, target: number): Rgb {
  if (contrast(ink, paper) >= target) return ink;
  const [L, a, b] = toOklab(ink);
  const end = luminance(paper) < 0.2 ? 1 : 0;
  let lo = 0;
  let hi = 1;
  let best = fromOklab([end, 0, 0]);
  for (let i = 0; i < 26; i++) {
    const t = (lo + hi) / 2;
    const k = 1 - t * 0.6;
    const c = fromOklab([L + (end - L) * t, a * k, b * k]);
    if (contrast(c, paper) >= target) {
      hi = t;
      best = c;
    } else lo = t;
  }
  return best;
}

export type Tokens = Record<string, string>;

/**
 * The window's colours, from the map's `pair` (Mondrian's own, when it's drawn
 * in Mondrian — then `mondrian` names the theme, and the accents are its primaries:
 * red for the actions, blue for what's picked, yellow for what's ticked).
 *
 *   --paper / --ink        the map's paper, and text that reads on it
 *   --ink-2 / --ink-3      secondary text / the faintest marks
 *   --line / --hair        frames and rules / hairlines between things
 *   --pop                  anything floating over the map, opaque
 *   --land / --land-2      the details' globe: the day's countries, and the rest
 *   --sheet                the settings sheet: tracing paper over the map
 *   --on-ink               what's written on an ink fill
 *   --accent, --select, --mark (+ --on-*)  the action, the picked option, the tick
 *   --brick                the one colour that isn't ink: a mistake
 */
export function tokensFor(pair: ColorPair, mondrian: Theme | null): Tokens {
  const paper = hexToRgb(pair.background);
  const mapInk = hexToRgb(pair.foreground);
  const white: Rgb = [1, 1, 1];
  const dark = luminance(paper) < 0.2;
  const ink = readableInk(mapInk, paper, dark ? 13 : 7.5);
  const pop = dark ? mix(paper, ink, 0.07) : mix(paper, white, 0.55);
  const onInk = dark ? mix(paper, ink, 0.03) : mix(paper, white, 0.45);
  const t: Tokens = {
    paper: rgbToHex(paper),
    ink: rgbToHex(ink),
    "ink-2": rgbToHex(mix(ink, paper, 0.3)),
    "ink-3": rgbToHex(mix(ink, paper, 0.58)),
    line: rgbToHex(dark ? mix(ink, paper, 0.45) : ink),
    hair: rgba(ink, dark ? 0.16 : 0.2),
    pop: rgbToHex(pop),
    sheet: rgba(dark ? mix(paper, ink, 0.045) : mix(paper, pop, 0.55), dark ? 0.9 : 0.92),
    land: rgbToHex(dark ? mix(paper, ink, 0.12) : mix(paper, mapInk, 0.025)),
    "land-2": rgbToHex(dark ? mix(paper, ink, 0.09) : mix(paper, white, 0.3)),
    "on-ink": rgbToHex(onInk),
    brick: dark ? "#e0806f" : "#a4372a",
    accent: rgbToHex(ink),
    "on-accent": rgbToHex(onInk),
    select: rgbToHex(ink),
    "on-select": rgbToHex(onInk),
    mark: rgbToHex(ink),
    "on-mark": rgbToHex(onInk),
  };
  if (mondrian) {
    Object.assign(t, {
      accent: MONDRIAN_PRIMARIES.red[mondrian],
      "on-accent": "#ffffff",
      select: MONDRIAN_PRIMARIES.blue[mondrian],
      "on-select": "#ffffff",
      mark: MONDRIAN_PRIMARIES.yellow[mondrian],
      "on-mark": "#141414",
    });
  }
  return t;
}

/** Lay `tokens` on `el` (the document root), and tell the platform's own controls which way it leans. */
export function applyTokens(el: HTMLElement, tokens: Tokens, theme: Theme): void {
  for (const [k, v] of Object.entries(tokens)) el.style.setProperty(`--${k}`, v);
  el.style.colorScheme = theme;
}
