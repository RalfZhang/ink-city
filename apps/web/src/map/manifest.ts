import type { City, Osm } from "@inkcity/core";

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

async function gunzip(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

export async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Decode a day as fetched or as cached: gunzip it if the bytes are gzip — sniffed,
 * never taken from the URL or the headers, since a host may decompress on the way —
 * and parse it. An HTML error page served with a 200, or a truncated body, throws,
 * which the fetch ladder reads as a miss.
 */
export async function decodeManifest(bytes: Uint8Array): Promise<Manifest> {
  const text = isGzip(bytes) ? await gunzip(bytes) : new TextDecoder().decode(bytes);
  return JSON.parse(text) as Manifest;
}
