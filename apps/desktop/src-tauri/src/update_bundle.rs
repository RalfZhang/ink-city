//! Downloading the update bundle: resumable, mirror-walking, and verified.
//!
//! This replaces `tauri_plugin_updater::Update::download`, which is a poor fit
//! for a network where GitHub is unreliable in three separate ways:
//!
//!   • it fetches the one URL the manifest named, so a blocked release host is
//!     simply the end of the road;
//!   • it buffers the whole bundle with no `Range` request, so *any* failure —
//!     a reset at 60 MB of 70 — restarts from zero;
//!   • it sets no timeout at all, so a wedged socket hangs until the OS gives
//!     up minutes later.
//!
//! Resuming is what makes the rest work. Once partial progress survives, a host
//! that connects and then crawls costs nothing to abandon, so the first pass
//! over the mirror ladder can afford to be impatient about throughput — which
//! is the failure mode that actually strands users behind the Great Firewall,
//! where a route is far more often slow than closed.
//!
//! Resumable *within one call* only: the bytes live in memory, so quitting the
//! app mid-download still loses them. That is why `fetch` takes a `cancelled`
//! poll — quitting shouldn't be the only way out of a transfer the user has
//! changed their mind about.
//!
//! The request itself is otherwise the plugin's, `Accept` header included: that
//! is the request every relay in `github_mirror` was surveyed against.
//!
//! `Update::install` is still the plugin's job. But signature verification
//! lived *inside* the `download` we no longer call, so it has to happen here:
//! same minisign check, same pubkey from the same config (see `verify`). That
//! check is also what makes the untrusted relays in `github_mirror` admissible
//! at all, so it is not optional — `fetch` refuses to run without a pubkey
//! rather than hand back bytes nobody vouched for.
//!
//! "Untrusted" is taken literally: a relay may answer with anything, so nothing
//! a response claims is believed on its own. `decide` is where every claim is
//! checked, and it is a pure function precisely so those checks can be tested
//! without a network — a trust boundary that needs one is a boundary that
//! doesn't get tested.

use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use base64::Engine;
use minisign_verify::{PublicKey, Signature};
use reqwest::header::{ACCEPT, CONTENT_RANGE, RANGE};
use reqwest::StatusCode;
use tauri_plugin_updater::Update;

use crate::github_mirror;

/// How long a host gets before the first pass may judge its throughput. Long
/// enough to cover the TLS handshake and a slow start, short enough that a
/// crawling host doesn't eat the download.
const THROUGHPUT_GRACE: Duration = Duration::from_secs(20);

/// Throughput below which the first pass gives up on a host and tries the next.
/// Set well under any usable connection: this is meant to catch the 20-100 KB/s
/// trickle that a blocked route degrades to, not to shop around for the fastest
/// mirror. A user whose every route is that slow still gets the bundle — the
/// second pass drops this guard entirely.
const MIN_THROUGHPUT: u64 = 50 * 1024;

/// Smallest total that could be a real bundle. The smallest platform bundle is
/// ~35 MB and the macOS universal one ~70, so this is orders of magnitude clear
/// of a genuine size — it is here to catch a relay's error page, not to
/// validate a bundle.
const MIN_PLAUSIBLE_TOTAL: u64 = 1024 * 1024;

/// Hard ceiling for a response that never said how big it is. Nothing bounds a
/// response body but the body itself, and a host that streams forever would
/// otherwise grow the buffer until the OS kills the app.
const MAX_BUNDLE_BYTES: u64 = 512 * 1024 * 1024;

/// How many complete-but-unverifiable transfers to walk past before giving up.
/// Walking past them at all is what keeps one relay's convincing-looking error
/// body from ending the ladder; giving up soon is because each retry costs
/// another whole bundle over a link that is slow by definition.
const MAX_VERIFY_FAILURES: u32 = 2;

