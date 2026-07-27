#!/usr/bin/env -S npx tsx
// Headless map renderer — one script, two input modes, picked from the argument:
//   • lat/lon (e.g. 34.25668/108.95738) → fetch roads + water + airports +
//     railways + aerialways live from Overpass, cache the payload, then render.
//   • a city .json path                  → replay that precached payload offline.
// Either way it renders both themes (light/dark) in every requested format
// (png/svg) on a node-canvas surface, so the output matches the desktop
// wallpaper exactly. Every output file — including the downloaded JSON — is
// timestamped, so repeated tuning runs never clobber earlier captures.
//
// node-canvas resolves only from the project's node_modules, so run from inside
// the repo.
//
// Usage:
//   npm run render -- <lat/lon | city.json> [options]
//
// Options:
//   -t, --type <png|svg|both>             output format(s)  (default both)
//   -s, --size <WxH>                       pixel size        (default 2560x1664)
//   -p, --preset <minimal|standard|bold>  road weights      (default standard)
//       --theme <light|dark|both>         which themes      (default both)
//   -o, --out <dir>                        output dir  (default: test-out for
//                                          coords, next to the file for a path)
//
// Examples:
//   npm run render -- 34.25668/108.95738
//   npm run render -- test-out/34.25668_108.95738_20260725-234157.json -p bold
//   npm run render -- 34.25668/108.95738 -t png -s 3840x2160 --theme dark -o /tmp/maps
//
// Accepted .json shapes:
//   - { lat, lon, osm:{ v, elements, ... } } from the throwaway test-data generator, or
//   - a bare osm payload { v, elements, ... } whose <lat>_<lon>[_<ts>].json
//     filename carries the center coords.
//
// Output: <out>/<base>_<theme>_<ts>.<ext>, where <base> is "<lat>_<lon>" for
// coords or the .json's stem — e.g. test-out/34.25668_108.95738_dark_20260725-234157.png

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createCanvas } from "canvas";

import {
  drawScene,
  bboxForScreen,
  LAYER_IDS,
  type Bbox,
  type LayerId,
  type Osm,
  type Style,
  type StylePreset,
} from "../src/core/index.ts";
import { fetchCityData } from "../src/core/osm/index.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = join(SCRIPT_DIR, "..");
const COORD_PRECISION = 5;
/** Half-width (km) of the rendered square; bboxForScreen crops a screen-aspect
 *  rectangle from it — matches the wallpaper pipeline's precached 20km area. */
const RENDER_RADIUS_KM = 10;

const PRESETS: StylePreset[] = ["minimal", "standard", "bold"];

type ThemeName = "light" | "dark";
const THEMES: Record<ThemeName, { background: string; foreground: string }> = {
  light: { background: "#eee8d6", foreground: "#2d2d2d" },
  dark: { background: "#000000", foreground: "#5e5d58" },
};

/** A lat/lon argument, e.g. "34.25668/108.95738". If it doesn't match, the
 *  positional is treated as a .json path instead. */
const COORD_RE = /^(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)$/;
/** <lat>_<lon>[_<timestamp>] stem of a cached payload's filename. The optional
 *  trailing `_...` lets a timestamped download round-trip back through here. */
const FILENAME_COORD_RE = /^(-?\d+(?:\.\d+)?)_(-?\d+(?:\.\d+)?)(?:_.*)?$/;

type CityWrapper = { lat: number; lon: number; bbox?: Bbox; osm: Osm };

/** Every optional layer switched on, as `{ showWater: true, ... }`. Derived
 *  from LAYER_IDS so a newly-added layer turns on here with no edit. */
function allLayersOn(): Pick<Style, `show${Capitalize<LayerId>}`> {
  return Object.fromEntries(
    LAYER_IDS.map((id) => [`show${id[0].toUpperCase()}${id.slice(1)}`, true]),
  ) as Pick<Style, `show${Capitalize<LayerId>}`>;
}

/** Minimal `-f value` / `--flag value` / `--flag=value` parser; bare args → positionals. */
function parseArgs(argv: string[]): { positionals: string[]; flags: Record<string, string> } {
  const alias: Record<string, string> = { t: "type", s: "size", p: "preset", o: "out" };
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("-")) {
      positionals.push(a);
      continue;
    }
    const key = a.replace(/^-+/, "");
    const [name, inlineVal] = key.split("=");
    const long = alias[name] ?? name;
    if (inlineVal !== undefined) flags[long] = inlineVal;
    else flags[long] = argv[++i] ?? "";
  }
  return { positionals, flags };
}

