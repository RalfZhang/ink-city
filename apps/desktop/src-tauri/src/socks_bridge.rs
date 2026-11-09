//! A local HTTP proxy in front of a SOCKS5 one, for the sidecar.
//!
//! The sidecar is a compiled Bun binary, and Bun's `fetch` takes HTTP(S) proxies
//! only: handed a `socks5://` route it fails every request (UnsupportedProxyProtocol)
//! — the route System mode picks by itself when the OS has only a SOCKS proxy set.
//! So a SOCKS route reaches the sidecar as this instead: a listener on 127.0.0.1
//! that answers HTTP `CONNECT host:port` by opening that connection through the
//! SOCKS proxy, then relays bytes both ways. Every Overpass server is https
//! (packages/core/src/overpass.json), so CONNECT is all it has to speak. It lives
//! as long as the sidecar run it was started for (`osm_sidecar::fetch`).
//!
//! Names are resolved as reqwest resolves them for the same route, so "Test
//! connection" tests what the sidecar does: here for `socks5://`, by the proxy for
//! `socks5h://`.

use std::net::IpAddr;
use std::sync::Arc;

use anyhow::{anyhow, bail, Context, Result};
use tokio::io::{copy_bidirectional, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;

/// The most a CONNECT request's head may take, in bytes: a request line and a few
/// headers. Anything longer isn't one.
const MAX_HEAD: usize = 8 * 1024;

/// A running bridge. Dropping it stops taking connections; any open one ends when
/// either side closes it.
pub struct Bridge {
    /// The HTTP proxy to hand the sidecar: `http://127.0.0.1:<port>`.
    pub url: String,
    accept: JoinHandle<()>,
}

impl Drop for Bridge {
    fn drop(&mut self) {
        self.accept.abort();
    }
}

/// Whether `route` is a SOCKS5 proxy URL, which the sidecar can't take as it is.
pub fn is_socks(route: &str) -> bool {
    route.starts_with("socks5://") || route.starts_with("socks5h://")
}

/// Start a bridge into the SOCKS5 proxy at `route` (`socks5://[user:pass@]host[:port]`
/// or `socks5h://…`).
pub async fn start(route: &str) -> Result<Bridge> {
    let socks = Arc::new(Socks::parse(route).ok_or_else(|| anyhow!("not a SOCKS5 proxy URL: {route}"))?);
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.context("can't open the local proxy for the SOCKS route")?;
    let port = listener.local_addr()?.port();
    let accept = tokio::spawn(async move {
        while let Ok((client, _)) = listener.accept().await {
            let socks = socks.clone();
            tokio::spawn(async move {
                if let Err(e) = serve(client, &socks).await {
                    log::warn!("[proxy] SOCKS bridge: {e:#}");
                }
            });
        }
    });
    Ok(Bridge { url: format!("http://127.0.0.1:{port}"), accept })
}

/// The SOCKS5 proxy a route names.
#[derive(Debug, PartialEq)]
struct Socks {
    host: String,
    port: u16,
    auth: Option<(String, String)>,
    /// `socks5h`: the proxy resolves names. `socks5`: they're resolved here.
    remote_dns: bool,
}

impl Socks {
    fn parse(route: &str) -> Option<Self> {
        let url = reqwest::Url::parse(route).ok()?;
        let remote_dns = match url.scheme() {
            "socks5" => false,
            "socks5h" => true,
            _ => return None,
        };
        let host = crate::proxy::connect_host(&url)?;
        let auth = (!url.username().is_empty())
            .then(|| (percent_decode(url.username()), percent_decode(url.password().unwrap_or(""))));
        Some(Self { host, port: url.port().unwrap_or(1080), auth, remote_dns })
    }
}

/// `%XX` escapes decoded, as a URL's user and password carry them.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = bytes.get(i + 1..i + 3).and_then(|h| std::str::from_utf8(h).ok()).and_then(|h| u8::from_str_radix(h, 16).ok());
        match (bytes[i], hex) {
            (b'%', Some(b)) => {
                out.push(b);
                i += 3;
            }
            (b, _) => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// One connection from the sidecar: its CONNECT, opened through the SOCKS proxy,
/// then relayed.
async fn serve(mut client: TcpStream, socks: &Socks) -> Result<()> {
    let (head, early) = read_head(&mut client).await?;
    let Some((host, port)) = connect_target(&head) else {
        let _ = client.write_all(b"HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\n\r\n").await;
        bail!("only CONNECT goes through: {}", head.lines().next().unwrap_or(""));
    };
    let mut upstream = match dial(socks, &host, port).await {
        Ok(s) => s,
        Err(e) => {
            let _ = client.write_all(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n").await;
            return Err(e);
        }
    };
    client.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n").await?;
    // Whatever came in behind the head (a client that didn't wait for the 200).
    if !early.is_empty() {
        upstream.write_all(&early).await?;
    }
    copy_bidirectional(&mut client, &mut upstream).await?;
    Ok(())
}

/// Read a request's head, up to its blank line: the head, and any bytes after it.
async fn read_head(s: &mut (impl AsyncRead + Unpin)) -> Result<(String, Vec<u8>)> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        if let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            let early = buf.split_off(end + 4);
            return Ok((String::from_utf8_lossy(&buf).into_owned(), early));
        }
        if buf.len() > MAX_HEAD {
            bail!("a request head over {MAX_HEAD} bytes");
        }
        let n = s.read(&mut chunk).await?;
        if n == 0 {
            bail!("the connection closed before its request was in");
        }
        buf.extend_from_slice(&chunk[..n]);
    }
}

