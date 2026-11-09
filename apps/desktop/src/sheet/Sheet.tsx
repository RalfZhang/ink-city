import { createContext, useEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ParseKeys } from "i18next";

export type TabId = "general" | "style" | "lab" | "about" | "devMode";

/**
 * Whether the sheet is up. It stays mounted when it goes down, so what a tab draws
 * outside the sheet's box — a menu in a portal — reads this to go down with it.
 */
export const SheetOpen = createContext(true);

const TAB_LABELS: Record<TabId, ParseKeys> = {
  general: "sheet.general",
  style: "sheet.style",
  lab: "sheet.lab",
  about: "sheet.about",
  devMode: "sheet.devMode",
};

/** The save strip at the sheet's foot: an unsaved preview, a save under way, or a save the wallpaper didn't follow. */
export type Foot =
  | { kind: "dirty" }
  | { kind: "saving"; painting: boolean }
  | { kind: "failed"; message: string }
  | null;

/**
 * The settings sheet over the home: its tabs along the top edge, Done to put it
 * away, and — while Style and Lab have edits — the strip that saves them. It sits
 * lower on those two tabs, so the map they change shows above it.
 */
export default function Sheet({
  open,
  tab,
  tabs,
  onTab,
  onClose,
  foot,
  onSave,
  onRevert,
  onRetry,
  children,
}: {
  open: boolean;
  tab: TabId;
  tabs: TabId[];
  onTab: (tab: TabId) => void;
  onClose: () => void;
  foot: Foot;
  onSave: () => void;
  onRevert: () => void;
  onRetry: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const body = useRef<HTMLDivElement>(null);
  const low = tab === "style" || tab === "lab";

  // A tab opens at its top.
  useEffect(() => {
    body.current?.scrollTo({ top: 0 });
  }, [tab]);

  return (
    <div className={`sheet${open ? " is-open" : ""}${low ? " is-low" : ""}`} aria-hidden={!open} inert={!open}>
      <div className="sheet__head">
        <div className="tabs" role="tablist">
          {tabs.map((id) => (
            <button key={id} type="button" role="tab" aria-selected={id === tab} onClick={() => onTab(id)}>
              {t(TAB_LABELS[id])}
            </button>
          ))}
        </div>
        <button type="button" className="ink-link" onClick={onClose}>
          {t("sheet.done")}
        </button>
      </div>
      <div ref={body} className="sheet__body" role="tabpanel">
        <SheetOpen.Provider value={open}>{children}</SheetOpen.Provider>
      </div>
      {foot && (
        <div className="sheet__foot">
          {foot.kind === "saving" ? (
            <>
              <span>{t(foot.painting ? "sheet.savingWall" : "sheet.saving")}</span>
              <i className="progress" />
            </>
          ) : foot.kind === "dirty" ? (
            <>
              <span>
                <i className="dot" />
                {t("sheet.previewing")}
              </span>
              <button type="button" className="ink-link" onClick={onRevert}>
                {t("sheet.revert")}
              </button>
              <button type="button" className="btn" onClick={onSave}>
                {t("sheet.save")}
              </button>
            </>
          ) : (
            <>
              <span className="is-bad" role="alert">
                {foot.message}
              </span>
              <button type="button" className="btn btn--line" onClick={onRetry}>
                {t("home.retry")}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
