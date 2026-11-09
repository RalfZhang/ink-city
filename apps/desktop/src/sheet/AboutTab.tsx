import { useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Trans, useTranslation } from "react-i18next";
import { ArrowUpRight } from "lucide-react";
import { CC_BY_URL, GEONAMES_URL, GITHUB_ISSUES, ODBL_URL, OSM_COPYRIGHT_URL, VISUAL_DESIGNER, WEBSITE_URL } from "@inkcity/core";
import { errorText, useAction } from "@/lib/action";
import { logError } from "@/lib/log";
import { useToast } from "@inkcity/ui/game";
import type { Status, UpdateCheck } from "../types";
import { Check, Pick, Row, Sec } from "./controls";

// Clicks reset if more than this elapses between them, so it takes seven clicks
// *in a row*, not seven cumulative clicks over an arbitrarily long session.
const DEV_MODE_CLICK_WINDOW_MS = 1500;
const DEV_MODE_CLICKS_REQUIRED = 7;

// Transient feedback only. Whether an update *is available* is read from
// `status.updateAvailable` (the Rust source of truth), so it survives tab
// switches and window reopens.
type UpdateState = "idle" | "checking" | "installing" | "uptodate" | "unavailable" | "error";

// A failed update check isn't always a fault. During the brief release window a
// freshly-tagged release can be "latest" before its latest.json asset finishes
// uploading (the endpoint 404s), and users are frequently just offline. Treat
// those as a calm "unavailable"; reserve the error for genuinely unexpected
// failures such as a malformed manifest.
function isBenignUpdateError(e: unknown): boolean {
  const msg = errorText(e).toLowerCase();
  return ["404", "not found", "releasenotfound", "network", "timed out", "timeout", "dns", "connect", "offline", "sending request", "failed to fetch"].some(
    (s) => msg.includes(s),
  );
}

/** An inline link that opens in the system browser (an anchor would navigate the webview). Its text comes from <Trans>. */
function ExtLink({ href, children }: { href: string; children?: ReactNode }) {
  return (
    <button type="button" className="ink-link" onClick={() => void openUrl(href)}>
      {children}
    </button>
  );
}

/**
 * About: what InkCity is, its website, and its version (seven clicks
 * on which unlock Dev Mode); updates, where the install can take them; help; and
 * at the foot, the imprint — the data's attribution in full, the designer, the
 * copyright — as the website's foot has it.
 */
