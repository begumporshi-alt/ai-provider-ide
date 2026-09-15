//! egress-gateway (L0): ALL outbound HTTP from the app. The single audited place that
//! combines a secret with a request (invariant 2) and enforces the host allowlist
//! (invariant 3/9 — no telemetry is mechanically true, not aspirational).
//!
//! Contract with TS: the interpreter sends auth headers whose value carries the `{{secret}}`
//! sentinel (e.g. `"Bearer {{secret}}"`). Rust resolves the secretRef from the keychain,
//! substitutes the sentinel, sends, and drops the value.
//!
//! Trust model (diff-review 2026-09-15, the webview is UNTRUSTED — Tauri 2 does not ACL
//! app-defined commands):
//! - `secret_ref` may only be used against the host of its OWN provider (`key:<keyId>` rows
//!   are joined to providers.base_url and the destination host must match), so a compromised
//!   webview cannot pair a stolen ref with an attacker URL.
//! - Redirects are only followed to allowlisted hosts (reqwest's default cross-host
//!   header-stripping does not cover `x-api-key`, so following off-allowlist would exfil).
//! - The webview cannot mutate the allowlist; only `provider_upsert`/`provider_delete` do.

use std::collections::HashSet;
use std::sync::{Arc, RwLock};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

use crate::store::Store;
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
    #[error("secret_ref {ref_} may only be used against its own provider host {expected} (got {got})")]
    KeyHostMismatch {
        ref_: String,
        expected: String,
        got: String,
    },
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("vault error: {0}")]
    Vault(#[from] vault::VaultError),
    #[error("store error: {0}")]
    Store(#[from] crate::store::StoreError),
}

/// In-memory allowlist of provider hosts. Mutated ONLY by provider CRUD commands host-side
/// (never by the webview).
#[derive(Default)]
pub struct AllowList(pub RwLock<HashSet<String>>);

impl AllowList {
    pub fn allow(&self, host: &str) {
        self.0.write().unwrap().insert(host.to_lowercase());
    }
    #[allow(dead_code)] // symmetric API; provider_delete uses recompute_allow instead
    pub fn deny(&self, host: &str) {
        self.0.write().unwrap().remove(&host.to_lowercase());
    }
    pub fn contains(&self, host: &str) -> bool {
        self.0.read().unwrap().contains(&host.to_lowercase())
    }
}

pub fn is_local(host: &str) -> bool {
    matches!(host, "127.0.0.1" | "localhost" | "::1" | "[::1]")
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
    if !is_local(host) && !allow.contains(host) {
        return Err(EgressError::HostDenied(host.into()));
    }
    Ok(url)
}

/// Enforce `secret_ref -> own provider host` pairing using the DB (the webview is untrusted).
pub fn check_secret_host(store: &Store, secret_ref: &str, dest_host: &str) -> Result<(), EgressError> {
    let conn = store.conn.lock().unwrap();
    let base: Option<String> = conn
        .query_row(
            "SELECT p.base_url FROM api_keys k JOIN providers p ON p.id = k.provider_id WHERE k.secret_ref = ?1",
            rusqlite::params![secret_ref],
            |r| r.get(0),
        )
        .ok();
    let Some(base) = base else {
        // Unknown ref: refuse. It may also simply be deleted — the caller gets a clear error.
        return Err(EgressError::SecretMissing { ref_: secret_ref.into() });
    };
    let expected = reqwest::Url::parse(&base)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_lowercase()))
        .unwrap_or_default();
    if expected != dest_host.to_lowercase() {
        return Err(EgressError::KeyHostMismatch {
            ref_: secret_ref.into(),
            expected,
            got: dest_host.into(),
        });
    }
    Ok(())
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
    state: &EgressState,
    req: EgressRequest,
) -> Result<reqwest::RequestBuilder, EgressError> {
    let url = check_url(&state.allow, &req.url)?;
    let host = url.host_str().unwrap_or("");
    // The port of any local provider is allowed, but a NON-local key may only ever meet a
    // non-local host on its own provider domain.
    if let Some(r) = &req.secret_ref {
        check_secret_host(&state.store, r, host)?;
    }
    let secret = match &req.secret_ref {
        Some(r) => Some(
            vault::get(r)?
                .ok_or_else(|| EgressError::SecretMissing { ref_: r.clone() })?,
        ),
        None => None,
    };
    let headers = inject_secret(req.headers.clone(), secret.as_deref())?;
    // TS emits GET/POST only (HttpPort type); shrink the surface.
    let method: reqwest::Method = match req.method.as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        _ => return Err(EgressError::BadUrl(format!("method not permitted: {}", req.method))),
    };
    let mut b = state.client.request(method, url);
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
pub async fn request(state: &EgressState, req: EgressRequest) -> Result<EgressResponse, EgressError> {
    let res = build(state, req).await?.send().await?;
    let status = res.status().as_u16();
    let headers = res
        .headers()
        .iter()
        .map(|(k, v)| (k.as_str().to_lowercase(), v.to_str().unwrap_or("").to_string()))
        .collect();
    let body = res.text().await?;
    Ok(EgressResponse { status, headers, body })
}

