/**
 * Scroll match `i` of a list of matches (game.css's `.matches`) into the list's
 * view — as far as it takes, and no further. For when the keys move to it; not when
 * the pointer does, which would scroll the list out from under it. Both lines with
 * matches over them use it: the game's guess line (./Bar.tsx), and the desktop's
 * pin line, whose city search returns more than a short window shows.
 */
export function revealMatch(list: HTMLElement | null, i: number): void {
  const item = list?.children[i];
  if (!list || !item) return;
  const box = list.getBoundingClientRect();
  const at = item.getBoundingClientRect();
  const top = box.top + list.clientTop;
  if (at.top < top) list.scrollBy({ top: at.top - top });
  else if (at.bottom > top + list.clientHeight) list.scrollBy({ top: at.bottom - top - list.clientHeight });
}
