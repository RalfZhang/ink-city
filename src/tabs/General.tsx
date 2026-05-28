import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import type { Status } from "../types";

type Props = {
  status: Status;
  refresh: () => Promise<void>;
  onError: (e: unknown) => void;
};

export default function General({ status, refresh, onError }: Props) {
  const [autostart, setAutostart] = useState<boolean | null>(null);

  useEffect(() => {
    isEnabled().then(setAutostart).catch(onError);
  }, []);

  const regenerate = async () => {
    try {
      await invoke("regenerate_now");
    } catch (e) {
      onError(e);
    }
  };

  const toggleEnabled = async (on: boolean) => {
    try {
      await invoke("set_enabled", { on });
      await refresh();
    } catch (e) {
      onError(e);
    }
  };

  const toggleHideTray = async (hide: boolean) => {
    try {
      await invoke("set_hide_tray", { hide });
      await refresh();
    } catch (e) {
      onError(e);
    }
  };

  const toggleAutostart = async (on: boolean) => {
    try {
      if (on) await enable();
      else await disable();
      setAutostart(on);
    } catch (e) {
      onError(e);
    }
  };

  const city = status.city;

  return (
    <div className="space-y-6 max-w-2xl">
      <Card>
        <CardContent>
          <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Today · {status.date}</div>
          <div className="text-xl font-semibold">
            {city.name}, {city.country}
          </div>
          {city.localName !== city.name && (
            <div className="text-sm text-muted-foreground">{city.localName}</div>
          )}
          <div className="text-xs text-muted-foreground mt-1">
            {city.lat.toFixed(4)}, {city.lon.toFixed(4)} · pop {city.population.toLocaleString()}
          </div>
          <Button onClick={regenerate} disabled={status.running} size="sm" className="mt-4">
            {status.running ? "Generating…" : "Regenerate now"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-4">
          <Row
            label="Enable daily updates"
            description="Refresh the wallpaper at midnight with the next city."
            control={
              <Switch checked={status.enabled} onCheckedChange={toggleEnabled} />
            }
          />
          <Separator />
          <Row
            label="Launch at login"
            description="Start InkCity automatically when you log in."
            control={
              <Switch
                checked={autostart ?? false}
                disabled={autostart === null}
                onCheckedChange={toggleAutostart}
              />
            }
          />
          <Separator />
          <Row
            label="Hide system tray icon"
            description={
              status.hide_tray
                ? "With the tray hidden, relaunch the app to reopen this window."
                : "Keep the menu-bar icon visible."
            }
            control={
              <Switch checked={status.hide_tray} onCheckedChange={toggleHideTray} />
            }
          />
        </CardContent>
      </Card>

      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={() => invoke("hide_window")}>
          Hide window
        </Button>
        <Button variant="outline" size="sm" onClick={() => invoke("quit_app")}>
          Quit InkCity
        </Button>
      </div>
    </div>
  );
}

function Row({
  label,
  description,
  control,
}: {
  label: string;
  description?: string;
  control: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex-1 min-w-0">
        <Label className="text-sm">{label}</Label>
        {description && (
          <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
        )}
      </div>
      {control}
    </div>
  );
}