function fail(msg: string): never {
  console.error(`error: ${msg}\n`);
  console.error(
    "usage: npm run render -- <lat/lon | city.json> [-t png|svg|both] [-s WxH] [-p preset] [--theme light|dark|both] [-o dir]",
  );
  process.exit(1);
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function main() {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  const input = positionals[0] ?? fail("missing <lat/lon | city.json>");

  // --- Options shared by both modes ---
  const typeArg = (flags.type ?? "both").toLowerCase();
  if (!["png", "svg", "both"].includes(typeArg)) fail(`--type must be png/svg/both, got "${typeArg}"`);
  const types: ("png" | "svg")[] = typeArg === "both" ? ["png", "svg"] : [typeArg as "png" | "svg"];

  const size = flags.size ?? "2560x1664";
  const sm = size.match(/^(\d+)x(\d+)$/i);
  if (!sm) fail(`bad --size "${size}" (expected WxH, e.g. 2560x1664)`);
  const width = Number(sm[1]);
  const height = Number(sm[2]);

  const preset = (flags.preset ?? "standard") as StylePreset;
  if (!PRESETS.includes(preset)) fail(`--preset must be one of ${PRESETS.join("/")}`);

  const themeArg = (flags.theme ?? "both").toLowerCase();
  if (!["light", "dark", "both"].includes(themeArg)) fail(`--theme must be light/dark/both`);
  const themes: ThemeName[] = themeArg === "both" ? ["light", "dark"] : [themeArg as ThemeName];

  // --- Resolve the input into { lat, lon, osm, base, outDir } ---
  const ts = stamp();
  const coord = input.match(COORD_RE);
  let lat: number, lon: number, osm: Osm, base: string, outDir: string;

  if (coord) {
    // Coordinates → fetch live from Overpass and cache the payload.
    lat = Number(coord[1]);
    lon = Number(coord[2]);
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) fail(`lat/lon out of range: ${lat}/${lon}`);
    base = `${lat}_${lon}`;
    outDir = flags.out ?? join(REPO_DIR, "test-out");
    const bbox = bboxForScreen(lat, lon, RENDER_RADIUS_KM, width / height);

    console.log(`[render] ${lat}/${lon} @ ${width}x${height} ${preset} → ${types.join("+")} (${themes.join(", ")})`);
    console.log(`[render] fetching roads + water + airports + railways + aerialways from Overpass ...`);
    osm = await fetchCityData(bbox, { coordPrecision: COORD_PRECISION });

    mkdirSync(outDir, { recursive: true });
    // Persist the raw payload (timestamped) so it can be replayed offline later.
    const osmFile = join(outDir, `${base}_${ts}.json`);
    writeFileSync(osmFile, JSON.stringify(osm));
    console.log(`[render] osm data → ${osmFile}`);
  } else {
    // A .json path → replay a precached payload offline.
    const raw = JSON.parse(readFileSync(input, "utf8")) as CityWrapper | Osm;
    const wrapped = "osm" in raw ? (raw as CityWrapper) : null;
    osm = wrapped ? wrapped.osm : (raw as Osm);
    base = basename(input).replace(/\.json$/, "");
    outDir = flags.out ?? dirname(input);

    // Center coords come from the wrapper, else from the <lat>_<lon>[_<ts>] filename.
    if (wrapped && wrapped.lat !== undefined && wrapped.lon !== undefined) {
      lat = wrapped.lat;
      lon = wrapped.lon;
    } else {
      const fm = base.match(FILENAME_COORD_RE);
      if (!fm) fail(`no lat/lon in JSON and can't parse them from filename "${base}" (expected <lat>_<lon>[_<ts>].json)`);
      lat = Number(fm[1]);
      lon = Number(fm[2]);
    }
    mkdirSync(outDir, { recursive: true });
  }

  console.log(
    `[render] ${osm.elements?.length ?? 0} ways, ${osm.water?.length ?? 0} water, ` +
      `${osm.airports?.length ?? 0} airports, ${osm.railways?.length ?? 0} railways, ${osm.aerialways?.length ?? 0} aerialways`,
  );

  // Same as the wallpaper pipeline: a screen-aspect rectangle around the center.
  const bbox = bboxForScreen(lat, lon, RENDER_RADIUS_KM, width / height);

  for (const name of themes) {
    const theme = THEMES[name];
    for (const type of types) {
      const canvas = type === "svg" ? createCanvas(width, height, "svg") : createCanvas(width, height);
      const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
      const counts = drawScene(ctx, {
        bbox,
        width,
        height,
        style: {
          background: theme.background,
          foreground: theme.foreground,
          preset,
          ...allLayersOn(),
        },
        osm,
      });
      const buf = type === "svg" ? canvas.toBuffer() : canvas.toBuffer("image/png");
      const file = join(outDir, `${base}_${name}_${ts}.${type}`);
      writeFileSync(file, buf);
      const summary = Object.entries(counts)
        .filter(([, n]) => n > 0)
        .map(([layer, n]) => `${n} ${layer}`)
        .join(", ");
      console.log(`[render] ${name}/${type}: ${summary} → ${file}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
