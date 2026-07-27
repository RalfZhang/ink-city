import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
import { useTranslation } from "react-i18next";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import SettingRow from "@/components/SettingRow";
import ProxySetting from "@/components/ProxySetting";
import { getLocaleChoice, setLocaleChoice, LOCALES, type LocaleChoice } from "../i18n";
import type { Status } from "../types";

type Props = {
  status: Status;
  refresh: () => Promise<void>;
  onError: (e: unknown) => void;
};

export default function General({ status, refresh, onError }: Props) {
  const { t } = useTranslation();
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [locale, setLocale] = useState<LocaleChoice>(getLocaleChoice());

  useEffect(() => {
    isEnabled().then(setAutostart).catch(onError);
  }, []);

  const toggleHideTray = async (hide: boolean) => {
    try {
      await invoke("set_hide_tray", { hide });
      await refresh();
    } catch (e) {
      onError(e);
    }
  };

  const toggleAutostart = async (on: boolean) => {
    try {
      if (on) await enable();
      else await disable();
      setAutostart(on);
    } catch (e) {
      onError(e);
    }
  };

  const pickLocale = (v: LocaleChoice) => {
    setLocaleChoice(v);
    setLocale(v);
  };

  return (
    <div className="space-y-4 max-w-2xl">
      <Card>
        <CardContent className="space-y-4">
          <SettingRow
            label={t("general.autostartLabel")}
            description={t("general.autostartDesc")}
            control={
              <Switch
                checked={autostart ?? false}
                disabled={autostart === null}
                onCheckedChange={toggleAutostart}
              />
            }
          />
          <Separator />
          <SettingRow
            label={t("general.hideTrayLabel")}
            description={
              status.hide_tray
                ? t("general.hideTrayDescOn")
                : t("general.hideTrayDescOff")
            }
            control={<Switch checked={status.hide_tray} onCheckedChange={toggleHideTray} />}
          />
          <Separator />
          <SettingRow
            label={t("general.languageLabel")}
            control={
              <Select value={locale} onValueChange={(v) => pickLocale(v as LocaleChoice)}>
                <SelectTrigger className="w-[150px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">{t("general.languageAuto")}</SelectItem>
                  {LOCALES.map((l) => (
                    <SelectItem key={l.code} value={l.code}>
                      {l.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
          />
          <Separator />
          <ProxySetting
            enabled={status.proxyEnabled}
            url={status.proxyUrl}
            refresh={refresh}
            onError={onError}
          />
        </CardContent>
      </Card>
    </div>
  );
}
