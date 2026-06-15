#!/usr/bin/env -S npx tsx
// Guards locale parity: every key in the source-of-truth locale (en) must exist
// in every other locale, and no locale may carry stray keys. Without this a
// missing translation silently falls back to English in the UI and nothing in
// the build complains. Keep this in sync with the locales wired into
// `src/i18n/index.ts`.
//
//   npm run check:i18n
//
// Exits non-zero (and prints the offending keys) on any drift, so it can gate
// the build / CI.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const i18nDir = join(here, "..", "src", "i18n");

// The first entry is the source of truth (matches `fallbackLng` in index.ts).
const SOURCE = "en";
const OTHERS = ["zh-Hans"];

type Json = Record<string, unknown>;

function load(locale: string): Json {
  return JSON.parse(readFileSync(join(i18nDir, `${locale}.json`), "utf8"));
}

/** Flatten to dotted leaf paths, e.g. "general.enabledLabel". */
function keys(obj: Json, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? keys(v as Json, `${prefix}${k}.`)
      : [`${prefix}${k}`],
  );
}

const source = new Set(keys(load(SOURCE)));
let failed = false;

for (const locale of OTHERS) {
  const theirs = new Set(keys(load(locale)));
  const missing = [...source].filter((k) => !theirs.has(k)).sort();
  const extra = [...theirs].filter((k) => !source.has(k)).sort();

  if (missing.length || extra.length) {
    failed = true;
    console.error(`✗ ${locale}.json out of sync with ${SOURCE}.json`);
    if (missing.length) console.error(`  missing (${missing.length}): ${missing.join(", ")}`);
    if (extra.length) console.error(`  extra (${extra.length}): ${extra.join(", ")}`);
  } else {
    console.log(`✓ ${locale}.json matches ${SOURCE}.json (${theirs.size} keys)`);
  }
}

if (failed) process.exit(1);
