import { useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  MAX_GUESSES,
  countryName,
  exactCountry,
  searchCountries,
  type Country,
  type CountryIndex,
  type GameSnapshot,
  type GuessOutcome,
} from "@/core";
import GuessRow from "./GuessRow";

type Props = {
  /** Today's game while it's waiting or underway (`resolving` / `painting` / `playing`). */
  snapshot: GameSnapshot;
  index: CountryIndex;
  saving: boolean;
  /** Why today's map can't be painted, if it can't — shown in place of the hint line. */
  lastError: string | null;
  onGuess: (code: string) => Promise<GuessOutcome | "failed">;
};

type Hint = "alreadyGuessed" | "noMatch";

/**
 * The guess-the-country card: name a country or region, see how far and which way
 * today's city lies from it, six tries. Sits under the (concealed) city card until
 * the day is revealed; that card carries the date, the fetch status and Regenerate,
 * so this one is only the game. Key it by date so a midnight rollover starts it
 * fresh.
 *
 * Entering a guess is two steps on purpose, because a guess can't be taken back:
 * picking a suggestion only fills the box, and Enter (or Guess) on a name that
 * matches exactly is what submits.
 *
 * Nothing here moves the layout: the six rows are reserved from the start, the
 * suggestion list floats over them (it sits at the top of the card because the
 * card clips overflow), and the hint line keeps its height when empty.
 */
export default function GuessCountry({ snapshot, index, saving, lastError, onGuess }: Props) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const [input, setInput] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [hint, setHint] = useState<Hint | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const playing = snapshot.state === "playing";
  const guessed = snapshot.guesses.map((g) => g.code);
  const suggestions = open && playing ? searchCountries(index, input, lang, guessed) : [];
  const exact = exactCountry(index, input, lang);
  const canSubmit = playing && !saving && exact !== null && !guessed.includes(exact.code);

  const pick = (c: Country) => {
    setInput(countryName(index, c.code, lang));
    setOpen(false);
    setHint(null);
    inputRef.current?.focus();
  };

  const submit = async () => {
    if (!playing || saving) return;
    if (!exact) {
      setHint("noMatch");
      return;
    }
    const outcome = await onGuess(exact.code);
    if (outcome === "accepted") {
      setInput("");
      setHint(null);
    } else if (outcome === "alreadyGuessed") {
      setHint("alreadyGuessed");
    } else if (outcome === "unknownCountry") {
      setHint("noMatch");
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // Mid-composition (pinyin, kana, hangul…) Enter confirms the IME's candidate;
    // it must never submit a guess. keyCode 229 covers WebKit's composition keys.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "ArrowDown" && suggestions.length > 0) {
      e.preventDefault();
      setActive((a) => (a + 1) % suggestions.length);
    } else if (e.key === "ArrowUp" && suggestions.length > 0) {
      e.preventDefault();
      setActive((a) => (a - 1 + suggestions.length) % suggestions.length);
    } else if (e.key === "Escape") {
      setOpen(false);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (suggestions.length > 0) pick(suggestions[Math.min(active, suggestions.length - 1)]);
      else void submit();
    }
  };

  // The line under the box: why the game isn't open yet, or what went wrong with
  // the last attempt. A day still resolving says nothing here — the city card
  // above already explains that.
  const line =
    snapshot.state === "painting"
      ? t(lastError ? "game.paintFailed" : "game.painting")
      : hint
        ? t(hint === "alreadyGuessed" ? "game.alreadyGuessed" : "game.noMatch")
        : "";

  return (
    <Card>
      <CardContent className="space-y-2">
        <div className="flex items-baseline justify-between gap-2">
          <div className="text-base font-medium">{t("game.prompt")}</div>
          {playing && (
            <div className="shrink-0 text-xs text-muted-foreground tabular-nums">
              {t("game.progress", { n: snapshot.guesses.length + 1, max: MAX_GUESSES })}
            </div>
          )}
        </div>
        <div className="relative">
          <div className="flex gap-2">
            <Input
              ref={inputRef}
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
              aria-invalid={hint !== null}
              role="combobox"
              aria-expanded={suggestions.length > 0}
              aria-autocomplete="list"
              spellCheck={false}
              autoComplete="off"
            />
            <Button size="sm" className="relative h-8 min-w-16" onClick={() => void submit()} disabled={!canSubmit}>
              {/* Overlaid, with the label kept for its width: an inline spinner would
                  widen the button and squeeze the input beside it. */}
              {saving && <Loader2 className="absolute animate-spin size-3.5" />}
              <span className={saving ? "invisible" : undefined}>{t("game.guess")}</span>
            </Button>
          </div>
          {suggestions.length > 0 && (
            <ul
              className="absolute z-10 mt-1 w-full max-h-52 overflow-y-auto rounded-md border bg-popover shadow-md py-1"
              role="listbox"
            >
              {suggestions.map((c, i) => {
                const name = countryName(index, c.code, lang);
                return (
                  <li key={c.code} role="option" aria-selected={i === active}>
                    <button
                      type="button"
                      className={`w-full text-start px-2 py-1.5 text-sm flex items-baseline gap-2 ${
                        i === active ? "bg-accent" : "hover:bg-accent"
                      }`}
                      // Keep focus in the box, so its blur doesn't close the list mid-click.
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseEnter={() => setActive(i)}
                      onClick={() => pick(c)}
                    >
                      <span>{name}</span>
                      {name !== c.name && <span className="text-xs text-muted-foreground">{c.name}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div className={`text-xs min-h-4 ${hint && playing ? "text-destructive" : "text-muted-foreground"}`}>
          {line}
        </div>
        <ol className="space-y-1">
          {snapshot.guesses.map((g) => (
            <GuessRow key={g.code} view={g} index={index} lang={lang} />
          ))}
          {Array.from({ length: Math.max(0, MAX_GUESSES - snapshot.guesses.length) }, (_, i) => (
            <li key={`empty-${i}`} className="h-7 rounded-md border border-dashed border-foreground/10" />
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}
