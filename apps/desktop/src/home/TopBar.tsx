import { useTranslation } from "react-i18next";
import { RotateCw, SlidersHorizontal } from "lucide-react";
import { TickMark } from "@/sheet/controls";

/**
 * The bar along the top of the home: the three things the window does to the map
 * — drawing it on the desktop again, whether it goes there at all, and the
 * settings. Which map it is reads at the foot, over the game. The bar's empty
 * stretch moves the window (macOS draws its own buttons over the map's corner here,
 * so there's no title bar to hold).
 *
 * Regenerate only means something while syncing, so it comes and goes with the
 * sync box — at the far end from the edge, so the two that stay never move, and
 * sliding open and shut rather than popping.
 *
 * Under it, kept until it's put right: why the map didn't make it onto the
 * desktop. And with the sheet put away, an unsaved preview says so, with its two
 * ways out — the two stacked in one column (.top__notes), never over each other.
 */
export default function TopBar({
  sync,
  busy,
  sheetOpen,
  wallError,
  syncError,
  dirty,
  onSync,
  onRegenerate,
  onSettings,
  onSave,
  onRevert,
}: {
  sync: boolean;
  busy: boolean;
  sheetOpen: boolean;
  wallError: string | null;
  /** Why the sync box couldn't be switched, kept until it can; its retry switches again. */
  syncError: string | null;
  dirty: boolean;
  onSync: () => void;
  onRegenerate: () => void;
  onSettings: () => void;
  onSave: () => void;
  onRevert: () => void;
}) {
  const { t } = useTranslation();
  const showErr = !!wallError && !busy;
  const showPeek = !sheetOpen && dirty;
  const showSync = !!syncError;
  return (
    <>
      <div className="top" data-tauri-drag-region>
        <span className="top__chips">
          <span className={`slide-x${sync ? "" : " is-shut"}`} inert={!sync} aria-hidden={!sync}>
            <span>
              <button
                type="button"
                className={`chip${busy ? " is-busy" : ""}`}
                aria-busy={busy}
                onClick={onRegenerate}
                disabled={busy || !sync}
                title={t("home.regenerate")}
                aria-label={t("home.regenerate")}
              >
                <RotateCw className="ic" aria-hidden />
              </button>
            </span>
          </span>
          <button
            type="button"
            className={`chip chip--sync${busy ? " is-busy" : ""}`}
            aria-busy={busy}
            role="checkbox"
            aria-checked={sync}
            onClick={onSync}
          >
            <span className="box">
              <TickMark />
            </span>
            <span>{t("home.sync")}</span>
          </button>
          <button type="button" className="chip" aria-expanded={sheetOpen} onClick={onSettings}>
            <SlidersHorizontal className="ic" aria-hidden />
            <span>{t("home.settings")}</span>
          </button>
        </span>
      </div>
      {(showSync || showErr || showPeek) && (
        <div className="top__notes">
          {showSync && (
            <div className="top__err">
              <div className="err" role="alert">
                <span>{t("home.syncFail", { reason: syncError })}</span>
                <button type="button" className="ink-link" onClick={onSync}>
                  {t("home.retry")}
                </button>
              </div>
            </div>
          )}
          {showErr && (
            <div className="top__err">
              <div className="err" role="alert">
                <span>{t("home.wallFail", { reason: wallError })}</span>
                <button type="button" className="ink-link" onClick={onRegenerate}>
                  {t("home.retry")}
                </button>
              </div>
            </div>
          )}
          {showPeek && (
            <div className="peek">
              <span>{t("sheet.previewing")}</span>
              {/* In the sheet foot's order: Revert, then Save. */}
              <button type="button" className="ink-link" onClick={onRevert}>
                {t("sheet.revert")}
              </button>
              <button type="button" className="ink-link" onClick={onSave}>
                {t("sheet.save")}
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
}