/// SSE streaming request: lines flow through the channel. When the webview stops consuming
/// (channel send fails), the loop breaks and the reqwest stream future drops — closing the
/// provider connection (§3.5 cancellation).
pub async fn stream(state: &EgressState, req: EgressRequest, channel: Channel<StreamEvent>) -> Result<(), EgressError> {
    let b = build(state, req).await?;
    match b.send().await {
        Ok(res) => {
            let status = res.status().as_u16();
            let headers = res
                .headers()
                .iter()
                .map(|(k, v)| (k.as_str().to_lowercase(), v.to_str().unwrap_or("").to_string()))
                .collect();
            if channel
                .send(StreamEvent::Headers { status, headers })
                .is_err()
            {
                return Ok(()); // consumer gone; provider stream drops => cancelled
            }
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
                            if channel.send(StreamEvent::Line { text: line }).is_err() {
                                return Ok(()); // mid-stream disconnect -> cancel upstream
                            }
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

/// Managed state: the audited trio (client + allowlist + pairing DB).
pub struct EgressState {
    pub client: reqwest::Client,
    pub allow: Arc<AllowList>,
    pub store: Arc<Store>,
}

impl EgressState {
    /// Connect budget per §3.6; redirect policy vetoes any off-allowlist hop (Blocker 1 of
    /// the Phase 1 diff review).
    pub fn new(allow: Arc<AllowList>, store: Arc<Store>) -> Self {
        let _ = &allow;
        Self {
            client: reqwest::Client::builder()
                .connect_timeout(std::time::Duration::from_secs(10))
                // v1: never follow redirects. API providers don't 3xx on these endpoints, and
                // reqwest re-sends auth headers (incl. x-api-key, which its default policy does
                // NOT strip cross-host) to the redirect target — that would exfiltrate the key
                // (diff-review Blocker 1). A 3xx surfaces as a classified error instead.
                .redirect(reqwest::redirect::Policy::none())
                .tcp_nodelay(true)
                .build()
                .expect("reqwest client"),
            allow,
            store,
        }
    }
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

#[cfg(test)]
mod pairing_tests {
    use super::*;

    fn store_with(provider_url: &str, secret_ref: &str) -> Store {
        let dir = std::env::temp_dir().join(format!("aip-pair-{}-{}", std::process::id(), {
            use std::sync::atomic::{AtomicUsize, Ordering};
            static N: AtomicUsize = AtomicUsize::new(0);
            N.fetch_add(1, Ordering::Relaxed)
        }));
        let _ = std::fs::remove_dir_all(&dir);
        let s = Store::open(&dir).unwrap();
        let conn = s.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO providers (id, slug, name, base_url, status, created_at, updated_at) VALUES ('p','s','n',?1,'enabled',1,1)",
            rusqlite::params![provider_url],
        ).unwrap();
        conn.execute(
            "INSERT INTO api_keys (id, provider_id, label, secret_ref, added_at) VALUES ('k','p','l',?1,1)",
            rusqlite::params![secret_ref],
        ).unwrap();
        drop(conn);
        s
    }

    #[test]
    fn secret_ref_may_only_meet_its_own_provider_host() {
        let s = store_with("https://openrouter.ai/api/v1", "key:k1");
        assert!(check_secret_host(&s, "key:k1", "openrouter.ai").is_ok());
        assert!(matches!(
            check_secret_host(&s, "key:k1", "attacker.tld"),
            Err(EgressError::KeyHostMismatch { .. })
        ));
        let _ = std::fs::remove_dir_all(&s.path);
    }

    #[test]
    fn unknown_secret_ref_is_refused() {
        let s = store_with("https://x.test/v1", "key:k1");
        assert!(matches!(check_secret_host(&s, "key:evil", "x.test"), Err(EgressError::SecretMissing { .. })));
        let _ = std::fs::remove_dir_all(&s.path);
    }
}
