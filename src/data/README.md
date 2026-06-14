# City data pools

Three **schema-identical** JSON pools — each entry is
`{ id, name, localName, country, lat, lon, population }`, so they're drop-in
interchangeable:

| File | Pins | What it is |
|---|---|---|
| `cities.json` | 1000 | Top cities by population (GeoNames). **The only one wired into the app.** |
| `cities-famous.json` | 993 | Fame-ranked (Wikidata sitelinks × log₁₀ pop). |
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

### `cities-famous.json` specifics

Same baseline, **plus** sub-national overrides the countries file lacks. (Its ids are
*not* GeoNames ids, so pins were coord+name joined to GeoNames, preferring max-population
within ~0.2° to avoid matching sub-districts.)

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
  Traditional like Changsha 長沙 → 长沙); ko strips 특별시/광역시/etc.; my strips မြို့.
- **~15 manual curations** for data gaps / bad preferred-name picks: Prayagraj → प्रयागराज
  (not pre-2018 इलाहाबाद), Ho Chi Minh City → Thành phố Hồ Chí Minh (not abbrev TPHCM),
  Rhodes → Ρόδος, Basra → البصرة (not "Old Basra"), Espoo → Espoo (GeoNames had only
  Swedish "Esbo"). TD/DJ curated to Arabic to **match `cities-countries.json`.**
