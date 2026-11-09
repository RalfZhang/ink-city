import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { CornerDownLeft, Globe, Share } from "lucide-react";
import { cn } from "../lib/utils";
import { UI_NS } from "../i18n";
import {
  MAX_GUESSES,
  countryName,
  exactCountry,
  normalizeCountryQuery,
  searchCountries,
  type City,
  type Country,
  type CountryIndex,
  type GameSnapshot,
  type GuessOutcome,
} from "@inkcity/core";
import { isComposing, shake } from "./motion";
import { flightFrom, type Flight } from "./fly";
import { formatCount, matchSpan } from "./format";
import { revealMatch } from "./matches";

/**
 * What the bar at the foot of the page is, through a visit:
 *   • `loading`  — the day on its way: one button, waiting;
 *   • `retry`    — it couldn't be loaded: the same button, to try again;
 *   • `choice`   — a newcomer's, on the website: Guess, or straight to the wallpaper;
 *   • `input`    — the game: the line to write a guess on;
 *   • `done`     — the day's over: share it, or see it on the globe;
 *   • `revealed` — a day that can't be played: the wallpaper, then, where there's one
 *                  to go to.
 */
export type Mode = "loading" | "retry" | "choice" | "input" | "done" | "revealed";

/**
 * The website's way down to its page below — the app that makes the map a
 * wallpaper — and the words for it, which are the website's own (its catalog, not
 * the shared `ui` one): the desktop, which *is* the app, has neither.
 */
export type WallpaperWay = {
  /** Go down to the app. */
  go: () => void;
  /** A newcomer's choice: play… */
  guess: string;
  /** …or have the map as a wallpaper: the way down. */
  set: string;
  /** Under the game's page, that there's more below. */
  more: string;
  /** The result's way down, naming the day's city. */
  label: (city: City) => string;
};

type Props = {
  mode: Mode;
  /** Today's game, for the line to write on. */
  snapshot: GameSnapshot | null;
  index: CountryIndex;
  saving: boolean;
  onGuess: (code: string) => Promise<GuessOutcome | "failed">;
  /** A guess about to be taken: its name, set where it was written, to fly up into the log — or null, if it wasn't taken after all. */
  onFlight: (flight: Flight | null) => void;
  /** Take the cursor when the line arrives: it was asked for (Guess), or the keyboard's right there (a wide screen). */
  focusInput: boolean;
  onChoose: () => void;
  /** The website's page below, with the app; absent, the bar never offers it. */
  /** The website's way down to the app, with its words (the Stage's `wallpaper`). */
  wallpaper?: Pick<WallpaperWay, "go" | "guess" | "set">;
  onShare: () => void;
  details: boolean;
  onDetails: () => void;
  onRetry: () => void;
};

type Half = { label: string; icon?: ReactNode; onClick: () => void; tone: "ink" | "line" } | null;

/**
 * The page's one control, at its foot, and how it changes: two halves of one box
 * that part and meet. Waiting, they're one button; when the day is in they part
 * into two (Guess, Set as wallpaper), or — for a player who's been here lately —
 * become the line to write a guess on, the Guess half widening to take the whole
 * bar while the other folds away. When the game ends the line parts again, into
 * Share and View details. Everything moves on the halves' widths, so each change
 * reads as the same thing turning into the next.
 */
export default function Bar(props: Props) {
  const { mode, wallpaper } = props;
  const { t } = useTranslation(UI_NS);

  let a: Half = null;
  let b: Half = null;
  if (mode === "choice" && wallpaper) {
    a = { label: wallpaper.guess, onClick: props.onChoose, tone: "ink" };
    b = { label: wallpaper.set, onClick: wallpaper.go, tone: "line" };
  } else if (mode === "done") {
    a = { label: t("result.share"), icon: <Share className="bar__ic" aria-hidden />, onClick: props.onShare, tone: "ink" };
    // The same globe either way: the button shows it, then puts it away.
    b = {
      label: props.details ? t("result.back") : t("result.details"),
      icon: <Globe className="bar__ic" aria-hidden />,
      onClick: props.onDetails,
      tone: "line",
    };
  } else if (mode === "revealed" && wallpaper) {
    a = { label: wallpaper.set, onClick: wallpaper.go, tone: "ink" };
  }
  // A day that can't be played, with nowhere to go from it (the desktop is the app the
  // website sends people to): nothing to offer, so no bar at all — not an empty box.
  const empty = mode === "revealed" && !a;

  return (
    <div className={cn("bar", `bar--${mode}`, empty && "is-empty")}>
      {[a, b].map((h, i) => (
        <button
          key={i}
          type="button"
          className={cn("bar__half", i === 0 ? "bar__half--a" : "bar__half--b")}
          data-tone={h?.tone ?? "line"}
          onClick={h?.onClick}
          disabled={!h}
          aria-hidden={h ? undefined : true}
        >
          {h && (
            <span key={h.label} className="bar__label">
              {h.icon}
              {h.label}
            </span>
          )}
        </button>
      ))}
      {mode === "loading" && (
        <p className="bar__over bar__waiting" role="status">
          {t("today.loading")}
        </p>
      )}
      {mode === "retry" && (
        <button type="button" className="bar__over bar__retry" onClick={props.onRetry}>
          {t("today.retry")}
        </button>
      )}
      {mode === "input" && props.snapshot && <GuessLine {...props} snapshot={props.snapshot} />}
    </div>
  );
}

type Hint = "alreadyGuessed" | "noMatch";

