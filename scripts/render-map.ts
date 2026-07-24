#!/usr/bin/env -S npx tsx
// Render any location's map (roads + water) to PNG or SVG, both themes, without
// the Tauri app. Reuses the portable core (drawRoads → drawWater) on a
// node-canvas surface, so the output matches the desktop wallpaper exactly.
// Unlike render-test (which replays a pre-generated city.json offline), this
// fetches roads + water live from Overpass for any lat/lon. node-canvas resolves
// only from the project's node_modules, so run this from inside the repo.
//
// Usage:
//   npm run render-map -- -l <lat/lon> [options]
//
// Options:
//   -l, --location <lat/lon>   center, e.g. 34.25668/108.95738   (required)
//   -t, --type <png|svg|both>  output format(s)        (default both)
//   -s, --size <WxH>           pixel size            (default 2560x1664)
//   -p, --preset <minimal|standard|bold>  road weights  (default standard)
//       --theme <light|dark|both>         which themes  (default both)
//   -o, --out <dir>            output dir              (default <repo>/test-out)
//
// Minimal (only the required flag; defaults fill the rest — both formats, both themes):
//   npm run render-map -- -l 34.25668/108.95738
//
// Full (every option set explicitly):
//   npm run render-map -- -l 34.25668/108.95738 -t png -s 3840x2160 -p bold --theme both -o /tmp/maps
//
// Output: <out>/<lat>_<lon>-<theme>.<ext>, e.g.
//   test-out/34.25668_108.95738-dark.png

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createCanvas } from "canvas";

import { drawRoads, bboxForScreen, type StylePreset } from "../src/core/index.ts";
import { fetchCityData } from "../src/core/fetch-city.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = join(SCRIPT_DIR, "..");
const COORD_PRECISION = 5;

const THEMES = {
  light: { background: "#eee8d6", foreground: "#2d2d2d" },
  dark: { background: "#000000", foreground: "#5e5d58" },
} as const;
type ThemeName = keyof typeof THEMES;

const PRESETS: StylePreset[] = ["minimal", "standard", "bold"];

/** Minimal `-f value` / `--flag value` / `--flag=value` parser. */
function parseArgs(argv: string[]): Record<string, string> {
  const alias: Record<string, string> = {
    l: "location", t: "type", s: "size", p: "preset", o: "out",
  };
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("-")) continue;
    const key = a.replace(/^-+/, "");
    const [name, inlineVal] = key.split("=");
    const long = alias[name] ?? name;
    if (inlineVal !== undefined) out[long] = inlineVal;
    else out[long] = argv[++i] ?? "";
  }
  return out;
}

function fail(msg: string): never {
  console.error(`error: ${msg}\n`);
  console.error("usage: npm run render-map -- -l <lat/lon> [-t png|svg|both] [-s WxH] [-p preset] [--theme light|dark|both] [-o dir]");
  process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const loc = args.location ?? fail("missing -l <lat/lon>");
  const m = loc.match(/^(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) fail(`bad --location "${loc}" (expected lat/lon, e.g. 34.25668/108.95738)`);
  const lat = Number(m![1]);
  const lon = Number(m![2]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) fail(`lat/lon out of range: ${lat}/${lon}`);

  // -t is optional: omit it to render both formats.
  const typeArg = (args.type ?? "both").toLowerCase();
  if (!["png", "svg", "both"].includes(typeArg)) fail(`--type must be png/svg/both, got "${typeArg}"`);
  const types: ("png" | "svg")[] = typeArg === "both" ? ["png", "svg"] : [typeArg as "png" | "svg"];

  const size = args.size ?? "2560x1664";
  const sm = size.match(/^(\d+)x(\d+)$/i);
  if (!sm) fail(`bad --size "${size}" (expected WxH, e.g. 2560x1664)`);
  const width = Number(sm![1]);
  const height = Number(sm![2]);

  const preset = (args.preset ?? "standard") as StylePreset;
  if (!PRESETS.includes(preset)) fail(`--preset must be one of ${PRESETS.join("/")}`);

  const themeArg = (args.theme ?? "both").toLowerCase();
  if (!["light", "dark", "both"].includes(themeArg)) fail(`--theme must be light/dark/both`);
  const themes: ThemeName[] = themeArg === "both" ? ["light", "dark"] : [themeArg as ThemeName];

  const outDir = args.out ?? join(REPO_DIR, "test-out");

  // Same as the wallpaper pipeline: a screen-aspect rectangle around the center.
  const bbox = bboxForScreen(lat, lon, 10, width / height);

  console.log(`[render-map] ${lat}/${lon} @ ${width}x${height} ${preset} → ${types.join("+")} (${themes.join(", ")})`);
  console.log(`[render-map] fetching roads + water from Overpass ...`);
  const osm = await fetchCityData(bbox, { coordPrecision: COORD_PRECISION, spacingMs: 1500 });
  console.log(`[render-map] ${osm.elements?.length ?? 0} ways, ${osm.water?.length ?? 0} water features`);

  mkdirSync(outDir, { recursive: true });

  for (const name of themes) {
    const theme = THEMES[name];
    for (const type of types) {
      const canvas = type === "svg" ? createCanvas(width, height, "svg") : createCanvas(width, height);
      const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
      const drawn = drawRoads(ctx, {
        bbox,
        width,
        height,
        style: { background: theme.background, foreground: theme.foreground, preset, showWater: true },
        osm,
      });
      const buf = type === "svg" ? canvas.toBuffer() : canvas.toBuffer("image/png");
      // <out>/<lat>_<lon>-<theme>.<ext> — flat, underscore between coords.
      const file = join(outDir, `${lat}_${lon}-${name}.${type}`);
      writeFileSync(file, buf);
      console.log(`[render-map] ${name}: ${drawn} ways → ${file}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
