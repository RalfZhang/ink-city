use std::sync::{OnceLock, RwLock};
use std::time::Duration;

use anyhow::{anyhow, Result};
use serde::Deserialize;

/// Process-wide proxy URL applied to every mirror fetch, or `None` for a direct
/// connection. Set once at startup from the persisted config and again whenever
/// the user changes the Proxy setting (see `commands::apply_proxy_settings`).
/// A module-level holder rather than a `client()` parameter because the callers
/// (`cdn.rs`, `cities_update.rs`) have no `AppState` handle, and the proxy is a
/// single app-wide setting.
static PROXY: RwLock<Option<String>> = RwLock::new(None);

/// Update the proxy applied to future `client()` builds. `None` (or the empty
/// string) means a direct connection.
pub fn set_proxy(url: Option<String>) {
    let normalized = url.filter(|u| !u.trim().is_empty());
    *PROXY.write().unwrap() = normalized;
}

/// Repo these mirrors serve. Update if the repo moves.
pub const REPO: &str = "RalfZhang/ink-city";

/// jsDelivr (and friends) rather than raw.githubusercontent.com directly,
/// because the latter is frequently DNS-poisoned in mainland China and
/// unreliable for users there.
///
/// jsDelivr itself can still have a partial or regional outage, so we also
/// try its alternate hostnames (all serve the same GitHub-backed content,
/// just different edge networks — testingcf.jsdelivr.net is jsDelivr's own
/// Cloudflare-only fallback domain, jsdelivr.b-cdn.net is Bunny-CDN-backed,
/// fastly.jsdelivr.net is Fastly-backed) plus cdn.statically.io, an
/// independent GitHub-CDN operator using the same "/gh/user/repo@ref/path"
/// URL convention, before dropping to raw.githack.com (an independent
/// Cloudflare-backed proxy of GitHub raw content with correct Content-Type
/// headers) and finally raw.githubusercontent.com directly — that one's last
/// because it's the one known to be DNS-poisoned in mainland China. Hosts
/// are tried in order; the first that returns a valid payload wins.
///
/// Deliberately not included: community mirrors like JSDMirror
/// (jsdmirror.com) — unlike the above, they're run by an unaudited single
/// operator rather than jsDelivr/GitHub/a CDN company, and mainland-China
/// ones are bound to content-compliance rules that could alter/pull content.
pub const JSDELIVR_STYLE_HOSTS: &[&str] = &[
    "https://cdn.jsdelivr.net",
    "https://testingcf.jsdelivr.net",
    "https://jsdelivr.b-cdn.net",
    "https://fastly.jsdelivr.net",
    "https://cdn.statically.io",
];
/// GitHub's own raw host — the origin everything above mirrors. It sits last in
/// `RAW_STYLE_HOSTS` because it's the one known to be DNS-poisoned in mainland
/// China, but it's also the only entry that *isn't* a cache or a CDN edge, which
/// is why Dev Mode's "bypass cache & CDN" asks for it by name (`github_only_urls`).
pub const GITHUB_RAW_HOST: &str = "https://raw.githubusercontent.com";
pub const RAW_STYLE_HOSTS: &[&str] = &["https://raw.githack.com", GITHUB_RAW_HOST];

/// Host serving GitHub *releases* — the updater's manifest and bundles, as
/// opposed to the repo files every host above serves. Sole input to
/// `release_mirror_urls`, which leaves any other host untouched.
const RELEASE_ORIGIN_HOST: &str = "github.com";

