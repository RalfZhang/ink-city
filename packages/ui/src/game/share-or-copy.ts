/**
 * Hand `data` to the share sheet where there is one, and `copy` to the clipboard
 * otherwise. `"copied"` when it went to the clipboard — the page says so —
 * `"shared"` or `"none"` (dismissed, or nothing worked) otherwise.
 */
export async function shareOrCopy(data: ShareData, copy: string): Promise<"shared" | "copied" | "none"> {
  if (navigator.share) {
    try {
      await navigator.share(data);
      return "shared";
    } catch (e) {
      // Dismissing the sheet is a choice, not a failure; anything else falls through to copying.
      if (e instanceof DOMException && e.name === "AbortError") return "none";
    }
  }
  return (await copyText(copy)) ? "copied" : "none";
}

/** Copy `text` to the clipboard; whether it went. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Some webviews (WebKitGTK, the Linux desktop's) refuse the async clipboard:
    // the old way still copies there.
    return copyTheOldWay(text);
  }
}

/** Copy `text` through a selected, off-screen textarea and `execCommand` — deprecated, and still the one that works where the async API won't. */
function copyTheOldWay(text: string): boolean {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "-1000px";
  area.style.opacity = "0";
  document.body.appendChild(area);
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  area.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  area.remove();
  focused?.focus({ preventScroll: true });
  return copied;
}
