//! local-gateway (L0, Phase 2b): OpenAI-compatible HTTP endpoint (axum) bridging external
//! apps into the webview-hosted router core (§3.3, §3.4, §3.5).
//!
//! Security posture (invariants 10, 11, 15, 16):
//! - binds 127.0.0.1 only;
//! - every request authenticated by the master key BEFORE any routing work; constant-time
//!   compare; per-IP exponential backoff on repeated auth failures;
//! - the master key lives only in the OS keychain (account `masterkey`); reveal is a
//!   Rust-side copy-to-clipboard (§14) — it never enters webview-observable state;
//!   rotation overwrites the account, so the old key dies on the NEXT request read (§3.3);
//! - core unavailable (stale heartbeat): 503 + Retry-After: 1, nothing queued (§3.5);
//! - capacity: 8 concurrent + 32 queued -> 429 + Retry-After;
//! - cancellation: client disconnect drops the Slot -> bridge.cancel(id) -> the webview
//!   aborts the router call -> the provider stream closes.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
#[cfg(test)]
use std::sync::atomic::AtomicUsize;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use rand::Rng as _;
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot, OwnedSemaphorePermit, Semaphore};

use crate::vault;

pub const DEFAULT_PORT: u16 = 8787;
pub const MASTER_ACCOUNT: &str = "masterkey";
const MAX_TOTAL: usize = 8 + 32; // §3.5: 8 concurrent, queue of 32
const HEARTBEAT_STALE_MS: u64 = 6_000;
/// R1: liveness bound while the window is hidden. macOS throttles timers in a hidden window,
/// so the renderer's 2s heartbeat cannot be expected to land on schedule — but it does still
/// run. A looser bound keeps the gateway serving in the background; the cost is that a truly
/// dead renderer is detected after 30s instead of 6s (and only while hidden).
const HEARTBEAT_STALE_HIDDEN_MS: u64 = 30_000;

/// Pluggable master-key lookup so the HTTP surface is testable without touching the real
/// OS keychain. Production passes the vault-backed closure.
pub type KeyProvider = Arc<dyn Fn() -> Option<String> + Send + Sync + 'static>;

/// R4: active per-app key secrets (keychain-backed). Returns only NON-revoked keys, so
/// revocation takes effect on the very next request without rotating anything else.
pub type AppKeyProvider = Arc<dyn Fn() -> Vec<String> + Send + Sync + 'static>;

pub fn vault_key_provider() -> KeyProvider {
    Arc::new(|| vault::get(MASTER_ACCOUNT).ok().flatten())
}

/// Keychain account prefix for a per-app gateway key (audit R4).
pub const APP_KEY_PREFIX: &str = "gwkey:";

/// R4: secrets of every non-revoked per-app key, read from the keychain. Metadata (label,
/// revocation, last-used) lives in SQLite — see `persist.rs`.
pub fn vault_app_key_provider(store: Arc<crate::store::Store>) -> AppKeyProvider {
    Arc::new(move || {
        let ids = crate::persist::active_gateway_key_ids(&store).unwrap_or_default();
        ids.iter()
            .filter_map(|id| vault::get(&format!("{APP_KEY_PREFIX}{id}")).ok().flatten())
            .collect()
    })
}

/// R4: month-to-date spend vs. the configured cap, in micro-USD — `(spent, cap)`, where
/// `cap <= 0` means "no cap". Injected the same way as the key providers so the HTTP surface
/// is testable without SQLite.
pub type SpendProvider = Arc<dyn Fn() -> (i64, i64) + Send + Sync + 'static>;

/// Production spend gate. Reads on every request (not cached): the ledger is capped at 90 days
/// and the SUM is an indexed range scan, so the cost is negligible next to an upstream LLM
/// round-trip — and a stale cap is exactly the failure this feature exists to prevent.
pub fn vault_spend_provider(store: Arc<crate::store::Store>) -> SpendProvider {
    Arc::new(move || {
        let spent = crate::persist::month_spend_micros(&store);
        let cap = crate::persist::spend_cap_micros(&store).unwrap_or(0);
        (spent, cap)
    })
}

// ---------- bridge protocol (Rust <-> webview) ----------

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeRequest {
    pub request_id: u64,
    pub kind: &'static str, // "chat" | "models" | "image"
    pub body: Value,
    /// Select headers forwarded for client detection (User-Agent, X-Client-Name, etc.).
    pub headers: HashMap<String, String>,
}

/// Messages the webview bridge sends back for one request.
#[derive(Debug, Clone)]
pub enum BridgeMsg {
    Delta(String),
    ToolCalls(Value),
    /// Tool execution result from the local sandbox, fed back to the model as a tool role message.
    ToolResult { call_id: String, content: String },
    Result(Value),
    Usage {
        prompt_tokens: u64,
        completion_tokens: u64,
    },
    /// Re-dispatch the request with updated messages (accumulated tool results).
    /// The bridge should append tool results to the conversation and send a new request.
    FollowUp { messages: Vec<serde_json::Value> },
    Done,
    Error { status: u16, message: String },
}

/// Hand-off surface to the router core. Production emits Tauri events; the Phase-2b
/// integration test injects a synthetic bridge (the §3.5 entry-gate spike).
pub trait Bridge: Send + Sync + 'static {
    fn dispatch(&self, req: BridgeRequest);
    fn cancel(&self, request_id: u64);
}

pub struct GatewayCore {
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, mpsc::UnboundedSender<BridgeMsg>>>,
    permits: Arc<Semaphore>,
    last_heartbeat: Mutex<Instant>,
    failures: Mutex<HashMap<IpAddr, (u32, Instant)>>,
    bridge: Arc<dyn Bridge>,
    key_provider: KeyProvider,
    /// R4: optional per-app key secrets. `None` = master key only (all existing tests).
    /// Behind a Mutex so it can be swapped after create/revoke without rebuilding the core.
    app_key_provider: Mutex<Option<AppKeyProvider>>,
    /// R4: optional monthly spend gate. `None` = uncapped (all existing tests).
    spend_provider: Mutex<Option<SpendProvider>>,
    /// R1: window hidden (background mode). Loosens the heartbeat bound — see
    /// `HEARTBEAT_STALE_HIDDEN_MS`.
    hidden: AtomicBool,
    running: AtomicBool,
    port: Mutex<u16>,
    tools_enabled: AtomicBool,
    /// Workspace root for local tool execution (write_file, mkdir, run_command).
    /// Set via `gateway_set_workspace_root` Tauri command before first tool use.
    workspace_root: Mutex<Option<std::path::PathBuf>>,
}

impl GatewayCore {
    pub fn new(bridge: Arc<dyn Bridge>, key_provider: KeyProvider) -> Self {
        // Default workspace root: current process directory, falling back to home.
        let default_root = std::env::current_dir()
            .ok()
            .or_else(|| std::env::var("HOME").map(std::path::PathBuf::from).ok())
            .unwrap_or_default();
        Self {
            next_id: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            permits: Arc::new(Semaphore::new(MAX_TOTAL)),
            last_heartbeat: Mutex::new(Instant::now()),
            failures: Mutex::new(HashMap::new()),
            bridge,
            key_provider,
            app_key_provider: Mutex::new(None),
            spend_provider: Mutex::new(None),
            hidden: AtomicBool::new(false),
            running: AtomicBool::new(false),
            port: Mutex::new(DEFAULT_PORT),
            tools_enabled: AtomicBool::new(false),
            workspace_root: Mutex::new(Some(default_root)),
        }
    }

    /// R4: attach per-app key verification. Kept as a builder so `new()` — and therefore every
    /// existing test — keeps the master-key-only behaviour.
    pub fn with_app_keys(mut self, provider: AppKeyProvider) -> Self {
        self.app_key_provider = Mutex::new(Some(provider));
        self
    }

    /// R4: attach the monthly spend gate. Builder, like `with_app_keys`, so `new()` keeps the
    /// uncapped behaviour every existing test relies on.
    ///
    /// There is deliberately no `set_*` counterpart for either provider: both read the store
    /// on *every* request, so create / revoke / cap-change take effect on the next request with
    /// no swap and no cache to invalidate.
    pub fn with_spend(mut self, provider: SpendProvider) -> Self {
        self.spend_provider = Mutex::new(Some(provider));
        self
    }

    pub fn heartbeat(&self) {
        *self.last_heartbeat.lock().unwrap() = Instant::now();
    }

    pub fn is_available(&self) -> bool {
        let bound = if self.hidden.load(Ordering::Relaxed) {
            HEARTBEAT_STALE_HIDDEN_MS
        } else {
            HEARTBEAT_STALE_MS
        };
        self.running.load(Ordering::Relaxed)
            && self.last_heartbeat.lock().unwrap().elapsed() < Duration::from_millis(bound)
    }

    /// R1: flip background mode. Entering it stamps the heartbeat so the (longer) grace window
    /// starts now rather than part-way through — otherwise a window hidden immediately after
    /// the last beat would trip the short bound before the renderer's next throttled tick.
    pub fn set_hidden(&self, hidden: bool) {
        if self.hidden.swap(hidden, Ordering::Relaxed) != hidden {
            if hidden {
                self.heartbeat();
            }
        }
    }

    pub fn is_hidden(&self) -> bool {
        self.hidden.load(Ordering::Relaxed)
    }

    pub fn set_running(&self, on: bool) {
        self.running.store(on, Ordering::Relaxed);
        if on {
            self.heartbeat();
        }
    }

    pub fn port(&self) -> u16 {
        *self.port.lock().unwrap()
    }

    /// Webview bridge replies land here (gateway_chunk / gateway_result / gateway_done /
    /// gateway_error commands). Unknown/stale id = client already gone -> idempotent no-op.
    pub fn reply(&self, id: u64, msg: BridgeMsg) {
        let tx = self.pending.lock().unwrap().get(&id).cloned();
        if let Some(tx) = tx {
            let terminal = matches!(msg, BridgeMsg::Done | BridgeMsg::Error { .. });
            let _ = tx.send(msg);
            if terminal {
                self.pending.lock().unwrap().remove(&id);
            }
        }
    }

    fn close(&self, id: u64) {
        self.pending.lock().unwrap().remove(&id);
    }

    pub fn is_tools_enabled(&self) -> bool {
        self.tools_enabled.load(Ordering::Relaxed)
    }

    pub fn set_tools_enabled(&self, enabled: bool) {
        self.tools_enabled.store(enabled, Ordering::Relaxed);
    }

    /// Set the workspace root for local tool execution. Must be set before any tool calls.
    pub fn set_workspace_root(&self, root: std::path::PathBuf) {
        *self.workspace_root.lock().unwrap() = Some(root);
    }

    /// Get the current workspace root. Returns None if not set.
    pub fn workspace_root(&self) -> Option<std::path::PathBuf> {
        self.workspace_root.lock().unwrap().clone()
    }

    /// Re-dispatch a request with updated messages (after local tool execution).
    /// The bridge calls this via `gateway_re_dispatch` to continue the agent loop.
    pub fn re_dispatch(&self, id: u64, messages: Vec<serde_json::Value>) {
        let tx = self.pending.lock().unwrap().get(&id).cloned();
        if let Some(tx) = tx {
            let _ = tx.send(BridgeMsg::FollowUp { messages });
        }
    }
}

/// RAII slot: permit + registration + receiver, all released on drop — including on client
/// disconnect mid-stream, which is what makes §3.5 cancellation work.
struct Slot {
    core: Arc<GatewayCore>,
    _permit: OwnedSemaphorePermit,
    id: u64,
    rx: mpsc::UnboundedReceiver<BridgeMsg>,
}

impl Drop for Slot {
    fn drop(&mut self) {
        self.core.close(self.id);
        self.core.bridge.cancel(self.id);
    }
}

