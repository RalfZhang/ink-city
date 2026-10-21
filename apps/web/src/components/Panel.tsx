import type { ReactNode, RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Eye, PanelBottomOpen, PanelLeftOpen, PanelRightOpen } from "lucide-react";
import { Button } from "@inkcity/ui/components/button";
import { cn } from "@inkcity/ui/lib/utils";

type Props = {
  panelRef: RefObject<HTMLElement | null>;
  /** A side panel on a wide screen, a sheet along the bottom on a narrow one. */
  wide: boolean;
  rtl: boolean;
  hidden: boolean;
  onHiddenChange: (hidden: boolean) => void;
  children: ReactNode;
};

/**
 * The game's panel over the map. Flush with the edge it sits on — the whole height
 * of the screen at the inline start on a wide screen, the whole width along the
 * bottom on a narrow one — because the map slides away from it by half its size
 * (MapView) and the strip that opens up has to lie underneath it. For the same
 * reason it doesn't float, drag or resize.
 *
 * "Show the whole map" (the eye, or H) slides it out of the way; a button in the
 * corner brings it back.
 */
export default function Panel({ panelRef, wide, rtl, hidden, onHiddenChange, children }: Props) {
  const { t } = useTranslation();
  const RestoreIcon = !wide ? PanelBottomOpen : rtl ? PanelRightOpen : PanelLeftOpen;
  return (
    <>
      <aside
        ref={panelRef}
        aria-labelledby="panel-title"
        aria-hidden={hidden}
        inert={hidden}
        className={cn(
          "fixed z-10 flex flex-col bg-background/90 backdrop-blur-md shadow-xl transition-transform duration-500 ease-out motion-reduce:transition-none",
          wide
            ? "inset-y-0 start-0 w-[380px] max-w-[85vw] border-e border-foreground/10"
            : "inset-x-0 bottom-0 max-h-[68dvh] rounded-t-2xl border-t border-foreground/10",
          hidden && (wide ? (rtl ? "translate-x-full" : "-translate-x-full") : "translate-y-full"),
        )}
      >
        <header className="flex items-center gap-3 px-5 pt-5 pb-3">
          <img src="/apple-touch-icon.png" alt="" className="size-9 shrink-0" />
          <div className="min-w-0 flex-1">
            <h1 id="panel-title" className="text-base font-semibold leading-tight">
              InkCity
            </h1>
            <p className="truncate text-xs text-muted-foreground">{t("panel.tagline")}</p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onHiddenChange(true)}
            aria-label={t("panel.showMap")}
            title={`${t("panel.showMap")} (H)`}
            aria-keyshortcuts="H"
          >
            <Eye />
          </Button>
        </header>
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-5 pb-5 space-y-4">{children}</div>
      </aside>
      {hidden && (
        <Button
          variant="outline"
          size="icon-lg"
          className={cn("fixed z-10 shadow-lg", wide ? "top-4 start-4" : "bottom-4 start-4")}
          onClick={() => onHiddenChange(false)}
          aria-label={t("panel.showGame")}
          title={`${t("panel.showGame")} (H)`}
          aria-keyshortcuts="H"
        >
          <RestoreIcon />
        </Button>
      )}
    </>
  );
}
