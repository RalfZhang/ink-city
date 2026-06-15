import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import type { ParseKeys } from "i18next";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { ColorPair, Status, StylePreset, ThemeMode } from "../types";

type Props = {
  status: Status;
  busy: boolean;
  onError: (e: unknown) => void;
};

type Defaults = { light: ColorPair; dark: ColorPair };

const THEMES: { id: ThemeMode; labelKey: ParseKeys }[] = [
  { id: "light", labelKey: "style.themeLight" },
  { id: "dark", labelKey: "style.themeDark" },
  { id: "system", labelKey: "style.themeSystem" },
];

const PRESETS: { id: StylePreset; labelKey: ParseKeys; hintKey: ParseKeys }[] = [
  { id: "minimal", labelKey: "style.presetMinimal", hintKey: "style.hintMinimal" },
  { id: "standard", labelKey: "style.presetStandard", hintKey: "style.hintStandard" },
  { id: "bold", labelKey: "style.presetBold", hintKey: "style.hintBold" },
];

export default function Style({ status, busy, onError }: Props) {
  const { t } = useTranslation();

  const [theme, setTheme] = useState<ThemeMode>(status.theme);
  const [preset, setPreset] = useState<StylePreset>(status.style);
  const [light, setLight] = useState<ColorPair>(status.light);
  const [dark, setDark] = useState<ColorPair>(status.dark);
  const [showWater, setShowWater] = useState<boolean>(status.showWater);
  const [defaults, setDefaults] = useState<Defaults | null>(null);
  const [saving, setSaving] = useState(false);
  const sawBusy = useRef(false);

  // Initialize pending state from status on first mount only. We deliberately
  // do not auto-sync from later status updates so the user's in-progress
  // edits aren't clobbered by polling.

  useEffect(() => {
    invoke<Defaults>("get_color_defaults").then(setDefaults).catch(onError);
  }, []);

  // Track pipeline lifecycle to release the Save button only after regen
  // completes. `sawBusy` ensures we wait for busy to flip on first, so we
  // don't release before the pipeline has actually started.
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
    light.background !== status.light.background ||
    light.foreground !== status.light.foreground ||
    dark.background !== status.dark.background ||
    dark.foreground !== status.dark.foreground ||
    showWater !== status.showWater;

  const save = async () => {
    setSaving(true);
    sawBusy.current = false;
    try {
      const result = await invoke<{ regenStarted: boolean }>("apply_style_settings", {
        theme,
        style: preset,
        light,
        dark,
        showWater,
      });
      if (!result.regenStarted) {
        setSaving(false);
      }
    } catch (e) {
      onError(e);
      setSaving(false);
    }
  };

  const activeHintKey = PRESETS.find((p) => p.id === preset)?.hintKey;

  return (
    <Card className="max-w-2xl">
      <CardContent className="space-y-4">
        <Section label={t("style.theme")}>
          <ToggleGroup
            type="single"
            value={theme}
            onValueChange={(v) => v && setTheme(v as ThemeMode)}
            variant="outline"
            size="sm"
            disabled={saving}
          >
            {THEMES.map((it) => (
              <ToggleGroupItem key={it.id} value={it.id}>
                {t(it.labelKey)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Section>

        <Separator />

        <Section label={t("style.mapStyle")} hint={activeHintKey ? t(activeHintKey) : undefined}>
          <ToggleGroup
            type="single"
            value={preset}
            onValueChange={(v) => v && setPreset(v as StylePreset)}
            variant="outline"
            size="sm"
            disabled={saving}
          >
            {PRESETS.map((p) => (
              <ToggleGroupItem key={p.id} value={p.id}>
                {t(p.labelKey)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Section>

        <Separator />

        {/* Water toggle — only shown when the current city's data has water.
            Left/right row like the General tab. The hint is always rendered (not
            gated on the switch) so toggling never shifts the layout below it. */}
        {status.hasWater && (
          <>
            <div className="flex items-center justify-between gap-4">
              <div className="flex-1 min-w-0">
                <Label className="text-sm">{t("style.showWater")}</Label>
                <p className="text-xs text-muted-foreground mt-0.5">{t("style.waterHint")}</p>
              </div>
              <Switch checked={showWater} onCheckedChange={setShowWater} disabled={saving} />
            </div>

            <Separator />
          </>
        )}

        <PaletteSection
          title={t("style.lightColors")}
          active={status.effectiveTheme === "light"}
          colors={light}
          onChange={setLight}
          onReset={() => defaults && setLight(defaults.light)}
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
          onReset={() => defaults && setDark(defaults.dark)}
          activeLabel={t("style.active")}
          resetLabel={t("style.reset")}
          bgLabel={t("style.background")}
          fgLabel={t("style.foreground")}
          disabled={saving}
        />
      </CardContent>

      <CardFooter className="justify-end">
        <Button onClick={save} disabled={!dirty || saving} size="sm">
          {saving && <Loader2 className="animate-spin size-3.5 mr-1.5" />}
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
      <code className="text-xs text-muted-foreground">{value}</code>
    </label>
  );
}
