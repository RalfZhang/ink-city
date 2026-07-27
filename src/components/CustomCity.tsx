import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { parseLatLon } from "@/core";
import type { City } from "@/core";
import { logWarn } from "@/lib/log";
import type { Status } from "../types";
import { googleMapsUrl } from "../constants";

type Props = {
  status: Status;
  onError: (e: unknown) => void;
};

/** How long the input must sit still before we ask the backend for matches. */
const SEARCH_DEBOUNCE_MS = 180;

/**
 * The "Customized" update mode: pin the wallpaper to a user-entered location.
 * Rendered by the City tab when `updateMode === "customized"`.
 *
 * One input accepts both of the forms issue #11 asks for, told apart by whether
 * `parseLatLon` can read the text:
 *
 *   • coordinates — many formats, including a pasted map link (see core/coords.ts).
 *     Apply is enabled immediately.
 *   • a city name — anything that isn't coordinates is treated as a name and looked
 *     up in the bundled list (`search_cities`); picking a suggestion fills in its
 *     coordinates, which is what actually gets pinned. Only the ~1000-city bundled
 *     list is searched, so a name that isn't in it falls back to entering coordinates.
 */
export default function CustomCity({ status, onError }: Props) {
  const { t } = useTranslation();
  const custom = status.custom;

  const [input, setInput] = useState<string>(() =>
    custom ? `${custom.lat}, ${custom.lon}` : "",
  );
  const [matches, setMatches] = useState<City[]>([]);
  // Suppressed right after picking a suggestion (or applying), so the dropdown
  // doesn't immediately reopen on the text we just wrote into the input.
  const [showMatches, setShowMatches] = useState(false);

  const parsed = parseLatLon(input);
  const query = input.trim();
  // A name lookup only makes sense for text that isn't already coordinates, and
  // one letter would match half the list.
  const searchable = parsed === null && query.length >= 2;

  // Debounced name lookup. `searchable` gates it, so typing coordinates never
  // hits the backend.
  useEffect(() => {
    if (!searchable) {
      setMatches([]);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      invoke<City[]>("search_cities", { query })
        .then((found) => {
          if (!live) return;
          setMatches(found);
          setShowMatches(true);
        })
        .catch((e) => logWarn("[city] search failed", e));
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, searchable]);

  const suggestions = showMatches ? matches : [];
  // Only complain once the lookup has had its turn and come back empty — an
  // unrecognized name is otherwise indistinguishable from mid-typing.
  const showInvalid = query !== "" && parsed === null && (!searchable || suggestions.length === 0);

  const applyLatLon = async (lat: number, lon: number) => {
    try {
      await invoke("apply_custom_city", { lat, lon });
    } catch (e) {
      onError(e);
    }
  };

  const pick = (c: City) => {
    setInput(`${c.lat}, ${c.lon}`);
    setShowMatches(false);
    void applyLatLon(c.lat, c.lon);
  };

  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <Card>
      <CardContent className="space-y-1.5">
        <div className="text-sm font-medium">{t("city.inputLocation")}</div>
        {/* `relative` anchors the suggestion dropdown, which is absolutely
            positioned so opening it never pushes the rest of the card around. */}
        <div className="relative">
          <Input
            ref={inputRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setShowMatches(true);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") setShowMatches(false);
              if (e.key === "Enter" && suggestions.length > 0) pick(suggestions[0]);
            }}
            placeholder={t("city.locationPlaceholder")}
            aria-invalid={showInvalid}
            spellCheck={false}
            autoComplete="off"
          />
          {suggestions.length > 0 && (
            <ul
              className="absolute z-10 mt-1 w-full max-h-56 overflow-y-auto rounded-md border bg-popover shadow-md py-1"
              role="listbox"
            >
              {suggestions.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    className="w-full text-start px-2 py-1.5 text-sm hover:bg-accent flex items-baseline gap-2"
                    onClick={() => pick(c)}
                  >
                    <span>
                      {c.name}, {c.country}
                    </span>
                    {c.localName !== c.name && (
                      <span className="text-xs text-muted-foreground">{c.localName}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {/* Reserve the line so validation feedback never shifts the layout. */}
        <div className="text-xs text-destructive min-h-4">
          {showInvalid ? t("city.invalidLocation") : ""}
        </div>
        {/* Custom locations aren't precached — each Apply fetches live from the
            map service, so warn against hammering it. */}
        <p className="text-xs text-muted-foreground">{t("city.customRateHint")}</p>
      </CardContent>
      <CardFooter className="justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={!parsed}
          onClick={() => parsed && openUrl(googleMapsUrl(parsed.lat, parsed.lon))}
        >
          {t("city.googleMaps")}
        </Button>
        <Button
          className="min-w-24"
          size="sm"
          onClick={() => {
            setShowMatches(false);
            if (parsed) void applyLatLon(parsed.lat, parsed.lon);
          }}
          disabled={!parsed || status.running}
        >
          {status.running && <Loader2 className="animate-spin size-3.5 me-1.5" />}
          {t("city.apply")}
        </Button>
      </CardFooter>
    </Card>
  );
}
