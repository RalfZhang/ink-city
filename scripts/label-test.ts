#!/usr/bin/env -S npx tsx
// Verifies where the city caption sets in from its corner (packages/core/src/label.ts):
//   • with the wallpaper's insets (the default, "add"), the margin is kept beyond them
//     — a caption a margin below the menu bar;
//   • with the desktop window's ("min"), the margin counts from the edge, and an inset
//     only pushes the caption in as far as it must to clear what's there.
// Drawn into a stand-in context that records where each line's text goes.
// Exits non-zero (printing every violation) on failure, so it can gate CI.
//
//   pnpm label-test

import { drawLabel, LABEL_MARGIN, type MapLabel } from "@inkcity/core";

const W = 1000;
const H = 800;
const MARGIN = Math.min(W, H) * LABEL_MARGIN; // 32

/** Where `drawLabel` puts the first line's text: its x, and its baseline. */
function firstLine(label: MapLabel): { x: number; y: number } {
  const at: { x: number; y: number }[] = [];
  const ctx = {
    save() {},
    restore() {},
    font: "",
    textAlign: "left",
    textBaseline: "alphabetic",
    lineJoin: "round",
    lineWidth: 1,
    direction: "ltr",
    fillStyle: "",
    strokeStyle: "",
    // Every line 100 px wide, its font 10 px over the baseline and 3 px under.
    measureText: () => ({ width: 100, fontBoundingBoxAscent: 10, fontBoundingBoxDescent: 3 }),
    strokeText() {},
    fillText(_text: string, x: number, y: number) {
      at.push({ x, y });
    },
  } as unknown as CanvasRenderingContext2D;
  drawLabel(ctx, label, { background: "#ffffff", foreground: "#000000" }, W, H);
  return at[0];
}

const base: MapLabel = { corner: "top-left", name: "Ghent", localName: "Gent", country: "BE", lat: 51.05, lon: 3.72 };
const insets = (top: number) => ({ top, right: 0, bottom: 0, left: 0 });

type Case = [what: string, label: MapLabel, want: { x?: number; top?: number }];
const CASES: Case[] = [
  ["no insets: a margin from the corner", base, { x: MARGIN, top: MARGIN }],
  ["add: the margin beyond a 54 px bar", { ...base, insets: insets(54) }, { x: MARGIN, top: 54 + MARGIN }],
  ["min: a 54 px bar outreaches the margin", { ...base, insets: insets(54), insetsMode: "min" }, { x: MARGIN, top: 54 }],
  ["min: a 20 px bar sits inside the margin", { ...base, insets: insets(20), insetsMode: "min" }, { x: MARGIN, top: MARGIN }],
  ["right corner, add: the margin beyond a 40 px edge", { ...base, corner: "top-right", insets: { top: 0, right: 40, bottom: 0, left: 0 } }, { x: W - 40 - MARGIN }],
  ["right corner, min: the farther of the two", { ...base, corner: "top-right", insets: { top: 0, right: 40, bottom: 0, left: 0 }, insetsMode: "min" }, { x: W - 40 }],
];

let failures = 0;
for (const [what, label, want] of CASES) {
  const got = firstLine(label);
  // The first line's baseline sits its ascent (10 px) below where the caption starts.
  const top = got.y - 10;
  const ok = (want.x === undefined || got.x === Math.round(want.x)) && (want.top === undefined || top === Math.round(want.top));
  if (!ok) {
    failures++;
    console.error(`✗ ${what}: x ${got.x}, top ${top}; want ${JSON.stringify(want)}`);
  }
}

if (failures > 0) {
  console.error(`✗ ${failures}/${CASES.length} caption placement cases failed`);
  process.exit(1);
}
console.log(`✓ drawLabel: ${CASES.length} placement cases (insets added to the margin, or at least it)`);
