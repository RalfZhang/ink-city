import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import type { ParseKeys } from "i18next";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import SettingRow from "@/components/SettingRow";
import { RAILWAY_STYLES } from "@/core";
import type { RailwayStyle, Status, StyleVariant } from "../types";

// The railway row is a selector rather than a switch: "don't draw" is one of the
// symbol choices, not a separate dimension (see RailwayStyle). Each option's own
// weights and opacity live in `RAILWAY_MODES` in core/render.ts.
//
// A `Record` over the union, iterated in `RAILWAY_STYLES` order, rather than
// Style.tsx's hand-ordered `{ id, labelKey }[]`: this one has to stay in step with
// the renderer, so a mode added to `RailwayStyle` should be a missing-key error
// here — with a list, it would just be silently absent from the selector. Order
// stays in core so the CLI's `--rail` and this row can't disagree. `ParseKeys` is
// what makes a mistyped locale key fail here rather than fall back to the raw key
// in the UI.
const RAILWAY_LABELS: Record<RailwayStyle, ParseKeys> = {
  off: "lab.railwayOff",
  plain: "lab.railwayPlain",
  banded: "lab.railwayBanded",
  ties: "lab.railwayTies",
};

type Props = {
  status: Status;
  busy: boolean;
  onError: (e: unknown) => void;
};

// "Lab": the experimental map settings — the four optional data layers plus the
// Mondrian variant. Every control is shown unconditionally, whether or not today's
// city carries that layer: a city without the data just renders nothing for it, so
// nothing has to probe the OSM payload first. Mirrors the Style tab's save/regen
// lifecycle: Save stays disabled until an edit is made, then spins until the
// wallpaper re-render (triggered by apply_lab_settings) completes.
export default function Lab({ status, busy, onError }: Props) {
  const { t } = useTranslation();

  // Seeded from `status` on first mount only — see the same note in Style.tsx.
  const [showAirports, setShowAirports] = useState<boolean>(status.showAirports);
  const [showWater, setShowWater] = useState<boolean>(status.showWater);
  const [railwayStyle, setRailwayStyle] = useState<RailwayStyle>(status.railwayStyle);
  const [showAerialways, setShowAerialways] = useState<boolean>(status.showAerialways);
  const [variant, setVariant] = useState<StyleVariant>(status.variant);
  const [saving, setSaving] = useState(false);
  const sawBusy = useRef(false);

  // Release the Save button only after the regen actually completes. `sawBusy`
  // makes us wait for busy to flip on first, so we don't release prematurely.
  useEffect(() => {
    if (!saving) return;
    if (busy) {
      sawBusy.current = true;
    } else if (sawBusy.current) {
      setSaving(false);
      sawBusy.current = false;
    }
  }, [busy, saving]);

  // Safety net: never leave Save disabled longer than 2 min in case
  // pipeline:end never fires (network hang, etc.).
  useEffect(() => {
    if (!saving) return;
    const timer = setTimeout(() => setSaving(false), 120_000);
    return () => clearTimeout(timer);
  }, [saving]);

  const dirty =
    showAirports !== status.showAirports ||
    showWater !== status.showWater ||
    railwayStyle !== status.railwayStyle ||
    showAerialways !== status.showAerialways ||
    variant !== status.variant;

  const save = async () => {
    setSaving(true);
    sawBusy.current = false;
    try {
      const result = await invoke<{ regenStarted: boolean }>("apply_lab_settings", {
        settings: { showAirports, showWater, railwayStyle, showAerialways, variant },
      });
      if (!result.regenStarted) setSaving(false);
    } catch (e) {
      onError(e);
      setSaving(false);
    }
  };

  return (
    <Card className="max-w-2xl">
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{t("lab.intro")}</p>

        <SettingRow
          label={t("lab.showWater")}
          description={t("lab.waterHint")}
          control={<Switch checked={showWater} onCheckedChange={setShowWater} disabled={saving} />}
        />

        <Separator />

        <SettingRow
          label={t("lab.showAirports")}
          description={t("lab.airportsHint")}
          control={
            <Switch checked={showAirports} onCheckedChange={setShowAirports} disabled={saving} />
          }
        />

        <Separator />

        <SettingRow
          label={t("lab.railwayStyle")}
          description={t("lab.railwaysHint")}
          control={
            <Select
              value={railwayStyle}
              onValueChange={(v) => setRailwayStyle(v as RailwayStyle)}
              disabled={saving}
            >
              <SelectTrigger className="w-[150px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RAILWAY_STYLES.map((id) => (
                  <SelectItem key={id} value={id}>
                    {t(RAILWAY_LABELS[id])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />

        <Separator />

        <SettingRow
          label={t("lab.showAerialways")}
          description={t("lab.aerialwaysHint")}
          control={
            <Switch checked={showAerialways} onCheckedChange={setShowAerialways} disabled={saving} />
          }
        />

        <Separator />

        <SettingRow
          label={t("lab.mondrian")}
          description={t("lab.mondrianHint")}
          control={
            <Switch
              checked={variant === "mondrian"}
              onCheckedChange={(on) => setVariant(on ? "mondrian" : "ink")}
              disabled={saving}
            />
          }
        />
      </CardContent>

      <CardFooter className="justify-end">
        <Button onClick={save} disabled={!dirty || saving} size="sm">
          {saving && <Loader2 className="animate-spin size-3.5 me-1.5" />}
          {t("lab.save")}
        </Button>
      </CardFooter>
    </Card>
  );
}