/// Relays for GitHub release downloads, for the in-app updater. A separate list
/// from the repo-file hosts above for two reasons, and the second is the one
/// that decides which hosts are admissible:
///
///   • Reach. jsDelivr and friends only serve files that live in the git tree,
///     and a release asset isn't one — `cdn.jsdelivr.net/gh/{REPO}@v0.12.1/`
///     `<asset>` answers 403 — so not one host above can carry an update. Nor
///     could they carry ours anyway: the per-file cap is 20 MB and the macOS
///     bundle is 70.
///   • Trust. The payloads `cdn.rs` fetches are unsigned, so a hostile mirror
///     there could quietly change what the wallpaper draws; that's why that
///     list is confined to jsDelivr/CDN operators and why community mirrors are
///     refused by name. An update is *signed*: `update_bundle::verify` checks
///     the bundle against the minisign pubkey configured for the app
///     (`plugins.updater.pubkey`) before anything is installed, and `check` only
///     accepts a version newer than the one running. So a relay here can make
///     an update fail, but it cannot substitute a build and it cannot roll a
///     user back — which is what makes these usable for updates and still not
///     for data.
///
/// Each takes a whole GitHub URL appended to the host
/// (`https://<host>/https://github.com/…`) and follows the redirect to the
/// short-lived signed `release-assets.githubusercontent.com` URL server-side.
/// Verified against v0.12.1: `latest.json` byte-identical to the origin's, full
/// 35 MB `.exe` identical by sha256, no size cap at 70 MB, and `206` on a ranged
/// request — the last one being what a resumable downloader would need.
///
/// The list itself lives in `update-mirrors.json` rather than in this file,
/// because it will rot: these are small independent operators, and of seventeen
/// candidates surveyed only five worked — the rest were dead, geo-fenced,
/// serving landing pages, or already rate-limiting. That file is compiled in as
/// the default *and* re-read from `main` at runtime, so a list gone stale is one
/// commit to fix for clients already installed (see `refresh_release_proxies`) —
/// which matters because a broken update path can't carry its own fix.
const MIRRORS_FILE: &str = "src-tauri/update-mirrors.json";
/// Branch the live copy is read from. `main`, not the CI-managed `data` branch:
/// this file is hand-edited under pressure, and `main` is never force-pushed.
const MIRRORS_REF: &str = "main";
/// The compiled-in copy of the very same file — one source of truth, so the
/// shipped default can't drift from what's published.
const BAKED_IN_MIRRORS: &str = include_str!("../update-mirrors.json");

/// Sanity cap on a fetched list. Not a limit anyone should hit; it bounds how
/// long a wrong or hostile list can make the ladder.
const MAX_MIRROR_HOSTS: usize = 12;

/// Relay hosts in force. Empty until something loads one — every read goes
/// through `release_proxy_hosts`, which falls back to the compiled-in list, so
/// this being empty is never a functional state.
static RELEASE_PROXIES: RwLock<Vec<String>> = RwLock::new(Vec::new());

#[derive(Deserialize)]
struct MirrorList {
    hosts: Vec<String>,
}

/// The relay list to use: whatever was last loaded, else the compiled-in
/// default. Safe to call before any load has happened.
pub fn release_proxy_hosts() -> Vec<String> {
    let live = RELEASE_PROXIES.read().unwrap();
    if live.is_empty() {
        baked_in_hosts()
    } else {
        live.clone()
    }
}

/// The compiled-in list, parsed once.
///
/// A file that doesn't parse is a build-time mistake, but panicking here would
/// turn it into a crash on a user's machine — so it degrades to no relays
/// (origin only) and is caught instead by
/// `the_baked_in_mirror_list_is_usable`, which fails the build's test run.
fn baked_in_hosts() -> Vec<String> {
    static PARSED: OnceLock<Vec<String>> = OnceLock::new();
    PARSED
        .get_or_init(|| match parse_mirror_list(BAKED_IN_MIRRORS) {
            Ok(hosts) => hosts,
            Err(e) => {
                log::error!("[mirrors] compiled-in list is unusable, origin only: {e}");
                Vec::new()
            }
        })
        .clone()
}

/// Parse and vet a mirror list, from either copy of the file.
///
/// Vetting matters more for the fetched copy than the compiled-in one: it is
/// read from the network, so it decides where an update *may* be downloaded
/// from. Non-https and unparseable entries are dropped rather than trusted, the
/// count is capped, and a list that ends up empty is refused outright so the
/// list already in force survives instead of being replaced with nothing.
///
/// What vetting deliberately doesn't have to catch is a *malicious* host: the
/// origin is compiled in and always tried first, so nothing here can redirect
/// the primary route, and every downloaded bundle is verified against the app's
/// minisign pubkey regardless of which host served it.
fn parse_mirror_list(json: &str) -> Result<Vec<String>> {
    let list: MirrorList = serde_json::from_str(json)?;
    let hosts: Vec<String> = list
        .hosts
        .iter()
        .map(|host| host.trim().trim_end_matches('/').to_string())
        .filter(|host| match reqwest::Url::parse(host) {
            Ok(url) if url.scheme() == "https" && url.has_host() => true,
            _ => {
                log::warn!("[mirrors] ignoring unusable host {host:?}");
                false
            }
        })
        .take(MAX_MIRROR_HOSTS)
        .collect();
    if hosts.is_empty() {
        return Err(anyhow!("mirror list has no usable hosts"));
    }
    Ok(hosts)
}

