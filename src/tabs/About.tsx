import { openUrl } from "@tauri-apps/plugin-opener";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { GITHUB_ISSUES, GITHUB_REPO } from "../constants";

export default function About() {
  const { t } = useTranslation();

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
    </div>
  );
}
