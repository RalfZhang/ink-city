import { Component, lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDown } from "lucide-react";
import { cn } from "@inkcity/ui/lib/utils";
import type { GuessGame } from "@inkcity/ui/guess";
import { isRevealed, type CountryIndex } from "@inkcity/core";
import { useTransient } from "../lib/hooks";
import { playedWithin } from "../lib/recent";
import { shareOrCopy } from "../lib/share";
import type { MapStatus } from "../map/useDailyMap";
import Bar, { type Mode } from "./Bar";
import CityCard from "./CityCard";
import Curtain from "./Curtain";
import Fold from "./Fold";
import Intro from "./Intro";
import NextCity from "./NextCity";
import Rows from "./Rows";
import StatsCard from "./StatsCard";
import type { Flight } from "./fly";
import { shareText } from "./share";

// Only fetched when someone asks for the details: the globe and its 80 KB of borders.
const Globe = lazy(() => import("./globe/Globe"));

/** How long the question stays over the map once the curtain is off it, ms. */
const QUESTION_MS = 1000;
/** A game that ends in front of the player: how long its last row has to land before the view goes up to the city. */
const LANDING_MS = 650;

type Props = {
  game: GuessGame;
  date: string;
  index: CountryIndex;
  map: MapStatus & { retry: () => void };
  /** A wide screen, whose keyboard can take the cursor without covering the map. */
  wide: boolean;
  theme: "light" | "dark";
  /** Go to the page below: the app that makes the map a wallpaper. */
  onWallpaper: () => void;
};

/**
 * The first page: the game, over today's map. It opens under the curtain
 * (./Curtain.tsx), with a button over it that waits for the map (./Bar.tsx); once
 * the map is in, the curtain slides down off it, uncovering the page — the question
 * in its middle for someone with nothing on it yet (./Intro.tsx), the cards for
 * someone back to a day that's begun — and once it's gone, the button becomes what
 * this visit needs: the choice of playing for someone new, the game itself for
 * someone who's played in the last week (lib/recent.ts), today's result for someone
 * who's finished it. Guesses stack up above the bar as they're made (./Rows.tsx); a
 * finished day shows the city, the time to the next one and the record over them —
 * the record and the guesses folded away on request (./Fold.tsx), the countdown with
 * them — or the guesses on a globe. Key it by date: a new day starts it over.
 */
