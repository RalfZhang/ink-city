import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Switch } from "@/components/ui/switch";
import SettingRow from "@/components/SettingRow";
import { isRevealed, type GameSnapshot } from "@/core";

/**
 * The "Daily guess" switch — on by default, so the game is what a day starts with.
 * It is the inverse of the save file's `showCityInfo` preference: off means "don't
 * make me play, show the city every day".
 *
 * Turning it off reveals today, so it asks first — and says so when that would cost
 * a game already underway. Turning it back on needs no confirmation, but only
 * starts the game tomorrow if today has already been given away (the caption says
 * as much).
 */
export default function DailyGuessSwitch({
  snapshot,
  saving,
  onChange,
}: {
  /** Null while the save is still being read: the switch waits too. */
  snapshot: GameSnapshot | null;
  saving: boolean;
  onChange: (playing: boolean) => void;
}) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const playing = !(snapshot?.showCityInfo ?? false);
  // `applySwitch` gives up any game with guesses that today hasn't revealed yet —
  // including one waiting for its map again after a relaunch, not only one in play.
  const forfeits = snapshot !== null && !isRevealed(snapshot.state) && snapshot.guesses.length > 0;
  const description = !playing
    ? t("city.gameDescOff")
    : snapshot?.resumesTomorrow
      ? t("city.gameTomorrow")
      : t("city.gameDescOn");

  return (
    <>
      <SettingRow
        label={t("city.gameLabel")}
        description={description}
        control={
          <Switch
            checked={playing}
            disabled={!snapshot || saving}
            onCheckedChange={(next) => (next ? onChange(true) : setConfirming(true))}
          />
        }
      />
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("city.gameOffTitle")}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-1">
                <p>{t("city.gameOffBody")}</p>
                {forfeits && <p>{t("city.gameOffForfeit")}</p>}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="sm">{t("general.cancel")}</AlertDialogCancel>
            <AlertDialogAction size="sm" onClick={() => onChange(false)}>
              {t("city.gameOffConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
