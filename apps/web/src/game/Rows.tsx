import { useLayoutEffect, useRef, useState, type CSSProperties, type MutableRefObject } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@inkcity/ui/lib/utils";
import { MAX_TIER, countryName, type CountryIndex, type GuessView } from "@inkcity/core";
import { fly, type Flight } from "./fly";
import { bearing, formatCount, formatKm } from "./format";

type Props = {
  guesses: readonly GuessView[];
  index: CountryIndex;
  /** The word on its way up from the input, for the newest row to land (./fly.ts). */
  flight: MutableRefObject<Flight | null>;
};

/**
 * The day's guesses, one ruled row each, oldest at the top and the newest right
 * above the line it was written on: the country, a dotted leader to how far today's
 * city is from it, which way to go, and how warm that is on the five-cell ink
 * scale. A guess made just now arrives as its own name, flown up from the input;
 * the rest of its row is written in after it lands.
 */
export default function Rows({ guesses, index, flight }: Props) {
  const { i18n } = useTranslation();
  const lang = i18n.language;
  // Rows already there when the log first showed are simply there.
  const [seen] = useState(guesses.length);
  const names = useRef<(HTMLElement | null)[]>([]);

  useLayoutEffect(() => {
    const word = flight.current;
    const el = names.current[guesses.length - 1];
    if (!word || !el || guesses.length <= seen) return;
    flight.current = null;
    // Measured once the commit is through: Stage's layout effect, a parent's and so
    // run after this one, scrolls the stack to its foot first, and where the row is
    // after that is where the word lands. Still before the frame is painted, so the
    // row never shows before the word gets there.
    queueMicrotask(() => {
      if (el.isConnected) fly(word, el);
    });
  }, [guesses.length, flight, seen]);

  if (guesses.length === 0) return null;
  return (
    // Each guess read out as it's added: the country, how far, which way.
    <ol className="rows" aria-live="polite" aria-relevant="additions">
      {guesses.map((g, i) => (
        <Row
          key={g.code}
          n={i + 1}
          view={g}
          name={countryName(index, g.code, lang)}
          lang={lang}
          fresh={i >= seen}
          nameRef={(el) => {
            names.current[i] = el;
          }}
        />
      ))}
    </ol>
  );
}

function Row({
  n,
  view,
  name,
  lang,
  fresh,
  nameRef,
}: {
  n: number;
  view: GuessView;
  name: string;
  lang: string;
  fresh: boolean;
  nameRef: (el: HTMLElement | null) => void;
}) {
  const { t } = useTranslation();
  return (
    <li className={cn("row", view.correct && "is-correct", fresh && "is-fresh")}>
      <span className="row__n">{formatCount(n, lang)}</span>
      <span ref={nameRef} className="row__name">
        {name}
      </span>
      <span className="row__leader" aria-hidden />
      <span className="row__reading">
        {view.correct ? (
          <Check />
        ) : (
          <>
            <span className="row__km">{formatKm(view.km, lang)}</span>
            <Arrow deg={bearing(view.dir)} label={t(`dir.${view.dir}`)} />
          </>
        )}
        <Warmth tier={view.tier} />
      </span>
    </li>
  );
}

/**
 * Which way to go, as a needle: a bearing on the Earth, so it must never mirror
 * under RTL — an inline transform, not an `rtl:` utility. A fresh row's swings in
 * from north, the short way round (play.css's arrow-swing).
 */
function Arrow({ deg, label }: { deg: number; label: string }) {
  const from = deg > 180 ? deg - 360 : deg;
  return (
    <svg className="row__arrow" viewBox="-8 -8 16 16" role="img" aria-label={label}>
      <g style={{ transform: `rotate(${deg}deg)`, "--from": `${from}deg` } as CSSProperties}>
        <path d="M0 -6.5 L3 1 L0 -0.5 L-3 1 Z" />
        <line x1="0" y1="-0.5" x2="0" y2="6.5" />
      </g>
    </svg>
  );
}

/** A tick drawn in with the pen, for the guess that was right. */
function Check() {
  return (
    <svg className="row__check" viewBox="0 0 16 16" aria-hidden>
      <path d="M2.5 8.5 L6.5 12.2 L13.5 3.8" pathLength={1} />
    </svg>
  );
}

/** How warm a guess is: five cells, inked from the first as it gets closer. */
function Warmth({ tier }: { tier: number }) {
  return (
    <span className="warmth" aria-hidden>
      {Array.from({ length: MAX_TIER }, (_, i) => (
        <i key={i} className={i < tier ? "is-on" : undefined} style={{ "--i": i } as CSSProperties} />
      ))}
    </span>
  );
}