/// 503 if the core is unreachable, 429 if over capacity, otherwise the Slot.
fn try_slot(core: &Arc<GatewayCore>) -> Result<Slot, Response> {
    if !core.is_available() {
        return Err(err_ra(
            StatusCode::SERVICE_UNAVAILABLE,
            "1",
            openai_error("AI-Provider Router core unavailable — is the app open?", "service_unavailable", None),
        ));
    }
    let Ok(permit) = core.permits.clone().try_acquire_owned() else {
        return Err(err_ra(StatusCode::TOO_MANY_REQUESTS, "1", openai_error("router at capacity", "rate_limit", None)));
    };
    let id = core.next_id.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = mpsc::unbounded_channel();
    core.pending.lock().unwrap().insert(id, tx);
    Ok(Slot { core: core.clone(), _permit: permit, id, rx })
}

// ---------- auth (invariants 10, 11, 15) ----------

fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    let mut diff = (a.len() ^ b.len()) as u8;
    for i in 0..a.len().max(b.len()) {
        let x = a.get(i).copied().unwrap_or(0);
        let y = b.get(i).copied().unwrap_or(0);
        diff |= x ^ y;
    }
    std::hint::black_box(diff == 0)
}

fn auth_allowed(core: &GatewayCore, ip: IpAddr) -> bool {
    let f = core.failures.lock().unwrap();
    match f.get(&ip) {
        Some((_, until)) => Instant::now() >= *until,
        None => true,
    }
}

fn note_auth_failure(core: &GatewayCore, ip: IpAddr) {
    let mut f = core.failures.lock().unwrap();
    let e = f.entry(ip).or_insert((0, Instant::now()));
    e.0 += 1;
    let delay = Duration::from_millis(500u64.saturating_mul(2u64.pow((e.0 - 1).min(6))));
    e.1 = Instant::now() + delay;
}

/// Returns Some(response) to deny, None to allow. Reads the key providers per request so a
/// rotation/revocation kills the old key instantly (§3.3, criterion 8).
///
/// Accepts the master key OR any active per-app key (audit R4). Master is tried first because
/// it is the common case; per-app secrets are only read when the master does not match, so
/// adding app keys costs nothing on the hot path.
///
/// The brute-force backoff is applied on the FAILURE path only, after the key has been
/// checked. It used to run up front, which meant one bad credential throttled every caller on
/// the loopback — with per-app keys (R4) that is one misconfigured app locking out all the
/// others. Throttling only attempts that would have been rejected anyway keeps the same
/// anti-brute-force bound (one attempt per backoff window) without collateral damage.
fn check_gateway_key(core: &GatewayCore, headers: &HeaderMap, ip: IpAddr) -> Option<Response> {
    if !core.running.load(Ordering::Relaxed) {
        return Some(err_ra(StatusCode::SERVICE_UNAVAILABLE, "1", openai_error("gateway disabled", "service_unavailable", None)));
    }
    let Some(stored) = (core.key_provider)() else {
        return Some(err(StatusCode::UNAUTHORIZED, openai_error("no master key configured", "invalid_request", Some("invalid_api_key"))));
    };
    let presented = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        // Anthropic clients (Claude Code, anthropic-sdk) send the key in x-api-key;
        // Gemini clients use x-goog-api-key (or ?key=, handled in the Gemini handler).
        .or_else(|| headers.get("x-api-key").and_then(|v| v.to_str().ok()))
        .or_else(|| headers.get("x-goog-api-key").and_then(|v| v.to_str().ok()))
        .unwrap_or("");
    let mut matched = constant_time_eq(presented, &stored);
    if !matched {
        // R4: per-app key. Every comparison is constant-time, and we deliberately do NOT break
        // early on a match that is followed by more keys (no length/first-byte oracle).
        // Clone the Arc out of the lock before calling it — never hold a mutex across a
        // keychain read (which can block on a macOS security prompt).
        let app_provider = core.app_key_provider.lock().ok().and_then(|g| g.clone());
        if let Some(provider) = app_provider {
            for secret in provider() {
                if constant_time_eq(presented, &secret) {
                    matched = true;
                }
            }
        }
    }
    if matched {
        core.failures.lock().unwrap().remove(&ip);
        return spend_gate(core);
    }
    if !auth_allowed(core, ip) {
        return Some(err_ra(StatusCode::TOO_MANY_REQUESTS, "30", openai_error("too many failed auth attempts — backing off", "rate_limit", None)));
    }
    note_auth_failure(core, ip);
    Some(err(StatusCode::UNAUTHORIZED, openai_error("invalid gateway key", "invalid_request", Some("invalid_api_key"))))
}

/// R4: deny once month-to-date spend has reached the cap. Checked *after* auth so the cap
/// (and the current spend) is never disclosed to an unauthenticated caller.
///
/// 402 is deliberate: it is the one status clients already read as "you are out of credit",
/// so a runaway agent loop stops retrying instead of hammering a 429/403.
fn spend_gate(core: &GatewayCore) -> Option<Response> {
    // Clone the Arc out of the lock before calling it — never hold a mutex across a DB read.
    let provider = core.spend_provider.lock().ok().and_then(|g| g.clone())?;
    let (spent, cap) = provider();
    if cap > 0 && spent >= cap {
        return Some(err_ra(
            StatusCode::PAYMENT_REQUIRED,
            "0",
            openai_error(
                &format!("monthly spend cap reached — {spent}/{cap} micro-USD this month"),
                "insufficient_quota",
                Some("spend_cap_exceeded"),
            ),
        ));
    }
    None
}

fn openai_error(message: &str, kind: &str, code: Option<&str>) -> Value {
    json!({ "error": { "message": message, "type": kind, "code": code } })
}

/// Anthropic-style error envelope for /v1/messages failures (§3.4 extended 2026-09-16).
fn anthropic_error(message: &str, kind: &str) -> Value {
    json!({ "type": "error", "error": { "type": kind, "message": message } })
}

fn err(status: StatusCode, body: Value) -> Response {
    (status, axum::Json(body)).into_response()
}

fn err_ra(status: StatusCode, retry: &'static str, body: Value) -> Response {
    (status, [(header::RETRY_AFTER, retry)], axum::Json(body)).into_response()
}

fn peer_ip(_headers: &HeaderMap) -> IpAddr {
    IpAddr::V4(Ipv4Addr::LOCALHOST) // loopback bind: single peer namespace (v1)
}

/// Extract headers relevant for client detection (User-Agent, X-Client-Name, etc.).
fn forwarded_headers(headers: &HeaderMap) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for key in ["user-agent", "x-client-name", "x-codex-client", "accept", "x-api-key", "anthropic-version"] {
        if let Some(v) = headers.get(key).and_then(|v| v.to_str().ok()) {
            out.insert(key.to_string(), v.to_string());
        }
    }
    out
}

// ---------- handlers ----------

async fn chat_h(State(core): State<Arc<GatewayCore>>, headers: HeaderMap, body: String) -> Response {
    if let Some(r) = check_gateway_key(&core, &headers, peer_ip(&headers)) {
        return r;
    }
    let Ok(mut req) = serde_json::from_str::<Value>(&body) else {
        return err(StatusCode::BAD_REQUEST, openai_error("invalid JSON body", "invalid_request", None));
    };
    // §3.4 compatibility contract: only reject truly incompatible parameters.
    // Tools/tool_choice/response_format are now forwarded to upstream providers.
    for unsupported in ["functions"] {
        if req.get(unsupported).is_some_and(|v| !v.is_null()) {
            return err(
                StatusCode::BAD_REQUEST,
                openai_error(&format!("{unsupported} is not supported yet"), "invalid_request", Some("unsupported_parameter")),
            );
        }
    }
    if req.get("model").and_then(Value::as_str).unwrap_or("").is_empty() {
        return err(StatusCode::BAD_REQUEST, openai_error("model is required", "invalid_request", None));
    }
    let wants_stream = req.get("stream").and_then(Value::as_bool).unwrap_or(false);
    // §3.4: strip tool fields when the gateway toggle is off
    if !core.is_tools_enabled() {
        if let Some(obj) = req.as_object_mut() {
            obj.remove("tools");
            obj.remove("tool_choice");
            obj.remove("response_format");
        }
    }

    let mut slot = match try_slot(&core) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let id = slot.id;
    let fwd = forwarded_headers(&headers);
    core.bridge.dispatch(BridgeRequest { request_id: id, kind: "chat", body: req.clone(), headers: fwd.clone() });
    tracing::info!(request_id = id, kind = "chat", model = %req.get("model").unwrap_or(&json!("")).as_str().unwrap_or(""), "dispatching chat request");

    if wants_stream {
        // Slot (and its Drop -> bridge.cancel) lives inside the SSE stream: axum drops the
        // stream exactly when the client disconnects or the body finishes.
        let stream_body = async_stream::stream! {
            let mut usage: Option<(u64, u64)> = None;
            let mut tool_pending = false;
            while let Some(msg) = slot.rx.recv().await {
                match msg {
                    BridgeMsg::Delta(t) => {
                        let payload = json!({ "id": format!("gw-{id}"), "object": "chat.completion.chunk",
                            "choices": [{ "index": 0, "delta": { "content": t } }] });
                        yield Ok::<Event, std::convert::Infallible>(Event::default().data(payload.to_string()));
                    }
                    BridgeMsg::Result(_) => {}
                    BridgeMsg::Done => {
                        if tool_pending {
                            // Bridge executed tools and re-dispatched; break to let the
                            // FollowUp handler take over with the next turn.
                            break;
                        }
                        let (pt, ct) = usage.unwrap_or((0, 0));
                        yield Ok::<Event, std::convert::Infallible>(Event::default().data(
                            json!({
                                "id": format!("gw-{id}"),
                                "object": "chat.completion.chunk",
                                "choices": [{
                                    "index": 0,
                                    "delta": {},
                                    "finish_reason": "stop",
                                    "usage": {
                                        "prompt_tokens": pt,
                                        "completion_tokens": ct,
                                        "total_tokens": pt + ct
                                    }
                                }]
                            }).to_string(),
                        ));
                        break;
                    }
                    BridgeMsg::Error { message, .. } => {
                        yield Ok::<Event, std::convert::Infallible>(Event::default().data(
                            json!({ "error": { "message": message, "type": "upstream_error", "code": null } }).to_string(),
                        ));
                        break;
                    }
                    BridgeMsg::ToolCalls(calls) => {
                        // Emit tool calls as OpenAI-shaped SSE chunk so clients receive
                        // structured tool_calls instead of mercury-2.5 pseudo-markup.
                        let payload = json!({
                            "id": format!("gw-{}", id),
                            "object": "chat.completion.chunk",
                            "choices": [{
                                "index": 0,
                                "delta": { "tool_calls": calls },
                                "finish_reason": "tool_calls"
                            }]
                        });
                        yield Ok::<Event, std::convert::Infallible>(Event::default().data(payload.to_string()));
                        tool_pending = true;
                        break;
                    }
                    BridgeMsg::Usage { prompt_tokens, completion_tokens } => {
                        usage = Some((prompt_tokens, completion_tokens));
                    }
                    BridgeMsg::FollowUp { messages } => {
                        // Bridge executed tools and re-dispatched with updated messages.
                        let mut new_chat = req.clone();
                        new_chat["messages"] = json!(messages);
                        core.bridge.dispatch(BridgeRequest { request_id: id, kind: "chat", body: new_chat, headers: fwd.clone() });
                    }
                    BridgeMsg::ToolResult { .. } => {}
                }
            }
            drop(slot);
        };
        return Sse::new(stream_body)
            .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
            .into_response();
    }

    let mut full = String::new();
    let mut tool_calls_json: Option<String> = None;
    let mut tool_pending = false;
    let mut usage: Option<(u64, u64)> = None;
    let mut err_info: Option<(u16, String)> = None;
    while let Some(msg) = slot.rx.recv().await {
        match msg {
            BridgeMsg::Delta(t) => full.push_str(&t),
            BridgeMsg::Result(_) => {}
            BridgeMsg::Done => {
                if tool_pending { break; }
                break;
            }
            BridgeMsg::Error { status, message } => {
                err_info = Some((status, message));
                break;
            }
            BridgeMsg::ToolCalls(calls) => {
                // Buffer tool calls for non-streaming response.
                tool_calls_json = Some(calls.to_string());
                tool_pending = true;
                break;
            }
            BridgeMsg::Usage { prompt_tokens, completion_tokens } => {
                usage = Some((prompt_tokens, completion_tokens));
            }
            BridgeMsg::FollowUp { messages } => {
                let mut new_chat = req.clone();
                new_chat["messages"] = json!(messages);
                core.bridge.dispatch(BridgeRequest { request_id: id, kind: "chat", body: new_chat, headers: fwd.clone() });
            }
            BridgeMsg::ToolResult { .. } => {}
        }
    }
    drop(slot);
    match err_info {
        Some((status, message)) => {
            let code = match status {
                404 => StatusCode::NOT_FOUND,
                429 => StatusCode::TOO_MANY_REQUESTS,
                401 => StatusCode::UNAUTHORIZED,
                _ => StatusCode::BAD_GATEWAY,
            };
            err(code, openai_error(&message, "upstream_error", None))
        }
        None => {
            let mut choice = json!({ "index": 0, "message": { "role": "assistant", "content": full }, "finish_reason": "stop" });
            if let Some(tc) = tool_calls_json {
                let parsed: Value = serde_json::from_str(&tc).unwrap_or_default();
                if !parsed.is_null() {
                    choice["message"]["tool_calls"] = parsed;
                    choice["finish_reason"] = "tool_calls".into();
                }
            }
            if let Some((pt, ct)) = usage {
                choice["usage"] = json!({ "prompt_tokens": pt, "completion_tokens": ct });
            }
            (
                StatusCode::OK,
                [(header::CONTENT_TYPE, "application/json")],
                json!({ "id": format!("gw-{id}"), "object": "chat.completion",
                    "choices": [choice],
                    "usage": usage.as_ref().map(|(pt, ct)| json!({ "prompt_tokens": pt, "completion_tokens": ct })) })
                    .to_string(),
            )
                .into_response()
        }
    }
}

