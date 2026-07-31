## How the daily city is chosen

A GitHub Action draws each day's city at random from `src/data/cities-*.json` (~1055 cities) under no-repeat cooldowns — no city within 30 days, no country within 5 — and **persists the result** to `osm-v2/city-list.json` on the `data` branch. The client reads that, so the pick is not a formula it can recompute; the tradeoff is that a stored schedule can be steered by hand, which a seeded one can't. [random-city-strategy.md](random-city-strategy.md) is the full account, including the hand-edit workflow and the four-rung client fallback.

**The population rotation is now only the last-resort fallback**, reached when no host serves either schedule file:

```
index = (days_since_2023-03-03 * 379) % N
```

`379` is prime, which makes the mapping a *permutation* of `0..N-1`: the sequence feels random and never repeats within a full `N`-day cycle, yet `cities.json` can stay population-sorted and append-only. The formula is ported in both `src-tauri/src/city.rs` and `src/core/city.ts` and the two must stay equivalent. The website still computes it directly and so will name the rotation city until it reads the manifests too.

## Architecture

```
src/core/           Portable, dependency-free logic (city pick, bbox math, the
                    daily schedule, canvas rendering incl. the Mondrian variant)
                    shared by the desktop renderer, osm-cli, and a future website.
src/core/osm/       Overpass transport + per-layer extraction (roads, water,
                    airports, railways, aerialways). Node/Bun only — never
                    bundled into the client; see src/core/index.ts.
src/                React + TypeScript settings UI (Vite).
src/renderer/       Hidden WebView that draws the map to a canvas → PNG.
src-tauri/          Rust backend: scheduler, pipeline, wallpaper setting, tray,
                    config, CDN fetch, and the osm-cli sidecar invocation. See
                    the module map at the top of src-tauri/src/lib.rs.
scripts/            osm-cli (the OSM acquisition CLI — CI's batch precache mode
                    and the app's live single-fetch sidecar mode), build-sidecar,
                    build-cities, render, and the check-i18n / *-test guards.
.github/workflows/  precache (OSM data → `data` branch, every 6h) and the
                    release-please → release signing pipeline.
```

**Data flow:** resolve today's city *and* its map data together (local day cache → schedule manifest → schedule state + live Overpass → rotation fallback) → compute a screen-sized bbox → a hidden WebView renders it to a PNG → the PNG is set as the wallpaper (cover-fit). OSM and PNG artifacts are cached for `KEEP_DAYS` (7) so re-rendering after a theme change needs no network.

**Map variants:** `Style.variant` picks the visual language the same geometry is drawn in — `ink` (the default map, in the theme's colors) or `mondrian` (issue #18). The Mondrian variant is not a separate pipeline: `core/render.ts` runs the one compositing order with the palette forced to its paper/ink pair and one extra step that fills a deterministic subset of the enclosed city blocks (`core/mondrian.ts`) just before the roads are stroked over them. Which blocks exist is derived from the road classes the active preset actually strokes, so a color plane always has its black borders.

**CDN pre-cache:** a GitHub Action runs `osm-cli precache` every 6 hours, fetching the upcoming days' map data (all five layers), slimming it, and force-pushing it to the `data` branch, which [jsDelivr](https://www.jsdelivr.com/) serves as a CDN. This keeps the app fast and reachable on networks where Overpass is slow or blocked (notably mainland China). The desktop app's live fallback (`osm-cli fetch`, run as a bundled sidecar) shares the exact same TypeScript implementation, so a CDN miss never produces data poorer than the CDN's — see `src/core/osm/fetch-city.ts`.

## Build from source

**Prerequisites**

- [Node.js](https://nodejs.org/) 20+
- [Rust](https://www.rust-lang.org/tools/install) (stable)
- Platform toolchain for Tauri — see [Tauri prerequisites](https://tauri.app/start/prerequisites/) (Xcode Command Line Tools on macOS; the WebView2 runtime + MSVC build tools on Windows)
- [Bun](https://bun.sh) — build-time only, to compile the `osm-cli` sidecar. Not needed at app runtime.

**Develop**

```bash
npm install
npm run tauri dev
```

`npm run tauri dev`/`build` always compiles the `osm-cli` sidecar for your machine first (the `pretauri` script runs `npm run build:sidecar`), so a fresh clone works with no separate manual step — just bun installed. Re-run `npm run build:sidecar` yourself only if you want to rebuild it without going through `tauri dev`/`build`.

**Build a release bundle**

```bash
npm run tauri build
```

**Regenerate the city list** (downloads GeoNames `cities1000`, takes the top 1000 by population):

```bash
npm run build:cities
```

**Pre-cache OSM data** (what the GitHub Action runs; writes `data/osm/<id>.json`):

```bash
npm run precache -- data/osm 7
```
