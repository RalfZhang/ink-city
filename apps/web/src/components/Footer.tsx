import type { ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Languages } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@inkcity/ui/components/select";
import {
  CC_BY_URL,
  GEONAMES_URL,
  GITHUB_REPO,
  ODBL_URL,
  OSM_COPYRIGHT_URL,
  VISUAL_DESIGNER,
} from "@inkcity/core";
import { LOCALES, setLanguage, type LocaleCode } from "../i18n";

// Children are supplied by <Trans> through the placeholder tags.
function ExtLink({ href, children }: { href: string; children?: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foreground">
      {children}
    </a>
  );
}

/**
 * The data's attribution — a licence obligation for both sources, and OSM's has to
 * be visible wherever its map is — the designer's credit, the source, and the
 * language.
 */
export default function Footer() {
  const { t, i18n } = useTranslation();
  return (
    <footer className="space-y-3 px-1 pb-1 text-xs text-muted-foreground">
      <div className="space-y-1">
        <p>
          <Trans i18nKey="footer.osm" components={[<ExtLink href={OSM_COPYRIGHT_URL} />, <ExtLink href={ODBL_URL} />]} />
        </p>
        <p>
          <Trans i18nKey="footer.geonames" components={[<ExtLink href={GEONAMES_URL} />, <ExtLink href={CC_BY_URL} />]} />
        </p>
        <p>{t("footer.credit", { name: VISUAL_DESIGNER })}</p>
      </div>
      <div className="flex items-center justify-between gap-2">
        <ExtLink href={GITHUB_REPO}>{t("footer.source")}</ExtLink>
        <Select value={i18n.language} onValueChange={(v) => setLanguage(v as LocaleCode)}>
          <SelectTrigger size="sm" className="h-7 gap-1.5 text-xs" aria-label={t("footer.language")}>
            <Languages className="size-3.5" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LOCALES.map((l) => (
              <SelectItem key={l.code} value={l.code}>
                {l.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </footer>
  );
}
