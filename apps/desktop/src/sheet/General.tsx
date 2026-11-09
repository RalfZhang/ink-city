import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { useTranslation } from "react-i18next";
import type { GuessGame } from "@inkcity/ui/guess";
import { MAP_PROVIDERS, isRevealed, type MapProvider } from "@inkcity/core";
import { useAction } from "@/lib/action";
import type { Status, UpdateMode } from "../types";
import { Check, Collapsible, Pick, Row, Sec } from "./controls";
import LanguageMenu from "./LanguageMenu";
import Proxy from "./Proxy";

/**
 * General: which map (Daily, or a pinned place) and whether today's is a game; the
 * app's own settings; and the network. Each control applies the moment it's
 * changed — nothing here waits for a Save — and a failure stays on its row.
 */
export default function General({ status, game }: { status: Status; game: GuessGame }) {
  const { t } = useTranslation();
  const mode = useAction();
  const tray = useAction();
  const quit = useAction();
  const autostartAct = useAction();
  const provider = useAction();
  const cache = useAction();
  const playing = useAction();
  const [autostart, setAutostart] = useState<boolean | null>(null);
  // macOS only — see `wallpaper_cache_dirs` in commands.rs.
  const [hasWallpaperCache, setHasWallpaperCache] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);

  useEffect(() => {
    isEnabled().then(setAutostart, () => setAutostart(false));
    invoke<boolean>("has_wallpaper_cache").then(setHasWallpaperCache, () => setHasWallpaperCache(false));
  }, []);

  const daily = status.updateMode === "daily";
  const snapshot = game.snapshot;
  const gameOn = !(snapshot?.showCityInfo ?? false);
  // Turning the game off gives up a game with guesses today hasn't revealed yet.
  const forfeits = snapshot !== null && !isRevealed(snapshot.state) && snapshot.guesses.length > 0;
  const gameDesc = !gameOn ? t("general.gameDescOff") : snapshot?.resumesTomorrow ? t("general.gameTomorrow") : t("general.gameDescOn");
  const noTray = status.hideTray || !status.trayAvailable;

  return (
    <>
      <Sec label={t("general.secWallpaper")}>
        <Row label={t("general.howToUpdate")} error={mode.error}>
          <Pick<UpdateMode>
            label={t("general.howToUpdate")}
            options={[
              ["daily", t("general.modeDaily")],
              ["customized", t("general.modeCustomized")],
            ]}
            value={status.updateMode}
            onChange={(m) => void mode.run(() => invoke("set_update_mode", { mode: m }))}
          />
        </Row>
        {/* The game is Daily's alone. */}
        <Collapsible open={daily}>
          <Row label={t("general.gameLabel")} desc={gameDesc} error={playing.error}>
            <Check
              label={t("general.gameLabel")}
              checked={gameOn}
              disabled={!snapshot || game.saving}
              onChange={(on) => (on ? void playing.run(() => game.setPlaying(true)) : setConfirmOff(true))}
            />
          </Row>
          <Collapsible open={confirmOff}>
            <div className="confirm" role="alertdialog" aria-label={t("general.gameOffTitle")}>
              <p>
                <b>{t("general.gameOffTitle")}</b>
              </p>
              <p>{t("general.gameOffBody")}</p>
              {forfeits && <p>{t("general.gameOffForfeit")}</p>}
              <div className="set__acts">
                <button type="button" className="btn btn--line" onClick={() => setConfirmOff(false)}>
                  {t("general.cancel")}
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setConfirmOff(false);
                    void playing.run(() => game.setPlaying(false));
                  }}
                >
                  {t("general.gameOffConfirm")}
                </button>
              </div>
            </div>
          </Collapsible>
        </Collapsible>
      </Sec>

      <Sec label={t("general.secApp")}>
        <Row label={t("general.autostartLabel")} error={autostartAct.error}>
          <Check
            label={t("general.autostartLabel")}
            checked={autostart ?? false}
            disabled={autostart === null}
            onChange={(on) =>
              void autostartAct.run(async () => {
                if (on) await enable();
                else await disable();
                setAutostart(on);
              })
            }
          />
        </Row>
        {/* Hidden, it says how the window comes back. */}
        <Row label={t("general.hideTrayLabel")} error={tray.error}>
          <Check
            label={t("general.hideTrayLabel")}
            checked={status.hideTray}
            onChange={(hide) => void tray.run(() => invoke("set_hide_tray", { hide }))}
          />
        </Row>
        {/* With no tray icon there's no tray menu to quit from, and no Dock either. */}
        <Collapsible open={noTray}>
          <Row label={t("general.quitLabel")} desc={t("general.quitDesc")} error={quit.error}>
            <button type="button" className="btn btn--line" onClick={() => void quit.run(() => invoke("quit_app"))}>
              {t("general.quit")}
            </button>
          </Row>
        </Collapsible>
        <Row label={<LanguageLabel />}>
          <LanguageMenu />
        </Row>
        <Row label={t("general.mapServiceLabel")} desc={t("general.mapServiceHint")} error={provider.error}>
          <Pick<MapProvider>
            label={t("general.mapServiceLabel")}
            options={MAP_PROVIDERS.map((p) => [p.id, t(p.labelKey)] as const)}
            value={status.mapProvider}
            onChange={(p) => void provider.run(() => invoke("set_map_provider", { provider: p }))}
          />
        </Row>
        {hasWallpaperCache && (
          <Row label={t("general.wallpaperCacheLabel")} desc={t("general.wallpaperCacheDesc")} error={cache.error}>
            <button type="button" className="btn btn--line" onClick={() => void cache.run(() => invoke("open_wallpaper_cache"))}>
              {t("general.wallpaperCacheOpen")}
            </button>
          </Row>
        )}
      </Sec>

      <Sec label={t("general.secNetwork")}>
        <Proxy mode={status.proxyMode} url={status.proxyUrl} />
      </Sec>
    </>
  );
}

/** "Language", with the English word beside it in any other language — a way back for someone who can't read the one they landed in. */
function LanguageLabel() {
  const { t, i18n } = useTranslation();
  return (
    <>
      {t("general.languageLabel")}
      {!i18n.language.startsWith("en") && (
        <small lang="en"> · Language</small>
      )}
    </>
  );
}
