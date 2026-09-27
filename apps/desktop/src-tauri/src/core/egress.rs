//! egress-gateway (L0): ALL outbound HTTP from the app. The single audited place that
//! combines a secret with a request (invariant 2) and enforces the host allowlist
//! (invariant 3/9 — no telemetry is mechanically true, not aspirational).
//!
//! Contract with TS: the interpreter sends auth headers whose value carries the `{{secret}}`
//! sentinel (e.g. `"Bearer {{secret}}"`). Rust resolves the secretRef from the vault,
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
    #[error("secret {ref_} not found in the local secrets file (re-enter the key)")]
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
    /// A cleartext destination this process refuses. See [`require_secure_scheme`].
    #[error(
        "refusing cleartext {scheme}:// to non-local host {host} — a provider credential would cross the network unencrypted (invariant 3)"
    )]
    InsecureScheme { scheme: String, host: String },
    /// The blocking pool could not run a database closure. **Not** a policy refusal — it is a real
    /// local failure, so it stays out of [`EgressError::is_policy_refusal`].
    #[error("store task failed: {0}")]
    StoreTask(String),
}

impl From<crate::core::store::StoreTaskError> for EgressError {
    fn from(e: crate::core::store::StoreTaskError) -> Self {
        EgressError::StoreTask(e.0)
    }
}

impl EgressError {
    /// **Was this a refusal by this process, or a failure to reach the host?** — the one predicate.
    ///
    /// `HostDenied` is the allowlist; `KeyHostMismatch` is a `secret_ref` pointed at a host it is
    /// not paired with; `InsecureScheme` is a cleartext destination for a credentialed request.
    /// None of the three dialled anything, so none is evidence about the provider, and reporting
    /// any of them as a network failure blames the upstream for a decision taken here (D46).
    ///
    /// **Named once because two surfaces ask the same question** — [`StreamEvent::from_egress_error`]
    /// and `egress_port`'s mapping to `HttpError`. Two spellings of "is this our policy" is how a
    /// stream and a unary request come to disagree about what the same refusal was.
    ///
    /// Everything else stays a transport failure: `BadUrl` and `SentinelMissing` are manifest bugs,
    /// `SecretMissing` is missing configuration, and `Http`/`Store`/`Vault`/`ImageFetch` are real
    /// failures. Widening this is a decision, not a tidy-up.
    pub fn is_policy_refusal(&self) -> bool {
        matches!(
            self,
            EgressError::HostDenied(_)
                | EgressError::KeyHostMismatch { .. }
                | EgressError::InsecureScheme { .. }
        )
    }
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

/// Cloneable because a stalled attempt is re-sent: [`stream`] rebuilds the request for a
/// second attempt, and taking `EgressRequest` by value in [`build`] means the retry needs its
/// own copy rather than a borrow that outlives the first `send`.
#[derive(Debug, Clone, Deserialize)]
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
    Headers {
        status: u16,
        headers: std::collections::BTreeMap<String, String>,
    },
    Line {
        text: String,
    },
    Done,
    Error {
        message: String,
        /// **`true` when the egress refused the request rather than failing to reach the host.**
        ///
        /// Serialised only when set, so every payload this type puts on the Tauri channel is
        /// byte-identical to before for every failure that is not a refusal — an additive change,
        /// not a wire change. See [`crate::core::http_port::HttpErrorKind::Denied`] for why the
        /// distinction has to survive this far.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        denied: bool,
    },
}

impl StreamEvent {
    /// A stream error that is not a policy refusal.
    pub fn error(message: impl Into<String>) -> Self {
        Self::Error { message: message.into(), denied: false }
    }

    /// A stream error that is one. See [`crate::core::http_port::HttpErrorKind::Denied`].
    pub fn denied(message: impl Into<String>) -> Self {
        Self::Error { message: message.into(), denied: true }
    }

    /// Classify an egress failure — **the one place the policy family is named.**
    ///
    /// `HostDenied` and `KeyHostMismatch` are refusals *by this process*: the destination is not in
    /// the allowlist, or a `secret_ref` is pointed at a host it is not paired with. Neither dialled
    /// anything, so neither is evidence about the provider. Every other `EgressError` is a genuine
    /// failure to reach or read the host.
    pub fn from_egress_error(e: &EgressError) -> Self {
        if e.is_policy_refusal() {
            Self::denied(e.to_string())
        } else {
            Self::error(e.to_string())
        }
    }
}

/// May the egress dial `host`? — **the one predicate**, so an assertion about it cannot drift.
///
/// Localhost is permitted unconditionally (§8 note); everything else must be a registered base
/// URL host. [`check_url`] refuses on this answer and `core::activation` skips a provider on it,
/// which is the whole reason it is a function rather than an `if` inside `check_url`: two
/// spellings of "is this host allowed" is how a boot-time assertion comes to disagree with the
/// enforcement it is asserting about.
///
/// The port is not an input — see [`is_local`].
pub fn host_is_permitted(allow: &AllowList, host: &str) -> bool {
    is_local(host) || allow.contains(host)
}

/// **May a credential-bearing request go to this URL at all?** — the scheme half of the same
/// question [`host_is_permitted`] answers for the host.
///
/// `https` is always allowed. `http` is allowed **only for loopback**, which is a primary use case
/// rather than a concession: Ollama listens on 11434 and LM Studio on 1234, both cleartext on this
/// machine, where there is no network to cross. Everywhere else it is refused, because
/// [`inject_secret`] attaches the provider credential to the request and the body carries the
/// prompt — so an `http://` base URL for a remote provider puts both on the wire in plaintext.
///
/// **Measured 2026-09-27: nothing enforced this.** `check_url` checked the host only, and
/// `adapter-spec`'s zod schema used `z.string().url()`, which accepts `http:`. A user who typed
/// `http://` — a typo, or a copied internal URL — got a silent downgrade with no warning at input
/// time and no refusal at request time. Both halves are fixed; this is the enforcement point, and
/// the schema refuses at input time so the operator learns before the first request.
///
/// One predicate, so the unary path, the streaming path, the image carve-out and the redirect
/// policy cannot disagree about which destinations are secure — the same reason
/// [`host_is_permitted`] is a function rather than an `if` inside `check_url`.
pub fn require_secure_scheme(url: &reqwest::Url, host: &str) -> Result<(), EgressError> {
    if url.scheme() == "https" || is_local(host) {
        return Ok(());
    }
    Err(EgressError::InsecureScheme { scheme: url.scheme().to_string(), host: host.to_string() })
}

