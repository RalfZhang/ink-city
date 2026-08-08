# CI / release troubleshooting (issue #30)

## The problem

The signed-build workflow ([release.yml](../.github/workflows/release.yml)) is
triggered by a `vX.Y.Z` **tag**. That tag is created by release-please, and only
when a release PR merges — which only happens for `feat:` / `fix:` commits (see
[CLAUDE.md](../CLAUDE.md)). A `ci:` / `chore:` / `docs:` commit bumps no version,
cuts no release, and creates no tag, so **it never triggers release.yml**.

That's a chicken-and-egg problem when the thing you're fixing *is* release.yml:
the `ci:` commit that fixes it can't exercise it. And a previous failed run may
have left a **bad draft release** behind.

## The fix: re-run the build against an existing tag

`release.yml` now takes a `workflow_dispatch` **`tag` input**. Pushing a tag
still triggers it as before; additionally you can re-run the full signed build
against any existing version tag without cutting a new release:

1. GitHub → **Actions** → **Release** → **Run workflow**.
2. Enter the tag to (re)build, e.g. `v0.6.0` (usually the latest release), and run.

The workflow checks out that tag (not the branch you dispatched from), builds and
signs both platforms, and uploads assets to that tag's release. This is how you
validate a `ci:`-only fix: land the fix on `main`, then dispatch against the last
tag and confirm the run is green.

> Why the input matters: without it, a manual dispatch runs against `main`, so
> `github.ref_name` is `main` and the build would create a bogus `InkCity main`
> release/tag. The `tag` input makes dispatch resolve to a real version tag
> (`inputs.tag || github.ref_name`) for checkout, `tagName`, `releaseName`, and
> the publish step.

## Recovering from a bad draft release

If a run failed partway, the release for that tag may be a **draft** with missing
or stale assets. Because it's a draft it's excluded from `releases/latest`, so
the in-app updater is unaffected (it keeps resolving to the previous complete
release — the whole point of draft-then-publish). To recover:

1. Fix the underlying CI issue and merge it to `main`.
2. Delete the bad draft **and** re-upload cleanly:
   ```sh
   gh release delete v0.6.0 --repo RalfZhang/ink-city --yes   # keep the tag
   ```
   Deleting the release keeps the git tag, so the next step can recreate the
   release for it.
3. Re-run: Actions → Release → Run workflow → `tag = v0.6.0`. The build recreates
   the draft, uploads assets, and — once both platforms succeed — the `publish`
   job flips it to public + `latest`.

Leaving the tag in place is deliberate: it keeps release-please's changelog
anchor intact (see the `force-tag-creation` note in CLAUDE.md), so the next real
release still computes correctly.

## The macOS icon gate

Two macOS-only steps in `release.yml` exist to stop a release shipping the wrong
app icon. macOS 26 draws the icon from a compiled asset catalog
(`Contents/Resources/Assets.car`, named by `CFBundleIconName`) built by `actool`
from [src-tauri/icons/InkCity.icon](../src-tauri/icons/InkCity.icon). `actool`
ships only inside full Xcode 26+; when it's missing or too old the bundler logs a
single line and carries on, and the app falls back to the `.icns` — which macOS 26
renders inside a grey rounded-rect plate. Nothing else fails, so without these
steps a bad icon would sail through signing and publishing.

- **"Select an Xcode whose actool can compile the icon catalog"** runs before the
  build and `xcode-select`s an Xcode whose actool reports `short-bundle-version`
  >= 26. It probes the current selection first and only sweeps `/Applications` if
  that one is too old.
- **"Compile the macOS icon catalog"** runs `pnpm icon:car`
  ([scripts/build-icon-car.sh](../scripts/build-icon-car.sh)), producing the
  gitignored `src-tauri/icons/Assets.car` that `bundle.icon` points at.
- **`--verbose` in the macOS matrix `args`** is load-bearing, not leftover
  debugging. tauri-bundler reports an actool rejection as a bare `failed to
  bundle project: Failed to create app Assets.car: 'failed to run actool'`. It
  *does* capture actool's stdout/stderr — but emits them through `log::debug!`,
  so at the default log level **the actual complaint is discarded**. Without
  `--verbose` a red build tells you nothing about what actool disliked.
- **"Verify the macOS 26 icon was compiled into the bundle"** runs after and
  asserts `Assets.car` exists and `CFBundleIconName` is set.

### Why we compile the catalog ourselves

`bundle.icon` lists `icons/Assets.car`, not `icons/InkCity.icon`, even though the
bundler is perfectly capable of compiling a `.icon`. Its version of that crashes:

```
error: Exception while running actool: *** -[__NSPlaceholderArray
initWithObjects:count:]: attempt to insert nil object from objects[0]
```

That is [tauri-apps/tauri#15315](https://github.com/tauri-apps/tauri/issues/15315)
— open, and reproducible with Tauri's own `examples/api`. The maddening part is
that the *identical* actool command run from a normal shell succeeds; only the
bundler's invocation fails, and it fails every time. `create_assets_car_file`
returns as soon as it finds a `.car` entry in `bundle.icon`, so handing it a
pre-compiled catalog skips the broken code path entirely. Revisit if the issue
closes.

Earlier failure, v0.10.0 (a real defect of ours, separate from the above):
`supported-platforms.squares` in `icon.json` was written as a list of platform
names. It takes the string `"shared"` — only `circles` takes a list
(`["watchOS"]`). Validate against the Icon Composer schema before guessing.

If a step goes red:

1. Read the `actool <major>` lines the selection step prints. If nothing on the
   runner is >= 26, the image changed — that's the whole finding; fix it there
   rather than working around it downstream.
2. For a bundling failure, search the build log for `actool` — with `--verbose`
   the daemon's own diagnostics are in there, above the generic error line.
3. **A red build leaving a draft release behind is expected**, not a second bug.
   The verification step runs after `tauri-action` has uploaded, so the draft
   holds a bad build — but `publish` needs the job, so it never goes public and
   the updater keeps resolving to the previous release. Re-running against the
   same tag overwrites the assets; see *Recovering from a bad draft release*.
4. **A dispatch takes the workflow from one ref and the source from another**, and
   that asymmetry is easy to misread. "Use workflow from" decides which
   `release.yml` *runs*; the `tag` input decides what `Checkout` puts on disk. So
   dispatching from `dev` against `v0.10.1` runs dev's steps over v0.10.1's
   source. A change confined to `release.yml` (a new step, a matrix flag) takes
   effect immediately; a change touching anything else — `scripts/`,
   `package.json`, `tauri.conf.json`, the icon sources — does not, and the run
   will fail on dev's steps referencing files the tag doesn't have. Fixes of that
   shape need a new `fix:` commit and a new version; there is no tag to rehearse
   them against.

`CFBundleIconName` is `Icon`, not `InkCity` — the bundler copies the `.icon`
directory to `Icon.icon` and passes `--app-icon Icon` to `actool`, so the
directory's name is for humans only. Don't "fix" it.

## Alternative: force a real release

If the fix genuinely belongs in a release anyway, you don't need any of the
above — make it a `fix:` commit (or add a `fix:`/`feat:` alongside), let
release-please cut the PR, and merge it. That tags a new version and triggers
release.yml normally.
