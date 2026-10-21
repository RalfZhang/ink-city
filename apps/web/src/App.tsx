import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Direction } from "radix-ui";
import { countryIndex, isRevealed } from "@inkcity/core";
import countries from "@inkcity/core/countries.json";
import { DailyGuess, useGuessGame } from "@inkcity/ui/guess";
import { dirForLocale } from "./i18n";
import { useElementSize, useLocalDate, useMediaQuery } from "./lib/hooks";
import { detectVisitor } from "./lib/platform";
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
  const visitor = useMemo(() => detectVisitor(navigator), []);

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
  // Half the panel's size toward the free side: the city lands in the middle of what's left.
  const shift =
    hidden || !panelSize
      ? { x: 0, y: 0 }
      : wide
        ? { x: ((dir === "rtl" ? -1 : 1) * panelSize.width) / 2, y: 0 }
        : { x: 0, y: -panelSize.height / 2 };

  return (
    <Direction.Provider dir={dir}>
      <MapView stageRef={stage} canvasRef={canvas} shift={shift} painted={map.painted} />
      <Panel panelRef={panel} wide={wide} rtl={dir === "rtl"} hidden={hidden} onHiddenChange={setHidden}>
        <TodayCard
          date={date}
          city={map.city}
          revealed={revealed}
          stage={map.stage}
          error={map.error}
          onRetry={map.retry}
          index={COUNTRIES}
        />
        {memoryOnly && <MemoryOnlyNote />}
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

function MemoryOnlyNote() {
  const { t } = useTranslation();
  return <p className="px-1 text-xs text-muted-foreground">{t("storage.memoryOnly")}</p>;
}
