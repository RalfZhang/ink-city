import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { emptyGuessStore, parseGuessStore, resetDay, serializeGuessStore, type GuessStore } from "@inkcity/core";
import { useAction } from "@/lib/action";
import { tauriGuessStorage } from "@/lib/guess-storage";
import { useToast } from "@inkcity/ui/game";
import type { Status } from "../types";
import { Check, Pick, Row, Sec } from "./controls";

type PreviewResult = { city: { name: string; localName: string; country: string }; date: string; pngBase64: string; pngPath: string };
type CleanCacheResult = { removedFiles: number; freedBytes: number };

const AHEAD = ["1", "2", "3", "4", "5"] as const;

/** Human-readable byte size (e.g. 1536 → "1.5 KB"). */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/**
 * Dev Mode: the cache, a look at the days ahead, and the game's save. The Daily
 * schedule's tools are off on a pinned place: there's no schedule to look ahead
 * at, and a pin already fetches live, with no cache or CDN to bypass — the backend
 * enforces the bypass half (`AppState::bypass_cache_for`).
 */
export default function DevTab({ status, onGameChanged }: { status: Status; onGameChanged: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const daily = status.updateMode === "daily";
  const clean = useAction();
  const bypass = useAction();
  const preview = useAction();
  const reset = useAction();
  const clear = useAction();
  const reveal = useAction();
  const [ahead, setAhead] = useState<string | null>(null);
  const [shot, setShot] = useState<PreviewResult | null>(null);

  const runPreview = async (days: string) => {
    setAhead(days);
    setShot(null);
    const result = await preview.run(() => invoke<PreviewResult>("preview_city", { daysAhead: Number(days) }));
    if (result) setShot(result);
  };

  // The save, rewritten through the storage the home plays from — which then reads
  // it again (`onGameChanged`); every write makes the backend re-check the
  // wallpaper's caption too (`guess_store_write`).
  const rewrite = async (edit: (store: GuessStore) => GuessStore) => {
    const { store } = parseGuessStore(await tauriGuessStorage.load());
    await tauriGuessStorage.save(serializeGuessStore(edit(store)));
    onGameChanged();
  };

  return (
    <>
      <Sec label={t("devMode.secCache")}>
        <Row label={t("devMode.cleanCacheTitle")} desc={t("devMode.cleanCacheDesc")} error={clean.error}>
          <button
            type="button"
            className="btn btn--brick"
            disabled={clean.busy}
            onClick={async () => {
              const r = await clean.run(() => invoke<CleanCacheResult>("clean_cache"));
              if (r)
                toast(
                  r.removedFiles === 0
                    ? t("devMode.cleanCacheEmpty")
                    : t("devMode.cleanCacheResult", { files: r.removedFiles, size: formatBytes(r.freedBytes) }),
                );
            }}
          >
            {clean.busy ? t("devMode.cleaning") : t("devMode.cleanCacheButton")}
          </button>
        </Row>
        <Row label={t("devMode.bypassCacheTitle")} desc={daily ? t("devMode.bypassCacheDesc") : t("devMode.dailyOnly")} error={bypass.error} off={!daily}>
          <Check
            label={t("devMode.bypassCacheTitle")}
            checked={status.bypassCache}
            disabled={!daily}
            onChange={(on) => void bypass.run(() => invoke("set_bypass_cache", { on }))}
          />
        </Row>
      </Sec>

      <Sec label={t("devMode.secPreview")}>
        <div className={`set set--col${daily ? "" : " is-off"}`}>
          <Row label={t("devMode.advancePreviewTitle")} desc={daily ? t("devMode.advancePreviewDesc") : t("devMode.dailyOnly")} error={preview.error} off={!daily}>
            <Pick
              label={t("devMode.advancePreviewTitle")}
              options={AHEAD.map((n) => [n, `+${n}`] as const)}
              value={ahead}
              disabled={!daily || preview.busy}
              onChange={(n) => void runPreview(n)}
            />
          </Row>
          {daily && (preview.busy || shot) && (
            <>
              <div className="preview-img">
                {shot ? (
                  <img
                    src={`data:image/png;base64,${shot.pngBase64}`}
                    alt={`${shot.city.name} preview`}
                    onDoubleClick={() => void preview.run(() => invoke("open_preview_image", { path: shot.pngPath }))}
                  />
                ) : (
                  <p>{t("devMode.loading")}</p>
                )}
              </div>
              {shot && (
                <span className="small">
                  {shot.date} · {shot.city.name}, {shot.city.country}
                </span>
              )}
            </>
          )}
        </div>
      </Sec>

      <Sec label={t("devMode.secGame")}>
        <Row label={t("devMode.resetTodayTitle")} desc={t("devMode.resetTodayDesc")} error={reset.error}>
          <button
            type="button"
            className="btn btn--line"
            disabled={reset.busy}
            onClick={async () => {
              const ok = await reset.run(async () => (await rewrite((store) => resetDay(store, status.date)), true));
              if (ok) toast(t("devMode.resetDone"));
            }}
          >
            {t("devMode.resetTodayButton")}
          </button>
        </Row>
        <Row label={t("devMode.clearGuessTitle")} desc={t("devMode.clearGuessDesc")} error={clear.error}>
          <button
            type="button"
            className="btn btn--brick"
            disabled={clear.busy}
            onClick={async () => {
              const ok = await clear.run(async () => (await rewrite(() => emptyGuessStore()), true));
              if (ok) toast(t("devMode.clearDone"));
            }}
          >
            {t("devMode.clearGuessButton")}
          </button>
        </Row>
        <Row label={t("devMode.guessFileTitle")} desc={t("devMode.guessFileDesc")} error={reveal.error}>
          <button type="button" className="btn btn--line" onClick={() => void reveal.run(() => invoke("reveal_guess_store"))}>
            {t("devMode.guessFileButton")}
          </button>
        </Row>
      </Sec>
    </>
  );
}
