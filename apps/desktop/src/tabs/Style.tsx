import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import type { ParseKeys } from "i18next";
import { Loader2 } from "lucide-react";
import { Button } from "@inkcity/ui/components/button";
import { Card, CardContent, CardFooter } from "@inkcity/ui/components/card";
import { Collapsible, CollapsibleContent } from "@inkcity/ui/components/collapsible";
import { Label } from "@inkcity/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@inkcity/ui/components/select";
import { Separator } from "@inkcity/ui/components/separator";
import { ToggleGroup, ToggleGroupItem } from "@inkcity/ui/components/toggle-group";
import { DEFAULT_COLORS, LABEL_CORNERS, STYLE_PRESETS, STYLE_VARIANTS } from "@inkcity/core";
import type { CityLabel, ColorPair, Status, StylePreset, StyleVariant, ThemeMode } from "../types";

type Props = {
  status: Status;
  busy: boolean;
  onError: (e: unknown) => void;
};

// Each row's labels are a `Record` over its union, so a value added to the union is
// a missing-key error here rather than an option the row silently lacks. The order
// is the theme's own (this toggle group is the only place that enumerates
// `ThemeMode` at runtime), but the presets' stays in core, so the CLI's `--preset`
// and this row can't disagree. (Same shape and reasoning as `RAILWAY_LABELS` in
// Lab.tsx.)
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

// The palette: your own colors (the `ink` variant) or Mondrian's, which has its own
// for each theme. A `Record` iterated in `STYLE_VARIANTS` order, for the same reason
// as `PRESET_LABELS`.
const PALETTE_LABELS: Record<StyleVariant, ParseKeys> = {
  ink: "style.paletteCustom",
  mondrian: "style.paletteMondrian",
};

// The desktop city caption's corner, "off" first, then `LABEL_CORNERS` order. A
// `Record` for the same reason as `PRESET_LABELS`: a corner added to the union is a
// missing-key error here rather than an option the selector silently lacks.
const CITY_LABELS: Record<CityLabel, ParseKeys> = {
  off: "style.cityLabelOff",
  "top-left": "style.cityLabelTopLeft",
  "top-right": "style.cityLabelTopRight",
  "bottom-left": "style.cityLabelBottomLeft",
  "bottom-right": "style.cityLabelBottomRight",
};
const CITY_LABEL_ORDER: CityLabel[] = ["off", ...LABEL_CORNERS];