/// Adopt a mirror list from JSON — used to restore the cached copy at startup.
/// Rejects an unusable list rather than applying it, leaving the compiled-in
/// default in force.
pub fn set_release_proxies(json: &str) -> Result<()> {
    let hosts = parse_mirror_list(json)?;
    log::info!("[mirrors] using {} relay hosts", hosts.len());
    *RELEASE_PROXIES.write().unwrap() = hosts;
    Ok(())
}

/// Re-read the published list from `main` over the data-path CDN — a route
/// already proven reachable where GitHub itself isn't (see `cdn.rs`), which is
/// the whole point: it works in exactly the situation the relays exist for.
///
/// Returns the JSON that won so the caller can cache it, or `None` if every host
/// missed. Never fails and never disturbs the list in force on a miss.
pub async fn refresh_release_proxies() -> Option<String> {
    let client = match client() {
        Ok(client) => client,
        Err(e) => {
            log::warn!("[mirrors] no HTTP client: {e}");
            return None;
        }
    };
    for url in mirror_urls(MIRRORS_REF, MIRRORS_FILE) {
        let fetched = match client.get(&url).send().await {
            Ok(response) if response.status().is_success() => response.text().await,
            Ok(response) => {
                log::debug!("[mirrors] HTTP {} ({url})", response.status());
                continue;
            }
            Err(e) => {
                log::debug!("[mirrors] {url}: {e}");
                continue;
            }
        };
        match fetched {
            Ok(json) => match set_release_proxies(&json) {
                Ok(()) => {
                    log::info!("[mirrors] refreshed from {url}");
                    return Some(json);
                }
                Err(e) => log::warn!("[mirrors] {url} served an unusable list: {e}"),
            },
            Err(e) => log::debug!("[mirrors] {url}: {e}"),
        }
    }
    None
}

const USER_AGENT: &str = "InkCity/0.1";

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// Whole-request cap for `client()`'s small JSON reads.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
/// Inactivity cap for `download_client()`: how long one read may go without
/// delivering bytes before the transfer is treated as wedged. Resets on every
/// successful read, so it measures a stalled socket and not a slow one.
const DOWNLOAD_READ_TIMEOUT: Duration = Duration::from_secs(30);

/// Shared base for the clients below: the user agent, the connect budget and the
/// configured proxy (see `set_proxy`). An invalid proxy URL is logged and
/// skipped rather than propagated, so a bad setting degrades to a direct
/// connection instead of breaking every fetch.
fn proxied_builder() -> reqwest::ClientBuilder {
    let mut builder =
        reqwest::Client::builder().user_agent(USER_AGENT).connect_timeout(CONNECT_TIMEOUT);
    if let Some(url) = PROXY.read().unwrap().as_ref() {
        match reqwest::Proxy::all(url) {
            Ok(proxy) => builder = builder.proxy(proxy),
            Err(e) => log::warn!("[proxy] ignoring invalid proxy URL {:?}: {}", url, e),
        }
    }
    builder
}

/// HTTP client shared by all GitHub-mirror fetches of the published map data —
/// a few KB to a few MB of JSON per request, where a whole-request cap is the
/// right shape.
pub fn client() -> Result<reqwest::Client> {
    Ok(proxied_builder().timeout(REQUEST_TIMEOUT).build()?)
}

/// Client for update-bundle downloads (`update_bundle::fetch`). Same proxy as
/// `client()`, deliberately different timeouts: a 60-second whole-request cap
/// is right for a manifest and fatal for a 70 MB bundle, which on a slow link
/// legitimately takes the better part of an hour. This bounds *inactivity*
/// instead, so a slow-but-alive transfer runs as long as it needs to while a
/// wedged socket still fails in `DOWNLOAD_READ_TIMEOUT` rather than hanging on
/// the OS-level TCP timeout.
pub fn download_client() -> Result<reqwest::Client> {
    Ok(proxied_builder().read_timeout(DOWNLOAD_READ_TIMEOUT).build()?)
}

