import { useTranslation } from "react-i18next";
import { cn } from "../lib/utils";
import { UI_NS } from "../i18n";
import { formatCountdown, useUntilMidnight } from "./time";

/**
 * The time to the next city, over a finished day's cards: the countdown large, and
 * under it, small, what it counts down to. Its own component, so its tick
 * re-renders only these two lines.
 */
export default function NextCity({ hidden, date }: { hidden: boolean; date: string }) {
  const { t } = useTranslation(UI_NS);
  // To the end of the day on screen: no fresh 24 hours over yesterday's cards.
  const left = useUntilMidnight(date);
  return (
    <div className={cn("next", hidden && "is-hidden")} aria-hidden={hidden}>
      <p className="next__time">{formatCountdown(left)}</p>
      <p className="next__label">{t("result.nextCity")}</p>
    </div>
  );
}