/// Pure allowlist + URL check (unit-testable).
pub fn check_url(allow: &AllowList, raw: &str) -> Result<reqwest::Url, EgressError> {
    let url = reqwest::Url::parse(raw).map_err(|e| EgressError::BadUrl(e.to_string()))?;
    let host = url.host_str().ok_or_else(|| EgressError::BadUrl(raw.into()))?;
    if !host_is_permitted(allow, host) {
        return Err(EgressError::HostDenied(host.into()));
    }
    // After the allowlist check, not before: an unregistered host is reported as `HostDenied`
    // whatever its scheme, so the two refusals stay distinguishable to a caller and to the tests.
    require_secure_scheme(&url, host)?;
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

/// Inject the vault secret into sentinel headers. Returns the mutated map.
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
    //
    // **Both steps block, and both used to run on the async executor.** The first is a SQLite read
    // behind the store mutex; the second is the vault read, which `stat`s — and may read — a file
    // on disk. They are moved to the blocking pool **together**, so a credentialed request pays one
    // hop rather than two, and the **order is unchanged**: the host pairing is still checked before
    // the secret is fetched, which is the property `check_secret_host`'s own doc calls out.
    let secret = match req.secret_ref.clone() {
        Some(r) => {
            let host = host.to_string();
            let secrets = state.secrets.clone();
            let s = state
                .store
                .offload(move |store| {
                    check_secret_host(store, &r, &host)?;
                    // Through the seam, not `vault::get` directly — see `SecretProvider`. The `?`
                    // still propagates a vault *error* as `EgressError::Vault`, and a `None` from
                    // the provider still means "no secret is stored under this ref", which is a
                    // different answer from "the secrets file could not be read".
                    secrets(&r)?.ok_or_else(|| EgressError::SecretMissing { ref_: r.clone() })
                })
                .await?;
            Some(s)
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
    let host = url.host_str().unwrap_or("");
    image_host_allowed(state, host)?;
    // This carve-out attaches no secret — but a **pre-signed** CDN URL *is* a credential, so a
    // cleartext fetch leaks the signature and the object. Same rule as the credentialed path.
    require_secure_scheme(&url, host)?;
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

/// How long the upstream may take to produce **response headers** before the attempt is
/// abandoned and retried.
///
/// **Split from [`UPSTREAM_IDLE_TIMEOUT`] because one constant was doing two jobs with
/// contradictory requirements, and the retry is what lost.** `stream` bounded *both* the wait for
/// headers and each wait for a chunk by `idle_timeout`, so the pre-headers phase inherited the
/// 120s streaming budget. But the gateway's `FIRST_MSG_TIMEOUT` (`gateway.rs`) fails the request
/// at **30s** and drops the slot, whose `Drop` calls `bridge.cancel` — so a pre-headers stall was
/// aborted by the *gateway* 90s before this layer would have noticed it, and the stall retry
/// written for exactly that case could never fire in production. *(That retry was removed
/// outright on 2026-09-27 — see `UPSTREAM_TRANSPORT_RETRIES` — because a retry that re-sends the
/// same prompt to the same host cannot outrun a bound that is simply too small. The split itself
/// still stands: this constant bounds silence, `UPSTREAM_HEADER_TIMEOUT` bounds the wait for a
/// reply, and only the second is subject to the gateway's first-message bound.)*
///
/// Measured 2026-09-26, on the build that had just added the retry: ledger row 1600,
/// `CANCELLED` at 30 019ms, `tokens_out = 0`, log `bridge produced nothing for 30000ms` bound to
/// `request_id=12` — and **no `connection stalled` line in any log**, which is the proof that the
/// pre-headers bound below was never reached.
///
/// **Sized from the request path's own measurement, and the previous 10s was too small.**
/// `Slot::recv` logs `first_msg_ms`, stamped from *dispatch*, so it is the only in-path
/// time-to-first-byte this system has. Measured 2026-09-27 over every real session (n=54; the
/// mock session writes `first_msg_ms=0` 924 times and is excluded):
///
/// ```text
/// p50 2106ms   p75 3622ms   p90 7126ms   p95 13396ms   p99 18626ms   max 18644ms
/// ```
///
/// At 10s this bound was **manufacturing the stall it was written to survive**: 4/54 requests
/// (7.4%) — 3/24 (12.5%) in the incident session — exceeded it and then *succeeded on the
/// retry*. The bound aborted a healthy slow request, the retry re-sent the identical prompt, and
/// the ledger recorded a `NETWORK` failure for a request that was never broken. Two recoveries
/// were measured directly: attempt 2 delivered **2.80s** after the stall (request 4) and
/// **8.60s** after it (request 16).
///
/// **20s is chosen because 0/54 requests ever needed more than 20s** — so a single attempt now
/// covers every success this system has recorded, with no duplicate upstream call. It also
/// leaves room for the engine's plan budget: see [`crate::core::engine::PLAN_BUDGET`], which is
/// what keeps a *chain* of candidates inside the gateway's `FIRST_MSG_TIMEOUT`.
///
/// The pre-headers phase is still bounded separately from [`UPSTREAM_IDLE_TIMEOUT`], and the
/// split remains load-bearing: this bounds the wait for a *response*, that bounds silence
/// *within* a response. Only this one is subject to the gateway's first-message bound.
/// `pub` because it is one term of a three-constant ordering that spans two modules: the engine's
/// `PLAN_BUDGET` funds each admitted candidate with exactly this much, so the two cannot be tuned
/// independently. See `the_plan_budget_fits_inside_the_gateway_bound`.
pub const UPSTREAM_HEADER_TIMEOUT: Duration = Duration::from_secs(20);

/// How long the upstream may take to produce its **first body byte** — measured from the moment
/// the request is sent, so it encloses [`UPSTREAM_HEADER_TIMEOUT`] rather than following it.
///
/// **This constant is the second half of the 2026-09-27 incident, and the split above stopped one
/// phase short.** [`UPSTREAM_HEADER_TIMEOUT`] took the *wait for headers* out of
/// [`UPSTREAM_IDLE_TIMEOUT`] because that 120s streaming budget is 4x the gateway's
/// `FIRST_MSG_TIMEOUT` — so the gateway's bound always fired first and the retry written for a
/// pre-headers stall could never run. The **wait for the first chunk** was left in the 120s
/// budget, where the identical argument applies and had the identical consequence: the gateway's
/// 30s bound fired first, `Slot`'s `Drop` called `bridge.cancel`, `egress_port`'s cancel watcher
/// aborted the driver, and the `lines` stream ended **cleanly with zero chunks** — which the
/// engine faithfully reports as `Ended::Served` with an empty attempt chain and the ledger
/// faithfully files as `CANCELLED` with `fallback_chain_json = "[]"`. The comment above claimed
/// "only this one is subject to the gateway's first-message bound"; that was false, and this
/// constant is the correction.
///
/// Measured 2026-09-27 on the live gateway, ledger row **1671**: `error_class = CANCELLED`,
/// `latency_ms = 30005`, `fallback_chain_json = []`, `http_status = NULL`, and **no egress line of
/// any kind** for the request. Each of those is forced by the path above and by nothing else:
/// a pre-headers stall logs `upstream sent no response headers` at 20s, and any `>= 400` status
/// becomes `HttpResponse { lines: None }`, which `interpreter.rs` turns into
/// `Err(AttemptError::Transport)` — a *populated* chain. An empty chain with a `CANCELLED` class
/// therefore requires a 2xx whose body never produced a chunk, ended by our own cancel. The
/// sibling case (row 1600, `CANCELLED` at 30 019ms) is named in `UPSTREAM_HEADER_TIMEOUT`'s doc
/// as a *pre-headers* stall; that reading was never measured against the chain, and this one was.
///
/// **Sized at the same 20s, from the same measurement.** `first_msg_ms` (`Slot::recv`) is stamped
/// at dispatch and reaches the first *bridge message*, which is the first content delta — so it is
/// an end-to-end measurement of exactly this phase, path overhead included. Over every real
/// session (n=54) it reads p50 2106ms / p90 7126ms / p99 18626ms / max 18644ms, and 0/54 requests
/// ever needed more than 20s. Bounding the phase as a whole is therefore what that calibration
/// always meant; applying it to the header wait alone is what made it partial.
///
/// **The two are ordered, and the order is what makes the logs discriminate.** The header wait
/// keeps its own sub-bound so a request that never got headers reports *that* (`upstream sent no
/// response headers`) rather than this one, and
/// `the_pre_first_byte_budget_encloses_the_header_budget` pins
/// `UPSTREAM_HEADER_TIMEOUT <= UPSTREAM_FIRST_BYTE_TIMEOUT <= PLAN_BUDGET < FIRST_MSG_TIMEOUT` so
/// the sub-bound cannot come to exceed the phase that contains it.
///
/// **Not retried inside the egress.** `Headers` is already on the sink by the time this expires,
/// so a second dial would replay a status the consumer has read — the same argument the mid-stream
/// idle arm states. The engine is where the recovery belongs: it sees an error with `emitted ==
/// false`, so `attempt_disposition` advances to the next candidate, which is the failover this
/// path could not previously reach because the gateway had already taken the request away.
pub const UPSTREAM_FIRST_BYTE_TIMEOUT: Duration = Duration::from_secs(20);

/// How many *extra* attempts a **transport error** gets — and, deliberately, how many a header
/// timeout gets: **none**.
///
/// **The retry used to be attached to the wrong arm, and that is what the 2026-09-27 incident
/// measured.** In [`stream`], a header timeout looped and retried, while `Ok(Err(e))` — a real
/// transport error — returned immediately. So a socket that reset got no second chance, and a
/// slow-but-alive upstream got a retry that re-sent the *identical prompt to the identical host*
/// and could only ever be as slow as the first attempt. The two arms had it exactly backwards.
///
/// The asymmetry is now justified by what a retry can actually change:
///
/// - **A transport error is a fresh roll.** The connection failed before any response, so the
///   next attempt dials a *different* pooled connection and re-runs [`build`]'s allowlist and
///   secret-host checks from the same inputs. This is where a retry has measured value.
/// - **A header timeout is not a fresh roll.** The prompt and the host are unchanged, so a retry
///   reproduces the same wait. Worse, it spends a second full [`UPSTREAM_HEADER_TIMEOUT`] that
///   the plan budget has already allocated to the next candidate — which is precisely how
///   requests 22/25/26/27 reached 30s and were cancelled by the gateway rather than failed by
///   this layer.
///
/// Safe for the same reason it always was: a failure in the header phase has written **nothing**
/// to the sink — no `Headers`, no `Line`, no `Error` — so the consumer cannot have seen output it
/// would then receive twice. A failure *after* headers is still not retried, because the sink
/// already carries a status the consumer has read. Retries never apply to a refusal either:
/// [`EgressError::is_policy_refusal`] is decided before anything is dialled.
///
/// The cost is bounded and stated: a transport error costs at most
/// `(UPSTREAM_TRANSPORT_RETRIES + 1)` dials, and each is a dial that failed immediately rather
/// than a wait — so this retry cannot consume the plan budget the way the old one did.
const UPSTREAM_TRANSPORT_RETRIES: usize = 1;

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
    // **Send before returning, because the caller does not read the `Err` as an event.** `build` is
    // where the allowlist refusal happens, and *both* consumers of this function treat the `Err` as
    // the command's own failure rather than as something the stream said —
    // `tauri::commands::egress_stream` forwards only what arrives on the sink, and
    // `egress_port`'s driver is spawned with its result dropped. So a denied host sent **nothing at
    // all**, and the consumer reported the one thing that was certainly false: that the egress
    // "ended before reporting response headers". Measured 2026-09-24, found while giving the
    // refusal its own class (D46); the module comment above `egress_port`'s `None` arm claimed that
    // path was unreachable, and it was reachable for exactly this case.
    // **One counter, and it counts transport dials only.** It used to count *header timeouts*,
    // which is the arm whose retry was removed — see `UPSTREAM_TRANSPORT_RETRIES`, where the
    // asymmetry between the two arms is the safety argument rather than an oversight. `req` is
    // cloned per attempt because `build` consumes it and the next attempt needs the same allowlist
    // and secret-host checks to run again from the same inputs.
    //
    // Counted, not subtracted: it can exceed the budget on the way out, and `panic = "abort"`
    // makes an underflowing `usize` a dead daemon rather than a bad number in a log line.
    let mut transport_attempt = 0usize;
    loop {
        let b = match build(state, req.clone()).await {
            Ok(b) => b,
            Err(e) => {
                let _ = sink.send(StreamEvent::from_egress_error(&e));
                return Err(e);
            }
        };
        // Bounded the same way as the chunks below: headers are progress too, and a server that
        // completes the handshake and then never answers is indistinguishable from a stall.
        // **The pre-headers wait is bounded by `header_timeout`, not `idle_timeout`.** Using the
        // streaming budget here is what made a pre-headers retry unreachable: 120s of silence
        // before a retry could even be considered, against a gateway that gives up at 30s. See
        // `UPSTREAM_HEADER_TIMEOUT` for the measurement and for the invariant that keeps the two
        // bounds ordered.
        // Stamped *before* the send, so the deadline below encloses the header wait instead of
        // following it. A deadline stamped after `send()` returns cannot bound a header stall at
        // all — it would restart the clock exactly when the phase it is meant to bound ended.
        let sent_at = Instant::now();
        let sent = tokio::time::timeout(state.header_timeout, b.send()).await;
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
                    let _ = sink.send(StreamEvent::error(format!(
                        "http {status}: {}",
                        body.chars().take(2000).collect::<String>()
                    )));
                    return Ok(());
                }
                let mut stream = res.bytes_stream();
                let mut buf = String::new();
                // **One deadline for the whole pre-first-byte phase, not a second full budget.**
                // Two sequential budgets would let the header wait and the first byte add up past
                // the gateway's bound — the wrong-unit shape
                // `the_plan_budget_fits_inside_the_gateway_bound` exists to forbid. Stamped from
                // `sent_at` so it encloses the header wait. See `UPSTREAM_FIRST_BYTE_TIMEOUT`.
                let first_byte_deadline = sent_at + state.first_byte_timeout;
                let mut saw_byte = false;
                loop {
                    // Each wait for the next chunk is bounded, not the stream as a whole: a
                    // provider that keeps sending is never cut off, however long it runs. Before
                    // the first byte, though, the bound is the *phase* deadline — because that is
                    // the budget the gateway's `FIRST_MSG_TIMEOUT` competes with.
                    let budget = if saw_byte {
                        state.idle_timeout
                    } else {
                        first_byte_deadline.saturating_duration_since(Instant::now())
                    };
                    let next = tokio::time::timeout(budget, stream.next()).await;
                    let chunk = match next {
                        Ok(Some(c)) => c,
                        Ok(None) => break, // upstream closed the stream
                        Err(_) if !saw_byte => {
                            // **The arm that did not exist, and row 1671 is why.** Headers arrived
                            // and the body never started. Bounded by `idle_timeout` this was 120s,
                            // so the gateway's 30s bound always won the race and the request was
                            // filed as a client abort with an empty chain.
                            //
                            // Not retried here; the engine is the recovery. No chunk reached the
                            // sink, so `emitted` is false and the attempt advances to the next
                            // candidate. See `UPSTREAM_FIRST_BYTE_TIMEOUT`.
                            tracing::warn!(
                                first_byte_secs = state.first_byte_timeout.as_secs(),
                                elapsed_ms = sent_at.elapsed().as_millis() as u64,
                                "upstream sent response headers but no body — abandoning the \
                                 attempt",
                            );
                            let _ = sink.send(StreamEvent::error(format!(
                                "upstream sent response headers but no body within {}s — \
                                 abandoning the attempt",
                                state.first_byte_timeout.as_secs()
                            )));
                            return Ok(());
                        }
                        Err(_) => {
                            // Not retried: `Headers` is already on the sink and the consumer has
                            // read a status off it, so a second attempt would replay it. The
                            // trace is the point — this stall left no line in any log before.
                            tracing::warn!(
                                idle_secs = state.idle_timeout.as_secs(),
                                "upstream went silent mid-stream — abandoning the request",
                            );
                            let _ = sink.send(StreamEvent::error(format!(
                                "upstream went silent for {}s — abandoning the stream",
                                state.idle_timeout.as_secs()
                            )));
                            return Ok(());
                        }
                    };
                    match chunk {
                        Ok(bytes) => {
                            if !saw_byte {
                                saw_byte = true;
                                // The instrument this phase never had. `first_msg_ms` measures the
                                // same quantity end to end, but only for requests that *succeed* —
                                // a body that never starts leaves no number anywhere, which is how
                                // 120s of silence survived uncalibrated. Calibrate the next value
                                // of `UPSTREAM_FIRST_BYTE_TIMEOUT` against this line.
                                tracing::info!(
                                    first_byte_ms = sent_at.elapsed().as_millis() as u64,
                                    "upstream delivered its first body byte",
                                );
                            }
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
                            let _ = sink.send(StreamEvent::error(e.to_string()));
                            return Ok(());
                        }
                    }
                }
                if !buf.trim().is_empty() {
                    let _ = sink.send(StreamEvent::Line { text: buf.trim().to_string() });
                }
                let _ = sink.send(StreamEvent::Done);
                return Ok(());
            }
            Ok(Err(e)) => {
                // **The retry that has measured value, and it used to be missing from this arm.**
                // A transport error means the connection failed before any response, so the next
                // attempt dials a *different* pooled connection. That is a fresh roll; the header
                // timeout below is not one.
                transport_attempt += 1;
                if transport_attempt <= UPSTREAM_TRANSPORT_RETRIES && retryable_transport(&e) {
                    tracing::warn!(
                        attempt = transport_attempt as u64,
                        max_attempts = (UPSTREAM_TRANSPORT_RETRIES + 1) as u64,
                        error = %e,
                        "upstream transport error before any response — retrying on a fresh \
                         connection",
                    );
                    continue;
                }
                let _ = sink.send(StreamEvent::error(e.to_string()));
                return Err(e.into());
            }
            Err(_) => {
                // **Not retried, and the absence is the fix rather than an omission.** A header
                // timeout means the upstream accepted the connection and then sent nothing for
                // `header_timeout`. The prompt and the host are unchanged, so a retry reproduces
                // the same wait *and* spends a second full budget the plan had already allocated
                // to the next candidate. That is exactly how requests 22/25/26/27 reached 30s and
                // were cancelled by the gateway instead of failing here with a real class.
                // Measured 2026-09-27 — see `UPSTREAM_TRANSPORT_RETRIES` for the full argument.
                //
                // Still the only trace a pre-output timeout leaves anywhere. Without it the
                // failure reached the ledger as a bare `NETWORK` and no line in any log, which is
                // what made 2026-09-26's two lost turns take a database query to explain.
                tracing::warn!(
                    // The *header* budget, which is the one this arm actually waited out.
                    // Reporting `idle_timeout` here named a number 12x the one that expired, so
                    // the line misdescribed its own cause.
                    header_secs = state.header_timeout.as_secs(),
                    "upstream sent no response headers — abandoning the attempt",
                );
                let _ = sink.send(StreamEvent::error(format!(
                    "upstream sent no response headers for {}s — abandoning the request",
                    state.header_timeout.as_secs()
                )));
                return Ok(());
            }
        }
    }
}