/// Ordered candidate URLs mirroring `{REPO}@{git_ref}/{path}` across the
/// hosts above, jsDelivr-style hosts first, then raw-content-style hosts.
pub fn mirror_urls(git_ref: &str, path: &str) -> Vec<String> {
    JSDELIVR_STYLE_HOSTS
        .iter()
        .map(|host| format!("{host}/gh/{REPO}@{git_ref}/{path}"))
        .chain(RAW_STYLE_HOSTS.iter().map(|host| format!("{host}/{REPO}/{git_ref}/{path}")))
        .collect()
}

/// `{REPO}@{git_ref}/{path}` at GitHub's raw host only — no CDN edge, no proxy
/// mirror. For Dev Mode's "bypass cache & CDN", which still has to read one small
/// file (the schedule state, see `cdn::fetch_schedule_city`) and must read it from
/// the origin: a CDN edge could serve a cached copy, and a cached copy is the
/// exact thing that switch exists to avoid.
pub fn github_only_urls(git_ref: &str, path: &str) -> Vec<String> {
    vec![format!("{GITHUB_RAW_HOST}/{REPO}/{git_ref}/{path}")]
}

/// A release URL to try in order: `url` itself first, then the same URL through
/// each relay in `release_proxy_hosts`.
///
/// Origin first, unlike the data path — there the CDN edge is simply the better
/// route for everyone, whereas a relay here is a detour that only helps a user
/// who can't reach GitHub. Putting it first means the common case involves no
/// third party at all and costs the blocked user a bounded wait (`updates`
/// bounds the manifest fetch per endpoint and the check as a whole, and
/// `download_client`'s read timeout bounds a wedged bundle transfer) before the
/// ladder carries them.
///
/// A `url` that isn't on `RELEASE_ORIGIN_HOST` comes back alone: it's already a
/// mirror, a self-hosted endpoint or unparseable, and prefixing a relay onto
/// something it doesn't proxy would only manufacture failures.
pub fn release_mirror_urls(url: &str) -> Vec<String> {
    let on_origin = reqwest::Url::parse(url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(|host| host == RELEASE_ORIGIN_HOST))
        .unwrap_or(false);
    if !on_origin {
        return vec![url.to_string()];
    }
    std::iter::once(url.to_string())
        .chain(release_proxy_hosts().into_iter().map(|host| format!("{host}/{url}")))
        .collect()
}

