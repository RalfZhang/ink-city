#!/usr/bin/env node
// Builds src/data/cities.json from GeoNames cities1000.
// Run with: npm run build:cities

import { mkdtempSync, createWriteStream, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT = join(ROOT, "src", "data", "cities.json");
const URL = "https://download.geonames.org/export/dump/cities1000.zip";
const TOP_N = 1000;

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
}

function unzip(zipPath, destDir) {
  const r = spawnSync("unzip", ["-o", zipPath, "-d", destDir], { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`unzip exited ${r.status}`);
}

const COLS = [
  "geonameid", "name", "asciiname", "alternatenames",
  "latitude", "longitude", "featureClass", "featureCode",
  "country", "cc2", "admin1", "admin2", "admin3", "admin4",
  "population", "elevation", "dem", "timezone", "modificationDate",
];

function parseLine(line) {
  const fields = line.split("\t");
  const row = {};
  COLS.forEach((c, i) => (row[c] = fields[i]));
  return row;
}

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), "ink-city-geonames-"));
  const zipPath = join(tmp, "cities1000.zip");

  console.log(`[1/4] download ${URL}`);
  await download(URL, zipPath);

  console.log(`[2/4] unzip -> ${tmp}`);
  unzip(zipPath, tmp);

  console.log(`[3/4] parse cities1000.txt`);
  const raw = readFileSync(join(tmp, "cities1000.txt"), "utf8");
  const cities = raw
    .split("\n")
    .filter((l) => l.length > 0)
    .map(parseLine)
    .filter((r) => r.featureClass === "P")
    .map((r) => ({
      id: Number(r.geonameid),
      name: r.asciiname,
      localName: r.name,
      country: r.country,
      lat: Number(r.latitude),
      lon: Number(r.longitude),
      population: Number(r.population) || 0,
    }))
    .filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lon) && c.population > 0)
    .sort((a, b) => b.population - a.population)
    .slice(0, TOP_N);

  console.log(`[4/4] write ${OUT} (${cities.length} cities)`);
  if (!existsSync(dirname(OUT))) mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(cities, null, 2));
  console.log(`done. smallest population in list: ${cities[cities.length - 1].population}`);
}

await main();
