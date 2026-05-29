use anyhow::{anyhow, Result};
use std::time::Duration;

use crate::bbox::Bbox;

// Mirror list and query template mirror `src/core/overpass.ts`; keep in sync.

const MIRRORS: &[&str] = &[
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
];

fn build_query(b: Bbox) -> String {
    format!(
        "[out:json][timeout:90];way[highway]({s},{w},{n},{e});out geom;",
        s = b.south,
        w = b.west,
        n = b.north,
        e = b.east,
    )
}

pub async fn fetch_roads(b: Bbox) -> Result<serde_json::Value> {
    let q = build_query(b);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(95))
        .user_agent("InkCity/0.1 (https://github.com)")
        .build()?;

    let mut last_err: Option<anyhow::Error> = None;
    for mirror in MIRRORS {
        match try_one(&client, mirror, &q).await {
            Ok(v) => {
                eprintln!("[overpass] success via {}", mirror);
                return Ok(v);
            }
            Err(e) => {
                eprintln!("[overpass] {} failed: {}", mirror, e);
                last_err = Some(e);
            }
        }
    }
    Err(last_err.unwrap_or_else(|| anyhow!("no mirrors configured")))
}

async fn try_one(client: &reqwest::Client, url: &str, q: &str) -> Result<serde_json::Value> {
    let res = client
        .post(url)
        .body(format!("data={}", urlencode(q)))
        .header("Content-Type", "application/x-www-form-urlencoded")
        .send()
        .await?;
    if !res.status().is_success() {
        return Err(anyhow!("HTTP {}", res.status()));
    }
    let json: serde_json::Value = res.json().await?;
    Ok(json)
}

fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}
