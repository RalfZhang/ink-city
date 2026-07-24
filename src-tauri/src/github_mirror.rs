use std::time::Duration;

use anyhow::Result;

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
pub const RAW_STYLE_HOSTS: &[&str] = &["https://raw.githack.com", "https://raw.githubusercontent.com"];

const USER_AGENT: &str = "InkCity/0.1";

/// HTTP client shared by all GitHub-mirror fetches.
pub fn client() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(60))
        .build()?)
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
