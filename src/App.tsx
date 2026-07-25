import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";
import { logWarn } from "@/lib/log";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import General from "./tabs/General";
import City from "./tabs/City";
import Style from "./tabs/Style";
import Lab from "./tabs/Lab";
import About from "./tabs/About";
import DevMode from "./tabs/DevMode";
import type { Status } from "./types";

type TabId = "general" | "city" | "style" | "lab" | "about" | "devMode";

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

  // The backend pushes a fresh Status snapshot on every change (replacing the
  // old 2s poll). Subscribe first, then fetch the initial snapshot — so a
  // change landing between fetch and subscribe can't be missed (a redundant
  // push during the gap is harmless: last-write-wins).
  useEffect(() => {
    let off: (() => void) | undefined;
    let cancelled = false;
    listen<Status>("status:changed", (e) => setStatus(e.payload)).then((f) => {
      // If cleanup already ran before `listen` resolved (StrictMode remount, or
      // a fast unmount), unsubscribe immediately instead of leaking the listener.
      if (cancelled) {
        f();
        return;
      }
      off = f;
      refresh();
    });
    return () => {
      cancelled = true;
      off?.();
    };
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
      }).catch((e) => logWarn("[tray] sync failed", e));
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
      }).catch((e) => logWarn("[update] strings sync failed", e));
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

  // Cross-midnight rollover is handled entirely by the backend now: the
  // scheduler detects the date change and pushes a fresh Status (and, when
  // daily updates are enabled, repaints within its ≤60s reconcile). No frontend
  // timer is needed — which also sidesteps wall-clock timer fragility across
  // sleep/wake and DST.

  const onError = (e: unknown) => setErr(String(e));

  // Dev Mode's unlocked state is persisted in config.json (backend) so the tab
  // stays revealed across restarts. Unlocked by clicking the version number in
  // About seven times in a row (see About.tsx). The toggle just tells the
  // backend; the fresh status:changed push flips `devMode` below.
  const toggleDevMode = () => {
    const next = !(status?.devMode ?? false);
    // Leaving devMode while it's the active tab would otherwise strand the Tabs
    // component on a value with no matching trigger/content.
    if (!next && tab === "devMode") setTab("general");
    invoke("set_dev_mode", { on: next }).catch(onError);
  };

  if (!status) {
    return (
      <main className="p-4 text-sm text-muted-foreground">
        {err ? <pre className="text-destructive">{err}</pre> : t("common.loading")}
      </main>
    );
  }

  const effectiveStatus = { ...status, running: busy || status.running };
  const devMode = status.devMode;

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
          <TabsTrigger value="lab">{t("sidebar.lab")}</TabsTrigger>
          <TabsTrigger value="about">{t("sidebar.about")}</TabsTrigger>
          {devMode && <TabsTrigger value="devMode">{t("sidebar.devMode")}</TabsTrigger>}
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
        <TabsContent value="lab" className="flex-1 overflow-y-auto border-l px-4 py-4">
          <Lab status={effectiveStatus} busy={busy || status.running} onError={onError} />
        </TabsContent>
        <TabsContent value="about" className="flex-1 overflow-y-auto border-l px-4 py-4">
          <About
            status={effectiveStatus}
            refresh={refresh}
            onError={onError}
            onToggleDevMode={toggleDevMode}
          />
        </TabsContent>
        {devMode && (
          <TabsContent value="devMode" className="flex-1 overflow-y-auto border-l px-4 py-4">
            <DevMode status={effectiveStatus} onError={onError} />
          </TabsContent>
        )}
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
