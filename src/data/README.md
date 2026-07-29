# City data pools

Three **schema-identical** JSON pools — each entry is
`{ id, name, localName, country, lat, lon, population }`, so they're drop-in
interchangeable. `id` is the GeoNames `geonameid` in **all three**, so the same city
carries the same id across pools and they can be joined/deduped by id.
`cities-famous.json` carries one extra key, `wikiId` — additive, so it still
deserializes anywhere the others do.

| File | Pins | What it is |
|---|---|---|
| `cities.json` | 1000 | Top cities by population (GeoNames). **The only one wired into the app.** |
| `cities-famous.json` | 992 | Fame-ranked (Wikidata sitelinks × log₁₀ pop). |
| `cities-countries.json` | 284 | Capital + largest city of every inhabited ISO 3166-1 region, deduped. |

Only `cities.json` is loaded at runtime — it's hardcoded in
[`src-tauri/src/city.rs`](../../src-tauri/src/city.rs) (`include_str!` + cache
filename) and the jsDelivr hot-update URL in `cities_update.rs`. The other two are
**standalone assets awaiting a multi-list selector feature** — they are *not* dead
files. The rotation logic is list-length-agnostic, so wiring one in only needs a
list-selection setting + parameterizing that hardcoded filename/URL.

## How these are built / regenerated

No generators are committed. Each file is produced by a **throwaway script run from
`/tmp`** (we commit only the resulting JSON, not the generator). `cities.json` mirrors
[`scripts/build-cities.mjs`](../../scripts/build-cities.mjs); the other two reuse its
GeoNames download/parse logic. Sources: GeoNames `cities1000.txt`,
`alternateNamesV2.txt`, `countryInfo.txt`.

When editing an existing file, change **only the field you mean to** — e.g. the
localName passes below rewrite *just* the `localName` line via text-level replacement,
leaving every other byte intact (so floats like `"lon": 10.0` and trailing newline
don't reformat).

## `country` field — which ISO code

`country` is an **ISO 3166-1 alpha-2 code**, and a place gets **its own** code before
its sovereign's: Hong Kong is `HK` not `CN`, Macau `MO`, San Juan `PR` not `US`,
Gibraltar `GI` not `GB`, Laayoune `EH` not `MA`, Cayenne / Saint-Denis /
Fort-de-France `GF` / `RE` / `MQ` not `FR`. A place with no code of its own falls
back to the sovereign ISO assigns it — Crimea → `UA` (ISO 3166-2 `UA-43` / `UA-40`).
Kosovo has no ISO 3166-1 code at all and uses the user-assigned **`XK`**.

That's exactly the GeoNames `country code` column, which makes the invariant
checkable: join all three pools to `cities1000.txt` by `id` and every `country` must
match. It holds for all 2276 pins except the two with no `cities1000.txt` row at all
(Jaboatão in `cities.json`, Monte Águila — see below). Across pools it's also
consistent: shared ids never disagree on `country`, which is what lets
[`mergePools`](../core/schedule.ts) pick a winner without moving a city between
country cooldowns.

## `localName` field — what language/script it holds

`localName` means "this city's name in the locally-appropriate language/script."

- **`cities.json`** — `localName` is the GeoNames `name` column, mostly Latin/English
  (`Beijing`, `Moscow`). **Not** nativized. (This is the file the app actually shows.)
- **`cities-countries.json` & `cities-famous.json`** — `localName` is **native script**
  (北京, Москва, Αθήνα, ירושלים), resolved from GeoNames `alternateNamesV2` per the rules
  below.

### Baseline rules (both nativized files)

1. **Language = the country's primary language** (from `countryInfo.txt` `Languages`
   column, first entry, region suffix dropped). zh / ru / el / …
2. **Pick the best alternate name in that language**, scoring
   `preferred×2 + short×2`, ties → shorter; skip historic/colloquial entries.
3. **Latin stays Latin when Latin *is* the local name** — countries whose primary
   language uses Latin script (en/fr/es/pt/de/tr/uz/so/…) keep Latin localNames
   (Lagos, Nairobi, Sydney, Bamako, Toshkent).
