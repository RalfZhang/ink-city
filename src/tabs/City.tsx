import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import SettingRow from "@/components/SettingRow";
import DailyCity from "@/components/DailyCity";
import CustomCity from "@/components/CustomCity";
import GuessCountry from "@/components/guess/GuessCountry";
import GuessResult from "@/components/guess/GuessResult";
import DailyGuessSwitch from "@/components/guess/DailyGuessSwitch";
import { useGuessGame } from "@/components/guess/useGuessGame";
import { countryIndex, isRevealed } from "@/core";
import { tauriGuessStorage } from "@/lib/guess-storage";
import countries from "@/data/countries.json";
import type { Status, UpdateMode } from "../types";

type Props = {
  status: Status;
  onError: (e: unknown) => void;
};

const COUNTRIES = countryIndex(countries);

/**
 * The City tab: a "How to update?" selector (Disable / Daily / Customized) plus
 * the panel for the active mode. The Daily and Customized panels are their own
 * self-contained components — they're independent features that just happen to
 * share this selector.
 *
 * Daily is also where the guess-the-country game lives: until today is revealed
 * (guessed, out of guesses, or the "Daily guess" switch turned off) the city card
 * stays in place but concealed, with the game under it; afterwards the card shows
 * the city and today's result takes the game's place. The game's state belongs to
 * the day, not to this selector — it's kept in the save file, so switching modes
 * and back can neither reset a game nor hide a revealed city.
 */
export default function City({ status, onError }: Props) {
  const { t } = useTranslation();
  const game = useGuessGame(
    tauriGuessStorage,
    { date: status.date, city: status.city, ready: status.todayPainted },
    COUNTRIES,
    onError,
  );
  const snapshot = game.snapshot;
  const daily = status.updateMode === "daily";
  // Concealed until the save has been read, too: showing the city first would flash
  // the answer.
  const revealed = snapshot !== null && isRevealed(snapshot.state);
  const finished =
    snapshot !== null &&
    (snapshot.state === "won" || snapshot.state === "lost" || snapshot.state === "gaveUp");

  const setMode = async (mode: UpdateMode) => {
    try {
      await invoke("set_update_mode", { mode });
    } catch (e) {
      onError(e);
    }
  };

  return (
    <div className="space-y-4 max-w-2xl">
      <Card>
        <CardContent className="space-y-4">
          <SettingRow
            label={t("city.howToUpdate")}
            control={
              <Select value={status.updateMode} onValueChange={(v) => setMode(v as UpdateMode)}>
                <SelectTrigger className="w-[150px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="disable">{t("city.modeDisable")}</SelectItem>
                  <SelectItem value="daily">{t("city.modeDaily")}</SelectItem>
                  <SelectItem value="customized">{t("city.modeCustomized")}</SelectItem>
                </SelectContent>
              </Select>
            }
          />
          {daily && (
            <>
              <Separator />
              <DailyGuessSwitch
                snapshot={snapshot}
                saving={game.saving}
                onChange={(playing) => void game.setPlaying(playing)}
              />
            </>
          )}
        </CardContent>
      </Card>

      {status.updateMode === "disable" && (
        <p className="text-sm text-muted-foreground px-1">{t("city.disabledHint")}</p>
      )}
      {daily && (
        <>
          <DailyCity status={status} onError={onError} concealed={!revealed} />
          {snapshot && !revealed && (
            <GuessCountry
              key={status.date}
              snapshot={snapshot}
              index={COUNTRIES}
              saving={game.saving}
              lastError={status.lastError}
              onGuess={game.guess}
            />
          )}
          {snapshot && finished && snapshot.guesses.length > 0 && (
            <GuessResult snapshot={snapshot} index={COUNTRIES} />
          )}
        </>
      )}
      {status.updateMode === "customized" && <CustomCity status={status} onError={onError} />}
    </div>
  );
}
