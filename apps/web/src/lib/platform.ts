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
  userAgentData?: {
    platform?: string;
    mobile?: boolean;
    getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string }>;
  };
};

// Linux is the one platform shipped for a single architecture (x86_64), so an ARM
// machine running it — a Raspberry Pi, Asahi on a Mac, a Chromebook's Linux — has
// nothing to install, and is left unplaced rather than led to packages it'd refuse.
const ARM_UA = /\b(aarch64|arm64|armv\d+l?)\b/i;
const linux = (ua: string): Visitor => (ARM_UA.test(ua) ? "unknown" : "linux");

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
      return linux(nav.userAgent);
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
  if (/Linux|X11/.test(ua)) return linux(ua);
  return "unknown";
}

/**
 * `visitor` checked against Client Hints' architecture, where it's a Linux one: the
 * user agent can't say ARM there in Chromium, whose reduced UA string reads
 * "Linux x86_64" on every Linux machine (a Raspberry Pi's default browser included).
 * Firefox's still names the real one, which `detectVisitor` reads.
 */
export async function refineVisitor(nav: NavigatorLike, visitor: Visitor): Promise<Visitor> {
  const hints = nav.userAgentData;
  if (visitor !== "linux" || !hints?.getHighEntropyValues) return visitor;
  try {
    const { architecture } = await hints.getHighEntropyValues(["architecture"]);
    return architecture === "arm" ? "unknown" : visitor;
  } catch {
    return visitor;
  }
}
