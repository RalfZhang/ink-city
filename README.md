<div align="center">
  <img src="docs/logo.png" width="120" height="120" alt="InkCity" />
  <h1>InkCity</h1>
  <p>Your desktop wallpaper, redrawn every day as the road map of a different city.</p>
</div>

---

InkCity is a small cross-platform (macOS + Windows) desktop app. Every day at midnight it picks a city, renders its road network as an ink-on-paper map sized to your screen, and sets it as your wallpaper.

## Features

- **A new city every day** — a deterministic rotation through the world's ~1000 most populous cities.
- **Real road data** — road geometry from OpenStreetMap, rendered to cover-fit your screen without stretching.
- **Themeable maps** — Light / Dark / Follow-system map palettes, each with customizable background and line colors, plus three line-weight presets (Minimal / Standard / Bold).

## Screenshots

<div align="center">
  <img src="docs/settings.png" width="420" alt="InkCity settings" />
  <img src="docs/wallpaper.png" alt="Example wallpaper" />
</div>


## How the daily city is chosen

The city list is sorted by population, but you don't want to wake up to the same five megacities every week. So the day's index is

```
index = (days_since_2023-03-03 * 379) % N
```

`379` is prime, which makes the mapping a *permutation* of `0..N-1`: the sequence feels random and never repeats within a full `N`-day cycle, yet `cities.json` can stay neatly population-sorted and append-only. The exact same formula lives in the Rust client (`src-tauri/src/city.rs`) and the TypeScript core (`src/core/city.ts`), so the desktop app, the CI pre-cache, and the website all agree on today's city.

## Architecture

```
src/core/          Portable, dependency-free logic (city pick, bbox math,
                   Overpass fetch, canvas rendering) shared by the desktop
                   renderer, the CI script, and a future website.
src/                React + TypeScript settings UI (Vite).
src/renderer/       Hidden WebView that draws the map to a canvas → PNG.
src-tauri/          Rust backend: scheduler, pipeline, wallpaper setting,
                   tray, config, CDN + Overpass fetch.
scripts/            build-cities (GeoNames → cities.json) and
                   precache-osm (CI OSM pre-cache).
.github/workflows/  Daily OSM pre-cache published to the `data` branch.
```

**Data flow:** scheduler picks today's city → computes a screen-sized bbox → fetches road data (local cache → jsDelivr CDN → Overpass mirrors) → a hidden WebView renders it to a PNG → the PNG is set as the wallpaper (cover-fit). OSM and PNG artifacts are cached for 7 days so re-rendering after a theme change needs no network.

**CDN pre-cache:** a daily GitHub Action fetches the upcoming cities' road data, slims it, and force-pushes it to the `data` branch, which [jsDelivr](https://www.jsdelivr.com/) serves as a CDN. This keeps the app fast and reachable on networks where Overpass is slow or blocked (notably mainland China).

## Build from source

**Prerequisites**

- [Node.js](https://nodejs.org/) 20+
- [Rust](https://www.rust-lang.org/tools/install) (stable)
- Platform toolchain for Tauri — see [Tauri prerequisites](https://tauri.app/start/prerequisites/) (Xcode Command Line Tools on macOS; the WebView2 runtime + MSVC build tools on Windows)

**Develop**

```bash
npm install
npm run tauri dev
```

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

## Releasing

Bump the version in `package.json` and `src-tauri/tauri.conf.json`, then push a
matching tag:

```bash
git tag v0.2.0 && git push origin v0.2.0
```

The [release workflow](.github/workflows/release.yml) builds signed bundles for
macOS (universal) and Windows, publishes a **draft** GitHub Release (review, then
hit Publish), and generates the signed `latest.json` the in-app updater reads.
Code signing / notarization setup is documented in [docs/SIGNING.md](docs/SIGNING.md).

## Data sources & licenses

- Road map data © **OpenStreetMap** contributors, licensed under the [Open Database License (ODbL)](https://opendatacommons.org/licenses/odbl/).
- City list from [**GeoNames**](https://www.geonames.org/), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

These attributions are also shown in the app's **About** tab.

## Feedback

Found a bug or have an idea? [Open an issue](https://github.com/RalfZhang/ink-city/issues). For bug reports, please include your OS version and, if relevant, the city/date that triggered the problem.

## License

InkCity's own source code is released under the [MIT License](LICENSE). The data it displays is licensed separately, as described above.