export default function Style({ status, busy, onError }: Props) {
  const { t } = useTranslation();

  // Seeded from `status` on first mount only. Deliberately never re-synced from a
  // later status push, which would clobber an in-progress edit (same rule as Lab).
  const [theme, setTheme] = useState<ThemeMode>(status.theme);
  const [preset, setPreset] = useState<StylePreset>(status.style);
  const [variant, setVariant] = useState<StyleVariant>(status.variant);
  const [light, setLight] = useState<ColorPair>(status.light);
  const [dark, setDark] = useState<ColorPair>(status.dark);
  const [cityLabel, setCityLabel] = useState<CityLabel>(status.cityLabel);
  const [saving, setSaving] = useState(false);
  const sawBusy = useRef(false);

  // Release the Save button only once the regen has actually completed. `sawBusy`
  // makes us wait for `busy` to flip on first, so we don't release before the
  // pipeline has even started.
  useEffect(() => {
    if (!saving) return;
    if (busy) {
      sawBusy.current = true;
    } else if (sawBusy.current) {
      setSaving(false);
      sawBusy.current = false;
    }
  }, [busy, saving]);

  // Safety net: never let Save stay disabled longer than 2 min in case
  // pipeline:end never fires (network hang, etc.).
  useEffect(() => {
    if (!saving) return;
    const t = setTimeout(() => setSaving(false), 120_000);
    return () => clearTimeout(t);
  }, [saving]);

  const dirty =
    theme !== status.theme ||
    preset !== status.style ||
    variant !== status.variant ||
    light.background !== status.light.background ||
    light.foreground !== status.light.foreground ||
    dark.background !== status.dark.background ||
    dark.foreground !== status.dark.foreground ||
    cityLabel !== status.cityLabel;

  const save = async () => {
    setSaving(true);
    sawBusy.current = false;
    try {
      const result = await invoke<{ regenStarted: boolean }>("apply_style_settings", {
        theme,
        style: preset,
        variant,
        light,
        dark,
        cityLabel,
      });
      if (!result.regenStarted) {
        setSaving(false);
      }
    } catch (e) {
      onError(e);
      setSaving(false);
    }
  };

  return (
    <Card className="max-w-2xl">
      <CardContent className="space-y-4">
        <Section label={t("style.theme")}>
          <ChoiceGroup
            ids={THEME_ORDER}
            labels={THEME_LABELS}
            value={theme}
            onChange={setTheme}
            disabled={saving}
          />
        </Section>

        <Separator />

        {/* The palette row and the color table under it are one item of the stack,
            so a folded table leaves no gap of its own behind. */}
        <div>
          <Section label={t("style.palette")}>
            <ChoiceGroup
              ids={STYLE_VARIANTS}
              labels={PALETTE_LABELS}
              value={variant}
              onChange={setVariant}
              disabled={saving}
            />
          </Section>

          {/* Your own colors fold away while Mondrian, which brings its own, is
              picked. They keep any edit meanwhile, and Save stores them either way.
              The fold animates the height, which needs overflow-hidden; the 4px of
              padding, offset by as much negative margin, keeps the 3px focus rings
              of the controls at its edges (Reset, the color inputs) inside it. */}
          <Collapsible open={variant === "ink"}>
            <CollapsibleContent className="-m-1 overflow-hidden p-1 data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
              <div className="space-y-4 pt-4">
                <Separator />

                <PaletteSection
                  title={t("style.lightColors")}
                  active={status.effectiveTheme === "light"}
                  colors={light}
                  onChange={setLight}
                  onReset={() => setLight(DEFAULT_COLORS.light)}
                  activeLabel={t("style.active")}
                  resetLabel={t("style.reset")}
                  bgLabel={t("style.background")}
                  fgLabel={t("style.foreground")}
                  disabled={saving}
                />

                <Separator />

                <PaletteSection
                  title={t("style.darkColors")}
                  active={status.effectiveTheme === "dark"}
                  colors={dark}
                  onChange={setDark}
                  onReset={() => setDark(DEFAULT_COLORS.dark)}
                  activeLabel={t("style.active")}
                  resetLabel={t("style.reset")}
                  bgLabel={t("style.background")}
                  fgLabel={t("style.foreground")}
                  disabled={saving}
                />
              </div>
            </CollapsibleContent>
          </Collapsible>
        </div>

        <Separator />

        <Section label={t("style.mapStyle")}>
          <ChoiceGroup
            ids={STYLE_PRESETS}
            labels={PRESET_LABELS}
            value={preset}
            onChange={setPreset}
            disabled={saving}
          />
        </Section>

        <Separator />

        <Section label={t("style.cityLabel")} hint={t("style.cityLabelHint")}>
          <Select
            value={cityLabel}
            onValueChange={(v) => setCityLabel(v as CityLabel)}
            disabled={saving}
          >
            <SelectTrigger className="w-[150px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CITY_LABEL_ORDER.map((id) => (
                <SelectItem key={id} value={id}>
                  {t(CITY_LABELS[id])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Section>
      </CardContent>

      <CardFooter className="justify-end">
        <Button onClick={save} disabled={!dirty || saving} size="sm">
          {saving && <Loader2 className="animate-spin size-3.5 me-1.5" />}
          {t("style.save")}
        </Button>
      </CardFooter>
    </Card>
  );
}

function Section({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <Label className="text-sm mb-2 block">{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground mt-2">{hint}</p>}
    </div>
  );
}

// One row of mutually exclusive choices — the theme, the palette, the map style.
// A single ToggleGroup reports "" when its pressed item is clicked again; that's
// dropped, so a row always has exactly one value.
function ChoiceGroup<T extends string>({
  ids,
  labels,
  value,
  onChange,
  disabled,
}: {
  ids: readonly T[];
  labels: Record<T, ParseKeys>;
  value: T;
  onChange: (v: T) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={(v) => v && onChange(v as T)}
      variant="outline"
      size="sm"
      disabled={disabled}
    >
      {ids.map((id) => (
        <ToggleGroupItem key={id} value={id}>
          {t(labels[id])}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

function PaletteSection({
  title,
  active,
  colors,
  onChange,
  onReset,
  activeLabel,
  resetLabel,
  bgLabel,
  fgLabel,
  disabled,
}: {
  title: string;
  active: boolean;
  colors: ColorPair;
  onChange: (next: ColorPair) => void;
  onReset: () => void;
  activeLabel: string;
  resetLabel: string;
  bgLabel: string;
  fgLabel: string;
  disabled: boolean;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Label className="text-sm">{title}</Label>
          {active && (
            <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-foreground text-background font-medium">
              {activeLabel}
            </span>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={onReset} disabled={disabled}>
          {resetLabel}
        </Button>
      </div>
      <div className="flex gap-6">
        <ColorField
          label={bgLabel}
          value={colors.background}
          onChange={(v) => onChange({ ...colors, background: v })}
          disabled={disabled}
        />
        <ColorField
          label={fgLabel}
          value={colors.foreground}
          onChange={(v) => onChange({ ...colors, foreground: v })}
          disabled={disabled}
        />
      </div>
    </div>
  );
}

function ColorField({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="w-9 h-7 rounded border border-border bg-transparent cursor-pointer p-0 disabled:cursor-not-allowed disabled:opacity-50"
      />
      <span className="text-muted-foreground">{label}</span>
      <code dir="ltr" className="text-xs text-muted-foreground">{value}</code>
    </label>
  );
}
