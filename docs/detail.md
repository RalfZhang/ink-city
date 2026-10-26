## How the daily city is chosen

A GitHub Action draws each day's city at random from `packages/core/data/cities-*.json` (~1055 cities) under no-repeat cooldowns — no city within 30 days, no country within 5 — and **persists the result** to `osm-v2/city-list.json` on the `data` branch. The client reads that, so the pick is not a formula it can recompute; the tradeoff is that a stored schedule can be steered by hand, which a seeded one can't. [random-city-strategy.md](random-city-strategy.md) is the full account, including the hand-edit workflow and the three-rung client ladder.

**The population rotation is gone from the client.** It was the last-resort fallback during the migration — reached when no host served either schedule file — and picked a city with:

```
index = (days_since_2023-03-03 * 379) % N
```

`379` is prime, which makes the mapping a *permutation* of `0..N-1`: the sequence feels random and never repeats within a full `N`-day cycle, yet `cities.json` can stay population-sorted and append-only. The Rust port is deleted; `packages/core/src/city.ts` keeps the formula for the CI pre-cacher, which still publishes the id-keyed `osm/<id>.json` payloads for clients shipped before the removal (recommended removal after 2026-11-01). A day the schedule can't name is now simply not painted: the previous wallpaper stays up, the City tab says why, and the 60s poll retries. The formula is not a source of truth for any client any more — the future website will read the manifests rather than recompute it, since a random stored pick has no formula to recompute.

## Architecture

```
apps/desktop/       The desktop app (`@inkcity/desktop`):
  src/              React + TypeScript settings UI (Vite).
  src/renderer/     Hidden WebView that draws the map to a canvas → PNG.
  src-tauri/        Rust backend: scheduler, pipeline, wallpaper setting, tray,
                    config, CDN fetch, and the osm-cli sidecar invocation. See
                    the module map at the top of src-tauri/src/lib.rs. The
                    per-OS modules are wallpaper_linux, tray_linux (Linux) and
                    tray_theme (Windows).
packages/core/      `@inkcity/core` — portable, dependency-free logic (city pick,
                    bbox math, the daily schedule, the guess-the-country game,
                    canvas rendering incl. the Mondrian variant) and the city
                    data, shared by the desktop renderer, osm-cli, and a future
                    website.
packages/osm/       `@inkcity/osm` — Overpass transport + per-layer extraction
                    (roads, water, airports, railways, aerialways). Node/Bun
                    only; a package of its own so it never reaches a client
                    bundle.
packages/ui/        `@inkcity/ui` — shadcn components, the theme stylesheet, and
                    the guess-the-country game's React layer and strings. All
                    three packages are imported as TypeScript source with no
                    build step.
scripts/            osm-cli (the OSM acquisition CLI — CI's batch precache mode
                    and the app's live single-fetch sidecar mode), build-sidecar,
                    build-cities, render, and the check-i18n / *-test guards.
.github/workflows/  ci (build + every test, cargo test on all three OSes, on each
                    pushed branch), precache (OSM data → `data` branch, every 6h)
                    and the release-please → release signing pipeline.
```

**Data flow:** resolve today's city *and* its map data together (local day cache → schedule manifest → schedule state + live Overpass → rotation fallback) → compute a screen-sized bbox → a hidden WebView renders it to a PNG → the PNG is set as the wallpaper (cover-fit). Every apply renders afresh — the PNG is just `<date>.png`, rewritten each time and never reused — while the day's OSM payload stays cached, so re-rendering after a theme change, a style edit or a relaunch needs no network.

