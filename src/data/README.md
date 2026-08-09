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

`cities.json` has a committed generator,
[`scripts/build-cities.mjs`](../../scripts/build-cities.mjs) (`pnpm build:cities`).

**The two curated pools do not, by convention** — they're produced by a throwaway
script run from `/tmp`, and only the resulting JSON is committed. They reuse
`build-cities.mjs`'s GeoNames download/parse logic plus the `localName` rules below,
which is why those rules are written out here rather than left implicit in code.
Sources: GeoNames `cities1000.txt`, `alternateNamesV2.txt`, `countryInfo.txt`.

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

## `lat` / `lon` — where the coordinates come from

**Both curated pools take their coordinates from the OSM `place` *node*, joined on
OSM's `wikidata` tag.** `cities.json` is unaffected — it stays GeoNames.

This matters more here than it would elsewhere, because the coordinate is not a
label point: it is simultaneously the Overpass download area, the render crop and
the projection origin ([`pipeline.rs`](../../src-tauri/src/pipeline.rs)'s
`bbox_for_screen(lat, lon, 10.0, aspect)`, `MAX_HALF_KM` in
[`osm-cli.ts`](../../scripts/osm-cli.ts), `RENDER_RADIUS_KM` in
[`render.ts`](../../scripts/render.ts) — all three must agree on 10). The long side
is a fixed 20 km, so a 16:9 frame is only **11.25 km tall** and a 21:9 one 8.6 km.
Nothing recenters on failure: a bad coordinate just renders empty.