/// The `host` and `port` of a `CONNECT host:port HTTP/1.1` request line, or `None`
/// for any other request. An IPv6 host comes bracketed (`[::1]:443`).
fn connect_target(head: &str) -> Option<(String, u16)> {
    let mut parts = head.lines().next()?.split_whitespace();
    if !parts.next()?.eq_ignore_ascii_case("CONNECT") {
        return None;
    }
    let (host, port) = parts.next()?.rsplit_once(':')?;
    let host = host.trim_start_matches('[').trim_end_matches(']');
    if host.is_empty() {
        return None;
    }
    Some((host.to_string(), port.parse().ok()?))
}

/// Open a connection to `host:port` through the SOCKS5 proxy (RFC 1928, with
/// RFC 1929's username and password when the route has them).
async fn dial(socks: &Socks, host: &str, port: u16) -> Result<TcpStream> {
    let mut s = TcpStream::connect((socks.host.as_str(), socks.port))
        .await
        .with_context(|| format!("can't reach the SOCKS proxy at {}:{}", socks.host, socks.port))?;
    let target = target_address(socks, host, port).await?;
    handshake(&mut s, socks.auth.as_ref(), &target, port).await.with_context(|| format!("SOCKS proxy, to {host}:{port}"))?;
    Ok(s)
}

/// The address in a CONNECT request: an IP as it is, or a name — sent to the proxy
/// to resolve (`socks5h`), or resolved here first (`socks5`).
async fn target_address(socks: &Socks, host: &str, port: u16) -> Result<Vec<u8>> {
    let ip = match host.parse::<IpAddr>() {
        Ok(ip) => ip,
        Err(_) if socks.remote_dns => {
            let name = host.as_bytes();
            let len = u8::try_from(name.len()).map_err(|_| anyhow!("host name too long: {host}"))?;
            return Ok([&[0x03, len][..], name].concat());
        }
        Err(_) => tokio::net::lookup_host((host, port))
            .await
            .with_context(|| format!("can't resolve {host}"))?
            .next()
            .ok_or_else(|| anyhow!("{host} has no address"))?
            .ip(),
    };
    Ok(match ip {
        IpAddr::V4(v4) => [&[0x01][..], &v4.octets()].concat(),
        IpAddr::V6(v6) => [&[0x04][..], &v6.octets()].concat(),
    })
}