**Map variants:** `Style.variant` picks the visual language the same geometry is drawn in — `ink` (the default map, in the theme's colors) or `mondrian` (issue #18). The Mondrian variant is not a separate pipeline: `core/render.ts` runs the one compositing order with the palette forced to its paper/ink pair and one extra step that fills a deterministic subset of the enclosed city blocks (`core/mondrian.ts`) just before the roads are stroked over them. Which blocks exist is derived from the road classes the active preset actually strokes, so a color plane always has its black borders. Mondrian has a palette per theme, picked by `Style.theme` (the desktop sends its effective theme); both pick the same blocks, so a theme switch recolors the poster rather than reshuffling it — except that the dark one leaves its rare ink-colored blocks bare, since its gray ink would read as water.

**CDN pre-cache:** a GitHub Action runs `osm-cli precache` every 6 hours, fetching the upcoming days' map data (all five layers), slimming it, and force-pushing it to the `data` branch, which [jsDelivr](https://www.jsdelivr.com/) serves as a CDN. This keeps the app fast and reachable on networks where Overpass is slow or blocked (notably mainland China). The desktop app's live fallback (`osm-cli fetch`, run as a bundled sidecar) shares the exact same TypeScript implementation, so a CDN miss never produces data poorer than the CDN's — see `packages/osm/src/fetch-city.ts`.

## Build from source

**Prerequisites**

- [Node.js](https://nodejs.org/) 20+
- [pnpm](https://pnpm.io/installation) — the project's package manager, pinned by `packageManager` in `package.json`. Use it rather than npm: the lockfile is `pnpm-lock.yaml` and CI installs with `pnpm install --frozen-lockfile`.
- [Rust](https://www.rust-lang.org/tools/install) (stable)
- Platform toolchain for Tauri — see [Tauri prerequisites](https://tauri.app/start/prerequisites/) (Xcode Command Line Tools on macOS; the WebView2 runtime + MSVC build tools on Windows; on Debian/Ubuntu, `libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf libxdo-dev xdg-utils libgtk-3-dev build-essential` — the same set [release.yml](../.github/workflows/release.yml) installs)
- [Bun](https://bun.sh) — build-time only, to compile the `osm-cli` sidecar. Not needed at app runtime.

**Develop**

```bash
pnpm install
pnpm tauri dev
```

`pnpm tauri dev`/`build` always compiles the sidecar (`ink-city-osm-cli`, built from `scripts/osm-cli.ts`) for your machine first (the `pretauri` script runs `build:sidecar`), so a fresh clone works with no separate manual step — just bun installed. Re-run `pnpm build:sidecar` yourself only if you want to rebuild it without going through `tauri dev`/`build`.

**Testing across days.** A dev build reads `INKCITY_DAY_OFFSET` and treats today as that many days away — `INKCITY_DAY_OFFSET=1 pnpm tauri dev` is tomorrow, for everything that keys off the date: the schedule, the caches, the City tab and the guess-the-country game (rollover, streaks, the game resuming after "Daily guess" is turned back on). The CDN publishes about a week ahead, so 0–6 resolve to scheduled cities. Release builds compile it out. Within a day, Dev Mode can reset today's game, clear all game data, or show `guess.json` for editing by hand.

**Build a release bundle**

```bash
pnpm tauri build
```

**Regenerate the city list** (downloads GeoNames `cities1000`, takes the top 1000 by population):

```bash
pnpm build:cities
```

**Pre-cache OSM data** (what the GitHub Action runs; writes `data/osm/<id>.json`):

```bash
pnpm precache data/osm 7
```

Script arguments are passed directly, with no `--` separator. pnpm forwards `--` through to the script rather than stripping it (npm strips it), so both `osm-cli.ts` and `render.ts` drop a bare `--` from their argv — `pnpm precache -- data/osm 7` works too, it just isn't the idiomatic form.

## Reclaiming disk space

Local development leaks caches in three places, none of them tracked:

| What | Why it grows | Mitigation |
| --- | --- | --- |
| `.<hash>-00000000.bun-build` in the repo root | `bun build --compile` temp files, only cleaned up on a clean exit — an interrupted `pnpm build:sidecar` leaves them behind | `build-sidecar.ts` now sweeps them before *and* after every compile, so they no longer accumulate |
| `apps/desktop/src-tauri/target` (was multi-GB) | cargo debug artifacts | `[profile.dev]` in `apps/desktop/src-tauri/Cargo.toml` drops dependency debuginfo and keeps only line tables for our own code (~3-4x smaller); `pnpm run clean --rust` wipes it |
| `.git` | the CI-owned `data` branch — see below | `pnpm run clean --git`, plus the config below to stop fetching it |

`run` is required: pnpm 11 has a built-in `pnpm clean` that rejects these flags before it hands over to the script.

```bash
pnpm run clean            # bun temps, dist/, test-out/ — safe and instant
pnpm run clean --rust     # also cargo clean (next `tauri dev` recompiles from scratch)
pnpm run clean --git      # also expire the origin/data reflog + git gc --prune=now
pnpm run clean --all
```

### Why `.git` grows, and why plain `git gc` doesn't shrink it

This repo's actual source history is **~9 MB** — `main`, `dev` and every tag
combined. Everything above that is the `data` branch:

- `precache.yml` republishes it as a **single orphan commit** every 6 hours and
  force-pushes. Consecutive tips therefore share *no* history, so every tip you
  fetch is a complete fresh ~130 MB tree of OSM JSON (~31 MB packed).
- Deleting the branch or moving the ref frees nothing. `refs/remotes/origin/data`
  keeps **its own reflog, one entry per fetch**, and each entry pins that
  fetch's entire tree. `git gc` counts reflog entries as reachable, so even
  `--prune=now` leaves them all on disk until `gc.reflogExpireUnreachable`
  (30 days) — and every fetch in the meantime adds another snapshot.

That's the whole mechanism: 42 fetches had accumulated 42 pinned snapshots,
≈190 MB that no amount of `git gc` would touch. `pnpm run clean --git` expires that
one reflog before packing, which is why it can reclaim what a bare gc can't.
It only ever discards `origin/data` history — CI output that lives on the remote
and reaches the app over jsDelivr, never local work.

A dev clone never reads that branch locally — the app gets it from jsDelivr, and
the precache workflow clones it separately into `data-out/`. So the durable fix
is to stop fetching it, which **`pnpm install` now does for you**: the `prepare`
script runs `pnpm run clean --setup-git`, which is idempotent and does four things:

| | |
| --- | --- |
| `git config --add remote.origin.fetch '^refs/heads/data'` | a *negative* refspec — excludes the branch from every `git fetch` / `git pull` / `git fetch --all` while leaving `+refs/heads/*:refs/remotes/origin/*` in place for everything else |
| `git config gc.'refs/remotes/origin/data'.reflogExpire now` | drop that reflog on gc instead of holding it 90 days |
| `git config gc.'…'.reflogExpireUnreachable now` | same for entries whose commits are already unreachable — normally 30 days. These two are the safety net for an explicit `git fetch origin data`, which *overrides* a negative refspec |
| `git reflog expire … && git update-ref -d refs/remotes/origin/data && git gc --prune=now` | drop the snapshot(s) already on disk. Deleting the ref removes its reflog too |

Set `INKCITY_SKIP_GIT_SETUP=1` to opt out; it is also skipped under `CI`. To undo,
`git config --unset` those four keys and fetch normally.

Note that no amount of git config prevents the **initial** clone from pulling
`data` down once: `git clone`'s first fetch ignores negative refspecs (verified
with both `init.templateDir` and `includeIf "hasconfig:remote.*.url:…"`, which do
apply the config — the clone just doesn't honour it). That one ~31 MB tip is what
the first `pnpm install` throws away. To avoid even that, clone narrowly:

```bash
git clone --single-branch -b main <url>   # then `git remote set-branches --add origin dev`
```
