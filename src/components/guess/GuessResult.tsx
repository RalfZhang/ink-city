import { useTranslation } from "react-i18next";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { MAX_GUESSES, countryName, type CountryIndex, type GameSnapshot } from "@/core";
import { cn } from "@/lib/utils";
import GuessRow from "./GuessRow";

/**
 * Today's result under the revealed city card: how it went, the trail of guesses,
 * and the lifetime record — played, win rate, current and best streak, and how many
 * guesses each win took, with today's bar inked solid (and bold, so it doesn't rely
 * on tone alone).
 */
export default function GuessResult({ snapshot, index }: { snapshot: GameSnapshot; index: CountryIndex }) {
  const { t, i18n } = useTranslation();
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
    <Card className="animate-in fade-in duration-300">
      <CardContent className="space-y-3">
        <div className="text-base font-medium">{headline}</div>
        <ol className="space-y-1">
          {guesses.map((g) => (
            <GuessRow key={g.code} view={g} index={index} lang={lang} />
          ))}
        </ol>
        <Separator />
        <div className="grid grid-cols-4 gap-2 text-center">
          {tiles.map(([value, label]) => (
            <div key={label}>
              <div className="text-xl font-semibold tabular-nums">{value}</div>
              <div className="text-xs text-muted-foreground">{label}</div>
            </div>
          ))}
        </div>
        <div className="space-y-1">
          <div className="text-xs text-muted-foreground">{t("result.distribution")}</div>
          {stats.distribution.map((n, i) => {
            const today = won && guesses.length === i + 1;
            return (
              <div key={i} className="flex items-center gap-2 text-xs tabular-nums">
                <span className="w-3 text-end text-muted-foreground">{num.format(i + 1)}</span>
                <div className="flex-1">
                  <div
                    className={cn(
                      "h-4 min-w-6 rounded-sm px-1.5 text-end text-[11px] leading-4",
                      today ? "bg-foreground text-background font-semibold" : "bg-foreground/15",
                    )}
                    style={{ width: `${(n / tallest) * 100}%` }}
                    aria-current={today ? "true" : undefined}
                  >
                    {num.format(n)}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
