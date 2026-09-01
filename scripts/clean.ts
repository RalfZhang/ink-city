#!/usr/bin/env -S npx tsx
// Reclaims the disk that local development leaks. Nothing here touches
// tracked files or anything CI needs — every target is a rebuildable cache:
//
//   pnpm clean            the cheap sweep: bun temp files, stale build output
//   pnpm clean --rust     also `cargo clean` (src-tauri/target, multi-GB —
//                         the next `tauri dev` recompiles from scratch, ~minutes)
//   pnpm clean --git      also repack .git and drop unreachable objects
//   pnpm clean --all      all of the above
//   pnpm clean --setup-git   one-shot, idempotent: stop this clone from ever
//                         fetching the `data` branch again (see below). Wired to
//                         the "prepare" script, so `pnpm install` runs it — a
//                         fresh clone is cleaned up without anyone typing
//                         anything. Opt out with INKCITY_SKIP_GIT_SETUP=1.
//
// On .git: this repo's own source history is tiny (~9 MB for main + dev + every
// tag). All the bloat is the CI-owned `data` branch — precache.yml republishes
// it as a *single orphan commit* every 6h and force-pushes, so every tip you
// fetch is a whole fresh ~130 MB tree of OSM JSON sharing no history with the
// last one. Deleting or moving the ref does not free them: the remote-tracking
// ref's own reflog keeps one entry per fetch, each pinning that fetch's entire
// tree, and `git gc --prune=now` treats reflog entries as reachable. Hence 42
// fetches = 42 pinned snapshots = ~190 MB that a plain gc will not touch for
// gc.reflogExpireUnreachable (30 days) at the earliest.
//
// So `--git` expires that one reflog before packing. It only ever drops
// origin/data history, which is CI output that lives on the remote and is
// served to the app over jsDelivr — never local work.
//
// Better still, stop fetching the branch at all (dev clones never read it
// locally). Per-clone, reversible by dropping the config lines:
//   git config --add remote.origin.fetch '^refs/heads/data'
//   git config gc.'refs/remotes/origin/data'.reflogExpire now
//   git config gc.'refs/remotes/origin/data'.reflogExpireUnreachable now
//   git update-ref -d refs/remotes/origin/data && pnpm clean --git
// The negative refspec covers `git fetch` and `git pull`, but *not* an explicit
// `git fetch origin data` — that still overrides it, which is what the two
// gc.* lines are there to mop up. Nor does it help the *initial* clone: `git
// clone`'s first fetch ignores negative refspecs entirely (verified), so a fresh
// clone always pays for one `data` tip no matter how git is configured. That
// single tip is what --setup-git drops on the first `pnpm install`.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const flags = new Set(process.argv.slice(2));
const all = flags.has("--all");
const want = (f: string) => all || flags.has(f);

/** Recursive apparent size. Deliberately not `du -sk` — this script has to run
 * on Windows too, where there is no `du`. */
function dirSize(path: string): number {
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += dirSize(child);
    else if (entry.isFile()) {
      try {
        total += statSync(child).size;
      } catch {
        // raced with a concurrent cargo/rust-analyzer build; skip it
      }
    }
  }
  return total;
}

