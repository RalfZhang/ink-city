//! Where the app's requests go — the Proxy setting's three modes — and General's
//! "Test connection".
//!
//! The route is process-wide state rather than something each caller reads off
//! `AppState`: the fetchers (`github_mirror`'s clients, the sidecar's environment)
//! have no `AppState` handle, and there is one proxy for the whole app. `System`
//! isn't a URL but a lookup, made again as the OS's settings change (a proxy app
//! switched on or off mid-session), so it's resolved at every use through a short
//! cache (`system`).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock, RwLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::config::ProxyMode;

/// The route requests take now. Set at launch from the persisted config and again
/// whenever the user changes the setting (`commands::apply_proxy_settings`).
static ROUTE: RwLock<Route> = RwLock::new(Route::Off);

/// How long a read of the OS's proxy settings is trusted. Long enough that a burst
/// of fetches costs one read (on macOS it's a `scutil` run), short enough that a
/// proxy switched on mid-session is picked up by the next update.
const SYSTEM_TTL: Duration = Duration::from_secs(30);
static SYSTEM: Mutex<Option<(Instant, Option<String>)>> = Mutex::new(None);
/// A read of the OS's settings is under way on its own thread (`refresh`).
static REFRESHING: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Route {
    /// No proxy of the app's own.
    Off,
    /// Whatever the OS is set to, looked up at use (`system`).
    System,
    /// The user's URL, trimmed and non-empty.
    Custom(String),
}

impl Route {
    /// The route a setting asks for. A custom mode with no address is no proxy at
    /// all — the UI only applies a valid one, but an empty URL must never reach
    /// reqwest as a proxy.
    pub fn from_setting(mode: ProxyMode, url: &str) -> Self {
        match mode {
            ProxyMode::Off => Route::Off,
            ProxyMode::System => Route::System,
            ProxyMode::Custom => match url.trim() {
                "" => Route::Off,
                u => Route::Custom(u.to_string()),
            },
        }
    }

    /// The proxy URL this route uses right now, or `None` for none of the app's own.
    pub fn url(&self) -> Option<String> {
        match self {
            Route::Off => None,
            Route::System => system(),
            Route::Custom(u) => Some(u.clone()),
        }
    }
}

pub fn set(route: Route) {
    // Read the OS's settings ahead of the first fetch that needs them, off the
    // fetchers' threads (`system`).
    if route == Route::System && SYSTEM.lock().unwrap().is_none() {
        refresh();
    }
    *ROUTE.write().unwrap() = route;
}

/// The proxy URL requests should go through right now — see `Route::url`.
pub fn current() -> Option<String> {
    let route = ROUTE.read().unwrap().clone();
    route.url()
}

/// The OS's proxy as a URL reqwest and the sidecar both take (`http://host:port`
/// or `socks5h://host:port`), or `None` when it has none set. Cached for
/// `SYSTEM_TTL`.
///
/// Reading the settings runs a subprocess (`scutil`; up to seven `gsettings` on
/// Linux), and this is called from async fetches, so it never waits on one: a stale
/// answer is handed back as it is while a fresh one is read on a thread of its own,
/// for the call after. Only a call before anything has been read at all — before
/// `set`'s own read lands — reads the settings itself.
pub fn system() -> Option<String> {
    let cached = SYSTEM.lock().unwrap().clone();
    let Some((at, url)) = cached else { return system_now() };
    if at.elapsed() >= SYSTEM_TTL {
        refresh();
    }
    url
}

/// Read the OS's settings into the cache on a thread of its own, unless a read is
/// already under way. A subprocess that hangs holds up only that thread — and the
/// refreshes after it: the cache keeps its last answer.
fn refresh() {
    if REFRESHING.swap(true, Ordering::AcqRel) {
        return;
    }
    let spawned = std::thread::Builder::new().name("proxy-lookup".into()).spawn(|| {
        system_now();
        REFRESHING.store(false, Ordering::Release);
    });
    if let Err(e) = spawned {
        log::warn!("[proxy] couldn't read the system proxy: {e}");
        REFRESHING.store(false, Ordering::Release);
    }
}

/// `system` without the cache: what General shows next to the System choice, which
/// should be the OS's setting as it is the moment the user looks.
pub fn system_now() -> Option<String> {
    let url = detect();
    *SYSTEM.lock().unwrap() = Some((Instant::now(), url.clone()));
    url
}