/// Build updated messages from the original chat body + tool call results, then re-dispatch
/// through the bridge so the handler loop can continue collecting more turns.
///
/// Tool result messages are appended as role="tool" entries; the assistant turn that
/// requested the calls is kept as-is so upstream providers see a complete conversation.
fn re_dispatch_with_tool_results(
    core: &Arc<GatewayCore>,
    request_id: u64,
    original_chat: &serde_json::Value,
    tool_calls: &serde_json::Value,
) {
    let mut msgs: Vec<Value> = original_chat.get("messages").cloned().unwrap_or(json!([])).as_array().cloned().unwrap_or_default();
    if let Some(arr) = tool_calls.as_array() {
        for tc in arr {
            let call_id = tc.get("id").and_then(Value::as_str).unwrap_or("");
            let name = tc.get("function").and_then(|f| f.get("name")).and_then(Value::as_str).unwrap_or("");
            let args_raw = tc.get("function").and_then(|f| f.get("arguments")).unwrap_or(&json!(null));
            let _args: String = if let Some(s) = args_raw.as_str() { s.to_string() } else { args_raw.to_string() };
            // Append a tool result message: the bridge will set content via gateway_re_dispatch.
            msgs.push(json!({
                "role": "tool",
                "tool_call_id": call_id,
                "content": format!("[gateway: tool '{}' called, awaiting result]", name),
            }));
        }
    }
    core.re_dispatch(request_id, msgs);
}

async fn models_h(State(core): State<Arc<GatewayCore>>, headers: HeaderMap) -> Response {
    if let Some(r) = check_gateway_key(&core, &headers, peer_ip(&headers)) {
        return r;
    }
    let mut slot = match try_slot(&core) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let id = slot.id;
    core.bridge.dispatch(BridgeRequest { request_id: id, kind: "models", body: json!({}), headers: forwarded_headers(&headers) });
    tracing::info!(request_id = id, kind = "models", "dispatching models request");
    while let Some(msg) = slot.rx.recv().await {
        match msg {
            BridgeMsg::Result(v) => {
                return (StatusCode::OK, [(header::CONTENT_TYPE, "application/json")], v.to_string()).into_response()
            }
            BridgeMsg::Error { message, .. } => {
                return err(StatusCode::BAD_GATEWAY, openai_error(&message, "upstream_error", None))
            }
            BridgeMsg::Done => break,
            BridgeMsg::Delta(_) => {}
            BridgeMsg::ToolCalls(_) => {}
            BridgeMsg::Usage { .. } => {}
            BridgeMsg::ToolResult { .. } => {}
            BridgeMsg::FollowUp { .. } => {}
        }
    }
    err(StatusCode::BAD_GATEWAY, openai_error("empty models response from core", "upstream_error", None))
}

/// Anthropic Messages ingress (2026-09-16 amendment, DECISIONS.md): Claude Code and
/// anthropic-sdk clients can point at this IDE. The request is translated to the router's
/// normalized chat call; the reply is re-framed as Anthropic events. The router core stays
/// provider-agnostic — this is ingress-dialect translation at the edge, symmetric to the
/// egress dialects providers speak.
fn to_chat_body(req: &Value) -> Option<Value> {
    let model = req.get("model").and_then(Value::as_str)?;
    let mut messages: Vec<Value> = Vec::new();
    if let Some(system) = req.get("system").and_then(Value::as_str) {
        messages.push(json!({ "role": "system", "content": system }));
    }
    for m in req.get("messages").and_then(Value::as_array)? {
        let role = m.get("role").and_then(Value::as_str).unwrap_or("user");
        // content: string OR content blocks [{type:"text",text:…}] -> flattened to text
        let content = match m.get("content") {
            Some(Value::String(t)) => t.clone(),
            Some(Value::Array(blocks)) => blocks
                .iter()
                .filter_map(|b| b.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join(""),
            _ => String::new(),
        };
        messages.push(json!({ "role": role, "content": content }));
    }
    let mut out = json!({
        "model": model,
        "messages": messages,
        "stream": req.get("stream").and_then(Value::as_bool).unwrap_or(false),
        "max_tokens": req.get("max_tokens").and_then(Value::as_i64).unwrap_or(1024),
    });
    // forward tools parameters to upstream providers
    if req.get("tools").is_some() {
        out["tools"] = req["tools"].clone();
    }
    if req.get("tool_choice").is_some() {
        out["tool_choice"] = req["tool_choice"].clone();
    }
    if req.get("response_format").is_some() {
        out["response_format"] = req["response_format"].clone();
    }
    Some(out)
}

fn anthropic_stop_reason(cls: Option<&str>) -> &'static str {
    match cls {
        Some("length") => "max_tokens",
        Some("tool_use") => "tool_use",
        _ => "end_turn",
    }
}

async fn messages_h(State(core): State<Arc<GatewayCore>>, headers: HeaderMap, body: String) -> Response {
    if let Some(r) = check_gateway_key(&core, &headers, peer_ip(&headers)) {
        return r;
    }
    let Ok(req) = serde_json::from_str::<Value>(&body) else {
        return err(StatusCode::BAD_REQUEST, anthropic_error("invalid JSON body", "invalid_request_error"));
    };
    let Some(mut chat) = to_chat_body(&req) else {
        return err(
            StatusCode::BAD_REQUEST,
            anthropic_error("model and messages are required", "invalid_request_error"),
        );
    };
    // tools/tool_choice are now forwarded to upstream providers
    // §3.4: strip when toggle is off
    if !core.is_tools_enabled() {
        if let Some(obj) = chat.as_object_mut() {
            obj.remove("tools");
            obj.remove("tool_choice");
            obj.remove("response_format");
        }
    }
    let wants_stream = chat.get("stream").and_then(Value::as_bool).unwrap_or(false);
    let mut slot = match try_slot(&core) {
        Ok(s) => s,
        Err(r) => {
            // map the generic responses to anthropic shape
            let status = r.status().as_u16();
            return err(
                StatusCode::from_u16(status).unwrap_or(StatusCode::SERVICE_UNAVAILABLE),
                anthropic_error("gateway unavailable or at capacity", "overloaded_error"),
            );
        }
    };
    let id = slot.id;
    let msg_id = format!("msg_gw_{id}");
    let model = chat.get("model").and_then(Value::as_str).unwrap_or("").to_string();
    tracing::info!(request_id = id, kind = "anthropic", model = %model, body = %chat.to_string().chars().take(500).collect::<String>(), "dispatching anthropic messages request");
    let fwd = forwarded_headers(&headers);
    core.bridge.dispatch(BridgeRequest { request_id: id, kind: "chat", body: chat, headers: fwd.clone() });

    if wants_stream {
        let mid = msg_id.clone();
        let stream_body = async_stream::stream! {
            // Anthropic SSE: `event: <name>` + `data: <json>` — emit the full lifecycle.
            let start = json!({ "type": "message_start", "message": { "id": mid, "type": "message", "role": "assistant",
                "content": [], "model": model, "stop_reason": null, "usage": { "input_tokens": 0, "output_tokens": 0 } } });
            yield Ok::<Event, std::convert::Infallible>(Event::default().event("message_start").data(start.to_string()));
            yield Ok::<Event, std::convert::Infallible>(Event::default().event("content_block_start")
                .data(json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "text", "text": "" } }).to_string()));
            let mut usage: Option<(u64, u64)> = None;
            let mut has_tool_calls = false;
            while let Some(msg) = slot.rx.recv().await {
                match msg {
                    BridgeMsg::Delta(t) => {
                        tracing::info!(request_id = id, delta_len = t.len(), "anthropic stream delta received");
                        let d = json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": t } });
                        yield Ok::<Event, std::convert::Infallible>(Event::default().event("content_block_delta").data(d.to_string()));
                    }
                    BridgeMsg::Result(_) => {}
                    BridgeMsg::Done => break,
                    BridgeMsg::Error { message, .. } => {
                        let e = json!({ "type": "error", "error": { "type": "overloaded_error", "message": message } });
                        yield Ok::<Event, std::convert::Infallible>(Event::default().event("error").data(e.to_string()));
                        return;
                    }
                    BridgeMsg::ToolCalls(calls) => {
                        // Model returned structured tool calls — emit them as Anthropic tool_use
                        // blocks alongside the accumulated text, then signal stop_reason: tool_use
                        // so clients know a round-trip is required.
                        has_tool_calls = true;
                        if let Some(arr) = calls.as_array() {
                            for (idx, tc) in arr.iter().enumerate() {
                                let call_id = tc.get("id").and_then(Value::as_str).unwrap_or("");
                                let name = tc.get("function").and_then(|f| f.get("name")).and_then(Value::as_str).unwrap_or("");
                                let args_raw = tc.get("function").and_then(|f| f.get("arguments")).unwrap_or(&json!(null));
                                let args: String = if let Some(s) = args_raw.as_str() {
                                    s.to_string()
                                } else {
                                    args_raw.to_string()
                                };
                                let payload = json!({
                                    "type": "content_block_start",
                                    "index": 1 + idx,
                                    "content_block": { "type": "tool_use", "id": call_id, "name": name }
                                });
                                yield Ok::<Event, std::convert::Infallible>(
                                    Event::default().event("content_block_start").data(payload.to_string()),
                                );
                                // input_json_delta: emit the full argument string so the client
                                // receives the completed tool call in one event (Anthropic allows
                                // a single delta carrying the whole JSON).
                                let delta_ev = json!({
                                    "type": "content_block_delta",
                                    "index": 1 + idx,
                                    "delta": { "type": "input_json_delta", "partial_json": args.clone() }
                                });
                                yield Ok::<Event, std::convert::Infallible>(
                                    Event::default().event("content_block_delta").data(delta_ev.to_string()),
                                );
                                let stop_ev = json!({
                                    "type": "content_block_stop",
                                    "index": 1 + idx
                                });
                                yield Ok::<Event, std::convert::Infallible>(
                                    Event::default().event("content_block_stop").data(stop_ev.to_string()),
                                );
                            }
                        }
                        // Fall through to send message_delta + usage on the Done chunk.
                    }
                    BridgeMsg::Usage { prompt_tokens, completion_tokens } => {
                        usage = Some((prompt_tokens, completion_tokens));
                    }
                    BridgeMsg::FollowUp { messages } => {
                        let mut new_chat = req.clone();
                        new_chat["messages"] = json!(messages);
                        core.bridge.dispatch(BridgeRequest { request_id: id, kind: "chat", body: new_chat, headers: fwd.clone() });
                    }
                    BridgeMsg::ToolResult { .. } => {}
                }
            }
            // Only emit stop events if we didn't break for tool execution.
            if !has_tool_calls {
                yield Ok::<Event, std::convert::Infallible>(Event::default().event("content_block_stop")
                    .data(json!({ "type": "content_block_stop", "index": 0 }).to_string()));
                let stop_reason = if has_tool_calls { "tool_use" } else { "end_turn" };
                yield Ok::<Event, std::convert::Infallible>(Event::default().event("message_delta")
                    .data(json!({ "type": "message_delta", "delta": { "stop_reason": stop_reason, "stop_sequence": null },
                        "usage": { "output_tokens": usage.as_ref().map(|(_, ct)| ct).unwrap_or(&0) } }).to_string()));
                yield Ok::<Event, std::convert::Infallible>(Event::default().event("message_stop").data(json!({ "type": "message_stop" }).to_string()));
            }
            drop(slot);
        };
        return Sse::new(stream_body)
            .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
            .into_response();
    }

    let mut full = String::new();
    let mut usage: Option<(u64, u64)> = None;
    let mut err_info: Option<(u16, String)> = None;
    let mut tool_content_blocks: Vec<Value> = Vec::new();
    let mut has_tool_calls = false;
    let mut tool_pending = false;
    while let Some(msg) = slot.rx.recv().await {
        match msg {
            BridgeMsg::Delta(t) => {
                tracing::info!(request_id = id, delta_len = t.len(), "anthropic non-stream delta received");
                full.push_str(&t);
            }
            BridgeMsg::Result(_) => {}
            BridgeMsg::Done => {
                if tool_pending { break; }
                tracing::info!(request_id = id, full_len = full.len(), "anthropic non-stream done");
                break;
            }
            BridgeMsg::Error { status, message } => {
                err_info = Some((status, message));
                break;
            }
            BridgeMsg::ToolCalls(calls) => {
                // Buffer tool calls to include as tool_use blocks in the response.
                has_tool_calls = true;
                tool_pending = true;
                if let Some(arr) = calls.as_array() {
                    for tc in arr {
                        let call_id = tc.get("id").and_then(Value::as_str).unwrap_or("");
                        let name = tc.get("function").and_then(|f| f.get("name")).and_then(Value::as_str).unwrap_or("");
                        let args_raw = tc.get("function").and_then(|f| f.get("arguments")).unwrap_or(&Value::Null);
                        let args: String = if let Some(s) = args_raw.as_str() {
                            s.to_string()
                        } else {
                            args_raw.to_string()
                        };
                        tool_content_blocks.push(json!({
                            "type": "tool_use",
                            "id": call_id,
                            "name": name,
                            "input": serde_json::from_str(&args).unwrap_or(json!(args))
                        }));
                    }
                }
                break;
            }
            BridgeMsg::Usage { prompt_tokens, completion_tokens } => {
                usage = Some((prompt_tokens, completion_tokens));
            }
            BridgeMsg::FollowUp { messages } => {
                let mut new_chat = req.clone();
                new_chat["messages"] = json!(messages);
                core.bridge.dispatch(BridgeRequest { request_id: id, kind: "chat", body: new_chat, headers: fwd.clone() });
            }
            BridgeMsg::ToolResult { .. } => {}
        }
    }
    drop(slot);
    match err_info {
        Some((_, message)) => err(StatusCode::BAD_GATEWAY, anthropic_error(&message, "api_error")),
        None => {
            let prompt_tokens = usage.as_ref().map(|(pt, _)| pt).unwrap_or(&0);
            let completion_tokens = usage.as_ref().map(|(_, ct)| ct).unwrap_or(&0);
            // Build content: text block first, then any tool_use blocks.
            let mut content: Vec<Value> = vec![json!({ "type": "text", "text": full })];
            content.append(&mut tool_content_blocks);
            (
                StatusCode::OK,
                [(header::CONTENT_TYPE, "application/json")],
                json!({
                    "id": msg_id, "type": "message", "role": "assistant",
                    "content": content,
                    "model": model, "stop_reason": anthropic_stop_reason(if has_tool_calls { Some("tool_use") } else { None }), "stop_sequence": null,
                    "usage": { "input_tokens": prompt_tokens, "output_tokens": completion_tokens }
                })
                .to_string(),
            )
                .into_response()
        }
    }
}

