import cdn from "./cdn.json";

// The data branch's table (./cdn.json): which repo and branch installed clients
// fetch published data from, the hosts that serve it in the order they're tried,
// and where the schedule sits on that branch. The desktop compiles the same file
// in (`github_mirror::table()` in apps/desktop/src-tauri/src/github_mirror.rs, which
// explains the choice of hosts); this is the TypeScript side of it — CI's
// producer and the website's fetch ladder.

/**
 * Where the schedule is published on the `data` branch:
 *
 *     <SCHEDULE_ROOT>/<SCHEDULE_STATE_FILE>          the schedule itself
 *     <SCHEDULE_ROOT>/<SCHEDULE_DATA_DIR>/<date>.json[.gz]
 *
 * The state file sits *beside* the manifest dir rather than inside it because
 * the manifest prune and the workflow's gzip pass both sweep that dir — one
 * level up is what keeps them off it.
 *
 * Defined in ./cdn.json, which the desktop compiles in as well (`ScheduleLayout`
 * in apps/desktop/src-tauri/src/github_mirror.rs), so the producer (CI, through
 * ./schedule.ts) and both readers are one definition rather than three kept in
 * step. The copy left over is `.github/workflows/precache.yml`, which can read
 * neither: its gzip glob and publish guard spell the paths out, and
 * `pnpm schedule-test` parses both and fails if either disagrees with these.
 *
 * Every release reads these paths with its own copy of the table compiled in, so
 * renaming one strands the versions already out there (CLAUDE.md, "Files clients
 * fetch at runtime") — add a new path instead.
 */
export const SCHEDULE_ROOT = cdn.schedule.root;
export const SCHEDULE_STATE_FILE = cdn.schedule.stateFile;
export const SCHEDULE_DATA_DIR = cdn.schedule.dataDir;

/**
 * Ordered candidate URLs for `path` on the data branch, across every host in the
 * table: the jsDelivr-style hosts first (`<host>/gh/<repo>@<branch>/<path>`), then
 * the raw-style ones (`<host>/<repo>/<branch>/<path>`), GitHub's own origin last.
 * The branch isn't a parameter because no file a client reads lives anywhere else.
 *
 * Mirrors `mirror_urls` in apps/desktop/src-tauri/src/github_mirror.rs; both are
 * tested against scripts/fixtures/mirror-urls.json, so the desktop's ladder and
 * the website's can't drift apart.
 */
export function mirrorUrls(path: string): string[] {
  const { repo, branch } = cdn;
  return [
    ...cdn.jsdelivrStyleHosts.map((host) => `${host}/gh/${repo}@${branch}/${path}`),
    ...cdn.rawStyleHosts.map((host) => `${host}/${repo}/${branch}/${path}`),
  ];
}