/**
 * The line a guess is written on, in the bar — on the website and in the desktop
 * window alike:
 *
 *   • two steps on purpose, because a guess can't be taken back: picking a match
 *     only fills the line, and Enter on a name that matches exactly is what submits;
 *   • Enter mid-composition (pinyin, kana, hangul…) confirms the IME's candidate and
 *     never submits.
 *
 * The matches open upward, over the log, since the line sits at the foot of the
 * page — above a phone's keyboard, when it's up (App.tsx's --kb). Its end counts the
 * guesses — or, once the name is one that would be taken, shows the key that takes
 * it. A name that isn't a country shakes the line, and why stays over it until the
 * line is written on again: a refusal is something to read, not to catch in passing.
 */
function GuessLine({
  snapshot,
  index,
  saving,
  onGuess,
  onFlight,
  focusInput,
}: Props & { snapshot: GameSnapshot }) {
  const { t, i18n } = useTranslation(UI_NS);
  const lang = i18n.language;
  const [input, setInput] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [hint, setHint] = useState<Hint | null>(null);
  const field = useRef<HTMLInputElement>(null);

  const playing = snapshot.state === "playing";
  const guessed = snapshot.guesses.map((g) => g.code);
  const suggestions = open && playing ? searchCountries(index, input, lang, guessed) : [];
  const exact = exactCountry(index, input, lang);
  const ready = playing && !saving && exact !== null && !guessed.includes(exact.code);

  useEffect(() => {
    if (focusInput) field.current?.focus({ preventScroll: true });
  }, [focusInput]);

  const refuse = (h: Hint) => {
    setHint(h);
    shake(field.current?.parentElement);
  };

  const pick = (c: Country) => {
    setInput(countryName(index, c.code, lang));
    setOpen(false);
    setHint(null);
    field.current?.focus();
  };

  const submit = async () => {
    if (!playing || saving) return;
    if (!exact) return refuse("noMatch");
    // Measured before the line is cleared: the word flies from where it was written.
    if (field.current) onFlight(flightFrom(field.current, countryName(index, exact.code, lang)));
    const outcome = await onGuess(exact.code);
    if (outcome === "accepted") {
      // The cursor stays on the line — and a phone's keyboard up — for the next guess,
      // until the game's over or the player leaves the line themselves.
      setInput("");
      setHint(null);
      return;
    }
    onFlight(null);
    if (outcome === "alreadyGuessed") refuse("alreadyGuessed");
    else if (outcome === "unknownCountry") refuse("noMatch");
  };

  // Brought into the list's view when the keys move to it — not when the pointer does,
  // which would scroll the list out from under it.
  const list = useRef<HTMLUListElement>(null);
  const reveal = (i: number) => revealMatch(list.current, i);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (isComposing(e)) return;
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && suggestions.length > 0) {
      e.preventDefault();
      // Down is towards the line: to the better match.
      const n = suggestions.length;
      const next = (Math.min(active, n - 1) + (e.key === "ArrowDown" ? n - 1 : 1)) % n;
      setActive(next);
      reveal(next);
    } else if (e.key === "Escape") {
      setOpen(false);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (suggestions.length > 0) pick(suggestions[Math.min(active, suggestions.length - 1)]);
      else void submit();
    }
  };

  const query = normalizeCountryQuery(input);
  return (
    <div className="bar__over line">
      <input
        ref={field}
        className="line__input"
        value={input}
        onChange={(e) => {
          setInput(e.target.value);
          setOpen(true);
          setActive(0);
          setHint(null);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
        placeholder={t("game.placeholder")}
        disabled={!playing}
        aria-label={t("game.prompt")}
        aria-invalid={hint !== null}
        role="combobox"
        aria-expanded={suggestions.length > 0}
        aria-controls="guess-matches"
        aria-autocomplete="list"
        aria-activedescendant={suggestions.length > 0 ? `guess-match-${Math.min(active, suggestions.length - 1)}` : undefined}
        spellCheck={false}
        autoComplete="off"
        enterKeyHint="go"
      />
      {/* The count, or — with a name that would be taken — the key that takes it, as a button for a touch screen. */}
      {ready ? (
        <button
          type="button"
          className="line__go"
          // The cursor stays on the line through the press, as it does through Enter.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => void submit()}
          aria-label={t("game.guess")}
        >
          <CornerDownLeft aria-hidden />
        </button>
      ) : (
        <span className="line__count" aria-label={t("game.progress", { n: snapshot.guesses.length + 1, max: MAX_GUESSES })}>
          {formatCount(snapshot.guesses.length, lang)}/{formatCount(MAX_GUESSES, lang)}
        </span>
      )}
      {suggestions.length > 0 && (
        // Listed upward from the line, the best match nearest it (play.css).
        <ul ref={list} id="guess-matches" className="ink-pop matches" role="listbox">
          {suggestions.map((c, i) => {
            const name = countryName(index, c.code, lang);
            return (
              <li
                key={c.code}
                id={`guess-match-${i}`}
                role="option"
                aria-selected={i === active}
                className="matches__item"
                // Keep focus in the box, so its blur doesn't close the list mid-click.
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(c)}
              >
                <Marked text={name} query={query} />
                {name !== c.name && <span className="matches__en">{c.name}</span>}
              </li>
            );
          })}
        </ul>
      )}
      {hint && suggestions.length === 0 && (
        <p key={hint} className="bar__note is-error" role="status">
          {t(hint === "alreadyGuessed" ? "game.alreadyGuessed" : "game.noMatch")}
        </p>
      )}
    </div>
  );
}

/** `text` with the part that matches what was typed underlined, where it can be found as typed (./format.ts). */
function Marked({ text, query }: { text: string; query: string }) {
  const span = matchSpan(text, query);
  if (!span) return <span>{text}</span>;
  const [start, end] = span;
  return (
    <span>
      {text.slice(0, start)}
      <mark className="matches__mark">{text.slice(start, end)}</mark>
      {text.slice(end)}
    </span>
  );
}
