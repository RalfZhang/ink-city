import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Direction } from "radix-ui";
import { X } from "lucide-react";
import { Button } from "@inkcity/ui/components/button";
import { countryIndex, isRevealed } from "@inkcity/core";
import countries from "@inkcity/core/countries.json";
import { DailyGuess, useGuessGame } from "@inkcity/ui/guess";
import { dirForLocale } from "./i18n";
import { useElementSize, useLocalDate, useMediaQuery } from "./lib/hooks";
import { detectVisitor, refineVisitor } from "./lib/platform";
import { useGuessStorage } from "./lib/storage";
import { useDailyMap } from "./map/useDailyMap";
import MapView from "./components/MapView";
import Panel from "./components/Panel";
import TodayCard from "./components/TodayCard";
import { DownloadCard, DownloadTeaser } from "./components/Download";
import Footer from "./components/Footer";

const COUNTRIES = countryIndex(countries);

/** Whether the panel is tucked away ("Show the whole map"); per tab, so a new visit starts on the game. */
const PANEL_HIDDEN_KEY = "inkcity:panel-hidden";

function readHidden(): boolean {
  try {
    return sessionStorage.getItem(PANEL_HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Typing into a field (the guess box) must never toggle the panel, and neither may a
 * key an open list is using to jump to an item (the language picker's).
 */
function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) ||
      target.closest('[role="listbox"]') !== null)
  );
}

/**
 * The website: today's map across the whole page, and the guess-the-country game in
 * a panel over it — the same game as the desktop's (`@inkcity/ui/guess`), its save
 * in this browser's localStorage instead of a file. The game opens once the map is
 * drawn, as the desktop's waits for its wallpaper; once it's over the panel reveals
 * the city and offers the app that would make it your wallpaper.
 */
export default function App() {
  const { t, i18n } = useTranslation();
  const dir = dirForLocale(i18n.language);
  const dark = useMediaQuery("(prefers-color-scheme: dark)");
  const wide = useMediaQuery("(min-width: 768px)");
  const date = useLocalDate();
  const [visitor, setVisitor] = useState(() => detectVisitor(navigator));
  useEffect(() => {
    let live = true;
    void refineVisitor(navigator, detectVisitor(navigator)).then((v) => live && setVisitor(v));
    return () => {
      live = false;
    };
  }, []);

  // The shared theme's dark tokens hang off a `.dark` class; follow the system.
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  // A drag-resize settles before the map redraws; the first size draws at once.
  const size = useElementSize(stage, 300);
  const map = useDailyMap(date, dark ? "dark" : "light", size, canvas);

  const { storage, memoryOnly } = useGuessStorage();
  const [noteDismissed, setNoteDismissed] = useState(false);
  const game = useGuessGame(storage, { date, city: map.city, ready: map.painted }, COUNTRIES, (e) =>
    console.error("[game]", e),
  );
  const snapshot = game.snapshot;
  // Concealed until the save has been read, too: showing the city first would flash the answer.
  const revealed = snapshot !== null && isRevealed(snapshot.state);

  const [hidden, setHidden] = useState(readHidden);
  useEffect(() => {
    try {
      sessionStorage.setItem(PANEL_HIDDEN_KEY, hidden ? "1" : "0");
    } catch {
      // per page load, then
    }
  }, [hidden]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "h" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.defaultPrevented || isTyping(e.target)) return;
      setHidden((h) => !h);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const panel = useRef<HTMLElement>(null);
  const panelSize = useElementSize(panel);
  const view = useRef<HTMLDivElement>(null);
  const viewSize = useElementSize(view);
  // How far the stage runs on under a phone's browser bars (the large viewport's
  // height past the dynamic one's); none where the two are one, or `dvh` isn't known.
  const under = size && viewSize?.height ? Math.max(0, size.height - viewSize.height) : 0;
  // Half the panel's size toward the free side, and up out of the bars: the city lands
  // in the middle of what's left on screen.
  const shift =
    hidden || !panelSize
      ? { x: 0, y: -under / 2 }
      : wide
        ? { x: ((dir === "rtl" ? -1 : 1) * panelSize.width) / 2, y: -under / 2 }
        : { x: 0, y: -(panelSize.height + under) / 2 };

  return (
    <Direction.Provider dir={dir}>
      <MapView stageRef={stage} viewRef={view} canvasRef={canvas} shift={shift} painted={map.painted} />
      <Panel
        panelRef={panel}
        wide={wide}
        rtl={dir === "rtl"}
        hidden={hidden}
        onHiddenChange={setHidden}
        notice={memoryOnly && !noteDismissed && <MemoryOnlyNote onDismiss={() => setNoteDismissed(true)} />}
      >
        <TodayCard
          date={date}
          city={map.city}
          revealed={revealed}
          stage={map.stage}
          error={map.error}
          onRetry={map.retry}
          index={COUNTRIES}
        />
        <DailyGuess
          game={game}
          date={date}
          index={COUNTRIES}
          paintingLine={t(map.error ? "game.paintFailed" : "game.painting")}
        />
        {revealed && map.city ? <DownloadCard city={map.city} visitor={visitor} /> : <DownloadTeaser visitor={visitor} />}
        <Footer />
      </Panel>
    </Direction.Provider>
  );
}

/** Turns up with the first write the browser refuses — mid-game, so it's laid over the panel. */
function MemoryOnlyNote({ onDismiss }: { onDismiss: () => void }) {
  const { t } = useTranslation();
  return (
    <div role="status" className="flex items-start gap-2 rounded-lg border border-foreground/10 bg-background py-2 ps-3 pe-1 text-xs text-muted-foreground shadow-lg">
      <p className="flex-1 py-1">{t("storage.memoryOnly")}</p>
      <Button variant="ghost" size="icon-xs" onClick={onDismiss} aria-label={t("storage.dismiss")}>
        <X />
      </Button>
    </div>
  );
}
