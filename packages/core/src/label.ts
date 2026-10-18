import type { MapLabel, Style } from "./types";

// The city caption a revealed wallpaper carries in one corner — the map's title
// block: the city's own name large, then its English name and country, then where
// on Earth it is. Drawn over everything else in the map's own ink, ringed by a
// paper-coloured halo: the cartographic way to keep type legible over linework
// without boxing it in.

/**
 * Geist first — the settings window's typeface, bundled with the app (the renderer
 * loads it, apps/desktop/src/renderer/render.ts) — though it only covers Latin, Cyrillic and
 * Vietnamese; every other script falls back glyph by glyph to the system's fonts,
 * the same fallback the City tab's own `localName` line relies on.
 *
 * No `-apple-system`: `system-ui` already means it in WebKit, and node-canvas (the
 * CLI renderer) rejects a font string containing it outright — and a canvas that
 * rejects `font` keeps drawing at its 10px default without a word.
 */
export const LABEL_FONT_FAMILY = `"Geist Variable", system-ui, "Segoe UI", "Noto Sans", sans-serif`;

/** Type sizes, as fractions of the image's short side. */
const TITLE_SIZE = 0.034;
const SUBTITLE_SIZE = 0.0165;
const COORDS_SIZE = 0.0125;
/**
 * Extra gap below each line, as a fraction of that line's size, on top of the font's
 * own ascent + descent (which already carry most of the leading).
 */
const GAP_AFTER = [0.1, 0.22];
/** Distance from the edge (on top of any insets), as a fraction of the short side. */
const MARGIN = 0.04;
/** Widest the caption may get, as a fraction of the image width; longer names shrink. */
const MAX_WIDTH = 0.42;
/**
 * Width of the paper-coloured halo stroke, as a fraction of the *coordinates* line's
 * size — one width for every line, however big its type. Sized off the smallest
 * line it stays a fine keyline that parts the letters from a road running through
 * them, rather than swelling into a sticker around the title; and since it follows
 * the type, it looks the same on every screen. The stroke is centred on the glyph
 * outline and the fill covers its inner half, so half of it shows: about 3.6 px on a
 * 5K screen, 1.4 px at 1080p.
 */
const HALO = 0.2;

type Line = { text: string; size: number; weight: number };

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** `48.8566° N, 2.3522° E`. */
export function formatLatLon(lat: number, lon: number): string {
  const ns = lat >= 0 ? "N" : "S";
  const ew = lon >= 0 ? "E" : "W";
  return `${Math.abs(lat).toFixed(4)}° ${ns}, ${Math.abs(lon).toFixed(4)}° ${ew}`;
}

/**
 * The caption's lines at `short` px — title, subtitle (omitted when it would only
 * repeat the title: Singapore, Vatican City), coordinates. The subtitle drops the
 * English name when it *is* the title (Paris · France) and the country when it
 * repeats the name (Hong Kong).
 */
function lines(label: MapLabel, short: number): Line[] {
  const title = label.localName.trim() || label.name;
  const country = label.countryName?.trim() || label.country;
  const parts: string[] = [];
  if (label.name && !same(label.name, title)) parts.push(label.name);
  if (!parts.some((p) => same(p, country)) && !same(country, title)) parts.push(country);
  const out: Line[] = [{ text: title, size: short * TITLE_SIZE, weight: 400 }];
  if (parts.length > 0) out.push({ text: parts.join(" · "), size: short * SUBTITLE_SIZE, weight: 400 });
  out.push({ text: formatLatLon(label.lat, label.lon), size: short * COORDS_SIZE, weight: 400 });
  return out;
}

/** Whole pixels: a canvas serializes `font` back with the size it understood, which `setFont` checks. */
const pxOf = (l: Line, scale: number) => Math.max(1, Math.round(l.size * scale));
const fontOf = (l: Line, scale: number) => `${l.weight} ${pxOf(l, scale)}px ${LABEL_FONT_FAMILY}`;

/**
 * Set a line's font, falling back to a bare `sans-serif` at the same size should the
 * canvas reject the full stack — which it does silently, leaving the previous (or
 * 10px default) font in place: a caption at a tenth of its size is worse than one in
 * the wrong face.
 */
