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

## Alternative: force a real release

If the fix genuinely belongs in a release anyway, you don't need any of the
above — make it a `fix:` commit (or add a `fix:`/`feat:` alongside), let
release-please cut the PR, and merge it. That tags a new version and triggers
release.yml normally.
