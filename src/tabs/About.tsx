import { useEffect, useState, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getVersion } from "@tauri-apps/api/app";
import { Trans, useTranslation } from "react-i18next";
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

export default function About() {
  const { t } = useTranslation();
  const [version, setVersion] = useState("");

  useEffect(() => {
    getVersion().then(setVersion).catch(() => {});
  }, []);

  return (
    <div className="space-y-6 max-w-2xl">
      <Card>
        <CardContent>
          <h2 className="text-base font-semibold">InkCity</h2>
          <p className="text-sm text-muted-foreground mt-1">{t("about.p1")}</p>
          <p className="text-sm text-muted-foreground mt-2">{t("about.p2")}</p>
        </CardContent>
        <CardFooter className="justify-end">
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
