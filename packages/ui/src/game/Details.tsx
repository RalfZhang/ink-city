import { Component, lazy, Suspense, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { City, CountryIndex, GuessView } from "@inkcity/core";
import { UI_NS } from "../i18n";

// Whether the globe's code failed to arrive — which only loading the page again
// mends — rather than the globe failing once it had.
let importFailed = false;
// Only fetched when someone asks for the details: the globe and its 80 KB of borders.
const Globe = lazy(() =>
  import("./globe/Globe").catch((e: unknown) => {
    importFailed = true;
    throw e;
  }),
);

type Props = {
  guesses: readonly GuessView[];
  city: City;
  index: CountryIndex;
  theme: "light" | "dark";
};

/**
 * The result's details, in the cards' place over the bar: the day's guesses on a
 * globe (./globe/Globe.tsx), in a frame as wide as the cards and as tall — or, on a
 * page too short for that, as tall as the room there is, so the whole frame is
 * always in view. The frame is outside the wait for the globe, so it rises in once:
 * the first time, it holds bare paper until the globe has loaded.
 */
export default function Details({ guesses, city, index, theme }: Props) {
  const { t } = useTranslation(UI_NS);
  const [attempt, setAttempt] = useState(0);
  // Code that didn't arrive (the website's, offline or replaced by a deploy) stays
  // failed — a failed import stays failed — so trying again is loading the page
  // again; the game's saved, so the page comes back to it. A globe that failed once
  // it had its code (the desktop's always does: it ships with the app) is only
  // mounted again, which leaves the rest of the page as it was.
  const retry = () => (importFailed ? location.reload() : setAttempt((n) => n + 1));
  return (
    <section className="card globe">
      <Caught
        key={attempt}
        fallback={
          <div className="globe__failed" role="alert">
            <p>{t("globe.failed")}</p>
            <button type="button" className="ink-btn" onClick={retry}>
              {t("today.retry")}
            </button>
          </div>
        }
      >
        <Suspense fallback={null}>
          <Globe guesses={guesses} city={city} index={index} theme={theme} />
        </Suspense>
      </Caught>
    </section>
  );
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
