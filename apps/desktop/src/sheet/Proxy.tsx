import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { useAction } from "@/lib/action";
import { useToast } from "@inkcity/ui/game";
import { isComposing } from "@inkcity/ui/game/motion";
import type { ProxyMode } from "../types";
import { Pick, Row } from "./controls";

/** A URL the backend (reqwest::Proxy::all) will take: an http(s) or socks5 scheme with a host. */
function parseProxy(raw: string): URL | null {
  try {
    const u = new URL(raw.trim());
    return ["http:", "https:", "socks5:", "socks5h:"].includes(u.protocol) && u.hostname !== "" ? u : null;
  } catch {
    return null;
  }
}

type Probe = { target: "cdn" | "github" | "overpass"; ok: boolean; ms: number; reason: "proxy" | "timeout" | "status" | "network" | null; detail: string | null };
type Test = { route: string; probes: Probe[] | null };

/** Where the OS keeps its proxy, for the System choice's note — told by the webview's own UA (WKWebView says Macintosh, WebView2 Windows NT, WebKitGTK Linux). */
const OS = /Windows/.test(navigator.userAgent) ? "windows" : /Macintosh|Mac OS X/.test(navigator.userAgent) ? "macos" : "linux";

/**
 * The Proxy setting: off, the system's, or an address of the user's own — and a
 * test of whichever is picked, reaching the three services the app relies on. The
 * custom address applies with Enter or Apply, never on each keystroke; the test
 * takes the address as typed, so it can be tried before it's applied. A result
 * belongs to the route it tested: switching modes or editing the address clears it.
 */
export default function Proxy({ mode, url }: { mode: ProxyMode; url: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [draft, setDraft] = useState(url);
  const [system, setSystem] = useState<string | null | undefined>(undefined);
  const [test, setTest] = useState<Test | null>(null);
  const token = useRef(0);

  useEffect(() => setDraft(url), [url]);
  useEffect(() => {
    if (mode !== "system") return;
    let live = true;
    invoke<string | null>("get_system_proxy").then((u) => live && setSystem(u ?? null), () => live && setSystem(null));
    return () => {
      live = false;
    };
  }, [mode]);

  const forgetTest = () => {
    token.current++;
    setTest(null);
  };

  // Through `useAction`, as every other row: a refusal is logged too — the file a
  // user reporting "the proxy won't apply" can attach — and an older try that
  // answers late can't overwrite a newer one's outcome.
  const applying = useAction();
  const apply = async (nextMode: ProxyMode, nextUrl: string) => {
    const ok = await applying.run(async () => {
      await invoke("apply_proxy_settings", { mode: nextMode, url: nextUrl });
      return true;
    });
    return ok === true;
  };

  const parsed = parseProxy(draft);
  const empty = draft.trim() === "";
  const applied = draft.trim() === url.trim();

  const applyDraft = async () => {
    if (!parsed || applied) return;
    if (await apply("custom", draft)) toast(t("proxy.applied"));
  };

  // What a test goes through now: straight out, the system's proxy, or the address in the box.
  const route = mode === "off" ? t("proxy.direct") : mode === "system" ? (system ?? t("proxy.direct")) : parsed ? draft.trim() : null;

  const runTest = async () => {
    if (route === null) return;
    const id = ++token.current;
    setTest({ route, probes: null });
    const probes = await invoke<Probe[]>("test_proxy", { mode, url: draft });
    if (id === token.current) setTest({ route, probes });
  };

  const why = (p: Probe) =>
    p.reason === "proxy"
      ? t("proxy.whyProxy")
      : p.reason === "timeout"
        ? t("proxy.whyTimeout")
        : p.reason === "status"
          ? t("proxy.whyStatus", { detail: p.detail ?? "" })
          : t("proxy.whyNetwork");
  const from = OS === "macos" ? t("proxy.systemFromMacos") : OS === "windows" ? t("proxy.systemFromWindows") : t("proxy.systemFromLinux");

  return (
    <Row label={t("proxy.label")} desc={t("proxy.desc")} error={applying.error} col>
      <div className="proxy">
        <Pick
          label={t("proxy.label")}
          options={[
            ["off", t("proxy.off")],
            ["system", t("proxy.system")],
            ["custom", t("proxy.custom")],
          ]}
          value={mode}
          onChange={(m) => {
            forgetTest();
            // The saved address is kept whichever mode is picked; an edit to it
            // that's valid goes in with Custom, as Apply would.
            void apply(m, m === "custom" && parseProxy(draft) ? draft : url);
          }}
        />
        {mode === "system" && system !== undefined && (
          <p className="pstate">
            {system ? (
              <span>
                <i className="dot is-on" />
                {t("proxy.systemUsing")} <code>{system}</code> · {from}
              </span>
            ) : (
              <span>
                <i className="dot" />
                {t("proxy.systemNone")}
              </span>
            )}
          </p>
        )}
        {mode === "custom" && (
          <>
            <label className={`pline${!empty && !parsed ? " is-bad" : ""}`}>
              <input
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  forgetTest();
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !isComposing(e)) {
                    e.preventDefault();
                    void applyDraft();
                  }
                }}
                placeholder="http://127.0.0.1:7890"
                aria-label={t("proxy.label")}
                spellCheck={false}
                autoComplete="off"
                autoCapitalize="off"
              />
              <button type="button" className="pline__go" disabled={!parsed || applied} onClick={() => void applyDraft()}>
                {t("proxy.apply")}
              </button>
            </label>
            <p className="pstate">
              {!empty && !parsed ? (
                <span className="is-bad">{t("proxy.bad")}</span>
              ) : parsed && applied ? (
                <span>
                  <i className="dot is-on" />
                  {t("proxy.inUse")} · {parsed.protocol.replace(":", "")} · {parsed.host}
                </span>
              ) : parsed ? (
                <>
                  <span>
                    <i className="dot" />
                    {t("proxy.edited")}
                  </span>
                  <span>
                    {t("proxy.willRoute")} {parsed.protocol.replace(":", "")} · {parsed.host}
                  </span>
                </>
              ) : (
                <span>
                  <i className="dot" />
                  {t("proxy.notSet")}
                </span>
              )}
            </p>
          </>
        )}
        <div className="ptest">
          <p className="acts">
            <button type="button" className="ink-link" disabled={route === null || (test !== null && !test.probes)} onClick={() => void runTest()}>
              {test && !test.probes ? t("proxy.testing") : t("proxy.test")}
            </button>
            {route === null && <span className="small">{t("proxy.testNeedsUrl")}</span>}
            {test && (
              <span className="small">
                {t("proxy.route", { route: test.route })}
              </span>
            )}
          </p>
          {test && (
            <ul>
              {(["cdn", "github", "overpass"] as const).map((target) => {
                const p = test.probes?.find((x) => x.target === target);
                return (
                  <li key={target}>
                    <b>{t(`proxy.${target}`)}</b>
                    <span className="row__leader" />
                    {!p ? (
                      <span className="r is-wait">…</span>
                    ) : p.ok ? (
                      // Which server answered, where a leg has several (Overpass).
                      <span className="r" title={p.detail ?? undefined}>
                        ✓ {p.ms} ms
                      </span>
                    ) : (
                      <span className="r is-bad" title={p.detail ?? undefined}>
                        ✕ {why(p)}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </Row>
  );
}
