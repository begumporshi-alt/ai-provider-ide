//! egress-gateway (L0): ALL outbound HTTP from the app. The single audited place that
//! combines a secret with a request (invariant 2) and enforces the host allowlist
//! (invariant 3/9 — no telemetry is mechanically true, not aspirational).
//!
//! Contract with TS: the interpreter sends auth headers whose value carries the `{{secret}}`
//! sentinel (e.g. `"Bearer {{secret}}"`). Rust resolves the secretRef from the keychain,
//! substitutes the sentinel, sends, and drops the value. A header WITHOUT a sentinel is sent
//! as-is; a request with a secretRef but no sentinel header is an error (the key would be
//! silently unused — better to fail loud than to send an unauthenticated request).

use std::collections::HashSet;
use std::sync::RwLock;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

use crate::vault;

pub const SENTINEL: &str = "{{secret}}";

#[derive(Debug, thiserror::Error)]
pub enum EgressError {
    #[error("host not allowlisted: {0} (invariant 3)")]
    HostDenied(String),
    #[error("invalid url: {0}")]
    BadUrl(String),
    #[error("secret {ref_} not found in keychain (re-enter the key)")]
    SecretMissing { ref_: String },
    #[error("secretRef given but no header carries the {{secret}} sentinel — refusing to send unauthenticated")]
    SentinelMissing,
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("vault error: {0}")]
    Vault(#[from] vault::VaultError),
}

/// In-memory allowlist of provider hosts, populated from the DB at startup and on every
/// provider add (user-entered base URLs only — §2.6 "generator cannot change hosts").
#[derive(Default)]
pub struct AllowList(pub RwLock<HashSet<String>>);

impl AllowList {
    pub fn allow(&self, host: &str) {
        self.0.write().unwrap().insert(host.to_lowercase());
    }
    pub fn deny(&self, host: &str) {
        self.0.write().unwrap().remove(&host.to_lowercase());
    }
    fn contains(&self, host: &str) -> bool {
        self.0.read().unwrap().contains(&host.to_lowercase())
    }
}

#[derive(Debug, Deserialize)]
pub struct EgressRequest {
    pub url: String,
    pub method: String,
    pub headers: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub secret_ref: Option<String>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
pub struct EgressResponse {
    pub status: u16,
    pub headers: std::collections::BTreeMap<String, String>,
    pub body: String,
}

/// Events streamed to the TS side for SSE requests (invariant: only raw text lines — the
/// secret never crosses back).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StreamEvent {
    Headers { status: u16, headers: std::collections::BTreeMap<String, String> },
    Line { text: String },
    Done,
    Error { message: String },
}

/// Pure allowlist + URL check (unit-testable).
pub fn check_url(allow: &AllowList, raw: &str) -> Result<reqwest::Url, EgressError> {
    let url = reqwest::Url::parse(raw).map_err(|e| EgressError::BadUrl(e.to_string()))?;
    let host = url.host_str().ok_or_else(|| EgressError::BadUrl(raw.into()))?;
    // Localhost providers permitted (§8 note); everything else must be a registered base URL host.
    let is_local = matches!(host, "127.0.0.1" | "localhost" | "::1");
    if !is_local && !allow.contains(host) {
        return Err(EgressError::HostDenied(host.into()));
    }
    Ok(url)
}

/// Inject the keychain secret into sentinel headers. Returns the mutated map.
pub fn inject_secret(
    mut headers: std::collections::BTreeMap<String, String>,
    secret: Option<&str>,
) -> Result<std::collections::BTreeMap<String, String>, EgressError> {
    let has_sentinel = headers.values().any(|v| v.contains(SENTINEL));
    match secret {
        Some(s) => {
            if !has_sentinel {
                return Err(EgressError::SentinelMissing);
            }
            for v in headers.values_mut() {
                if v.contains(SENTINEL) {
                    *v = v.replace(SENTINEL, s);
                }
            }
            Ok(headers)
        }
        None => {
            // No secret: refuse if a sentinel would leak the literal to the provider.
            if has_sentinel {
                return Err(EgressError::SentinelMissing);
            }
            Ok(headers)
        }
    }
}

async fn build(
    client: &reqwest::Client,
    allow: &AllowList,
    req: EgressRequest,
) -> Result<reqwest::RequestBuilder, EgressError> {
    let url = check_url(allow, &req.url)?;
    let secret = match &req.secret_ref {
        Some(r) => Some(
            vault::get(r)?
                .ok_or_else(|| EgressError::SecretMissing { ref_: r.clone() })?,
        ),
        None => None,
    };
    let headers = inject_secret(req.headers.clone(), secret.as_deref())?;
    let method: reqwest::Method = req.method.parse().map_err(|_| EgressError::BadUrl("bad method".into()))?;
    let mut b = client.request(method, url);
    if let Some(ms) = req.timeout_ms {
        b = b.timeout(std::time::Duration::from_millis(ms));
    }
    for (k, v) in headers {
        b = b.header(k, v);
    }
    if let Some(body) = req.body {
        b = b.body(body);
    }
    Ok(b)
}

