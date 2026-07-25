import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import SettingRow from "@/components/SettingRow";

type Props = {
  // The persisted proxy config (source of truth after each refresh).
  enabled: boolean;
  url: string;
  refresh: () => Promise<void>;
  onError: (e: unknown) => void;
};

// A URL the backend (reqwest::Proxy::all) will accept: an explicit http/https
// or socks5 scheme with a host. Gates the enable switch and the invalid styling.
function isValidProxyUrl(raw: string) {
  const url = raw.trim();
  if (!url) return false;
  try {
    const u = new URL(url);
    return (
      ["http:", "https:", "socks5:", "socks5h:"].includes(u.protocol) &&
      u.hostname !== ""
    );
  } catch {
    return false;
  }
}

// Proxy row: one input + one switch, no save button. The switch turns ON only
// with a valid URL and applies immediately; editing the URL drops the live
// proxy (switch off); blurring persists a valid/empty address (kept disabled).
export default function ProxySetting({ enabled, url, refresh, onError }: Props) {
  const { t } = useTranslation();
  const [proxyEnabled, setProxyEnabled] = useState(enabled);
  const [proxyUrl, setProxyUrl] = useState(url);
  const [saving, setSaving] = useState(false);

  const urlValid = isValidProxyUrl(proxyUrl);

  const applyProxy = async (nextEnabled: boolean, nextUrl: string) => {
    setSaving(true);
    try {
      await invoke("apply_proxy_settings", {
        proxyEnabled: nextEnabled,
        proxyUrl: nextUrl,
      });
      setProxyEnabled(nextEnabled);
      await refresh();
    } catch (e) {
      onError(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
        <SettingRow
          label={t("general.proxyLabel")}
          description={t("general.proxyDesc")}
          control={
            <Switch
              checked={proxyEnabled}
              // Can turn ON only with a valid URL; can always turn OFF.
              disabled={saving || (!proxyEnabled && !urlValid)}
              onCheckedChange={(on) => applyProxy(on, proxyUrl)}
            />
          }
        />
        <Input
          value={proxyUrl}
          onChange={(e) => {
            const value = e.target.value;
            setProxyUrl(value);
            // Editing the URL invalidates the live config, so drop the proxy the
            // moment it changes; the user re-enables once done. Only the first
            // keystroke hits the backend — proxyEnabled is false after.
            if (proxyEnabled) applyProxy(false, value);
          }}
          onBlur={() => {
            // Persist a valid or cleared address on blur (kept disabled — any
            // prior edit already switched it off). Skips when unchanged so an
            // untouched, enabled proxy isn't turned off just by focusing.
            const trimmed = proxyUrl.trim();
            if ((trimmed === "" || urlValid) && trimmed !== url) {
              applyProxy(false, proxyUrl);
            }
          }}
          className={cn(
            "mt-2",
            proxyUrl.trim() !== "" &&
              !urlValid &&
              "border-destructive focus-visible:border-destructive focus-visible:ring-destructive/50",
          )}
          placeholder="http://127.0.0.1:7890"
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
        />
    </div>
  );
}
