## How the daily city is chosen

The city list is sorted by population, but you don't want to wake up to the same five megacities every week. So the day's index is

```
index = (days_since_2023-03-03 * 379) % N
```

`379` is prime, which makes the mapping a *permutation* of `0..N-1`: the sequence feels random and never repeats within a full `N`-day cycle, yet `cities.json` can stay neatly population-sorted and append-only. The exact same formula lives in the Rust client (`src-tauri/src/city.rs`) and the TypeScript core (`src/core/city.ts`), so the desktop app, the CI pre-cache, and the website all agree on today's city.

## Architecture

```
src/core/          Portable, dependency-free logic (city pick, bbox math,
                   Overpass fetch, water/coastline assembly, canvas
                   rendering) shared by the desktop renderer, osm-cli, and a
                   future website.
src/                React + TypeScript settings UI (Vite).
src/renderer/       Hidden WebView that draws the map to a canvas → PNG.
src-tauri/          Rust backend: scheduler, pipeline, wallpaper setting,
                   tray, config, CDN fetch, and the osm-cli sidecar invocation.
scripts/            build-cities (GeoNames → cities.json) and osm-cli (the
                   single OSM acquisition CLI: CI's batch precache mode and
                   the desktop app's live single-fetch sidecar mode).
.github/workflows/  Daily OSM pre-cache published to the `data` branch.
```

**Data flow:** scheduler picks today's city → computes a screen-sized bbox → fetches road + water data (local cache → jsDelivr CDN → the `osm-cli` sidecar, run live) → a hidden WebView renders it to a PNG → the PNG is set as the wallpaper (cover-fit). OSM and PNG artifacts are cached for 7 days so re-rendering after a theme change needs no network.

**CDN pre-cache:** a daily GitHub Action runs `osm-cli precache`, which fetches the upcoming cities' road + water data, slims it, and force-pushes it to the `data` branch, which [jsDelivr](https://www.jsdelivr.com/) serves as a CDN. This keeps the app fast and reachable on networks where Overpass is slow or blocked (notably mainland China). The desktop app's live fallback (`osm-cli fetch`, run as a bundled sidecar) shares the exact same TypeScript implementation, so a CDN miss never produces data poorer than the CDN's — see `src/core/fetch-city.ts`.

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
