// Lat/lon parsing for the "customize city" feature (issue #11): accept the
// handful of formats users actually paste, normalize to decimal degrees.
// Portable + dependency-free (runs in the client and in tests). Returns null on
// anything unparseable or out of range, so callers can show an inline error
// rather than pinning a bogus location.
//
// Accepted (lat then lon), examples:
//   "51.5074, -0.1278"       decimal, comma
//   "51.5074 -0.1278"        decimal, whitespace
//   "51.5074°N, 0.1278°W"    decimal + hemisphere
//   "51.5074N 0.1278W"       hemisphere with no separator
//   "51°30'26\"N 0°7'39\"W"  degrees/minutes/seconds + hemisphere
//   "@51.5074,-0.1278,13z"   Google-Maps centre fragment
//   a whole pasted Google Maps URL (see `fromUrl`)

export type LatLon = { lat: number; lon: number };

const inRange = (lat: number, lon: number): boolean =>
  Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

/** DMS → decimal. `deg`/`min`/`sec` are magnitudes; `hemi` applies the sign. */
function dms(deg: number, min: number, sec: number, hemi: string): number {
  const v = deg + min / 60 + sec / 3600;
  return /[sw]/i.test(hemi) ? -v : v;
}

const NUM = String.raw`-?\d+(?:\.\d+)?`;

/**
 * Pull the coordinate pair out of a pasted map URL. Ordered by how specific each
 * form is, because a Google place URL carries both: `!3d…!4d…` is the *place*,
 * while `@…` is only wherever the viewport happened to be centred, so the former
 * wins. `q=`/`ll=`/`center=` cover the query-parameter styles (Google, OSM,
 * Bing). Returns null when the string carries no recognizable pair — the caller
 * then tries to read it as plain coordinates.
 */
function fromUrl(s: string): LatLon | null {
  const patterns = [
    new RegExp(String.raw`!3d(${NUM})!4d(${NUM})`),
    new RegExp(String.raw`@\s*(${NUM})\s*,\s*(${NUM})`),
    new RegExp(String.raw`[?&#](?:q|ll|center|mlat)=\s*(${NUM})\s*,\s*(${NUM})`, "i"),
    // OSM's map fragment: #map=<zoom>/<lat>/<lon>
    new RegExp(String.raw`[#&]map=${NUM}/(${NUM})/(${NUM})`, "i"),
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) {
      const lat = Number(m[1]);
      const lon = Number(m[2]);
      if (inRange(lat, lon)) return { lat, lon };
    }
  }
  // OSM also uses separate mlat/mlon params.
  const mlat = s.match(new RegExp(String.raw`[?&#]mlat=(${NUM})`, "i"));
  const mlon = s.match(new RegExp(String.raw`[?&#]mlon=(${NUM})`, "i"));
  if (mlat && mlon) {
    const lat = Number(mlat[1]);
    const lon = Number(mlon[1]);
    if (inRange(lat, lon)) return { lat, lon };
  }
  return null;
}

// Degrees [minutes [seconds]] + hemisphere, e.g. "51 30 26 N , 0 7 39 W" or
// (degrees-only) "51.5074 N". Requires N/S/E/W so it can't swallow plain signed
// decimals (handled separately).
const DMS_RE = new RegExp(
  String.raw`^\s*(\d+(?:\.\d+)?)\s+(?:(\d+(?:\.\d+)?)\s+)?(?:(\d+(?:\.\d+)?)\s+)?([NnSs])` +
    String.raw`\s*[, ]\s*(\d+(?:\.\d+)?)\s+(?:(\d+(?:\.\d+)?)\s+)?(?:(\d+(?:\.\d+)?)\s+)?([EeWw])\s*$`,
);

/** Plain signed decimals separated by a comma and/or whitespace. */
const DEC_RE = new RegExp(String.raw`^\s*(${NUM})\s*[, ]\s*(${NUM})\s*$`);

/**
 * Try to parse one "lat, lon" string into decimal degrees, or null. A pasted map
 * URL is handled first, then the DMS/hemisphere form (the most specific of the
 * bare forms), then plain decimals.
 */
export function parseLatLon(input: string): LatLon | null {
  if (!input) return null;
  const raw = input.trim();
  if (!raw) return null;

  // Anything carrying URL punctuation is treated as a paste, not as coordinates.
  if (/[:?&#]|!3d/.test(raw) || raw.startsWith("@")) {
    const fromLink = fromUrl(raw);
    if (fromLink) return fromLink;
  }

  // Normalize: strip a leading Google "@", drop a trailing ",<n>z" zoom, turn
  // every DMS symbol (° ' ′ " ″) into a space so degrees/minutes/seconds become
  // plain space-separated numbers one lexer can read, and detach a hemisphere
  // letter stuck to its number ("51.5N" → "51.5 N") so the same lexer sees it.
  let s = raw.replace(/^@/, "");
  s = s.replace(/,\s*\d+(?:\.\d+)?z\s*$/i, ""); // Google zoom suffix
  s = s.replace(/[°'′"″]/g, " ");
  s = s.replace(/(\d)\s*([NSEWnsew])(?![A-Za-z])/g, "$1 $2");

  const m = s.match(DMS_RE);
  if (m) {
    const lat = dms(Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0), m[4]);
    const lon = dms(Number(m[5]), Number(m[6] ?? 0), Number(m[7] ?? 0), m[8]);
    return inRange(lat, lon) ? { lat, lon } : null;
  }

  const dec = s.match(DEC_RE);
  if (dec) {
    const lat = Number(dec[1]);
    const lon = Number(dec[2]);
    return inRange(lat, lon) ? { lat, lon } : null;
  }

  return null;
}