export default function Stage({ game, date, index, map, wide, theme, onWallpaper }: Props) {
  const { t, i18n } = useTranslation();
  const { snapshot } = game;
  const recent = game.store !== null && playedWithin(game.store, date);
  // The map is in and the save has been read: what the page holds is known.
  const settled = map.painted && snapshot !== null;
  const [uncovered, setUncovered] = useState(false);
  const questionGone = useAfter(uncovered, QUESTION_MS);
  const [chose, setChose] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [folding, setFolding] = useState(false);
  const [details, setDetails] = useState(false);
  const [note, setNote] = useTransient<string>(2200);
  const flight = useRef<Flight | null>(null);

  const revealed = snapshot !== null && isRevealed(snapshot.state);
  const guesses = snapshot?.guesses ?? [];
  const over =
    snapshot !== null &&
    (snapshot.state === "won" || snapshot.state === "lost" || snapshot.state === "gaveUp") &&
    guesses.length > 0;

  // What the page holds (the cards, the guesses, the countdown) — laid out under the
  // curtain as soon as it's known, to be uncovered with the map…
  let content: Mode;
  if (map.error && !map.painted) content = "retry";
  else if (!settled) content = "loading";
  else if (revealed) content = over ? "done" : "revealed";
  else if (guesses.length > 0 || recent || chose) content = "input";
  else content = "choice";
  // …and the bar, which keeps waiting until the curtain is off the page, then turns
  // into what the visit needs.
  const mode: Mode = content === "retry" || uncovered ? content : "loading";
  const showDetails = details && over && map.city !== null;
  const folded = collapsed && content === "done";

  // Whether the game was open at some point this visit: a result now is one that just happened.
  const [wasOpen, setWasOpen] = useState(false);
  if (content === "input" && !wasOpen) setWasOpen(true);
  const fresh = wasOpen && revealed;

  // The countdown over the cards goes as they fold, and comes back once they've unfolded.
  const toggleFold = () => {
    setCollapsed((c) => !c);
    setFolding(true);
  };

  const share = async () => {
    if (!snapshot) return;
    const text = shareText(snapshot, date, i18n.language, `${location.origin}/`);
    const how = await shareOrCopy({ text }, text, { touchOnly: true });
    if (how === "copied") setNote(t("result.copied"));
  };

  // When the stack runs past the room it has: in a game, it's the newest guess — at
  // its foot — that stays in view; over, it's the city, at its head. A game that's
  // just ended lets its last row land first, then goes up to the city.
  const stack = useRef<HTMLDivElement>(null);
  const shownContent = useRef(content);
  useLayoutEffect(() => {
    const el = stack.current;
    const was = shownContent.current;
    shownContent.current = content;
    if (!el) return;
    if (content === "input") {
      el.scrollTop = el.scrollHeight;
      return;
    }
    if (was !== "input") {
      el.scrollTop = 0;
      return;
    }
    const id = setTimeout(() => el.scrollTo({ top: 0, behavior: "smooth" }), LANDING_MS);
    return () => clearTimeout(id);
  }, [guesses.length, content, details]);

  // Unfolding on a page too short for all of it, what comes out from behind the bar
  // stays in view, the card above going up and out of the top as it would on a
  // taller one: the stack keeps to its foot while the fold opens. (Folding needs
  // nothing: as the stack shrinks, its scroll comes down to its foot by itself.)
  useEffect(() => {
    const el = stack.current;
    if (!el || !folding || collapsed) return;
    let raf = 0;
    const pin = () => {
      el.scrollTop = el.scrollHeight;
      raf = requestAnimationFrame(pin);
    };
    raf = requestAnimationFrame(pin);
    return () => cancelAnimationFrame(raf);
  }, [folding, collapsed]);

  return (
    <>
      {/* The question, for someone with nothing on the page yet: under the curtain, uncovered with the map. */}
      <Intro shown={!questionGone && guesses.length === 0 && !revealed} />
      {!uncovered && <Curtain open={map.painted} onGone={() => setUncovered(true)} />}
      <div className="stage">
        {/* While the map is on its way, why it's taking a while, if it is. */}
        {(mode === "loading" || mode === "retry") && (map.error || map.stage === "overpass") && (
          <p className={cn("status", map.error && "is-error")} role={map.error ? "alert" : "status"}>
            {map.error ? t("today.failed") : t("today.rebuilding")}
          </p>
        )}
        {(content === "done" || content === "revealed") && <NextCity hidden={folded || folding || showDetails} />}
        <div ref={stack} className="stack">
          {/* The frame is outside the wait for the globe, so it rises in once: the first
              time, it holds bare paper until the globe has loaded. */}
          {showDetails && map.city && (
            <section className="card globe">
              <Caught
                fallback={
                  <div className="globe__failed" role="alert">
                    <p>{t("globe.failed")}</p>
                    {/* Trying again is loading the page again: the browser holds on to a
                        failed import's failure, and after a deploy what it asked for is
                        gone anyway. The game's saved, so the page comes back to it. */}
                    <button type="button" className="ink-btn" onClick={() => location.reload()}>
                      {t("today.retry")}
                    </button>
                  </div>
                }
              >
                <Suspense fallback={null}>
                  <Globe guesses={guesses} city={map.city} index={index} theme={theme} />
                </Suspense>
              </Caught>
            </section>
          )}
          {/* Kept while the globe's up, so going back finds them as they were. */}
          <div className="stack__cards" hidden={showDetails}>
            {(content === "done" || content === "revealed") && map.city && (
              <CityCard
                city={map.city}
                date={date}
                index={index}
                fresh={fresh}
                onWallpaper={onWallpaper}
                fold={content === "done" ? { collapsed, onToggle: toggleFold } : undefined}
              />
            )}
            {/* The record and the guesses. They keep their place from the game to its
                result, so the last guess still flies into its row. */}
            <Fold open={!folded} onSettled={() => setFolding(false)}>
              {content === "done" && snapshot && <StatsCard snapshot={snapshot} index={index} fresh={fresh} />}
              {(content === "input" || content === "done") && <Rows guesses={guesses} index={index} flight={flight} />}
            </Fold>
          </div>
        </div>
        <Bar
          mode={mode}
          snapshot={snapshot}
          index={index}
          saving={game.saving}
          onGuess={game.guess}
          onFlight={(f) => {
            flight.current = f;
          }}
          focusInput={chose || wide}
          onChoose={() => setChose(true)}
          onWallpaper={onWallpaper}
          onShare={() => void share()}
          details={details}
          onDetails={() => setDetails((d) => !d)}
          onRetry={map.retry}
          note={note}
        />
        <button
          type="button"
          className={cn("more", questionGone && mode !== "retry" && "is-in")}
          onClick={onWallpaper}
        >
          <span>{t("play.more")}</span>
          <ArrowDown aria-hidden />
        </button>
      </div>
    </>
  );
}

/** Whether `flag` has held for `ms`: false until then, and true from then on. */
function useAfter(flag: boolean, ms: number): boolean {
  const [after, setAfter] = useState(false);
  useEffect(() => {
    if (!flag || after) return;
    const id = setTimeout(() => setAfter(true), ms);
    return () => clearTimeout(id);
  }, [flag, after, ms]);
  return after;
}

/**
 * `children`, or `fallback` once they've thrown — the globe's code not arriving
 * (offline, or replaced by a deploy since the page was opened) — rather than the
 * error taking the whole page down with it.
 */
class Caught extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
