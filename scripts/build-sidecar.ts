#!/usr/bin/env -S npx tsx
// Compiles scripts/osm-cli.ts into the Tauri sidecar binary, named per
// Tauri's externalBin convention: src-tauri/binaries/ink-city-osm-cli-<target-triple>
// (+ ".exe" on Windows; see BIN below for why the basename is prefixed).
// Requires `bun` (https://bun.sh) at *build* time only — the compiled binary is
// a standalone executable; nothing at app runtime needs a JS engine.
//
// Runs automatically (host triple) before every `pnpm tauri ...` via the
// "pretauri" script hook, so a fresh clone just needs bun installed — no separate
// manual step. Re-run it yourself to pick up changes to scripts/osm-cli.ts or
// src/core/osm/*.ts (transport, layers, fetch-city) without going through
// `tauri dev`/`build`.
//
// Usage:
//   tsx scripts/build-sidecar.ts                 host triple, for local `tauri dev`/`build`
//   tsx scripts/build-sidecar.ts --bun-target=bun-darwin-x64 --triple=x86_64-apple-darwin
//   tsx scripts/build-sidecar.ts --bun-target=bun-darwin-arm64 --triple=aarch64-apple-darwin
//   tsx scripts/build-sidecar.ts --bun-target=bun-windows-x64 --triple=x86_64-pc-windows-msvc
//   tsx scripts/build-sidecar.ts --bun-target=bun-linux-x64 --triple=x86_64-unknown-linux-gnu
//
// bun cross-compiles, so any of those can be produced from any host — handy for
// checking a Linux or Windows build without leaving your machine.
//
// macOS universal builds need a fat binary, which `bun build --compile` can't
// produce directly: build the two arch-specific binaries above, then
//   lipo -create -output src-tauri/binaries/ink-city-osm-cli-universal-apple-darwin \
//     src-tauri/binaries/ink-city-osm-cli-aarch64-apple-darwin \
//     src-tauri/binaries/ink-city-osm-cli-x86_64-apple-darwin
// Keep all three files — don't delete the arch-specific ones afterward.
// `tauri build --target universal-apple-darwin` needs both: build.rs runs
// once per real arch (cargo has no literal "universal" target) and looks up
// the arch-specific name each time, while the bundler's final packaging step
// runs once, after both cargo passes, and looks up the
// `-universal-apple-darwin` name to embed in the app.

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT_DIR = join(ROOT, "src-tauri", "binaries");

/** Basename of the compiled sidecar, prefixed with the product name while the
 * TypeScript source it's built from stays `scripts/osm-cli.ts`. The prefix is
 * for Linux: the .deb/.rpm install external binaries into the shared
 * `/usr/bin`, next to the app's own `/usr/bin/ink-city`, so a bare `osm-cli`
 * there would be squatting a very general name in a namespace other packages
 * share. macOS and Windows keep theirs inside the app bundle / install dir, so
 * the name only has to be unique to us — but it's one binary, so it's one name.
 * Must match `bundle.externalBin` in tauri.conf.json, the sidecar entry in
 * capabilities/default.json, and the `.sidecar()` call in osm_sidecar.rs. */
const BIN = "ink-city-osm-cli";

function parseFlags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of args) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** The current machine's Rust target triple — matches what a bare `tauri
 * dev`/`tauri build` (no --target) builds for, so the sidecar we produce here
 * is the one Tauri will actually look for. */
function hostTriple(): string {
  try {
    return execFileSync("rustc", ["--print", "host-tuple"], { encoding: "utf8" }).trim();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(
        "\n[build-sidecar] `rustc` not found. Install Rust (see docs/detail.md's " +
          "prerequisites) and re-run.",
      );
      process.exit(1);
    }
    throw e;
  }
}

/** `bun build --compile` scatters temp files named `.<hash>-00000000.bun-build`
 * into its cwd and only removes them on a clean exit — an interrupted or failed
 * compile leaves them behind, and they pile up in the repo root forever (they're
 * gitignored, so nothing ever complains). Sweep them ourselves, before and
 * after, so a crashed run cleans up on the next one too. */
function sweepBunBuildTemps(dir: string) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".") && name.endsWith(".bun-build")) {
      rmSync(join(dir, name), { force: true, recursive: true });
    }
  }
}

function main() {
  const flags = parseFlags(process.argv.slice(2));
  const triple = flags.triple ?? hostTriple();
  const bunTarget = flags["bun-target"]; // omit to let bun default to the host

  mkdirSync(OUT_DIR, { recursive: true });
  const exe = triple.includes("windows") ? ".exe" : "";
  const outfile = join(OUT_DIR, `${BIN}-${triple}${exe}`);

  const args = ["build", "--compile"];
  if (bunTarget) args.push(`--target=${bunTarget}`);
  args.push(join(ROOT, "scripts", "osm-cli.ts"), "--outfile", outfile);

  console.log(`[build-sidecar] bun ${args.join(" ")}`);
  sweepBunBuildTemps(ROOT);
  try {
    execFileSync("bun", args, { stdio: "inherit", cwd: ROOT });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(
        "\n[build-sidecar] `bun` not found. It's required to compile the osm-cli sidecar " +
          "(see docs/detail.md's prerequisites) — install it from https://bun.sh and re-run.",
      );
      process.exit(1);
    }
    throw e;
  } finally {
    sweepBunBuildTemps(ROOT);
  }
  console.log(`[build-sidecar] wrote ${outfile}`);
}

main();