/// The SOCKS5 exchange on a connection to the proxy, up to its reply to CONNECT.
async fn handshake(
    s: &mut (impl AsyncRead + AsyncWrite + Unpin),
    auth: Option<&(String, String)>,
    target: &[u8],
    port: u16,
) -> Result<()> {
    // Ways to sign in: none, and a username and password when there are some.
    let greeting: &[u8] = if auth.is_some() { &[0x05, 0x02, 0x00, 0x02] } else { &[0x05, 0x01, 0x00] };
    s.write_all(greeting).await?;
    let mut choice = [0u8; 2];
    s.read_exact(&mut choice).await?;
    if choice[0] != 0x05 {
        bail!("not a SOCKS5 proxy");
    }
    match (choice[1], auth) {
        (0x00, _) => {}
        (0x02, Some((user, pass))) => {
            let (u, p) = (user.as_bytes(), pass.as_bytes());
            let ulen = u8::try_from(u.len()).map_err(|_| anyhow!("username too long"))?;
            let plen = u8::try_from(p.len()).map_err(|_| anyhow!("password too long"))?;
            s.write_all(&[&[0x01, ulen][..], u, &[plen], p].concat()).await?;
            let mut res = [0u8; 2];
            s.read_exact(&mut res).await?;
            if res[1] != 0x00 {
                bail!("the proxy refused the username and password");
            }
        }
        (0x02, None) => bail!("the proxy wants a username and password"),
        _ => bail!("the proxy accepts no way of signing in this offers"),
    }
    s.write_all(&[&[0x05, 0x01, 0x00][..], target, &port.to_be_bytes()].concat()).await?;
    // VER REP RSV ATYP, then the bound address and port, which nothing here needs.
    let mut reply = [0u8; 4];
    s.read_exact(&mut reply).await?;
    if reply[1] != 0x00 {
        bail!("the proxy couldn't connect (SOCKS reply {})", reply[1]);
    }
    let addr_len = match reply[3] {
        0x01 => 4,
        0x04 => 16,
        0x03 => {
            let mut n = [0u8; 1];
            s.read_exact(&mut n).await?;
            n[0] as usize
        }
        t => bail!("unknown address type {t} in the proxy's reply"),
    };
    let mut bound = vec![0u8; addr_len + 2];
    s.read_exact(&mut bound).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_socks_routes() {
        assert!(is_socks("socks5://127.0.0.1:1086") && is_socks("socks5h://proxy:1080"));
        assert!(!is_socks("http://127.0.0.1:7890"));
        assert_eq!(
            Socks::parse("socks5://127.0.0.1:1086"),
            Some(Socks { host: "127.0.0.1".into(), port: 1086, auth: None, remote_dns: false })
        );
        assert_eq!(
            Socks::parse("socks5h://us%40r:p%3Ass@[::1]"),
            Some(Socks { host: "::1".into(), port: 1080, auth: Some(("us@r".into(), "p:ss".into())), remote_dns: true })
        );
        assert_eq!(Socks::parse("http://127.0.0.1:7890"), None);
    }

    #[test]
    fn reads_connect_targets() {
        assert_eq!(connect_target("CONNECT overpass-api.de:443 HTTP/1.1\r\nHost: x\r\n\r\n"), Some(("overpass-api.de".into(), 443)));
        assert_eq!(connect_target("CONNECT [2001:db8::1]:443 HTTP/1.1\r\n\r\n"), Some(("2001:db8::1".into(), 443)));
        assert_eq!(connect_target("GET http://example.com/ HTTP/1.1\r\n\r\n"), None);
        assert_eq!(connect_target("CONNECT example.com HTTP/1.1\r\n\r\n"), None);
    }

    /// The whole path: an HTTP CONNECT into the bridge comes out of a (stand-in)
    /// SOCKS5 proxy as a CONNECT to the same name, and bytes then flow both ways.
    #[tokio::test]
    async fn tunnels_a_connect_through_socks5() {
        // A SOCKS5 proxy that takes no sign-in, checks the CONNECT, then echoes.
        let proxy = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let proxy_port = proxy.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut s, _) = proxy.accept().await.unwrap();
            let mut greeting = [0u8; 3];
            s.read_exact(&mut greeting).await.unwrap();
            assert_eq!(greeting, [0x05, 0x01, 0x00]);
            s.write_all(&[0x05, 0x00]).await.unwrap();
            let mut req = [0u8; 5];
            s.read_exact(&mut req).await.unwrap();
            assert_eq!(req[..4], [0x05, 0x01, 0x00, 0x03], "a name, for the proxy to resolve");
            let mut name = vec![0u8; req[4] as usize + 2];
            s.read_exact(&mut name).await.unwrap();
            assert_eq!(&name[..name.len() - 2], b"overpass.example");
            assert_eq!(u16::from_be_bytes([name[name.len() - 2], name[name.len() - 1]]), 443);
            s.write_all(&[0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 80]).await.unwrap();
            let mut buf = [0u8; 4];
            s.read_exact(&mut buf).await.unwrap();
            s.write_all(&buf).await.unwrap();
        });

        let bridge = start(&format!("socks5h://127.0.0.1:{proxy_port}")).await.unwrap();
        let port: u16 = bridge.url.rsplit_once(':').unwrap().1.parse().unwrap();
        let mut client = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        client.write_all(b"CONNECT overpass.example:443 HTTP/1.1\r\nHost: overpass.example:443\r\n\r\n").await.unwrap();
        let (head, early) = read_head(&mut client).await.unwrap();
        assert!(head.starts_with("HTTP/1.1 200"), "{head}");
        assert!(early.is_empty());
        client.write_all(b"ping").await.unwrap();
        let mut back = [0u8; 4];
        client.read_exact(&mut back).await.unwrap();
        assert_eq!(&back, b"ping");
    }
}
