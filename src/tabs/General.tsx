import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getLocaleChoice, setLocaleChoice, type LocaleChoice } from "../i18n";
import type { Status, UpdateCheck } from "../types";

type Props = {
  status: Status;
  refresh: () => Promise<void>;
  onError: (e: unknown) => void;
};

// Transient UI feedback only. Whether an update *is available* is no longer
// tracked here — it's read from `status.updateAvailable` (the Rust source of
// truth), so it survives tab switches and window reopens.
type UpdateState =
  | "idle"
  | "checking"
  | "installing"
  | "uptodate"
  | "unavailable"
  | "error";

// A failed update check isn't always a fault. During the brief release window a
// freshly-tagged release can be "latest" before its latest.json asset finishes
// uploading (the endpoint 404s), and users are frequently just offline. Treat
// those transport-/availability-level failures as a calm "unavailable" state
// rather than an alarming "check failed"; reserve the error state for genuinely
// unexpected failures such as a malformed manifest.
function isBenignUpdateError(e: unknown): boolean {
  const msg = (
    e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e ?? "")
  ).toLowerCase();
  return [
    "404",
    "not found",
    "releasenotfound",
    "network",
    "timed out",
    "timeout",
    "dns",
    "connect",
    "offline",
    "sending request",
    "failed to fetch",
  ].some((s) => msg.includes(s));
}

export default function General({ status, refresh, onError }: Props) {
  const { t } = useTranslation();
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [locale, setLocale] = useState<LocaleChoice>(getLocaleChoice());
  const [updateState, setUpdateState] = useState<UpdateState>("idle");

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

  const pickUpdateCheck = async (v: UpdateCheck) => {
    try {
      await invoke("set_update_check", { value: v });
      await refresh();
    } catch (e) {
      onError(e);
    }
  };

  const checkForUpdate = async () => {
    setUpdateState("checking");
    try {
      // Rust runs the check, updates the shared state (tray + status), and
      // returns the version (or null). The 2s status poll surfaces the
      // "available" affordance; we just clear the transient feedback.
      const version = await invoke<string | null>("check_for_update");
      await refresh();
      setUpdateState(version ? "idle" : "uptodate");
    } catch (e) {
      console.error("[updater] check failed", e);
      setUpdateState(isBenignUpdateError(e) ? "unavailable" : "error");
    }
  };

  const installUpdate = async () => {
    setUpdateState("installing");
    try {
      // Rust re-checks, downloads, installs, then relaunches — so on success
      // this never resolves. `false` means there was nothing to install.
      const installed = await invoke<boolean>("install_update");
      if (!installed) {
        await refresh();
        setUpdateState("uptodate");
      }
    } catch (e) {
      console.error("[updater] install failed", e);
      setUpdateState(isBenignUpdateError(e) ? "unavailable" : "error");
    }
  };

  const updateBusy = updateState === "checking" || updateState === "installing";

  return (
    <div className="min-h-full space-y-6 max-w-2xl flex flex-col justify-between">
      <Card>
        <CardContent className="space-y-4">
          <Row
            label={t("general.enabledLabel")}
            description={t("general.enabledDesc")}
            control={<Switch checked={status.enabled} onCheckedChange={toggleEnabled} />}
          />
          <Separator />
          <Row
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
          <Row
            label={t("general.hideTrayLabel")}
            description={
              status.hide_tray
                ? t("general.hideTrayDescOn")
                : t("general.hideTrayDescOff")
            }
            control={<Switch checked={status.hide_tray} onCheckedChange={toggleHideTray} />}
          />
          <Separator />
          <div className="space-y-3">
            <Row
              label={t("general.updateCheckLabel")}
              description={t("general.updateCheckDesc")}
              control={
                <Select
                  value={status.updateCheck}
                  onValueChange={(v) => pickUpdateCheck(v as UpdateCheck)}
                >
                  <SelectTrigger className="w-[150px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="daily">{t("general.updateDaily")}</SelectItem>
                    <SelectItem value="weekly">{t("general.updateWeekly")}</SelectItem>
                    <SelectItem value="monthly">{t("general.updateMonthly")}</SelectItem>
                    <SelectItem value="never">{t("general.updateNever")}</SelectItem>
                  </SelectContent>
                </Select>
              }
            />
            <div className="flex items-center gap-2">
              {status.updateAvailable || updateState === "installing" ? (
                <Button size="sm" onClick={installUpdate} disabled={updateBusy}>
                  {updateState === "installing" && <Loader2 className="animate-spin" />}
                  {t(updateState === "installing" ? "general.installing" : "general.installRestart")}
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={checkForUpdate}
                  disabled={updateBusy}
                >
                  {updateState === "checking" && <Loader2 className="animate-spin" />}
                  {t(updateState === "checking" ? "general.checking" : "general.checkNow")}
                </Button>
              )}
              <span className="text-xs text-muted-foreground">
                {status.updateAvailable
                  ? t("general.updateAvailable", { version: status.updateAvailable })
                  : updateState === "uptodate"
                    ? t("general.upToDate")
                    : updateState === "unavailable"
                      ? t("general.updateUnavailable")
                      : updateState === "error"
                        ? t("general.updateError")
                        : null}
              </span>
            </div>
          </div>
          <Separator />
          <Row
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

function Row({
  label,
  description,
  control,
}: {
  label: string;
  description?: string;
  control: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex-1 min-w-0">
        <Label className="text-sm">{label}</Label>
        {description && (
          <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
        )}
      </div>
      {control}
    </div>
  );
}
