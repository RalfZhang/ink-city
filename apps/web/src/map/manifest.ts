import type { City, Osm } from "@inkcity/core";
import { isCity } from "@inkcity/core/schedule";

/**
 * One published day, `osm-v2/data/<date>.json[.gz]`: the map data with the day's
 * city stamped on (`{ v, elements, …, date, city }`, see scripts/osm-cli.ts). The
 * same shape whichever rung produced it — the cache, the CDN, or the website
 * rebuilding it from Overpass.
 */
export type Manifest = Osm & { date?: string; city: City };

/** Whether `bytes` start with gzip's magic number. */
export function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/** Whether this browser can (de)compress gzip itself — Chrome 80, Safari 16.4, Firefox 113. */
export const gzipSupported = typeof DecompressionStream !== "undefined" && typeof CompressionStream !== "undefined";

async function gunzip(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

export async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Decode a day as fetched or as cached: gunzip it if the bytes are gzip — sniffed,
 * never taken from the URL or the headers, since a host may decompress on the way —
 * parse it, and accept it only if it carries road elements and a whole city (the
 * seven fields `City` requires): the two checks the desktop makes too
 * (`validate_scheduled` in apps/desktop/src-tauri/src/cdn.rs). Anything else — an
 * HTML error page served with a 200, a truncated body — throws, which the fetch
 * ladder reads as a miss.
 */
export async function decodeManifest(bytes: Uint8Array): Promise<Manifest> {
  const text = isGzip(bytes) ? await gunzip(bytes) : new TextDecoder().decode(bytes);
  const json: unknown = JSON.parse(text);
  if (!isObject(json)) throw new Error("not a JSON object");
  if (!Array.isArray(json.elements) || json.elements.length === 0) throw new Error("no road elements");
  const { city } = json;
  if (!isCity(city)) throw new Error("no usable city");
  return { ...(json as Osm), city };
}
