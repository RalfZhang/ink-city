#!/usr/bin/env -S npx tsx
// Headless render harness for eyeballing the map (roads + water + airports) without the
// Tauri app. Reuses the portable `drawRoads` (which now also fills water) on a
// node-canvas context — the core is written to be canvas-implementation
// agnostic. Renders both themes so light/dark can be compared side by side.
//
//   npm run render-test -- <city.json> <width> <height> [outDir]
//
// <city.json> holds { bbox, osm:{ v, elements, water } } (as written by the
// throwaway test-data generator). Output PNGs land next to it (or in outDir),
// named "<base>_<light|dark>_<timestamp>.png" so repeated tuning runs don't
// clobber earlier captures.

import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { createCanvas } from "canvas";

import { drawRoads, bboxForScreen, type Bbox, type Osm, type StylePreset } from "../src/core/index.ts";

type CityTest = { lat: number; lon: number; bbox?: Bbox; osm: Osm };

const THEMES = [
  { name: "light", background: "#eee8d6", foreground: "#2d2d2d" },
  { name: "dark", background: "#000000", foreground: "#5e5d58" },
] as const;

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function main() {
  const [jsonPath, wArg, hArg, outArg] = process.argv.slice(2);
  if (!jsonPath || !wArg || !hArg) {
    console.error("usage: render-test <city.json> <width> <height> [outDir]");
    process.exit(1);
  }
  const width = Number(wArg);
  const height = Number(hArg);
  const data = JSON.parse(readFileSync(jsonPath, "utf8")) as CityTest;
  const { osm } = data;
  // Mirror pipeline.rs: render a screen-aspect rectangle around the city, a
  // subset of the precached 20km square. The renderer clips data outside it.
  const bbox = bboxForScreen(data.lat, data.lon, 10, width / height);

  const outDir = outArg ?? dirname(jsonPath);
  const base = basename(jsonPath).replace(/\.json$/, "");
  const ts = stamp();
  const preset: StylePreset = "standard";

  for (const theme of THEMES) {
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
    const drawn = drawRoads(ctx, {
      bbox,
      width,
      height,
      style: {
        background: theme.background,
        foreground: theme.foreground,
        preset,
        showWater: true,
        showAirports: true,
        showRailways: true,
        showAerialways: true,
      },
      osm,
    });
    const file = join(outDir, `${base}_${theme.name}_${ts}.png`);
    writeFileSync(file, canvas.toBuffer("image/png"));
    console.log(
      `[render-test] ${theme.name}: ${drawn} ways, ${osm.water?.length ?? 0} water, ` +
        `${osm.airports?.length ?? 0} airports, ${osm.railways?.length ?? 0} railways, ${osm.aerialways?.length ?? 0} aerialways → ${file}`,
    );
  }
}

main();
