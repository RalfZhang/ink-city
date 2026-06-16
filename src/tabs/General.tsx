import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
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
import { getLocaleChoice, setLocaleChoice, type LocaleChoice } from "../i18n";
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

  const toggleEnabled = async (on: boolean) => {
    try {
      await invoke("set_enabled", { on });
      await refresh();
    } catch (e) {
      onError(e);
    }
  };

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
    <div className="min-h-full space-y-4 max-w-2xl flex flex-col justify-between">
      <Card>
        <CardContent className="space-y-4">
          <SettingRow
            label={t("general.enabledLabel")}
            description={t("general.enabledDesc")}
            control={<Switch checked={status.enabled} onCheckedChange={toggleEnabled} />}
          />
          <Separator />
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
                  <SelectItem value="en">English</SelectItem>
                  <SelectItem value="zh-Hans">简体中文</SelectItem>
                </SelectContent>
              </Select>
            }
          />
        </CardContent>
      </Card>

      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={() => invoke("quit_app")}>
          {t("general.quit")}
        </Button>
        <Button size="sm" onClick={() => invoke("hide_window")}>
          {t("general.hideWindow")}
        </Button>
      </div>
    </div>
  );
}
