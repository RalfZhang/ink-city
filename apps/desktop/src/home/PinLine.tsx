import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { useToast } from "@inkcity/ui/game";
import { revealMatch } from "@inkcity/ui/game/matches";
import { isComposing, shake } from "@inkcity/ui/game/motion";
import { formatLatLon, parseLatLon, PIN_DECIMALS, type City, type LatLon } from "@inkcity/core";
import { errorText } from "@/lib/action";
import { logWarn } from "@/lib/log";
import type { PassEnd } from "@/types";

/** How long the line must sit still before the bundled list is searched. */
const SEARCH_DEBOUNCE_MS = 180;

/** A pin's precision, ~1 m: what the backend keeps it by (`pipeline::coord_key`). */
const round = (v: number) => Math.round(v * 10 ** PIN_DECIMALS) / 10 ** PIN_DECIMALS;

/**
 * The Customized mode's line, at the foot of the home: where the map is pinned —
 * drawn as the game's guess line is (@inkcity/ui/game's bar), so the foot is one
 * control in either mode. One line takes both forms issue #11 asks for, told apart
 * by whether `parseLatLon` can read the text: coordinates (many formats, a pasted
 * map link among them), or a city's name, looked up in the bundled list
 * (`search_cities`, the daily schedule's own pool) with the matches listed upward
 * from the line. Whatever it was given, what's pinned is then what the line says:
 * the pair itself, as a picked city's — a link or degrees and minutes are written
 * over with it.
 *
 * While the place's map is fetched the line can't be written on, and its key shows
 * the wait (`is-busy`): a pin applied here, or one the backend fetches on its own
 * (at launch, after the cache is cleared). Why it can't be pinned stays over the
 * line until the line is written on again: text that's neither, or — from the
 * backend, once applied — map data the place couldn't be fetched for.
 */
export default function PinLine({
  awaitRun,
  fetching,
  fetchError,
}: {
  /** Hand a function the pass of a run that serves its ticket (App's `awaitRun`). */
  awaitRun: (ticket: number, done: (pass: PassEnd) => void) => void;
  /** Its map is on its way: not to hand yet, and not failed. */
  fetching: boolean;
  fetchError: string | null;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [input, setInput] = useState("");
  const [matches, setMatches] = useState<City[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // The backend's reason holds until the line is written on: then it's about a place no longer there.
  const [edited, setEdited] = useState(false);
  // A pin applied here, until the run it started is over (`awaitRun`). It locks the
  // line from the moment it's sent: until then the status may still name the old pin
  // — or this one, with the reason its last try failed.
  const [pending, setPending] = useState<(LatLon & { place: string }) | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);

  const parsed = parseLatLon(input);
  const query = input.trim();
  const searchable = parsed === null && query.length >= 2;

  useEffect(() => {
    field.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (!searchable) {
      setMatches([]);
      return;
    }
    let live = true;
    const timer = window.setTimeout(() => {
      invoke<City[]>("search_cities", { query })
        .then((found) => {
          if (!live) return;
          setMatches(found);
          setActive(0);
        })
        .catch((e) => logWarn("[city] search failed", e));
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [query, searchable]);

  const locked = pending !== null || fetching;
  const suggestions = open && !locked ? matches : [];

  const refuse = (message: string) => {
    setError(message);
    shake(box.current);
  };

  const pin = async (lat: number, lon: number, place: string) => {
    setInput(`${lat}, ${lon}`);
    setOpen(false);
    setError(null);
    setEdited(false);
    setPending({ lat, lon, place });
    try {
      const ticket = await invoke<number>("apply_custom_city", { lat, lon });
      // Settled by the run it started, once that's over: pinned (a toast says so), or
      // not — the reason then shows over the line, from the status that follows.
      awaitRun(ticket, (pass) => {
        setPending(null);
        if (!pass.failure) toast(t("home.pinnedTo", { place }));
      });
    } catch (e) {
      setPending(null);
      refuse(errorText(e));
    }
  };

  const pick = (c: City) => void pin(round(c.lat), round(c.lon), `${c.name}, ${c.country}`);

  const submit = () => {
    if (locked) return;
    if (suggestions.length > 0) return pick(suggestions[Math.min(active, suggestions.length - 1)]);
    if (!query) return;
    if (!parsed) return refuse(t("home.invalidLocation"));
    const [lat, lon] = [round(parsed.lat), round(parsed.lon)];
    void pin(lat, lon, formatLatLon(lat, lon));
  };

  // A short window shows fewer matches than a search returns: the keys bring the one
  // they move to into view, as the guess line's do.
  const list = useRef<HTMLUListElement>(null);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (isComposing(e)) return;
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && suggestions.length > 0) {
      e.preventDefault();
      // Down is towards the line: to the better match.
      const n = suggestions.length;
      const next = (Math.min(active, n - 1) + (e.key === "ArrowDown" ? n - 1 : 1)) % n;
      setActive(next);
      revealMatch(list.current, next);
    } else if (e.key === "Escape" && suggestions.length > 0) {
      e.stopPropagation();
      setOpen(false);
    } else if (e.key === "Enter") {
      e.preventDefault();
      submit();
    }
  };

  const shown = error ?? (!edited && !locked && fetchError ? t("home.placeFail", { reason: fetchError }) : null);
  return (
    <div ref={box} className={`bar bar--input bar--pin${locked ? " is-busy" : ""}`}>
      {/* The bar's two halves, met as one box, as the game's line has them. */}
      <button type="button" className="bar__half bar__half--a" data-tone="line" disabled aria-hidden tabIndex={-1} />
      <button type="button" className="bar__half bar__half--b" data-tone="line" disabled aria-hidden tabIndex={-1} />
      <div className="bar__over line">
        <input
          ref={field}
          className="line__input"
          value={input}
          // Read-only rather than disabled: the focus stays in the line for when it's free.
          readOnly={locked}
          onChange={(e) => {
            setInput(e.target.value);
            setOpen(true);
            setError(null);
            setEdited(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
          placeholder={t("home.locationPlaceholder")}
          aria-label={t("home.locationPlaceholder")}
          aria-invalid={shown !== null}
          role="combobox"
          aria-expanded={suggestions.length > 0}
          aria-controls="pin-matches"
          aria-autocomplete="list"
          aria-activedescendant={suggestions.length > 0 ? `pin-match-${Math.min(active, suggestions.length - 1)}` : undefined}
          spellCheck={false}
          autoComplete="off"
        />
        <button
          type="button"
          className="line__go line__go--text"
          disabled={locked || !query}
          aria-busy={locked}
          aria-label={locked ? t("home.fetchingPlace") : undefined}
          onMouseDown={(e) => e.preventDefault()}
          onClick={submit}
        >
          {t("home.apply")}
        </button>
        {suggestions.length > 0 && (
          <ul ref={list} id="pin-matches" className="ink-pop matches" role="listbox">
            {suggestions.map((c, i) => (
              <li
                key={c.id}
                id={`pin-match-${i}`}
                role="option"
                aria-selected={i === active}
                className="matches__item"
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(c)}
              >
                <span>
                  {c.name}, {c.country}
                </span>
                {c.localName !== c.name && <span className="matches__en">{c.localName}</span>}
              </li>
            ))}
          </ul>
        )}
        {shown && suggestions.length === 0 && (
          <p className="bar__note is-error" role="alert">
            {shown}
          </p>
        )}
      </div>
    </div>
  );
}