4. **Manual language overrides:** `HK/MO/TW → zh`, `PS/EH → ar`.
5. Per-language script regex rejects Latin/wrong-script transliterations that are
   nonetheless tagged in that language.
6. If no name exists in the target language, **keep the current value** (≈22–23 pins,
   mostly already-Latin like Singapore/Miami/Oxford).

### `cities-countries.json` specifics

- Country-primary language only — **no sub-national overrides**.
- en/fr-first countries keep Latin, **except** when the first *indigenous* (non-en/fr)
  language has a non-Latin script — then curated to it: `IN → मुंबई / नई दिल्ली` (hi),
  `TD → نجامينا` (ar), `DJ → جيبوتي` (ar). Minority/co-official non-Latin langs are
  *not* used (no CA→Inuktitut, no CX→Chinese).
- `name` is **ASCII-only** (0/284 non-ASCII): GeoNames `name` where that's already
  ASCII, `asciiname` for the 15 that aren't (`Bogota`, `São Paulo` → `Sao Paulo`,
  `Zürich` → `Zuerich`). `cities-famous.json` keeps the diacritics instead, so the
  two pools differ on 19 of their 221 shared ids. Worth knowing before "fixing" either
  side: [`city.rs`'s search](../../src-tauri/src/city.rs) lowercases but does **not**
  fold diacritics, so an ASCII `name` is what a user typing `bogota` can actually find.
- `lat` / `lon` / `population` are **GeoNames verbatim** — the whole file re-derives
  from a dump, so a stale dump shows up here as a stale number (Astana `345604` and
  Sydney `5557233` were refreshed by hand to `1544142` / `5638830`). Ngerulmud's
  `population: 0` is *not* one of those: Palau's capital is government buildings only
  and genuinely has no residents. It's the sole 0 in either pool, which puts it last in
  the population-descending search ranking — a `city.rs` tiebreak question, not a data one.

### `cities-famous.json` specifics

Same baseline, **plus** sub-national overrides the countries file lacks.

#### `id` / `wikiId`

The pin *list* is chosen from Wikidata, so each pin keeps its Wikidata Q-number (minus
the `Q`) in **`wikiId`** — `id` itself is the GeoNames `geonameid`, backfilled by a
coord+name join against `cities1000.txt`. Ranking of candidates within ~80 km:
`name` == GeoNames primary name, then `name` in its alternate names, then the same two
for `localName`, then max population. **Name signals must outrank population** — going
by population alone pulls a city onto its larger neighbour (Offenbach → Frankfurt,
Ludwigshafen → Mannheim, Kotte → Colombo, New Delhi → Delhi), and preferring
`name` over `localName` is what saves those cases when the `localName` is itself wrong.

All 992 ids resolved. Cross-check: of the pins that independently name+coord-match an
entry in the two GeoNames-sourced pools, **480/480** agree with that entry's id, and
513 famous pins now share an id with those pools. Two hand-checked exceptions:
**Monte Águila (CL)** is `3879476`, which is missing from `cities1000.txt` because
GeoNames records it with population 0; **Bremen** was 993 pins because the list
carried both the city (`Q24879`)
and the *Land* (`Q1209`, de label "Freie Hansestadt Bremen", pop = city + Bremerhaven) —
GeoNames has only the city, so the Land was dropped.

Target-language priority: **CURATED > China autonomous region > India state > multilingual-country region > country-primary.**

- **China autonomous regions / SARs** use local script: Tibet → Tibetan (ལྷ་ས་),
  Xinjiang → Uyghur (ئۈرۈمچى), **Inner Mongolia → vertical Mongolian script** (ᠬᠥᠬᠡᠬᠣᠲᠠ).
  Guangxi/Ningxia → Chinese (titular langs are Latin-Zhuang / none). HK/MO → Traditional
  (澳門). **Mongolia-the-country stays Cyrillic** (Улаанбаатар) — a separate target from
  Inner Mongolia.
- **India** — each state → its first official language by admin1 (Tamil Nadu → Tamil,
  West Bengal/Tripura → Bengali, Kerala → Malayalam, Maharashtra → Marathi,
  J&K Srinagar → Kashmiri سِری نَگَر, …).
- **Multilingual countries** override country-primary by region (admin1):
  Canada Québec → fr (Montréal), Switzerland French cantons → fr (Geneva → Genève) &
  Ticino → it, Belgium Wallonia + Brussels → fr (Liège / Namur / Bruxelles),
  Spain Catalonia/Valencia/Balearic → ca (Alicante → Alacant).
- **Suffix stripping:** zh prefers the `zh-CN` tag and strips trailing 市/区 (avoids
  Traditional like Changsha 長沙 → 长沙); ja likewise strips 市 (京都市 → 京都 — this ran
  for zh only at first, so 7 of the 21 JP pins kept the suffix); ko strips
  특별시/광역시/etc. — **as a whole word**, since peeling only 시 off 평양직할시 leaves the
  broken stem 평양직할; my strips မြို့.
- **~15 manual curations** for data gaps / bad preferred-name picks: Prayagraj → प्रयागराज
  (not pre-2018 इलाहाबाद), Ho Chi Minh City → Thành phố Hồ Chí Minh (not abbrev TPHCM),
  Rhodes → Ρόδος, Basra → البصرة (not "Old Basra"), Espoo → Espoo (GeoNames had only
  Swedish "Esbo"), Vatican City → Città del Vaticano (it — Latin `Civitas Vaticana` is
  the *state's* name, and `la` is a document language, not a spoken one), Singapore →
  Singapore (not the state form "Republic of Singapore"). TD/DJ curated to Arabic to
  **match `cities-countries.json`.** `localName` follows `country`, so the two
  dependencies whose code isn't their sovereign's also take that region's language:
  Laayoune → العيون (`EH` → ar, rule 4 — it had drifted to Spanish "El Aaiún") and
  Pristina → Prishtinë (`XK` → sq, not Serbian Приштина).
- **`wikiId` and `id` don't always denote the same thing** — the pin list is Wikidata's
  and the coordinates came with it, so three pins needed their `lat`/`lon` re-pinned to
  the GeoNames point. Each is a different failure:
  - **Rhodes** — genuinely the wrong entity: `wikiId` `Q43048` is the *island*
    ("island in Aegean sea"), while `id` `400666` is GeoNames' Ródos, the town. The
    island's `P625` is its inland centroid, 40 km from town.
  - **Cần Thơ** — the *right* entity (`Q216075`, "city of Vietnam", 芹苴市) but the wrong
    kind of point. Cần Thơ is a centrally-governed municipality, ~1,440 km² before the
    July 2025 merger with Hậu Giang + Sóc Trăng, and its `P625` lands in the rural
    north-west of that area, 34 km from the urban core at Ninh Kiều where GeoNames
    puts it. Any Vietnamese *thành phố trực thuộc trung ương* can do this — an
    area-wide point is not the city you want to render.
  - **Babylon** — the inverse of Rhodes: `wikiId` `Q5684` *is* Babylon, but `id`
    `99347` is **Al Hillah**, the modern city 9 km south, because Babylon has no
    `cities1000.txt` row of its own (archaeological site, not a populated place).
    `name`/`localName`/coords describe Babylon (بابل); `population` is Al Hillah's
    455,700, because the pin needs a live figure for the search ranking and Wikidata's
    150,000 is an estimate of the *ancient* city's peak.
- **Neighbour bleed** — three pins had a *different* city's name as their `localName`,
  found by the geonameid join and fixed from Wikidata labels: Offenbach am Main
  (was "Frankfurt am Main"), Ludwigshafen → Ludwigshafen am Rhein (was "Mannheim"),
  Sri Jayawardenepura Kotte → ශ්‍රී ජයවර්ධනපුර කෝට්ටේ (was කොළඹ, i.e. Colombo — GeoNames
  has no Sinhala name for Kotte at all, so rule 6's "keep current value" had nothing
  to keep).
