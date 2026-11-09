import { useTranslation } from "react-i18next";
import type { ParseKeys } from "i18next";
import { RAILWAY_STYLES, type RailwayStyle, type Theme } from "@inkcity/core";
import { styleOf, type MapDraft } from "@/lib/draft";
import Sample, { SCENES } from "./Sample";
import { Check, Sec } from "./controls";

// A `Record` over the union, iterated in `RAILWAY_STYLES` order: a mode added to
// `RailwayStyle` is a missing-key error here rather than a sample the row lacks.
const RAILWAY_LABELS: Record<RailwayStyle, ParseKeys> = {
  off: "lab.railwayOff",
  plain: "lab.railwayPlain",
  banded: "lab.railwayBanded",
  ties: "lab.railwayTies",
};

type Layer = "showWater" | "showAirports" | "showAerialways";

/**
 * Lab: the experimental layers — water, airports, cable cars, railways — each with
 * a sample of what it draws (./Sample.tsx). Every control is shown whether or not
 * today's city carries the data: a city without it just draws nothing for it.
 * Shares Style's draft and its one Save.
 */
export default function LabTab({ draft, onChange, theme }: { draft: MapDraft; onChange: (next: MapDraft) => void; theme: Theme }) {
  const { t } = useTranslation();
  const set = (patch: Partial<MapDraft>) => onChange({ ...draft, ...patch });
  const bare = styleOf({ ...draft, showWater: false, showAirports: false, railwayStyle: "off", showAerialways: false }, theme);

  const layer = (k: Layer, name: string, hint: string, scene: keyof typeof SCENES) => (
    <div className="layer">
      <Check label={name} checked={draft[k]} onChange={(on) => set({ [k]: on })} />
      <span className="tile__img">
        <Sample scene={scene} style={{ ...bare, [k]: true }} />
      </span>
      <div className="set__t">
        <div className="set__k">{name}</div>
        <div className="set__d">{hint}</div>
      </div>
    </div>
  );

  return (
    <>
      <p className="lab-intro">{t("lab.intro")}</p>
      <Sec label={t("lab.layers")}>
        {layer("showWater", t("lab.showWater"), t("lab.waterHint"), "water")}
        {layer("showAirports", t("lab.showAirports"), t("lab.airportsHint"), "airport")}
        {layer("showAerialways", t("lab.showAerialways"), t("lab.aerialwaysHint"), "cable")}
      </Sec>
      <Sec label={t("lab.railwayStyle")}>
        <div className="set">
          <div className="tiles tiles--rail">
            {RAILWAY_STYLES.map((r) => (
              <button
                key={r}
                type="button"
                className="tile"
                aria-pressed={draft.railwayStyle === r}
                aria-label={t(RAILWAY_LABELS[r])}
                title={t(RAILWAY_LABELS[r])}
                onClick={() => set({ railwayStyle: r })}
              >
                <span className="tile__img">
                  {/* None: the box struck through, corner to corner. Otherwise the track as a legend draws it. */}
                  {r === "off" ? (
                    <svg className="tile__none" viewBox="0 0 10 10" preserveAspectRatio="none" aria-hidden>
                      <path d="M0 0 10 10M10 0 0 10" />
                    </svg>
                  ) : (
                    <Sample scene="rail" style={{ ...bare, railwayStyle: r }} />
                  )}
                </span>
              </button>
            ))}
          </div>
        </div>
      </Sec>
    </>
  );
}