/// Whether a transport failure is worth one more dial on a fresh connection.
///
/// **The predicate is the retry's justification, so it is written as one rather than as
/// "anything that is not a refusal".** `is_connect` and `is_request` are the failures a *new*
/// connection can actually change: refused, reset, DNS, TLS, and a connection closed before the
/// request was written. Each of those returns an error rather than waiting out a budget, so the
/// retry costs the plan almost nothing.
///
/// **`is_timeout` is excluded, and that exclusion is load-bearing for the budget.** A connect
/// timeout means the host is unreachable, and a second dial reproduces it — the same argument that
/// removed the retry from the header-timeout arm, applied one layer down. It also matters
/// arithmetically: `connect_timeout` is 10s, so retrying a connect timeout would make one
/// candidate cost `2 x 10s` on top of its header budget and break the
/// `UPSTREAM_HEADER_TIMEOUT <= PLAN_BUDGET` ordering that `the_plan_budget_fits_inside_the_gateway_bound`
/// pins. With timeouts excluded, a candidate's worst case is exactly one
/// [`UPSTREAM_HEADER_TIMEOUT`], which is what that ordering assumes.
///
/// (The header budget is not a `reqwest::Error` at all — it is a `tokio::time::timeout`
/// `Elapsed` — so this predicate can never accidentally re-enable the retry that
/// [`UPSTREAM_TRANSPORT_RETRIES`] removed.)
///
/// **A body error is excluded deliberately.** By then the request has been written and partly
/// consumed, so a second attempt duplicates work without the fresh-connection benefit that is the
/// entire argument for retrying here.
fn retryable_transport(e: &reqwest::Error) -> bool {
    !e.is_timeout() && !e.is_body() && (e.is_connect() || e.is_request())
}

