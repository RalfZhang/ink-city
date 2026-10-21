#!/usr/bin/env -S npx tsx
// Headless map renderer — one script, three input modes, picked from the argument:
//   • lat/lon (e.g. 34.25668/108.95738) → fetch roads + water + airports +
//     railways + aerialways live from Overpass, cache the payload, then render.
//   • a city .json path                  → replay that precached payload offline.
//   • a directory                        → replay every .json in it, same options.
// Either way it renders both themes (light/dark) in every requested preset and
// format (png/svg) on a node-canvas surface, so the output matches the desktop
// wallpaper exactly. Every output file — including the downloaded JSON — is
// timestamped, so repeated tuning runs never clobber earlier captures; pass
// --no-stamp when you'd rather overwrite in place (tuning ROAD_WEIGHTS against
// a fixed set of cities, where a stable filename is the point).
//
// node-canvas resolves only from the project's node_modules, so run from inside
// the repo.
//
// Usage:
//   pnpm render <lat/lon | city.json | dir> [options]
//
// Options:
//   -t, --type <png|svg|both>             output format(s)  (default both)
//   -s, --size <WxH>                       pixel size        (default 2560x1664)
//   -p, --preset <minimal|standard|bold>  road weights      (default standard)
//                                          `all`, or a comma-separated list, to
//                                          render several in one pass.
//       --km <n>                           width (km) of the square area, i.e.
//                                          how much ground the payload covers
//                                          (default 20, the pipeline's cache).
//       --rail <off|plain|banded|ties>    railway symbol    (default banded)
//       --theme <light|dark|both>         which themes      (default both)
//       --mondrian                         Mondrian style (issue #18). Overrides
//                                          the theme colors, so it renders once
//                                          and tags the file `_mondrian`.
//       --fetch-only                       download + cache the payload, then
//                                          stop — no rendering (coords only).
//       --no-stamp                         drop the timestamp from output names,
//                                          so re-runs overwrite in place.
//   -o, --out <dir>                        output dir  (default: test-out for
//                                          coords, next to the file for a path)
//
// Examples:
//   pnpm render 34.25668/108.95738
//   pnpm render test-out/34.25668_108.95738_20260725-234157.json -p bold
//   pnpm render 34.25668/108.95738 -t png -s 3840x2160 --theme dark -o /tmp/maps
//   pnpm render test-out/-16.50016_-68.1709.json --mondrian -t png
//   pnpm render road-test/json -t png --theme light -p all --no-stamp -o road-test/png
//   pnpm render 34.25668/108.95738 --fetch-only --km 20 -o road-test/json
//
// Accepted .json shapes:
//   - { lat, lon, osm:{ v, elements, ... } } from the throwaway test-data generator,
//   - a payload carrying its own city, { v, elements, ..., city:{ lat, lon } } —
//     what the `data` branch publishes (osm/<id>.json, osm-v2/data/<date>.json), or
//   - a bare osm payload { v, elements, ... } whose <lat>_<lon>[_<ts>].json
//     filename carries the center coords.
// A payload may also carry `km` (written by --fetch-only); it's the area it was
// downloaded with, so a replay crops the same ground without repeating --km.
//
// Output: <out>/<base>_<preset>_<theme>_<ts>.<ext>, where <base> is "<lat>_<lon>"
// for coords or the .json's stem — e.g.
// test-out/34.25668_108.95738_standard_dark_20260725-234157.png

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createCanvas } from "canvas";

import {
  drawScene,
  bboxForScreen,
  DEFAULT_COLORS,
  LAYER_IDS,
  MAX_HALF_KM,
  RAILWAY_STYLES,
  STYLE_PRESETS,
  type Bbox,
  type LayerId,
  type Osm,
  type RailwayStyle,
  type Style,
  type StylePreset,
} from "@inkcity/core";
import { fetchCityData } from "@inkcity/osm";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = join(SCRIPT_DIR, "..");
const COORD_PRECISION = 5;
/** Width (km) of the square area a payload covers; bboxForScreen crops a
 *  screen-aspect rectangle out of it. 20km — twice MAX_HALF_KM, the square the
 *  wallpaper pipeline precaches at aspect 1 — so a payload from the `data` branch
 *  replays here unchanged. `--km` overrides it. */
const DEFAULT_AREA_KM = 2 * MAX_HALF_KM;

/** The desktop's two themes, each drawn in a fresh install's colors. */
type ThemeName = keyof typeof DEFAULT_COLORS;

/** A lat/lon argument, e.g. "34.25668/108.95738". If it doesn't match, the
 *  positional is treated as a .json path instead. */
const COORD_RE = /^(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)$/;
/** <lat>_<lon>[_<timestamp>] stem of a cached payload's filename. The optional
 *  trailing `_...` lets a timestamped download round-trip back through here. */
