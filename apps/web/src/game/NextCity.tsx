import { useTranslation } from "react-i18next";
import { cn } from "@inkcity/ui/lib/utils";
import { formatCountdown } from "../lib/date";
import { useUntilMidnight } from "../lib/hooks";

/**
 * The time to the next city, over a finished day's cards: the countdown large, and
 * under it, small, what it counts down to. Its own component, so its tick
 * re-renders only these two lines.
 */
export default function NextCity({ hidden }: { hidden: boolean }) {
  const { t } = useTranslation();
  const left = useUntilMidnight();
  return (
    <div className={cn("next", hidden && "is-hidden")} aria-hidden={hidden}>
      <p className="next__time">{formatCountdown(left)}</p>
      <p className="next__label">{t("result.nextCity")}</p>
    </div>
  );
}