/// Where a `secret_ref` is resolved to the secret it names.
///
/// **Pluggable for the same reason [`crate::core::gateway::KeyProvider`] is**, and that type's own
/// note is the whole argument: the request path is the one place a provider key is used, so without
/// a seam it cannot be exercised end to end against the real vault. The vault is a file now, but its
/// data dir is a process-global `OnceLock` (`vault.rs:290-292`), so a test could redirect it only
/// once per process — and the first test to do so would decide the data dir for every other test in
/// the binary. Production passes [`vault::get`]; a test passes a closure and gets the
/// whole route (gateway → router → adapter → egress → upstream) with no vault in it.
///
/// **It cannot be used to skip a check.** `check_secret_host` runs before this lookup and
/// `inject_secret` runs after it, and neither consults this value. What moves is where the bytes
/// come from, not whether the request is allowed.
pub type SecretProvider =
    Arc<dyn Fn(&str) -> Result<Option<String>, vault::VaultError> + Send + Sync>;

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
    /// How a `secret_ref` becomes its secret — [`vault::get`] in production.
    secrets: SecretProvider,
    /// Invariant-3 lease: hosts returned in response bodies, valid briefly. A provider
    /// that returns an `imageUrl` on a CDN host the allowlist has never seen may have
    /// THAT host fetched back — scoped, expiring, never persisted to the allowlist.
    returned_hosts: RwLock<HashMap<String, Instant>>,
    /// How long an upstream may stay silent before the request is abandoned.
    ///
    /// **A field rather than the constant read directly in [`stream`], so a test can shrink it.**
    /// Proving that a pre-output stall is retried — and that a post-headers one is not — needs
    /// two abandonment cycles, which at the production budget is a four-minute test and would
    /// never be run. It defaults to [`UPSTREAM_IDLE_TIMEOUT`] and is not read from configuration:
    /// nothing in the UI exposes a silence budget today, and inventing one to make this settable
    /// would be a feature, not a seam.
    idle_timeout: Duration,
    /// How long the upstream may take to produce response headers before the attempt is abandoned
    /// and retried. Separate from `idle_timeout`, and the split is load-bearing rather than
    /// cosmetic — see [`UPSTREAM_HEADER_TIMEOUT`] for the measurement and for the invariant it
    /// holds with the gateway's `FIRST_MSG_TIMEOUT`. A field for the same reason `idle_timeout`
    /// is one: the production budget is longer than any test should be asked to wait.
    header_timeout: Duration,
    /// How long the upstream may take to produce its **first body byte**, measured from the send —
    /// so this encloses `header_timeout` rather than following it.
    ///
    /// A third field for the same reason the other two are fields, and with a sharper edge here:
    /// the defect this bound closes is *only observable as an ordering* between two budgets, so a
    /// test that cannot set them independently cannot tell the fix from the bug. It defaults to
    /// [`UPSTREAM_FIRST_BYTE_TIMEOUT`].
    first_byte_timeout: Duration,
}

