import { useTranslation } from "react-i18next";
import type { City } from "@inkcity/core";
import { cityName } from "../lib/city-name";
import type { Visitor } from "../lib/platform";
import { Countdown, DownloadOptions } from "./Download";
import Footer from "./Footer";
import Sheet from "./Sheet";

/**
 * The second page, the sheet drawn up over the map: the app the game is there to
 * lead to — what it does, its download for the visitor's own platform with the
 * others under it, the countdown to the next city — and the imprint. Today's city
 * is named only once the game has given it away.
 */
export default function AppPage({ city, visitor }: { city: City | null; visitor: Visitor }) {
  const { t, i18n } = useTranslation();
  return (
    <Sheet>
      <p className="app__lead">
        {city ? t("download.title", { city: cityName(city, i18n.language) }) : t("app.tagline")}
      </p>
      <p className="app__body">{t("download.body")}</p>
      <DownloadOptions visitor={visitor} />
      <Countdown />
      <Footer />
    </Sheet>
  );
}
