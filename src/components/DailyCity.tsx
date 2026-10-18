import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { Status } from "../types";
import { wikipediaUrl, mapUrl } from "../constants";

type Props = {
  status: Status;
  onError: (e: unknown) => void;
  /**
   * Mask the city: today's guess-the-country game isn't over, and this card is the
   * answer. The name line says when it will be revealed, the other two keep their
   * place behind placeholder bars, and the two lookup links are disabled;
   * Regenerate stays.
   */
  concealed?: boolean;
};

/**
 * The "Daily" update mode: the city today's wallpaper depicts, with quick links and
 * a manual Regenerate. Rendered by the City tab when `updateMode === "daily"`.
 * `status.city` is whatever the backend actually rendered, not a pick recomputed
 * here — see `pipeline::city_for_status`.
 *
 * It's null while the day is still unresolved, and there is no local rotation to
 * guess with, so the name line holds an em dash and the lookup links are disabled.
 *
 * `status.lastError` is what makes that gap legible: on its own an em dash can't
 * say whether the day is still arriving or can never arrive, and those want
 * opposite things from the user (wait vs. check the network). So the coordinate
 * line — already a muted one-liner — carries the reason instead of coordinates
 * while `city` is null. It stays one line either way, so nothing shifts when the
 * city lands. Regenerate stays live throughout: it's how the user retries.
 *
 * Note the failure it reports is never shown in the global error banner: unlike a
 * command rejection, this one is re-recorded by every 60s poll, so a dismissable
 * banner would keep reappearing and could never be cleared.
 *
 * While today's guess-the-country game is still open the card is `concealed`: the
 * name line reads "revealed after today's guess" in muted type — an empty card
 * alone didn't say why it was empty — and the two lines under it become
 * placeholder bars of the same height, so revealing the city shifts nothing. The
 * unresolved em dash and its reason still show; they give nothing away.
 */
export default function DailyCity({ status, onError, concealed = false }: Props) {
  const { t } = useTranslation();
  const city = status.city;
  // A resolution that has failed, as opposed to one still in flight. Both show as
  // no city; only this one is worth explaining, and only it isn't going to clear
  // itself on the next poll.
  const unresolvable = !city && status.lastError !== null;
  const hidden = city !== null && concealed;
  // What the two lookup links open: nothing while there's no city, or it's concealed.
  const linkCity = hidden ? null : city;

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
        <div className={cn("text-xl font-semibold", hidden && "text-muted-foreground")}>
          {hidden ? t("city.revealAfterGame") : city ? `${city.name}, ${city.country}` : "—"}
        </div>
        <div className="text-sm text-muted-foreground">
          {hidden ? <Masked className="h-3.5 w-20" /> : city ? city.localName : "-"}
        </div>
        <div className="text-xs text-muted-foreground mt-1">
          {hidden ? (
            <Masked className="h-3 w-32" />
          ) : city ? (
            `${city.lat.toFixed(4)}, ${city.lon.toFixed(4)}`
          ) : unresolvable ? (
            t("city.unresolved")
          ) : (
            t("city.resolving")
          )}
        </div>
      </CardContent>
      <CardFooter className="justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={!linkCity}
          onClick={() => linkCity && openUrl(wikipediaUrl(linkCity.name))}
        >
          {t("city.wikipedia")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!linkCity}
          onClick={() => linkCity && openUrl(mapUrl(status.mapProvider, linkCity.lat, linkCity.lon))}
        >
          {t("city.openMap")}
        </Button>
        <Button className="min-w-32" onClick={regenerate} disabled={status.running} size="sm">
          {status.running && <Loader2 className="animate-spin size-3.5 me-1.5" />}
          {status.running ? t("city.regenerating") : t("city.regenerate")}
        </Button>
      </CardFooter>
    </Card>
  );
}

/** An ink bar standing in for a concealed line, sized to sit inside that line's height. */
function Masked({ className }: { className: string }) {
  return (
    <span aria-hidden className={cn("inline-block align-middle rounded-sm bg-foreground/10", className)} />
  );
}
