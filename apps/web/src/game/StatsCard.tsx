import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@inkcity/ui/lib/utils";
import { UI_NS } from "@inkcity/ui/i18n";
import { MAX_GUESSES, countryName, type CountryIndex, type GameSnapshot } from "@inkcity/core";

/**
 * How today went, and the lifetime record: played, win rate, current and best
 * streak, and how many guesses each win took — today's bar in solid ink (and its
 * count bold, so it doesn't rely on tone alone), the rest hatched.
 */
export default function StatsCard({ snapshot, index, fresh }: { snapshot: GameSnapshot; index: CountryIndex; fresh: boolean }) {
  const { t, i18n } = useTranslation(UI_NS);
  const lang = i18n.language;
  const { stats, guesses } = snapshot;
  const won = snapshot.state === "won";
  const country = snapshot.answer ? countryName(index, snapshot.answer, lang) : "";
  const headline = won
    ? t("result.won", { n: guesses.length })
    : snapshot.state === "lost"
      ? t("result.lost", { max: MAX_GUESSES, country })
      : t("result.gaveUp", { country });
  const num = new Intl.NumberFormat(lang);
  const percent = new Intl.NumberFormat(lang, { style: "percent", maximumFractionDigits: 0 });
  const tiles: [string, string][] = [
    [num.format(stats.played), t("result.played")],
    [percent.format(stats.played > 0 ? stats.wins / stats.played : 0), t("result.winRate")],
    [num.format(stats.currentStreak), t("result.streak")],
    [num.format(stats.maxStreak), t("result.maxStreak")],
  ];
  const tallest = Math.max(1, ...stats.distribution);

  return (
    <section className={cn("card stats", fresh && "is-fresh")}>
      <p className="stats__headline">{headline}</p>
      <dl className="stats__tiles">
        {tiles.map(([value, label]) => (
          <div key={label} className="stats__tile">
            <dt className="ink-label">{label}</dt>
            <dd className="stats__n">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="ink-label stats__dist-label">{t("result.distribution")}</p>
      <ol className="dist">
        {stats.distribution.map((n, i) => {
          const today = won && guesses.length === i + 1;
          return (
            <li key={i} className={cn("dist__row", today && "is-today", n === 0 && "is-zero")} aria-current={today ? "true" : undefined}>
              <span className="dist__n">{num.format(i + 1)}</span>
              <span className="dist__track">
                {n > 0 && <span className="dist__bar" style={{ "--f": n / tallest, "--i": i } as CSSProperties} />}
                <span className="dist__count">{num.format(n)}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
