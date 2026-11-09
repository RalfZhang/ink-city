import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { countryIndex, isRevealed } from "@inkcity/core";
import countries from "@inkcity/core/countries.json";
import { useGuessGame } from "@inkcity/ui/guess";
import { Stage, ToastProvider } from "@inkcity/ui/game";
import { cityName } from "@inkcity/ui/game/city-name";
import { UI_NS } from "@inkcity/ui/i18n";
import { REDUCED_MOTION } from "@inkcity/ui/game/motion";
import { useElementSize, useMediaQuery } from "@inkcity/ui/lib/hooks";
import { useKeyboardInset, useLocalDate } from "./lib/hooks";
import { usePaging } from "./lib/paging";
import { detectVisitor, refineVisitor } from "./lib/platform";
import { useGuessStorage } from "./lib/storage";
import { useDailyMap } from "./map/useDailyMap";
import MapView from "./components/MapView";
import HeaderBrand from "./components/HeaderBrand";
import TopBar from "./components/TopBar";
import CornerCredit from "./components/CornerCredit";
import AppPage from "./components/AppPage";
import Curtain from "./game/Curtain";

const COUNTRIES = countryIndex(countries);

/**
 * The website: today's map across the whole page, inked in from the top, and two
 * pages over it that scroll while it stays put — the guess-the-country game
 * (./game/Stage.tsx), and the app that makes the map a wallpaper, on a sheet of
 * tracing paper (./components/AppPage.tsx) — the same sheet a visit opens on, before
 * it slides down off the map. The game is the desktop's
 * — core's rules, `useGuessGame` from @inkcity/ui/guess — its save in this
 * browser's localStorage instead of a file, drawn in this site's own pieces. Over
 * every page, fixed: the name in one top corner, the language and the source in the
 * other, and the copyright and the data's credit at the foot once there's a map.
 */
export default function App() {
  const { t, i18n } = useTranslation();
  const { t: tUi } = useTranslation(UI_NS);
  const dark = useMediaQuery("(prefers-color-scheme: dark)");
  const wide = useMediaQuery("(min-width: 768px)");
  const still = useMediaQuery(REDUCED_MOTION);
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
  // Inked in from the top, out from under the curtain sliding down off it (game/Curtain.tsx).
  const map = useDailyMap(date, dark ? "dark" : "light", size, canvas, !still);

  const { storage, memoryOnly } = useGuessStorage();
  const [noteDismissed, setNoteDismissed] = useState(false);
  const game = useGuessGame(storage, { date, city: map.city, ready: map.painted }, COUNTRIES, (e) =>
    console.error("[game]", e),
  );
  // Concealed until the save has been read, too: naming the city first would give the answer away.
  const revealed = game.snapshot !== null && isRevealed(game.snapshot.state);

  const pages = useRef<HTMLElement>(null);
  usePaging(pages, !still);
  useKeyboardInset();
  const toApp = () => document.getElementById("app")?.scrollIntoView({ behavior: still ? "auto" : "smooth" });
  const toPlay = () => pages.current?.scrollTo({ top: 0, behavior: still ? "auto" : "smooth" });

  return (
    <ToastProvider>
      <MapView stageRef={stage} canvasRef={canvas} painted={map.painted} />
      <main ref={pages} className="pages">
        <section className="page page--play" aria-label={tUi("intro.question")}>
          <Stage
            key={date}
            game={game}
            date={date}
            index={COUNTRIES}
            map={{ ...map, rebuilding: map.stage === "overpass" }}
            wide={wide}
            theme={dark ? "dark" : "light"}
            wallpaper={{
              go: toApp,
              guess: t("play.guess"),
              set: t("play.wallpaper"),
              more: t("play.more"),
              label: (city) => t("download.title", { city: cityName(city, i18n.language) }),
            }}
            curtain={(open, onGone) => <Curtain open={open} onGone={onGone} />}
            shareUrl={`${location.origin}/`}
          />
        </section>
        <section id="app" className="page page--app" aria-label="InkCity">
          <AppPage city={revealed ? map.city : null} visitor={visitor} />
        </section>
      </main>
      <HeaderBrand onHome={toPlay} />
      <TopBar />
      <CornerCredit shown={map.painted} />
      {memoryOnly && !noteDismissed && <MemoryOnlyNote onDismiss={() => setNoteDismissed(true)} />}
    </ToastProvider>
  );
}

/** Turns up with the first write the browser refuses — mid-game, so it floats at the top, clear of it. */
function MemoryOnlyNote({ onDismiss }: { onDismiss: () => void }) {
  const { t } = useTranslation();
  return (
    <div role="status" className="ink-pop memory-note">
      <p>{t("storage.memoryOnly")}</p>
      <button type="button" className="chip-btn chip-btn--bare" onClick={onDismiss} aria-label={t("storage.dismiss")}>
        <X aria-hidden />
      </button>
    </div>
  );
}
