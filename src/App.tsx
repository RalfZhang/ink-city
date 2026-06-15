import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import General from "./tabs/General";
import City from "./tabs/City";
import Style from "./tabs/Style";
import About from "./tabs/About";
import type { Status } from "./types";
import { STATUS_POLL_MS } from "./constants";

type TabId = "general" | "city" | "style" | "about";

function App() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<Status | null>(null);
  const [tab, setTab] = useState<TabId>("general");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    try {
      setStatus(await invoke<Status>("get_status"));
    } catch (e) {
      setErr(String(e));
    }
  };

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, STATUS_POLL_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const offStart = listen("pipeline:start", () => setBusy(true));
    const offEnd = listen("pipeline:end", () => {
      setBusy(false);
      refresh();
    });
    return () => {
      offStart.then((f) => f());
      offEnd.then((f) => f());
    };
  }, []);

  // Generic "jump to a tab" channel. (The tray's "Update available" entry no
  // longer uses it — it confirms + installs in place via a native dialog.)
  useEffect(() => {
    const off = listen<string>("open-tab", (e) => setTab(e.payload as TabId));
    return () => {
      off.then((f) => f());
    };
  }, []);

  // Push the current language's translations for the Rust-rendered surfaces
  // (tray menu + the windowless update notification/dialogs) into Rust. Done on
  // mount and on every language change. Source of truth remains the JSON locale
  // files; Rust just renders whatever it's told.
  useEffect(() => {
    const sync = () => {
      invoke("update_tray_labels", {
        openSettings: i18n.t("tray.openSettings"),
        dailyUpdates: i18n.t("tray.dailyUpdates"),
        regenerateNow: i18n.t("tray.regenerateNow"),
        quit: i18n.t("tray.quit"),
        updateAvailable: i18n.t("tray.updateAvailable"),
      }).catch((e) => console.warn("[tray] sync failed", e));
      invoke("set_update_strings", {
        strings: {
          notifyBody: i18n.t("update.notifyBody"),
          downloading: i18n.t("update.downloading"),
          promptBody: i18n.t("update.promptBody"),
          updateNow: i18n.t("update.updateNow"),
          later: i18n.t("update.later"),
          upToDate: i18n.t("update.upToDate"),
          failed: i18n.t("update.failed"),
        },
      }).catch((e) => console.warn("[update] strings sync failed", e));
    };
    sync();
    i18n.on("languageChanged", sync);
    return () => i18n.off("languageChanged", sync);
  }, []);

  // The settings-page UI always follows the OS theme. The user-visible "Map
  // Theme" toggle in Style only controls which color pair the wallpaper
  // renderer uses; it doesn't override the app chrome's appearance.
  useEffect(() => {
    const root = document.documentElement;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      if (mq.matches) root.classList.add("dark");
      else root.classList.remove("dark");
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  // When the calendar date rolls over while the settings window is open, the
  // 2s poll surfaces the new city before the backend's reconcile (≤60s) repaints
  // the wallpaper. Kick a regenerate the moment we observe that rollover so the
  // visible city and the desktop stay in sync. This is an immediacy optimization
  // only — the backend poll remains the reliable source of truth (it runs in
  // Rust regardless of window/webview state). Gated on `enabled` so it never
  // overrides a user who turned daily updates off, and skipped if a render is
  // already in flight (the backend likely beat us to it; coalescing covers the
  // rest). Skips the first observed date so opening the app never re-renders.
  const prevDateRef = useRef<string | null>(null);
  useEffect(() => {
    if (!status) return;
    const prev = prevDateRef.current;
    prevDateRef.current = status.date;
    if (prev === null || prev === status.date) return;
    if (!status.enabled || status.running) return;
    invoke("regenerate_now").catch((e) => setErr(String(e)));
  }, [status?.date, status?.enabled, status?.running]);

  const onError = (e: unknown) => setErr(String(e));

  if (!status) {
    return (
      <main className="p-4 text-sm text-muted-foreground">
        {err ? <pre className="text-destructive">{err}</pre> : t("common.loading")}
      </main>
    );
  }

  const effectiveStatus = { ...status, running: busy || status.running };

  return (
    <div className="h-screen flex flex-col">
      <Tabs
        orientation="vertical"
        value={tab}
        onValueChange={(v) => setTab(v as TabId)}
        className="flex-1 min-h-0 gap-0"
      >
        <TabsList className="w-[180px] h-full bg-transparent rounded-none p-4 gap-0.5 items-stretch">
          <TabsTrigger value="general">{t("sidebar.general")}</TabsTrigger>
          <TabsTrigger value="city">{t("sidebar.city")}</TabsTrigger>
          <TabsTrigger value="style">{t("sidebar.style")}</TabsTrigger>
          <TabsTrigger value="about">{t("sidebar.about")}</TabsTrigger>
        </TabsList>

        <TabsContent value="general" className="flex-1 overflow-y-auto border-l px-4 py-4">
          <General status={effectiveStatus} refresh={refresh} onError={onError} />
        </TabsContent>
        <TabsContent value="city" className="flex-1 overflow-y-auto border-l px-4 py-4">
          <City status={effectiveStatus} onError={onError} />
        </TabsContent>
        <TabsContent value="style" className="flex-1 overflow-y-auto border-l px-4 py-4">
          <Style status={effectiveStatus} busy={busy || status.running} onError={onError} />
        </TabsContent>
        <TabsContent value="about" className="flex-1 overflow-y-auto border-l px-4 py-4">
          <About />
        </TabsContent>
      </Tabs>

      {err && (
        <div className="mx-4 mb-4 p-3 rounded border border-destructive/30 bg-destructive/5 text-destructive text-xs whitespace-pre-wrap">
          {err}
        </div>
      )}
    </div>
  );
}

export default App;
