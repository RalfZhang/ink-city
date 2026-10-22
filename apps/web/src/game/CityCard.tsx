import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUpRight } from "lucide-react";
import { cn } from "@inkcity/ui/lib/utils";
import { captionText, countryName, formatLatLon, mapUrl, wikipediaUrl, type City, type CountryIndex } from "@inkcity/core";
import { cityName } from "../lib/city-name";

type Props = {
  city: City;
  date: string;
  index: CountryIndex;
  /** The day was revealed just now, in front of the player: the card is written in. */
  fresh: boolean;
  onWallpaper: () => void;
  /** Whether what's under the card (the record, the guesses) is folded away, and the way to fold or unfold it; absent, there's nothing to fold. */
  fold?: { collapsed: boolean; onToggle: () => void };
};

/**
 * Today's city, once the game is over — read like the map's caption: the city's
 * own name, then its English name and country, then where on Earth it is; where to
 * read about it, and the way to have it as a wallpaper (the page below).
 */
export default function CityCard({ city, date, index, fresh, onWallpaper, fold }: Props) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const { title, subtitle } = captionText({ ...city, countryName: countryName(index, city.country, lang) });
  // Noon, so no time zone can tip the date into its neighbour.
  const day = new Intl.DateTimeFormat(lang, { weekday: "long", month: "long", day: "numeric" }).format(
    new Date(`${date}T12:00:00`),
  );
  return (
    <section className={cn("card city", fresh && "is-fresh")} aria-label={title}>
      <div className="city__head">
        <p className="ink-label">
          {t("today.label")} · {day}
        </p>
        {fold && (
          <button type="button" className="ink-link city__fold" onClick={fold.onToggle} aria-expanded={!fold.collapsed}>
            {fold.collapsed ? t("result.expand") : t("result.collapse")}
          </button>
        )}
      </div>
      <p className="city__title">{title}</p>
      {subtitle && <p className="city__subtitle">{subtitle}</p>}
      {/* Coordinates read left to right in every language. */}
      <p className="city__coords" dir="ltr">
        {formatLatLon(city.lat, city.lon)}
      </p>
      <p className="city__links">
        <a className="ink-link" href={wikipediaUrl(city.name)} target="_blank" rel="noreferrer">
          {t("today.wikipedia")}
          <ArrowUpRight aria-hidden />
        </a>
        <a className="ink-link" href={mapUrl("osm", city.lat, city.lon)} target="_blank" rel="noreferrer">
          {t("today.openMap")}
          <ArrowUpRight aria-hidden />
        </a>
        <button type="button" className="ink-link" onClick={onWallpaper}>
          {t("download.title", { city: cityName(city, lang) })}
          <ArrowDown aria-hidden />
        </button>
      </p>
    </section>
  );
}
