import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Download as DownloadIcon, Share } from "lucide-react";
import { Button } from "@inkcity/ui/components/button";
import { Card, CardContent } from "@inkcity/ui/components/card";
import {
  DESKTOP_DOWNLOADS,
  DESKTOP_PLATFORM_NAMES,
  DESKTOP_PLATFORMS,
  desktopDownloadUrl,
  type City,
  type DesktopDownload,
  type DesktopPlatform,
} from "@inkcity/core";
import { cityName } from "../lib/city-name";
import { formatCountdown } from "../lib/date";
import { useUntilMidnight } from "../lib/hooks";
import type { Visitor } from "../lib/platform";

/**
 * The result's call to action: today's city as the wallpaper it could be, the
 * countdown to the next one, and the download — what the game was there to lead to.
 */
export function DownloadCard({ city, visitor }: { city: City; visitor: Visitor }) {
  const { t, i18n } = useTranslation();
  return (
    <Card className="animate-in fade-in duration-300">
      <CardContent className="space-y-3">
        <div className="text-base font-medium">{t("download.title", { city: cityName(city, i18n.language) })}</div>
        <p className="text-sm text-muted-foreground">{t("download.body")}</p>
        <Countdown />
        <DownloadOptions visitor={visitor} />
      </CardContent>
    </Card>
  );
}

/** The countdown to the next city: its own component, so its tick re-renders only this line. */
function Countdown() {
  const { t } = useTranslation();
  const left = useUntilMidnight();
  return (
    <p className="text-xs text-muted-foreground tabular-nums">
      {t("download.countdown", { time: formatCountdown(left) })}
    </p>
  );
}

/**
 * The low-key version while the game is still on: one line about the app, and the
 * downloads behind a link.
 */
export function DownloadTeaser({ visitor }: { visitor: Visitor }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-3 px-1 text-xs text-muted-foreground">
      <p>
        {t("download.teaser")}{" "}
        {!open && (
          <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => setOpen(true)}>
            {t("download.teaserLink")}
          </button>
        )}
      </p>
      {open && <DownloadOptions visitor={visitor} />}
    </div>
  );
}

/**
 * The installers, led by the visitor's own platform: one button for macOS or
 * Windows, both packages for Linux (which one a distribution takes isn't something
 * a browser can tell), all three platforms side by side when we can't place it,
 * and the rest under "Other platforms". A phone gets no download at all — a way to
 * send the page to a computer instead.
 */
function DownloadOptions({ visitor }: { visitor: Visitor }) {
  const { t } = useTranslation();
  if (visitor === "mobile") return <SendToSelf />;

  const kind = (d: DesktopDownload) => t(`download.kind.${d.kind}`);
  const others = DESKTOP_PLATFORMS.filter((p) => p !== visitor);
  let lead: DesktopDownload[];
  let primary;
  if (visitor === "unknown") {
    lead = DESKTOP_PLATFORMS.map((p) => DESKTOP_DOWNLOADS[p][0]);
    primary = (
      <div className="grid grid-cols-3 gap-2">
        {DESKTOP_PLATFORMS.map((p) => (
          <FileButton key={p} file={DESKTOP_DOWNLOADS[p][0]} label={DESKTOP_PLATFORM_NAMES[p]} />
        ))}
      </div>
    );
  } else if (visitor === "linux") {
    lead = [...DESKTOP_DOWNLOADS.linux];
    primary = (
      <div className="grid grid-cols-2 gap-2">
        {DESKTOP_DOWNLOADS.linux.map((d) => (
          <FileButton key={d.file} file={d} label={`.${d.kind}`} hint={kind(d)} />
        ))}
      </div>
    );
  } else {
    const first = DESKTOP_DOWNLOADS[visitor][0];
    lead = [first];
    primary = (
      <FileButton file={first} label={t("download.button", { os: DESKTOP_PLATFORM_NAMES[visitor] })} hint={`${kind(first)} · .${first.kind}`} wide />
    );
  }
  const rest = DESKTOP_PLATFORMS.flatMap((p) =>
    DESKTOP_DOWNLOADS[p].filter((d) => !lead.includes(d)).map((d) => ({ platform: p, d })),
  );

  return (
    <div className="space-y-2">
      {primary}
      <p className="text-xs text-muted-foreground">
        {visitor === "unknown"
          ? t("download.free")
          : t("download.alsoOn", { others: others.map((p) => DESKTOP_PLATFORM_NAMES[p]).join(" / ") })}
      </p>
      {rest.length > 0 && <OtherPlatforms items={rest} kind={kind} />}
    </div>
  );
}

function FileButton({ file, label, hint, wide }: { file: DesktopDownload; label: string; hint?: string; wide?: boolean }) {
  return (
    <Button asChild className={wide ? "h-auto w-full flex-col gap-0 py-2" : "h-auto flex-col gap-0 py-1.5"}>
      <a href={desktopDownloadUrl(file.file)}>
        <span className="flex items-center gap-1.5">
          {wide && <DownloadIcon />}
          {label}
        </span>
        {hint && <span className="text-[11px] font-normal opacity-70">{hint}</span>}
      </a>
    </Button>
  );
}

function OtherPlatforms({
  items,
  kind,
}: {
  items: { platform: DesktopPlatform; d: DesktopDownload }[];
  kind: (d: DesktopDownload) => string;
}) {
  const { t } = useTranslation();
  return (
    <details className="group text-xs">
      <summary className="cursor-pointer list-none text-muted-foreground hover:text-foreground select-none">
        <span className="underline underline-offset-2">{t("download.otherPlatforms")}</span>
      </summary>
      <ul className="mt-2 space-y-1">
        {items.map(({ platform, d }) => (
          <li key={d.file}>
            <a className="flex items-baseline gap-2 rounded-md px-2 py-1 hover:bg-accent" href={desktopDownloadUrl(d.file)}>
              <span className="font-medium">{DESKTOP_PLATFORM_NAMES[platform]}</span>
              <span className="text-muted-foreground">
                {kind(d)} · .{d.kind}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * For a phone: nothing to install here, so hand the page to the visitor's own
 * share sheet (AirDrop, a message to themselves…), or copy its link where there is
 * none.
 */
function SendToSelf() {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const send = async () => {
    const url = location.href;
    if (navigator.share) {
      try {
        await navigator.share({ title: document.title, url });
        return;
      } catch (e) {
        // Dismissing the sheet is a choice, not a failure; anything else falls through to copying.
        if (e instanceof DOMException && e.name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Nothing more a page can do; the address bar still has the link.
    }
  };
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">{t("download.mobile")}</p>
      <Button className="w-full" onClick={() => void send()}>
        {copied ? <Check /> : <Share />}
        {copied ? t("download.copied") : t("download.share")}
      </Button>
    </div>
  );
}
