#!/usr/bin/env -S npx tsx
// Verifies the map's crop around a city (packages/core/src/bbox.ts):
//   • bboxForScreen against scripts/fixtures/bbox-cases.json — the same cases
//     `cargo test` runs against its Rust port (apps/desktop/src-tauri/src/bbox.rs),
//     since CI precaches with this one and the client crops with that one,
//   • the square CI precaches at MAX_HALF_KM contains every crop a client takes of
//     it, whatever the screen's aspect — the reason one published payload serves
//     every screen.
// Exits non-zero (printing every violation) on failure, so it can gate CI.
//
//   pnpm bbox-test

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { bboxForScreen, MAX_HALF_KM, type Bbox } from "@inkcity/core";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

type Case = {
  name: string;
  lat: number;
  lon: number;
  maxHalfKm: number;
  /** width:height */
  aspect: [number, number];
  bbox: Bbox;
};

const { cases } = JSON.parse(
  readFileSync(join(ROOT, "scripts", "fixtures", "bbox-cases.json"), "utf8"),
) as { cases: Case[] };

/** Degrees: ~0.1 mm, far below a pixel and far above what two languages' `cos` can disagree by. */
const EPS = 1e-9;
const EDGES = ["south", "west", "north", "east"] as const;

let checks = 0;
let failures = 0;
function check(ok: boolean, msg: string): void {
  checks++;
  if (!ok) {
    failures++;
    console.error(`✗ ${msg}`);
  }
}

check(cases.length > 0, "the fixture has no cases");

for (const c of cases) {
  const got = bboxForScreen(c.lat, c.lon, c.maxHalfKm, c.aspect[0] / c.aspect[1]);
  for (const edge of EDGES) {
    check(Math.abs(got[edge] - c.bbox[edge]) < EPS, `${c.name}: ${edge} is ${got[edge]}, the fixture says ${c.bbox[edge]}`);
  }
}

// The client crops `bboxForScreen(lat, lon, MAX_HALF_KM, w/h)` out of a payload CI
// fetched as `bboxForScreen(lat, lon, MAX_HALF_KM, 1)`, so the square has to contain
// the crop at every aspect — the fixture's, plus two more extreme than any screen.
const aspects = [...new Set([...cases.map((c) => c.aspect[0] / c.aspect[1]), 4, 1 / 4])];
for (const c of cases) {
  const square = bboxForScreen(c.lat, c.lon, MAX_HALF_KM, 1);
  for (const aspect of aspects) {
    const crop = bboxForScreen(c.lat, c.lon, MAX_HALF_KM, aspect);
    check(
      crop.south >= square.south && crop.north <= square.north && crop.west >= square.west && crop.east <= square.east,
      `${c.name}: the ${aspect.toFixed(3)} crop reaches past the precached square`,
    );
  }
}

if (failures > 0) {
  console.error(`✗ ${failures}/${checks} bbox checks failed`);
  process.exit(1);
}
console.log(
  `✓ bboxForScreen: ${cases.length} fixture cases (shared with cargo test), ` +
    `and the ${2 * MAX_HALF_KM} km precached square covers every crop at ${aspects.length} aspects`,
);
