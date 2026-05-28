import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { ColorPair, Status, StylePreset, ThemeMode } from "../types";

type Props = {
  status: Status;
  busy: boolean;
  refresh: () => Promise<void>;
  onError: (e: unknown) => void;
};

const THEMES: { id: ThemeMode; labelKey: string }[] = [
  { id: "light", labelKey: "style.themeLight" },
  { id: "dark", labelKey: "style.themeDark" },
  { id: "system", labelKey: "style.themeSystem" },
];

const PRESETS: { id: StylePreset; labelKey: string; hintKey: string }[] = [
  { id: "minimal", labelKey: "style.presetMinimal", hintKey: "style.hintMinimal" },
  { id: "standard", labelKey: "style.presetStandard", hintKey: "style.hintStandard" },
  { id: "bold", labelKey: "style.presetBold", hintKey: "style.hintBold" },
];

export default function Style({ status, busy, refresh, onError }: Props) {
  const { t } = useTranslation();

  const pickTheme = async (mode: ThemeMode) => {
    try {
      await invoke("set_theme", { mode });
      await refresh();
    } catch (e) {
      onError(e);
    }
  };

  const pickStyle = async (preset: StylePreset) => {
    try {
      await invoke("set_style", { preset });
      await refresh();
    } catch (e) {
      onError(e);
    }
  };

  const activeHintKey = PRESETS.find((p) => p.id === status.style)?.hintKey;

  return (
    <div className="relative space-y-6 max-w-2xl">
      {busy && (
        <div
          className="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-background/65 backdrop-blur-sm text-sm"
          role="status"
          aria-live="polite"
        >
          <span className="inline-block size-3 rounded-full border-2 border-border border-t-foreground animate-spin" />
          <span>{t("style.rerendering")}</span>
        </div>
      )}

      <Card>
        <CardContent>
          <Label className="text-sm mb-3 block">{t("style.theme")}</Label>
          <ToggleGroup
            type="single"
            value={status.theme}
            onValueChange={(v) => v && pickTheme(v as ThemeMode)}
            variant="outline"
            size="sm"
          >
            {THEMES.map((it) => (
              <ToggleGroupItem key={it.id} value={it.id}>
                {t(it.labelKey)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <Label className="text-sm mb-3 block">{t("style.mapStyle")}</Label>
          <ToggleGroup
            type="single"
            value={status.style}
            onValueChange={(v) => v && pickStyle(v as StylePreset)}
            variant="outline"
            size="sm"
          >
            {PRESETS.map((p) => (
              <ToggleGroupItem key={p.id} value={p.id}>
                {t(p.labelKey)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          {activeHintKey && (
            <p className="text-xs text-muted-foreground mt-2">{t(activeHintKey)}</p>
          )}
        </CardContent>
      </Card>

      <ColorEditor
        mode="light"
        titleKey="style.lightColors"
        colors={status.light}
        active={status.effectiveTheme === "light"}
        refresh={refresh}
        onError={onError}
      />
      <ColorEditor
        mode="dark"
        titleKey="style.darkColors"
        colors={status.dark}
        active={status.effectiveTheme === "dark"}
        refresh={refresh}
        onError={onError}
      />
    </div>
  );
}

function ColorEditor({
  mode,
  titleKey,
  colors,
  active,
  refresh,
  onError,
}: {
  mode: "light" | "dark";
  titleKey: string;
  colors: ColorPair;
  active: boolean;
  refresh: () => Promise<void>;
  onError: (e: unknown) => void;
}) {
  const { t } = useTranslation();

  const update = async (next: Partial<ColorPair>) => {
    const merged = { ...colors, ...next };
    try {
      await invoke("set_colors", { mode, background: merged.background, foreground: merged.foreground });
      await refresh();
    } catch (e) {
      onError(e);
    }
  };

  const reset = async () => {
    try {
      await invoke("reset_colors", { mode });
      await refresh();
    } catch (e) {
      onError(e);
    }
  };

  return (
    <Card>
      <CardContent>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Label className="text-sm">{t(titleKey)}</Label>
            {active && (
              <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-foreground text-background font-medium">
                {t("style.active")}
              </span>
            )}
          </div>
          <Button variant="ghost" size="sm" onClick={reset}>
            {t("style.reset")}
          </Button>
        </div>
        <div className="flex gap-6">
          <ColorField
            label={t("style.background")}
            value={colors.background}
            onChange={(v) => update({ background: v })}
          />
          <ColorField
            label={t("style.foreground")}
            value={colors.foreground}
            onChange={(v) => update({ foreground: v })}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-9 h-7 rounded border border-border bg-transparent cursor-pointer p-0"
      />
      <span className="text-muted-foreground">{label}</span>
      <code className="text-xs text-muted-foreground">{value}</code>
    </label>
  );
}
