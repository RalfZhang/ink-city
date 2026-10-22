import type { ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { CC_BY_URL, GEONAMES_URL, ODBL_URL, OSM_COPYRIGHT_URL, VISUAL_DESIGNER } from "@inkcity/core";

// Children are supplied by <Trans> through the placeholder tags.
function ExtLink({ href, children }: { href: string; children?: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="ink-link">
      {children}
    </a>
  );
}

/** Who the site is by, for its copyright line. */
export const SITE_OWNER_URL = "https://ralfz.com/";

/**
 * The imprint, at the foot of the second page: the data's attribution in full — a
 * licence obligation for both sources; the corner keeps their short credit in view
 * on every page (./CornerCredit.tsx) — the designer's credit and the site's
 * copyright. The source is the mark in the top corner (./TopBar.tsx).
 */
export default function Footer() {
  const { t } = useTranslation();
  return (
    <footer className="imprint">
      <p>
        <Trans i18nKey="footer.osm" components={[<ExtLink href={OSM_COPYRIGHT_URL} />, <ExtLink href={ODBL_URL} />]} />
      </p>
      <p>
        <Trans i18nKey="footer.geonames" components={[<ExtLink href={GEONAMES_URL} />, <ExtLink href={CC_BY_URL} />]} />
      </p>
      <p>{t("footer.credit", { name: VISUAL_DESIGNER })}</p>
      <p className="imprint__last">
        © {new Date().getFullYear()} <ExtLink href={SITE_OWNER_URL}>RalfZ</ExtLink>
      </p>
    </footer>
  );
}