const FILENAME_COORD_RE = /^(-?\d+(?:\.\d+)?)_(-?\d+(?:\.\d+)?)(?:_.*)?$/;

type CityWrapper = { lat: number; lon: number; km?: number; bbox?: Bbox; osm: Osm };
/** A payload that carries its own center — what the `data` branch publishes, and
 *  what --fetch-only writes (with the `km` it was downloaded with). */
type SelfLocating = Osm & { km?: number; city?: { lat: number; lon: number; name?: string } };

/** The optional layers that are plain on/off, switched on — `{ showWater: true, ... }`.
 *  Derived from LAYER_IDS so a newly-added boolean layer turns on here with no
 *  edit. `railways` is excluded: it's a mode, not a flag (see `--rail`). */
const BOOLEAN_LAYERS = LAYER_IDS.filter((id) => id !== "railways");
type BooleanLayer = Exclude<LayerId, "railways">;

function allLayersOn(): Pick<Style, `show${Capitalize<BooleanLayer>}`> {
  return Object.fromEntries(
    BOOLEAN_LAYERS.map((id) => [`show${id[0].toUpperCase()}${id.slice(1)}`, true]),
  ) as Pick<Style, `show${Capitalize<BooleanLayer>}`>;
}


/** Flags that take no value — present ⇒ "true", and the next argv is left alone. */
const BOOL_FLAGS = new Set(["mondrian", "fetch-only", "no-stamp"]);

/** Minimal `-f value` / `--flag value` / `--flag=value` parser; bare args → positionals. */
function parseArgs(argv: string[]): { positionals: string[]; flags: Record<string, string> } {
  const alias: Record<string, string> = { t: "type", s: "size", p: "preset", o: "out" };
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // pnpm forwards `--` through to the script rather than stripping it, so a
    // habitual `pnpm render -- x` would otherwise read `--` as the positional.
    // Skipping it makes the separator optional.
    if (a === "--") continue;
    if (!a.startsWith("-")) {
      positionals.push(a);
      continue;
    }
    const key = a.replace(/^-+/, "");
    const [name, inlineVal] = key.split("=");
    const long = alias[name] ?? name;
    if (inlineVal !== undefined) flags[long] = inlineVal;
    else if (BOOL_FLAGS.has(long)) flags[long] = "true";
    else flags[long] = argv[++i] ?? "";
  }
  return { positionals, flags };
}