GeoNames and Wikidata both fail the same way — they hand you an **administrative or
geometric centroid** rather than the urban core. OSM `place` nodes are placed by
mappers *at* the city centre (they're what osm-carto labels the city from), which
is the thing this pipeline actually needs. As a bonus the centring point and the
rendered roads then come from the same database.

Measured before the switch: of 439 ids shared between `cities-famous.json` and
`cities.json`, 120 disagreed by >2 km and 21 by >5 km (Dubai 21 km, Muscat 19 km).
OSM did not systematically side with either source — it sided with the urban core
each time.

### Resolution rules

1. **Join** `nwr["wikidata"="Q…"]["place"]`, batched, `out center tags`. 1027/1051
   Q-ids resolved this way (97.7%).
2. **Accept only settlement `place` values**, best first: `city`, `town`,
   `municipality`, `borough`, `village`, `hamlet`, `suburb`, `quarter`. Everything
   else is rejected — a *whitelist*, so an unforeseen value degrades to "unresolved"
   (which the fallback ladder handles) rather than to "confidently wrong". This is
   what stops Singapore's `place=country` node (6.7 km off) and Rhodes'
   `place=island` (37.6 km).
3. **Node only.** A way/relation `center` is a bbox centroid — the artifact we're
   escaping. Tokyo's `place=province` relation centres ~980 km out in the Pacific,
   because the metropolis includes Ogasawara. Relation-only pins go to F1, not to
   the centroid.
4. Ties break on `place` rank → `population` → distance from the incumbent.
5. **Name-agreement guard:** if the node's `name`/`name:*` matches neither `name`
   nor `localName`, it does not land silently. (It caught St. Petersburg vs OSM's
   "Saint Petersburg", and Aurangabad vs its 2023 rename "Chhatrapati Sambhajinagar"
   — both correct, both worth a human glance.)

### Fallback ladder

- **F1 — `admin_centre`** of the relation carrying that Q, for relation-only pins.
  It's the seat node by definition, not a centroid. (Yazd, Hama.)
- **F2 — proximity + name**, one query per pin (a merged union makes results
  unattributable). **A name signal is mandatory**: `around:15000` in Vietnam returns
  hundreds of wards tagged `place=city`, so the `place` filter decides nothing and
  the name match does all the work. Without that floor, population scoring silently
  relocates Babylon onto Al Hillah (pop 1.7 M, 6.8 km away) — the neighbour bleed
  documented below. 29 pins resolved here, including three whose OSM node carries a
  *different* Q than our `wikiId` (Erlangen `Q117751880`, Huế `Q36167`) or none at
  all (Nha Trang).
- **F3 — keep the incumbent.** 5 pins: `San Juan`(PR, famous — repaired from the
  countries pool instead), `Saint Croix`, `Saipan`, `Weno`, `Pembroke Parish`. All
  are names denoting an *island or parish* with no same-named settlement node
  (Saipan's populated centre is mapped `Garapan`, Saint Croix's is `Christiansted`).

### Review gate and manual curations

Moves ≤2 km land automatically. Larger ones were scored by an intrinsic metric —
`highway` way count in the 16:9 frame vs. in a central box 1/16 its area — on the
old *and* new coordinate, which flags only the failure it genuinely detects: a new
point that landed somewhere empty. **The metric does not get a vote between two
plausible centres**; it systematically penalises large-block grids and waterfront
cities for reasons unrelated to the pin being wrong.

Two failure modes worth knowing before reusing it:

- **It is a ratio, so it discards absolute fill.** Kano's new frame has 65% *more*
  road (29,147 ways vs 17,632) because it stops wasting half the frame on farmland —
  yet centrality *drops* (1.98→0.92) because the denominator grew. Read `waysF`
  alongside it or you will reject the better frame. Muscat is the clean counter-case:
  `waysF` halved (11,386→5,265), which is visible in one number.
- **Its high end is meaningless.** Adamstown (Pitcairn, pop. 46) scores exactly
  `16.00` — the arithmetic ceiling of `1/0.0625`, meaning all 99 roads in the frame
  sit inside the centre box. That is "nothing around", not "dense core". Micro-territories
  fill the entire top of the ranking.

Four pins were checked visually with `pnpm render`, and the metric was overruled once:

- **Tianjin**, **Jinan** — kept the incumbent. The OSM nodes (7 / 11.8 km away) render
  an even grid with no focus, and Jinan's leaves the bottom third as empty mountains;
  the incumbents centre the Hai river bend and the old city respectively.
- **Hangzhou** — kept the incumbent. The OSM node is out at Qianjiang New City (where
  the municipal government moved in the 2000s) — administratively right, but it crops
  West Lake to a sliver on the left edge. The incumbent centres the lake whole, with
  the Qiantang river crossing the right and the hills below. Found by the water screen
  below, not by centrality.
- **Kano** — took the OSM node **against** the metric (centrality 1.98→0.92). The
  metric mis-scores it because the new frame is uniformly dense so no 1/16 core stands
  out; in fact the incumbent wasted the right half on farmland.
- **Muscat** — both pools pinned to the OSM node at Old Muscat
  (`23.6123628/58.5938134`), so `cities-countries.json` moved 19 km off its GeoNames
  incumbent. A first pass kept the GeoNames Ruwi point because the OSM frame spends
  40% of its area on sea — **that was the wrong standard.** These renders are
  wallpapers: a coastline's bays and headlands are the strongest figure in the frame,
  and the density contrast against open water reads better than Ruwi's flat spread.
  Filling the frame with roads is not the goal.
- **Babylon** — kept, see the bullet below. F2 matched a village tagged `بابل` 12.3 km
  away; rejected.
- **East Jerusalem** (`PS`) — kept. F2 matched Jerusalem's Hebrew node `ירושלים` (`IL`);
  it's a separate pin by design.

**A second screen, for water.** Road density alone encodes a bad assumption — that a
full frame beats an empty one. These are wallpapers: a coastline is often the
strongest figure in the frame, so "traded sea for inland sprawl" is a regression that
centrality actively *rewards*. So every silently-adopted move >2 km was also scored on
`natural=water|coastline` way count, old frame vs new, flagging those that kept under
half. Six turned up; two mattered:

- **Hangzhou** (760→304 water ways) — a real loss, see above. Note the count fell
  because West Lake's shoreline, islets and garden water carry many small ways, not
  because water *area* shrank; the new frame actually shows more Qiantang river.
- **Vũng Tàu** (673→188) — kept the OSM node anyway. The peninsula tip reads as a
  deliberate composition: land jutting into open sea.
- **Tashkent** (317→145) — false positive. The lost "water" is irrigation canals with
  no visual weight; the new frame is plainly better (city fills it, radial core
  centred). Caracas / Mosul / Managua likewise flagged on <100 ways, i.e. noise.

Water gains are just as common and need no action — Tokyo 348→499, Ho Chi Minh City
156→400, Paramaribo 474→666.

Shared ids now agree across both pools (221 of them), so `mergePools` picking either
one renders the same frame — previously they could differ by up to 21 km.

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
- `population` is **GeoNames verbatim** — the whole file re-derives
  from a dump, so a stale dump shows up here as a stale number (Astana `345604` and
  Sydney `5557233` were refreshed by hand to `1544142` / `5638830`). `lat`/`lon` used
  to be GeoNames too; they now come from OSM `place` nodes — see
  [`lat` / `lon`](#lat--lon--where-the-coordinates-come-from). Ngerulmud's
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
- **`wikiId` and `id` don't always denote the same thing.** The pin list is Wikidata's
  and the coordinates originally came with it, which needed three pins re-pinned by
  hand. Coordinates now come from OSM
  ([see above](#lat--lon--where-the-coordinates-come-from)) and the resolution rules
  handle all three automatically — but the entity mismatches themselves are still
  real, still describe these rows, and are still what the rules are defending against:
  - **Rhodes** — genuinely the wrong entity: `wikiId` `Q43048` is the *island*
    ("island in Aegean sea"), while `id` `400666` is GeoNames' Ródos, the town. The
    island's `P625` is its inland centroid, 40 km from town. *Now handled by rule 2:*
    Q43048's only OSM element is `relation place=island`, which the whitelist rejects,
    so the pin drops to F2 and lands on the `Ρόδος` town node 1.0 km from the
    incumbent. The wrong entity costs a fallback query, not a bad pin.
  - **Cần Thơ** — the *right* entity (`Q216075`, "city of Vietnam", 芹苴市) but the wrong
    kind of point. Cần Thơ is a centrally-governed municipality, ~1,440 km² before the
    July 2025 merger with Hậu Giang + Sóc Trăng, and its `P625` lands in the rural
    north-west of that area, 34 km from the urban core at Ninh Kiều where GeoNames
    puts it. Any Vietnamese *thành phố trực thuộc trung ương* can do this — an
    area-wide point is not the city you want to render. *Now handled by rule 3:* the
    node/relation split is exactly this distinction, so the municipality's areal
    element can never win.
  - **Babylon** — the inverse of Rhodes: `wikiId` `Q5684` *is* Babylon, but `id`
    `99347` is **Al Hillah**, the modern city 9 km south, because Babylon has no
    `cities1000.txt` row of its own (archaeological site, not a populated place).
    `name`/`localName`/coords describe Babylon (بابل); `population` is Al Hillah's
    455,700, because the pin needs a live figure for the search ranking and Wikidata's
    150,000 is an estimate of the *ancient* city's peak. *Still manual:* Q5684 carries
    no `place` tag (archaeological site), and F2 matched a village tagged `بابل` 12.3 km
    off, so this pin is pinned by hand. Its frame is genuinely road-poor — whether it
    should just be Al Hillah is a curation question, not one a scorer should answer.
- **Neighbour bleed** — three pins had a *different* city's name as their `localName`,
  found by the geonameid join and fixed from Wikidata labels: Offenbach am Main
  (was "Frankfurt am Main"), Ludwigshafen → Ludwigshafen am Rhein (was "Mannheim"),
  Sri Jayawardenepura Kotte → ශ්‍රී ජයවර්ධනපුර කෝට්ටේ (was කොළඹ, i.e. Colombo — GeoNames
  has no Sinhala name for Kotte at all, so rule 6's "keep current value" had nothing
  to keep).
