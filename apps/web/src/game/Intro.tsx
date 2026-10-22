import { useTranslation } from "react-i18next";
import { cn } from "@inkcity/ui/lib/utils";

/**
 * The question a visit opens on, in the middle of the first page: under the curtain
 * while the map is on its way, uncovered with the map as the curtain goes, and gone
 * a moment after that (game/Stage.tsx).
 */
export default function Intro({ shown }: { shown: boolean }) {
  const { t } = useTranslation();
  return (
    <div className={cn("intro", !shown && "is-gone")} aria-hidden={!shown}>
      <h1 className="intro__question">{t("intro.question")}</h1>
    </div>
  );
}
