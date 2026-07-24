import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import SettingRow from "@/components/SettingRow";

type Props = {
  onError: (e: unknown) => void;
};

type PreviewCity = { name: string; localName: string; country: string };
type PreviewResult = { city: PreviewCity; date: string; pngBase64: string };

const DAYS_AHEAD_OPTIONS = [0, 1, 2, 3, 4, 5];

export default function DevMode({ onError }: Props) {
  const { t } = useTranslation();
  const [daysAhead, setDaysAhead] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<PreviewResult | null>(null);

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
    </div>
  );
}
