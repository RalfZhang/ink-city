# Comment & documentation audit

Scope: every `.ts` / `.tsx` / `.rs` / `.md` / `.yml` file under `src/`,
`src-tauri/src/`, `scripts/`, `docs/`, `.github/workflows/` plus the root
`README.md`. Shadcn-generated `src/components/ui/*` is excluded — those files
carry zero comments and are vendored.

Baseline measured before any edit:

| Area | Lines | Comment lines | Density |
|---|---|---|---|
| `src-tauri/src/*.rs` | 4 276 | 1 252 | 29% |
| `src/core/**` | 2 382 | 880 | 37% |
| `scripts/*.ts` | 1 431 | 379 | 26% |
| `src/tabs` + `src/components` (excl. `ui/`) | 1 509 | 103 | 7% |
| Docs (`docs/*.md`, both READMEs) | 617 | — | — |

## Headline finding

This is **not** the usual AI-generated comment problem. The dominant style is
genuinely explanatory — it documents invariants, cross-file contracts and
rejected alternatives, which is the expensive kind of knowledge to recover. Very
little of it restates code.

The real problems are different, and there are four of them:

1. **Five dead path references** — comments point at files that don't exist.
2. **Six factual conflicts** with the implementation, all from features that
   moved on without their comments.
3. **Duplication across files** — the same paragraph re-derived in 2–4 places,
   so a change has to be made everywhere or the copies disagree (and they have).
