import { GITHUB_REPO } from "./constants";

// The desktop app's installers, as the website offers them. Their names carry no
// version (release.yml's `assetNamePattern`), so `releases/latest/download/<file>`
// always resolves to the newest release — and atomically: the `publish` job only
// flips a release to `latest` once every platform's assets are up. No CDN copy
// exists or is needed (jsDelivr serves git trees, not release assets, and caps a
// file at 20 MB), so the list is static. README's download links name the same
// files.

export const DESKTOP_PLATFORMS = ["macos", "windows", "linux"] as const;
export type DesktopPlatform = (typeof DESKTOP_PLATFORMS)[number];

/** What kind of file a download is — what the website words its label from. */
export type InstallerKind = "dmg" | "exe" | "msi" | "deb" | "rpm";

export type DesktopDownload = { file: string; kind: InstallerKind };

/** Each platform's installers, the one to offer first leading. */
export const DESKTOP_DOWNLOADS: Readonly<Record<DesktopPlatform, readonly DesktopDownload[]>> = {
  macos: [{ file: "InkCity_universal.dmg", kind: "dmg" }],
  windows: [
    { file: "InkCity_x64-setup.exe", kind: "exe" },
    { file: "InkCity_x64.msi", kind: "msi" },
  ],
  // Both: which one a distribution takes isn't something a browser can tell.
  linux: [
    { file: "InkCity_amd64.deb", kind: "deb" },
    { file: "InkCity_x86_64.rpm", kind: "rpm" },
  ],
};

/** The platform's display name — a product name, the same in every language. */
export const DESKTOP_PLATFORM_NAMES: Readonly<Record<DesktopPlatform, string>> = {
  macos: "macOS",
  windows: "Windows",
  linux: "Linux",
};

/** The latest release's copy of `file`, straight from GitHub. */
export function desktopDownloadUrl(file: string): string {
  return `${GITHUB_REPO}/releases/latest/download/${file}`;
}