/// `host:443` for the release origin and every relay — the target set for the
/// updater's "is the network up yet?" pre-flight (`updates::endpoint_reachable`),
/// which needs hosts to open a socket to rather than URLs to fetch.
pub fn release_probe_targets() -> Vec<String> {
    std::iter::once(RELEASE_ORIGIN_HOST.to_string())
        .chain(
            release_proxy_hosts()
                .iter()
                .filter_map(|host| reqwest::Url::parse(host).ok()?.host_str().map(str::to_string)),
        )
        .map(|host| format!("{host}:443"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn github_only_urls_is_the_origin_alone() {
        let urls = github_only_urls("data", "osm-v2");
        assert_eq!(urls, ["https://raw.githubusercontent.com/RalfZhang/ink-city/data/osm-v2"]);
        // Nothing cache-y may sneak in — that's the point of the bypass.
        for url in &urls {
            assert!(!JSDELIVR_STYLE_HOSTS.iter().any(|h| url.starts_with(h)));
            assert!(!url.starts_with("https://raw.githack.com"));
        }
    }

    #[test]
    fn mirror_urls_covers_all_hosts_jsdelivr_style_first() {
        let urls = mirror_urls("main", "src/data/cities.json");
        assert_eq!(urls.len(), JSDELIVR_STYLE_HOSTS.len() + RAW_STYLE_HOSTS.len());
        assert_eq!(
            urls[0],
            "https://cdn.jsdelivr.net/gh/RalfZhang/ink-city@main/src/data/cities.json"
        );
        assert_eq!(
            urls[JSDELIVR_STYLE_HOSTS.len()],
            "https://raw.githack.com/RalfZhang/ink-city/main/src/data/cities.json"
        );
    }

    const ASSET: &str =
        "https://github.com/RalfZhang/ink-city/releases/download/v0.12.1/InkCity_universal.app.tar.gz";

    #[test]
    fn release_mirror_urls_tries_the_origin_first_then_every_relay() {
        let urls = release_mirror_urls(ASSET);
        assert_eq!(urls.len(), release_proxy_hosts().len() + 1);
        assert_eq!(urls[0], ASSET);
        // Derived from the list in force rather than naming a host, so
        // reordering `update-mirrors.json` can't fail this on a detail it
        // isn't testing — the join shape is what matters here.
        assert_eq!(urls[1], format!("{}/{ASSET}", release_proxy_hosts()[0]));
        // Every relay takes the whole URL, scheme included — that's the
        // convention they share, and dropping it yields a 404.
        for url in &urls[1..] {
            assert!(url.contains("/https://github.com/"));
        }
    }

    // The signature check that makes an untrusted relay acceptable is keyed to
    // the release *bundle*, so wrapping a URL these hosts don't proxy buys
    // nothing and loses the one route that worked.
    #[test]
    fn release_mirror_urls_leaves_a_non_github_url_alone() {
        for url in ["https://releases.example.com/latest.json", "not a url"] {
            assert_eq!(release_mirror_urls(url), [url]);
        }
    }

    /// The compiled-in list is the floor every install falls back to, and
    /// `baked_in_hosts` deliberately swallows a parse failure rather than
    /// crashing a user's app — so this is the check that a broken
    /// `update-mirrors.json` can't ship. It fails the build's test run instead.
    #[test]
    fn the_baked_in_mirror_list_is_usable() {
        let hosts = parse_mirror_list(BAKED_IN_MIRRORS).expect("compiled-in list must parse");
        assert!(!hosts.is_empty());
        assert_eq!(hosts, baked_in_hosts());
        // The `note` field is there for whoever edits this under pressure;
        // unknown keys must stay ignorable so it can never break the parse.
        assert!(BAKED_IN_MIRRORS.contains("\"note\""));
    }

    #[test]
    fn parse_mirror_list_drops_hosts_it_cannot_use() {
        let hosts = parse_mirror_list(
            r#"{"v":1,"hosts":[
                "https://good.example",
                "http://insecure.example",
                "not a url",
                "ftp://wrong-scheme.example",
                "https://trailing.example/"
            ]}"#,
        )
        .unwrap();
        // https only, and the trailing slash normalized off so the
        // `{host}/{url}` join doesn't produce a double slash.
        assert_eq!(hosts, ["https://good.example", "https://trailing.example"]);
    }

    /// Refusing an empty result is what makes a bad published list harmless:
    /// `set_release_proxies` propagates the error and the list already in force
    /// stays, rather than being replaced with nothing.
    #[test]
    fn parse_mirror_list_refuses_a_list_with_nothing_usable() {
        for json in [
            r#"{"v":1,"hosts":[]}"#,
            r#"{"v":1,"hosts":["http://only-insecure.example"]}"#,
            r#"{"v":1}"#,
            "not json at all",
        ] {
            assert!(parse_mirror_list(json).is_err(), "should be refused: {json}");
        }
    }

    #[test]
    fn parse_mirror_list_caps_the_number_of_hosts() {
        let many: Vec<String> = (0..40).map(|i| format!("\"https://h{i}.example\"")).collect();
        let json = format!(r#"{{"v":1,"hosts":[{}]}}"#, many.join(","));
        assert_eq!(parse_mirror_list(&json).unwrap().len(), MAX_MIRROR_HOSTS);
    }

    #[test]
    fn release_probe_targets_covers_the_origin_and_every_relay() {
        let targets = release_probe_targets();
        assert_eq!(targets.len(), release_proxy_hosts().len() + 1);
        assert_eq!(targets[0], "github.com:443");
        // Hosts, not URLs — the probe opens a socket, it doesn't fetch.
        for target in &targets {
            assert!(!target.contains("://"), "{target} is a URL, not a host:port");
            assert!(target.ends_with(":443"));
        }
        assert!(targets.contains(&"gh-proxy.com:443".to_string()));
    }

    // The fallback chain's shape is load-bearing (see `cdn::fetch_from_mirrors`):
    // every CDN edge is tried before anything GitHub-side, and the origin is last.
    #[test]
    fn mirror_urls_puts_every_cdn_edge_before_github() {
        let urls = mirror_urls("data", "osm-v2/data");
        let first_raw = urls.iter().position(|u| u.contains("raw.")).unwrap();
        assert_eq!(first_raw, JSDELIVR_STYLE_HOSTS.len());
        assert!(urls.last().unwrap().starts_with(GITHUB_RAW_HOST));
    }
}
