# InkCity

A Tauri (Rust + React/TS) desktop app shipping signed bundles for macOS (universal), Windows and Linux (x86_64).

## Data

City pins live in `src/data/` (three schema-identical pools), next to `countries.json`, the guess-the-country game's answer table. The daily schedule draws from `cities-famous.json` + `cities-countries.json`, and the app compiles the same two in as its Customized-mode search index; `cities.json` only feeds the legacy CI rotation until it is removed after 2026-11-01. For the pools' relationship, the `localName` language/script rules, how countries.json's reference points were chosen, and how to regenerate them, see [src/data/README.md](src/data/README.md).

## Guess-the-country game

The daily game is written once in `src/core/guess` (rules, save format, stats, country lookup) so the future website can reuse it verbatim; hosts differ only in storage — the desktop keeps the save in `app_data_dir/guess.json` through `src-tauri/src/guess_store.rs`, the website in `localStorage` (`localStorageGuessStorage`). The backend reads just enough of the save (`is_revealed`) to decide the wallpaper's city caption; that one mirrored rule is pinned by `scripts/fixtures/guess-reveal-cases.json`, which both `pnpm guess-test` and `cargo test` run. To test by hand: Dev Mode resets today's game, clears all game data, or shows `guess.json` for editing; `INKCITY_DAY_OFFSET=<n> pnpm tauri dev` (debug builds only) shifts the app's "today" for anything that spans days.

## Files clients fetch at runtime

Installed apps (and, later, the website) re-read some repo files over jsDelivr at fixed paths, so each such path is a contract with every version already shipped. **Serve them from the `data` branch, never from `main`.** Keep the source anywhere on `main` and have [precache.yml](.github/workflows/precache.yml) copy it from `origin/main` into `data` on every run, as its "Publish client files from main" step does for `client/update-mirrors.json`. That way `main`'s layout stays free to change. Don't hand-edit `data`: every run clones it, rewrites the paths CI owns, and force-pushes the whole tree back as a fresh single commit — so a hand edit to one of those paths is lost on the next run, and any other file carries over and stays served indefinitely. A `data` path that any release has read is frozen — add new ones, but rename or remove one only with a dated deprecation, as with the legacy `osm/` flow.

What `data` serves today: `osm-v2/data/<date>.json[.gz]` and `osm-v2/city-list.json` (the schedule), `client/update-mirrors.json` (updater relays), and `osm/<id>.json[.gz]` (legacy, until 2026-11-01). Two `main` paths predate the rule and are still read by shipped versions: `src/data/cities.json` (v0.2.0–v0.13.0, their Customized search index) and `src-tauri/update-mirrors.json` (v0.12.2–v0.13.0). Both degrade gracefully when missing — the client keeps its cached or compiled-in copy — so moving them only stops those versions' refreshes.

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

1. Push to `main` → `release-please` scans Conventional Commits and creates/updates a **"release PR"** that bumps the version in `package.json` + `src-tauri/tauri.conf.json` and updates `CHANGELOG.md`. **No release is created yet.**
2. Merge the release PR → release-please cuts the GitHub Release as a **draft** (`draft: true` in [release-please-config.json](release-please-config.json)), keeping it out of `releases/latest` until assets are uploaded. A draft release has **no git tag** (GitHub only creates the ref on publish), so the config also sets **`force-tag-creation: true`**, which makes release-please create the `vX.Y.Z` tag immediately — with `RELEASE_PLEASE_TOKEN` (a PAT), and crucially *within the same run, before it computes the next release PR*. That tag both triggers `release.yml` and anchors the next run's changelog. Without it (plain `draft: true`), release-please cuts the release but can't tag it, then loses its anchor in the very same run and re-collects the whole history into a bogus release PR.
3. The `vX.Y.Z` tag triggers `release.yml` → builds + signs the macOS/Windows/Linux bundles, uploads them plus the signed updater manifest `latest.json` to the draft release.
4. After **all** platform builds succeed, the `publish` job flips the release to public + `latest`.

### Why draft-then-publish

The in-app updater endpoint is `releases/latest/download/latest.json`. If the release went public before `latest.json` was uploaded, `releases/latest` would point at an assetless release and "check for updates" would 404 during the build window. Keeping the release a draft until all assets are uploaded means the updater keeps resolving to the previous complete release, and the switch to `latest` is atomic.

### Cross-platform

InkCity ships on macOS, Windows **and** Linux — reason about all three when making changes, not after the fact.

Linux is the one that breaks quietly, because several things the other two treat as platform guarantees are optional there:

- **Setting the wallpaper** is per-desktop, not an API. [wallpaper_linux.rs](src-tauri/src/wallpaper_linux.rs) dispatches on `XDG_CURRENT_DESKTOP`; GNOME / KDE Plasma / XFCE are the supported set, the rest is best-effort. The `wallpaper` crate is deliberately not used here — see that module's header.
- **The tray is optional.** GNOME 45+ has no `StatusNotifierItem` host without a user-installed extension, and publishing the icon still *succeeds* — so an app whose only surface is the tray becomes unreachable. [tray_linux.rs](src-tauri/src/tray_linux.rs) probes for a host and `lib.rs` surfaces the settings window instead. `TrayIconEvent` is never emitted and tooltips are unsupported, so anything routed through those is macOS/Windows-only by nature.
- **There is no primary monitor** on Wayland. Anything reaching for one needs the fallback chain in `pipeline::screen_geometry`.
- **There is no work area** on Wayland either: `Monitor::work_area()` returns the whole screen, so the desktop city caption's safe area (`pipeline::label_insets`) gets no menu-bar/dock insets there and relies on the renderer's base margin alone.
- **There is no vibrancy**, so the transparent window in `tauri.conf.json` has nothing behind it — `index.css` paints an opaque background off the `data-os` attribute set in `index.html`.
- **There is no self-update.** Linux ships .deb + .rpm, and Tauri's updater can only replace an AppImage — which we don't ship, because linuxdeploy rpath-patches everything in the AppDir's `usr/bin` and that breaks `ldd` on the bun-compiled `ink-city-osm-cli` sidecar (see the long comment in [release.yml](.github/workflows/release.yml)). `updates::supported()` is the gate: it probes `$APPIMAGE`, so it stays correct if an AppImage is ever added, and the About tab hides its whole update section when it's false rather than offering a check that can't work.
- **`bundle.icon` must contain no missing paths.** [tauri.linux.conf.json](src-tauri/tauri.linux.conf.json) exists only to narrow that list to the PNGs: Tauri deep-merges `tauri.<platform>.conf.json` over the base config, and the Linux bundler *errors* on an icon path that isn't there, where the Windows one just skips it. The base list names `icons/Assets.car`, which only exists after the macOS-only `pnpm icon:car` — so without the override, every Linux build fails at bundling with the binary already compiled.