/// macOS: the network settings as `scutil --proxy` prints them — HTTPS first, the
/// one every fetch here uses, then HTTP, then SOCKS.
#[cfg(target_os = "macos")]
fn detect() -> Option<String> {
    let out = std::process::Command::new("/usr/sbin/scutil").arg("--proxy").output().ok()?;
    if !out.status.success() {
        return None;
    }
    parse_scutil(&String::from_utf8_lossy(&out.stdout))
}

/// Windows: Internet Options, which the registry keeps per user — `ProxyEnable`, and
/// `ProxyServer` as either `host:port` for every scheme or a `scheme=host:port` list.
#[cfg(target_os = "windows")]
fn detect() -> Option<String> {
    use std::ffi::c_void;
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD, RRF_RT_REG_SZ};

    let wide = |s: &str| -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() };
    let key = wide(r"Software\Microsoft\Windows\CurrentVersion\Internet Settings");

    let enable = wide("ProxyEnable");
    let mut on: u32 = 0;
    let mut size = std::mem::size_of::<u32>() as u32;
    // SAFETY: every pointer is to a live local, and `size` is `on`'s byte length.
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            enable.as_ptr(),
            RRF_RT_REG_DWORD,
            std::ptr::null_mut(),
            &mut on as *mut u32 as *mut c_void,
            &mut size,
        )
    };
    if status != ERROR_SUCCESS || on == 0 {
        return None;
    }

    let server = wide("ProxyServer");
    let mut buf = vec![0u16; 1024];
    let mut size = (buf.len() * 2) as u32;
    // SAFETY: as above; `size` is the buffer's byte length, which RegGetValueW won't exceed.
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            server.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            buf.as_mut_ptr() as *mut c_void,
            &mut size,
        )
    };
    if status != ERROR_SUCCESS {
        return None;
    }
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    parse_windows_server(&String::from_utf16_lossy(&buf[..len]))
}

/// Linux: the environment's `https_proxy` and kin, which is how most desktops hand
/// their proxy to the programs they start — one in a scheme the app can't use passed
/// over for the next (`with_scheme`); failing that, GNOME's own setting.
#[cfg(target_os = "linux")]
fn detect() -> Option<String> {
    for var in ["https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY", "http_proxy", "HTTP_PROXY"] {
        if let Ok(v) = std::env::var(var) {
            if let Some(url) = with_scheme(v.trim(), "http") {
                return Some(url);
            }
        }
    }
    gnome_proxy()
}

#[cfg(target_os = "linux")]
fn gnome_proxy() -> Option<String> {
    let get = |schema: &str, key: &str| -> Option<String> {
        let out = std::process::Command::new("gsettings").args(["get", schema, key]).output().ok()?;
        out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().trim_matches('\'').to_string())
    };
    if get("org.gnome.system.proxy", "mode")? != "manual" {
        return None;
    }
    for (schema, scheme) in [("org.gnome.system.proxy.https", "http"), ("org.gnome.system.proxy.http", "http"), ("org.gnome.system.proxy.socks", SYSTEM_SOCKS)] {
        let host = get(schema, "host").unwrap_or_default();
        let port = get(schema, "port").and_then(|p| p.parse::<u16>().ok()).unwrap_or(0);
        if !host.is_empty() && port != 0 {
            return Some(format!("{scheme}://{host}:{port}"));
        }
    }
    None
}

/// `scutil --proxy`'s dictionary: `HTTPSEnable : 1`, `HTTPSProxy : host`,
/// `HTTPSPort : 7890`, and the same for HTTP and SOCKS.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_scutil(text: &str) -> Option<String> {
    let value = |key: &str| -> Option<&str> {
        text.lines().find_map(|l| {
            let (k, v) = l.split_once(" : ")?;
            (k.trim() == key).then(|| v.trim())
        })
    };
    for (prefix, scheme) in [("HTTPS", "http"), ("HTTP", "http"), ("SOCKS", SYSTEM_SOCKS)] {
        if value(&format!("{prefix}Enable")) != Some("1") {
            continue;
        }
        let host = value(&format!("{prefix}Proxy")).unwrap_or("");
        let port = value(&format!("{prefix}Port")).and_then(|p| p.parse::<u16>().ok());
        if let (false, Some(port)) = (host.is_empty(), port) {
            return Some(format!("{scheme}://{host}:{port}"));
        }
    }
    None
}

