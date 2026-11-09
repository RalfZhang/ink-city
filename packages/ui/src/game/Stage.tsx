import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDown } from "lucide-react";
import { isRevealed, type City, type CountryIndex } from "@inkcity/core";
import { cn } from "../lib/utils";
import { UI_NS } from "../i18n";
import type { GuessGame } from "../guess";
import Bar, { type Mode, type WallpaperWay } from "./Bar";
import CityCard, { type OpenLink } from "./CityCard";
import Details from "./Details";
import Fold from "./Fold";
import Intro from "./Intro";
import NextCity from "./NextCity";
import Rows from "./Rows";
import StatsCard from "./StatsCard";
import type { Flight } from "./fly";
import { playedWithin } from "./recent";
import { shareText } from "./share";
import { copyText } from "./share-or-copy";
import { useToast } from "./toast";

/** How long the question stays over the map once the curtain is off it, ms. */
const QUESTION_MS = 1000;
/** A game that ends in front of the player: how long its last row has to land before the view goes up to the city. */
const LANDING_MS = 650;

/** What the host knows of the day's map: whether it's on screen, and if not, why. */
export type StageMap = {
  /** Today's city, once the day is known. */
  city: City | null;
  /** Whether today's map is on screen — the game waits for it. */
  painted: boolean;
  /** Why it can't be had, or null while it's coming (or came). */
  error: string | null;
  /** The day is being rebuilt from Overpass: slower than usual, and worth saying. */
  rebuilding?: boolean;
  /** Spell the error out under the page's line about it. */
  showReason?: boolean;
  retry: () => void;
};

type Props = {
  game: GuessGame;
  date: string;
  index: CountryIndex;
  map: StageMap;
  /** Take the cursor when the line arrives: there's a keyboard right there (a wide screen, a desktop). */
  wide: boolean;
  theme: "light" | "dark";
  /**
   * The website's page below — the app that makes the map a wallpaper — with the
   * website's words for going there. Given, a newcomer is first asked whether to
   * play or go there, and the result offers it; absent (the desktop, which *is* the
   * app), the line is there from the start.
   */
  wallpaper?: WallpaperWay;
  /**
   * What the page opens under (the website's curtain): drawn by the host, told to
   * open once the map's in and calling `onGone` once it's off the page. Absent, the
   * page is uncovered as soon as the map is painted — and with no curtain to lift,
   * there's no question to show in its middle either.
   */
  curtain?: (open: boolean, onGone: () => void) => ReactNode;
  /** Over the game while it's played: the day, and what's asked of it (the desktop's). */
  head?: ReactNode;
  /** The result's map link, and how links are opened (see CityCard). */
  mapLink?: (city: City) => { href: string; label: string };
  onOpen?: OpenLink;
  /** Where the shared result links to. */
  shareUrl: string;
};

/**
 * The game, over today's map — the website's first page and the desktop's home
 * alike. It opens under the host's curtain, if it has one, with a button over it
 * that waits for the map (./Bar.tsx); once the map is in, the page is uncovered —
 * the question in its middle for someone with nothing on it yet (./Intro.tsx), the
 * cards for someone back to a day that's begun — and once it is, the button becomes
 * what this visit needs: on the website, the choice of playing for someone new, the
 * game itself for someone who's played in the last week (./recent.ts); on the
 * desktop, the game straight away; today's result for someone who's finished it.
 * Guesses stack up above the bar as they're made (./Rows.tsx); a finished day shows
 * the city, the time to the next one and the record over them — the record and the
 * guesses folded away on request (./Fold.tsx), the countdown with them — or, in
 * place of all that, the guesses on a globe (./Details.tsx). Key it by date: a new
 * day starts it over.
 */
export default function Stage({
  game,
  date,
  index,
  map,
  wide,
  theme,
  wallpaper,
  curtain,
  head,
  mapLink,
  onOpen,
  shareUrl,
}: Props) {
  const { t, i18n } = useTranslation(UI_NS);
  const toast = useToast();
  const { snapshot } = game;
  const recent = game.store !== null && playedWithin(game.store, date);
  // The map is in and the save has been read: what the page holds is known.
  const settled = map.painted && snapshot !== null;
  const [lifted, setLifted] = useState(false);
  const uncovered = curtain ? lifted : map.painted;
  const questionGone = useAfter(uncovered, QUESTION_MS);
  const [chose, setChose] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [folding, setFolding] = useState(false);
  const [details, setDetails] = useState(false);
  const flight = useRef<Flight | null>(null);

  const revealed = snapshot !== null && isRevealed(snapshot.state);
  const guesses = snapshot?.guesses ?? [];
  const over =
    snapshot !== null &&
    (snapshot.state === "won" || snapshot.state === "lost" || snapshot.state === "gaveUp") &&
    guesses.length > 0;

  // What keeps the page from going on, if anything: the map, which can't be had.
  const mapFailed = map.error !== null && !map.painted;
  const trouble = map.error ? { text: t("today.failed"), reason: map.error } : null;

  // What the page holds (the cards, the guesses, the countdown) — laid out under the
  // curtain as soon as it's known, to be uncovered with the map…
  let content: Mode;
  if (mapFailed) content = "retry";
  else if (!settled) content = "loading";
  else if (revealed) content = over ? "done" : "revealed";
  else if (guesses.length > 0 || recent || chose || !wallpaper) content = "input";
  else content = "choice";
  // …and the bar, which keeps waiting until the page is uncovered, then turns into
  // what the visit needs.
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
    const text = shareText(snapshot, date, i18n.language, shareUrl);
    if (await copyText(text)) toast(t("result.copied"));
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
      {curtain && <Intro shown={!questionGone && guesses.length === 0 && !revealed} />}
      {curtain && !lifted && curtain(map.painted, () => setLifted(true))}
      <div className="stage">
        {/* What's over the bar, stacked up from it: the game, or its result — or, in
            their place, the result's details. */}
        <div className="view">
          {/* While the map is on its way, why it's taking a while, if it is. */}
          {(mode === "loading" || mode === "retry") && (trouble || map.rebuilding) && (
            <p className={cn("status", trouble && "is-error")} role={trouble ? "alert" : "status"}>
              {trouble ? trouble.text : t("today.rebuilding")}
              {trouble && map.showReason && <span className="status__reason">{trouble.reason}</span>}
            </p>
          )}
          {showDetails && map.city && <Details guesses={guesses} city={map.city} index={index} theme={theme} />}
          {/* Kept while the globe's up, so going back finds them as they were. */}
          <div className="view__main" hidden={showDetails}>
            {/* The time to the next game is for whoever plays: a day revealed without
                being played (the game switched off) shows its city, not a countdown. */}
            {content === "done" && <NextCity hidden={folded || folding} date={date} />}
            <div ref={stack} className="stack">
              {content === "input" && head}
              <div className="stack__cards">
                {(content === "done" || content === "revealed") && map.city && (
                  <CityCard
                    city={map.city}
                    date={date}
                    index={index}
                    fresh={fresh}
                    mapLink={mapLink?.(map.city)}
                    onOpen={onOpen}
                    wallpaper={
                      wallpaper ? { label: wallpaper.label(map.city), onClick: wallpaper.go } : undefined
                    }
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
          wallpaper={wallpaper}
          onShare={() => void share()}
          details={details}
          onDetails={() => setDetails((d) => !d)}
          onRetry={map.retry}
        />
        {wallpaper && (
          <button
            type="button"
            className={cn("more", questionGone && mode !== "retry" && "is-in")}
            onClick={wallpaper.go}
          >
            <span>{wallpaper.more}</span>
            <ArrowDown aria-hidden />
          </button>
        )}
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
