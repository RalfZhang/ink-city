# InkCity

A Tauri (Rust + React/TS) desktop app shipping signed bundles for macOS (universal) and Windows.

## Data

City pins live in `src/data/` (three schema-identical pools; only `cities.json` is wired into the app). For the pools' relationship, the `localName` language/script rules, and how to regenerate them, see [src/data/README.md](src/data/README.md).

## Contribution flow

Never commit directly to `main`. For any change:

1. Branch off `main` with a descriptive name (e.g. `feat/water-labels`, `ci/release-draft-then-publish`).
2. Commit using **Conventional Commits** — this drives automated versioning:
   - `feat:` → minor bump, `fix:` → patch bump, `feat!:` / `BREAKING CHANGE:` → major bump.
   - Other types (`chore:`, `ci:`, `docs:`, `refactor:`) don't trigger a release on their own.
3. **Fast-forward merge** the branch into `main` (keep history linear).

The push to `main` triggers the release pipeline below.

## Release flow (automated)

Driven by [release-please](.github/workflows/release-please.yml) + [release.yml](.github/workflows/release.yml):

1. Push to `main` → `release-please` scans Conventional Commits and creates/updates a **"release PR"** that bumps the version in `package.json` + `src-tauri/tauri.conf.json` and updates `CHANGELOG.md`. **No release is created yet.**
2. Merge the release PR → the next `release-please` run tags `vX.Y.Z` and creates the GitHub Release as a **draft** (`draft: true` in [release-please-config.json](release-please-config.json)). The tag is pushed with `RELEASE_PLEASE_TOKEN` (a PAT) so it can trigger downstream workflows.
3. The `vX.Y.Z` tag triggers `release.yml` → builds + signs the macOS/Windows bundles, uploads them plus the signed updater manifest `latest.json` to the draft release.
4. After **both** platform builds succeed, the `publish` job flips the release to public + `latest`.

### Why draft-then-publish

The in-app updater endpoint is `releases/latest/download/latest.json`. If the release went public before `latest.json` was uploaded, `releases/latest` would point at an assetless release and "check for updates" would 404 during the build window. Keeping the release a draft until all assets are uploaded means the updater keeps resolving to the previous complete release, and the switch to `latest` is atomic.

### Cross-platform

InkCity ships on macOS **and** Windows — reason about both OSes when making changes, not after the fact.
