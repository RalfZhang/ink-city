#!/usr/bin/env -S npx tsx
// Verifies the coordinate parser behind the "Customized" update mode
// (src/core/coords.ts, issue #11):
//   • every input format the module documents actually parses,
//   • pasted Google Maps / OpenStreetMap links yield the place, not null,
//   • out-of-range and junk input is rejected rather than pinned.
// Exits non-zero (printing every violation) on failure, so it can gate CI.
//
//   npm run coords-test

import { parseLatLon } from "../src/core/coords.ts";

/** `null` ⇒ the input must be rejected. */
type Case = [input: string, want: [lat: number, lon: number] | null];

const CASES: Case[] = [
  // --- the documented bare formats ---
  ["51.5074, -0.1278", [51.5074, -0.1278]],
  ["51.5074 -0.1278", [51.5074, -0.1278]],
  ["  35.6895 , 139.6917  ", [35.6895, 139.6917]],
  ["-16.5, -68.17", [-16.5, -68.17]],
  ["51.5074°N, 0.1278°W", [51.5074, -0.1278]],
  ["51.5074N 0.1278W", [51.5074, -0.1278]],
  ["33.8688S, 151.2093E", [-33.8688, 151.2093]],
  ["51°30'26\"N 0°7'39\"W", [51.507222, -0.1275]],
  ["40°26′46″N 79°58′56″W", [40.446111, -79.982222]],

  // --- pasted links ---
  ["@51.5074,-0.1278,13z", [51.5074, -0.1278]],
  ["https://www.google.com/maps/@51.5074,-0.1278,13z", [51.5074, -0.1278]],
  ["https://maps.google.com/?q=51.5074,-0.1278", [51.5074, -0.1278]],
  // A place URL carries both the viewport centre (@) and the place (!3d/!4d);
  // the place must win.
  ["https://www.google.com/maps/place/X/@1.5,2.5,13z/data=!3d51.0543!4d3.7174", [51.0543, 3.7174]],
  ["https://www.openstreetmap.org/#map=13/51.0543/3.7174", [51.0543, 3.7174]],
  ["https://www.openstreetmap.org/?mlat=51.0543&mlon=3.7174", [51.0543, 3.7174]],

  // --- rejected ---
  ["", null],
  ["   ", null],
  ["hello", null],
  ["51.5074", null], // one number is not a location
  ["1,2,3", null],
  ["91, 0", null], // latitude out of range
  ["-91, 0", null],
  ["0, 181", null], // longitude out of range
  ["0, -181", null],
  ["https://example.com/nothing", null],
  ["S 33.8688, E 151.2093", null], // hemisphere prefix isn't a supported form
];

let failures = 0;
for (const [input, want] of CASES) {
  const got = parseLatLon(input);
  const ok =
    want === null
      ? got === null
      : got !== null &&
        Math.abs(got.lat - want[0]) < 1e-5 &&
        Math.abs(got.lon - want[1]) < 1e-5;
  if (!ok) {
    failures++;
    console.error(`✗ ${JSON.stringify(input)} → ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}

if (failures > 0) {
  console.error(`✗ ${failures}/${CASES.length} coordinate cases failed`);
  process.exit(1);
}
console.log(`✓ parseLatLon: ${CASES.length} cases (formats, pasted links, rejections)`);
