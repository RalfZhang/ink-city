use std::sync::RwLock;
use std::time::Duration;

use anyhow::Result;

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

const USER_AGENT: &str = "InkCity/0.1";

/// HTTP client shared by all GitHub-mirror fetches. Applies the configured proxy
/// (see `set_proxy`) when set. An invalid proxy URL is logged and skipped rather
/// than propagated, so a bad setting degrades to a direct connection instead of
/// breaking every fetch.
pub fn client() -> Result<reqwest::Client> {
    let mut builder = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(60));
    if let Some(url) = PROXY.read().unwrap().as_ref() {
        match reqwest::Proxy::all(url) {
            Ok(proxy) => builder = builder.proxy(proxy),
            Err(e) => log::warn!("[proxy] ignoring invalid proxy URL {:?}: {}", url, e),
        }
    }
    Ok(builder.build()?)
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