/// OpenAI Responses API ingress (v1.1, 2026-09-16): Codex-style clients. Edge translation
/// to the normalized chat call; the router core stays single-surface.
fn to_chat_body_responses(req: &Value) -> Option<Value> {
    let model = req.get("model").and_then(Value::as_str)?;
    let mut messages: Vec<Value> = Vec::new();
    if let Some(inst) = req.get("instructions").and_then(Value::as_str) {
        messages.push(json!({ "role": "system", "content": inst }));
    }
    match req.get("input") {
        Some(Value::String(t)) => messages.push(json!({ "role": "user", "content": t.clone() })),
        Some(Value::Array(items)) => {
            for it in items {
                let role = it.get("role").and_then(Value::as_str).unwrap_or("user");
                let content = match it.get("content") {
                    Some(Value::String(t)) => t.clone(),
                    Some(Value::Array(parts)) => parts
                        .iter()
                        .filter_map(|p| {
                            p.get("text")
                                .and_then(Value::as_str)
                                .or_else(|| p.get("content").and_then(Value::as_str))
                        })
                        .collect::<Vec<_>>()
                        .join(""),
                    _ => String::new(),
                };
                messages.push(json!({ "role": role, "content": content }));
            }
        }
        _ => return None,
    }
    let mut out = json!({
        "model": model,
        "messages": messages,
        "stream": req.get("stream").and_then(Value::as_bool).unwrap_or(false),
        "max_tokens": req.get("max_output_tokens").and_then(Value::as_i64).unwrap_or(1024),
    });
    // forward tools parameters to upstream providers
    if req.get("tools").is_some() {
        out["tools"] = req["tools"].clone();
    }
    if req.get("tool_choice").is_some() {
        out["tool_choice"] = req["tool_choice"].clone();
    }
    Some(out)
}

fn responses_error(message: &str, code: &str) -> Value {
    json!({ "error": { "message": message, "type": "invalid_request_error", "code": code } })
}

/// Strip tools/tool_choice/response_format from a forwarded chat body when the
/// gateway's tools toggle is disabled. Called after translating ingress dialects
/// so the router core never receives those fields when tools are off.
#[allow(dead_code)]
fn strip_tool_fields(body: &mut Value, enabled: bool) {
    if !enabled {
        if let Some(obj) = body.as_object_mut() {
            obj.remove("tools");
            obj.remove("tool_choice");
            obj.remove("response_format");
        }
    }
}

