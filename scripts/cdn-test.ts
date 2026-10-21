#!/usr/bin/env -S npx tsx
// Verifies mirrorUrls (packages/core/src/cdn.ts) against
// scripts/fixtures/mirror-urls.json — the same cases `cargo test` runs against
// `mirror_urls` (apps/desktop/src-tauri/src/github_mirror.rs), so the website's
// fetch ladder and the desktop's try the same URLs in the same order.
// Exits non-zero (printing every violation) on failure, so it can gate CI.
//
//   pnpm cdn-test

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { mirrorUrls } from "@inkcity/core";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { cases } = JSON.parse(
  readFileSync(join(ROOT, "scripts", "fixtures", "mirror-urls.json"), "utf8"),
) as { cases: { path: string; urls: string[] }[] };

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
  const got = mirrorUrls(c.path);
  check(got.length === c.urls.length, `${c.path}: ${got.length} URLs, the fixture lists ${c.urls.length}`);
  c.urls.forEach((want, i) => check(got[i] === want, `${c.path} #${i}: ${got[i]}, the fixture says ${want}`));
}

if (failures > 0) {
  console.error(`✗ ${failures}/${checks} cdn checks failed`);
  process.exit(1);
}
console.log(`✓ mirrorUrls: ${cases.length} fixture cases (shared with cargo test)`);
