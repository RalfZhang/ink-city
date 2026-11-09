import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUpRight } from "lucide-react";
import { captionText, countryName, formatLatLon, mapUrl, wikipediaUrl, type City, type CountryIndex } from "@inkcity/core";
import { cn } from "../lib/utils";
import { UI_NS } from "../i18n";

/** How the host opens a link: the website as an anchor does; the desktop through the system's browser. */
export type OpenLink = (href: string) => void;

type Props = {
  city: City;
  date: string;
  index: CountryIndex;
  /** The day was revealed just now, in front of the player: the card is written in. */
  fresh: boolean;
  /** Where the map link goes and what it's called — OpenStreetMap unless the host says otherwise. */
  mapLink?: { href: string; label: string };
  /** Open links this way rather than as anchors (a desktop webview can't follow one out). */
  onOpen?: OpenLink;
  /** The website's way to have the city as a wallpaper (the page below); absent, no such link. */
  wallpaper?: { label: string; onClick: () => void };
  /** Whether what's under the card (the record, the guesses) is folded away, and the way to fold or unfold it; absent, there's nothing to fold. */
  fold?: { collapsed: boolean; onToggle: () => void };
};

/**
 * Today's city, once the game is over — read like the map's caption: the city's
 * own name, then its English name and country, then where on Earth it is; where to
 * read about it, and on the website the way to have it as a wallpaper.
 */
export default function CityCard({ city, date, index, fresh, mapLink, onOpen, wallpaper, fold }: Props) {
  const { t, i18n } = useTranslation(UI_NS);
  const lang = i18n.language;
  const { title, subtitle } = captionText({ ...city, countryName: countryName(index, city.country, lang) });
  // Noon, so no time zone can tip the date into its neighbour.
  const day = new Intl.DateTimeFormat(lang, { weekday: "long", month: "long", day: "numeric" }).format(
    new Date(`${date}T12:00:00`),
  );
  const map = mapLink ?? { href: mapUrl("osm", city.lat, city.lon), label: t("today.openMap") };
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
        <Out href={wikipediaUrl(city.name)} onOpen={onOpen}>
          {t("today.wikipedia")}
        </Out>
        <Out href={map.href} onOpen={onOpen}>
          {map.label}
        </Out>
        {wallpaper && (
          <button type="button" className="ink-link" onClick={wallpaper.onClick}>
            {wallpaper.label}
            <ArrowDown aria-hidden />
          </button>
        )}
      </p>
    </section>
  );
}

function Out({ href, onOpen, children }: { href: string; onOpen?: OpenLink; children: ReactNode }) {
  const mark = <ArrowUpRight aria-hidden />;
  return onOpen ? (
    <button type="button" className="ink-link" onClick={() => onOpen(href)}>
      {children}
      {mark}
    </button>
  ) : (
    <a className="ink-link" href={href} target="_blank" rel="noreferrer">
      {children}
      {mark}
    </a>
  );
}