/// The verified bundle bytes, ready for `Update::install`.
///
/// Walks `github_mirror::release_mirror_urls` twice: once refusing to wait on a
/// host slower than `MIN_THROUGHPUT`, then once accepting whatever it can get.
/// Progress carries across every attempt in both passes, so the ladder costs
/// nothing to walk and no byte is fetched twice.
///
/// `on_progress` is called with (bytes so far, total if known) as chunks land.
/// It reports the *bundle's* progress, not one attempt's, so it never goes
/// backwards on a host switch — except where a host's bytes are discarded, in
/// which case they really are gone. Callers are expected to throttle their own
/// side of it; this fires per chunk (see `updates::set_download_progress`).
///
/// `cancelled` is polled per chunk and between hosts, so abandoning a
/// twenty-minute transfer doesn't require quitting the app.
pub async fn fetch(
    update: &Update,
    pubkey: &str,
    mut on_progress: impl FnMut(u64, Option<u64>) + Send,
    cancelled: impl Fn() -> bool + Send,
) -> Result<Vec<u8>> {
    if pubkey.trim().is_empty() {
        // Belt and braces: `updates::updater_pubkey` already treats a missing
        // key as fatal. Installing an unverified bundle is the one outcome this
        // module must never produce, so it's checked where the bytes are.
        return Err(anyhow!("refusing to download an update with no pubkey to verify it against"));
    }

    let candidates = github_mirror::release_mirror_urls(update.download_url.as_str());
    let client = github_mirror::download_client()?;

    let mut bundle = Bundle::default();
    let mut last_err = None;
    let mut verify_failures = 0;

    'ladder: for impatient in [true, false] {
        for url in &candidates {
            if cancelled() {
                return Err(anyhow!("download cancelled"));
            }
            match bundle.resume_from(&client, url, impatient, &mut on_progress, &cancelled).await {
                Ok(()) => {
                    log::info!(
                        "[updater] fetched {} ({} bytes) via {}",
                        update.version,
                        bundle.bytes.len(),
                        bundle.contributors.join(", ")
                    );
                    match bundle.take_verified(&update.signature, pubkey) {
                        Ok(bytes) => return Ok(bytes),
                        // Not the end of the road. A complete transfer that
                        // doesn't verify is far more often a host that served
                        // something else convincingly than a corrupted bundle,
                        // and the hosts after it may serve the real one — so
                        // keep walking, up to `MAX_VERIFY_FAILURES`.
                        Err(e) => {
                            log::warn!("[updater] {e}");
                            last_err = Some(e);
                            verify_failures += 1;
                            if verify_failures >= MAX_VERIFY_FAILURES {
                                break 'ladder;
                            }
                        }
                    }
                }
                Err(e) => {
                    log::warn!("[updater] {url} gave up at {} bytes: {e}", bundle.bytes.len());
                    last_err = Some(e);
                }
            }
        }
    }

    Err(last_err.unwrap_or_else(|| anyhow!("no usable download URL for {}", update.version)))
}

/// The bundle as it accumulates across hosts.
#[derive(Default)]
struct Bundle {
    bytes: Vec<u8>,
    /// Total size, once a host has told us. Also the guard against splicing two
    /// different artifacts together and the cap on how far the buffer may grow
    /// — see `resolved_total` and `resume_from`.
    total: Option<u64>,
    /// Hosts that contributed bytes, in order. Only ever read when verification
    /// fails, where "which mirrors did this come from" is the one thing a user's
    /// log needs to say.
    contributors: Vec<String>,
}

