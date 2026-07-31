# Open questions — skipped, need your call

Items I could not settle by reading the implementation, or where "correcting" the
comment would have meant deciding something that isn't mine to decide. **Nothing in
this list was edited**, except where noted as narrowed-not-deleted.

---

## 1. `detail.md` tells contributors `npm install`; everything else is pnpm

- [docs/detail.md:46](detail.md#L46) — `npm install` / `npm run tauri dev`
- `package.json` declares `"packageManager": "pnpm@11.11.0"`, and the repo has
  `pnpm-lock.yaml` + `pnpm-workspace.yaml` with no `package-lock.json`.
- Both CI workflows use `pnpm/action-setup` and `pnpm install --frozen-lockfile`.
- `CLAUDE.md` describes the project as pnpm-based.
- But `package.json`'s own scripts call `npm run` internally
  (`"build": "npm run check:i18n && tsc && vite build"`, `"pretauri": "npm run
  build:sidecar"`), and `precache.yml` shells out with `npx -y tsx@4`.

**Why I stopped:** a contributor following the doc literally would run `npm install`
against a pnpm lockfile — it works, but produces a `package-lock.json` and ignores
the workspace file. Fixing the doc is one line; fixing it *consistently* means
deciding whether the internal `npm run` calls and `npx` invocations should also
become pnpm, which is a real change to how the project is built. Every `npm run X`
in a comment or doc across the repo (~14 occurrences) hangs off the same decision.

**What I'd need:** is pnpm the only supported package manager, or is `npm` a
deliberately supported path? I'll do the sweep either way.

---

## 2. The "unverified end-to-end" notes — narrowed, not deleted

- [src-tauri/src/cdn.rs:50](../src-tauri/src/cdn.rs#L50)
- [scripts/osm-cli.ts](../scripts/osm-cli.ts) — `runScheduleCache`'s doc

Both said the publish→CDN→client path is "unverified end-to-end". That conflicts
with [random-city-strategy.md:18-24](random-city-strategy.md#L18), which states the
CI→CDN hop **is** live and dated it 2026-07-28 ("the schedule held 7 days … every
manifest fetched 200"), while saying the client's own consumption is still only
exercised by hand.

**What I did:** rather than delete (which would drop a live caveat) or leave a
contradiction, I narrowed both to "no automated test covers this; checked by hand"
and pointed them at the doc that owns the status.

**What I'd need:** confirm that's still true. If the client path has since been
verified too, both notes should go entirely — and the doc's status block with them.
Only you know the current state.

---

## 3. `docs/random-city-strategy.md` calls the rotation "on its way out"

Stated three times (lines 143, 184, and the rung-4 discussion). The code agrees it's
a fallback, but "on its way out" is a **plan**, not a fact about the code — and
`city.rs`'s rotation is still load-bearing: it's the last rung, it backs the website,
and `cities.json` is still the only pool wired into the app.

**Why I stopped:** I can't tell whether removal is actually intended and imminent, or
whether this is aspirational language from the issue #1 write-up. If it isn't
planned, the phrase should go, because it invites someone to delete working code.

---

## 4. `OSM_SCHEMA_VERSION` history — trimmed, but one judgement is yours

[src/core/constants.ts](../src/core/constants.ts) — I kept the fact that v5 covers
two payload changes (a real trap when bumping) and dropped the per-version changelog
(v1 = roads+water, v2 = airports, …).

**Why flag it:** the dropped list doubled as a record of which `v` corresponds to
which payload shape. Nothing in the code needs it — a payload with a stale `v` is
discarded, never interpreted — but if you ever have to reason about data published
by an old client, git history is now the only place it lives. Say the word and I'll
restore it as a compact one-line-per-version table.

---

## 5. Two `.gz` claims I could not verify

- [src-tauri/src/cdn.rs](../src-tauri/src/cdn.rs) `Gz::Skip` — "the workflow's gzip
  pass deliberately sweeps only `osm-v2/data/`, so a `.gz` here would always 404."
  The glob in `precache.yml` does match this, and `schedule-test.ts` asserts it, so
  the *internal* claim checks out. What I can't verify is the "always 404" part,
  which depends on what's actually on the `data` branch right now.
- [.github/workflows/precache.yml](../.github/workflows/precache.yml) — "jsDelivr
  already gzips `.json` responses over the wire transparently", and the 20 MB
  per-file cap. Both are claims about jsDelivr's current behaviour that I can't
  check from the repo. Left verbatim.

---

## 6. `events.rs::OpenTab` is dead but retained

[src-tauri/src/events.rs](../src-tauri/src/events.rs) — no backend path emits it;
`App.tsx` does listen. It carries `#[allow(dead_code)]` and a comment justifying
keeping it.

I only rewrote the comment's tone. Whether the variant and its frontend listener
should exist at all is a code decision — flagging it because "kept for a future
one-line change" is the kind of justification that outlives the future it imagined.

---

## 7. Out of scope: two code-level mismatches found while reading

Not comments, so untouched — but they look like defects:

1. **[scripts/osm-cli.ts:311](../scripts/osm-cli.ts#L311)** — the `[precache] cached`
   log line reports ways, water, railways and aerialways, but **omits the airports
   count**, which every other summary in the file includes (compare
   `scripts/render.ts:209-211`). Looks like an oversight when the layer was added.
2. **`preview_city` accepts `0..=5`** ([commands.rs:425](../src-tauri/src/commands.rs#L425))
   while the schedule fills through `today + LOOKAHEAD_DAYS` = **+6**. So Advance
   Preview can't reach the last scheduled day. May well be deliberate (the +6 day is
   the one just written, and the UI offers 0–5 to match), but the two constants aren't
   linked in code, so nothing keeps them consistent if `LOOKAHEAD_DAYS` changes.

---

## 8. Working-tree state I left alone

`docs/task.md` shows as **deleted but unstaged** — that predates this cleanup. I did
not stage, restore, or commit it. It is still sitting as an uncommitted deletion in
your working tree; decide whether that deletion was intended.