async fn responses_h(State(core): State<Arc<GatewayCore>>, headers: HeaderMap, uri: axum::http::Uri, body: String) -> Response {
    // ?key= fallback for Gemini-style query auth is handled in gemini_h; Responses uses Bearer.
    if let Some(r) = check_gateway_key(&core, &headers, peer_ip(&headers)) {
        return r;
    }
    let _ = uri;
    let Ok(req) = serde_json::from_str::<Value>(&body) else {
        return err(StatusCode::BAD_REQUEST, responses_error("invalid JSON body", "invalid_json"));
    };
    let Some(mut chat) = to_chat_body_responses(&req) else {
        return err(StatusCode::BAD_REQUEST, responses_error("model and input are required", "missing_required_parameter"));
    };
    // Forward tools/tool_choice from the original Responses API request to upstream providers.
    let tools: Option<Value> = req.get("tools").cloned();
    let tool_choice: Option<Value> = req.get("tool_choice").cloned();
    // §3.4: strip when toggle is off
    if !core.is_tools_enabled() {
        if let Some(obj) = chat.as_object_mut() {
            obj.remove("tools");
            obj.remove("tool_choice");
            obj.remove("response_format");
        }
    }
    let wants_stream = chat.get("stream").and_then(Value::as_bool).unwrap_or(false);
    let mut slot = match try_slot(&core) {
        Ok(s) => s,
        Err(r) => return map_generic_to_status(r),
    };
    let id = slot.id;
    let resp_id = format!("resp_gw_{id}");
    let fwd = forwarded_headers(&headers);
    core.bridge.dispatch(BridgeRequest { request_id: id, kind: "responses", body: chat.clone(), headers: fwd.clone() });
    tracing::info!(request_id = id, kind = "responses", model = %chat.get("model").unwrap_or(&json!("")).as_str().unwrap_or(""), "dispatching responses request");

    if wants_stream {
        let rid = resp_id.clone();
        let stream_tools = tools.clone();
        let stream_body = async_stream::stream! {
            let ev = |name: &str, payload: Value| Ok::<Event, std::convert::Infallible>(
                Event::default().event(name).data(payload.to_string()),
            );
            yield ev("response.created", json!({ "type": "response.created", "response": { "id": rid, "object": "response", "status": "in_progress" } }));
            yield ev("response.output_item.added", json!({ "type": "response.output_item.added", "output_index": 0,
                "item": { "id": format!("{rid}_out"), "type": "message", "role": "assistant", "status": "in_progress", "content": [] } }));
            yield ev("response.content_part.added", json!({ "type": "response.content_part.added", "item_id": format!("{rid}_out"), "output_index": 0,
                "content_index": 0, "part": { "type": "output_text", "text": "", "annotations": [] } }));
            let mut text = String::new();
            let mut tool_calls: Vec<(String, String, Value)> = Vec::new(); // call_id, name, arguments
            let mut usage: Option<(u64, u64)> = None;
            let mut tool_pending = false;
            while let Some(msg) = slot.rx.recv().await {
                match msg {
                    BridgeMsg::Delta(t) => {
                        text.push_str(&t);
                        yield ev("response.output_text.delta", json!({ "type": "response.output_text.delta", "item_id": format!("{rid}_out"),
                            "output_index": 0, "content_index": 0, "delta": t }));
                    }
                    BridgeMsg::Result(_) => {}
                    BridgeMsg::Done => {
                        if tool_pending { break; }
                        break;
                    }
                    BridgeMsg::Error { message, .. } => {
                        yield ev("response.failed", json!({ "type": "response.failed",
                            "response": { "id": rid, "object": "response", "status": "failed", "error": { "message": message } } }));
                        return;
                    }
                    BridgeMsg::ToolCalls(calls) => {
                        if let Some(arr) = calls.as_array() {
                            for tc in arr {
                                let call_id = tc.get("id").and_then(Value::as_str).unwrap_or("");
                                let name = tc.get("function").and_then(|f| f.get("name")).and_then(Value::as_str).unwrap_or("");
                                let args_raw = tc.get("function").and_then(|f| f.get("arguments")).unwrap_or(&Value::Null);
                                let args: Value = if let Some(s) = args_raw.as_str() {
                                    serde_json::from_str(s).unwrap_or(json!(s))
                                } else {
                                    args_raw.clone()
                                };
                                tool_calls.push((call_id.to_string(), name.to_string(), args));
                            }
                        }
                        tool_pending = true;
                        break;
                    }
                    BridgeMsg::Usage { prompt_tokens, completion_tokens } => {
                        usage = Some((prompt_tokens, completion_tokens));
                    }
                    BridgeMsg::FollowUp { messages } => {
                        let mut new_chat = req.clone();
                        new_chat["messages"] = json!(messages);
                        core.bridge.dispatch(BridgeRequest { request_id: id, kind: "responses", body: new_chat, headers: fwd.clone() });
                    }
                    BridgeMsg::ToolResult { .. } => {}
                }
            }
            if !tool_pending {
                yield ev("response.output_text.done", json!({ "type": "response.output_text.done", "item_id": format!("{rid}_out"),
                "output_index": 0, "content_index": 0, "text": text.clone() }));
                // Emit any tool-call output items interleaved with the text content.
                let mut content_parts: Vec<Value> = vec![json!({ "type": "output_text", "text": text.clone(), "annotations": [] })];
                for (call_id, name, args) in &tool_calls {
                    yield ev("response.output_item.added", json!({ "type": "response.output_item.added", "output_index": 0,
                        "item": { "id": format!("{rid}_fc_{call_id}"), "type": "function_call", "call_id": call_id, "name": name, "arguments": args.to_string() } }));
                    yield ev("response.function_call_arguments.done", json!({ "type": "response.function_call_arguments.done", "item_id": format!("{rid}_fc_{call_id}"),
                        "output_index": 0, "arguments": args.to_string() }));
                    content_parts.push(json!({ "type": "function_call", "call_id": call_id, "name": name, "arguments": args.to_string() }));
                }
                yield ev("response.content_part.done", json!({ "type": "response.content_part.done", "item_id": format!("{rid}_out"),
                    "output_index": 0, "content_index": 0, "part": { "type": "output_text", "text": text.clone(), "annotations": [] } }));
                yield ev("response.output_item.done", json!({ "type": "response.output_item.done", "output_index": 0,
                    "item": { "id": format!("{rid}_out"), "type": "message", "role": "assistant", "status": "completed",
                        "content": content_parts } }));
                let resolved_tool_choice = stream_tools
                    .as_ref()
                    .map(|_| json!("auto"))
                    .or(tool_choice.as_ref().map(|tc| tc.clone()))
                    .unwrap_or(json!("auto"));
                yield ev("response.completed", json!({ "type": "response.completed",
                    "response": { "id": rid, "object": "response", "status": "completed",
                        "output": [{ "type": "message", "role": "assistant", "content": content_parts }],
                        "usage": { "input_tokens": usage.map(|(p, _c)| p).unwrap_or(0), "output_tokens": usage.map(|(_p, c)| c).unwrap_or(0) },
                        "tools": stream_tools.unwrap_or(json!([])),
                        "tool_choice": resolved_tool_choice
                    } }));
            } else {
                return;
            }
            drop(slot);
        };
        return Sse::new(stream_body).keep_alive(KeepAlive::new().interval(Duration::from_secs(15))).into_response();
    }

    // Non-streaming path.
    let mut full = String::new();
    let mut err_info: Option<(u16, String)> = None;
    let mut tool_calls: Vec<(String, String, Value)> = Vec::new();
    let mut usage: Option<(u64, u64)> = None;
    let mut tool_pending = false;
    while let Some(msg) = slot.rx.recv().await {
        match msg {
            BridgeMsg::Delta(t) => full.push_str(&t),
            BridgeMsg::Result(_) => {}
            BridgeMsg::Done => {
                if tool_pending { break; }
                break;
            }
            BridgeMsg::Error { status, message } => {
                err_info = Some((status, message));
                break;
            }
            BridgeMsg::ToolCalls(calls) => {
                tool_pending = true;
                if let Some(arr) = calls.as_array() {
                    for tc in arr {
                        let call_id = tc.get("id").and_then(Value::as_str).unwrap_or("");
                        let name = tc.get("function").and_then(|f| f.get("name")).and_then(Value::as_str).unwrap_or("");
                        let args_raw = tc.get("function").and_then(|f| f.get("arguments")).unwrap_or(&Value::Null);
                        let args: Value = if let Some(s) = args_raw.as_str() {
                            serde_json::from_str(s).unwrap_or(json!(s))
                        } else {
                            args_raw.clone()
                        };
                        tool_calls.push((call_id.to_string(), name.to_string(), args));
                    }
                }
                break;
            }
            BridgeMsg::Usage { prompt_tokens, completion_tokens } => {
                usage = Some((prompt_tokens, completion_tokens));
            }
            BridgeMsg::FollowUp { messages } => {
                let mut new_chat = req.clone();
                new_chat["messages"] = json!(messages);
                core.bridge.dispatch(BridgeRequest { request_id: id, kind: "responses", body: new_chat, headers: fwd.clone() });
            }
            BridgeMsg::ToolResult { .. } => {}
        }
    }
    drop(slot);
    match err_info {
        Some((_, message)) => err(StatusCode::BAD_GATEWAY, responses_error(&message, "upstream_error")),
        None => {
            let mut content: Vec<Value> = vec![json!({ "type": "output_text", "text": full, "annotations": [] })];
            for (call_id, name, args) in &tool_calls {
                content.push(json!({ "type": "function_call", "call_id": call_id, "name": name, "arguments": args.to_string() }));
            }
            let (pt, ct) = usage.unwrap_or((0, 0));
            let resp_body = json!({
                "id": resp_id, "object": "response", "status": "completed",
                "output": [{ "type": "message", "role": "assistant", "content": content }],
                "usage": { "input_tokens": pt, "output_tokens": ct },
                "tools": tools.unwrap_or(json!([])),
                "tool_choice": tool_choice.unwrap_or(json!("auto"))
            });
            (StatusCode::OK, [(header::CONTENT_TYPE, "application/json")], resp_body.to_string()).into_response()
        }
    }
}

/// Catch-all for unknown `/v1/*` and `/v1beta/*` routes — returns a JSON 404 OpenAI-style error
/// instead of falling through to the Tauri webview HTML 404 page.
async fn unknown_route() -> Response {
    tracing::warn!("unknown gateway route hit");
    err(StatusCode::NOT_FOUND, openai_error("route not found", "not_found", Some("unknown_route")))
}

fn map_generic_to_status(r: Response) -> Response {
    let status = r.status();
    let body = openai_error(
        if status == StatusCode::TOO_MANY_REQUESTS { "router at capacity" } else { "AI-Provider Router core unavailable — is the app open?" },
        if status == StatusCode::TOO_MANY_REQUESTS { "rate_limit" } else { "service_unavailable" },
        None,
    );
    (status, axum::Json(body)).into_response()
}

fn gemini_error(message: &str, status: StatusCode) -> Response {
    (
        status,
        axum::Json(json!({ "error": { "code": status.as_u16(), "message": message, "status": match status.as_u16() {
            400 => "INVALID_ARGUMENT", 401 => "UNAUTHENTICATED", 429 => "RESOURCE_EXHAUSTED", 503 => "UNAVAILABLE", _ => "INTERNAL" } } })),
    )
        .into_response()
}

