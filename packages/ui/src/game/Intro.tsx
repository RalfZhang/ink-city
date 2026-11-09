import { useTranslation } from "react-i18next";
import { cn } from "../lib/utils";
import { UI_NS } from "../i18n";

/**
 * The question a visit opens on, in the middle of the first page: under the curtain
 * while the map is on its way, uncovered with the map as the curtain goes, and gone
 * a moment after that (game/Stage.tsx).
 */
export default function Intro({ shown }: { shown: boolean }) {
  const { t } = useTranslation(UI_NS);
  return (
    <div className={cn("intro", !shown && "is-gone")} aria-hidden={!shown}>
      <h1 className="intro__question">{t("intro.question")}</h1>
    </div>
  );
}