/// How long a provider-returned host stays fetchable (invariant 3 carve-out).
const RETURNED_HOST_TTL: Duration = Duration::from_secs(10 * 60);

/// How long an idle pooled connection may be kept before it is evicted.
///
/// **Hardening, not a demonstrated fix, and the comment says so because the difference matters.**
/// A pooled socket the server has already closed is still handed out, and the request then waits
/// on a connection nobody is reading — which presents as an upstream stall rather than as a dead
/// socket. Evicting idle sockets sooner narrows that race. It was added after the 2026-09-26
/// stalls, whose cause was *not* reproduced, so this is a prior against one plausible mechanism
/// and not evidence about it.
const POOL_IDLE_TIMEOUT: Duration = Duration::from_secs(30);

/// TCP keepalive interval on provider connections: probes a socket that is still in the pool
/// but whose peer has gone away, so the failure surfaces as a reset rather than as silence.
const TCP_KEEPALIVE: Duration = Duration::from_secs(60);

impl EgressState {
    /// Connect budget per §3.6; redirect policy vetoes any off-allowlist hop (Blocker 1 of
    /// the Phase 1 diff review).
    pub fn new(allow: Arc<AllowList>, store: Arc<Store>) -> Self {
        Self::with_secret_provider(allow, store, Arc::new(vault::get))
    }

