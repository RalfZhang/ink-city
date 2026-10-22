import { Trans } from "react-i18next";
import { GEONAMES_URL, OSM_COPYRIGHT_URL } from "@inkcity/core";
import { cn } from "@inkcity/ui/lib/utils";
import { SITE_OWNER_URL } from "./Footer";

/**
 * The site's copyright and the data's short credit, in the corner of every page once
 * there's a map to credit — OSM's attribution has to be in view wherever its map
 * is; the full one is in the second page's imprint (./Footer.tsx).
 */
export default function CornerCredit({ shown }: { shown: boolean }) {
  return (
    <p className={cn("corner", shown && "is-in")} inert={!shown}>
      © {new Date().getFullYear()}{" "}
      <a href={SITE_OWNER_URL} target="_blank" rel="noreferrer">
        RalfZ
      </a>
      {" · "}
      <Trans
        i18nKey="corner.credit"
        components={[
          <a href={OSM_COPYRIGHT_URL} target="_blank" rel="noreferrer" />,
          <a href={GEONAMES_URL} target="_blank" rel="noreferrer" />,
        ]}
      />
    </p>
  );
}
