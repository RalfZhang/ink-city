#!/usr/bin/env -S npx tsx
// Verifies the railway way-stitcher behind the `banded`/`ties`/`plain` symbols
// (chainRailways in src/core/render.ts):
//   • ways that meet end-to-end join into one chain, in either orientation and
//     whichever end of the growing chain they attach to,
//   • a chain breaks where three or more ways meet — a switch or junction is a real
//     topological feature, unlike the arbitrary splits OSM makes mid-line,
//   • the shared node appears once, not twice, at every join,
//   • no vertex is invented, lost, or duplicated: the stitched output carries exactly
//     the input vertices minus one per join,
//   • closed loops terminate instead of chasing their own tail,
//   • degenerate input (a one-point way, an empty list) is dropped, not drawn.
// Exits non-zero (printing every violation) on failure, so it can gate CI.
//
// Why this is worth a test at all: the stitcher is invisible in the output. Get it
// wrong and nothing crashes and nothing looks obviously broken — the dash phase just
// restarts more often than it should, which is exactly the symptom the stitcher
// exists to remove, so the layer would silently look the way it did before.
//
//   pnpm railway-test

import { chainRailways } from "../src/core/render.ts";
import type { Geom } from "../src/core/index.ts";

/** A way as `[lat, lon]` pairs — shorter to write than {lat, lon} objects. */
type Way = [number, number][];

const way = (pts: Way) => ({ line: pts.map(([lat, lon]) => ({ lat, lon })) });
const asPairs = (line: Geom[]): Way => line.map((p) => [p.lat, p.lon]);

/** Chains as `[lat, lon]` pairs, sorted so a case's `want` needn't fix the order
 *  chainRailways happens to emit (drawRailways re-sorts by screen length anyway). */
function chains(ways: Way[]): Way[] {
  return chainRailways(ways.map(way))
    .map(asPairs)
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

const sorted = (ws: Way[]) => ws.slice().sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

type Case = { name: string; ways: Way[]; want: Way[] };

// A: (0,0)→(0,1)→(0,2)   B: (0,2)→(0,3)   — B continues A at (0,2).
const A: Way = [[0, 0], [0, 1], [0, 2]];
const B: Way = [[0, 2], [0, 3]];

const CASES: Case[] = [
  {
    name: "two ways head-to-tail join, shared node kept once",
    ways: [A, B],
    want: [[[0, 0], [0, 1], [0, 2], [0, 3]]],
  },
  {
    name: "the second way reversed still joins (tail meets tail)",
    ways: [A, [[0, 3], [0, 2]]],
    want: [[[0, 0], [0, 1], [0, 2], [0, 3]]],
  },
  {
    name: "a way that extends the chain's head is prepended, not appended",
    // A starts at (0,0); this one ends there, so it belongs in front of A.
    ways: [A, [[0, -2], [0, -1], [0, 0]]],
    want: [[[0, -2], [0, -1], [0, 0], [0, 1], [0, 2]]],
  },
  {
    name: "head-side way reversed is flipped before it's prepended",
    ways: [A, [[0, 0], [0, -1]]],
    want: [[[0, -1], [0, 0], [0, 1], [0, 2]]],
  },
  {
    name: "a chain grows at both ends in one pass",
    ways: [A, B, [[0, -1], [0, 0]]],
    want: [[[0, -1], [0, 0], [0, 1], [0, 2], [0, 3]]],
  },
  {
    name: "the real case: many short ways become one long chain",
    ways: [
      [[0, 0], [0, 1]], [[0, 1], [0, 2]], [[0, 2], [0, 3]],
      [[0, 3], [0, 4]], [[0, 4], [0, 5]],
    ],
    want: [[[0, 0], [0, 1], [0, 2], [0, 3], [0, 4], [0, 5]]],
  },
  {
    name: "a chain breaks at a switch (three ways at one node)",
    // A ends at (0,2); two ways leave it, so there's no single continuation and
    // all three stay separate.
    ways: [A, B, [[0, 2], [1, 3]]],
    want: sorted([A, B, [[0, 2], [1, 3]]]),
  },
  {
    name: "disjoint lines stay separate",
    ways: [A, [[9, 9], [9, 10]]],
    want: sorted([A, [[9, 9], [9, 10]]]),
  },
  {
    name: "two ways forming a closed loop terminate as one chain",
    ways: [[[0, 0], [0, 1], [1, 1]], [[1, 1], [1, 0], [0, 0]]],
    want: [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]],
  },
  {
    name: "a single self-closed way is left alone (its two endpoints are one node)",
    ways: [[[0, 0], [0, 1], [1, 1], [0, 0]]],
    want: [[[0, 0], [0, 1], [1, 1], [0, 0]]],
  },
  {
    name: "a one-point way is dropped, and doesn't break the join around it",
    ways: [A, [[5, 5]], B],
    want: [[[0, 0], [0, 1], [0, 2], [0, 3]]],
  },
  { name: "no ways in, no chains out", ways: [], want: [] },
  {
    name: "endpoints matching only past ~1cm are not the same node",
    // 1e-7° ≈ 1.1cm at the equator: the quantization step, so this is a miss.
    ways: [A, [[0, 2.0000002], [0, 3]]],
    want: sorted([A, [[0, 2.0000002], [0, 3]]]),
  },
];

let failures = 0;
const bad = (name: string, msg: string) => {
  failures++;
  console.error(`✗ ${name}: ${msg}`);
};

for (const { name, ways, want } of CASES) {
  const got = chains(ways);
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    bad(name, `\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`);
    continue;
  }

  // Vertex conservation, checked on every case rather than spelled out per case:
  // stitching may only *remove* the duplicate node at a join, so the total vertex
  // count must drop by exactly (input ways drawn − chains out). A stitcher that
  // dropped a way, kept a shared node twice, or emitted one twice fails here even
  // when the shape it produced looks plausible.
  const drawn = ways.filter((w) => w.length >= 2);
  const vertsIn = drawn.reduce((n, w) => n + w.length, 0);
  const vertsOut = got.reduce((n, c) => n + c.length, 0);
  if (vertsOut !== vertsIn - (drawn.length - got.length)) {
    bad(name, `${vertsIn} vertices in ${drawn.length} ways → ${vertsOut} in ${got.length} chains`);
  }

  // Every chain must be drawable and free of the zero-length segments that a
  // double-counted join node would leave behind (walkPolyline skips them, but the
  // dash phase would still be off by a vertex).
  for (const c of got) {
    if (c.length < 2) bad(name, `emitted a ${c.length}-point chain`);
    for (let i = 1; i < c.length; i++) {
      if (c[i][0] === c[i - 1][0] && c[i][1] === c[i - 1][1]) {
        bad(name, `duplicate adjacent point at index ${i}: ${JSON.stringify(c)}`);
      }
    }
  }
}

if (failures > 0) {
  console.error(`✗ ${failures} railway stitching violation(s) across ${CASES.length} cases`);
  process.exit(1);
}
console.log(`✓ chainRailways: ${CASES.length} cases (joins, orientation, junctions, loops, degenerate input)`);
