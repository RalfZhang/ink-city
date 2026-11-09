import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useTranslation } from "react-i18next";
import { ArrowUpRight } from "lucide-react";
import { useGuessGame } from "@inkcity/ui/guess";
import { Stage, ToastProvider, useToast } from "@inkcity/ui/game";
import { UI_NS } from "@inkcity/ui/i18n";
import { useMediaQuery } from "@inkcity/ui/lib/hooks";
import { MAP_PROVIDERS, WEBSITE_URL, countryIndex, countryName, formatLatLon, isRevealed, mapUrl, type MapLabel } from "@inkcity/core";
import countries from "@inkcity/core/countries.json";
import i18n from "@/i18n";
import { errorText } from "@/lib/action";
import { draftFrom, pairOf, sameDraft, styleOf, themeOf, type MapDraft } from "@/lib/draft";
import { guessStorage } from "@/lib/guess-storage";
import { useWindowShown } from "@/lib/window-shown";
import { logWarn } from "@/lib/log";
import { applyTokens, tokensFor } from "@inkcity/ui/game/tokens";
import { createMapClient } from "@/map/client";
import MapCaption from "@/map/MapCaption";
import { useHomeFrame, useMapData } from "@/map/useHomeMap";
import PinLine from "@/home/PinLine";
import TopBar from "@/home/TopBar";
import AboutTab from "@/sheet/AboutTab";
import DevTab from "@/sheet/DevTab";
import General from "@/sheet/General";
import LabTab from "@/sheet/LabTab";
import Sheet, { type Foot, type TabId } from "@/sheet/Sheet";
import StyleTab from "@/sheet/StyleTab";
import type { PassEnd, RunEnd, Status } from "./types";

const COUNTRIES = countryIndex(countries);

/** A wait on a run: its request's ticket (`pipeline::spawn_run`), and what's done with the pass that serves it. */
type Waiter = { ticket: number; done: (pass: PassEnd) => void };

/**
 * The pass of `end` that served `ticket`: the first whose `served` reaches it. Only
 * asked of an end that covers the ticket, whose last pass always does.
 */
function passFor(end: RunEnd, ticket: number): PassEnd {
  return end.passes.find((pass) => ticket <= pass.served) ?? end.passes[end.passes.length - 1];
}

/**
 * Something that ends in a run — syncing turned on, Regenerate, a save, a caption
 * added: `ok` is its word once the map is on the desktop, and `save` whether Save
 * waits on it too.
 */
type Job = { ok: string; save: boolean };

/** Why a save fell short, and what its Retry does: save again (nothing was written), or paint again (saved, not on the desktop). */
type SaveFailure = { message: string; retry: "save" | "paint" };

/**
 * The window: today's map within its frame, with the game at its foot — the
 * website's own (@inkcity/ui/game), save that the line is there from the start —
 * and the bar along its top (the home), and the settings as a sheet drawn up over
 * it. The map wears the wallpaper's palette — the draft's, while Style and Lab are
 * edited, so the window previews what Save would put on the desktop — and so does
 * the window.
 */
export default function App() {
  return (
    <ToastProvider>
      <Main />
    </ToastProvider>
  );
}