export default function AboutTab({ status, onToggleDevMode }: { status: Status; onToggleDevMode: () => Promise<void> }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const [version, setVersion] = useState("");
  const [updateState, setUpdateState] = useState<UpdateState>("idle");
  const [updateError, setUpdateError] = useState<string | null>(null);
  const clicks = useRef({ count: 0, last: 0 });
  // A cancel and an "already up to date" both come back as `false` from
  // `install_update`; only the click that asked can tell them apart.
  const cancelRequested = useRef(false);
  const cadence = useAction();
  const auto = useAction();
  const logs = useAction();
  const dev = useAction();

  // The backend flag, not our own click: the tray entry and auto-update start
  // downloads with no window involved.
  const installing = status.updateInstalling || updateState === "installing";
  const busy = updateState === "checking" || installing;

  useEffect(() => {
    getVersion().then(setVersion, () => {});
  }, []);

  const onVersionClick = () => {
    const now = Date.now();
    const c = clicks.current;
    c.count = now - c.last <= DEV_MODE_CLICK_WINDOW_MS ? c.count + 1 : 1;
    c.last = now;
    if (c.count >= DEV_MODE_CLICKS_REQUIRED) {
      c.count = 0;
      // Said once it's so; a switch that couldn't be saved says why instead (below).
      const off = status.devMode;
      void dev.run(async () => {
        await onToggleDevMode();
        toast(off ? t("about.devOff") : t("about.devOn"));
      });
    }
  };

  const installUpdate = async () => {
    cancelRequested.current = false;
    setUpdateState("installing");
    try {
      // Rust re-checks, downloads, installs, then relaunches — so on success this
      // never resolves. `false` means there was nothing to install.
      const installed = await invoke<boolean>("install_update");
      if (!installed) setUpdateState(cancelRequested.current ? "idle" : "uptodate");
    } catch (e) {
      if (cancelRequested.current) return setUpdateState("idle");
      logError("[updater] install failed", e);
      setUpdateError(errorText(e));
      setUpdateState(isBenignUpdateError(e) ? "unavailable" : "error");
    }
  };

  const cancelUpdate = () => {
    cancelRequested.current = true;
    void invoke("cancel_update");
  };

  const checkForUpdate = async () => {
    setUpdateState("checking");
    try {
      const found = await invoke<string | null>("check_for_update");
      if (!found) {
        setUpdateState("uptodate");
        toast(t("general.upToDate"));
        return;
      }
      if (status.autoUpdate && !installing) await installUpdate();
      else setUpdateState("idle");
    } catch (e) {
      logError("[updater] check failed", e);
      setUpdateError(errorText(e));
      setUpdateState(isBenignUpdateError(e) ? "unavailable" : "error");
    }
  };

  const lastChecked = (() => {
    if (status.lastUpdateCheck === null) return t("about.neverChecked");
    const at = new Date(status.lastUpdateCheck * 1000);
    const today = at.toDateString() === new Date().toDateString();
    const when = new Intl.DateTimeFormat(i18n.language, today ? { timeStyle: "short" } : { dateStyle: "medium", timeStyle: "short" }).format(at);
    return t("about.lastChecked", { when });
  })();

  // One line for where things stand, one button for the one thing to do about it.
  // Only while that failure is still the news: an update found since (by the background
  // check, or the tray) or one being installed is what the line says then.
  const failed = (updateState === "error" || updateState === "unavailable") && !status.updateAvailable && !installing;
  const line = installing
    ? status.updateProgress === null
      ? t("general.installing")
      : `${status.updateProgress}%`
    : updateState === "checking"
      ? t("general.checking")
      : status.updateAvailable
        ? t("general.updateAvailable", { version: status.updateAvailable })
        : updateState === "error"
          ? `${t("general.updateError")}: ${updateError ?? ""}`
          : updateState === "unavailable"
            ? t("general.updateUnavailable")
            : lastChecked;

  return (
    <>
      <div className="ahead">
        <p className="ahead__name">InkCity</p>
        <p className="ahead__tag">{t("about.tagline")}</p>
        <p className="ahead__meta">
          <button type="button" className="ink-link" onClick={() => void openUrl(WEBSITE_URL)} title={WEBSITE_URL}>
            {t("about.website")}
            <ArrowUpRight className="ic" aria-hidden />
          </button>
          {/* Seven clicks in a row unlock Dev Mode; it's just text to everyone else. */}
          <span className="ver" onClick={onVersionClick}>
            {t("about.version", { version: version || "…" })}
          </span>
          {dev.error && (
            <span className="is-bad" role="alert">
              {dev.error}
            </span>
          )}
        </p>
      </div>

      {/* Hidden outright on an install the updater can't act on — a Linux .deb/.rpm,
          whose updates come from the system package manager (`updates::supported`). */}
      {status.updaterSupported && (
        <Sec label={t("about.secUpdates")}>
          <Row label={t("general.updateCheckLabel")} error={cadence.error}>
            <Pick<UpdateCheck>
              label={t("general.updateCheckLabel")}
              options={[
                ["daily", t("general.updateDaily")],
                ["weekly", t("general.updateWeekly")],
                ["monthly", t("general.updateMonthly")],
                ["never", t("general.updateNever")],
              ]}
              value={status.updateCheck}
              onChange={(v) => void cadence.run(() => invoke("set_update_check", { value: v }))}
            />
          </Row>
          <Row label={t("general.autoUpdateLabel")} desc={t("general.autoUpdateDesc")} error={auto.error}>
            <Check
              label={t("general.autoUpdateLabel")}
              checked={status.autoUpdate}
              disabled={status.updateCheck === "never"}
              onChange={(on) => void auto.run(() => invoke("set_auto_update", { on }))}
            />
          </Row>
          <Row label={<span className={failed ? "is-bad" : "small"}>{line}</span>}>
            {installing ? (
              <button type="button" className="btn btn--line" onClick={cancelUpdate}>
                {t("general.cancel")}
              </button>
            ) : status.updateAvailable ? (
              <button type="button" className="btn" onClick={() => void installUpdate()} disabled={busy}>
                {t("general.installRestart")}
              </button>
            ) : (
              <button type="button" className="btn btn--line" onClick={() => void checkForUpdate()} disabled={busy}>
                {updateState === "checking" ? t("general.checking") : failed ? t("home.retry") : t("general.checkNow")}
              </button>
            )}
          </Row>
        </Sec>
      )}

      <Sec label={t("about.secHelp")}>
        <Row label={t("about.feedbackTitle")} desc={t("about.feedbackDesc")}>
          <button type="button" className="btn btn--line" onClick={() => void openUrl(GITHUB_ISSUES)}>
            {t("about.openIssues")}
          </button>
        </Row>
        <Row label={t("about.logsTitle")} desc={t("about.logsDesc")} error={logs.error}>
          <button type="button" className="btn btn--line" onClick={() => void logs.run(() => invoke("open_log_dir"))}>
            {t("about.openLogs")}
          </button>
        </Row>
      </Sec>

      <footer className="imprint">
        <p>
          <Trans i18nKey="about.osmAttribution" components={[<ExtLink href={OSM_COPYRIGHT_URL} />, <ExtLink href={ODBL_URL} />]} />
        </p>
        <p>
          <Trans i18nKey="about.geonamesAttribution" components={[<ExtLink href={GEONAMES_URL} />, <ExtLink href={CC_BY_URL} />]} />
        </p>
        <p>{t("about.designCredit", { name: VISUAL_DESIGNER })}</p>
        <p className="imprint__last">© {new Date().getFullYear()} Ralf Zhang</p>
      </footer>
    </>
  );
}