    /// The same state, reading secrets from `secrets` instead of the vault.
    ///
    /// A second constructor rather than a changed signature: `new` has two production callers
    /// (`aiproviderd.rs`, `tauri/app.rs`) and four test ones, and none of them should have to name
    /// the vault to keep the behaviour they already had.
    pub fn with_secret_provider(
        allow: Arc<AllowList>,
        store: Arc<Store>,
        secrets: SecretProvider,
    ) -> Self {
        let allow_clone = allow.clone();
        Self {
            client: reqwest::Client::builder()
                .connect_timeout(std::time::Duration::from_secs(10))
                // v1: never follow redirects. API providers don't 3xx on these endpoints, and
                // reqwest re-sends auth headers (incl. x-api-key, which its default policy does
                // NOT strip cross-host) to the redirect target — that would exfiltrate the key
                // (diff-review Blocker 1). A 3xx surfaces as a classified error instead.
                .redirect(reqwest::redirect::Policy::none())
                // See the two constants for what this is and is not: `POOL_IDLE_TIMEOUT` is
                // hardening against a stalled-but-open socket, not a fix for a measured cause.
                .pool_idle_timeout(POOL_IDLE_TIMEOUT)
                .tcp_keepalive(TCP_KEEPALIVE)
                .tcp_nodelay(true)
                .build()
                .expect("reqwest client"),
            image_client: reqwest::Client::builder()
                .connect_timeout(std::time::Duration::from_secs(10))
                .redirect(reqwest::redirect::Policy::custom(
                    move |attempt: reqwest::redirect::Attempt| {
                        let host = attempt.url().host_str().unwrap_or("").to_lowercase();
                        // The scheme is re-checked on every hop, not only on the first request: a
                        // permitted host that redirects `https` -> `http` would otherwise downgrade
                        // a pre-signed URL to cleartext *after* the initial check had passed. The
                        // credentialed client above sidesteps this entirely by never following a
                        // redirect (`Policy::none`), which is the stronger answer where a key is
                        // attached; here a redirect is legitimate, so the hop must be re-vetted.
                        let secure = attempt.url().scheme() == "https" || is_local(&host);
                        if secure && (is_local(&host) || allow_clone.contains(&host)) {
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
            secrets,
            returned_hosts: RwLock::new(HashMap::new()),
            idle_timeout: UPSTREAM_IDLE_TIMEOUT,
            header_timeout: UPSTREAM_HEADER_TIMEOUT,
            first_byte_timeout: UPSTREAM_FIRST_BYTE_TIMEOUT,
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

    /// **Cleartext to a remote host is refused — the test that fails without
    /// `require_secure_scheme`.** The egress attaches a provider credential to the request
    /// (`inject_secret`) and the body carries the prompt, so an `http://` base URL for a remote
    /// provider puts both on the wire unencrypted. Measured 2026-09-27: nothing enforced this.
    /// `check_url` checked the host only and `adapter-spec`'s schema accepted `http:`, so a user
    /// who typed `http://` — a typo, or a copied internal URL — got a silent downgrade.
    ///
    /// Falsified before it was trusted: deleting the `require_secure_scheme(&url, host)?` call
    /// from `check_url` reddens the assertions below and leaves the loopback ones green.
    #[test]
    fn cleartext_to_a_remote_host_is_refused_even_when_the_host_is_allowlisted() {
        let a = allow_with("openrouter.ai");
        // The host *is* registered, so this is not `HostDenied` — it is the scheme.
        let err = check_url(&a, "http://openrouter.ai/api/v1").unwrap_err();
        assert!(
            matches!(&err, EgressError::InsecureScheme { .. }),
            "expected InsecureScheme, got {err:?}"
        );
        // …and it is a *policy* refusal rather than a transport failure, so a caller does not
        // report it as an unreachable provider — the D46 class, reached by a third route.
        assert!(err.is_policy_refusal(), "a cleartext refusal is our decision, not the network's");
        // The same host over https is untouched.
        assert!(check_url(&a, "https://openrouter.ai/api/v1").is_ok());
    }

    /// The loopback carve-out, pinned — it is the whole reason the rule is a scheme *and* a host
    /// check rather than "https only". Ollama is on 11434 and LM Studio on 1234, both cleartext,
    /// and neither should need a TLS terminator to be usable.
    #[test]
    fn cleartext_stays_legal_on_loopback() {
        let a = AllowList::default();
        assert!(check_url(&a, "http://127.0.0.1:11434/api").is_ok());
        assert!(check_url(&a, "http://localhost:1234/v1").is_ok());
        assert!(check_url(&a, "http://[::1]:8080/v1").is_ok(), "IPv6 loopback is loopback");
        // An unregistered remote host is still refused as `HostDenied` **first**, so the two
        // refusals stay distinguishable instead of both presenting as a scheme problem.
        let err = check_url(&a, "http://evil.example/x").unwrap_err();
        assert!(matches!(&err, EgressError::HostDenied(_)), "got {err:?}");
    }

    /// One predicate, so the credentialed path, the image carve-out and the image redirect policy
    /// cannot drift about which destinations are secure.
    #[test]
    fn the_secure_scheme_predicate_is_shared_and_host_aware() {
        let https = reqwest::Url::parse("https://cdn.example/a.png").unwrap();
        assert!(require_secure_scheme(&https, "cdn.example").is_ok());
        let http_remote = reqwest::Url::parse("http://cdn.example/a.png").unwrap();
        assert!(require_secure_scheme(&http_remote, "cdn.example").is_err());
        // Same scheme, loopback host: permitted.
        let http_local = reqwest::Url::parse("http://127.0.0.1:11434/a.png").unwrap();
        assert!(require_secure_scheme(&http_local, "127.0.0.1").is_ok());
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

/// The secret seam — that an injected provider is what `build` actually consults.
///
/// **This module exists because a seam that compiles is not a seam that is used.** `build` could
/// have gone on calling `vault::get` and every other test in this file would have stayed green:
/// they pass `secret_ref: None` on purpose, so the vault is never reached by any of them.
#[cfg(test)]
mod secret_provider_tests {
    use super::*;

    fn store_with(provider_url: &str, secret_ref: &str) -> Store {
        let dir = std::env::temp_dir().join(format!("aip-secret-{}-{}", std::process::id(), {
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

    /// "No secret under this ref" as the seam's own error type spells it.
    fn nothing() -> Result<Option<String>, vault::VaultError> {
        Ok(None)
    }

    /// A request whose destination host is its own provider's host, so `check_secret_host` passes
    /// and the only thing left that can refuse it is the lookup itself.
    ///
    /// Port 9 has nothing listening, so the `Some` arm below would fail at *connect* rather than at
    /// a listener — and `build` does not connect, which is why neither arm needs a server.
    fn req(secret_ref: &str) -> EgressRequest {
        let mut headers = std::collections::BTreeMap::new();
        headers.insert("Authorization".to_string(), format!("Bearer {SENTINEL}"));
        EgressRequest {
            url: "http://127.0.0.1:9/v1/chat/completions".to_string(),
            method: "POST".to_string(),
            headers,
            body: None,
            secret_ref: Some(secret_ref.to_string()),
            timeout_ms: None,
        }
    }

    /// **Both arms, because one arm alone cannot tell the two designs apart.** A provider answering
    /// `None` and the real vault answering `None` produce the *same* `SecretMissing`, so a
    /// `Some`-only test would stay green against a `build` that ignored the seam entirely. The
    /// `None` arm pins that the provider is consulted, with the ref the request carried; the `Some`
    /// arm pins that its answer is believed.
    ///
    /// **Measured 2026-09-24, by reverting `build` to call `vault::get`:** the test reddens — and it
    /// reddens on the `None` arm's *recording* assertion, not on either `matches!`/`is_ok`. That is
    /// the false pass this test was written to avoid, observed rather than argued: the vault
    /// answering `None` for an unknown ref is indistinguishable from an injected provider doing it.
    #[tokio::test]
    async fn an_injected_provider_is_what_resolves_a_secret_ref() {
        let store = Arc::new(store_with("http://127.0.0.1:9/v1", "key:k1"));
        let path = store.path.clone();
        let asked: Arc<std::sync::Mutex<Vec<String>>> = Arc::new(std::sync::Mutex::new(Vec::new()));

        let refusing =
            EgressState::with_secret_provider(Arc::new(AllowList::default()), store.clone(), {
                let asked = asked.clone();
                Arc::new(move |r: &str| {
                    asked.lock().unwrap().push(r.to_string());
                    nothing()
                })
            });
        assert!(matches!(
            build(&refusing, req("key:k1")).await,
            Err(EgressError::SecretMissing { .. })
        ));
        assert_eq!(
            *asked.lock().unwrap(),
            vec!["key:k1".to_string()],
            "the provider must be asked for the ref the request carried"
        );

        let supplying = EgressState::with_secret_provider(
            Arc::new(AllowList::default()),
            store,
            Arc::new(|_: &str| -> Result<Option<String>, vault::VaultError> {
                Ok(Some("sk-injected".to_string()))
            }),
        );
        assert!(
            build(&supplying, req("key:k1")).await.is_ok(),
            "an injected secret must get past the lookup — if it does not, `build` is still reading \
             the vault and the seam is decoration"
        );
        let _ = std::fs::remove_dir_all(&path);
    }
}

/// Upstream stalls — that a silent upstream is survivable while nothing has been emitted.
///
/// **This module exists because the retry is invisible from every other angle.** The ledger
/// records `NETWORK` either way, the consumer receives the same `StreamEvent::Error` either way,
/// and before 2026-09-26 a stall left no line in any log at all — which is why two lost turns
/// took a database query to explain. The connection count on a listener that accepts and then
/// holds is the only observable that separates "retried" from "not".
///
/// **Both directions are asserted, because a retry that fires when it must not is the worse
/// bug.** Re-sending a request whose headers the consumer has already read replays a status it
/// has already acted on, so the post-headers case pins the *absence* of a retry rather than
/// leaving it unpinned.
#[cfg(test)]
mod stall_tests {
    use super::*;

    use std::io::Write as _;
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Where the listener goes silent: before it writes any byte, after headers only, or after
    /// headers **and one body line**.
    ///
    /// The third shape is the one that matters for the 2026-09-27 second-half fix, and it is the
    /// **control**: it is the only one that reaches the mid-stream idle budget rather than the
    /// pre-first-byte deadline. A "fix" that simply capped every chunk wait would pass the other
    /// two and cut off every slow-but-alive stream, so the control is what tells the two apart.
    #[derive(Clone, Copy)]
    enum Stall {
        BeforeHeaders,
        AfterHeaders,
        AfterFirstByte,
    }

    /// How long a connection is held open without an answer. Comfortably longer than the tests'
    /// idle budget, so the request abandons on **silence** rather than on a closed socket — the
    /// failure under test. A socket closed early would surface as `Ok(Err(_))`, not as a stall.
    const HOLD: Duration = Duration::from_secs(2);

    /// The budget the stall tests run under. A hold at the production 120s is a
    /// four-minute test, which is why [`EgressState::idle_timeout`] is a field at all.
    const TEST_IDLE: Duration = Duration::from_millis(120);

    /// A listener that accepts, counts, and then never answers.
    fn silent_listener(mode: Stall) -> (Arc<AtomicUsize>, String) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let connections = Arc::new(AtomicUsize::new(0));
        let counted = connections.clone();
        std::thread::spawn(move || {
            for incoming in listener.incoming() {
                let mut socket = match incoming {
                    Ok(s) => s,
                    Err(_) => break,
                };
                counted.fetch_add(1, Ordering::SeqCst);
                // **The hold runs on its own thread, and that is what makes the count a usable
                // observable.** Sleeping in the accept loop counts the second connection only
                // after the first hold expires, so the assertion reads `1` for a request that
                // really did dial twice — a harness that answers "not retried" whatever the code
                // does. Measured 2026-09-26: the first run of this test failed on exactly that,
                // with the retry already in place and working.
                std::thread::spawn(move || {
                    // Status line and headers first, for the two shapes that get that far.
                    // `send()` returns on headers, so those are the shapes that turn the stall
                    // into a post-headers one.
                    let head: &[u8] = match mode {
                        Stall::BeforeHeaders => b"",
                        Stall::AfterHeaders => {
                            b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n"
                        }
                        // Headers plus one complete SSE line, so the driver has demonstrably
                        // started reading a body. This is the shape that must stay on the 120s
                        // idle budget.
                        Stall::AfterFirstByte => {
                            b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n\
                              data: {\"x\":1}\n\n"
                        }
                    };
                    // **Read the request before answering, and the ordering is load-bearing.**
                    // The head used to be written on accept, without reading the request at all,
                    // which races the client's request write: hyper can see a response before it has
                    // finished writing, classify the dial as a pre-response transport error, and
                    // retry — so `connections` read `2` and these tests failed **in isolation**, not
                    // merely under load. Measured 2026-09-27: 4 of 10 single-threaded runs red
                    // before this, 0 of 10 after. A real server always reads the request first, so
                    // the old shape exercised a sequence the production path cannot produce: the
                    // code under test was behaving correctly on an input the harness invented.
                    let mut scratch = [0u8; 4096];
                    let _ = socket.set_read_timeout(Some(Duration::from_millis(500)));
                    loop {
                        match std::io::Read::read(&mut socket, &mut scratch) {
                            Ok(0) | Err(_) => break,
                            Ok(n) => {
                                if scratch[..n].windows(4).any(|w| w == b"\r\n\r\n") {
                                    break;
                                }
                            }
                        }
                    }
                    if !head.is_empty() {
                        let _ = socket.write_all(head);
                        let _ = socket.flush();
                    }
                    std::thread::sleep(HOLD);
                });
            }
        });
        (connections, format!("http://127.0.0.1:{port}/v1/chat/completions"))
    }

    /// A listener that accepts, counts, and closes the socket **without writing a single byte**.
    ///
    /// This is the transport-error shape rather than the stall shape: the client sees the
    /// connection end before any response, which is what a stale pooled connection looks like from
    /// inside `reqwest`. The close is immediate, so unlike [`silent_listener`] there is no hold
    /// thread — and the request carries no body (`req`), so there is no write race that could turn
    /// this into an EPIPE and change which predicate the error matches.
    fn closing_listener() -> (Arc<AtomicUsize>, String) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let connections = Arc::new(AtomicUsize::new(0));
        let counted = connections.clone();
        std::thread::spawn(move || {
            for incoming in listener.incoming() {
                match incoming {
                    Ok(socket) => {
                        counted.fetch_add(1, Ordering::SeqCst);
                        drop(socket);
                    }
                    Err(_) => break,
                }
            }
        });
        (connections, format!("http://127.0.0.1:{port}/v1/chat/completions"))
    }

    /// A state whose silence budget is short enough to test, with no secret on the request so the
    /// only thing that can refuse it is the stall itself.
    ///
    /// **All three budgets are shrunk, and leaving one at its production default is not a harmless
    /// omission — it silently changes which path a test exercises.** Measured 2026-09-27: the first
    /// run of the pre-first-byte test failed with `messages: []` because `first_byte_timeout` was
    /// left at 20s while [`HOLD`] is 2s, so the listener closed the socket before any budget could
    /// expire and the stream ended with `Ok(None)` — a *clean* end that sends no error at all. That
    /// is a third way to reach an empty attempt chain, and it is worth knowing about rather than
    /// papering over: see `UPSTREAM_FIRST_BYTE_TIMEOUT`.
    fn state(dir: &std::path::Path) -> EgressState {
        let _ = std::fs::remove_dir_all(dir);
        let store = Arc::new(Store::open(dir).unwrap());
        let mut s = EgressState::new(Arc::new(AllowList::default()), store);
        s.idle_timeout = TEST_IDLE;
        s.header_timeout = TEST_IDLE;
        s.first_byte_timeout = TEST_IDLE;
        s
    }

    fn req(url: String) -> EgressRequest {
        EgressRequest {
            url,
            method: "POST".to_string(),
            headers: std::collections::BTreeMap::new(),
            body: None,
            secret_ref: None,
            timeout_ms: None,
        }
    }

    /// Drain the sink into `(error messages, whether headers were seen)`.
    fn drain(rx: &mut tokio::sync::mpsc::UnboundedReceiver<StreamEvent>) -> (Vec<String>, bool) {
        let mut messages = Vec::new();
        let mut headers = false;
        while let Ok(ev) = rx.try_recv() {
            match ev {
                StreamEvent::Error { message, .. } => messages.push(message),
                StreamEvent::Headers { .. } => headers = true,
                _ => {}
            }
        }
        (messages, headers)
    }

    /// **The retry is gone from this arm, and that is the fix rather than a lost safety net.**
    ///
    /// Inverted 2026-09-27 from `a_stall_before_headers_is_retried_once`. The old assertion
    /// (`connections == 2`) encoded a policy that was then measured to be wrong: a header timeout
    /// means the prompt and the host are unchanged, so the second attempt reproduces the same wait
    /// *and* spends a budget the plan had already allocated to the next candidate. Requests
    /// 22/25/26/27 are the production trace — 20s of retry, then a second candidate entered with
    /// no budget left and cancelled by the gateway at 30s instead of failed here with a real class.
    ///
    /// The expectation stays a literal, for the reason the old test gave and which still holds:
    /// deriving it from the constant makes the assertion a tautology.
    #[tokio::test]
    async fn a_stall_before_headers_is_not_retried() {
        let dir = std::env::temp_dir().join(format!("aip-pre-noretry-{}", std::process::id()));
        let (connections, url) = silent_listener(Stall::BeforeHeaders);
        let s = state(&dir);
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();

        let r = stream(&s, req(url), tx).await;
        assert!(r.is_ok(), "an abandoned stall is not an egress failure: {r:?}");

        let (messages, headers) = drain(&mut rx);
        assert_eq!(
            connections.load(Ordering::SeqCst),
            1,
            "a pre-headers timeout must NOT be re-sent: the prompt and the host are unchanged, so \
             the retry reproduces the same wait and steals the next candidate's budget"
        );
        assert!(!headers, "no status was ever received, so nothing can have been replayed");
        assert_eq!(messages.len(), 1, "exactly one error reaches the consumer: {messages:?}");
        assert!(
            messages[0].contains("no response headers"),
            "the consumer must be told what happened, not merely that something did: {}",
            messages[0]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// **The arm that kept the retry, pinned end to end rather than through the predicate.**
    ///
    /// A listener that accepts and closes without answering is the shape a stale pooled connection
    /// produces, and it is the case a fresh dial genuinely fixes: the next attempt opens a
    /// *different* connection. [`retryable_transport`] is private and takes a `reqwest::Error`
    /// that no test can construct, so the only honest way to pin this is to make a real one happen
    /// and count the dials — a predicate test would prove the policy and not the wiring.
    #[tokio::test]
    async fn a_transport_error_before_headers_is_retried_once() {
        let dir = std::env::temp_dir().join(format!("aip-transport-retry-{}", std::process::id()));
        let (connections, url) = closing_listener();
        let s = state(&dir);
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();

        let _ = stream(&s, req(url), tx).await;
        let _ = drain(&mut rx);

        assert_eq!(
            connections.load(Ordering::SeqCst),
            2,
            "a connection that failed before any response must be dialled once more — a fresh \
             connection is the one thing a retry can actually change"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// **Renamed from `a_stall_after_headers_is_not_retried` on 2026-09-27, and the rename is the
    /// finding.** That test drove `Stall::AfterHeaders` and asserted the message contained
    /// `went silent` — i.e. it asserted the *mid-stream* arm fired for a shape that had received
    /// no body at all. With the pre-first-byte deadline in place the same listener now takes the
    /// missing-body arm, so the old assertion fails and the old name was describing the wrong
    /// phase. The shape was always "before the first byte"; only the budget it landed on changed.
    #[tokio::test]
    async fn a_stall_before_the_first_byte_is_not_retried() {
        let dir = std::env::temp_dir().join(format!("aip-stall-noretry-{}", std::process::id()));
        let (connections, url) = silent_listener(Stall::AfterHeaders);
        let s = state(&dir);
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();

        let r = stream(&s, req(url), tx).await;
        assert!(r.is_ok(), "an abandoned stall is not an egress failure: {r:?}");

        let (messages, headers) = drain(&mut rx);
        assert!(headers, "the consumer must see the status before the break");
        assert_eq!(
            connections.load(Ordering::SeqCst),
            1,
            "a stall after headers must NOT be retried — the consumer already read a status off \
             the sink, and a second attempt would replay it"
        );
        assert_eq!(messages.len(), 1, "exactly one error reaches the consumer: {messages:?}");
        assert!(
            messages[0].contains("no body"),
            "a body that never started must not be reported as a mid-stream silence: {}",
            messages[0]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// **The bound under test is only observable as an ordering, so all three budgets are set
    /// apart here.**
    ///
    /// A harness where `header_timeout`, `first_byte_timeout` and `idle_timeout` are equal cannot
    /// say which one expired — and that is not hypothetical: the suite already contained a
    /// post-headers stall test, it ran all three at `TEST_IDLE`, and it therefore passed against
    /// code whose first-chunk budget was 120s. Calibrating the instrument, not just the reading.
    ///
    /// **Falsified before it was trusted.** With the loop's budget reverted to
    /// `state.idle_timeout` — the pre-fix behaviour, one line — this test fails with
    /// `exactly one error reaches the consumer: []`: the listener's own 2s [`HOLD`] closes the
    /// socket before the 30s idle budget can expire, and the stream ends *cleanly*, which is a
    /// third route to an empty attempt chain. `a_stall_after_the_first_byte_keeps_the_idle_budget`
    /// passes in both versions, which is what makes it a control rather than a second copy of this
    /// test. `a_stall_before_the_first_byte_is_not_retried` also passes in both, and deliberately
    /// so: `Err(_) if !saw_byte` selects on the *phase*, not on which budget expired, so that test
    /// pins the classification while this one pins the budget.
    #[tokio::test]
    async fn a_body_that_never_starts_is_abandoned_on_the_first_byte_budget() {
        let dir = std::env::temp_dir().join(format!("aip-firstbyte-{}", std::process::id()));
        let (connections, url) = silent_listener(Stall::AfterHeaders);
        let mut s = state(&dir);
        // Headers *do* arrive, so the header budget must never be the one that fires.
        s.header_timeout = Duration::from_secs(30);
        // The bound under test. Against the pre-fix code the first chunk was bounded by
        // `idle_timeout`, so this would sit on 30s and fail the watchdog below instead.
        s.first_byte_timeout = Duration::from_millis(120);
        s.idle_timeout = Duration::from_secs(30);
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();

        let started = Instant::now();
        let r = tokio::time::timeout(Duration::from_secs(5), stream(&s, req(url), tx))
            .await
            .expect("the pre-first-byte budget must abandon the attempt, not the watchdog");
        let elapsed = started.elapsed();
        assert!(r.is_ok(), "an abandoned stall is not an egress failure: {r:?}");

        let (messages, headers) = drain(&mut rx);
        assert!(headers, "the consumer must see the status before the body bound fires");
        assert_eq!(
            connections.load(Ordering::SeqCst),
            1,
            "not retried: the status is already on the sink"
        );
        assert_eq!(messages.len(), 1, "exactly one error reaches the consumer: {messages:?}");
        assert!(
            messages[0].contains("no body"),
            "the failure must name the phase that expired, not the mid-stream one: {}",
            messages[0]
        );
        assert!(
            elapsed < Duration::from_secs(2),
            "the 120ms first-byte budget must be what fired, not the 30s idle budget; took {elapsed:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// **The control, and without it a "fix" that capped every chunk wait would pass this suite.**
    ///
    /// Here the body has demonstrably started, so the idle budget governs and the first-byte
    /// deadline must be inert. The idle budget is set *below* the first-byte budget on purpose:
    /// if the pre-first-byte deadline were still in force after the body started, this request
    /// would be abandoned as a *missing body* well before the idle budget expired.
    #[tokio::test]
    async fn a_stall_after_the_first_byte_keeps_the_idle_budget() {
        let dir = std::env::temp_dir().join(format!("aip-midstream-{}", std::process::id()));
        let (connections, url) = silent_listener(Stall::AfterFirstByte);
        let mut s = state(&dir);
        s.header_timeout = Duration::from_secs(30);
        s.first_byte_timeout = Duration::from_millis(120);
        s.idle_timeout = Duration::from_millis(400);
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();

        let started = Instant::now();
        let r = stream(&s, req(url), tx).await;
        let elapsed = started.elapsed();
        assert!(r.is_ok(), "an abandoned stall is not an egress failure: {r:?}");

        let (messages, headers) = drain(&mut rx);
        assert!(headers, "the consumer must see the status");
        assert_eq!(connections.load(Ordering::SeqCst), 1, "not retried");
        assert_eq!(messages.len(), 1, "exactly one error reaches the consumer: {messages:?}");
        assert!(
            messages[0].contains("went silent"),
            "once the body has started the mid-stream budget owns the silence, so the message \
             must say so: {}",
            messages[0]
        );
        assert!(
            elapsed >= Duration::from_millis(350),
            "the 400ms idle budget must be what fired, not the 120ms first-byte deadline; \
             took {elapsed:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// **The ordering between the two budgets *is* the fix, so it gets a test of its own.**
    ///
    /// **The ordering that matters is now a three-constant relationship, and the middle one is the
    /// term nothing else in this suite would notice.**
    ///
    /// The previous form asserted `UPSTREAM_HEADER_TIMEOUT x (retries + 1) < FIRST_MSG_TIMEOUT` —
    /// 10s x 2 = 20s < 30s, true, and **about the wrong unit**. `execute_text` walks the whole
    /// *plan* (`engine.rs:964`), and with two candidates the real worst case was 40s against a 30s
    /// bound, so the last candidate was always cut off mid-attempt. Ledger row 1652 carries both
    /// entries naming `provider: agnes`, and the log at `03:14:37.515` shows entry 2 starting its
    /// own `attempt=1` **18ms after** the gateway had already given up — the reset counter is the
    /// proof that a second `stream` call had begun with no budget left.
    ///
    /// ```text
    /// UPSTREAM_HEADER_TIMEOUT <= UPSTREAM_FIRST_BYTE_TIMEOUT <= PLAN_BUDGET < FIRST_MSG_TIMEOUT
    ///          20s                          20s                    26s              30s
    /// ```
    ///
    /// **The leftmost term was added hours after the two beside it, because this ordering was
    /// still one constant short.** It ordered the *header wait* against the plan, but the first
    /// body byte — the phase that encloses the header wait, and the one the gateway's bound is
    /// actually racing — was bounded by nothing smaller than the 120s idle budget. So the middle
    /// term was checked against a bound the request never had:
    /// `UPSTREAM_HEADER_TIMEOUT <= PLAN_BUDGET` was true and irrelevant, and ledger row 1671 is
    /// what that cost. The added term makes the assertion cover the phase that can actually
    /// overrun, and the `header <= per_attempt` clause keeps the sub-bound from silently
    /// swallowing it.
    ///
    /// The left inequality is what makes `PLAN_BUDGET` a real bound rather than a hope: the engine
    /// admits a candidate only when it can fund a full attempt, so no admitted candidate can run
    /// past the plan. The right inequality is the original one, kept. A deliberate retune of all
    /// three still passes; any single change that breaks an ordering goes red.
    #[test]
    fn the_plan_budget_fits_inside_the_gateway_bound() {
        let header = UPSTREAM_HEADER_TIMEOUT;
        // The phase that actually bounds one attempt is now the whole pre-first-byte window, not
        // the header wait inside it: an attempt that gets headers and then no body costs the full
        // `first_byte` budget, so that is the term the plan has to fund.
        let per_attempt = UPSTREAM_FIRST_BYTE_TIMEOUT;
        let plan = crate::core::engine::PLAN_BUDGET;
        let gateway_bound = crate::core::gateway::FIRST_MSG_TIMEOUT;
        assert!(
            header <= per_attempt,
            "the header wait may cost {header:?} but the phase containing it is only \
             {per_attempt:?}. A sub-bound larger than its enclosing phase can never fire, so the \
             `upstream sent no response headers` line would become unreachable and every stall — \
             including a genuine pre-headers one — would be reported as a missing body."
        );
        assert!(
            per_attempt <= plan,
            "one attempt may cost {per_attempt:?}, but the whole plan is budgeted {plan:?} — a \
             candidate admitted for a full attempt could then overrun the plan. Raise PLAN_BUDGET \
             or lower UPSTREAM_HEADER_TIMEOUT."
        );
        assert!(
            plan < gateway_bound,
            "the plan may spend {plan:?}, but the gateway abandons the request at \
             {gateway_bound:?} — so the last candidate would be cut off mid-attempt, which is \
             exactly the 2026-09-27 defect. Lower PLAN_BUDGET, or raise FIRST_MSG_TIMEOUT with it."
        );
    }
}
