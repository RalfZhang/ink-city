#!/usr/bin/env bash
#
# Compile src-tauri/icons/InkCity.icon into src-tauri/icons/Assets.car.
#
# Why this exists rather than letting the bundler do it: tauri-bundler can compile
# a `.icon` itself, but on macOS 26 that path crashes inside actool —
#
#   error: Exception while running actool: *** -[__NSPlaceholderArray
#   initWithObjects:count:]: attempt to insert nil object from objects[0]
#
# — reproducible with Tauri's own examples/api, tracked upstream as
# tauri-apps/tauri#15315 (open). The same actool command run from a normal shell
# succeeds; only the bundler's invocation fails, consistently. Since
# `create_assets_car_file` short-circuits on the first `.car` entry in
# `bundle.icon` and copies it verbatim, handing it a pre-compiled catalog skips
# the broken path entirely.
#
# Output is gitignored and rebuilt by CI on every release (same arrangement as
# the osm-cli sidecar). On macOS, run this once before a local `tauri build`:
#
#   pnpm icon:car
#
# Not needed on Windows — asset catalogs are macOS-only.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src="$repo_root/src-tauri/icons/InkCity.icon"
dest="$repo_root/src-tauri/icons/Assets.car"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "error: asset catalogs are macOS-only; nothing to do on $(uname -s)" >&2
  exit 1
fi

if [ ! -d "$src" ]; then
  echo "error: $src not found" >&2
  exit 1
fi

# The bundler gates on this exact value, and actool ships only inside full Xcode
# (the /usr/bin/actool shim resolves through the active developer directory).
# `|| true`: without a full Xcode the shim exits non-zero, and under `set -e` +
# pipefail that would kill the script before the diagnostic below ever printed.
version="$(actool --version --output-format=human-readable-text 2>/dev/null \
  | sed -n 's/^[[:space:]]*short-bundle-version:[[:space:]]*\(.*\)$/\1/p' | head -1 || true)"
major="${version%%.*}"
if [ -z "${major:-}" ] || [ "$major" -lt 26 ]; then
  echo "error: need actool >= 26 (found: ${version:-none}). Select a full Xcode 26+:" >&2
  echo "       sudo xcode-select -s /Applications/Xcode.app" >&2
  exit 1
fi

# Two things matter about this staging directory, and both are why the bundler
# fails where we succeed:
#   - the catalog must be named `Icon.icon`, because --app-icon takes the stem;
#   - the path must not contain a hidden component. The bundler stages under
#     tempfile's `.tmpXXXX`, and that is the one visible difference between its
#     invocation and this one.
work="$(mktemp -d -t inkcity-icon)"
trap 'rm -rf "$work"' EXIT
cp -R "$src" "$work/Icon.icon"
mkdir -p "$work/out"

# Mirrors tauri-bundler's own argument list (crates/tauri-bundler/src/bundle/
# macos/icon.rs) so the catalog we hand it is the one it would have built.
actool "$work/Icon.icon" \
  --compile "$work/out" \
  --output-format human-readable-text \
  --notices \
  --warnings \
  --output-partial-info-plist "$work/out/assetcatalog_generated_info.plist" \
  --app-icon Icon \
  --include-all-app-icons \
  --accent-color AccentColor \
  --enable-on-demand-resources NO \
  --development-region en \
  --target-device mac \
  --minimum-deployment-target 26.0 \
  --platform macosx

if [ ! -f "$work/out/Assets.car" ]; then
  echo "error: actool reported success but produced no Assets.car" >&2
  exit 1
fi

# CFBundleIconName is read back out of the catalog by the bundler
# (app_icon_name_from_assets_car), so a catalog without an "Icon Image" entry
# would bundle silently without naming an icon.
if ! assetutil --info "$work/out/Assets.car" | grep -q '"Icon Image"'; then
  echo "error: compiled catalog has no \"Icon Image\" entry; CFBundleIconName would be unset" >&2
  assetutil --info "$work/out/Assets.car" || true
  exit 1
fi

cp "$work/out/Assets.car" "$dest"
echo "wrote $dest (actool $version)"
