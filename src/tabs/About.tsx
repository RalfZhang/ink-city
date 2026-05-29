import { useEffect, useState, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getVersion } from "@tauri-apps/api/app";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { Trans, useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import {
  GITHUB_ISSUES,
  GITHUB_REPO,
  OSM_COPYRIGHT_URL,
  ODBL_URL,
  GEONAMES_URL,
  CC_BY_URL,
} from "../constants";

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

type UpdateState = "idle" | "checking" | "available" | "installing" | "uptodate" | "error";

export default function About() {
  const { t } = useTranslation();
  const [state, setState] = useState<UpdateState>("idle");
  const [pending, setPending] = useState<Update | null>(null);
  const [version, setVersion] = useState("");

  useEffect(() => {
    getVersion().then(setVersion).catch(() => {});
  }, []);

  async function checkForUpdate() {
    setState("checking");
    try {
      const upd = await check();
      if (upd) {
        setPending(upd);
        setState("available");
      } else {
        setState("uptodate");
      }
    } catch (e) {
      console.error("[updater] check failed", e);
      setState("error");
    }
  }

  async function installUpdate() {
    if (!pending) return;
    setState("installing");
    try {
      // Downloads, installs, then relaunches into the new version.
      await pending.downloadAndInstall();
      await relaunch();
    } catch (e) {
      console.error("[updater] install failed", e);
      setState("error");
    }
  }

  const busy = state === "checking" || state === "installing";

  return (
    <div className="space-y-6 max-w-2xl">
      <Card>
        <CardContent>
          <h2 className="text-base font-semibold">InkCity</h2>
          <p className="text-sm text-muted-foreground mt-1">{t("about.p1")}</p>
          <p className="text-sm text-muted-foreground mt-2">{t("about.p2")}</p>
        </CardContent>
        <CardFooter className="justify-between">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            {state === "available" || state === "installing" ? (
              <Button size="sm" onClick={installUpdate} disabled={busy}>
                {state === "installing" && <Loader2 className="animate-spin" />}
                {t(state === "installing" ? "about.installing" : "about.installRestart")}
              </Button>
            ) : (
              <Button variant="outline" size="sm" onClick={checkForUpdate} disabled={busy}>
                {state === "checking" && <Loader2 className="animate-spin" />}
                {t(state === "checking" ? "about.checking" : "about.checkUpdates")}
              </Button>
            )}
            {state === "available" && (
              <span>{t("about.updateAvailable", { version: pending?.version })}</span>
            )}
            {state === "uptodate" && <span>{t("about.upToDate")}</span>}
            {state === "error" && <span>{t("about.updateError")}</span>}
          </div>
          <Button variant="outline" size="sm" onClick={() => openUrl(GITHUB_REPO)}>
            {t("about.github")}
          </Button>
        </CardFooter>
      </Card>

      <Card>
        <CardContent>
          <h2 className="text-base font-semibold">{t("about.feedbackTitle")}</h2>
          <p className="text-sm text-muted-foreground mt-1">{t("about.feedbackDesc")}</p>
        </CardContent>
        <CardFooter className="justify-end">
          <Button variant="outline" size="sm" onClick={() => openUrl(GITHUB_ISSUES)}>
            {t("about.openIssues")}
          </Button>
        </CardFooter>
      </Card>

      <Card>
        <CardContent>
          <h2 className="text-base font-semibold">{t("about.dataTitle")}</h2>
          <p className="text-sm text-muted-foreground mt-1">
            <Trans
              i18nKey="about.osmAttribution"
              components={[<ExtLink href={OSM_COPYRIGHT_URL} />, <ExtLink href={ODBL_URL} />]}
            />
          </p>
          <p className="text-sm text-muted-foreground mt-2">
            <Trans
              i18nKey="about.geonamesAttribution"
              components={[<ExtLink href={GEONAMES_URL} />, <ExtLink href={CC_BY_URL} />]}
            />
          </p>
        </CardContent>
      </Card>

      <p className="text-center text-xs text-muted-foreground">
        {version ? `InkCity v${version}` : "InkCity"} · © 2026 Ralf Zhang
      </p>
    </div>
  );
}
