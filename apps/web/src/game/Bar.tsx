import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { CornerDownLeft } from "lucide-react";
import { cn } from "@inkcity/ui/lib/utils";
import { UI_NS } from "@inkcity/ui/i18n";
import {
  MAX_GUESSES,
  countryName,
  exactCountry,
  normalizeCountryQuery,
  searchCountries,
  type Country,
  type CountryIndex,
  type GameSnapshot,
  type GuessOutcome,
} from "@inkcity/core";
import { prefersReducedMotion, useTransient } from "../lib/hooks";
import { flightFrom, type Flight } from "./fly";
import { formatCount, matchSpan } from "./format";

/**
 * What the bar at the foot of the page is, through a visit:
 *   • `loading`  — the day on its way: one button, waiting;
 *   • `retry`    — it couldn't be loaded: the same button, to try again;
 *   • `choice`   — a newcomer's: Guess, or straight to the wallpaper;
 *   • `input`    — the game: the line to write a guess on;
 *   • `done`     — the day's over: share it, or see it on the globe;
 *   • `revealed` — a day that can't be played: the wallpaper, then.
 */
export type Mode = "loading" | "retry" | "choice" | "input" | "done" | "revealed";

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
  onWallpaper: () => void;
  onShare: () => void;
  details: boolean;
  onDetails: () => void;
  onRetry: () => void;
  /** A word over the bar for a moment (the share's "copied"), or null. */
  note: string | null;
};

type Half = { label: string; onClick: () => void; tone: "ink" | "line" } | null;

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
  const { mode } = props;
  const { t } = useTranslation();

  let a: Half = null;
  let b: Half = null;
  if (mode === "choice") {
    a = { label: t("play.guess"), onClick: props.onChoose, tone: "ink" };
    b = { label: t("play.wallpaper"), onClick: props.onWallpaper, tone: "line" };
  } else if (mode === "done") {
    a = { label: t("result.share"), onClick: props.onShare, tone: "ink" };
    b = { label: props.details ? t("result.back") : t("result.details"), onClick: props.onDetails, tone: "line" };
  } else if (mode === "revealed") {
    a = { label: t("play.wallpaper"), onClick: props.onWallpaper, tone: "ink" };
  }

  return (
    <div className={cn("bar", `bar--${mode}`)}>
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
      {props.note && (
        <p key={props.note} className="bar__note" role="status">
          {props.note}
        </p>
      )}
    </div>
  );
}

type Hint = "alreadyGuessed" | "noMatch";

/**
 * The line a guess is written on, in the bar. The same rules as the desktop's guess
 * card (`GuessCountry` in @inkcity/ui/guess):
 *
 *   • two steps on purpose, because a guess can't be taken back: picking a match
 *     only fills the line, and Enter on a name that matches exactly is what submits;
 *   • Enter mid-composition (pinyin, kana, hangul…) confirms the IME's candidate and
 *     never submits.
 *
 * The matches open upward, over the log, since the line sits at the foot of the
 * page — above a phone's keyboard, when it's up (App.tsx's --kb). Its end counts the
 * guesses — or, once the name is one that would be taken, shows the key that takes
 * it. A name that isn't a country shakes the line.
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
  // A refusal stays up for a moment, then clears itself.
  const [hint, setHint] = useTransient<Hint>(2600);
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
    if (prefersReducedMotion()) return;
    field.current?.parentElement?.animate(
      [{ translate: "0" }, { translate: "-6px" }, { translate: "5px" }, { translate: "-3px" }, { translate: "2px" }, { translate: "0" }],
      { duration: 380, easing: "ease-out" },
    );
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
  const reveal = (i: number) => {
    const ul = list.current;
    const li = ul?.children[i];
    if (!ul || !li) return;
    const box = ul.getBoundingClientRect();
    const at = li.getBoundingClientRect();
    if (at.top < box.top + ul.clientTop) ul.scrollBy({ top: at.top - box.top - ul.clientTop });
    else if (at.bottom > box.top + ul.clientTop + ul.clientHeight) ul.scrollBy({ top: at.bottom - box.top - ul.clientTop - ul.clientHeight });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // keyCode 229 covers WebKit's composition keys.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
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