4. **Meta-narrative** — sentences about the *authoring process* ("out of scope
   here", "until this check existed", "for two releases") rather than the code.

Volume itself is a secondary issue, concentrated in a handful of very long
header blocks. Where a long comment is load-bearing it stays long.

---

## A. Dead references (verified by resolving each path)

| Where | Says | Actually |
|---|---|---|
| [src/core/osm/layers.ts:9](../src/core/osm/layers.ts#L9) | "Mirrored … by `src-tauri/src/layers.rs`, which uses it only for presence detection/UI gating" | **No `layers.rs` exists.** Rust has no mirrored layer list at all — layers are four independent `show_*` bools in `config.rs` / `state.rs` / `commands.rs`. The claim is wrong twice over: the file, and the mirroring. |
| [src/core/types.ts:83](../src/core/types.ts#L83) | `core/airports.ts` | `core/osm/airports.ts` |
| [src/core/types.ts:101](../src/core/types.ts#L101) | `core/railways.ts` | `core/osm/railways.ts` |
| [docs/detail.md:32](detail.md#L32) | `src/core/fetch-city.ts` | `src/core/osm/fetch-city.ts` |
| [.github/workflows/precache.yml:50](../.github/workflows/precache.yml#L50) | `src/core/water.ts` | `src/core/osm/water.ts` |
| [docs/random-city-strategy.md:179](random-city-strategy.md#L179) | `pipeline::stamp_city_envelope` | `pipeline::stamp_manifest_envelope` |

All six are the same root cause: the `src/core/osm/` subdirectory extraction and
one function rename, neither of which swept the prose.

## B. Factual conflicts with the implementation

Each verified by reading the implementation, not inferred.

### B1. `Status.city` is documented as the rotation pick — it isn't
[src-tauri/src/commands.rs:24](../src-tauri/src/commands.rs#L24) —
`/// Today's Daily-rotation city — informational`.

`build_status` at line 77 calls `pipeline::city_for_status(app, date)`, whose own
doc says it returns the schedule-resolved city and falls back to the rotation
only as source (3). The inline comment 50 lines *below* the doc comment
(commands.rs:73-76) explicitly contradicts it: *"not a second, independent
rotation pick — those disagree on every day served from the schedule"*.
`docs/random-city-strategy.md:166-173` documents the correct behaviour too. So
the field doc is the only wrong copy, and it is wrong in exactly the way the rest
of the codebase warns about.

### B2. Airport layer documented as "runways + aprons"
[src-tauri/src/config.rs:157](../src-tauri/src/config.rs#L157) — `/// Draw the
airport layer (runways + aprons)`.

Aprons were dropped at schema v3. Evidence: `OSM_SCHEMA_VERSION` history in
[core/constants.ts:35](../src/core/constants.ts#L35) (*"3 = airports layer
reshaped to runway + taxiway centerlines (apron dropped)"*),
`AirportFeature = { kind: "runway" | "taxiway" }` in `types.ts:94`,
`airportsSelector` fetching only `aeroway=runway`/`taxiway`, and
`airports.ts:13-15` stating aprons are *"intentionally not collected"*.

Same field's second clause — *"only surfaced in the UI when the current city's
data actually has an airport"* — is also stale: `Lab.tsx:18-21` says the toggles
are *"always shown regardless of whether today's city actually carries the
layer"*, and there is no data probe anywhere in the Lab tab. `show_water`
(config.rs:154) carries the identical stale clause.

### B3. Water layer scope omits two of its five line classes
[src/core/osm/water.ts:24-26](../src/core/osm/water.ts#L24) — *"linear
waterway=river/canal/stream as thin strokes"*.

`LINE_CLASSES` (line 37) is `river | canal | stream | drain | ditch`, the
selector (lines 53-54) queries `drain` and `ditch`, and `slimWater` has a
dedicated named-only rule for them (lines 399-405). The `WaterLineClass` type in
`types.ts:70` lists all five. Only this header undercounts.

### B4. Lab tab described as two toggles; it has five controls
[src/tabs/Lab.tsx:18](../src/tabs/Lab.tsx#L18) — *"home for optional data-layer
toggles (airports, water)"*. The component renders water, airports, railways,
aerialways **and** the Mondrian variant switch.

### B5. Style tab comment blames a mechanism that no longer exists
[src/tabs/Style.tsx:44-46](../src/tabs/Style.tsx#L44) — edits *"aren't clobbered
by polling"*. Polling was replaced by the pushed `status:changed` event
(`events.rs:17`, `lib.rs:276-291`). `Lab.tsx:35-37` is the same comment already
corrected to *"the backend's status stream"* — so the two copies disagree, which
is exactly the failure mode of duplicating prose.

Both copies are also **dangling**: they sit after a blank line and describe the
`useState` initializers *above* them, so they read as documenting the `useEffect`
that follows.

### B6. README + detail.md still describe the rotation as *the* selection strategy
- [README.md:19](../README.md#L19) — *"a deterministic rotation through the
  world's ~1000 most populous cities"*.
- [docs/detail.md:1-9](detail.md#L1) — an entire *"How the daily city is chosen"*
  section documenting only `(days × 379) % N`, with no mention that this is now
  a fallback.

Since issue #1 the daily city comes from the CI-authored schedule
(`osm-v2/city-list.json`, pool = `cities-famous.json` + `cities-countries.json`,
~1055 cities). `city.rs:21-27` states the rotation *"is the fallback, not the
daily city"*; `docs/random-city-strategy.md` documents the real mechanism at
length. `detail.md` is the contributor-facing architecture doc, so this is the
most misleading single item in the audit.

`detail.md` has four smaller staleness items in the same vein: *"fetches road +
water data"* (now five layers, twice — lines 28 and 32), *"scheduler picks
today's city"* (now the four-rung `resolve_daily` ladder), and the `scripts/`
inventory listing 2 of 6 scripts.

## C. Duplication across files

Where the same explanation is maintained in N places, a change needs N edits.
This has already gone wrong once (B5).

| Explanation | Copies |
|---|---|
| "the status push replaced the old 2s poll" | `events.rs:17`, `state.rs:97`, `lib.rs:277`, `App.tsx:38-41`, plus the stale `Style.tsx:46` — **5** |
| "`update_mode` replaces the old `enabled` bool" | `config.rs:136`, `state.rs:28`, `types.ts:14` — **3**. Only the `config.rs` copy is load-bearing (it explains why `parse_config` exists). |
| Windows `RegisterApplicationRestart` rationale, at full length | `lib.rs:38-43` (fn doc) and `lib.rs:130-135` (call site) — **2**, ~6 lines each, near-verbatim |
| Dev Mode bypass gating rationale | `state.rs:145-159`, `cdn.rs:68-83`, `github_mirror.rs:88-92`, `commands.rs:332-334`, `DevMode.tsx:45-49` — **5** |
| "jsDelivr 20 MB per-file cap, that's why .gz" | `cdn.rs:161-168`, `osm-cli.ts:29-35`, `precache.yml:10-16` — **3** |
| Advance Preview's stale-PNG caveat | `pipeline.rs:748-751`, `random-city-strategy.md:196-201` — **2** |

The cross-language ones (Rust↔TS↔YAML) can't be deduplicated by import and are
legitimately repeated — `schedule-test.ts` even machine-checks five of those
copies. The same-file and same-language ones are just duplication.

## D. Redundancy inside a single comment

- **Doc comment restated inline.** `render.ts:350-355` documents *"grouped by
  stroke width and drawn thinnest-first so heavier roads layer on top"*; lines
  366 and 377 then repeat both halves as inline comments over the code that does
  it.
- **Section banner + per-item doc.** `render.ts:13-23` is a 11-line box
  explaining that the tokens below are design tokens; each of the six tokens then
  has its own doc comment saying the same thing more specifically.
- **Restating the signature.** `airports.ts:27-31`, `railways.ts:49-57`,
  `aerialways.ts:58-64` each open with *"Assemble a raw X Overpass response into
  slim, render-ready features. Coordinates are optionally rounded to
  `coordPrecision` decimals — mirrors slimY."* Three copies of a sentence that
  the type signature already states; only the trailing why-clauses differ.
- **Pure "what" comments** (rare, ~8 total), e.g. `pipeline.rs:731-736`
  `write_osm` (creates parent, writes), `mondrian.ts:283-291` `pickColor`,
  `water.ts:200-207` `corner`.

## E. Meta-narrative / process language

Comments about the authoring process rather than the code:

| Where | Text |
|---|---|
| `tray.rs:107` | "pre-existing, **out of scope here**" |
| `core/constants.ts:39-42` | "Two changes share one number because … it never invalidated the cached payloads … **for two releases**" (in `OSM_SCHEMA_VERSION`) |
| `core/schedule.ts:88-92` | "**which is how it stayed absent from this comment for two releases**" |
| `schedule-test.ts:82-90` | "**Until this check existed** the only thing holding the five copies together was a comment, and it had already drifted" |
| `events.rs:24-27` | "Reserved: … no backend path emits it today … Kept here so the registry stays complete" (accurate — `App.tsx:76` does listen — but the tone is a changelog) |
| `App.tsx:73-74` | "(The tray's 'Update available' entry **no longer uses it**…)" |
| `App.tsx:127-131` | A 5-line comment documenting a frontend timer that **does not exist** |
| `updates.rs:218-221`, `pipeline.rs:263`, `osm_sidecar.rs:18-20`, `fetch-city.ts:4-7`, `overpass.ts:4-6` | "instead of the old X", "rather than the previous Y" — the pre-refactor state as a comparison baseline |

`OSM_SCHEMA_VERSION`'s `History:` list (constants.ts:34-42) is the one
changelog-style comment worth keeping: entry 5 documents a real trap (one version
number covering two payload changes) that a reader bumping `v` must know. It can
be tightened, not dropped.

## F. Style inconsistencies

1. **Rust doc-comment marker.** `//!` module docs are used in exactly one file
   (`events.rs`); the other 16 modules use a plain `//` block at the top even
   where the content is module-level documentation. `bbox.rs`, `state.rs`,
   `tray.rs`, `wallpaper_set.rs` have no module header at all.
2. **TS module headers straddle the imports.** Some files put the header above
   the imports (`types.ts`, `constants.ts`, `mondrian.ts`), others below
   (`water.ts`, `airports.ts`, `railways.ts`, `aerialways.ts`, `roads.ts`,
   `city.ts`). Both appear inside `src/core/osm/`.
3. **`/** */` vs `//` for the same job.** Exported functions are mostly `/** */`,
   but `render.ts`'s `drawX` family, `geom.ts` and `bbox.ts` mix both for
   identically-scoped items.
4. **Issue-number citation.** `(issue #11)`, `issue #18`, `#33`, `Issue #18.`,
   `— see #44` all appear. No dominant form.
5. **Typographic characters.** `—`, `•`, `▸`, `⇒`, `≥`, box-drawing `─` rules and
   `─────` banners are used freely in Rust and TS. Consistent enough to be a
   deliberate house style; keeping it.
6. **Comment-only "sections".** `pipeline.rs` uses `─────` banner blocks to
   divide the file (5 of them); no other Rust module does.

## G. Missing documentation

Ranked by how much a reader loses:

1. **`src-tauri/src/lib.rs` has no module header.** It is the app's entry point
   and wiring: plugin order (with a load-bearing "single-instance must be first"
   constraint), window setup, per-OS branches, and the status-emitter task. There
   is no orientation comment at the top.
2. **No `src-tauri/src/` architecture map.** 17 Rust modules with no index of
   what talks to what. `docs/detail.md`'s tree stops at `src-tauri/` as one line.
   The TS side has `src/core/index.ts` acting as this map; Rust has nothing.
3. **`KEEP_DAYS` (`pipeline.rs:21`) is undocumented** — the cache-retention
   window, referenced by `cleanup_daily`, `render_preview` and `detail.md`'s
   "cached for 7 days".
4. **`bbox.rs`, `state.rs`, `tray.rs`, `wallpaper_set.rs`: no module header.**
   `state.rs` is the shared-state definition every other module reads.
5. **`Status` (`commands.rs:16`) has no type-level doc** despite being the single
   backend→frontend state contract, mirrored by `src/types.ts`.
6. **`src/index.css`** — 100+ lines of design tokens, theme variables and the
   `dark` override with no comment on where the palette comes from or which parts
   the wallpaper renderer reads vs. the app chrome.
7. **`components.json` / `vite.config.ts` / `tsconfig*.json`** — no comments;
   fine for the tsconfigs, but the `@/` alias is defined in two places
   (`vite.config.ts` and `tsconfig.json`) with nothing noting they must agree.

## H. Things deliberately left alone

- `src/components/ui/*` — vendored shadcn, zero comments, not ours to annotate.
- `src/i18n/*.json` — data, no comment syntax.
- `CHANGELOG.md` — generated by release-please.
- `CLAUDE.md` — the user's own instruction file.
- `docs/task.md` — shows as deleted in the working tree from **before** this
  cleanup started; not touched, and not staged in any checkpoint commit.
- Test-name-as-documentation in the Rust `#[cfg(test)]` blocks (`cdn.rs`,
  `pipeline.rs`, `config.rs`, `city.rs`, `lib.rs`). The per-test comments explain
  *why the case exists*, which is the good kind; they are dense but earn it.
- Two `package.json` / doc mismatches that are **code**, not comments, and so out
  of scope for this pass — logged in `_cleanup_questions.md` instead:
  `npm` vs `pnpm` in `detail.md`, and `osm-cli.ts:311`'s log line omitting the
  airports count.
