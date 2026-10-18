#!/usr/bin/env -S npx tsx
// Guards locale parity: every key in the source-of-truth locale (en) must exist
// in every other locale, and no locale may carry stray keys. Without this a
// missing translation silently falls back to English in the UI and nothing in
// the build complains. The locale list is imported from `apps/desktop/src/i18n/locales.ts`,
// so it tracks the shipped locales with no manual sync.
//
// It checks each catalog the app loads: its own strings (apps/desktop/src/i18n) and the
// shared components' `ui` namespace (packages/ui/src/i18n), which has to cover
// every locale the app ships too — a missing file there is a failure, not a skip.
//
//   pnpm check:i18n
//
// Exits non-zero (and prints the offending keys) on any drift, so it can gate
// the build / CI.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { LOCALES } from "../apps/desktop/src/i18n/locales";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CATALOGS = ["apps/desktop/src/i18n", "packages/ui/src/i18n"];

// Codes come straight from the shipped-locales table, so this stays in lockstep
// with the app automatically. "en" is the source of truth (matches `fallbackLng`
// in index.ts) and is compared against every other code.
const SOURCE = "en";
const OTHERS = LOCALES.map((l) => l.code).filter((code) => code !== SOURCE);

type Json = Record<string, unknown>;

let failed = false;

function load(catalog: string, locale: string): Json | undefined {
  try {
    return JSON.parse(readFileSync(join(root, catalog, `${locale}.json`), "utf8"));
  } catch (e) {
    failed = true;
    console.error(`✗ ${catalog}/${locale}.json: ${e instanceof Error ? e.message : e}`);
    return undefined;
  }
}

/** Flatten to dotted leaf paths, e.g. "general.enabledLabel". */
function keys(obj: Json, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? keys(v as Json, `${prefix}${k}.`)
      : [`${prefix}${k}`],
  );
}

for (const catalog of CATALOGS) {
  const sourceJson = load(catalog, SOURCE);
  if (!sourceJson) continue;
  const source = new Set(keys(sourceJson));

  for (const locale of OTHERS) {
    const json = load(catalog, locale);
    if (!json) continue;
    const theirs = new Set(keys(json));
    const missing = [...source].filter((k) => !theirs.has(k)).sort();
    const extra = [...theirs].filter((k) => !source.has(k)).sort();

    if (missing.length || extra.length) {
      failed = true;
      console.error(`✗ ${catalog}/${locale}.json out of sync with ${SOURCE}.json`);
      if (missing.length) console.error(`  missing (${missing.length}): ${missing.join(", ")}`);
      if (extra.length) console.error(`  extra (${extra.length}): ${extra.join(", ")}`);
    } else {
      console.log(`✓ ${catalog}/${locale}.json matches ${SOURCE}.json (${theirs.size} keys)`);
    }
  }
}

if (failed) process.exit(1);