impl Bundle {
    /// Resume from wherever this bundle stopped, appending until the transfer is
    /// complete or gives up. Whatever arrived is kept unless `decide` says it
    /// can't be trusted — that's the point of the `Range` request, and what lets
    /// the next host carry on rather than start over.
    ///
    /// `Ok(())` means the bundle is complete.
    async fn resume_from(
        &mut self,
        client: &reqwest::Client,
        url: &str,
        impatient: bool,
        on_progress: &mut impl FnMut(u64, Option<u64>),
        cancelled: &impl Fn() -> bool,
    ) -> Result<()> {
        let offset = self.bytes.len() as u64;

        let mut request = client.get(url).header(ACCEPT, "application/octet-stream");
        if offset > 0 {
            request = request.header(RANGE, format!("bytes={offset}-"));
        }
        // Survives the origin's redirect to the signed
        // `release-assets.githubusercontent.com` URL: reqwest only strips
        // `Authorization`, `Cookie` and the two auth headers when a redirect
        // crosses hosts, so `Range` is carried through. Verified against the
        // origin and every relay — all six answer 206 with a `Content-Range`
        // naming the total.
        let mut response = request.send().await?;

        // Everything this response claims is vetted before a byte of its body
        // is kept, and the decision also says what happens to the bytes we
        // already hold.
        match decide(
            response.status(),
            response.headers().get(CONTENT_RANGE).and_then(|value| value.to_str().ok()),
            response.content_length(),
            offset,
            self.total,
        ) {
            Decision::Append { total } => self.total = total,
            Decision::Refill { total } => {
                self.discard();
                self.total = total;
            }
            Decision::Reject { reason, drop_held } => {
                if drop_held {
                    self.discard();
                }
                return Err(anyhow!("{reason} ({url})"));
            }
        }

        self.contributors.push(url.to_string());
        let started = Instant::now();
        let start_len = self.bytes.len();
        // The total a host committed to is the tightest available bound on how
        // far the buffer may grow; `MAX_BUNDLE_BYTES` covers a response that
        // never gave one.
        let cap = self.total.unwrap_or(MAX_BUNDLE_BYTES);

        while let Some(chunk) = response.chunk().await? {
            self.bytes.extend_from_slice(&chunk);
            // A host that keeps sending past what it promised is not serving the
            // bundle it said it was, and the bytes it already sent are no better
            // — so they go too, rather than becoming the next host's offset.
            if self.bytes.len() as u64 > cap {
                self.discard();
                return Err(anyhow!("{url} sent more than the {cap} bytes it promised"));
            }
            on_progress(self.bytes.len() as u64, self.total);

            // Polled here rather than raced against the transfer: a cancel that
            // lands mid-chunk is honoured on the next one, and what has arrived
            // is left alone in case the caller retries.
            if cancelled() {
                return Err(anyhow!("cancelled at {} bytes ({url})", self.bytes.len()));
            }

            // Checked per chunk rather than on a timer: there's no separate task
            // to tick one, and a transfer that has stopped delivering chunks is
            // already the client's `read_timeout` to catch.
            if impatient {
                let elapsed = started.elapsed();
                if elapsed >= THROUGHPUT_GRACE {
                    let rate = (self.bytes.len() - start_len) as u64 / elapsed.as_secs().max(1);
                    if rate < MIN_THROUGHPUT {
                        return Err(anyhow!("{rate} B/s is too slow while hosts are untried"));
                    }
                }
            }
        }

        // A truncated response — the stream ended early — reads as success here,
        // so compare against the total before believing it.
        match self.total {
            Some(total) if self.bytes.len() as u64 != total => {
                Err(anyhow!("got {} of {total} bytes ({url})", self.bytes.len()))
            }
            // No total means nothing to compare against, so this floor is all
            // that stands between a short error body and the signature check.
            // The bytes go with it: kept, they'd be the offset the next host is
            // asked to resume from.
            None if (self.bytes.len() as u64) < MIN_PLAUSIBLE_TOTAL => {
                let got = self.bytes.len();
                self.discard();
                Err(anyhow!("{got} bytes is too small to be a bundle ({url})"))
            }
            _ => Ok(()),
        }
    }

    /// Drop what we hold: the bytes, the hosts that gave them, and the total
    /// they were measured against.
    ///
    /// The total goes too, and that is the whole reason this is one method. A
    /// total is only ever discovered from a host that also served bytes, so a
    /// total worth keeping past those bytes doesn't exist — and keeping one
    /// would latch a wrong size and then reject every later host that reports
    /// the right one, failing a download that had a working route left.
    fn discard(&mut self) {
        self.bytes.clear();
        self.contributors.clear();
        self.total = None;
    }

    /// The bundle bytes, once they carry a signature made by our key.
    ///
    /// On failure the bytes are dropped so the caller can keep walking the
    /// ladder from a clean slate. The hosts are named first: with the size
    /// checks in `decide` already ruling out the obvious mismatches, a failure
    /// here means genuine corruption or a relay that lied convincingly, and the
    /// log is all anyone has to tell those apart.
    fn take_verified(&mut self, signature: &str, pubkey: &str) -> Result<Vec<u8>> {
        match verify(&self.bytes, signature, pubkey) {
            Ok(()) => Ok(std::mem::take(&mut self.bytes)),
            Err(e) => {
                let from = self.contributors.join(", ");
                self.discard();
                Err(anyhow!("bundle from [{from}] failed verification: {e}"))
            }
        }
    }
}

