import { useEffect, useState } from "react";
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
    const id = setInterval(refresh, 2000);
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

  // Push the current language's tray-menu translations into Rust so the
  // OS-rendered tray menu stays in sync with the React UI. Done on mount and
  // on every language change. Source of truth remains the JSON locale files.
  useEffect(() => {
    const sync = () => {
      invoke("update_tray_labels", {
        openSettings: i18n.t("tray.openSettings"),
        dailyUpdates: i18n.t("tray.dailyUpdates"),
        regenerateNow: i18n.t("tray.regenerateNow"),
        quit: i18n.t("tray.quit"),
      }).catch((e) => console.warn("[tray] sync failed", e));
    };
    sync();
    i18n.on("languageChanged", sync);
    return () => i18n.off("languageChanged", sync);
  }, []);

  // Apply the shadcn `.dark` class on <html> based on the chosen theme mode.
  // In "system" mode, mirror the OS preference and watch for changes.
  useEffect(() => {
    if (!status) return;
    const root = document.documentElement;
    const apply = () => {
      root.classList.remove("dark");
      if (status.theme === "dark") root.classList.add("dark");
      else if (status.theme === "system") {
        if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
          root.classList.add("dark");
        }
      }
    };
    apply();
    if (status.theme === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      mq.addEventListener("change", apply);
      return () => mq.removeEventListener("change", apply);
    }
  }, [status?.theme]);

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
          <Style status={effectiveStatus} busy={busy || status.running} refresh={refresh} onError={onError} />
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