/// Gemini generateContent ingress (v1.1, 2026-09-16): `x-goog-api-key` or `?key=`, model
/// in the path, contents/parts request and candidates response shapes. SSE via ?alt=sse.
async fn gemini_h(State(core): State<Arc<GatewayCore>>, headers: HeaderMap, uri: axum::http::Uri, body: String) -> Response {
    let query: HashMap<String, String> = uri
        .query()
        .map(|q| {
            url::form_urlencoded::parse(q.as_bytes())
                .map(|(k, v)| (k.into_owned(), v.into_owned()))
                .collect()
        })
        .unwrap_or_default();
    // ?key= is Gemini's legacy auth; fold it into the header check.
    let mut headers2 = headers.clone();
    if headers2.get("x-goog-api-key").is_none() {
        if let Some(k) = query.get("key") {
            if let Ok(v) = HeaderValue::from_str(k) {
                headers2.insert("x-goog-api-key", v);
            }
        }
    }
    if let Some(r) = check_gateway_key(&core, &headers2, peer_ip(&headers)) {
        return r;
    }
    // path: /v1beta/models/<model>:generateContent | :streamGenerateContent
    let path = uri.path().to_string();
    let tail = match path.rsplit("/models/").next() {
        Some(t) => t,
        None => return gemini_error("bad path — expected /v1beta/models/<model>:generateContent", StatusCode::NOT_FOUND),
    };
    let (model, streaming) = match tail.split_once(':') {
        Some((m, "generateContent")) => (m.to_string(), false),
        Some((m, "streamGenerateContent")) => (m.to_string(), true),
        _ => return gemini_error("bad method suffix — expected :generateContent or :streamGenerateContent", StatusCode::BAD_REQUEST),
    };
    if streaming {
        if query.get("alt").map(|v| v.as_str()) != Some("sse") {
            // v1: Gemini streaming is served as SSE only (alt=sse); plain JSON-array
            // streaming is not implemented — refuse rather than answer wrongly.
            return gemini_error("streaming requires ?alt=sse", StatusCode::BAD_REQUEST);
        }
    }
    let Ok(req) = serde_json::from_str::<Value>(&body) else {
        return gemini_error("invalid JSON body", StatusCode::BAD_REQUEST);
    };
    let mut messages: Vec<Value> = Vec::new();
    if let Some(sys) = req.pointer("/systemInstruction/parts") {
        let text = sys
            .as_array()
            .map(|ps| ps.iter().filter_map(|p| p.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join(""))
            .unwrap_or_default();
        if !text.is_empty() {
            messages.push(json!({ "role": "system", "content": text }));
        }
    }
    let Some(contents) = req.get("contents").and_then(Value::as_array) else {
        return gemini_error("contents is required", StatusCode::BAD_REQUEST);
    };
    for c in contents {
        let role = if c.get("role").and_then(Value::as_str) == Some("model") { "assistant" } else { "user" };
        let text = c
            .get("parts")
            .and_then(Value::as_array)
            .map(|ps| ps.iter().filter_map(|p| p.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join(""))
            .unwrap_or_default();
        messages.push(json!({ "role": role, "content": text }));
    }
    let mut chat = json!({
        "model": model,
        "messages": messages,
        "stream": streaming,
        "max_tokens": req.pointer("/generationConfig/maxOutputTokens").and_then(Value::as_i64).unwrap_or(1024),
        "temperature": req.pointer("/generationConfig/temperature").and_then(Value::as_f64),
    });
    // Forward tools/tool_choice/response_format if present so upstream providers receive them.
    if let Some(tools) = req.get("tools").cloned() {
        chat["tools"] = tools;
    }
    if let Some(tc) = req.get("tool_choice").cloned() {
        chat["tool_choice"] = tc;
    }
    if let Some(rf) = req.get("response_format").cloned() {
        chat["response_format"] = rf;
    }
    let mut slot = match try_slot(&core) {
        Ok(s) => s,
        Err(r) => return map_generic_to_status(r),
    };
    let id = slot.id;
    let fwd = forwarded_headers(&headers);
    core.bridge.dispatch(BridgeRequest { request_id: id, kind: "chat", body: chat, headers: fwd.clone() });
    tracing::info!(request_id = id, kind = "gemini", "dispatching gemini request");

    if streaming {
        let stream_body = async_stream::stream! {
            let mut usage: Option<(u64, u64)> = None;
            let mut tool_pending = false;
            while let Some(msg) = slot.rx.recv().await {
                match msg {
                    BridgeMsg::Delta(t) => {
                        let chunk = json!({ "candidates": [{ "content": { "parts": [{ "text": t }], "role": "model" }, "index": 0 }] });
                        yield Ok::<Event, std::convert::Infallible>(Event::default().data(chunk.to_string()));
                    }
                    BridgeMsg::Result(_) => {}
                    BridgeMsg::Done => {
                        if tool_pending { break; }
                        let (pt, ct) = usage.unwrap_or((0, 0));
                        let fin = json!({ "candidates": [{ "finishReason": "STOP" }], "usageMetadata": { "promptTokenCount": pt, "candidatesTokenCount": ct } });
                        yield Ok::<Event, std::convert::Infallible>(Event::default().data(fin.to_string()));
                        break;
                    }
                    BridgeMsg::Error { message, .. } => {
                        let e = json!({ "error": { "code": 502, "message": message, "status": "INTERNAL" } });
                        yield Ok::<Event, std::convert::Infallible>(Event::default().data(e.to_string()));
                        break;
                    }
                    BridgeMsg::ToolCalls(calls) => {
                        // Emit a Gemini functionCall part and signal completion so the client
                        // can send tool results back in the next generateContent call.
                        if let Some(arr) = calls.as_array() {
                            for tc in arr {
                                let _call_id = tc.get("id").and_then(Value::as_str).unwrap_or("");
                                let name = tc.get("function").and_then(|f| f.get("name")).and_then(Value::as_str).unwrap_or("");
                                let args_raw = tc.get("function").and_then(|f| f.get("arguments")).unwrap_or(&json!(null));
                                let args: String = if let Some(s) = args_raw.as_str() {
                                    s.to_string()
                                } else {
                                    args_raw.to_string()
                                };
                                let part = json!({ "functionCall": { "name": name, "args": serde_json::from_str(&args).unwrap_or(json!({})) } });
                                let chunk = json!({ "candidates": [{ "content": { "parts": [part], "role": "model" }, "index": 0, "finishReason": "STOP" }] });
                                yield Ok::<Event, std::convert::Infallible>(Event::default().data(chunk.to_string()));
                            }
                        }
                        let (pt, ct) = usage.unwrap_or((0, 0));
                        let fin = json!({ "usageMetadata": { "promptTokenCount": pt, "candidatesTokenCount": ct } });
                        yield Ok::<Event, std::convert::Infallible>(Event::default().data(fin.to_string()));
                        tool_pending = true;
                        break;
                    }
                    BridgeMsg::Usage { prompt_tokens, completion_tokens } => {
                        usage = Some((prompt_tokens, completion_tokens));
                    }
                    BridgeMsg::FollowUp { messages } => {
                        let mut new_chat = req.clone();
                        new_chat["messages"] = serde_json::to_value(&messages).unwrap_or_default();
                        core.bridge.dispatch(BridgeRequest { request_id: id, kind: "chat", body: new_chat, headers: fwd.clone() });
                    }
                    BridgeMsg::ToolResult { .. } => {}
                }
            }
            drop(slot);
        };
        return Sse::new(stream_body).keep_alive(KeepAlive::new().interval(Duration::from_secs(15))).into_response();
    }

    let mut full = String::new();
    let mut usage: Option<(u64, u64)> = None;
    let mut err_info: Option<(u16, String)> = None;
    let mut has_tool_calls = false;
    let mut tool_parts: Vec<Value> = Vec::new();
    let mut tool_pending = false;
    while let Some(msg) = slot.rx.recv().await {
        match msg {
            BridgeMsg::Delta(t) => full.push_str(&t),
            BridgeMsg::Result(_) => {}
            BridgeMsg::Done => {
                if tool_pending { break; }
                break;
            }
            BridgeMsg::Error { status, message } => {
                err_info = Some((status, message));
                break;
            }
            BridgeMsg::ToolCalls(calls) => {
                has_tool_calls = true;
                tool_pending = true;
                if let Some(arr) = calls.as_array() {
                    for tc in arr {
                        let _call_id = tc.get("id").and_then(Value::as_str).unwrap_or("");
                        let name = tc.get("function").and_then(|f| f.get("name")).and_then(Value::as_str).unwrap_or("");
                        let args_raw = tc.get("function").and_then(|f| f.get("arguments")).unwrap_or(&Value::Null);
                        let args: String = if let Some(s) = args_raw.as_str() {
                            s.to_string()
                        } else {
                            args_raw.to_string()
                        };
                        tool_parts.push(json!({ "functionCall": { "name": name, "args": serde_json::from_str(&args).unwrap_or(json!({})) } }));
                    }
                }
            }
            BridgeMsg::Usage { prompt_tokens, completion_tokens } => {
                usage = Some((prompt_tokens, completion_tokens));
            }
            BridgeMsg::FollowUp { messages } => {
                let mut new_chat = req.clone();
                new_chat["messages"] = serde_json::to_value(&messages).unwrap_or_default();
                core.bridge.dispatch(BridgeRequest { request_id: id, kind: "chat", body: new_chat, headers: fwd.clone() });
            }
            BridgeMsg::ToolResult { .. } => {}
        }
    }
    drop(slot);
    match err_info {
        Some((503, _)) | Some((429, _)) => {
            let code = StatusCode::from_u16(503).unwrap();
            gemini_error("gateway unavailable or at capacity", code)
        }
        Some((_, message)) => gemini_error(&message, StatusCode::BAD_GATEWAY),
        None => {
            let (pt, ct) = usage.unwrap_or((0, 0));
            let finish_reason = if has_tool_calls { "STOP" } else { "STOP" };
            let parts = if has_tool_calls && !tool_parts.is_empty() {
                tool_parts
            } else {
                vec![json!({ "text": full })]
            };
            (
                StatusCode::OK,
                [(header::CONTENT_TYPE, "application/json")],
                json!({
                    "candidates": [{ "content": { "parts": parts, "role": "model" }, "finishReason": finish_reason, "index": 0 }],
                    "usageMetadata": { "promptTokenCount": pt, "candidatesTokenCount": ct, "totalTokenCount": pt + ct }
                })
                .to_string(),
            )
                .into_response()
        }
    }
}

async fn image_h(State(core): State<Arc<GatewayCore>>, headers: HeaderMap, body: String) -> Response {
    if let Some(r) = check_gateway_key(&core, &headers, peer_ip(&headers)) {
        return r;
    }
    let Ok(req) = serde_json::from_str::<Value>(&body) else {
        return err(StatusCode::BAD_REQUEST, openai_error("invalid JSON body", "invalid_request", None));
    };
    if req.get("model").and_then(Value::as_str).unwrap_or("").is_empty()
        || req.get("prompt").and_then(Value::as_str).unwrap_or("").is_empty()
    {
        return err(StatusCode::BAD_REQUEST, openai_error("model and prompt are required", "invalid_request", None));
    }
    let mut slot = match try_slot(&core) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let id = slot.id;
    core.bridge.dispatch(BridgeRequest { request_id: id, kind: "image", body: req, headers: forwarded_headers(&headers) });
    tracing::info!(request_id = id, kind = "image", "dispatching image request");
    while let Some(msg) = slot.rx.recv().await {
        match msg {
            BridgeMsg::Result(v) => {
                return (StatusCode::OK, [(header::CONTENT_TYPE, "application/json")], v.to_string()).into_response()
            }
            BridgeMsg::Error { status, message } => {
                let code = if status == 404 { StatusCode::NOT_FOUND } else { StatusCode::BAD_GATEWAY };
                return err(code, openai_error(&message, "upstream_error", None));
            }
            BridgeMsg::Done => break,
            BridgeMsg::Delta(_) => {}
            BridgeMsg::ToolCalls(_) => {}
            BridgeMsg::Usage { .. } => {}
            BridgeMsg::ToolResult { .. } => {}
            BridgeMsg::FollowUp { .. } => {}
        }
    }    err(StatusCode::BAD_GATEWAY, openai_error("empty image response from core", "upstream_error", None))
}

// ---------- master key + server lifecycle ----------

/// Generate a fresh master key (`sk-aip-` + 32 hex), store it in the keychain, return it
/// exactly once for display (§3.3). Rotation = call again: the old key dies instantly
/// because every request re-reads the keychain.
/// A crypto-random gateway credential. 32 hex chars from OsRng (same shape as the master key,
/// so external apps cannot tell a per-app key from the master one).
pub fn generate_random_key() -> String {
    let raw: String = (0..32).map(|_| format!("{:x}", rand::rngs::OsRng.gen_range(0..16))).collect();
    format!("sk-aip-{raw}")
}

/// Copy arbitrary text to the clipboard host-side (invariant 14: never crosses the DOM).
pub fn copy_text(text: &str) -> Result<(), String> {
    let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    cb.set_text(text.to_string()).map_err(|e| e.to_string())
}

pub fn generate_master_key() -> Result<String, String> {
    let raw: String = (0..32).map(|_| format!("{:x}", rand::rngs::OsRng.gen_range(0..16))).collect();
    let key = format!("sk-aip-{raw}");
    vault::put(MASTER_ACCOUNT, &key).map_err(|e| e.to_string())?;
    Ok(key)
}

pub fn revoke_master_key() -> Result<(), String> {
    vault::delete(MASTER_ACCOUNT).map_err(|e| e.to_string())
}

/// Copy the master key to the clipboard host-side (invariant 14: never crosses the DOM).
pub fn copy_master_key() -> Result<(), String> {
    let key = vault::get(MASTER_ACCOUNT).map_err(|e| e.to_string())?.ok_or("no master key exists")?;
    let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    cb.set_text(key).map_err(|e| e.to_string())
}

pub struct ServerHandle {
    pub shutdown: oneshot::Sender<()>,
    pub addr: SocketAddr,
}

/// Spawn the axum server on 127.0.0.1:port (invariant 11). Bind failure is a loud error
/// with remediation text (invariant 16).
pub async fn spawn(core: Arc<GatewayCore>, port: u16) -> Result<ServerHandle, String> {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let listener = tokio::net::TcpListener::bind(addr).await.map_err(|e| {
        format!("cannot bind {addr}: {e} — another process may squat port {port}; change it in Gateway settings")
    })?;
    let bound = listener.local_addr().map_err(|e| e.to_string())?;
    *core.port.lock().unwrap() = bound.port();
    let app = axum::Router::new()
        .route("/v1/models", get(models_h))
        .route("/v1/chat/completions", post(chat_h))
        .route("/v1/images/generations", post(image_h))
        .route("/v1/messages", post(messages_h))
        .route("/v1/responses", post(responses_h))
        .route("/v1beta/models/{*tail}", post(gemini_h))
        .fallback(unknown_route)
        .with_state(core);
    let (tx, rx) = oneshot::channel::<()>();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = rx.await;
            })
            .await;
    });
    Ok(ServerHandle { shutdown: tx, addr: bound })
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::StreamExt as _;

    /// Synthetic bridge = the §3.5 entry-gate spike: answers chat with deltas + Done,
    /// models/image with JSON, records cancels. Holds a back-pointer to the core so it can
    /// reply.
    struct SynthBridge {
        core: Mutex<Option<Arc<GatewayCore>>>,
        cancels: AtomicUsize,
        slow: AtomicUsize, // dispatch count to delay (for disconnect tests)
    }

    impl SynthBridge {
        fn new() -> Self {
            Self { core: Mutex::new(None), cancels: AtomicUsize::new(0), slow: AtomicUsize::new(0) }
        }
        fn attach(&self, core: &Arc<GatewayCore>) {
            *self.core.lock().unwrap() = Some(core.clone());
        }
    }

    impl Bridge for SynthBridge {
        fn dispatch(&self, req: BridgeRequest) {
            let core = self.core.lock().unwrap().clone().unwrap();
            let slow = self.slow.load(Ordering::Relaxed);
            std::thread::spawn(move || {
                if slow > 0 {
                    std::thread::sleep(Duration::from_millis(slow as u64 * 20));
                }
                match req.kind {
                    "chat" => {
                        core.reply(req.request_id, BridgeMsg::Delta("Hel".into()));
                        core.reply(req.request_id, BridgeMsg::Delta("lo".into()));
                        core.reply(req.request_id, BridgeMsg::Done);
                    }
                    "responses" => {
                        // Same synthetic text output as chat; responses_h wraps it into Responses API frames.
                        core.reply(req.request_id, BridgeMsg::Delta("Hel".into()));
                        core.reply(req.request_id, BridgeMsg::Delta("lo".into()));
                        core.reply(req.request_id, BridgeMsg::Done);
                    }
                    "models" => {
                        core.reply(req.request_id, BridgeMsg::Result(json!({
                            "object": "list",
                            "data": [{ "id": "openrouter/gpt-4o", "object": "model" }, { "id": "opencode/gpt-4o", "object": "model" }]
                        })));
                        core.reply(req.request_id, BridgeMsg::Done);
                    }
                    "image" => {
                        core.reply(req.request_id, BridgeMsg::Result(json!({ "data": [{ "url": "https://img.example/x.png" }] })));
                        core.reply(req.request_id, BridgeMsg::Done);
                    }
                    _ => {}
                }
            });
        }
        fn cancel(&self, _id: u64) {
            self.cancels.fetch_add(1, Ordering::Relaxed);
        }
    }

    struct TestServer {
        client: reqwest::Client,
        base: String,
        core: Arc<GatewayCore>,
        bridge: Arc<SynthBridge>,
        _handle: ServerHandle,
    }

    /// Key provider backed by a mutable slot — simulates rotate/revoke without the keychain.
    fn test_core(key: Arc<Mutex<Option<String>>>) -> (Arc<GatewayCore>, Arc<SynthBridge>) {
        let bridge = Arc::new(SynthBridge::new());
        let core = Arc::new(GatewayCore::new(
            bridge.clone(),
            Arc::new(move || key.lock().unwrap().clone()),
        ));
        bridge.attach(&core);
        (core, bridge)
    }

    async fn start(key: Arc<Mutex<Option<String>>>) -> TestServer {
        let (core, bridge) = test_core(key);
        core.set_running(true);
        let handle = spawn(core.clone(), 0).await.expect("bind ephemeral");
        TestServer {
            client: reqwest::Client::new(),
            base: format!("http://{}", handle.addr),
            core,
            bridge,
            _handle: handle,
        }
    }

    fn chat_body(stream: bool) -> Value {
        json!({ "model": "gpt-4o", "messages": [{ "role": "user", "content": "hi" }], "stream": stream })
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn criterion8_stream_with_master_key() {
        let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
        let s = start(key).await;
        let res = s
            .client
            .post(format!("{}/v1/chat/completions", s.base))
            .header("authorization", "Bearer sk-aip-test")
            .json(&chat_body(true))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        assert_eq!(res.headers()["content-type"], "text/event-stream");
        let mut stream = res.bytes_stream();
        let mut acc = String::new();
        while let Some(chunk) = stream.next().await {
            acc.push_str(&String::from_utf8_lossy(&chunk.unwrap()));
            if acc.contains("finish_reason") && acc.contains("\"stop\"") {
                break;
            }
        }
        assert!(acc.contains("Hel"));
        assert!(acc.contains("lo"));
        assert!(acc.contains("finish_reason") && acc.contains("stop"), "stream must terminate: {acc}");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn criterion8_wrong_key_401() {
        let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
        let s = start(key).await;
        let res = s
            .client
            .post(format!("{}/v1/chat/completions", s.base))
            .header("authorization", "Bearer sk-aip-WRONG")
            .json(&chat_body(false))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 401);
        let body: Value = res.json().await.unwrap();
        assert_eq!(body["error"]["code"], "invalid_api_key");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn criterion8_rotation_kills_old_key_instantly() {
        let key = Arc::new(Mutex::new(Some("sk-aip-old".to_string())));
        let s = start(key.clone()).await;
        // old key works
        let res = s
            .client
            .post(format!("{}/v1/chat/completions", s.base))
            .header("authorization", "Bearer sk-aip-old")
            .json(&chat_body(false))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        // rotate (overwrite keychain slot)
        *key.lock().unwrap() = Some("sk-aip-new".to_string());
        // old key now 401, new key 200 — no restart, per-request read
        let res_old = s
            .client
            .post(format!("{}/v1/chat/completions", s.base))
            .header("authorization", "Bearer sk-aip-old")
            .json(&chat_body(false))
            .send()
            .await
            .unwrap();
        assert_eq!(res_old.status(), 401);
        // invariant 15: the failed attempt put this IP in a short backoff — wait it out
        tokio::time::sleep(Duration::from_millis(600)).await;
        let res_new = s
            .client
            .post(format!("{}/v1/chat/completions", s.base))
            .header("authorization", "Bearer sk-aip-new")
            .json(&chat_body(false))
            .send()
            .await
            .unwrap();
        assert_eq!(res_new.status(), 200);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn non_stream_returns_openai_shape() {
        let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
        let s = start(key).await;
        let res = s
            .client
            .post(format!("{}/v1/chat/completions", s.base))
            .header("authorization", "Bearer sk-aip-test")
            .json(&chat_body(false))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        let body: Value = res.json().await.unwrap();
        assert_eq!(body["object"], "chat.completion");
        assert_eq!(body["choices"][0]["message"]["content"], "Hello");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn anthropic_messages_non_stream() {
        let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
        let s = start(key).await;
        let res = s
            .client
            .post(format!("{}/v1/messages", s.base))
            .header("x-api-key", "sk-aip-test") // Anthropic-style auth header
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&json!({ "model": "mock-fast", "max_tokens": 64,
                "messages": [{ "role": "user", "content": "hi" }] }))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        let body: Value = res.json().await.unwrap();
        assert_eq!(body["type"], "message");
        assert_eq!(body["role"], "assistant");
        assert_eq!(body["content"][0]["type"], "text");
        assert_eq!(body["content"][0]["text"], "Hello");
        assert_eq!(body["stop_reason"], "end_turn");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn anthropic_messages_stream_framing() {
        let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
        let s = start(key).await;
        let res = s
            .client
            .post(format!("{}/v1/messages", s.base))
            .header("x-api-key", "sk-aip-test")
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&json!({ "model": "mock-fast", "max_tokens": 64, "stream": true,
                "messages": [{ "role": "user", "content": [{ "type": "text", "text": "hi" }] }] }))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        let mut acc = String::new();
        let mut stream = res.bytes_stream();
        while let Some(chunk) = stream.next().await {
            acc.push_str(&String::from_utf8_lossy(&chunk.unwrap()));
            if acc.contains("message_stop") {
                break;
            }
        }
        for stage in ["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"] {
            assert!(acc.contains(stage), "missing {stage} in:
{acc}");
        }
        // synth bridge streams "Hel" + "lo" as separate deltas
        assert!(acc.contains("Hel"), "delta text missing");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn anthropic_system_and_bad_request() {
        let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
        let s = start(key).await;
        // system as a top-level string must become a system turn (accepted, 200)
        let res = s
            .client
            .post(format!("{}/v1/messages", s.base))
            .header("x-api-key", "sk-aip-test")
            .header("content-type", "application/json")
            .json(&json!({ "model": "mock-fast", "max_tokens": 8, "system": "be terse",
                "messages": [{ "role": "user", "content": "hi" }] }))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        // missing messages -> anthropic-shaped 400
        let res = s
            .client
            .post(format!("{}/v1/messages", s.base))
            .header("x-api-key", "sk-aip-test")
            .header("content-type", "application/json")
            .json(&json!({ "max_tokens": 8 }))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 400);
        let body: Value = res.json().await.unwrap();
        assert_eq!(body["type"], "error");
        assert_eq!(body["error"]["type"], "invalid_request_error");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn responses_api_non_stream() {
        let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
        let s = start(key).await;
        let res = s
            .client
            .post(format!("{}/v1/responses", s.base))
            .header("authorization", "Bearer sk-aip-test")
            .header("content-type", "application/json")
            .json(&json!({ "model": "mock-fast", "input": "hi", "instructions": "be nice" }))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        let body: Value = res.json().await.unwrap();
        assert_eq!(body["object"], "response");
        assert_eq!(body["status"], "completed");
        assert_eq!(body["output"][0]["content"][0]["text"], "Hello");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn responses_api_stream_events() {
        let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
        let s = start(key).await;
        let res = s
            .client
            .post(format!("{}/v1/responses", s.base))
            .header("authorization", "Bearer sk-aip-test")
            .header("content-type", "application/json")
            .json(&json!({ "model": "mock-fast", "input": [{ "role": "user", "content": "hi" }], "stream": true }))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        let mut acc = String::new();
        let mut stream = res.bytes_stream();
        while let Some(chunk) = stream.next().await {
            acc.push_str(&String::from_utf8_lossy(&chunk.unwrap()));
            if acc.contains("response.completed") {
                break;
            }
        }
        for ev in ["response.created", "response.output_text.delta", "response.output_text.done", "response.completed"] {
            assert!(acc.contains(ev), "missing {ev}");
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn gemini_generate_content() {
        let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
        let s = start(key).await;
        let res = s
            .client
            .post(format!("{}/v1beta/models/mock-fast:generateContent", s.base))
            .header("x-goog-api-key", "sk-aip-test")
            .header("content-type", "application/json")
            .json(&json!({ "contents": [{ "role": "user", "parts": [{ "text": "hi" }] }] }))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        let body: Value = res.json().await.unwrap();
        assert_eq!(body["candidates"][0]["content"]["parts"][0]["text"], "Hello");
        assert_eq!(body["candidates"][0]["finishReason"], "STOP");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn gemini_stream_requires_alt_sse() {
        let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
        let s = start(key).await;
        let res = s
            .client
            .post(format!("{}/v1beta/models/mock-fast:streamGenerateContent", s.base))
            .header("x-goog-api-key", "sk-aip-test")
            .header("content-type", "application/json")
            .json(&json!({ "contents": [{ "parts": [{ "text": "hi" }] }] }))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 400);
        let res = s
            .client
            .post(format!("{}/v1beta/models/mock-fast:streamGenerateContent?alt=sse", s.base))
            .header("x-goog-api-key", "sk-aip-test")
            .header("content-type", "application/json")
            .json(&json!({ "contents": [{ "parts": [{ "text": "hi" }] }] }))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        let mut acc = String::new();
        let mut stream = res.bytes_stream();
        while let Some(chunk) = stream.next().await {
            acc.push_str(&String::from_utf8_lossy(&chunk.unwrap()));
            if acc.contains("finishReason") {
                break;
            }
        }
        assert!(acc.contains("Hel"), "no delta: {acc}");
        assert!(acc.contains("STOP"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn gemini_bad_key_401() {
        let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
        let s = start(key).await;
        let res = s
            .client
            .post(format!("{}/v1beta/models/m:generateContent", s.base))
            .header("x-goog-api-key", "sk-wrong")
            .header("content-type", "application/json")
            .json(&json!({ "contents": [] }))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 401);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn tools_param_forwarded_to_upstream() {
        // tools/tool_choice/response_format are now forwarded to upstream providers
        // this test verifies the gateway accepts them and routes them to the bridge
        let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
        let s = start(key).await;
        let res = s
            .client
            .post(format!("{}/v1/chat/completions", s.base))
            .header("authorization", "Bearer sk-aip-test")
            .json(&json!({ "model": "gpt-4o", "messages": [], "tools": [{"type": "function", "function": {"name": "test"}}], "tool_choice": "auto" }))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn merged_models_qualified_ids() {
        let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
        let s = start(key).await;
        let res = s
            .client
            .get(format!("{}/v1/models", s.base))
            .header("authorization", "Bearer sk-aip-test")
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        let body: Value = res.json().await.unwrap();
        assert_eq!(body["data"][0]["id"], "openrouter/gpt-4o");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn image_generation_routes() {
        let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
        let s = start(key).await;
        let res = s
            .client
            .post(format!("{}/v1/images/generations", s.base))
            .header("authorization", "Bearer sk-aip-test")
            .json(&json!({ "model": "dall-e-3", "prompt": "cat" }))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        let body: Value = res.json().await.unwrap();
        assert_eq!(body["data"][0]["url"], "https://img.example/x.png");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn core_down_answers_503_with_retry_after() {
        let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
        let s = start(key).await;
        s.core.set_running(false);
        let res = s
            .client
            .post(format!("{}/v1/chat/completions", s.base))
            .header("authorization", "Bearer sk-aip-test")
            .json(&chat_body(true))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 503);
        assert_eq!(res.headers()["retry-after"], "1");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn client_disconnect_midstream_cancels_bridge() {
        let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
        let s = start(key).await;
        // Bridge answers slowly; we drop the response stream after the first chunk.
        s.bridge.slow.store(100, Ordering::Relaxed); // delay replies ~2s
        let res = s
            .client
            .post(format!("{}/v1/chat/completions", s.base))
            .header("authorization", "Bearer sk-aip-test")
            .json(&chat_body(true))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        // Drop the stream immediately (client disconnect).
        drop(res);
        // Slot drop -> cancel must be observed.
        for _ in 0..50 {
            if s.bridge.cancels.load(Ordering::Relaxed) > 0 {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("cancel was never propagated to the bridge");
    }

    #[test]
    fn constant_time_eq_basics() {
        assert!(constant_time_eq("abc", "abc"));
        assert!(!constant_time_eq("abc", "abd"));
        assert!(!constant_time_eq("abc", "abcd"));
    }
    // ========== Phase 3: End-to-End Tool Call Verification ==========

    /// Phase 3 Test 1: Verify non-streaming request with tools returns valid response
    #[tokio::test(flavor = "multi_thread")]
    async fn phase3_non_stream_tool_calls_in_response() {
        let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
        let s = start(key).await;
        let res = s
            .client
            .post(format!("{}/v1/chat/completions", s.base))
            .header("authorization", "Bearer sk-aip-test")
            .json(&json!({
                "model": "gpt-4o",
                "messages": [{"role": "user", "content": "run command"}],
                "tools": [{"type": "function", "function": {"name": "bash", "parameters": {"type": "object", "properties": {"command": {"type": "string"}}}}}],
                "stream": false
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        let body: Value = res.json().await.unwrap();
        // The synth bridge returns "Hello" without tool calls, so finish_reason should be "stop"
        assert_eq!(body["choices"][0]["finish_reason"], "stop");
    }

    /// Phase 3 Test 3: Verify tool schema is forwarded to bridge
    #[tokio::test(flavor = "multi_thread")]
    async fn phase3_tools_schema_forwarded() {
        let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
        let s = start(key).await;
        let res = s
            .client
            .post(format!("{}/v1/chat/completions", s.base))
            .header("authorization", "Bearer sk-aip-test")
            .json(&json!({
                "model": "gpt-4o",
                "messages": [{"role": "user", "content": "list files"}],
                "tools": [{
                    "type": "function",
                    "function": {
                        "name": "list_files",
                        "description": "List files in directory",
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "path": {"type": "string", "description": "Directory path"}
                            },
                            "required": ["path"]
                        }
                    }
                }]
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
    }

    /// Phase 3 Test 4: Verify headers are forwarded for client detection
    #[tokio::test(flavor = "multi_thread")]
    async fn phase3_headers_forwarded() {
        let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
        let s = start(key).await;
        let res = s
            .client
            .post(format!("{}/v1/chat/completions", s.base))
            .header("authorization", "Bearer sk-aip-test")
            .header("user-agent", "Claude-Code/1.0")
            .header("x-client-name", "claude-code")
            .json(&chat_body(false))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
    }

    // ---------- audit R4: per-app keys + monthly spend cap ----------

    /// `start()` plus the two R4 providers. Both are `Option` so each test opts into exactly
    /// the behaviour it exercises; `None` reproduces the pre-R4 (master-only, uncapped) path.
    fn core_with(
        key: Arc<Mutex<Option<String>>>,
        app_keys: Option<Arc<Mutex<Vec<String>>>>,
        spend: Option<Arc<Mutex<(i64, i64)>>>,
    ) -> (Arc<GatewayCore>, Arc<SynthBridge>) {
        let bridge = Arc::new(SynthBridge::new());
        let mut core =
            GatewayCore::new(bridge.clone(), Arc::new(move || key.lock().unwrap().clone()));
        if let Some(ak) = app_keys {
            core = core.with_app_keys(Arc::new(move || ak.lock().unwrap().clone()));
        }
        if let Some(sp) = spend {
            core = core.with_spend(Arc::new(move || *sp.lock().unwrap()));
        }
        let core = Arc::new(core);
        bridge.attach(&core);
        (core, bridge)
    }

    async fn start_with(
        app_keys: Option<Arc<Mutex<Vec<String>>>>,
        spend: Option<Arc<Mutex<(i64, i64)>>>,
    ) -> TestServer {
        let master = Arc::new(Mutex::new(Some("sk-aip-master".to_string())));
        let (core, bridge) = core_with(master, app_keys, spend);
        core.set_running(true);
        let handle = spawn(core.clone(), 0).await.expect("bind ephemeral");
        TestServer {
            client: reqwest::Client::new(),
            base: format!("http://{}", handle.addr),
            core,
            bridge,
            _handle: handle,
        }
    }

    async fn post_chat(s: &TestServer, bearer: &str) -> reqwest::Response {
        s.client
            .post(format!("{}/v1/chat/completions", s.base))
            .header("authorization", format!("Bearer {bearer}"))
            .json(&chat_body(false))
            .send()
            .await
            .unwrap()
    }

    /// R4(a): a per-app key authenticates even though it is not the master key — this is what
    /// lets an app be onboarded without handing out the master credential.
    #[tokio::test(flavor = "multi_thread")]
    async fn r4_app_key_authenticates() {
        let s = start_with(Some(Arc::new(Mutex::new(vec!["sk-aip-app1".to_string()]))), None).await;
        let res = post_chat(&s, "sk-aip-app1").await;
        assert_eq!(res.status(), 200, "per-app key must be accepted");
    }

    /// R4(a): revocation is immediate. The provider is re-read per request, so dropping a key
    /// from the active list kills it on the NEXT request — no restart, no master rotation.
    #[tokio::test(flavor = "multi_thread")]
    async fn r4_revoked_app_key_rejected_immediately() {
        let keys = Arc::new(Mutex::new(vec!["sk-aip-app1".to_string()]));
        let s = start_with(Some(keys.clone()), None).await;
        assert_eq!(post_chat(&s, "sk-aip-app1").await.status(), 200);
        keys.lock().unwrap().clear(); // == revoke
        assert_eq!(post_chat(&s, "sk-aip-app1").await.status(), 401);
        // The master key is untouched — revoking one consumer must not break the owner.
        assert_eq!(post_chat(&s, "sk-aip-master").await.status(), 200);
    }

    /// R4(a): an unrecognised key is still rejected when app keys are configured, and the
    /// failure is recorded (so the brute-force backoff still applies).
    #[tokio::test(flavor = "multi_thread")]
    async fn r4_unknown_key_still_rejected() {
        let s = start_with(Some(Arc::new(Mutex::new(vec!["sk-aip-app1".to_string()]))), None).await;
        let res = post_chat(&s, "sk-aip-nope").await;
        assert_eq!(res.status(), 401);
        let body: Value = res.json().await.unwrap();
        assert_eq!(body["error"]["code"], "invalid_api_key");
    }

    /// R4(a): the backoff window opened by a bad credential must not throttle a caller that
    /// authenticates correctly — otherwise one misconfigured app DoSes the rest for 500ms+
    /// per failure. It must still throttle a *second* bad attempt inside the window.
    #[tokio::test(flavor = "multi_thread")]
    async fn r4_valid_key_not_throttled_by_another_callers_failures() {
        let s = start_with(None, None).await;
        assert_eq!(post_chat(&s, "wrong").await.status(), 401);
        assert_eq!(post_chat(&s, "wrong").await.status(), 429, "repeat failures are throttled");
        // The load-bearing assertion: inside an open backoff window a *correct* key still
        // gets through (and, by clearing the counter, closes the window).
        assert_eq!(post_chat(&s, "sk-aip-master").await.status(), 200);
        assert_eq!(post_chat(&s, "wrong").await.status(), 401, "success resets the counter");
    }

    /// R4(b): at or over the cap the gateway refuses with 402 instead of spending more.
    #[tokio::test(flavor = "multi_thread")]
    async fn r4_spend_cap_blocks_at_threshold() {
        let s = start_with(None, Some(Arc::new(Mutex::new((50, 50))))).await;
        let res = post_chat(&s, "sk-aip-master").await;
        assert_eq!(res.status(), 402);
        let body: Value = res.json().await.unwrap();
        assert_eq!(body["error"]["type"], "insufficient_quota");
        assert_eq!(body["error"]["code"], "spend_cap_exceeded");
    }

    /// R4(b): strictly under the cap the request proceeds — the gate must not be off-by-one.
    #[tokio::test(flavor = "multi_thread")]
    async fn r4_spend_cap_allows_under_threshold() {
        let s = start_with(None, Some(Arc::new(Mutex::new((49, 50))))).await;
        assert_eq!(post_chat(&s, "sk-aip-master").await.status(), 200);
    }

    /// R4(b): cap 0 means disabled, not "zero budget" — otherwise enabling the feature with a
    /// cleared field would brick the gateway.
    #[tokio::test(flavor = "multi_thread")]
    async fn r4_spend_cap_zero_disables() {
        let s = start_with(None, Some(Arc::new(Mutex::new((999_999, 0))))).await;
        assert_eq!(post_chat(&s, "sk-aip-master").await.status(), 200);
    }

    /// R4(b): the cap is checked after auth, so an unauthenticated caller gets 401 — never a
    /// 402 that would disclose the configured budget and current spend.
    #[tokio::test(flavor = "multi_thread")]
    async fn r4_spend_cap_not_disclosed_to_unauthenticated() {
        let s = start_with(None, Some(Arc::new(Mutex::new((500, 50))))).await;
        let res = post_chat(&s, "wrong-key").await;
        assert_eq!(res.status(), 401, "spend state must not leak pre-auth");
    }

    // ---------- audit R1: background mode liveness ----------

    /// R1: a hidden window's heartbeat is throttled by the OS, so the liveness bound must
    /// relax — 6s would drop every request while the app sits in the background.
    #[test]
    fn r1_hidden_loosens_the_heartbeat_bound() {
        let core = GatewayCore::new(Arc::new(SynthBridge::new()), Arc::new(|| Some("k".into())));
        core.set_running(true);
        assert!(core.is_available());

        // Age the heartbeat past the visible bound (6s) but inside the hidden one (30s).
        *core.last_heartbeat.lock().unwrap() = Instant::now() - Duration::from_millis(7_000);
        assert!(!core.is_available(), "stale beat must fail while visible");

        core.set_hidden(true);
        assert!(core.is_available(), "hidden mode must tolerate a throttled beat");
        assert!(core.is_hidden());
    }

    /// R1: entering background stamps the heartbeat. Without this, hiding right before the
    /// beat was due would trip the short bound during the first throttled interval.
    #[test]
    fn r1_entering_background_stamps_the_heartbeat() {
        let core = GatewayCore::new(Arc::new(SynthBridge::new()), Arc::new(|| Some("k".into())));
        core.set_running(true);
        *core.last_heartbeat.lock().unwrap() = Instant::now() - Duration::from_millis(10_000);
        assert!(!core.is_available());
        core.set_hidden(true);
        assert!(core.is_available(), "set_hidden must refresh the beat");
    }

    /// R1: leaving background restores the tight bound, so a renderer that died while hidden
    /// is detected again instead of being trusted forever.
    #[test]
    fn r1_leaving_background_restores_the_tight_bound() {
        let core = GatewayCore::new(Arc::new(SynthBridge::new()), Arc::new(|| Some("k".into())));
        core.set_running(true);
        core.set_hidden(true);
        *core.last_heartbeat.lock().unwrap() = Instant::now() - Duration::from_millis(10_000);
        assert!(core.is_available());
        core.set_hidden(false);
        assert!(!core.is_available(), "visible mode must re-apply the 6s bound");
    }

    /// R4(b): no provider attached == uncapped. Guards the builder contract that every
    /// pre-R4 test relies on.
    #[test]
    fn r4_uncapped_without_provider() {
        let core = GatewayCore::new(
            Arc::new(SynthBridge::new()),
            Arc::new(|| Some("k".to_string())),
        );
        assert!(spend_gate(&core).is_none());
    }

    /// Phase 5: JSON 404 for unknown /v1/* routes
    #[tokio::test(flavor = "multi_thread")]
    async fn catch_all_unknown_route_returns_json_404() {
        let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
        let s = start(key).await;
        let res = s
            .client
            .post(format!("{}/v1/unknown/path", s.base))
            .header("authorization", "Bearer sk-aip-test")
            .header("content-type", "application/json")
            .body(r#"{"model":"gpt-4"}"#)
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 404);
        let body: Value = res.json().await.unwrap();
        assert_eq!(body["error"]["type"], "not_found");
        assert_eq!(body["error"]["code"], "unknown_route");
    }

}