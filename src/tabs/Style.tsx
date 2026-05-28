import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { ColorPair, Status, ThemeMode } from "../types";

type Props = {
  status: Status;
  busy: boolean;
  refresh: () => Promise<void>;
  onError: (e: unknown) => void;
};

const THEMES: { id: ThemeMode; label: string }[] = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "system", label: "Follow system" },
];

export default function Style({ status, busy, refresh, onError }: Props) {
  const pickTheme = async (mode: ThemeMode) => {
    try {
      await invoke("set_theme", { mode });
      await refresh();
    } catch (e) {
      onError(e);
    }
  };

  return (
    <div className="relative space-y-6 max-w-2xl overflow-hidden">
      {busy && (
        <div
          className="absolute inset-0 z-100 flex items-center justify-center gap-2 m-0 bg-background/65 backdrop-blur-sm rounded-md text-sm"
          role="status"
          aria-live="polite"
        >
          <span className="inline-block size-3 rounded-full border-2 border-border border-t-foreground animate-spin" />
          <span>Re-rendering wallpaper…</span>
        </div>
      )}

      <Card>
        <CardContent>
          <Label className="text-sm mb-3 block">Theme</Label>
          <ToggleGroup
            type="single"
            value={status.theme}
            onValueChange={(v) => v && pickTheme(v as ThemeMode)}
            variant="outline"
            size="sm"
          >
            {THEMES.map((t) => (
              <ToggleGroupItem key={t.id} value={t.id}>
                {t.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </CardContent>
      </Card>

      <ColorEditor
        mode="light"
        title="Light mode wallpaper colors"
        colors={status.light}
        active={status.effectiveTheme === "light"}
        refresh={refresh}
        onError={onError}
      />
      <ColorEditor
        mode="dark"
        title="Dark mode wallpaper colors"
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
  title,
  colors,
  active,
  refresh,
  onError,
}: {
  mode: "light" | "dark";
  title: string;
  colors: ColorPair;
  active: boolean;
  refresh: () => Promise<void>;
  onError: (e: unknown) => void;
}) {
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
            <Label className="text-sm">{title}</Label>
            {active && (
              <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-foreground text-background font-medium">
                Active
              </span>
            )}
          </div>
          <Button variant="ghost" size="sm" onClick={reset}>
            Reset
          </Button>
        </div>
        <div className="flex gap-6">
          <ColorField
            label="Background"
            value={colors.background}
            onChange={(v) => update({ background: v })}
          />
          <ColorField
            label="Foreground"
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
