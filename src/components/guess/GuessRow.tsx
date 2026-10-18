import { ArrowUp, Check } from "lucide-react";
import {
  MAX_TIER,
  countryName,
  type CompassPoint,
  type CountryIndex,
  type GuessView,
} from "@inkcity/core";
import { cn } from "@/lib/utils";

const ANGLE: Record<CompassPoint, number> = {
  n: 0, ne: 45, e: 90, se: 135, s: 180, sw: 225, w: 270, nw: 315,
};

/** `1,234 km`, in the player's language where the platform knows how. */
function formatKm(km: number, lang: string): string {
  try {
    return new Intl.NumberFormat(lang, {
      style: "unit",
      unit: "kilometer",
      maximumFractionDigits: 0,
    }).format(km);
  } catch {
    return `${Math.round(km)} km`;
  }
}

/**
 * One guess: the country, how far today's city is from it, which way to go, and
 * how warm that is on the five-cell ink scale. The correct guess trades distance
 * and direction for a check mark and a full scale.
 */
export default function GuessRow({
  view,
  index,
  lang,
}: {
  view: GuessView;
  index: CountryIndex;
  lang: string;
}) {
  return (
    <li className="flex items-center gap-3 h-7 px-2 rounded-md bg-muted/50 text-sm animate-in fade-in duration-300">
      <span className="flex-1 min-w-0 truncate">{countryName(index, view.code, lang)}</span>
      <span className="text-end tabular-nums text-muted-foreground">
        {view.correct ? null : formatKm(view.km, lang)}
      </span>
      <span className="w-4 flex justify-center">
        {view.correct ? (
          <Check className="size-3.5" />
        ) : (
          // A compass direction, so it must never mirror under RTL: an inline
          // transform, not an `rtl:` utility.
          <ArrowUp className="size-3.5" style={{ transform: `rotate(${ANGLE[view.dir]}deg)` }} />
        )}
      </span>
      <InkScale tier={view.tier} />
    </li>
  );
}

function InkScale({ tier }: { tier: number }) {
  return (
    <span className="flex gap-0.5" aria-hidden>
      {Array.from({ length: MAX_TIER }, (_, i) => (
        <span
          key={i}
          className={cn("size-2.5 rounded-[2px]", i < tier ? "bg-foreground" : "bg-foreground/12")}
        />
      ))}
    </span>
  );
}
