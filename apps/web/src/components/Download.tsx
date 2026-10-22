import { useTranslation } from "react-i18next";
import { Check, Download as DownloadIcon, Share } from "lucide-react";
import {
  DESKTOP_DOWNLOADS,
  DESKTOP_PLATFORM_NAMES,
  DESKTOP_PLATFORMS,
  desktopDownloadUrl,
  type DesktopDownload,
} from "@inkcity/core";
import { formatCountdown } from "../lib/date";
import { useTransient, useUntilMidnight } from "../lib/hooks";
import type { Visitor } from "../lib/platform";
import { shareOrCopy } from "../lib/share";

/**
 * The installers, led by the visitor's own platform: one button for macOS or
 * Windows, both packages for Linux (which one a distribution takes isn't something
 * a browser can tell), all three platforms side by side when we can't place it,
 * and under it every other installer, a line per platform. A phone gets no download
 * at all — a way to send the page to a computer instead.
 */
export function DownloadOptions({ visitor }: { visitor: Visitor }) {
  const { t } = useTranslation();
  if (visitor === "mobile") return <SendToSelf />;

  const kind = (d: DesktopDownload) => t(`download.kind.${d.kind}`);
  let lead: DesktopDownload[];
  let primary;
  if (visitor === "unknown") {
    lead = DESKTOP_PLATFORMS.map((p) => DESKTOP_DOWNLOADS[p][0]);
    primary = (
      <div className="downloads__row">
        {DESKTOP_PLATFORMS.map((p) => (
          <FileButton key={p} file={DESKTOP_DOWNLOADS[p][0]} label={DESKTOP_PLATFORM_NAMES[p]} />
        ))}
      </div>
    );
  } else if (visitor === "linux") {
    lead = [...DESKTOP_DOWNLOADS.linux];
    primary = (
      <div className="downloads__row">
        {DESKTOP_DOWNLOADS.linux.map((d) => (
          <FileButton key={d.file} file={d} label={`.${d.kind}`} hint={kind(d)} />
        ))}
      </div>
    );
  } else {
    const first = DESKTOP_DOWNLOADS[visitor][0];
    lead = [first];
    primary = (
      <FileButton
        file={first}
        label={t("download.button", { os: DESKTOP_PLATFORM_NAMES[visitor] })}
        hint={`${kind(first)} · .${first.kind}`}
        icon
      />
    );
  }
  // Every other installer, a line per platform: its name, then each of its files.
  const rest = DESKTOP_PLATFORMS.map((p) => ({ platform: p, files: DESKTOP_DOWNLOADS[p].filter((d) => !lead.includes(d)) })).filter(
    (r) => r.files.length > 0,
  );

  return (
    <div className="downloads">
      {primary}
      {rest.length > 0 && (
        <ul className="downloads__others">
          {rest.map(({ platform, files }) => (
            <li key={platform}>
              <span>{t("download.button", { os: DESKTOP_PLATFORM_NAMES[platform] })}</span>
              {files.map((d) => (
                <a key={d.file} className="ink-link" href={desktopDownloadUrl(d.file)}>
                  {kind(d)} · .{d.kind}
                </a>
              ))}
            </li>
          ))}
        </ul>
      )}
      <p className="downloads__note">{t("download.free")}</p>
    </div>
  );
}

function FileButton({ file, label, hint, icon }: { file: DesktopDownload; label: string; hint?: string; icon?: boolean }) {
  return (
    <a className="ink-btn file-btn" href={desktopDownloadUrl(file.file)}>
      <span className="file-btn__label">
        {icon && <DownloadIcon aria-hidden />}
        {label}
      </span>
      {hint && <span className="file-btn__hint">{hint}</span>}
    </a>
  );
}

/** The countdown to the next city: its own component, so its tick re-renders only this line. */
export function Countdown() {
  const { t } = useTranslation();
  const left = useUntilMidnight();
  return <p className="countdown">{t("download.countdown", { time: formatCountdown(left) })}</p>;
}

/**
 * For a phone: nothing to install here, so hand the page to the visitor's own
 * share sheet (AirDrop, a message to themselves…), or copy its link where there is
 * none.
 */
function SendToSelf() {
  const { t } = useTranslation();
  const [copied, setCopied] = useTransient<true>(2500);
  // Where it can't be copied either, there's nothing more a page can do; the address bar still has the link.
  const send = async () => {
    const url = location.href;
    if ((await shareOrCopy({ title: document.title, url }, url)) === "copied") setCopied(true);
  };
  return (
    <div className="downloads">
      <p className="downloads__note">{t("download.mobile")}</p>
      <button type="button" className="ink-btn file-btn" onClick={() => void send()}>
        <span className="file-btn__label">
          {copied ? <Check aria-hidden /> : <Share aria-hidden />}
          {copied ? t("download.copied") : t("download.share")}
        </span>
      </button>
    </div>
  );
}
