/**
 * Hand `data` to the share sheet where there is one — with `touchOnly`, only on a
 * touch screen, where it's worth using — and `copy` to the clipboard otherwise.
 * `"copied"` when it went to the clipboard — the page says so — `"shared"` or
 * `"none"` (dismissed, or nothing worked) otherwise.
 */
export async function shareOrCopy(
  data: ShareData,
  copy: string,
  { touchOnly = false } = {},
): Promise<"shared" | "copied" | "none"> {
  if (navigator.share && (!touchOnly || matchMedia("(pointer: coarse)").matches)) {
    try {
      await navigator.share(data);
      return "shared";
    } catch (e) {
      // Dismissing the sheet is a choice, not a failure; anything else falls through to copying.
      if (e instanceof DOMException && e.name === "AbortError") return "none";
    }
  }
  try {
    await navigator.clipboard.writeText(copy);
    return "copied";
  } catch {
    return "none";
  }
}