function sizeOf(path: string): number {
  if (!existsSync(path)) return 0;
  try {
    return dirSize(path);
  } catch {
    return 0;
  }
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(0)} MB`;

/** The remote-tracking reflog for the `data` branch, one entry per fetch, each
 * pinning a full OSM-JSON tree. See the header comment. */
const DATA_REF = "refs/remotes/origin/data";

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

function gitOk(args: string[]): boolean {
  try {
    execFileSync("git", args, { cwd: ROOT, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Idempotent per-clone git config so this working copy never re-accumulates the
 * `data` branch. Run from the "prepare" script, i.e. on every `pnpm install`,
 * which is the first thing a fresh clone does — so nobody has to remember any of
 * it. Everything here is local to this clone and reversible by hand. */
function setupGit(): void {
  if (process.env.INKCITY_SKIP_GIT_SETUP) return;
  // CI checkouts are single-branch, shallow and thrown away; nothing to save,
  // and the precache workflow reads `data` through its own separate clone.
  if (process.env.CI) return;
  // Tarball export, or git not installed — nothing to configure.
  if (!gitOk(["rev-parse", "--git-dir"]) || !gitOk(["remote", "get-url", "origin"])) return;

  const refspecs = git(["config", "--get-all", "remote.origin.fetch"]).split("\n");
  if (!refspecs.includes("^refs/heads/data")) {
    git(["config", "--add", "remote.origin.fetch", "^refs/heads/data"]);
    console.log("[clean] this clone will no longer fetch the `data` branch (CI/CDN-only)");
  }
  // Safety net for an explicit `git fetch origin data`, which overrides the
  // refspec above: let gc drop those snapshots instead of holding them 30 days.
  git(["config", `gc.${DATA_REF}.reflogExpire`, "now"]);
  git(["config", `gc.${DATA_REF}.reflogExpireUnreachable`, "now"]);

  if (!gitOk(["rev-parse", "--verify", "--quiet", DATA_REF])) return;
  const before = sizeOf(join(ROOT, ".git"));
  // Tolerate a missing reflog: a ref created by `git clone` has no reflog yet,
  // and `git reflog expire` treats that as an error. `update-ref -d` drops the
  // reflog along with the ref anyway — expiring first only matters once entries
  // exist (i.e. after a later fetch).
  gitOk(["reflog", "expire", "--expire=now", "--expire-unreachable=now", DATA_REF]);
  git(["update-ref", "-d", DATA_REF]);
  git(["gc", "--prune=now", "--quiet"]);
  const after = sizeOf(join(ROOT, ".git"));
  console.log(`[clean] dropped the fetched \`data\` snapshot: .git ${mb(before)} -> ${mb(after)}`);
}

if (flags.has("--setup-git")) {
  try {
    setupGit();
  } catch (e) {
    // Never fail `pnpm install` over a disk-hygiene nicety.
    console.warn(`[clean] --setup-git skipped: ${(e as Error).message}`);
  }
  process.exit(0);
}

let freed = 0;

/** `bun build --compile` leaves `.<hash>-00000000.bun-build` temp files in the
 * repo root when a compile is interrupted; build-sidecar.ts sweeps them too. */
function sweepBunTemps() {
  let n = 0;
  for (const name of readdirSync(ROOT)) {
    if (!name.startsWith(".") || !name.endsWith(".bun-build")) continue;
    const p = join(ROOT, name);
    freed += statSync(p).size;
    rmSync(p, { force: true, recursive: true });
    n += 1;
  }
  console.log(`[clean] bun temp files: removed ${n}`);
}

function removeDir(rel: string) {
  const p = join(ROOT, rel);
  const size = sizeOf(p);
  if (!size) return;
  rmSync(p, { force: true, recursive: true });
  freed += size;
  console.log(`[clean] ${rel}: freed ${mb(size)}`);
}

sweepBunTemps();
removeDir("dist");
removeDir("test-out");

if (want("--rust")) {
  const target = join(ROOT, "src-tauri", "target");
  const before = sizeOf(target);
  if (before) {
    execFileSync("cargo", ["clean"], { cwd: join(ROOT, "src-tauri"), stdio: "inherit" });
    freed += before - sizeOf(target);
    console.log(`[clean] src-tauri/target: freed ${mb(before)}`);
  }
} else {
  console.log(`[clean] src-tauri/target: ${mb(sizeOf(join(ROOT, "src-tauri", "target")))} (skipped, pass --rust)`);
}

if (want("--git")) {
  const before = sizeOf(join(ROOT, ".git"));
  // Fails when the ref has no reflog yet (fresh clone) — harmless either way.
  if (gitOk(["reflog", "expire", "--expire=now", "--expire-unreachable=now", DATA_REF])) {
    console.log(`[clean] expired the ${DATA_REF} reflog (CI output, re-fetchable)`);
  }
  execFileSync("git", ["gc", "--prune=now"], { cwd: ROOT, stdio: "inherit" });
  const after = sizeOf(join(ROOT, ".git"));
  freed += before - after;
  console.log(`[clean] .git: ${mb(before)} -> ${mb(after)}`);
} else {
  console.log(`[clean] .git: ${mb(sizeOf(join(ROOT, ".git")))} (skipped, pass --git)`);
}

console.log(`[clean] total freed: ${mb(freed)}`);
