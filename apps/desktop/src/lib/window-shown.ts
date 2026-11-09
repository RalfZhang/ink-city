import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Whether the window is on screen. A tray app's window is put away most of the
 * time — never shown at all after an autostart — and the map is only read and
 * drawn while it's up (`useMapData`, `useHomeFrame`). The backend says when it
 * shows the window (`window:shown`) and when its close button puts it away
 * (`window:hidden`); subscribed first, then asked, so a change landing between the
 * two can't be missed. The answer is dropped once either has been heard: a launch
 * shows the window (`window_ready`) about as soon as it's asked, and an answer read
 * before that `show()` can arrive after its `window:shown`, which it would undo.
 */
export function useWindowShown(): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    let live = true;
    let heard = false;
    const hear = (visible: boolean) => () => {
      heard = true;
      setShown(visible);
    };
    const offs = [listen("window:shown", hear(true)), listen("window:hidden", hear(false))];
    void Promise.all(offs)
      .then(() => getCurrentWindow().isVisible())
      .then(
        (visible) => live && !heard && setShown(visible),
        // Unknown is taken as up: drawing a map no one sees costs memory, not drawing
        // one someone is looking at costs the window.
        () => live && !heard && setShown(true),
      );
    return () => {
      live = false;
      offs.forEach((off) => off.then((f) => f()));
    };
  }, []);
  return shown;
}
