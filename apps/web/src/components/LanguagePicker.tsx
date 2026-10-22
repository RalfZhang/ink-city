import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { Check, Languages } from "lucide-react";
import { LOCALES, setLanguage, type LocaleCode } from "../i18n";

/** How long the pointer may be off the mark and its list before the list closes, ms: long enough to cross the gap between them. */
const CLOSE_MS = 220;

/**
 * The language, in the top corner: a mark (文A, the sign people look for in a page
 * they can't read) whose list of every language, each under its own name, opens as
 * a mouse comes over it — or on a click or a tap, and from the keyboard, where the
 * arrows walk the list, Escape closes it and focus goes back to the mark.
 */
export default function LanguagePicker() {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const closing = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Opened from the keyboard (or a tap): the current language takes the focus.
  const [focusOnOpen, setFocusOnOpen] = useState(false);
  // What the last press on the mark was made with, for its click.
  const via = useRef("");
  const current = LOCALES.find((l) => l.code === i18n.language);

  useEffect(() => () => clearTimeout(closing.current), []);
  useEffect(() => {
    if (!open || !focusOnOpen) return;
    list.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
  }, [open, focusOnOpen]);
  // A tap outside closes it, as the pointer leaving does for a mouse.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: globalThis.PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const hover = (e: PointerEvent, entering: boolean) => {
    if (e.pointerType !== "mouse") return;
    clearTimeout(closing.current);
    if (entering) {
      setFocusOnOpen(false);
      setOpen(true);
    } else closing.current = setTimeout(() => setOpen(false), CLOSE_MS);
  };

  const pick = (code: LocaleCode) => {
    setLanguage(code);
    setOpen(false);
    trigger.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const items = [...(list.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape" && open) {
      e.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      // Closed, the list isn't there to walk: open it, the current language focused.
      if (!open) {
        setFocusOnOpen(true);
        setOpen(true);
        return;
      }
      if (items.length === 0) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      items[at < 0 ? 0 : (at + step + items.length) % items.length].focus();
    } else if ((e.key === "Home" || e.key === "End") && at >= 0) {
      e.preventDefault();
      items[e.key === "Home" ? 0 : items.length - 1].focus();
    }
  };

  return (
    <div
      ref={wrap}
      className="lang"
      onPointerEnter={(e) => hover(e, true)}
      onPointerLeave={(e) => hover(e, false)}
      onKeyDown={onKeyDown}
      onBlur={(e) => {
        if (!wrap.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="chip-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("footer.language")}
        title={current ? `${t("footer.language")} · ${current.label}` : t("footer.language")}
        onPointerDown={(e) => {
          via.current = e.pointerType;
        }}
        onClick={() => {
          // A mouse over the mark has the list open already, and a click keeps it so;
          // a tap or the keyboard toggles it, and puts the focus in it.
          const mouse = via.current === "mouse";
          via.current = "";
          setFocusOnOpen(!mouse);
          setOpen((o) => (mouse ? true : !o));
        }}
      >
        <Languages strokeWidth={1.6} />
      </button>
      {open && (
        <ul
          ref={list}
          role="menu"
          aria-label={t("footer.language")}
          className="ink-pop lang-menu"
          // Keep the focus where it is through a click: a browser that doesn't focus a
          // button it's clicked (Safari, Firefox on a Mac) would otherwise blur the mark,
          // and the wrapper's blur close the list before the click lands.
          onMouseDown={(e) => e.preventDefault()}
        >
          {LOCALES.map((l) => {
            const checked = l.code === i18n.language;
            return (
              <li key={l.code} role="none">
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={checked}
                  className="lang-menu__item"
                  lang={l.code}
                  dir={"dir" in l ? l.dir : undefined}
                  tabIndex={-1}
                  onClick={() => pick(l.code)}
                >
                  <span>{l.label}</span>
                  {checked && <Check strokeWidth={1.6} aria-hidden className="lang-menu__check" />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