function setFont(ctx: CanvasRenderingContext2D, l: Line, scale: number): void {
  const px = pxOf(l, scale);
  ctx.font = fontOf(l, scale);
  if (!ctx.font.includes(`${px}px`)) ctx.font = `${l.weight} ${px}px sans-serif`;
}

/**
 * Each font the caption will set, with the text it sets in it — for the host to
 * load before drawing. The text matters: `document.fonts.load` fetches only the
 * subsets that text needs.
 */
export function labelFonts(label: MapLabel, width: number, height: number): { font: string; text: string }[] {
  return lines(label, Math.min(width, height)).map((l) => ({ font: fontOf(l, 1), text: l.text }));
}

/** Right-to-left if the first strong character is (Arabic, Hebrew, …). */
const RTL_FIRST = /^[^\p{L}]*[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}]/u;

/**
 * Draw the caption into its corner of a `width`×`height` canvas, in `style`'s ink
 * and paper. Left corners align left and right corners align right, physically —
 * `ctx.direction` only steers the bidi order within a line. Lines stack from the
 * corner inward, so a bottom caption grows upward.
 */
export function drawLabel(
  ctx: CanvasRenderingContext2D,
  label: MapLabel,
  style: Pick<Style, "background" | "foreground">,
  width: number,
  height: number,
): void {
  const short = Math.min(width, height);
  const ls = lines(label, short);
  const insets = label.insets ?? { top: 0, right: 0, bottom: 0, left: 0 };
  const margin = short * MARGIN;
  const leftSide = label.corner.endsWith("left");
  const topSide = label.corner.startsWith("top");

  ctx.save();
  try {
    // Shrink the whole block, keeping its proportions, if its widest line won't fit.
    let widest = 0;
    for (const l of ls) {
      setFont(ctx, l, 1);
      widest = Math.max(widest, ctx.measureText(l.text).width);
    }
    const room = Math.min(width * MAX_WIDTH, width - insets.left - insets.right - 2 * margin);
    const scale = widest > room && widest > 0 ? room / widest : 1;

    const x = leftSide ? insets.left + margin : width - insets.right - margin;
    ctx.textAlign = leftSide ? "left" : "right";
    ctx.textBaseline = "alphabetic";
    ctx.lineJoin = "round";
    ctx.fillStyle = style.foreground;
    ctx.strokeStyle = style.background;

    // Baselines from the font's own ascent/descent, not each string's ink, so the
    // rhythm doesn't change with the script or the letters in a name.
    const placed = ls.map((l, i) => {
      setFont(ctx, l, scale);
      const m = ctx.measureText(l.text);
      const size = pxOf(l, scale);
      return {
        l,
        size,
        // Absent in older engines and node-canvas, which read it as undefined or 0.
        ascent: m.fontBoundingBoxAscent || size * 0.9,
        descent: m.fontBoundingBoxDescent || size * 0.25,
        gap: i < ls.length - 1 ? size * GAP_AFTER[Math.min(i, GAP_AFTER.length - 1)] : 0,
      };
    });
    // A bottom caption starts one block-height up, so it ends at the bottom margin.
    const blockHeight = placed.reduce((h, p) => h + p.ascent + p.descent + p.gap, 0);
    let y = topSide ? insets.top + margin : height - insets.bottom - margin - blockHeight;
    const baselines = placed.map((p) => {
      y += p.ascent;
      const baseline = y;
      y += p.descent + p.gap;
      return baseline;
    });

    // The coordinates are always the last line (see `lines`); after any shrink-to-fit,
    // so a squeezed caption gets a proportionally finer halo too.
    ctx.lineWidth = placed[placed.length - 1].size * HALO;
    placed.forEach((p, i) => {
      setFont(ctx, p.l, scale);
      ctx.direction = RTL_FIRST.test(p.l.text) ? "rtl" : "ltr";
      ctx.strokeText(p.l.text, x, baselines[i]);
      ctx.fillText(p.l.text, x, baselines[i]);
    });
  } finally {
    ctx.restore();
  }
}
