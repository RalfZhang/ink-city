# Random city strategy (issue #1)

The daily city moves from a stateless client-side permutation to a **CI-authored,
date-keyed schedule** with no-repeat constraints, published to the CDN and read
by the client. The legacy permutation was kept as a fallback during the migration
and has since been **removed from the client** — see
[Retiring the rotation](#retiring-the-rotation).

## Status — implemented

Two different claims live in this section, and they age differently, so the dates
are per-row rather than one date on the heading. **Implemented** means the code is
in and its tests pass — true as of each row. **Verified** means the live
CI→CDN→client path was actually observed working end to end, which is a claim about
a particular day and can only be renewed by going and looking again (the blockquote
below records the last time anyone did).

| Part | State |
|---|---|
| Schedule state + cooldowns (`src/core/schedule.ts`) | ✅ + tested (`pnpm schedule-test`) |
| Pre-cache advances the schedule and emits manifests (`scripts/osm-cli.ts`) | ✅ (additive to `osm/<id>.json`) |
| Workflow gzips + publishes `osm-v2/` (`.github/workflows/precache.yml`) | ✅ |
| Client fetch-by-date + reconstruction (`cdn.rs` + `pipeline.rs`) | ✅ |
| `Status` names the rendered city and nothing else (`pipeline::city_for_status`) | ✅ |
| Dev Mode reads the schedule, not the rotation (`render_preview`, bypass) | ✅ |
| Client-side rotation fallback removed | ✅ code + tests (CI still publishes `osm/` until 2026-11-01) — **not** re-verified against the live path |
| Unresolvable day surfaced in the UI (`Status::last_error`) | ✅ + tested (`error_for_today`) |

> **The whole path is live, verified end to end** — CI publishes, jsDelivr serves,
> and the client consumes. `osm-v2/city-list.json` and the
> `osm-v2/data/<date>.json[.gz]` manifests are on the `data` branch (checked
> 2026-07-28: the schedule held 7 days, today…today+6, every manifest fetched 200;
> client consumption confirmed 2026-07-31). The schedule logic itself is covered by
> `pnpm schedule-test`. Each rung still degrades into the next; what changed is
> where the ladder ends — the bottom is now the schedule state file, not a local
> formula.
>
> That observation predates the rotation's removal, and it only ever exercised the
> path where the schedule *is* reachable — which the removal didn't touch. What it
> has never covered is the new failure end: no host serving either schedule file.
> Reproducing that against the live CDN means blocking seven hosts, so it's pinned
> by unit tests instead, and the end-to-end column above stays honest about it.

## Published layout (`data` branch)

```
osm/                        legacy id-keyed rotation — DEPRECATED, published for
  <id>.json                 pre-removal clients only; remove after 2026-11-01
  <id>.json.gz
osm-v2/
  city-list.json            the schedule itself (CI + humans; the client reads it
                            when no manifest is reachable, and for Dev Mode's
                            bypass — see below)
  data/
    <YYYY-MM-DD>.json       one day's city + map data
    <YYYY-MM-DD>.json.gz
```

`city-list.json` deliberately sits *beside* `data/`, not in it: the manifest
prune and the workflow's gzip pass both sweep `data/`, so keeping the schedule
one level up means neither can touch it.

## How it works

**The schedule is stored, not derived.** `osm-v2/city-list.json` *is* the
schedule:

```json
{ "list": { "2026-07-28": { "id": 2797656, "name": "Ghent", ... }, ... } }
```

An earlier revision derived each day from a seeded PRNG, so the sequence was a
pure function of `(date, pool)` and needed no storage. That was reproducible but
unsteerable: pinning a chosen city on a chosen day meant bending the seed, and
editing a pool retroactively rewrote every past day (picks were pool *indices*).
Now picks are genuinely random (`Math.random`) and the result is persisted — which
is also what makes the cooldowns possible at all, since a random pick can't be
recomputed, only remembered.

**Pool** — every `src/data/cities-*.json` (currently `cities-famous.json` +
`cities-countries.json`), merged and **deduped by `id`**, with later files
winning: ~1055 cities from 1276 rows. `cities.json` is excluded on purpose (the
hyphen in the glob) — it belongs to the legacy rotation, and is now only the desktop
Customized-mode search index plus that deprecated CI flow's list. The two pools share ids
for the 221 cities they both list but differ in coordinate precision and in how
they spell names (`Bogotá` vs `Bogota`); `cities-famous.json` wins those by glob
order. `country` is **not** one of the divergences — all pools carry the same ISO
3166-1 alpha-2 code for a given id — so which pool wins never shifts whose
country cooldown a city shares.

**Each run** (`scripts/osm-cli.ts` → `runScheduleCache`):

1. Read `city-list.json`. A malformed *entry* is dropped with a warning, not
   fatal — the file is hand-editable, and one bad day shouldn't stop the other 29
   from being scheduled. A malformed *file* (JSON that won't parse, or no `list`
   object) aborts the schedule for that run: this is the schedule's only copy, so
   treating it as empty would append a fresh rotation over the top and silently
   discard every hand-pinned day. Nothing is written, the restored copy is
   republished untouched, and the run goes red so a human fixes the JSON.
2. Give **one** day a city: `today+6`, the day that just came into range.
   **Existing entries are never re-rolled**, so a day already in the file — by an
   earlier run or by hand — is left exactly as it is. The pick excludes every city
   scheduled within 30 days *either side* of it, and every country within 5 days
   either side.
3. Drop every entry older than `today-23`. Entries *newer* than `today+6` are
   kept: those are hand-pinned future days, waiting for the calendar to reach them.
4. Reconcile the published manifests against it: an `osm-v2/data/<date>.json` is kept
   only if its `city.id` **and** `city.name` still match and its `v` is current;
   otherwise it's deleted and re-fetched. Days outside `today-2 … today+6` are pruned.
5. Fetch the missing days into
   `osm-v2/data/<YYYY-MM-DD>.json = { v, …osm, date, city }`, so the client gets a
   day's city + map data in one request.

Steps 2 and 3 are one function (`advanceSchedule`) because the order matters and
must not be separable at a call site. Picking `today+6` looks back 30 days to
`today-24`, and that is precisely the day step 3 removes — prune first and the
edge of the cooldown goes unguarded. The symptom would be a repeat at a gap of
exactly 30 days, about once every 1200 days: far too rare to notice, which is why
the constants carry an asserted invariant
(`CITY_COOLDOWN_DAYS === HISTORY_BACK_DAYS + 1 + LOOKAHEAD_DAYS`) and
`schedule-test.ts` pins the ordering with a forced-RNG case rather than trusting a
random run to expose it.

**Changing a city by hand** — edit that day's entry in `city-list.json` on the
`data` branch. The next run (≤6h, or trigger `Precache OSM` manually) sees the
manifest disagree, deletes it, and re-fetches the map data for the new city. Step 2
never touches days that already exist, so the edit sticks — **at any distance in
the future**, because both the retention window (step 3) and the manifest window
are measured in days off today rather than in entry counts, so a day pinned months
out neither gets pruned nor steals a manifest slot. And because the cooldowns are
symmetric, the days scheduled *around* it later will honour it: they see it inside
their own window and pick something else. Two things it can't do: editing a day
*in the past* has no effect (the client has moved on), and two days you pin **by
hand** can still conflict with each other, since nothing re-rolls an existing
entry.

Because only `today+6` is ever filled, a day that has no entry stays empty. Not
re-rolling nearer days is deliberate — it would fight the hand-edits this file exists
to carry — and a gap therefore has to come from somewhere unusual: a hand-deletion, a
`parseState` rejection, or CI not running for more than a day. **A gap now costs
more than it used to**: with the rotation removed there is nothing below the schedule,
so a day with no entry and no manifest can't be painted at all (the previous
wallpaper stays up and the poll keeps retrying). Filling gaps by hand in
`city-list.json` is the fix.

