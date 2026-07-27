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
import SettingRow from "@/components/SettingRow";
import DailyCity from "@/components/DailyCity";
import CustomCity from "@/components/CustomCity";
import type { Status, UpdateMode } from "../types";

type Props = {
  status: Status;
  onError: (e: unknown) => void;
};

/**
 * The City tab: a "How to update?" selector (Disable / Daily / Customized) plus
 * the panel for the active mode. The Daily and Customized panels are their own
 * self-contained components — they're independent features that just happen to
 * share this selector.
 */
export default function City({ status, onError }: Props) {
  const { t } = useTranslation();

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
        <CardContent>
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
        </CardContent>
      </Card>

      {status.updateMode === "disable" && (
        <p className="text-sm text-muted-foreground px-1">{t("city.disabledHint")}</p>
      )}
      {status.updateMode === "daily" && <DailyCity status={status} onError={onError} />}
      {status.updateMode === "customized" && <CustomCity status={status} onError={onError} />}
    </div>
  );
}
