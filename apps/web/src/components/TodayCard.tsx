import { useTranslation } from "react-i18next";
import { ExternalLink, Loader2 } from "lucide-react";
import { Button } from "@inkcity/ui/components/button";
import { Card, CardContent } from "@inkcity/ui/components/card";
import { cn } from "@inkcity/ui/lib/utils";
import { countryName, formatLatLon, mapUrl, wikipediaUrl, type City, type CountryIndex } from "@inkcity/core";
import type { Stage } from "../map/load";

type Props = {
  date: string;
  city: City | null;
  /** Today's game is over (or can't be played), so the city may show. */
  revealed: boolean;
  stage: Stage | null;
  error: string | null;
  onRetry: () => void;
  index: CountryIndex;
};

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Today and its city — the website's counterpart of the desktop's daily city card.
 * While the day is loading it says so (and why, when the map comes from Overpass
 * rather than the CDN); while the game is on, the city stays behind placeholder
 * bars of the same height, so revealing it moves nothing; afterwards it reads like
 * the map's caption: the city's own name, then its English name and country, then
 * where on Earth it is.
 */
export default function TodayCard({ date, city, revealed, stage, error, onRetry, index }: Props) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  // Noon, so no time zone can tip the date into its neighbour.
  const day = new Intl.DateTimeFormat(lang, { weekday: "long", month: "long", day: "numeric" }).format(
    new Date(`${date}T12:00:00`),
  );
  const shown = revealed ? city : null;

  let body;
  if (shown) {
    const title = shown.localName.trim() || shown.name;
    const country = countryName(index, shown.country, lang);
    const parts = [!same(shown.name, title) ? shown.name : null, !same(country, title) ? country : null].filter(
      (p): p is string => p !== null,
    );
    body = (
      <>
        <div className="text-xl font-semibold leading-snug">{title}</div>
        <div className="text-sm text-muted-foreground min-h-5">{parts.join(" · ")}</div>
        <div className="text-xs text-muted-foreground tabular-nums min-h-4">{formatLatLon(shown.lat, shown.lon)}</div>
        <div className="flex flex-wrap gap-2 pt-2">
          <Button variant="outline" size="sm" asChild>
            <a href={wikipediaUrl(shown.name)} target="_blank" rel="noreferrer">
              {t("today.wikipedia")}
              <ExternalLink />
            </a>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <a href={mapUrl("osm", shown.lat, shown.lon)} target="_blank" rel="noreferrer">
              {t("today.openMap")}
              <ExternalLink />
            </a>
          </Button>
        </div>
      </>
    );
  } else {
    body = (
      <>
        <div className={cn("text-xl font-semibold leading-snug", error ? "text-destructive" : "text-muted-foreground")}>
          {error ? t("today.failed") : city ? t("today.concealed") : <Loading stage={stage} />}
        </div>
        {error ? (
          <div className="pt-1">
            <Button variant="outline" size="sm" onClick={onRetry}>
              {t("today.retry")}
            </Button>
          </div>
        ) : (
          <>
            <div className="min-h-5 flex items-center">
              <Masked className="h-3.5 w-24" />
            </div>
            <div className="min-h-4 flex items-center">
              <Masked className="h-3 w-36" />
            </div>
          </>
        )}
      </>
    );
  }

  return (
    <Card size="sm">
      <CardContent className="space-y-0.5">
        <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">
          {t("today.label")} · {day}
        </div>
        {body}
      </CardContent>
    </Card>
  );
}

function Loading({ stage }: { stage: Stage | null }) {
  const { t } = useTranslation();
  return (
    <span className="flex items-start gap-2 text-base font-normal">
      <Loader2 className="mt-1 size-4 shrink-0 animate-spin" />
      {stage === "overpass" ? t("today.rebuilding") : t("today.loading")}
    </span>
  );
}

/** An ink bar standing in for a concealed line. */
function Masked({ className }: { className: string }) {
  return <span aria-hidden className={cn("inline-block rounded-sm bg-foreground/10", className)} />;
}