/// Internet Options' `ProxyServer`: `host:port`, or `http=host:port;https=…;socks=…`.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn parse_windows_server(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    if !raw.contains('=') {
        return with_scheme(raw, "http");
    }
    let entry = |name: &str| {
        raw.split(';').find_map(|part| {
            let (k, v) = part.split_once('=')?;
            (k.trim().eq_ignore_ascii_case(name)).then(|| v.trim())
        })
    };
    if let Some(v) = entry("https").or_else(|| entry("http")) {
        return with_scheme(v, "http");
    }
    entry("socks").and_then(|v| with_scheme(v, SYSTEM_SOCKS))
}

/// The scheme a SOCKS proxy set in the OS's settings is used in: SOCKS5 with the
/// proxy resolving names, as the OS's own apps use it. Resolved here instead, a name
/// a poisoned resolver answers falsely is dialled at the false address — the proxy
/// working in the browser and failing in the app.
const SYSTEM_SOCKS: &str = "socks5h";

/// `raw` as a URL the app can route through: with `scheme` when it names none, and
/// otherwise only in a scheme it can use (`usable`).
fn with_scheme(raw: &str, scheme: &str) -> Option<String> {
    match raw {
        "" => None,
        r if r.contains("://") => usable(r),
        r => Some(format!("{scheme}://{r}")),
    }
}

/// `url` if both reqwest and the sidecar's route (`socks_bridge`) can take it, its
/// scheme lower-cased as `socks_bridge::is_socks` reads it: HTTP(S) and SOCKS5 as
/// they are, and `socks://` — no version named, as `all_proxy` often has it — as
/// `SYSTEM_SOCKS`, the version every local proxy speaks. Anything else (`socks4://`)
/// is `None`, so the next place a proxy may be set is looked at instead.
fn usable(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    match scheme.to_ascii_lowercase().as_str() {
        s @ ("http" | "https" | "socks5" | "socks5h") => Some(format!("{s}://{rest}")),
        "socks" => Some(format!("{SYSTEM_SOCKS}://{rest}")),
        _ => {
            log::warn!("[proxy] passing over a system proxy in a scheme the app can't use: {url}");
            None
        }
    }
}

/// One leg of "Test connection": how a request to one of the services the app
/// relies on went, through the route under test.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    /// `cdn` (the published map data), `github` (updates) or `overpass` (live maps).
    pub target: &'static str,
    pub ok: bool,
    /// How long the answer took, ms — or how long it was waited for.
    pub ms: u64,
    /// Why it failed: `proxy` (the proxy itself didn't answer), `timeout`, `status`
    /// (the service answered with an error) or `network`.
    pub reason: Option<&'static str>,
    /// The error as reqwest put it, for the log and the tooltip.
    pub detail: Option<String>,
}

const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
const PROXY_CONNECT_TIMEOUT: Duration = Duration::from_secs(3);

/// The Overpass servers live maps are fetched from, in the order a fetch tries them:
/// the list the TypeScript client reads (packages/core/src/overpass.json), compiled in.
fn overpass_mirrors() -> &'static [String] {
    #[derive(Deserialize)]
    struct Table {
        mirrors: Vec<String>,
    }
    static MIRRORS: OnceLock<Vec<String>> = OnceLock::new();
    MIRRORS.get_or_init(|| {
        serde_json::from_str::<Table>(include_str!("../../../../packages/core/src/overpass.json"))
            .expect("bundled overpass.json invalid")
            .mirrors
    })
}

/// A server's status page, from its interpreter's URL: a cheap GET that runs no query.
fn status_url(interpreter: &str) -> String {
    match interpreter.strip_suffix("/interpreter") {
        Some(base) => format!("{base}/status"),
        None => interpreter.to_string(),
    }
}

/// Try the three services through `proxy` — the address typed in, applied or not;
/// `None` for none — at the same time, as the app would reach them: each down the
/// whole ladder its fetches go down, so a leg fails only when the app's own requests
/// would. The CDN hosts the day's map comes from (`mirror_urls`), the update
/// manifest at GitHub and its relays (`release_mirror_urls`), and the Overpass
/// servers live maps are fetched from. A proxy that doesn't take connections at all
/// fails every leg as `proxy`, which says more than three timeouts would.
pub async fn test(proxy: Option<String>) -> Vec<Probe> {
    const TARGETS: [&str; 3] = ["cdn", "github", "overpass"];
    let refused = |detail: String| -> Vec<Probe> {
        TARGETS
            .iter()
            .map(|&target| Probe { target, ok: false, ms: 0, reason: Some("proxy"), detail: Some(detail.clone()) })
            .collect()
    };
    if let Some(url) = proxy.as_deref() {
        if let Err(e) = reach_proxy(url).await {
            return refused(e);
        }
    }
    let client = match build_client(proxy.as_deref()) {
        Ok(c) => c,
        Err(e) => return refused(e.to_string()),
    };
    let cdn = crate::github_mirror::mirror_urls("client/update-mirrors.json");
    // What the updater reads first: the relays only carry release downloads, so a
    // page of the repo's own would fail through them while updates go through.
    let github = crate::github_mirror::release_mirror_urls(&format!(
        "https://{}/{}/releases/latest/download/latest.json",
        crate::github_mirror::RELEASE_ORIGIN_HOST,
        crate::github_mirror::table().repo
    ));
    let overpass: Vec<String> = overpass_mirrors().iter().map(|m| status_url(m)).collect();
    let (a, b, c) = tokio::join!(
        probe_any(&client, "cdn", &cdn),
        probe_any(&client, "github", &github),
        probe_any(&client, "overpass", &overpass),
    );
    vec![a, b, c]
}