/// What a response may do with the bytes already held.
#[derive(Debug, PartialEq, Eq)]
enum Decision {
    /// Append this response's body to what we hold; `total` is the bundle size
    /// as it now stands, `None` while still unknown.
    Append { total: Option<u64> },
    /// Drop what we hold and refill from this response, which starts at byte
    /// zero — appending it would duplicate the prefix.
    Refill { total: Option<u64> },
    /// Nothing usable here. `drop_held` when what we hold can no longer be
    /// trusted as the offset a later host resumes from either.
    Reject { reason: String, drop_held: bool },
}

impl Decision {
    fn reject(reason: impl Into<String>, drop_held: bool) -> Self {
        Decision::Reject { reason: reason.into(), drop_held }
    }
}

/// Vet a response before any of its body is kept. `held` is what we already
/// have (and asked to resume from), `known_total` the bundle size established
/// so far.
fn decide(
    status: StatusCode,
    content_range: Option<&str>,
    content_length: Option<u64>,
    held: u64,
    known_total: Option<u64>,
) -> Decision {
    match status {
        // A 206 must say which bytes it is (RFC 9110), and we have to read it
        // rather than assume we got what we asked for: a response starting
        // anywhere other than `held` would splice misaligned bytes into the
        // middle of the bundle, which is the one corruption the size checks
        // cannot see. No header, or a start we didn't ask for, and what we hold
        // is no longer a safe offset for anyone.
        StatusCode::PARTIAL_CONTENT => {
            let Some(range) = parse_content_range(content_range) else {
                return Decision::reject("206 without a readable Content-Range", true);
            };
            if range.start != held {
                return Decision::reject(
                    format!("206 covers from {}, asked from {held}", range.start),
                    true,
                );
            }
            // The whole size only lives here on a 206 — `Content-Length`
            // describes the slice, not the bundle.
            match resolved_total(range.total, held, known_total) {
                Ok(total) => Decision::Append { total },
                Err(reason) => Decision::reject(reason, true),
            }
        }
        // `Range` ignored, or never sent: the whole file from byte zero. What we
        // hold is dropped rather than appended to, which also leaves nothing for
        // this response's total to contradict — so it stands on its own, subject
        // only to the floor.
        StatusCode::OK => match resolved_total(content_length, 0, known_total) {
            Ok(total) => Decision::Refill { total },
            Err(reason) => Decision::reject(reason, true),
        },
        // We asked past the end, so what we hold can't be right.
        StatusCode::RANGE_NOT_SATISFIABLE => {
            Decision::reject(format!("range from {held} rejected"), true)
        }
        // Nothing about this says the bytes we hold are wrong — this host just
        // didn't answer — so they stay for the next one to resume from.
        other => Decision::reject(format!("HTTP {other}"), false),
    }
}

/// The bundle total a response establishes, or why it can't extend what we hold.
///
/// Two checks, both about a host serving something other than what it was asked
/// for:
///
///   • A total too small to be a bundle. The relays' documented rot mode is a
///     200 with a short landing page or rate-limit notice, whose
///     `Content-Length` describes it perfectly — so without a floor the length
///     check at the end of the transfer calls that page a *complete* download
///     and hands it to the signature check.
///   • A total that disagrees with the one already established, which means one
///     of the two hosts is serving a different artifact and appending would
///     splice them together. Only checked while `held` is non-zero: with
///     nothing to splice onto there is nothing to protect, and a guard that
///     fired anyway would latch the first total ever reported and then reject
///     every host reporting the right one.
fn resolved_total(
    reported: Option<u64>,
    held: u64,
    known: Option<u64>,
) -> Result<Option<u64>, String> {
    if let Some(total) = reported {
        if total < MIN_PLAUSIBLE_TOTAL {
            return Err(format!("{total} bytes is too small to be a bundle"));
        }
    }
    if held == 0 {
        return Ok(reported);
    }
    match (known, reported) {
        (Some(known), Some(now)) if known != now => {
            Err(format!("reports {now} bytes, expected {known}"))
        }
        // A `*` total, or the same one again: keep what is already established.
        (Some(known), _) => Ok(Some(known)),
        _ => Ok(reported),
    }
}