function Main() {
  const { t } = useTranslation();
  const { t: tUi } = useTranslation(UI_NS);
  const toast = useToast();
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [tab, setTab] = useState<TabId>("general");
  const [draft, setDraft] = useState<MapDraft | null>(null);
  const [saving, setSaving] = useState<{ painting: boolean } | null>(null);
  const [saveFailed, setSaveFailed] = useState<SaveFailure | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);
  // Why the sync box couldn't be switched, under the bar until it can.
  const [syncError, setSyncError] = useState<string | null>(null);
  const osDark = useMediaQuery("(prefers-color-scheme: dark)");
  const [gameEpoch, setGameEpoch] = useState(0);
  const client = useMemo(() => createMapClient(), []);
  useEffect(() => () => client.dispose(), [client]);
  const frame = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  const refresh = useCallback(async () => {
    setStatus(await invoke<Status>("get_status"));
  }, []);

  // The backend pushes a fresh Status on every change. Subscribe first, then fetch
  // the initial snapshot, so a change landing between the two can't be missed.
  useEffect(() => {
    let off: (() => void) | undefined;
    let cancelled = false;
    listen<Status>("status:changed", (e) => setStatus(e.payload)).then((f) => {
      if (cancelled) return f();
      off = f;
      void refresh();
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, [refresh]);

  // Busy only lets go once the status after the run is in: the errors the bar shows
  // when it stops looking busy are then the run's own.
  useEffect(() => {
    const offStart = listen("pipeline:start", () => setBusy(true));
    const offEnd = listen("pipeline:end", async () => {
      await refresh();
      setBusy(false);
    });
    return () => {
      offStart.then((f) => f());
      offEnd.then((f) => f());
    };
  }, [refresh]);

  // Push the current language's strings for the Rust-rendered surfaces (the tray,
  // and the windowless update notification and dialogs) into Rust, on mount and on
  // every language change. The JSON locale files stay the one source.
  useEffect(() => {
    const sync = () => {
      invoke("update_tray_labels", {
        openSettings: i18n.t("tray.openSettings"),
        // Shown instead of openSettings while today's game is playable — Rust picks
        // between the two (`tray::sync_open_item`).
        openGame: i18n.t("tray.openGame"),
        syncWallpaper: i18n.t("tray.syncWallpaper"),
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

  // ------------------------------------------------------------ the draft

  // Once per saved look, not per status: every push is a new object, most of them
  // about a run's progress, and the tokens below are laid again only when the look,
  // the draft or the theme changes.
  const savedKey = status ? JSON.stringify(draftFrom(status)) : null;
  const saved = useMemo<MapDraft | null>(() => (savedKey ? JSON.parse(savedKey) : null), [savedKey]);
  const shown = draft ?? saved;
  const dirty = draft !== null && saved !== null && !sameDraft(draft, saved);
  const theme = shown ? themeOf(shown, osDark) : osDark ? "dark" : "light";
  const pair = shown ? pairOf(shown, theme) : null;

  // A launch shows the window only once its first palette is on (`window_ready`):
  // until a status brings it, the page wears the light map's. The window's own fill,
  // behind the page, is the paper too — told again whenever the paper changes (a
  // palette, Mondrian, the OS going dark), or an edge bared by a resize would show
  // the old one; `window_ready` shows the window only the first time.
  const windowPaper = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!shown || !pair) return;
    const tokens = tokensFor(pair, shown.variant === "mondrian" ? theme : null);
    applyTokens(document.documentElement, tokens, theme);
    if (windowPaper.current === tokens.paper) return;
    windowPaper.current = tokens.paper;
    invoke("window_ready", { paper: tokens.paper }).catch((e) => logWarn("[window] couldn't say it's ready", e));
  }, [shown, pair, theme]);

  // ------------------------------------------------------------ wallpaper jobs

  // Each job is settled by the pass that served its ticket, in the `pipeline:end` of
  // its loop, from what that pass says rather than from whatever the next status
  // holds — or the loop's last pass, which may have been another request's: a word
  // once its map is on the desktop — or none if the pass failed, which `mapError` or
  // `wallError` then shows where it failed, until a run succeeds. Several can wait
  // at once.
  const waiters = useRef<Waiter[]>([]);
  // The latest end: a wait whose run was over before its ticket came back — a fetch
  // from the cache takes no time — is settled from it at once.
  const lastEnd = useRef<RunEnd | null>(null);
  /** Hand `done` the pass that serves `ticket`: the jobs below, and the pin line's pins. */
  const awaitRun = useCallback((ticket: number, done: (pass: PassEnd) => void) => {
    const end = lastEnd.current;
    if (end && end.served !== null && ticket <= end.served) done(passFor(end, ticket));
    else waiters.current.push({ ticket, done });
  }, []);
  const settle = (job: Job, pass: PassEnd) => {
    if (job.save) {
      setSaving(null);
      if (pass.failure) setSaveFailed({ message: t("sheet.saveFailWall", { reason: pass.failure }), retry: "paint" });
      else {
        setSaveFailed(null);
        toast(pass.painted ? job.ok : t("sheet.saved"));
      }
    } else if (!pass.failure && pass.painted) {
      toast(job.ok);
    }
  };
  const settleRef = useRef(settle);
  settleRef.current = settle;
  const startJob = (ticket: number, ok: string, save = false) => awaitRun(ticket, (pass) => settleRef.current({ ok, save }, pass));
  useEffect(() => {
    const off = listen<RunEnd>("pipeline:end", ({ payload: end }) => {
      const served = end.served;
      // Dev Mode's preview serves no request.
      if (served === null) return;
      lastEnd.current = end;
      const done = waiters.current.filter((w) => w.ticket <= served);
      waiters.current = waiters.current.filter((w) => w.ticket > served);
      for (const w of done) w.done(passFor(end, w.ticket));
    });
    return () => {
      off.then((f) => f());
    };
  }, []);
  const save = async () => {
    if (!draft || !status || saving) return;
    setSaveFailed(null);
    setSaving({ painting: status.syncWallpaper });
    try {
      // The draft stays put until the status push carries it back: dropping it now
      // would flash the old style for a frame.
      const r = await invoke<{ ticket: number | null }>("apply_map_settings", { settings: draft });
      if (r.ticket !== null) startJob(r.ticket, t("sheet.savedWall"), true);
      else {
        setSaving(null);
        toast(t("sheet.saved"));
      }
    } catch (e) {
      setSaving(null);
      // Nothing was written: Retry saves again.
      setSaveFailed({ message: errorText(e), retry: "save" });
    }
  };

  const revert = () => {
    setDraft(null);
    setSaveFailed(null);
  };

  const regenerate = (ok: string, isSave = false) => {
    if (isSave) {
      setSaveFailed(null);
      setSaving({ painting: true });
    }
    void invoke<number>("regenerate_now").then((ticket) => startJob(ticket, ok, isSave));
  };

  const toggleSync = async () => {
    if (!status || syncBusy) return;
    const on = !status.syncWallpaper;
    setSyncBusy(true);
    try {
      const ticket = await invoke<number | null>("set_sync_wallpaper", { on });
      setSyncError(null);
      if (ticket !== null) startJob(ticket, t("home.syncOn"));
      else toast(t("home.syncOff"));
    } catch (e) {
      logWarn("[sync] couldn't switch", e);
      setSyncError(errorText(e));
    } finally {
      setSyncBusy(false);
    }
  };

  // ------------------------------------------------------------ events from the backend

  useEffect(() => {
    const offView = listen<string>("open-view", (e) => {
      if (e.payload === "home") setSheetOpen(false);
      else if (e.payload === "settings") setSheetOpen(true);
    });
    // The window was put away: what only made sense while it was looked at goes —
    // an unsaved preview included, so it isn't still on the map next time.
    const offHidden = listen("window:hidden", () => {
      setSheetOpen(false);
      setDraft(null);
      setSaveFailed(null);
    });
    return () => {
      offView.then((f) => f());
      offHidden.then((f) => f());
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Not while an input method is composing: Escape there drops the candidate, and
      // only that (read as @inkcity/ui/game/motion's `isComposing` reads it).
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === "Escape" && !e.defaultPrevented) setSheetOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ------------------------------------------------------------ the map

  const daily = status?.updateMode === "daily";
  const centerLat = daily ? status?.city?.lat : status?.custom?.lat;
  const centerLon = daily ? status?.city?.lon : status?.custom?.lon;
  const center = useMemo(
    () => (centerLat !== undefined && centerLon !== undefined ? { lat: centerLat, lon: centerLon } : null),
    [centerLat, centerLon],
  );
  // The map is read and drawn only while the window is on screen (`useMapData`).
  const onScreen = useWindowShown();
  const data = useMapData(client, status?.mapKey ?? null, status?.mapReady ? status.mapRev : null, onScreen);
  const loadedKey = data.key !== null && data.key === status?.mapKey ? data.key : null;
  const painted = useHomeFrame({
    client,
    stage: frame,
    canvas,
    mapKey: loadedKey,
    rev: loadedKey !== null ? data.rev : null,
    visible: onScreen,
    center,
    style: shown ? styleOf(shown, theme) : null,
  });

  // The run the last save started, if any: one that revealed the day captions the
  // wallpaper (`guess_store_write`).
  const saveRun = useRef<number | null>(null);
  // A new storage object makes the game read the save again: Dev Mode rewrites it.
  const storage = useMemo(
    () =>
      guessStorage((ticket) => {
        saveRun.current = ticket;
      }),
    [gameEpoch],
  );
  // The game waits for its map to be on screen: nobody guesses at bare paper.
  const ready = daily && painted.shown !== null && painted.shown === status?.mapKey;
  const game = useGuessGame(
    storage,
    { date: status?.date ?? "", city: daily ? (status?.city ?? null) : null, ready },
    COUNTRIES,
    // Shown from `game.error`, which a later success clears; logged here.
    (e) => logWarn("[game] the save couldn't be read or written", e),
  );
  // Dev Mode hands the save out for editing by hand (`reveal_guess_store`), and an
  // edit made in another app ends with this window clicked back into: read the save
  // again then, or the next guess would write the old one back over the edit. Only
  // in Dev Mode, where hand edits happen: a read landing mid-guess could show the
  // save from before the guess.
  const devMode = status?.devMode ?? false;
  const reloadGame = game.reload;
  useEffect(() => {
    if (!devMode) return;
    const off = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (focused) reloadGame();
    });
    return () => {
      off.then((f) => f());
    };
  }, [devMode, reloadGame]);

  // The caption the wallpaper carries, on the window's map too, in its corner of
  // the frame: a Daily city as soon as the day is revealed, a pin's coordinates always.
  const revealed = game.snapshot !== null && isRevealed(game.snapshot.state);
  let label: MapLabel | null = null;
  if (shown && shown.cityLabel !== "off") {
    if (daily && revealed && status?.city) {
      label = {
        corner: shown.cityLabel,
        name: status.city.name,
        localName: status.city.localName,
        country: status.city.country,
        countryName: countryName(COUNTRIES, status.city.country, "en"),
        lat: status.city.lat,
        lon: status.city.lon,
      };
    } else if (!daily && status?.custom) {
      label = { corner: shown.cityLabel, name: "", localName: "", country: "", lat: status.custom.lat, lon: status.custom.lon };
    }
  }
  // A game solved here, with the city's name on the wallpaper: the render that puts
  // it there gets a word when it's done.
  const wasPlaying = useRef(false);
  useEffect(() => {
    const state = game.snapshot?.state;
    if (state === "playing") wasPlaying.current = true;
    else if (wasPlaying.current && state && isRevealed(state)) {
      wasPlaying.current = false;
      // The save that revealed it has just returned the run it started, if it started one.
      const ticket = saveRun.current;
      saveRun.current = null;
      if (ticket !== null && status?.syncWallpaper && status.cityLabel !== "off") startJob(ticket, t("home.captionDone"));
    }
    // The snapshot's state is what matters.
  }, [game.snapshot?.state]);

  const sheetFoot: Foot = saving
    ? { kind: "saving", painting: saving.painting }
    : saveFailed
      ? { kind: "failed", message: saveFailed.message }
      : dirty
        ? { kind: "dirty" }
        : null;
  // One tree from the first frame, status or not: the frame is what the map and the
  // caption measure, so it must be there from the start.
  const tabs: TabId[] = ["general", "style", "lab", "about", ...(status?.devMode ? (["devMode"] as const) : [])];
  const activeTab = tabs.includes(tab) ? tab : "about";
  // Rejects when the switch couldn't be saved: About says so, and only says it
  // switched once it has.
  const toggleDevMode = async () => {
    if (!status) return;
    const next = !status.devMode;
    await invoke("set_dev_mode", { on: next });
    if (!next && tab === "devMode") setTab("about");
  };

  const provider = MAP_PROVIDERS.find((p) => p.id === status?.mapProvider) ?? MAP_PROVIDERS[0];
  let home: ReactNode = (
    <div className="stage">
      <p className="status">{t("common.loading")}</p>
    </div>
  );
  if (status && !daily) {
    // A pinned place: which one, and a way to see it in the chosen map service, over
    // the line it's pinned from — with a word on why to pin sparingly: each new place
    // is a live Overpass fetch, and too many in a row get rate-limited.
    const pin = status.custom;
    home = (
      <div className="stage">
        <div className="stack">
          <div className="head">
            <p className="ink-label">{pin ? formatLatLon(pin.lat, pin.lon) : "—"}</p>
            {pin && (
              <button type="button" className="ink-link" onClick={() => void openUrl(mapUrl(provider.id, pin.lat, pin.lon))}>
                {t(provider.labelKey)}
                <ArrowUpRight aria-hidden />
              </button>
            )}
            <p className="head__note">{t("home.pinRateHint")}</p>
          </div>
        </div>
        <PinLine
          awaitRun={awaitRun}
          fetching={status.mapKey !== null && !status.mapReady && !status.mapError}
          fetchError={status.mapError ?? data.error}
        />
      </div>
    );
  } else if (status) {
    home = (
      <Stage
        key={status.date}
        game={game}
        date={status.date}
        index={COUNTRIES}
        map={{
          city: status.city,
          painted: ready,
          error: ready ? null : (status.mapError ?? data.error),
          showReason: true,
          // The map is missing: ask for it again, and read and draw what comes —
          // what couldn't be read may be whole by now, or gone and fetched anew.
          retry: () => {
            data.retry();
            painted.redraw();
            regenerate(t("home.regenDone"));
          },
        }}
        wide
        theme={theme}
        head={
          <div className="head">
            <p className="ink-label">
              {tUi("today.label")} · {status.date}
            </p>
            <p className="head__q">{tUi("game.prompt")}</p>
            {/* The save couldn't be written: the guess didn't count, and it says why — until one is. */}
            {game.error?.kind === "save" && (
              <p className="head__err" role="alert">
                {errorText(game.error.cause)}
              </p>
            )}
          </div>
        }
        mapLink={(city) => ({ href: mapUrl(provider.id, city.lat, city.lon), label: t(provider.labelKey) })}
        onOpen={(href) => void openUrl(href)}
        shareUrl={WEBSITE_URL}
      />
    );
  }

  return (
    // The map, inside its frame: the paper round it is what tells the window from
    // the wallpaper behind it, the same map edge to edge. It's the window's to drag.
    <main className="app" data-tauri-drag-region>
      <div ref={frame} className="frame">
        <canvas ref={canvas} className="map" aria-hidden />
        <MapCaption stage={frame} label={label} pair={pair} on={painted.landed !== null && painted.landed === loadedKey} />
        {status && (
          <TopBar
            sync={status.syncWallpaper}
            busy={busy || status.running}
            sheetOpen={sheetOpen}
            wallError={sheetOpen && saveFailed ? null : status.wallError}
            syncError={syncError}
            dirty={dirty && !saving}
            onSync={() => void toggleSync()}
            onRegenerate={() => regenerate(t("home.regenDone"))}
            onSettings={() => setSheetOpen((o) => !o)}
            onSave={() => void save()}
            onRevert={revert}
          />
        )}
        <div className={`home${sheetOpen ? " is-under" : ""}`} inert={sheetOpen}>
          {home}
        </div>
        {status && (
          <Sheet
            open={sheetOpen}
            tab={activeTab}
            tabs={tabs}
            onTab={setTab}
            onClose={() => setSheetOpen(false)}
            foot={sheetFoot}
            onSave={() => void save()}
            onRevert={revert}
            onRetry={() => (saveFailed?.retry === "save" ? void save() : regenerate(t("sheet.savedWall"), true))}
          >
            {activeTab === "general" && <General status={status} game={game} />}
            {activeTab === "style" && shown && <StyleTab draft={shown} onChange={setDraft} theme={theme} />}
            {activeTab === "lab" && shown && <LabTab draft={shown} onChange={setDraft} theme={theme} />}
            {activeTab === "about" && <AboutTab status={status} onToggleDevMode={toggleDevMode} />}
            {activeTab === "devMode" && <DevTab status={status} onGameChanged={() => setGameEpoch((n) => n + 1)} />}
          </Sheet>
        )}
      </div>
    </main>
  );
}
