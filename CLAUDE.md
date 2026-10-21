# InkCity

A Tauri (Rust + React/TS) desktop app shipping signed bundles for macOS (universal), Windows and Linux (x86_64), and the website that plays the same daily game in a browser.

## Workspace layout

A pnpm workspace. The desktop app is `apps/desktop` (`@inkcity/desktop`: `src/` is the React UI, `src-tauri/` the Rust side) and the website is `apps/web` (`@inkcity/web`); the code they share with each other and with CI lives in packages, imported as TypeScript source with no build step. The repo root holds the product version (`package.json`, which release-please bumps), the repo-level `scripts/`, and `pnpm dev` / `pnpm build` / `pnpm tauri …`, which forward to the desktop app — `pnpm build` also type-checks every package with `tsc -p` and builds the website; `pnpm web <script>` runs one of the website's (`pnpm web dev`). A dependency more than one package uses is versioned once, in `pnpm-workspace.yaml`'s `catalog:`, and listed as `catalog:` — above all React and i18next, which `@inkcity/ui` must share with whichever app hosts it.

- `@inkcity/core` (`packages/core`) — portable logic: rendering, bbox, the schedule, the guess-the-country rules, the data CDN's URL ladder (`mirrorUrls`) and the installers' download links, plus `data/` (the city pools, and `countries.json`, exported as `@inkcity/core/countries.json`) and the two JSON files the desktop's Rust compiles in: `src/defaults.json` (the default colors and style, and the map's 20 km span) and `src/cdn.json` (the data CDN's hosts, and the schedule's paths on `data`).
- `@inkcity/osm` (`packages/osm`) — Overpass fetch and layer extraction. Kept out of the apps' bundles (it pulls in `polygon-clipping`): it runs in the precache and the sidecar, and on the web only in the website's map worker, which imports it lazily for the last rung of its fetch ladder. `scripts/osm-cli.ts` is its entry point and stays in `scripts/`.
- `@inkcity/ui` (`packages/ui`) — the shadcn components (`@inkcity/ui/components/*`), `cn`, the theme stylesheet (`@inkcity/ui/globals.css`) and the game's React layer (`@inkcity/ui/guess`). Its strings are the `ui` i18next namespace in `packages/ui/src/i18n`, held to the same parity check as the apps'; next to them is the table of shipped locales both apps build their i18n from (`@inkcity/ui/i18n/locales`), so adding a language is a line there plus a JSON in each catalog; wording only a host can give comes in as a prop (GuessCountry's `paintingLine`). Desktop-only settings UI — `SettingRow`, the "Daily guess" switch — stays in `apps/desktop/src/`.

Anything Rust and TypeScript both need is written once. A value lives in a JSON file under `packages/core` that Rust `include_str!`s and TS imports, never restated in the other language; a formula ported to both is pinned by a fixture in `scripts/fixtures/` that a `pnpm *-test` script and `cargo test` both run (today: the guess game's reveal rule, and `bboxForScreen`).

Inside a package, files import each other relatively; packages never use the app's `@/` alias (CI rejects it). `shadcn add` (run in `apps/desktop`, or with `-c packages/ui`) writes into `packages/ui/src/components/` — switch its `cn` import to `../lib/utils` like the rest.

## Data

City pins live in `packages/core/data/` (three schema-identical pools), next to `countries.json`, the guess-the-country game's answer table. The daily schedule draws from `cities-famous.json` + `cities-countries.json`, and the app compiles the same two in as its Customized-mode search index; `cities.json` only feeds the legacy CI rotation until it is removed after 2026-11-01. For the pools' relationship, the `localName` language/script rules, how countries.json's reference points were chosen, and how to regenerate them, see [packages/core/data/README.md](packages/core/data/README.md).

## Guess-the-country game

The daily game is written once in `packages/core/src/guess` (rules, save format, stats, country lookup), its React layer once in `@inkcity/ui/guess`, and the website runs both verbatim; hosts differ only in storage — the desktop keeps the save in `app_data_dir/guess.json` through `apps/desktop/src-tauri/src/guess_store.rs`, the website in `localStorage` (core's `localStorageGuessStorage`, falling back to memory when the browser won't store it — `apps/web/src/lib/storage.ts`). The backend reads just enough of the save (`is_revealed`) to decide the wallpaper's city caption; that one mirrored rule is pinned by `scripts/fixtures/guess-reveal-cases.json`, which both `pnpm guess-test` and `cargo test` run. To test by hand: Dev Mode resets today's game, clears all game data, or shows `guess.json` for editing; `INKCITY_DAY_OFFSET=<n> pnpm tauri dev` (debug builds only) shifts the app's "today" for anything that spans days.

## Files clients fetch at runtime

Installed apps and the website re-read some repo files over jsDelivr at fixed paths, so each such path is a contract with every version already shipped. **Serve them from the `data` branch, never from `main`.** Keep the source anywhere on `main` and have [precache.yml](.github/workflows/precache.yml) copy it from `origin/main` into `data` on every run, as its "Publish client files from main" step does for `client/update-mirrors.json`. That way `main`'s layout stays free to change. Don't hand-edit `data`: every run clones it, rewrites the paths CI owns, and force-pushes the whole tree back as a fresh single commit — so a hand edit to one of those paths is lost on the next run, and any other file carries over and stays served indefinitely. A `data` path that any release has read is frozen — add new ones, but rename or remove one only with a dated deprecation, as with the legacy `osm/` flow.

What `data` serves today: `osm-v2/data/<date>.json[.gz]` and `osm-v2/city-list.json` (the schedule), `client/update-mirrors.json` (updater relays), and `osm/<id>.json[.gz]` (legacy, until 2026-11-01). Two `main` paths predate the rule. Shipped versions read them, but degrade gracefully when either is missing — the client keeps its cached or compiled-in copy — so moving one only stops those versions' refreshes. Both have moved since: `src/data/cities.json` (v0.2.0–v0.13.0, their Customized search index) and `src-tauri/update-mirrors.json` (v0.12.2–v0.13.0, the updater relays; it went with the desktop app to `apps/desktop`).

## Website

`apps/web` plays the daily game over a full-page copy of the day's map — the wallpaper's renderer, crop and defaults, drawn in a worker on an OffscreenCanvas — with the game in a panel beside it and the save in `localStorage`. It fetches the day the way the desktop does (`pipeline::resolve_daily`): this browser's Cache Storage copy, then `osm-v2/data/<date>.json[.gz]` from every host in `packages/core/src/cdn.json` (the same ladder as `mirror_urls`, pinned by `scripts/fixtures/mirror-urls.json`), then the day rebuilt from `city-list.json` and Overpass; never another city in its place. See `apps/web/src/map/load.ts`. `pnpm web dev` serves it on port 5174; `pnpm web-test` covers everything that runs without a browser.

It deploys on its own, outside the release flow below: a Cloudflare Workers project with static assets only (as ralfz.com is), built from the repo root on pushes to `main` — the build and deploy commands are in [apps/web/wrangler.jsonc](apps/web/wrangler.jsonc) — while release-please's `exclude-paths` keeps `apps/web` out of the desktop's version. That exclusion only skips a commit whose files are *all* under `apps/web`, so commit website changes on their own: one that also touches `packages/*` or `pnpm-lock.yaml` bumps the desktop (check with `npx release-please release-pr --dry-run`).

## Contribution flow

Never commit directly to `main`. For any change:

1. Branch off `main` with a descriptive name (e.g. `feat/water-labels`, `ci/release-draft-then-publish`).
2. Commit using **Conventional Commits** — this drives automated versioning:
   - `feat:` → minor bump, `fix:` → patch bump, `feat!:` / `BREAKING CHANGE:` → major bump.
   - Other types (`chore:`, `ci:`, `docs:`, `refactor:`) don't trigger a release on their own.
3. Push the branch and wait for [CI](.github/workflows/ci.yml) to pass: `pnpm build`, every TS test script, and `cargo test` on all three OSes.
4. **Fast-forward merge** the branch into `main` (keep history linear).

The push to `main` triggers the release pipeline below.

## Release flow (automated)

Driven by [release-please](.github/workflows/release-please.yml) + [release.yml](.github/workflows/release.yml):

1. Push to `main` → `release-please` scans Conventional Commits and creates/updates a **"release PR"** that bumps the version in `package.json` + `apps/desktop/src-tauri/tauri.conf.json` and updates `CHANGELOG.md`. **No release is created yet.**
2. Merge the release PR → release-please cuts the GitHub Release as a **draft** (`draft: true` in [release-please-config.json](release-please-config.json)), keeping it out of `releases/latest` until assets are uploaded. A draft release has **no git tag** (GitHub only creates the ref on publish), so the config also sets **`force-tag-creation: true`**, which makes release-please create the `vX.Y.Z` tag immediately — with `RELEASE_PLEASE_TOKEN` (a PAT), and crucially *within the same run, before it computes the next release PR*. That tag both triggers `release.yml` and anchors the next run's changelog. Without it (plain `draft: true`), release-please cuts the release but can't tag it, then loses its anchor in the very same run and re-collects the whole history into a bogus release PR.
3. The `vX.Y.Z` tag triggers `release.yml` → builds + signs the macOS/Windows/Linux bundles, uploads them plus the signed updater manifest `latest.json` to the draft release.
4. After **all** platform builds succeed, the `publish` job flips the release to public + `latest`.

To check a change to the build itself without releasing, run the Release workflow by hand from the pushed branch with its `tag` input left empty: it builds and signs all three platforms and uploads nothing (see [docs/ci-release-troubleshooting.md](docs/ci-release-troubleshooting.md)).

### Why draft-then-publish

The in-app updater endpoint is `releases/latest/download/latest.json`. If the release went public before `latest.json` was uploaded, `releases/latest` would point at an assetless release and "check for updates" would 404 during the build window. Keeping the release a draft until all assets are uploaded means the updater keeps resolving to the previous complete release, and the switch to `latest` is atomic.

### Cross-platform

InkCity ships on macOS, Windows **and** Linux — reason about all three when making changes, not after the fact.

Linux is the one that breaks quietly, because several things the other two treat as platform guarantees are optional there:

- **Setting the wallpaper** is per-desktop, not an API. [wallpaper_linux.rs](apps/desktop/src-tauri/src/wallpaper_linux.rs) dispatches on `XDG_CURRENT_DESKTOP`; GNOME / KDE Plasma / XFCE are the supported set, the rest is best-effort. The `wallpaper` crate is deliberately not used here — see that module's header.
- **The tray is optional.** GNOME 45+ has no `StatusNotifierItem` host without a user-installed extension, and publishing the icon still *succeeds* — so an app whose only surface is the tray becomes unreachable. [tray_linux.rs](apps/desktop/src-tauri/src/tray_linux.rs) probes for a host and `lib.rs` surfaces the settings window instead. `TrayIconEvent` is never emitted and tooltips are unsupported, so anything routed through those is macOS/Windows-only by nature.
- **There is no primary monitor** on Wayland. Anything reaching for one needs the fallback chain in `pipeline::screen_geometry`.
- **There is no work area** on Wayland either: `Monitor::work_area()` returns the whole screen, so the desktop city caption's safe area (`pipeline::label_insets`) gets no menu-bar/dock insets there and relies on the renderer's base margin alone.
- **There is no vibrancy**, so the transparent window in `tauri.conf.json` has nothing behind it — `index.css` paints an opaque background off the `data-os` attribute set in `index.html`.
- **There is no self-update.** Linux ships .deb + .rpm, and Tauri's updater can only replace an AppImage — which we don't ship, because linuxdeploy rpath-patches everything in the AppDir's `usr/bin` and that breaks `ldd` on the bun-compiled `ink-city-osm-cli` sidecar (see the long comment in [release.yml](.github/workflows/release.yml)). `updates::supported()` is the gate: it probes `$APPIMAGE`, so it stays correct if an AppImage is ever added, and the About tab hides its whole update section when it's false rather than offering a check that can't work.
- **`bundle.icon` must contain no missing paths.** [tauri.linux.conf.json](apps/desktop/src-tauri/tauri.linux.conf.json) exists only to narrow that list to the PNGs: Tauri deep-merges `tauri.<platform>.conf.json` over the base config, and the Linux bundler *errors* on an icon path that isn't there, where the Windows one just skips it. The base list names `icons/Assets.car`, which only exists after the macOS-only `pnpm icon:car` — so without the override, every Linux build fails at bundling with the binary already compiled.
