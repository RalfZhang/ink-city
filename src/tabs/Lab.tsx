import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import SettingRow from "@/components/SettingRow";
import type { Status } from "../types";

type Props = {
  status: Status;
  busy: boolean;
  onError: (e: unknown) => void;
};

// "Lab": home for optional data-layer toggles. For now just the airport toggle
// (the water toggle still lives in the Style tab; a later commit moves it here).
// A layer is only meaningful when the current city's OSM data actually carries
// it, so the toggle appears only when its `has*` flag is set. Mirrors the Style
// tab's save/regen lifecycle: Save stays disabled until an edit is made, then
// spins until the wallpaper re-render (triggered by apply_lab_settings) completes.
export default function Lab({ status, busy, onError }: Props) {
  const { t } = useTranslation();

  const [showAirports, setShowAirports] = useState<boolean>(status.showAirports);
  const [saving, setSaving] = useState(false);
  const sawBusy = useRef(false);

  // Initialize pending state from status on first mount only; we deliberately
  // don't auto-sync from later status pushes so in-progress edits aren't
  // clobbered by the backend's status stream (same rule as the Style tab).

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

  const dirty = showAirports !== status.showAirports;

  const save = async () => {
    setSaving(true);
    sawBusy.current = false;
    try {
      const result = await invoke<{ regenStarted: boolean }>("apply_lab_settings", {
        showAirports,
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

        {status.hasAirports ? (
          <SettingRow
            label={t("lab.showAirports")}
            description={t("lab.airportsHint")}
            control={
              <Switch checked={showAirports} onCheckedChange={setShowAirports} disabled={saving} />
            }
          />
        ) : (
          <p className="text-sm text-muted-foreground">{t("lab.noneAvailable")}</p>
        )}
      </CardContent>

      <CardFooter className="justify-end">
        <Button onClick={save} disabled={!dirty || saving} size="sm">
          {saving && <Loader2 className="animate-spin size-3.5 mr-1.5" />}
          {t("lab.save")}
        </Button>
      </CardFooter>
    </Card>
  );
}
