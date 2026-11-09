import { useContext, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown } from "lucide-react";
import { isComposing } from "@inkcity/ui/game/motion";
import { detectLocale } from "@inkcity/ui/i18n";
import { LOCALES, dirForLocale, getLocaleChoice, setLocaleChoice, type LocaleChoice } from "@/i18n";
import { SheetOpen } from "./Sheet";

/** The menu's size, px — styles/sheet.css's .menu. */
const MENU_W = 290;
const MENU_H = 330;

/** `code`'s name in `lang`, where the platform knows it; else nothing (the native name stands alone). */
function nameIn(code: string, lang: string): string {
  try {
    return new Intl.DisplayNames([lang], { type: "language" }).of(code) ?? "";
  } catch {
    return "";
  }
}

/**
 * The language picker: a button showing the choice, and a menu that opens from it
 * with a line to filter twenty languages down by typing. Each language is listed
 * in its own script, with its name in the current language beside it — so a
 * reader who landed in a language they can't read can still find theirs, and the
 * filter finds either spelling. "Auto" heads the list and says what the system's
 * language resolves to. Arrow keys move, Enter picks, Escape closes.
 */
export default function LanguageMenu() {
  const { t, i18n } = useTranslation();
  const [choice, setChoice] = useState<LocaleChoice>(getLocaleChoice());
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  // The menu is drawn over the window, outside the sheet: it goes down with the sheet.
  const sheetOpen = useContext(SheetOpen);
  useEffect(() => {
    if (!sheetOpen) setOpen(false);
  }, [sheetOpen]);
  const system = LOCALES.find((l) => l.code === detectLocale(navigator.language));

  const pick = (code: LocaleChoice) => {
    setLocaleChoice(code);
    setChoice(code);
    setOpen(false);
    button.current?.focus({ preventScroll: true });
  };

  const current = choice === "auto" ? null : LOCALES.find((l) => l.code === choice);
  return (
    <>
      <button
        ref={button}
        type="button"
        className="dd"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="dd__v">
          {current ? (
            <span lang={current.code}>{current.label}</span>
          ) : (
            <>
              {t("general.languageAuto")}
              {system && <small lang={system.code}>· {system.label}</small>}
            </>
          )}
        </span>
        <ChevronDown className="ic" aria-hidden />
      </button>
      {open && (
        <Menu
          anchor={button.current}
          choice={choice}
          lang={i18n.language}
          systemLabel={system?.label ?? ""}
          onPick={pick}
          onClose={(refocus) => {
            setOpen(false);
            if (refocus) button.current?.focus({ preventScroll: true });
          }}
        />
      )}
    </>
  );
}

type Item = { code: LocaleChoice; label: string; aside: string; dir?: "rtl" };

function Menu({
  anchor,
  choice,
  lang,
  systemLabel,
  onPick,
  onClose,
}: {
  anchor: HTMLElement | null;
  choice: LocaleChoice;
  lang: string;
  systemLabel: string;
  onPick: (code: LocaleChoice) => void;
  onClose: (refocus: boolean) => void;
}) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState("");
  const [place, setPlace] = useState<{ left: number; top?: number; bottom?: number; maxHeight: number } | null>(null);
  const menu = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);

  const all: Item[] = [
    { code: "auto", label: t("general.languageAuto"), aside: `${t("general.languageAutoDesc")} · ${systemLabel}` },
    ...LOCALES.map((l) => ({ code: l.code, label: l.label, aside: nameIn(l.code, lang), dir: dirForLocale(l.code) === "rtl" ? ("rtl" as const) : undefined })),
  ];
  const q = filter.trim().toLowerCase();
  const items = all.filter((it) => !q || [it.code, it.label, it.aside, nameIn(it.code === "auto" ? "en" : it.code, "en")].some((s) => s.toLowerCase().includes(q)));
  const [active, setActive] = useState(() => Math.max(0, items.findIndex((it) => it.code === choice)));
  const at = Math.min(active, Math.max(0, items.length - 1));

  // Opened beside the button, below it where there's room and above it where there isn't.
  useLayoutEffect(() => {
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const rtl = document.documentElement.dir === "rtl";
    const left = Math.max(8, Math.min(rtl ? r.left : r.right - MENU_W, window.innerWidth - MENU_W - 8));
    const below = window.innerHeight - r.bottom - 8;
    const above = r.top - 8;
    setPlace(
      below >= MENU_H || below >= above
        ? { left, top: r.bottom + 4, maxHeight: Math.min(MENU_H, below) }
        : { left, bottom: window.innerHeight - r.top + 4, maxHeight: Math.min(MENU_H, above) },
    );
  }, [anchor]);

  // A click anywhere else closes it.
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (!menu.current?.contains(e.target as Node) && !anchor?.contains(e.target as Node)) onClose(false);
    };
    document.addEventListener("mousedown", down);
    return () => document.removeEventListener("mousedown", down);
  }, [anchor, onClose]);

  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [at]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (isComposing(e)) return;
    const n = items.length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive(Math.min(n - 1, at + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive(Math.max(0, at - 1));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(n - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (items[at]) onPick(items[at].code);
    } else if (e.key === "Escape") {
      e.preventDefault();
      // The menu's, not the sheet's: Escape closes this, and only this.
      e.stopPropagation();
      onClose(true);
    } else if (e.key === "Tab") {
      onClose(false);
    }
  };

  return createPortal(
    <div ref={menu} className="menu" style={place ? { ...place } : { visibility: "hidden" }}>
      <input
        className="menu__filter"
        autoFocus
        value={filter}
        onChange={(e) => {
          setFilter(e.target.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
        placeholder={t("general.languageFilter")}
        aria-label={t("general.languageFilter")}
        aria-controls="lang-list"
        spellCheck={false}
        autoComplete="off"
      />
      <ul ref={list} id="lang-list" role="listbox">
        {items.length === 0 ? (
          <li className="menu__empty" aria-disabled>
            {t("general.languageNone")}
          </li>
        ) : (
          items.map((it, i) => (
            <li
              key={it.code}
              role="option"
              aria-selected={i === at}
              className={it.code === "auto" ? "is-auto" : undefined}
              onMouseMove={() => i !== at && setActive(i)}
              onClick={() => onPick(it.code)}
            >
              <span>{it.code === choice && <Check className="tick" aria-hidden />}</span>
              <span lang={it.code === "auto" ? undefined : it.code} dir={it.dir}>
                {it.label}
              </span>
              <small>{it.aside}</small>
            </li>
          ))
        )}
      </ul>
    </div>,
    document.body,
  );
}
