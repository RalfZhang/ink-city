import type { DesktopPlatform } from "@inkcity/core";

/**
 * Who's visiting, as far as the download section cares: a desktop platform whose
 * installer to lead with, a phone or tablet (nothing to install — offer to send
 * the page to a computer), or a desktop we can't place (all three, side by side).
 */
export type Visitor = DesktopPlatform | "mobile" | "unknown";

export type NavigatorLike = {
  userAgent: string;
  maxTouchPoints?: number;
  userAgentData?: { platform?: string; mobile?: boolean };
};

/**
 * Client Hints first (Chromium: `userAgentData.platform` is "macOS", "Windows",
 * "Linux", "Android", "iOS", "Chrome OS"…), the user-agent string where there are
 * none (Safari, Firefox). iPadOS asks for desktop sites with a Mac's user agent;
 * only its touchscreen gives it away, so a "Mac" with touch points is a tablet.
 * ChromeOS is left unplaced rather than called Linux: its Linux support is opt-in.
 */
export function detectVisitor(nav: NavigatorLike): Visitor {
  const hints = nav.userAgentData;
  if (hints?.mobile) return "mobile";
  switch (hints?.platform?.toLowerCase()) {
    case "macos":
      return "macos";
    case "windows":
      return "windows";
    case "linux":
      return "linux";
    case "android":
    case "ios":
      return "mobile";
    case "chrome os":
    case "chromeos":
    case "chromium os":
      return "unknown";
  }
  const ua = nav.userAgent;
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return "mobile";
  if (/Macintosh|Mac OS X/.test(ua)) return (nav.maxTouchPoints ?? 0) > 1 ? "mobile" : "macos";
  if (/Windows/.test(ua)) return "windows";
  if (/CrOS/.test(ua)) return "unknown";
  if (/Linux|X11/.test(ua)) return "linux";
  return "unknown";
}
