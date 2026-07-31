import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import type { Status } from "../types";
import { wikipediaUrl, googleMapsUrl } from "../constants";

type Props = {
  status: Status;
  onError: (e: unknown) => void;
};

/**
 * The "Daily" update mode: the city today's wallpaper depicts, with quick links and
 * a manual Regenerate. Rendered by the City tab when `updateMode === "daily"`.
 * `status.city` is whatever the backend actually rendered, not a pick recomputed
 * here — see `pipeline::city_for_status`.
 */
export default function DailyCity({ status, onError }: Props) {
  const { t } = useTranslation();
  const city = status.city;

  const regenerate = async () => {
    try {
      await invoke("regenerate_now");
    } catch (e) {
      onError(e);
    }
  };

  return (
    <Card>
      <CardContent>
        <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">
          {t("city.today")} · {status.date}
        </div>
        <div className="text-xl font-semibold">
          {city.name}, {city.country}
        </div>
        {city.localName !== city.name && (
          <div className="text-sm text-muted-foreground">{city.localName}</div>
        )}
        <div className="text-xs text-muted-foreground mt-1">
          {city.lat.toFixed(4)}, {city.lon.toFixed(4)}
        </div>
      </CardContent>
      <CardFooter className="justify-end gap-2">
        <Button variant="outline" size="sm" onClick={() => openUrl(wikipediaUrl(city.name))}>
          {t("city.wikipedia")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => openUrl(googleMapsUrl(city.lat, city.lon))}
        >
          {t("city.googleMaps")}
        </Button>
        <Button className="min-w-32" onClick={regenerate} disabled={status.running} size="sm">
          {status.running && <Loader2 className="animate-spin size-3.5 me-1.5" />}
          {status.running ? t("city.regenerating") : t("city.regenerate")}
        </Button>
      </CardFooter>
    </Card>
  );
}
