import { useTranslation } from "react-i18next";
import type { ParseKeys } from "i18next";
import {
  DEFAULT_COLORS,
  LABEL_CORNERS,
  STYLE_PRESETS,
  type ColorPair,
  type LabelCorner,
  type StylePreset,
  type StyleVariant,
  type Theme,
  type ThemeMode,
} from "@inkcity/core";
import type { MapDraft } from "@/lib/draft";
import { Collapsible, Pick, Sec } from "./controls";

// Each row's labels are a `Record` over its union, so a value added to the union is
// a missing-key error here rather than an option the row silently lacks. The
// presets' order stays in core, so the CLI's `--preset` and this row can't disagree.
const THEME_LABELS: Record<ThemeMode, ParseKeys> = {
  light: "style.themeLight",
  dark: "style.themeDark",
  system: "style.themeSystem",
};
const THEME_ORDER: ThemeMode[] = ["light", "dark", "system"];
const PRESET_LABELS: Record<StylePreset, ParseKeys> = {
  minimal: "style.presetMinimal",
  standard: "style.presetStandard",
  bold: "style.presetBold",
};
const CORNER_LABELS: Record<LabelCorner, ParseKeys> = {
  "top-left": "style.cityLabelTopLeft",
  "top-right": "style.cityLabelTopRight",
  "bottom-left": "style.cityLabelBottomLeft",
  "bottom-right": "style.cityLabelBottomRight",
};
const CORNER_CLASS: Record<LabelCorner, string> = { "top-left": "tl", "top-right": "tr", "bottom-left": "bl", "bottom-right": "br" };

/**
 * Style: how the map is drawn — its theme, its palette (your colours, or
 * Mondrian's), how heavy the streets are, and where the city's name goes on the
 * desktop — the city's name and where it is, or a pinned place's coordinates.
 * Edits draw straight onto the map above (the sheet sits low on this tab to show it)
 * and wait for Save, with Lab's, at the sheet's foot.
 */
export default function StyleTab({
  draft,
  onChange,
  theme,
}: {
  draft: MapDraft;
  onChange: (next: MapDraft) => void;
  /** The theme the draft draws in now. */
  theme: Theme;
}) {
  const { t } = useTranslation();
  const set = (patch: Partial<MapDraft>) => onChange({ ...draft, ...patch });

  const pair = (k: Theme, title: string) => {
    const colors = draft[k];
    const setColor = (role: keyof ColorPair, v: string) => set({ [k]: { ...colors, [role]: v } });
    return (
      <div className={`pair${theme === k ? " is-active" : ""}`}>
        <div className="pair__head">
          <span>
            {title}
            {theme === k && <span className="pair__badge">{t("style.active")}</span>}
          </span>
          <button type="button" className="ink-link" onClick={() => set({ [k]: DEFAULT_COLORS[k] })}>
            {t("style.reset")}
          </button>
        </div>
        <div className="swatches">
          <label className="swatch">
            <input type="color" value={colors.background} onChange={(e) => setColor("background", e.target.value)} />
            {t("style.background")}
            <code>{colors.background}</code>
          </label>
          <label className="swatch">
            <input type="color" value={colors.foreground} onChange={(e) => setColor("foreground", e.target.value)} />
            {t("style.foreground")}
            <code>{colors.foreground}</code>
          </label>
        </div>
      </div>
    );
  };

  return (
    <>
      <Sec label={t("style.theme")}>
        <div className="set">
          <Pick<ThemeMode>
            label={t("style.theme")}
            options={THEME_ORDER.map((m) => [m, t(THEME_LABELS[m])] as const)}
            value={draft.theme}
            onChange={(m) => set({ theme: m })}
          />
        </div>
      </Sec>

      <Sec label={t("style.palette")}>
        <div className="set">
          <Pick<StyleVariant>
            label={t("style.palette")}
            options={[
              ["ink", t("style.paletteCustom")],
              ["mondrian", t("style.paletteMondrian")],
            ]}
            value={draft.variant}
            onChange={(v) => set({ variant: v })}
          />
        </div>
        {/* Mondrian brings its own colours, so yours fold away — keeping any edit meanwhile. */}
        <Collapsible open={draft.variant !== "mondrian"}>
          <div className="pairs">
            {pair("light", t("style.lightColors"))}
            {pair("dark", t("style.darkColors"))}
          </div>
        </Collapsible>
      </Sec>

      <Sec label={t("style.mapStyle")}>
        <div className="set">
          <Pick<StylePreset>
            label={t("style.mapStyle")}
            options={STYLE_PRESETS.map((p) => [p, t(PRESET_LABELS[p])] as const)}
            value={draft.style}
            onChange={(p) => set({ style: p })}
          />
        </div>
      </Sec>

      <Sec label={t("style.cityLabel")}>
        <div className="set">
          <div className="corner-pick">
            {/* Pressing the chosen corner again takes the name off. */}
            <div className="corner">
              {LABEL_CORNERS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={CORNER_CLASS[c]}
                  aria-pressed={draft.cityLabel === c}
                  aria-label={t(CORNER_LABELS[c])}
                  title={t(CORNER_LABELS[c])}
                  onClick={() => set({ cityLabel: draft.cityLabel === c ? "off" : c })}
                >
                  <i />
                  <i />
                  <i />
                </button>
              ))}
            </div>
            <div className="set__d">{t("style.cityLabelHint")}</div>
          </div>
        </div>
      </Sec>
    </>
  );
}