/// What a `Content-Range: bytes <start>-<end>/<total>` header claims.
struct ContentRange {
    /// First byte of the slice — checked against the offset we asked for.
    start: u64,
    /// Size of the whole bundle. `None` for `*`, i.e. the host doesn't know.
    total: Option<u64>,
}

/// Parse a `Content-Range` value. `None` when it's absent or unreadable, which
/// callers treat as "don't trust this response" rather than as no constraint —
/// a resumed transfer has nothing else to check its alignment against.
fn parse_content_range(header: Option<&str>) -> Option<ContentRange> {
    let (range, total) = header?.trim().strip_prefix("bytes ")?.split_once('/')?;
    Some(ContentRange {
        start: range.split('-').next()?.trim().parse().ok()?,
        total: total.trim().parse().ok(),
    })
}

/// The minisign check `Update::download` would have run, replicated because we
/// no longer call it. Both the configured pubkey and the manifest's signature
/// are base64-encoded minisign *files* (comment line included), so each is
/// decoded to text before being parsed.
///
/// `allow_legacy` matches the plugin: the signatures we verify are the ones its
/// signer produces, so this has to accept exactly what it accepts.
fn verify(bytes: &[u8], signature: &str, pubkey: &str) -> Result<()> {
    let pubkey = PublicKey::decode(&decode_base64(pubkey).map_err(|e| anyhow!("pubkey: {e}"))?)
        .map_err(|e| anyhow!("undecodable pubkey: {e}"))?;
    let signature =
        Signature::decode(&decode_base64(signature).map_err(|e| anyhow!("signature: {e}"))?)
            .map_err(|e| anyhow!("undecodable signature: {e}"))?;
    pubkey.verify(bytes, &signature, true).map_err(|e| anyhow!("{e}"))
}

