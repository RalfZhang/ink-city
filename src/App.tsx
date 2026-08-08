import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { Direction } from "radix-ui";
import { X } from "lucide-react";
import i18n, { dirForLocale } from "@/i18n";
import { logWarn } from "@/lib/log";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import General from "./tabs/General";
import City from "./tabs/City";
import Style from "./tabs/Style";
import Lab from "./tabs/Lab";
import About from "./tabs/About";
import DevMode from "./tabs/DevMode";
import type { Status } from "./types";

const TAB_IDS = ["general", "city", "style", "lab", "about", "devMode"] as const;
type TabId = (typeof TAB_IDS)[number];

const isTabId = (v: string): v is TabId => (TAB_IDS as readonly string[]).includes(v);

function App() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<Status | null>(null);
  // Default to the City tab — the functional day-to-day view — rather than the
  // rarely-changed General settings.
  const [tab, setTab] = useState<TabId>("city");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    try {
      setStatus(await invoke<Status>("get_status"));
    } catch (e) {
      setErr(String(e));
    }
  };

  // The backend pushes a fresh Status snapshot on every change. Subscribe first,
  // then fetch the initial snapshot, so a change landing between the two can't be
  // missed (a redundant push during the gap is harmless: last-write-wins).
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

  // "Jump to a tab", emitted by the tray's "Open Settings" entry (see
  // `FrontendEvent::OpenTab`). Validated rather than cast: the payload crosses IPC
  // as a plain string, and an unrecognized one would strand Tabs on a value with no
  // trigger or content.
  useEffect(() => {
    const off = listen<string>("open-tab", (e) => {
      if (isTabId(e.payload)) setTab(e.payload);
      else logWarn("[app] ignoring open-tab for an unknown tab", e.payload);
    });
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

  // There is deliberately no midnight timer here: the backend scheduler detects the
  // date change and pushes a fresh Status (repainting within its ≤60s reconcile when
  // daily updates are on), which also sidesteps wall-clock timer fragility across
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
    if (!next && tab === "devMode") setTab("city");
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

  // Radix reads direction from this provider, not the DOM `dir`; without it its
  // roots force `dir="ltr"` and cancel the RTL mirroring. `useTranslation`
  // re-renders on language change, so `i18n.language` here stays current.
  const dir = dirForLocale(i18n.language);

  return (
    <Direction.Provider dir={dir}>
    <div className="relative h-screen flex flex-col">
      <Tabs
        orientation="vertical"
        value={tab}
        onValueChange={(v) => setTab(v as TabId)}
        className="flex-1 min-h-0 gap-0"
      >
        <div className="w-[180px] h-full flex flex-col p-4">
          <TabsList className="w-full bg-transparent rounded-none p-0 gap-0.5 items-stretch">
            <TabsTrigger value="city">{t("sidebar.city")}</TabsTrigger>
            <TabsTrigger value="general">{t("sidebar.general")}</TabsTrigger>
            <TabsTrigger value="style">{t("sidebar.style")}</TabsTrigger>
            <TabsTrigger value="lab">{t("sidebar.lab")}</TabsTrigger>
            <TabsTrigger value="about">{t("sidebar.about")}</TabsTrigger>
            {devMode && <TabsTrigger value="devMode">{t("sidebar.devMode")}</TabsTrigger>}
          </TabsList>
          {/* Window controls pinned to the bottom of the sidebar. */}
          <div className="mt-auto flex flex-col gap-2 pt-4">
            <Button variant="outline" size="sm" onClick={() => invoke("quit_app")}>
              {t("general.quit")}
            </Button>
            <Button size="sm" onClick={() => invoke("hide_window")}>
              {t("general.closeWindow")}
            </Button>
          </div>
        </div>

        <TabsContent value="city" className="flex-1 overflow-y-auto border-s border-s-divider px-4 py-4">
          <City status={effectiveStatus} onError={onError} />
        </TabsContent>
        <TabsContent value="general" className="flex-1 overflow-y-auto border-s border-s-divider px-4 py-4">
          <General status={effectiveStatus} refresh={refresh} onError={onError} />
        </TabsContent>
        <TabsContent value="style" className="flex-1 overflow-y-auto border-s border-s-divider px-4 py-4">
          <Style status={effectiveStatus} busy={busy || status.running} onError={onError} />
        </TabsContent>
        <TabsContent value="lab" className="flex-1 overflow-y-auto border-s border-s-divider px-4 py-4">
          <Lab status={effectiveStatus} busy={busy || status.running} onError={onError} />
        </TabsContent>
        <TabsContent value="about" className="flex-1 overflow-y-auto border-s border-s-divider px-4 py-4">
          <About
            status={effectiveStatus}
            refresh={refresh}
            onError={onError}
            onToggleDevMode={toggleDevMode}
          />
        </TabsContent>
        {devMode && (
          <TabsContent value="devMode" className="flex-1 overflow-y-auto border-s border-s-divider px-4 py-4">
            <DevMode status={effectiveStatus} onError={onError} />
          </TabsContent>
        )}
      </Tabs>

      {/* Dismissable, and overlaid rather than in flow: nothing else clears `err`,
          so without the button a one-off failure (a preview whose cached PNG was
          since cleaned, say) would sit there for the rest of the session — and an
          error appearing must not shove the content it's about out from under the
          cursor. Floating means an opaque background, and `start-[180px]` (the
          sidebar's width, logical so it flips under RTL) so it can't cover the
          window controls pinned to the sidebar's bottom. */}
      {err && (
        <div className="absolute bottom-0 start-[180px] end-0 mx-4 mb-4 flex items-start gap-3 p-3 rounded border border-destructive/30 bg-background shadow-lg">
          <div className="flex-1 min-w-0 max-h-40 overflow-y-auto text-destructive text-xs whitespace-pre-wrap break-words">
            {err}
          </div>
          <button
            type="button"
            onClick={() => setErr(null)}
            aria-label={t("common.dismiss")}
            title={t("common.dismiss")}
            className="shrink-0 text-destructive/60 hover:text-destructive"
          >
            <X className="size-3.5" />
          </button>
        </div>
      )}
    </div>
    </Direction.Provider>
  );
}

export default App;
