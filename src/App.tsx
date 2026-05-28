import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import General from "./tabs/General";
import Style from "./tabs/Style";
import About from "./tabs/About";
import Feedback from "./tabs/Feedback";
import type { Status } from "./types";

type TabId = "general" | "style" | "about" | "feedback";

function App() {
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
        {err ? <pre className="text-destructive">{err}</pre> : "loading…"}
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
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="style">Style</TabsTrigger>
          <TabsTrigger value="about">About</TabsTrigger>
          <TabsTrigger value="feedback">Feedback</TabsTrigger>
        </TabsList>

        <TabsContent value="general" className="flex-1 overflow-y-auto border-l px-4 py-4">
          <General status={effectiveStatus} refresh={refresh} onError={onError} />
        </TabsContent>
        <TabsContent value="style" className="flex-1 overflow-y-auto border-l px-4 py-4">
          <Style status={effectiveStatus} busy={busy || status.running} refresh={refresh} onError={onError} />
        </TabsContent>
        <TabsContent value="about" className="flex-1 overflow-y-auto border-l px-4 py-4">
          <About status={status} />
        </TabsContent>
        <TabsContent value="feedback" className="flex-1 overflow-y-auto border-l px-4 py-4">
          <Feedback />
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