/// Unary request (model lists, image generations, contract pings).
pub async fn request(
    client: &reqwest::Client,
    allow: &AllowList,
    req: EgressRequest,
) -> Result<EgressResponse, EgressError> {
    let res = build(client, allow, req).await?.send().await?;
    let status = res.status().as_u16();
    let headers = res
        .headers()
        .iter()
        .map(|(k, v)| (k.as_str().to_lowercase(), v.to_str().unwrap_or("").to_string()))
        .collect();
    let body = res.text().await?;
    Ok(EgressResponse { status, headers, body })
}

/// SSE streaming request: lines flow through the channel. Cancellation = the client drop of
/// the channel / task abort closes the provider stream (§3.5 propagates this to the provider).
pub async fn stream(
    client: &reqwest::Client,
    allow: &AllowList,
    req: EgressRequest,
    channel: Channel<StreamEvent>,
) -> Result<(), EgressError> {
    let b = build(client, allow, req).await?;
    match b.send().await {
        Ok(res) => {
            let status = res.status().as_u16();
            let headers = res
                .headers()
                .iter()
                .map(|(k, v)| (k.as_str().to_lowercase(), v.to_str().unwrap_or("").to_string()))
                .collect();
            let _ = channel.send(StreamEvent::Headers { status, headers });
            if status >= 400 {
                let body = res.text().await.unwrap_or_default();
                let _ = channel.send(StreamEvent::Error {
                    message: format!("http {status}: {}", body.chars().take(2000).collect::<String>()),
                });
                return Ok(());
            }
            let mut stream = res.bytes_stream();
            let mut buf = String::new();
            while let Some(chunk) = stream.next().await {
                match chunk {
                    Ok(bytes) => {
                        buf.push_str(&String::from_utf8_lossy(&bytes));
                        while let Some(pos) = buf.find('\n') {
                            let line = buf[..pos].trim_end_matches('\r').to_string();
                            buf.drain(..=pos);
                            let _ = channel.send(StreamEvent::Line { text: line });
                        }
                    }
                    Err(e) => {
                        let _ = channel.send(StreamEvent::Error { message: e.to_string() });
                        return Ok(());
                    }
                }
            }
            if !buf.trim().is_empty() {
                let _ = channel.send(StreamEvent::Line { text: buf.trim().to_string() });
            }
            let _ = channel.send(StreamEvent::Done);
            Ok(())
        }
        Err(e) => {
            let _ = channel.send(StreamEvent::Error { message: e.to_string() });
            Err(e.into())
        }
    }
}

/// Shared client with the §3.6 connect budget; per-request first-byte/idle budgets are applied
/// in the TS execution loop (Phase 2a) since they depend on stream activity.
pub fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .tcp_nodelay(true)
        .build()
        .expect("reqwest client")
}

/// Managed state wrapper so commands can share one client + allowlist.
pub struct EgressState {
    pub client: reqwest::Client,
    pub allow: AllowList,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allow_with(host: &str) -> AllowList {
        let a = AllowList::default();
        a.allow(host);
        a
    }

    #[test]
    fn allowlist_denies_unregistered_hosts() {
        let a = allow_with("openrouter.ai");
        assert!(check_url(&a, "https://openrouter.ai/api/v1/models").is_ok());
        assert!(check_url(&a, "https://evil.example.com/x").is_err());
    }

    #[test]
    fn allowlist_permits_localhost_providers() {
        let a = AllowList::default();
        assert!(check_url(&a, "http://127.0.0.1:11434/api").is_ok());
        assert!(check_url(&a, "http://localhost:1234/v1").is_ok());
    }

    #[test]
    fn secret_injected_only_at_sentinel() {
        let mut h = std::collections::BTreeMap::new();
        h.insert("Authorization".to_string(), "Bearer {{secret}}".to_string());
        h.insert("X-Title".to_string(), "AI-Provider IDE".to_string());
        let out = inject_secret(h, Some("sk-real-secret")).unwrap();
        assert_eq!(out["Authorization"], "Bearer sk-real-secret");
        assert_eq!(out["X-Title"], "AI-Provider IDE");
    }

    #[test]
    fn secret_never_reaches_a_request_without_sentinel() {
        let mut h = std::collections::BTreeMap::new();
        h.insert("Authorization".to_string(), "Bearer wrong".to_string());
        assert!(matches!(
            inject_secret(h, Some("sk-x")),
            Err(EgressError::SentinelMissing)
        ));
    }

    #[test]
    fn no_secret_means_no_sentinel_left_behind() {
        let mut h = std::collections::BTreeMap::new();
        h.insert("x-api-key".to_string(), "{{secret}}".to_string());
        assert!(matches!(inject_secret(h, None), Err(EgressError::SentinelMissing)));
    }
}
