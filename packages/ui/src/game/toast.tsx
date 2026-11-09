import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { prefersReducedMotion } from "./motion";

// Messages: a line of ink that rises from the foot of the window and goes again —
// "Saved", "Copied" — newest at the bottom, pushing the older ones up. Only for
// what went right: a failure stays put next to what failed until it's fixed, so
// it's never one of these.

/** How long a message stays, ms. */
const TOAST_MS = 3000;
/** How many can be up at once: a fourth pushes the oldest out. */
const TOAST_MAX = 3;
/** How long going takes, ms — game.css's .toast. */
const OUT_MS = 340;

type Item = { id: number; text: string; phase: "new" | "in" | "out"; bump: number };

const ToastContext = createContext<(text: string) => void>(() => {});

/** Put up a message. The same text again doesn't stack: it nudges the one that's up and starts its time over. */
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Item[]>([]);
  // The list itself lives here, so messages put up in one go each see the others.
  const list = useRef<Item[]>([]);
  const timers = useRef(new Map<number, number>());
  const nextId = useRef(0);

  const commit = useCallback((next: Item[]) => {
    list.current = next;
    setItems(next);
  }, []);

  const drop = useCallback(
    (id: number) => {
      window.clearTimeout(timers.current.get(id));
      timers.current.delete(id);
      commit(list.current.map((it) => (it.id === id ? { ...it, phase: "out" } : it)));
      window.setTimeout(
        () => commit(list.current.filter((it) => it.id !== id)),
        prefersReducedMotion() ? 0 : OUT_MS,
      );
    },
    [commit],
  );

  const show = useCallback(
    (text: string) => {
      const live = list.current.filter((it) => it.phase !== "out");
      const same = live.find((it) => it.text === text);
      if (same) {
        window.clearTimeout(timers.current.get(same.id));
        timers.current.set(same.id, window.setTimeout(() => drop(same.id), TOAST_MS));
        commit(list.current.map((it) => (it.id === same.id ? { ...it, bump: it.bump + 1 } : it)));
        return;
      }
      const id = nextId.current++;
      timers.current.set(id, window.setTimeout(() => drop(id), TOAST_MS));
      commit([...list.current, { id, text, phase: "new", bump: 0 }]);
      for (const old of live.slice(0, Math.max(0, live.length + 1 - TOAST_MAX))) drop(old.id);
    },
    [commit, drop],
  );

  // A new one is laid out collapsed first, then let in, so it rises rather than appears.
  useEffect(() => {
    if (!items.some((it) => it.phase === "new")) return;
    const raf = requestAnimationFrame(() =>
      commit(list.current.map((it) => (it.phase === "new" ? { ...it, phase: "in" } : it))),
    );
    return () => cancelAnimationFrame(raf);
  }, [items, commit]);

  useEffect(() => {
    const all = timers.current;
    return () => all.forEach((t) => window.clearTimeout(t));
  }, []);

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((it) => (
          <div key={it.id} className={`toast${it.phase === "in" ? " is-in" : it.phase === "out" ? " is-out" : ""}`}>
            <div>
              <span key={it.bump} className={it.bump ? "is-bump" : undefined}>
                {it.text}
              </span>
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
