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

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use base64::Engine as _;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};

use crate::core::store::Store;
use crate::core::vault;

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
    #[error(
        "secret_ref {ref_} may only be used against its own provider host {expected} (got {got})"
    )]
    KeyHostMismatch { ref_: String, expected: String, got: String },
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("vault error: {0}")]
    Vault(#[from] vault::VaultError),
    #[error("store error: {0}")]
    Store(#[from] crate::core::store::StoreError),
    #[error("image fetch refused: {0}")]
    ImageFetch(String),
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

/// Is `host` this machine?
///
/// **The port is not part of this decision and never was.** Every caller passes
/// `Url::host_str()`, which excludes it, so "localhost on any port" is permitted — and that is
/// deliberate, not an oversight: Ollama is on 11434, LM Studio on 1234, and a per-port allowlist
/// entry would break local providers, which are a primary use case. Widening or narrowing this
/// function does not change that; the port is simply not an input.
///
/// The whole `127/8` block is loopback (RFC 1122 §3.2.1.3), not just `127.0.0.1`. A provider
/// bound to `127.0.0.2` is exactly as local as one bound to `127.0.0.1`, and the previous
/// four-string match refused it for no reason — it was an arbitrary list, not a rule.
pub fn is_local(host: &str) -> bool {
    if matches!(host, "localhost" | "localhost." | "::1" | "[::1]") {
        return true;
    }
    // Parsed rather than prefix-matched: "127.0.0", "127.0.0.1.5" and "127.evil.example" must
    // all stay remote, and a `strip_prefix("127.")` test gets those wrong in at least one case.
    host.parse::<std::net::Ipv4Addr>().map(|ip| ip.octets()[0] == 127).unwrap_or(false)
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

/// Invariant-3 carve-out request: fetch a URL that a provider returned in the body of a
/// response the gateway itself just served (e.g. an `imageUrl` from an image generation).
/// The host must be localhost, allowlisted, or a recently-returned scoped host; the fetch
/// carries NO secret and follows redirects only to hosts passing the same rule.
#[derive(Debug, Deserialize)]
pub struct ImageFetchRequest {
    pub url: String,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
pub struct ImageFetchResponse {
    pub status: u16,
    pub content_type: String,
    pub base64: String,
    pub bytes: usize,
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
pub fn check_secret_host(
    store: &Store,
    secret_ref: &str,
    dest_host: &str,
) -> Result<(), EgressError> {
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
        Some(r) => {
            Some(vault::get(r)?.ok_or_else(|| EgressError::SecretMissing { ref_: r.clone() })?)
        }
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
pub async fn request(
    state: &EgressState,
    req: EgressRequest,
) -> Result<EgressResponse, EgressError> {
    let res = build(state, req).await?.send().await?;
    let status = res.status().as_u16();
    let headers = res
        .headers()
        .iter()
        .map(|(k, v)| (k.as_str().to_lowercase(), v.to_str().unwrap_or("").to_string()))
        .collect();
    let body = res.text().await?;
    // Invariant-3 carve-out: whatever hosts this provider just handed back (an imageUrl on a
    // CDN host, a docs URL, ...) become fetchable for a short window — scoped, expiring,
    // and never written into the allowlist.
    state.record_returned_hosts(&body);
    Ok(EgressResponse { status, headers, body })
}

/// Cap for the image-fetch carve-out — protects the webview from a hostile endpoint
/// streaming gigabytes of base64.
const IMAGE_FETCH_MAX_BYTES: usize = 32 * 1024 * 1024;

/// Invariant-3 check for the image-fetch carve-out: localhost, allowlisted, or a host the
/// gateway just saw in a provider response body (the scoped, expiring lease).
pub fn image_host_allowed(state: &EgressState, host: &str) -> Result<(), EgressError> {
    let host = host.to_lowercase();
    if is_local(&host) || state.allow.contains(&host) || state.returned_host_fresh(&host) {
        Ok(())
    } else {
        Err(EgressError::HostDenied(host))
    }
}

/// Invariant-3 carve-out fetch: get the bytes of a URL a provider returned (an imageUrl),
/// scoped to that response, NOT a new allowlist entry. No secret is ever attached — this
/// path exists for pre-signed CDN URLs, which need none. Every redirect hop re-passes the
/// same allow/scoped check (see the image_client policy above).
pub async fn fetch_image(
    state: &EgressState,
    req: ImageFetchRequest,
) -> Result<ImageFetchResponse, EgressError> {
    let url = reqwest::Url::parse(&req.url).map_err(|e| EgressError::BadUrl(e.to_string()))?;
    image_host_allowed(state, url.host_str().unwrap_or(""))?;
    let mut b = state.image_client.get(url);
    if let Some(ms) = req.timeout_ms {
        b = b.timeout(std::time::Duration::from_millis(ms));
    }
    let res = b.send().await?;
    let status = res.status().as_u16();
    let content_type = res
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    let mut bytes: Vec<u8> = Vec::new();
    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(EgressError::Http)?;
        bytes.extend_from_slice(&chunk);
        if bytes.len() > IMAGE_FETCH_MAX_BYTES {
            return Err(EgressError::ImageFetch("response exceeds 32 MiB cap".into()));
        }
    }
    Ok(ImageFetchResponse {
        status,
        content_type,
        base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
        bytes: bytes.len(),
    })
}

/// How long an upstream may go completely silent before we give up on it.
///
/// A post-connect stall is the one upstream failure nothing else reports: TCP stays open, no
/// RST, no FIN, and `send()` or `stream.next()` simply never resolves. `connect_timeout` covers
/// the handshake only, and `req.timeout_ms` is passed as `null` for chat, so before this a
/// provider that accepted the connection and then sat there held the request open forever —
/// while looking healthy to every layer above it.
///
/// Sized against measurement, not preference. The slowest request on the live gateway took
/// ~27s (a ~150k-token prompt), and the failure that prompted this was a turn that ran past
/// 30s. 120s is more than 4x the worst observed, so no legitimate request is at risk, while a
/// genuine stall now ends in two minutes instead of never. It bounds *silence*, not duration:
/// a stream that keeps producing data is never cut off, however long it runs.
const UPSTREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(120);

/// Drive one streaming request and push its events into `sink`.
///
/// **The sink is an `mpsc` sender rather than a `tauri::ipc::Channel`, and that is what makes this
/// function reachable from `core`.** It was the only `app`-gated item in this module and the gate
/// existed solely because a `Channel` is a Tauri type — the body below never touched Tauri.
/// `UnboundedSender::send` returns `Result<_, SendError>` exactly as `Channel::send` returns a
/// `Result`, so the `is_err()` and `let _ =` shapes are unchanged: a consumer that has gone away is
/// still detected the same way, and dropping the receiver is still what cancels the upstream.
///
/// `tauri/commands.rs` keeps its `Channel` and forwards through a task; `core/egress_port.rs`
/// consumes the receiver as the `HttpPort` line stream.
///
/// Cancellation is §3.5 and the sink is what carries it: a consumer that stops receiving drops the
/// receiver, the next `send` fails, the loop returns, and the reqwest stream future drops — closing
/// the provider connection.
pub async fn stream(
    state: &EgressState,
    req: EgressRequest,
    sink: tokio::sync::mpsc::UnboundedSender<StreamEvent>,
) -> Result<(), EgressError> {
    let b = build(state, req).await?;
    // Bounded the same way as the chunks below: headers are progress too, and a server that
    // completes the handshake and then never answers is indistinguishable from a stall.
    let sent = tokio::time::timeout(UPSTREAM_IDLE_TIMEOUT, b.send()).await;
    match sent {
        Ok(Ok(res)) => {
            let status = res.status().as_u16();
            let headers = res
                .headers()
                .iter()
                .map(|(k, v)| (k.as_str().to_lowercase(), v.to_str().unwrap_or("").to_string()))
                .collect();
            if sink.send(StreamEvent::Headers { status, headers }).is_err() {
                return Ok(()); // consumer gone; provider stream drops => cancelled
            }
            if status >= 400 {
                let body = res.text().await.unwrap_or_default();
                let _ = sink.send(StreamEvent::Error {
                    message: format!(
                        "http {status}: {}",
                        body.chars().take(2000).collect::<String>()
                    ),
                });
                return Ok(());
            }
            let mut stream = res.bytes_stream();
            let mut buf = String::new();
            loop {
                // Each wait for the next chunk is bounded, not the stream as a whole: a
                // provider that keeps sending is never cut off, however long it runs.
                let next = tokio::time::timeout(UPSTREAM_IDLE_TIMEOUT, stream.next()).await;
                let chunk = match next {
                    Ok(Some(c)) => c,
                    Ok(None) => break, // upstream closed the stream
                    Err(_) => {
                        let _ = sink.send(StreamEvent::Error {
                            message: format!(
                                "upstream went silent for {}s — abandoning the stream",
                                UPSTREAM_IDLE_TIMEOUT.as_secs()
                            ),
                        });
                        return Ok(());
                    }
                };
                match chunk {
                    Ok(bytes) => {
                        buf.push_str(&String::from_utf8_lossy(&bytes));
                        while let Some(pos) = buf.find('\n') {
                            let line = buf[..pos].trim_end_matches('\r').to_string();
                            buf.drain(..=pos);
                            if sink.send(StreamEvent::Line { text: line }).is_err() {
                                return Ok(()); // mid-stream disconnect -> cancel upstream
                            }
                        }
                    }
                    Err(e) => {
                        let _ = sink.send(StreamEvent::Error { message: e.to_string() });
                        return Ok(());
                    }
                }
            }
            if !buf.trim().is_empty() {
                let _ = sink.send(StreamEvent::Line { text: buf.trim().to_string() });
            }
            let _ = sink.send(StreamEvent::Done);
            Ok(())
        }
        Ok(Err(e)) => {
            let _ = sink.send(StreamEvent::Error { message: e.to_string() });
            Err(e.into())
        }
        Err(_) => {
            let _ = sink.send(StreamEvent::Error {
                message: format!(
                    "upstream sent no response headers for {}s — abandoning the request",
                    UPSTREAM_IDLE_TIMEOUT.as_secs()
                ),
            });
            Ok(())
        }
    }
}

/// Managed state: the audited trio (client + allowlist + pairing DB).
pub struct EgressState {
    pub client: reqwest::Client,
    /// Image-fetch client whose redirect policy re-validates every hop against the SAME
    /// allow/scoped rule — no cross-host leap can sneak a request off the approved set
    /// (reqwest's default policy strips standard auth headers cross-host but not custom
    /// ones, and this path carries no secret at all).
    image_client: reqwest::Client,
    pub allow: Arc<AllowList>,
    pub store: Arc<Store>,
    /// Invariant-3 lease: hosts returned in response bodies, valid briefly. A provider
    /// that returns an `imageUrl` on a CDN host the allowlist has never seen may have
    /// THAT host fetched back — scoped, expiring, never persisted to the allowlist.
    returned_hosts: RwLock<HashMap<String, Instant>>,
}

/// How long a provider-returned host stays fetchable (invariant 3 carve-out).
const RETURNED_HOST_TTL: Duration = Duration::from_secs(10 * 60);

impl EgressState {
    /// Connect budget per §3.6; redirect policy vetoes any off-allowlist hop (Blocker 1 of
    /// the Phase 1 diff review).
    pub fn new(allow: Arc<AllowList>, store: Arc<Store>) -> Self {
        let allow_clone = allow.clone();
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
            image_client: reqwest::Client::builder()
                .connect_timeout(std::time::Duration::from_secs(10))
                .redirect(reqwest::redirect::Policy::custom(
                    move |attempt: reqwest::redirect::Attempt| {
                        let host = attempt.url().host_str().unwrap_or("").to_lowercase();
                        if is_local(&host) || allow_clone.contains(&host) {
                            attempt.follow()
                        } else {
                            attempt.stop()
                        }
                    },
                ))
                .tcp_nodelay(true)
                .build()
                .expect("reqwest image client"),
            allow,
            store,
            returned_hosts: RwLock::new(HashMap::new()),
        }
    }

    /// Record hosts that appeared in a response body, for the invariant-3 carve-out. The
    /// body is bounded before scanning so a giant payload can't burn time.
    pub fn record_returned_hosts(&self, body: &str) {
        if body.len() > 2 * 1024 * 1024 {
            return; // provider-returned image URLs live in small JSON envelopes
        }
        let hosts = hosts_in_body(body);
        if hosts.is_empty() {
            return;
        }
        let mut map = self.returned_hosts.write().unwrap();
        let now = Instant::now();
        map.retain(|_, t| *t + RETURNED_HOST_TTL >= now);
        for h in hosts {
            map.insert(h, now);
        }
    }

    /// Invariant-3 check for the image-fetch carve-out.
    fn returned_host_fresh(&self, host: &str) -> bool {
        let map = self.returned_hosts.read().unwrap();
        map.get(host).is_some_and(|t| t.elapsed() < RETURNED_HOST_TTL)
    }
}

/// Where a URL stops, in practice: the end of a JSON string, an HTML attribute, or prose.
fn url_token_end(s: &str) -> usize {
    s.find(|c: char| {
        c.is_whitespace()
            || matches!(c, '"' | '\'' | '<' | '>' | ')' | ']' | '}' | ',' | '\\' | '`')
    })
    .unwrap_or(s.len())
}

/// The hosts of the http(s) URLs in `body`, parsed — not guessed.
///
/// The previous scan read "bytes after the scheme until the first non-hostname character", which
/// was wrong in two opposite directions:
///
///   - `https://cdn.example/x?next=http://attacker.example` read as TWO urls, minting a lease for
///     `attacker.example` from a string that merely appeared inside another URL's query; and
///   - `https://user:pw@cdn.example:8443/a.png` read the host as `user`.
///
/// Both feed the same carve-out: a host recorded here may be fetched by `fetch_image` for the
/// next `RETURNED_HOST_TTL`. Over-recording grants that to any URL a body happens to mention;
/// recording something that is not the host is worse than recording nothing, because the lease
/// is looked up by that string. Taking the whole token and asking the URL parser is the
/// difference: one URL, one host, and the host is the one the URL actually addresses.
fn hosts_in_body(body: &str) -> HashSet<String> {
    let mut hosts = HashSet::new();
    let mut rest = body;
    while let Some(pos) = rest.find("http") {
        let tail = &rest[pos..];
        if !tail.starts_with("https://") && !tail.starts_with("http://") {
            rest = &tail[1..]; // advance one byte; not a URL marker
            continue;
        }
        let candidate = &tail[..url_token_end(tail)];
        if let Ok(u) = reqwest::Url::parse(candidate) {
            if matches!(u.scheme(), "http" | "https") {
                if let Some(h) = u.host_str() {
                    hosts.insert(h.to_lowercase());
                }
            }
        }
        // Skip the whole token. Scanning *into* it is what minted a host from another URL's
        // query string; the max(1) keeps malformed text from looping forever.
        rest = &tail[candidate.len().max(1)..];
    }
    hosts
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

    /// The audit flagged `is_local` as "trusts any port on localhost". It cannot: every caller
    /// passes `Url::host_str()`, which excludes the port, so the port is not an input to the
    /// decision at all. Pinned so the question does not have to be re-litigated.
    #[test]
    fn the_port_is_not_an_input_to_the_host_decision() {
        assert!(!is_local("127.0.0.1:8080"), "a host string never carries a port");
        // …and the URL is still permitted, because the port was never what was being judged.
        assert!(check_url(&AllowList::default(), "http://127.0.0.1:8080/v1").is_ok());
        assert!(check_url(&AllowList::default(), "http://127.0.0.2:9999/v1").is_ok());
    }

    /// The real defect was the opposite of the audit's: the old four-string match covered only
    /// 127.0.0.1 of a /8 that is entirely loopback.
    #[test]
    fn loopback_is_the_whole_127_block_not_just_dot_one() {
        for host in ["127.0.0.1", "127.0.0.2", "127.1.2.3", "127.255.255.255"] {
            assert!(is_local(host), "{host} is loopback");
        }
        for host in [
            "128.0.0.1",
            "126.255.255.255",
            "127.0.0",          // too few octets
            "127.0.0.1.5",      // too many
            "127.evil.example", // looks local, is not
            "17.0.0.1",         // prefix of nothing
        ] {
            assert!(!is_local(host), "{host} is not loopback");
        }
        assert!(is_local("localhost") && is_local("::1"));
    }

    /// A local host that is NOT registered as a provider is allowed by `is_local`; a remote one
    /// is not. This is the boundary the allowlist cannot cover on its own.
    #[test]
    fn an_unregistered_remote_host_is_still_denied() {
        assert!(check_url(&AllowList::default(), "http://127.0.0.2:11434/v1").is_ok());
        assert!(check_url(&AllowList::default(), "https://attacker.example/v1").is_err());
    }

    #[test]
    fn a_url_inside_a_query_string_earns_no_lease_of_its_own() {
        let hosts =
            hosts_in_body(r#"{"url":"https://cdn.example/x?next=http://attacker.example"}"#);
        assert!(hosts.contains("cdn.example"));
        assert!(
            !hosts.contains("attacker.example"),
            "a URL that appears only inside another URL's query must not be fetchable"
        );
    }

    #[test]
    fn userinfo_and_port_are_not_the_host() {
        let hosts = hosts_in_body("see https://user:pw@cdn.example:8443/a.png");
        assert_eq!(hosts.into_iter().collect::<Vec<_>>(), vec!["cdn.example".to_string()]);
    }

    #[test]
    fn prose_that_merely_says_http_records_nothing() {
        assert!(hosts_in_body("the http spec does not define a host").is_empty());
    }

    #[test]
    fn only_http_schemes_earn_a_lease() {
        assert!(hosts_in_body("ftp://files.example/a.png").is_empty());
        assert!(hosts_in_body("https://cdn.example/a.png").contains("cdn.example"));
    }

    #[test]
    fn two_urls_in_one_body_both_earn_a_lease() {
        let hosts = hosts_in_body(r#"["https://a.example/1", "https://b.example/2"]"#);
        assert!(hosts.contains("a.example"));
        assert!(hosts.contains("b.example"));
    }

    #[test]
    fn secret_injected_only_at_sentinel() {
        let mut h = std::collections::BTreeMap::new();
        h.insert("Authorization".to_string(), "Bearer {{secret}}".to_string());
        h.insert("X-Title".to_string(), "AI-Provider Router".to_string());
        let out = inject_secret(h, Some("sk-real-secret")).unwrap();
        assert_eq!(out["Authorization"], "Bearer sk-real-secret");
        assert_eq!(out["X-Title"], "AI-Provider Router");
    }

    #[test]
    fn secret_never_reaches_a_request_without_sentinel() {
        let mut h = std::collections::BTreeMap::new();
        h.insert("Authorization".to_string(), "Bearer wrong".to_string());
        assert!(matches!(inject_secret(h, Some("sk-x")), Err(EgressError::SentinelMissing)));
    }

    #[test]
    fn no_secret_means_no_sentinel_left_behind() {
        let mut h = std::collections::BTreeMap::new();
        h.insert("x-api-key".to_string(), "{{secret}}".to_string());
        assert!(matches!(inject_secret(h, None), Err(EgressError::SentinelMissing)));
    }
}

#[cfg(test)]
mod image_fetch_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn allow_with(host: &str) -> AllowList {
        let a = AllowList::default();
        a.allow(host);
        a
    }

    fn store_with(provider_url: &str, secret_ref: &str) -> Store {
        let dir = std::env::temp_dir().join(format!("aip-img-{}-{}", std::process::id(), {
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

    fn state_with(host: &str) -> EgressState {
        EgressState::new(
            Arc::new(allow_with(host)),
            Arc::new(store_with("https://x.test/v1", "key:k1")),
        )
    }

    #[test]
    fn localhost_and_allowlisted_hosts_pass() {
        let state = state_with("cdn.example.com");
        assert!(image_host_allowed(&state, "127.0.0.1").is_ok());
        assert!(image_host_allowed(&state, "cdn.example.com").is_ok());
    }

    #[test]
    fn unknown_host_is_refused_before_any_request() {
        let state = state_with("cdn.example.com");
        assert!(matches!(
            image_host_allowed(&state, "evil.example.com"),
            Err(EgressError::HostDenied(_))
        ));
    }

    #[test]
    fn a_provider_returned_host_passes_the_carve_out() {
        let state = state_with("cdn.example.com");
        assert!(image_host_allowed(&state, "files.provider-cdn.test").is_err());
        // The provider's response body names that host -> scoped lease opens, nothing persisted.
        state
            .record_returned_hosts(r#"{"data":[{"url":"https://files.provider-cdn.test/a.png"}]}"#);
        assert!(image_host_allowed(&state, "files.provider-cdn.test").is_ok());
        assert!(
            !state.allow.contains("files.provider-cdn.test"),
            "carve-out must never widen the allowlist"
        );
        // A different host still has no lease.
        assert!(image_host_allowed(&state, "other-cdn.test").is_err());
    }

    #[test]
    fn an_expired_lease_is_refused_again() {
        let state = state_with("cdn.example.com");
        state.record_returned_hosts(r#"{"url":"https://files.provider-cdn.test/a.png"}"#);
        assert!(image_host_allowed(&state, "files.provider-cdn.test").is_ok());
        // Push the lease timestamp past its TTL.
        state.returned_hosts.write().unwrap().insert(
            "files.provider-cdn.test".to_string(),
            Instant::now() - RETURNED_HOST_TTL - Duration::from_secs(1),
        );
        assert!(image_host_allowed(&state, "files.provider-cdn.test").is_err());
    }

    #[test]
    fn body_scanning_is_bounded_and_terminates() {
        let state = state_with("cdn.example.com");
        // Malformed text and a huge body must not hang or open anything.
        state.record_returned_hosts("http:// http:// http://");
        state.record_returned_hosts(&"x".repeat(3 * 1024 * 1024));
        assert!(image_host_allowed(&state, "evil.example.com").is_err());
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
        assert!(matches!(
            check_secret_host(&s, "key:evil", "x.test"),
            Err(EgressError::SecretMissing { .. })
        ));
        let _ = std::fs::remove_dir_all(&s.path);
    }
}
