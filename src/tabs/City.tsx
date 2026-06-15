import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import type { Status } from "../types";
import { wikipediaUrl } from "../constants";

type Props = {
  status: Status;
  onError: (e: unknown) => void;
};

export default function City({ status, onError }: Props) {
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
    <div className="space-y-6 max-w-2xl">
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
        <CardFooter className="min-w-32 justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => openUrl(wikipediaUrl(city.name))}>
            {t("city.wikipedia")}
          </Button>
          <Button className="min-w-32" onClick={regenerate} disabled={status.running} size="sm">
            {status.running ? t("city.regenerating") : t("city.regenerate")}
          </Button>
        </CardFooter>
      </Card>

      {/* <div className="flex justify-end gap-2">
      </div> */}
    </div>
  );
}