**Client** (`src-tauri`) — `pipeline::resolve_daily` resolves the day's city and
its map data *together*, walking one ladder and stopping at the first rung that
answers:

1. **The local day cache** `daily/<date>.osm.json`. If it's there, that's what the
   day was already rendered from, and its `city` envelope names the city. No network.
2. **The published manifest** `osm-v2/data/<date>.json[.gz]` — city *and* map data
   in one request. `cdn::fetch_scheduled` walks every jsDelivr-style CDN edge
   (`.gz`, then plain `.json`, per host) before GitHub's raw origin, so this rung on
   its own is *CDN gz → CDN json → … → GitHub gz → GitHub json*.
3. **Reconstruct the manifest.** With no host serving one, read the schedule *state*
   file `osm-v2/city-list.json` (a few KB; CDN edges, then GitHub) for the day's
   city, fetch that city's map data live from Overpass, and splice `{ date, city }`
   back onto it. The result is shaped exactly like rung 2's payload, so the day
   cache — and `city_for_status` after a restart — can't tell the two apart. The
   state file is never cached locally: it's small, and it's the hand-edit override
   point, so a stale copy would be worse than a refetch.

**There is no rung 4.** When rung 3 misses too, `resolve_daily` returns an error: the
day is unresolvable, the previous wallpaper stays up, and `scheduler::reconcile`
retries on its next 60s poll (logging `error!` each time it can't paint). Advance
Preview surfaces the same failure inline. See
[Retiring the rotation](#retiring-the-rotation) for what used to be here and why it
went.

The client never computes a pick of any kind, so there is no Rust port to keep in
lockstep — and with random picks there couldn't be one.

Step 1 is load-bearing, not just a saving. `spawn_force_regen` (theme switch,
colour/style edit, Lab toggles, "regenerate now") deletes only the PNG and
re-enters the pipeline, so without it every colour tweak would re-download the
whole manifest — tens of MB — and, worse, could resolve a *different* city than
the PNG already cached for the other theme. Because the PNG cache key is
date+theme rather than city, a day must keep whatever city it first rendered
with; consulting the cache before the network is what guarantees that. Resolving
the city and the OSM in one place is the other half of it: the two can't
disagree if nothing resolves them separately.

**One city per day, everywhere.** Because the pick is no longer a pure function of
the date, nothing may recompute it — and now nothing *can*. `Status` (the City tab's
name, coordinates and Wikipedia / Maps links) reads `pipeline::city_for_status`,
which returns what the pipeline resolved: `AppState::resolved_city`, else the `city`
envelope on that day's cached `<date>.osm.json` (which is how it survives a restart
onto an already-rendered day), else **`None`** — the City tab then holds an em dash
where the name goes and disables the two lookup links until the day resolves.

`None` alone is ambiguous, though, and the two cases behind it want opposite things
from the user: a day still arriving wants patience, a day that can't arrive wants
the network looked at. So `Status::last_error` carries the reason (Daily-only, and
gated to *today* so a failure can't outlive the day it happened on), and the City
tab spends its coordinate line on it — "fetching…" versus "can't reach the
schedule" — rather than a second em dash. It's one muted line either way, so
nothing shifts when the city lands. That error never reaches the global banner:
every 60s poll re-records it, so a dismissable banner could never stay dismissed.

`last_error` has to be state rather than a returned `Result` because every caller
of `run_now` is detached and drops it — including `regenerate_now`, which is the
button the user is most likely to press while looking at the gap.

A **future** website (see [detail.md](detail.md)) will read the manifests, not
`pickCityForDate`. That's the only thing that keeps it consistent with the desktop
app: the pick is random and stored, so a website recomputing the retired formula
locally would name a different city every single day, with no code path left that
could make the two agree.

**Both flows carry `city`.** The legacy `osm/<id>.json` payloads get the same
envelope (backfilled into already-cached files without re-fetching). Additive and
ignored by existing clients. A payload fetched live from the sidecar has no
envelope of its own, so the client stamps one on before caching it
(`pipeline::stamp_manifest_envelope`) — otherwise a day rendered from a live fetch
would have no name at all after a restart. A cached payload from *before* the
envelope existed is unnameable for exactly that reason, so `resolve_daily` **deletes
it** and re-resolves the day rather than pairing one city's map data with another's
name. Deleting beats leaving it for the answering rung to overwrite, because the
rungs below can fail — and then a file nothing can use would be re-read and
re-parsed, tens of MB, on every 60s poll.

## Retiring the rotation

The client's last rung used to be the legacy population rotation:
`city::pick_for_date` — `(days_since_2023-03-03 * 379) % N` over the
population-sorted `src/data/cities.json` — plus the id-keyed `osm/<id>.json`
pre-cache for its map data. It existed so a total CDN outage still painted
*something*, and it logged a `warn` (the only signal that the CI→CDN→client path had
broken).

**It's gone from the client**, for two reasons. The case it covered had shrunk to
almost nothing once rung 3 landed: rung 3 needs only a few KB of `city-list.json`
from any of the CDN edges *or* GitHub raw, so reaching the rotation meant "every one
of those hosts unreachable, but Overpass reachable" — while the far more common
cause, an offline machine, would have failed one step later at the Overpass fetch
anyway. And what it painted was *a different city than the schedule had for that
day*, which the day cache then pinned for the rest of the day (the PNG cache key is
date+theme, not city). A day nobody can name is now simply not painted, and the
poll retries.

What went with it: `city::pick_for_date` and its `EPOCH`/`MULTIPLIER`,
`pipeline::rotation_fallback`, `Resolved::cdn_id`, and `cdn::fetch_cached_osm` —
the client no longer reads `osm/` at all. `city.rs` still loads
`src/data/cities.json` (bundled + hot-updated by `cities_update`), but only as the
index behind the City tab's Customized-mode name search; `src/core/city.ts` keeps
`pickCityForDate` for CI.

**CI still publishes `osm/`**, unchanged, for clients shipped before this change —
they have no other last rung. **Recommended removal after 2026-11-01**, by which
point anything still reading it is ~3 months stale. `scripts/osm-cli.ts`'s header
lists everything that goes at once (including re-deriving `MIN_NEEDED_TO_ALARM`,
whose "two fetches per day" premise halves), and `.github/workflows/precache.yml`
marks the two spots in the workflow.

## Dev Mode

Both Dev Mode affordances follow the schedule — they were written that way while the
rotation was still around, because a dev tool that quietly showed a different city
than the product would be worse than useless. Both are **disabled while the City tab is on
`Customized`** (backend-enforced, not just greyed out): there's no daily schedule
to look ahead at, and a pin already fetches live from Overpass, so there's nothing
left to bypass.

**Advance Preview** (`pipeline::render_preview`) is deliberately just the ordinary
Daily path with a date handed to it — same `resolve_daily` ladder, same
`wallpaper/daily/` cache for both the payload and the PNG, same
`render_and_cache` helper the real pipeline uses, so the two cannot drift apart.
The only thing it skips is applying the wallpaper and touching `last_applied`.
Caching the result is the point: that day wants those files within a day or two
anyway. The consequence to know is that the real pipeline treats a cached
`{date}-{theme}.png` as "already rendered, just reapply it" with no staleness
check, so a day previewed *before* a style/colour change reapplies the pre-change
PNG when it arrives — Clean cache (directly above the control) or previewing again
is the fix.

Because the PNG is already on disk, double-clicking the preview just opens that
cached file (`wallpaper/daily/<date>-<theme>.png`) in the OS image viewer — the
render carries its path back and `commands::open_preview_image` opens it, refusing
anything outside the cache dir. No copy is exported to Pictures or anywhere else,
so what you inspect full-size is exactly the file the pipeline will reapply.

**Bypass cache & CDN** jumps straight to rung 3 and keeps the schedule's city: it
skips the day cache and every manifest, reads `osm-v2/city-list.json` from
**GitHub's raw origin only** (`cdn::Hosts::GithubOnly` — a CDN edge could serve a
cached copy of the one file it still needs, which is exactly what the switch rules
out), and fetches the map live from Overpass, overwriting the local cache. That
combination is what makes it useful: fresh map data for the city the day is really
scheduled for.

## CI failure policy

A city that fails to fetch is a **`::warning::` annotation**, not a job failure: a
missing *manifest* still leaves the client rung 3 (the state file names the day and
Overpass supplies the map), and the job retries in 6 hours — letting one stubborn city
turn the run red forever would just train us to ignore it. The job fails on two
conditions:

- **Systemic fetch failure** — we needed to fetch **at least two** cities across
  both flows and every attempt failed (Overpass unreachable, a schema change, a
  bbox bug), which won't fix itself on retry.
- **An unreadable `city-list.json`** (see step 1 above) — nothing is lost, but
  only a human can fix it.

The two-city threshold is what keeps a single stubborn city quiet, and it matters
more than it looks. Steady state needs about two fetches per calendar day (one
rotation city, one schedule day), so the day's first run still catches a real
outage immediately. But once a run has succeeded at everything *except* one city,
later runs that day have nothing else left to try — without the threshold that
lone failure would satisfy "every attempt failed" and turn every remaining run of
the day red. A genuine outage escalates past the threshold on its own within a
day, as each new day adds another city and schedule day to the backlog.

> This is a deliberate change from the previous policy, which also failed the job
> when today's or tomorrow's rotation city was uncached. That case is now a
> warning.

> **Re-derive the threshold when the id-keyed flow is removed** (after 2026-11-01):
> steady state drops to ~one fetch per day, so `needed` will usually sit *below* 2
> and a real outage will take two days rather than one to escalate.

## Known edge cases / follow-ups

- `osm-v2/city-list.json` is the schedule's only storage, so deleting or resetting
  the `data` branch restarts the rotation from scratch and discards hand-picked
  upcoming days. A *skipped* publish is harmless by comparison — the branch keeps
  its previous copy — but it does throw away that run's work, which is why the
  publish guard checks `osm-v2/` as well as `osm/`.
- Because a run only ever fills `today+6`, a reset branch comes back **empty and
  fills forward one day at a time**: `today … today+5` have no entry, with the
  schedule taking over on day 6. The same applies after CI misses more than a full
  day — the days that were skipped are not back-filled. Neither fails the job, and
  both are recoverable by hand (add the days to `city-list.json`) — which is now the
  *only* recovery, since the rotation that used to cover those days is gone and the
  client simply won't paint one it can't name.
- The PNG cache key is date+theme, not city, so **a day keeps the city it first
  rendered with** — a manifest that lands after the day was already reconstructed
  from the state file only takes effect tomorrow. That's the day cache's job (step 1
  above): it pins city *and* OSM together, so a mid-day CDN change can't pair one
  day's city with another's map data, and a CDN failure after a PNG clear can't
  rename the day either.
- A day whose fetch keeps failing stays absent until it leaves the window; it is
  never re-rolled to a different city. Advance Preview surfaces exactly this case
  as an error.
- Manifest schema reuses `OSM_SCHEMA_VERSION` for `v`; the `date`/`city` envelope
  is additive.
- Precedence vs. the "customize city" pin (#11) is settled by the `UpdateMode`
  selector rather than by a fallback chain: `Customized` renders the pin and never
  consults the schedule, `Daily` renders the schedule and never consults the pin.
  So the two can't race, and the pin wins whenever the user has selected it.
