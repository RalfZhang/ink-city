import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import SettingRow from "@/components/SettingRow";
import type { Status } from "../types";

type Props = {
  status: Status;
  onError: (e: unknown) => void;
};

type PreviewCity = { name: string; localName: string; country: string };
type PreviewResult = { city: PreviewCity; date: string; pngBase64: string };
type CleanCacheResult = { removedFiles: number; freedBytes: number };

const DAYS_AHEAD_OPTIONS = [0, 1, 2, 3, 4, 5];

/** Human-readable byte size (e.g. 1536 → "1.5 KB"). */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

export default function DevMode({ status, onError }: Props) {
  const { t } = useTranslation();
  const [daysAhead, setDaysAhead] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [cleanResult, setCleanResult] = useState<string | null>(null);
  const [bypassCache, setBypassCache] = useState(status.bypassCache);

  const toggleBypassCache = async (on: boolean) => {
    setBypassCache(on);
    try {
      await invoke("set_bypass_cache", { on });
    } catch (e) {
      setBypassCache(!on);
      onError(e);
    }
  };

  const runPreview = async (value: string) => {
    setDaysAhead(value);
    setLoading(true);
    try {
      const result = await invoke<PreviewResult>("preview_city", { daysAhead: Number(value) });
      setPreview(result);
    } catch (e) {
      onError(e);
    } finally {
      setLoading(false);
    }
  };

  const cleanCache = async () => {
    setCleaning(true);
    setCleanResult(null);
    try {
      const { removedFiles, freedBytes } = await invoke<CleanCacheResult>("clean_cache");
      setCleanResult(
        removedFiles === 0
          ? t("devMode.cleanCacheEmpty")
          : t("devMode.cleanCacheResult", {
              files: removedFiles,
              size: formatBytes(freedBytes),
            }),
      );
    } catch (e) {
      onError(e);
    } finally {
      setCleaning(false);
    }
  };

  return (
    <div className="space-y-4 max-w-2xl">
      <Card>
        <CardContent className="space-y-4">
          <SettingRow
            label={t("devMode.advancePreviewTitle")}
            description={t("devMode.advancePreviewDesc")}
            control={
              <Select value={daysAhead} onValueChange={runPreview} disabled={loading}>
                <SelectTrigger className="w-[100px]">
                  <SelectValue placeholder="–" />
                </SelectTrigger>
                <SelectContent>
                  {DAYS_AHEAD_OPTIONS.map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
          />

          {loading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="animate-spin size-4" />
              {t("devMode.loading")}
            </div>
          )}

          {!loading && preview && (
            <div className="space-y-2">
              <div className="text-xs text-muted-foreground uppercase tracking-wider">
                {preview.date} · {preview.city.name}, {preview.city.country}
              </div>
              <img
                src={`data:image/png;base64,${preview.pngBase64}`}
                alt={`${preview.city.name} preview`}
                className="w-full rounded border"
              />
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <SettingRow
            label={t("devMode.bypassCacheTitle")}
            description={t("devMode.bypassCacheDesc")}
            control={
              <Switch checked={bypassCache} onCheckedChange={toggleBypassCache} />
            }
          />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-2">
          <SettingRow
            label={t("devMode.cleanCacheTitle")}
            description={t("devMode.cleanCacheDesc")}
            control={
              <Button
                variant="destructive"
                size="sm"
                onClick={cleanCache}
                disabled={cleaning}
              >
                {cleaning ? (
                  <Loader2 className="animate-spin size-3.5" />
                ) : (
                  <Trash2 className="size-3.5" />
                )}
                {cleaning ? t("devMode.cleaning") : t("devMode.cleanCacheButton")}
              </Button>
            }
          />
          {cleanResult && (
            <div className="text-xs text-muted-foreground">{cleanResult}</div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
