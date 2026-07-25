import { useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getVersion } from "@tauri-apps/api/app";
import { Trans, useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
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
import { logError } from "@/lib/log";
import {
  GITHUB_ISSUES,
  GITHUB_REPO,
  OSM_COPYRIGHT_URL,
  ODBL_URL,
  GEONAMES_URL,
  CC_BY_URL,
} from "../constants";
import type { Status, UpdateCheck } from "../types";

type Props = {
  status: Status;
  refresh: () => Promise<void>;
  onError: (e: unknown) => void;
  onToggleDevMode: () => void;
};

// Clicks reset if more than this elapses between them, so it takes seven
// clicks *in a row* (per the feature request), not seven cumulative clicks
// over an arbitrarily long session.
const DEV_MODE_CLICK_WINDOW_MS = 1500;
const DEV_MODE_CLICKS_REQUIRED = 7;

// Transient UI feedback only. Whether an update *is available* is read from
// `status.updateAvailable` (the Rust source of truth), so it survives tab
// switches and window reopens.
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

// Inline external link that opens in the system browser (anchors would navigate
// the webview). Children are supplied by <Trans> via the placeholder tags.
function ExtLink({ href, children }: { href: string; children?: ReactNode }) {
  return (
    <button
      type="button"
      onClick={() => openUrl(href)}
      className="underline underline-offset-2 hover:text-foreground"
    >
      {children}
    </button>
  );
}

export default function About({ status, refresh, onError, onToggleDevMode }: Props) {
  const { t } = useTranslation();
  const [version, setVersion] = useState("");
  const [updateState, setUpdateState] = useState<UpdateState>("idle");
  const versionClicks = useRef<{ count: number; last: number }>({ count: 0, last: 0 });

  useEffect(() => {
    getVersion().then(setVersion).catch(() => {});
  }, []);

  const onVersionClick = () => {
    const now = Date.now();
    const clicks = versionClicks.current;
    clicks.count = now - clicks.last <= DEV_MODE_CLICK_WINDOW_MS ? clicks.count + 1 : 1;
    clicks.last = now;
    if (clicks.count >= DEV_MODE_CLICKS_REQUIRED) {
      clicks.count = 0;
      onToggleDevMode();
    }
  };

  const openLogs = async () => {
    try {
      await invoke("open_log_dir");
    } catch (e) {
      onError(e);
    }
  };

  const pickUpdateCheck = async (v: UpdateCheck) => {
    try {
      await invoke("set_update_check", { value: v });
      await refresh();
    } catch (e) {
      onError(e);
    }
  };

  const toggleAutoUpdate = async (on: boolean) => {
    try {
      await invoke("set_auto_update", { on });
      await refresh();
    } catch (e) {
      onError(e);
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
      logError("[updater] install failed", e);
      setUpdateState(isBenignUpdateError(e) ? "unavailable" : "error");
    }
  };

  const checkForUpdate = async () => {
    setUpdateState("checking");
    try {
      // Rust runs the check, updates the shared state (tray + status), and
      // returns the version (or null). The status push surfaces the "available"
      // affordance; we just drive the transient feedback here.
      const version = await invoke<string | null>("check_for_update");
      await refresh();
      if (!version) {
        setUpdateState("uptodate");
        return;
      }
      // With auto-update on (the default), a manual check that finds a new
      // version goes straight to download → install → restart, mirroring the
      // background path. When the user has turned auto-update off, fall back to
      // surfacing the explicit "Install & restart" button (`idle`).
      if (status.autoUpdate) {
        await installUpdate();
      } else {
        setUpdateState("idle");
      }
    } catch (e) {
      logError("[updater] check failed", e);
      setUpdateState(isBenignUpdateError(e) ? "unavailable" : "error");
    }
  };

  const updateBusy = updateState === "checking" || updateState === "installing";

  return (
    <div className="min-h-full space-y-4 max-w-2xl flex flex-col justify-between">
      <div>
        <Card className='mb-4'>
          <CardContent>
            <h2 className="text-base font-semibold">InkCity</h2>
            <p className="text-sm text-muted-foreground mt-1">{t("about.p1")}</p>
            <p className="text-sm text-muted-foreground mt-2">{t("about.p2")}</p>
          </CardContent>
          <CardFooter className="justify-end">
            <Button className="min-w-28" variant="outline" size="sm" onClick={() => openUrl(GITHUB_REPO)}>
              {t("about.github")}
            </Button>
          </CardFooter>
        </Card>

        <Card className='mb-4'>
          <CardContent className="space-y-4">
              <SettingRow
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
              <Separator />
              <SettingRow
                label={t("general.autoUpdateLabel")}
                description={t("general.autoUpdateDesc")}
                control={
                  <Switch
                    checked={status.autoUpdate}
                    disabled={status.updateCheck === "never"}
                    onCheckedChange={toggleAutoUpdate}
                  />
                }
              />
          </CardContent>
          <CardFooter className="justify-end gap-2">
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
            {status.updateAvailable || updateState === "installing" ? (
              <Button className="min-w-28" size="sm" onClick={installUpdate} disabled={updateBusy}>
                {updateState === "installing" && <Loader2 className="animate-spin" />}
                {t(updateState === "installing" ? "general.installing" : "general.installRestart")}
              </Button>
            ) : (
              <Button
                className="min-w-28"
                variant="outline"
                size="sm"
                onClick={checkForUpdate}
                disabled={updateBusy}
              >
                {updateState === "checking" && <Loader2 className="animate-spin" />}
                {t(updateState === "checking" ? "general.checking" : "general.checkNow")}
              </Button>
            )}
          </CardFooter>
        </Card>

        <Card className='mb-4'>
          <CardContent className="space-y-4">
            <SettingRow
              label={t("about.feedbackTitle")}
              description={t("about.feedbackDesc")}
              control={
                <Button variant="outline" size="sm" onClick={() => openUrl(GITHUB_ISSUES)}>
                  {t("about.openIssues")}
                </Button>
              }
            />
            <Separator />
            <SettingRow
              label={t("about.logsTitle")}
              description={t("about.logsDesc")}
              control={
                <Button className="min-w-28" variant="outline" size="sm" onClick={openLogs}>
                  {t("about.openLogs")}
                </Button>
              }
            />
            <Separator />
            <SettingRow
              label={t("about.dataTitle")}
              description={
                <>
                  <p>
                    <Trans
                      i18nKey="about.osmAttribution"
                      components={[<ExtLink href={OSM_COPYRIGHT_URL} />, <ExtLink href={ODBL_URL} />]}
                    />
                  </p>
                  <p>
                    <Trans
                      i18nKey="about.geonamesAttribution"
                      components={[<ExtLink href={GEONAMES_URL} />, <ExtLink href={CC_BY_URL} />]}
                    />
                  </p>
                </>
              }
            />
          </CardContent>
        </Card>
      </div>

      <p className="text-center text-xs text-muted-foreground mb-4">
        <span onClick={onVersionClick}>{version ? `InkCity v${version}` : "InkCity"}</span> · © 2026
        Ralf Zhang
      </p>
    </div>
  );
}