fn decode_base64(encoded: &str) -> Result<String> {
    let decoded = base64::engine::general_purpose::STANDARD.decode(encoded.trim())?;
    Ok(String::from_utf8(decoded)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A plausible bundle size — above `MIN_PLAUSIBLE_TOTAL`, and the real
    /// v0.12.1 Windows one.
    const TOTAL: u64 = 35_233_937;

    /// The real signing key, read from the shipped config the same way
    /// `updates::updater_pubkey` reads it at runtime — so this fails if the key
    /// is ever replaced with something minisign can't parse.
    fn configured_pubkey() -> String {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tauri.conf.json");
        let conf: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        conf.pointer("/plugins/updater/pubkey").unwrap().as_str().unwrap().to_string()
    }

    #[test]
    fn the_configured_pubkey_is_a_decodable_minisign_key() {
        let decoded = decode_base64(&configured_pubkey()).expect("base64");
        assert!(decoded.starts_with("untrusted comment:"), "not a minisign public key file");
        PublicKey::decode(&decoded).expect("minisign public key");
    }

    /// Verification has to *fail* on bytes our key didn't sign — this is the
    /// check that makes an untrusted relay safe to download from, so a stub
    /// that always returned `Ok` would quietly undo the whole design.
    #[test]
    fn verify_rejects_bytes_the_key_did_not_sign() {
        // v0.12.1's darwin signature, over a bundle these bytes are not.
        let signature = concat!(
            "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVSL2RGT0",
            "JGMm9tdEE2N2tQVzB3S25ITGtXYStWY3BEclBUL1pKbFNmNHpkdDJ1bTBrNnVXWE5WYmxXcDdaVUhk",
            "T1FkRWs5bHRLdDVCNUhtQWhaMHNCSHhGRldOOXR3dkFBPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdG",
            "FtcDoxNzg4NDc4MTcwCWZpbGU6SW5rQ2l0eS5hcHAudGFyLmd6CkNZUGhJT3EyYlNBRnRYWW4yTTlJ",
            "RG9UNG1oQjhJSDV1YjFiL2VXNHdVcmNkRHl4a2RZb21mekdMbzZETVF3YUowbWRPdFVIRFRlWVNwZX",
            "NVZkVWYUF3PT0K",
        );
        let err = verify(b"not the bundle", signature, &configured_pubkey()).unwrap_err();
        assert!(!err.to_string().is_empty());
    }

    #[test]
    fn verify_rejects_a_signature_that_is_not_base64() {
        let err = verify(b"x", "@@ not base64 @@", &configured_pubkey()).unwrap_err();
        assert!(err.to_string().contains("signature"), "unexpected error: {err}");
    }

    /// A failed verification has to leave nothing behind: `fetch` walks on to
    /// the next host, and bytes that didn't verify must not become the offset it
    /// resumes from.
    #[test]
    fn take_verified_discards_bytes_that_do_not_verify() {
        let mut bundle = Bundle {
            bytes: b"not the bundle".to_vec(),
            total: Some(TOTAL),
            contributors: vec!["https://relay.example".to_string()],
        };
        let err = bundle.take_verified("@@ not base64 @@", &configured_pubkey()).unwrap_err();
        assert!(err.to_string().contains("relay.example"), "should name the host: {err}");
        assert!(bundle.bytes.is_empty());
        assert_eq!(bundle.total, None);
    }

    /// The total goes with the bytes, and that is load-bearing: keeping a total
    /// across a discard latched the *first* size any host reported, so once one
    /// host reported a stale one every later host got rejected for reporting the
    /// right one — a download that failed with a working route still on the list.
    #[test]
    fn discard_forgets_the_total_along_with_the_bytes() {
        let mut bundle = Bundle {
            bytes: vec![1, 2, 3],
            total: Some(TOTAL),
            contributors: vec!["https://relay.example".to_string()],
        };
        bundle.discard();
        assert!(bundle.bytes.is_empty());
        assert!(bundle.contributors.is_empty());
        assert_eq!(bundle.total, None);
    }

    #[test]
    fn a_206_from_the_offset_we_asked_for_appends_and_learns_the_total() {
        let header = Some("bytes 1048576-1049599/35233937");
        assert_eq!(
            decide(StatusCode::PARTIAL_CONTENT, header, Some(1024), 1_048_576, None),
            Decision::Append { total: Some(TOTAL) }
        );
    }

    /// The one corruption no size check can see, so it is checked here.
    #[test]
    fn a_206_from_the_wrong_offset_is_rejected_and_the_held_bytes_go() {
        let header = Some("bytes 0-1023/35233937");
        assert_eq!(
            decide(StatusCode::PARTIAL_CONTENT, header, Some(1024), 1_048_576, Some(TOTAL)),
            Decision::reject("206 covers from 0, asked from 1048576", true)
        );
    }

    #[test]
    fn a_206_without_a_readable_range_is_rejected_and_the_held_bytes_go() {
        for header in [None, Some("nonsense"), Some("bytes */35233937")] {
            let decision =
                decide(StatusCode::PARTIAL_CONTENT, header, Some(1024), 1_048_576, Some(TOTAL));
            assert_eq!(
                decision,
                Decision::reject("206 without a readable Content-Range", true),
                "should not be trusted: {header:?}"
            );
        }
    }

    /// A `*` total tells us nothing new, and must not unlearn what we know.
    #[test]
    fn a_206_with_an_unknown_total_keeps_the_one_already_established() {
        let header = Some("bytes 1048576-1049599/*");
        assert_eq!(
            decide(StatusCode::PARTIAL_CONTENT, header, Some(1024), 1_048_576, Some(TOTAL)),
            Decision::Append { total: Some(TOTAL) }
        );
    }

    /// Two hosts reporting different sizes means one is serving a different
    /// artifact; appending would splice them into a bundle that can only fail
    /// verification, with nothing to say which host was at fault.
    #[test]
    fn a_206_whose_total_contradicts_ours_is_rejected_while_we_hold_bytes() {
        let header = Some("bytes 1048576-1049599/34000000");
        assert_eq!(
            decide(StatusCode::PARTIAL_CONTENT, header, Some(1024), 1_048_576, Some(TOTAL)),
            Decision::reject("reports 34000000 bytes, expected 35233937", true)
        );
    }

    /// The same disagreement with nothing held is not a disagreement at all:
    /// there is nothing to splice, so the new host's word stands. Checking it
    /// anyway is what let one stale relay fail the whole download.
    #[test]
    fn a_stale_total_does_not_outlive_the_bytes_it_came_with() {
        // A 200 refills from zero, so the total it reports always wins.
        assert_eq!(
            decide(StatusCode::OK, None, Some(TOTAL), 1_048_576, Some(34_000_000)),
            Decision::Refill { total: Some(TOTAL) }
        );
        // And a 206 at offset zero is judged the same way.
        assert_eq!(
            decide(StatusCode::PARTIAL_CONTENT, Some("bytes 0-1023/35233937"), None, 0, Some(34)),
            Decision::Append { total: Some(TOTAL) }
        );
    }

    /// The relays' documented rot mode: a 200 whose `Content-Length` honestly
    /// describes a landing page. Without the floor the transfer completes, the
    /// length check calls it whole, and the signature check gets a page of HTML.
    #[test]
    fn a_total_too_small_to_be_a_bundle_is_rejected() {
        assert_eq!(
            decide(StatusCode::OK, None, Some(4096), 0, None),
            Decision::reject("4096 bytes is too small to be a bundle", true)
        );
        assert_eq!(
            decide(StatusCode::PARTIAL_CONTENT, Some("bytes 0-4095/4096"), None, 0, None),
            Decision::reject("4096 bytes is too small to be a bundle", true)
        );
    }

    #[test]
    fn a_200_refills_because_appending_would_duplicate_the_prefix() {
        assert_eq!(
            decide(StatusCode::OK, None, Some(TOTAL), 1_048_576, Some(TOTAL)),
            Decision::Refill { total: Some(TOTAL) }
        );
    }

    #[test]
    fn a_416_means_the_bytes_we_hold_are_wrong() {
        assert_eq!(
            decide(StatusCode::RANGE_NOT_SATISFIABLE, None, None, 1_048_576, Some(TOTAL)),
            Decision::reject("range from 1048576 rejected", true)
        );
    }

    /// Any other status says nothing about the bytes we hold — this host just
    /// didn't answer — so they survive for the next host to resume from.
    #[test]
    fn any_other_status_leaves_the_held_bytes_alone() {
        for status in [StatusCode::NOT_FOUND, StatusCode::TOO_MANY_REQUESTS, StatusCode::FORBIDDEN]
        {
            match decide(status, None, None, 1_048_576, Some(TOTAL)) {
                Decision::Reject { drop_held, .. } => assert!(!drop_held, "{status} dropped them"),
                other => panic!("{status} should be rejected, got {other:?}"),
            }
        }
    }

    /// The real header shape, taken from what the origin and all five relays
    /// actually answered for `Range: bytes=1048576-1049599` on v0.12.1's .exe.
    #[test]
    fn parse_content_range_reads_the_start_and_the_total() {
        let range = parse_content_range(Some("bytes 1048576-1049599/35233937")).unwrap();
        assert_eq!(range.start, 1048576);
        assert_eq!(range.total, Some(35233937));
    }

    #[test]
    fn parse_content_range_leaves_an_unknown_total_unknown() {
        // `*` must not parse as a size — it feeds the guard against splicing
        // two different artifacts, which would rather know nothing than guess.
        let range = parse_content_range(Some("bytes 200-1000/*")).unwrap();
        assert_eq!(range.start, 200);
        assert_eq!(range.total, None);
    }

    /// Unreadable means "don't trust this response": a resumed transfer has
    /// nothing but this header to check its alignment against, so anything the
    /// parser can't vouch for has to read as absent.
    #[test]
    fn parse_content_range_rejects_what_it_cannot_read() {
        for header in [
            Some("nonsense"),
            Some("bytes */35233937"), // no start to align to
            Some("items 0-1/2"),      // not a byte range
            Some("0-1/2"),            // missing the unit
            None,
        ] {
            assert!(parse_content_range(header).is_none(), "should not parse: {header:?}");
        }
    }
}