function fail(msg: string): never {
  console.error(`error: ${msg}\n`);
  console.error(
    "usage: pnpm render <lat/lon | city.json | dir> [-t png|svg|both] [-s WxH] [-p preset|all|a,b] [--km n] [--rail off|plain|banded|ties] [--theme light|dark|both] [--mondrian] [--fetch-only] [--no-stamp] [-o dir]",
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

  // One preset, `all`, or a comma-separated list — a tuning pass usually wants
  // to see the same city under every weight table at once.
  const presetArg = (flags.preset ?? "standard").toLowerCase();
  const presets = (presetArg === "all"
    ? [...STYLE_PRESETS]
    : presetArg.split(",").map((p) => p.trim()).filter(Boolean)) as StylePreset[];
  if (!presets.length) fail("--preset is empty");
  for (const p of presets) {
    if (!STYLE_PRESETS.includes(p)) {
      fail(`--preset must be ${STYLE_PRESETS.join("/")}, "all", or a comma-separated list — got "${p}"`);
    }
  }

  const areaKm = Number(flags.km ?? DEFAULT_AREA_KM);
  if (!Number.isFinite(areaKm) || areaKm <= 0) fail(`bad --km "${flags.km}" (expected a positive number, e.g. 20)`);

  const rail = (flags.rail ?? "banded") as RailwayStyle;
  if (!RAILWAY_STYLES.includes(rail)) fail(`--rail must be one of ${RAILWAY_STYLES.join("/")}`);

  const themeArg = (flags.theme ?? "both").toLowerCase();
  if (!["light", "dark", "both"].includes(themeArg)) fail(`--theme must be light/dark/both`);
  // Mondrian replaces `background`/`foreground` (see core/mondrian.ts), so both
  // themes would render byte-identical output — render once and label it as the
  // style rather than as a theme.
  const mondrian = flags.mondrian === "true";
  const themes: ThemeName[] = mondrian
    ? ["light"]
    : themeArg === "both"
      ? ["light", "dark"]
      : [themeArg as ThemeName];

  // --- Resolve the input into the list of payload files to render ---
  const ts = stamp();
  const suffix = flags["no-stamp"] === "true" ? "" : `_${ts}`;
  const coord = input.match(COORD_RE);
  const fetchOnly = flags["fetch-only"] === "true";
  if (fetchOnly && !coord) fail("--fetch-only downloads a payload, so it needs a lat/lon, not a path");
  const files: string[] = [];

  if (coord) {
    // Coordinates → fetch live from Overpass and cache the payload. Downloaded
    // as a square (aspect 1) like the pipeline's precache, so it's a superset of
    // every screen-aspect crop and replays at any later --size.
    const lat = Number(coord[1]);
    const lon = Number(coord[2]);
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) fail(`lat/lon out of range: ${lat}/${lon}`);
    const outDir = flags.out ?? join(REPO_DIR, "test-out");
    const bbox = bboxForScreen(lat, lon, areaKm / 2, 1);

    console.log(`[render] ${lat}/${lon}, ${areaKm}km square`);
    console.log(`[render] fetching roads + water + airports + railways + aerialways from Overpass ...`);
    const osm = await fetchCityData(bbox, { coordPrecision: COORD_PRECISION });

    mkdirSync(outDir, { recursive: true });
    // Persist the raw payload so it can be replayed offline later. `city` and
    // `km` ride along — the same shape the `data` branch publishes — so the
    // replay recovers both the center and the area without being told again.
    const osmFile = join(outDir, `${lat}_${lon}${suffix}.json`);
    const payload: SelfLocating = { ...osm, km: areaKm, city: { lat, lon } };
    writeFileSync(osmFile, JSON.stringify(payload));
    console.log(`[render] osm data → ${osmFile}`);
    if (fetchOnly) return;
    files.push(osmFile);
  } else if (statSync(input).isDirectory()) {
    // A directory → replay every payload in it under one set of options.
    const found = readdirSync(input).filter((f) => f.endsWith(".json")).sort();
    if (!found.length) fail(`no .json payloads in "${input}"`);
    files.push(...found.map((f) => join(input, f)));
  } else {
    files.push(input);
  }

  const labels = mondrian ? ["mondrian"] : themes;
  console.log(
    `[render] ${files.length} payload(s) @ ${width}x${height} → ${types.join("+")}` +
      ` × ${presets.join("/")} × ${labels.join("/")}`,
  );

  for (const file of files) {
    // Three accepted shapes (see the header): a { lat, lon, osm } wrapper, a
    // payload carrying its own `city`, or a bare payload named <lat>_<lon>.
    const raw = JSON.parse(readFileSync(file, "utf8")) as CityWrapper | SelfLocating;
    const wrapped = "osm" in raw ? (raw as CityWrapper) : null;
    const self = wrapped ? null : (raw as SelfLocating);
    const osm: Osm = wrapped ? wrapped.osm : (self as Osm);
    const base = basename(file).replace(/\.json$/, "");
    const outDir = flags.out ?? dirname(file);
    mkdirSync(outDir, { recursive: true });

    let lat: number, lon: number;
    const center =
      wrapped && wrapped.lat !== undefined && wrapped.lon !== undefined
        ? { lat: wrapped.lat, lon: wrapped.lon }
        : (self?.city ?? null);
    if (center) {
      lat = center.lat;
      lon = center.lon;
    } else {
      const fm = base.match(FILENAME_COORD_RE);
      if (!fm) {
        fail(
          `no lat/lon in "${file}": it has neither a { lat, lon } wrapper nor a \`city\`, ` +
            `and its name isn't <lat>_<lon>[_<ts>].json`,
        );
      }
      lat = Number(fm[1]);
      lon = Number(fm[2]);
    }
    // An explicit --km wins; otherwise the area the payload was downloaded with.
    const km = flags.km !== undefined ? areaKm : (wrapped?.km ?? self?.km ?? DEFAULT_AREA_KM);

    console.log(
      `[render] ${base} @ ${lat}/${lon} (${km}km): ${osm.elements?.length ?? 0} ways, ` +
        `${osm.water?.length ?? 0} water, ${osm.airports?.length ?? 0} airports, ` +
        `${osm.railways?.length ?? 0} railways, ${osm.aerialways?.length ?? 0} aerialways`,
    );

    // Same as the wallpaper pipeline: a screen-aspect rectangle around the center.
    const bbox = bboxForScreen(lat, lon, km / 2, width / height);

    for (const preset of presets) {
      for (const name of themes) {
        const theme = DEFAULT_COLORS[name];
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
              railwayStyle: rail,
              variant: mondrian ? "mondrian" : "ink",
            },
            osm,
          });
          const buf = type === "svg" ? canvas.toBuffer() : canvas.toBuffer("image/png");
          const label = mondrian ? "mondrian" : name;
          const outFile = join(outDir, `${base}_${preset}_${label}${suffix}.${type}`);
          writeFileSync(outFile, buf);
          const summary = Object.entries(counts)
            .filter(([, n]) => n > 0)
            .map(([layer, n]) => `${n} ${layer}`)
            .join(", ");
          console.log(`[render] ${preset}/${label}/${type}: ${summary} → ${outFile}`);
        }
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