/// The app's own client, through `proxy` — refused when it isn't a proxy URL, which
/// the app's fetches would only skip (`github_mirror::proxied_builder`).
fn build_client(proxy: Option<&str>) -> reqwest::Result<reqwest::Client> {
    let mut builder = crate::github_mirror::base_builder().timeout(PROBE_TIMEOUT);
    if let Some(url) = proxy {
        builder = builder.proxy(reqwest::Proxy::all(url)?);
    }
    builder.build()
}

/// A URL's host as a socket address takes it: an IPv6 literal without the brackets
/// a URL wraps it in (`[::1]` → `::1`), which `TcpStream::connect` won't resolve.
pub fn connect_host(url: &reqwest::Url) -> Option<String> {
    url.host_str().map(|h| h.trim_start_matches('[').trim_end_matches(']').to_string())
}

/// Whether anything takes connections where `url` says the proxy is.
async fn reach_proxy(url: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| e.to_string())?;
    let host = connect_host(&parsed).ok_or("no host")?;
    let port = parsed.port().unwrap_or(match parsed.scheme() {
        "https" => 443,
        "socks5" | "socks5h" => 1080,
        _ => 80,
    });
    match tokio::time::timeout(PROXY_CONNECT_TIMEOUT, tokio::net::TcpStream::connect((host.as_str(), port))).await {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => Err("timed out".into()),
    }
}

async fn probe(client: &reqwest::Client, target: &'static str, url: &str) -> Probe {
    let start = Instant::now();
    let result = client.get(url).send().await;
    let ms = start.elapsed().as_millis() as u64;
    match result {
        // Any answer is the service reached; only its own failure counts against it.
        Ok(resp) if !resp.status().is_server_error() => Probe { target, ok: true, ms, reason: None, detail: None },
        Ok(resp) => Probe { target, ok: false, ms, reason: Some("status"), detail: Some(resp.status().to_string()) },
        Err(e) => Probe {
            target,
            ok: false,
            ms,
            reason: Some(if e.is_timeout() { "timeout" } else { "network" }),
            detail: Some(e.to_string()),
        },
    }
}

/// One leg tried at every server that can serve it, all at once — the servers a
/// fetch goes down in turn until one answers. So it passes as
/// soon as any of them answers (naming it, for the tooltip), and fails only when
/// none does: timed out if they all did, otherwise for the first one's own reason.
async fn probe_any(client: &reqwest::Client, target: &'static str, urls: &[String]) -> Probe {
    let mut legs = tokio::task::JoinSet::new();
    for (i, url) in urls.iter().enumerate() {
        let (client, url) = (client.clone(), url.clone());
        legs.spawn(async move { (i, host_of(&url), probe(&client, target, &url).await) });
    }
    let mut failed = Vec::new();
    while let Some(joined) = legs.join_next().await {
        let Ok((i, host, p)) = joined else { continue };
        if p.ok {
            // The rest are dropped with the set, which aborts them.
            return Probe { detail: Some(host), ..p };
        }
        failed.push((i, host, p));
    }
    failed.sort_by_key(|(i, ..)| *i);
    let ms = failed.iter().map(|(_, _, p)| p.ms).max().unwrap_or(0);
    let detail = failed
        .iter()
        .map(|(_, host, p)| format!("{host}: {}", p.detail.as_deref().unwrap_or("failed")))
        .collect::<Vec<_>>()
        .join("\n");
    let reason = if failed.iter().all(|(_, _, p)| p.reason == Some("timeout")) {
        Some("timeout")
    } else {
        failed.iter().map(|(_, _, p)| p.reason).find(|r| *r != Some("timeout")).flatten()
    };
    Probe { target, ok: false, ms, reason: reason.or(Some("network")), detail: Some(detail) }
}

