# Random city strategy (issue #1)

The daily city moves from a stateless client-side permutation to a **CI-authored,
date-keyed schedule** with no-repeat constraints, published to the CDN and read
by the client, with a graceful fallback to the legacy strategy.

## Status — implemented

| Part | State |
|---|---|
| Schedule state + cooldowns (`src/core/schedule.ts`) | ✅ + tested (`npm run schedule-test`) |
| Pre-cache advances the schedule and emits manifests (`scripts/osm-cli.ts`) | ✅ (additive to `osm/<id>.json`) |
| Workflow gzips + publishes `osm-v2/` (`.github/workflows/precache.yml`) | ✅ |
| Client fetch-by-date + fallback (`cdn.rs` + `pipeline.rs`) | ✅ (fallback-guarded) |
| `Status` names the rendered city, not a second rotation pick (`pipeline::city_for_status`) | ✅ |
| Dev Mode reads the schedule, not the rotation (`render_preview`, bypass) | ✅ |

> **The CI→CDN hop is live.** `osm-v2/city-list.json` and the `osm-v2/data/<date>.json[.gz]`
> manifests are published on the `data` branch and served by jsDelivr (verified
> 2026-07-28: the schedule held 7 days, today…today+6, and every manifest fetched
> 200). The schedule logic itself is covered by `npm run schedule-test`. What is
> still only exercised by hand is the client's own consumption of it; every new
> path is fallback-guarded, so a miss degrades to the previous behavior rather
> than failing.

## Published layout (`data` branch)

```
osm/                        legacy id-keyed rotation — unchanged
  <id>.json
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
hyphen in the glob) — it belongs to the legacy rotation. The two pools share ids
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
2. Append days until the last key is `today+6`. **Existing entries are never
   re-rolled.** Each new pick excludes every city already in the file (a ~30-day
   city cooldown) and every country used in the last 5 entries.
3. Trim to the newest 30 entries (`today-23 … today+6`).
4. Reconcile the published manifests against it: an `osm-v2/data/<date>.json` is kept
   only if its `city.id` **and** `city.name` still match and its `v` is current;
   otherwise it's deleted and re-fetched. Days outside the newest 9 are pruned.
5. Fetch the missing days into
   `osm-v2/data/<YYYY-MM-DD>.json = { v, …osm, date, city }`, so the client gets a
   day's city + map data in one request.

**Changing a city by hand** — edit that day's entry in `city-list.json` on the
`data` branch. The next run (≤6h, or trigger `Precache OSM` manually) sees the
manifest disagree, deletes it, and re-fetches the map data for the new city. Step 2
never touches days that already exist, so the edit sticks. Two caveats: editing a
day *in the past* has no effect (the client has moved on), and an edit can break
the cooldowns for days already scheduled after it — those aren't re-rolled.

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
4. **The legacy rotation** — `city::pick_for_date` plus the id-keyed `osm/<id>.json`
   → sidecar chain. Only reachable when not one host served *either* schedule file.
   On its way out; kept so a total CDN outage still paints something.

The client never computes a schedule pick, so there is no Rust port to keep in
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
the date, nothing may recompute it: `city::pick_for_date` is the *fallback*, not a
second source of truth. `Status` (the City tab's name, coordinates and Wikipedia /
Maps links) therefore reads `pipeline::city_for_status`, which returns what the
pipeline resolved — from `AppState::resolved_city`, else the `city` envelope on
that day's cached `<date>.osm.json` (which is how it survives a restart onto an
already-rendered day), else the rotation pick. The same caveat applies to the
website, which computes `pickCityForDate` client-side and has no access to the
schedule: it will name the rotation city until it reads the manifests too.

**Both flows now carry `city`.** The legacy `osm/<id>.json` payloads get the same
envelope (backfilled into already-cached files without re-fetching). Additive and
ignored by existing clients. A payload fetched live from the sidecar has no
envelope of its own, so the client stamps one on before caching it
(`pipeline::stamp_city_envelope`) — otherwise a day rendered from a live fetch
would revert to the rotation name after a restart.

## Dev Mode

Both Dev Mode affordances follow the schedule, not the rotation — the rotation is
on its way out, and a dev tool that quietly showed a different city than the
product would be worse than useless. Both are **disabled while the City tab is on
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

A city that fails to fetch is a **`::warning::` annotation**, not a job failure:
the client falls back to the live sidecar for anything missing from the CDN, and
the job retries in 6 hours — letting one stubborn city turn the run red forever
would just train us to ignore it. The job fails on two conditions:

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

## Known edge cases / follow-ups

- `osm-v2/city-list.json` is the schedule's only storage, so deleting or resetting
  the `data` branch restarts the rotation from scratch and discards hand-picked
  upcoming days. A *skipped* publish is harmless by comparison — the branch keeps
  its previous copy — but it does throw away that run's work, which is why the
  publish guard checks `osm-v2/` as well as `osm/`.
- The PNG cache key is date+theme, not city, so **a day keeps the city it first
  rendered with** — a schedule manifest that lands after the day already fell back
  to the rotation only takes effect tomorrow. That's the day cache's job (step 1
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