/// `url`'s host, for naming a server in a tooltip.
fn host_of(url: &str) -> String {
    reqwest::Url::parse(url).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_else(|| url.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connect_host_unwraps_an_ipv6_literal() {
        let host = |u: &str| connect_host(&reqwest::Url::parse(u).unwrap());
        assert_eq!(host("http://[::1]:7890").as_deref(), Some("::1"));
        assert_eq!(host("socks5://127.0.0.1:1086").as_deref(), Some("127.0.0.1"));
        assert_eq!(host("http://proxy.example:8080").as_deref(), Some("proxy.example"));
    }

    #[test]
    fn the_overpass_test_reaches_every_server_a_fetch_would() {
        let mirrors = overpass_mirrors();
        assert!(mirrors.len() > 1, "a fetch has servers to fall back on");
        for m in mirrors {
            assert!(m.starts_with("https://") && m.ends_with("/api/interpreter"), "{m}");
            assert_eq!(status_url(m), format!("{}/api/status", m.trim_end_matches("/api/interpreter")));
        }
    }

    #[test]
    fn a_custom_route_needs_an_address() {
        assert_eq!(Route::from_setting(ProxyMode::Custom, "  "), Route::Off);
        assert_eq!(
            Route::from_setting(ProxyMode::Custom, " http://127.0.0.1:7890 "),
            Route::Custom("http://127.0.0.1:7890".into())
        );
        assert_eq!(Route::from_setting(ProxyMode::Off, "http://127.0.0.1:7890"), Route::Off);
        assert_eq!(Route::from_setting(ProxyMode::System, ""), Route::System);
    }

    #[test]
    fn reads_scutils_https_proxy_first() {
        let text = "<dictionary> {\n  HTTPEnable : 1\n  HTTPPort : 8080\n  HTTPProxy : 10.0.0.1\n  HTTPSEnable : 1\n  HTTPSPort : 7890\n  HTTPSProxy : 127.0.0.1\n  SOCKSEnable : 0\n}";
        assert_eq!(parse_scutil(text).as_deref(), Some("http://127.0.0.1:7890"));
    }

    #[test]
    fn falls_back_to_scutils_socks_proxy() {
        let text = "<dictionary> {\n  HTTPEnable : 0\n  HTTPSEnable : 0\n  SOCKSEnable : 1\n  SOCKSPort : 1080\n  SOCKSProxy : 127.0.0.1\n}";
        assert_eq!(parse_scutil(text).as_deref(), Some("socks5h://127.0.0.1:1080"));
        assert_eq!(parse_scutil("<dictionary> {\n  HTTPEnable : 0\n}"), None);
    }

    #[test]
    fn reads_both_shapes_of_windows_proxy_server() {
        assert_eq!(parse_windows_server("127.0.0.1:7890").as_deref(), Some("http://127.0.0.1:7890"));
        assert_eq!(
            parse_windows_server("http=10.0.0.1:80;https=127.0.0.1:7890;socks=127.0.0.1:1080").as_deref(),
            Some("http://127.0.0.1:7890")
        );
        assert_eq!(parse_windows_server("socks=127.0.0.1:1080").as_deref(), Some("socks5h://127.0.0.1:1080"));
        assert_eq!(parse_windows_server(""), None);
    }

    #[test]
    fn takes_a_system_proxy_only_in_a_scheme_the_app_can_route_through() {
        let url = |raw: &str| with_scheme(raw, "http");
        assert_eq!(url("127.0.0.1:7890").as_deref(), Some("http://127.0.0.1:7890"));
        assert_eq!(url("HTTP://10.0.0.1:8080").as_deref(), Some("http://10.0.0.1:8080"));
        assert_eq!(url("socks5://127.0.0.1:1080").as_deref(), Some("socks5://127.0.0.1:1080"));
        // `all_proxy`'s versionless SOCKS: the bridge's, and the proxy's to resolve.
        assert_eq!(url("socks://127.0.0.1:1080/").as_deref(), Some("socks5h://127.0.0.1:1080/"));
        assert_eq!(url("socks4://127.0.0.1:1080"), None);
        assert_eq!(url(""), None);
        for taken in ["http://127.0.0.1:7890", "socks5h://127.0.0.1:1080/"] {
            assert!(reqwest::Proxy::all(taken).is_ok(), "{taken}");
        }
        assert!(crate::socks_bridge::is_socks("socks5h://127.0.0.1:1080/"));
    }
}
