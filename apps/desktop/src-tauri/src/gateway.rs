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

use axum::http::{header, HeaderMap, StatusCode};
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
///
/// The headroom is measured, not assumed: with nothing on screen a hidden webview's 2s timer
/// fires at ~0.33/s with a worst observed gap of 3.0s. 30s is 10x that, so ordinary
/// throttling can never trip it. An unbounded `HEARTBEAT_STALE_HIDDEN_MS` would be the real
/// hazard — a suspended webview would then look alive forever.
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
///
/// The bridge owns the tool loop, so there is deliberately no "here are tool results, dispatch
/// again" variant: it executes locally, re-calls the model itself, and only ever emits prose,
/// a final `Result`, `Usage`, `Done` or `Error` on this channel. Tool calls only appear here in
/// *pass-through* mode, where the client declared the tools and will execute them itself.
#[derive(Debug, Clone)]
pub enum BridgeMsg {
    Delta(String),
    /// Client-declared tool calls to hand back untouched (pass-through mode only).
    ToolCalls(Value),
    Result(Value),
    Usage {
        prompt_tokens: u64,
        completion_tokens: u64,
    },
    Done,
    Error { status: u16, message: String },
}

/**
 * Put tool calls into the shape the OpenAI wire — and every other dialect's reader — expects.
 *
 * The webview side hands us `{id, name, arguments}`. That flat form is NOT what any consumer
 * reads: chat/responses/anthropic/gemini all look for `function.name` / `function.arguments`,
 * because that is the dialect they are translating into. So a flat call meant the Anthropic,
 * Gemini and Responses paths silently emitted tool calls with an empty name and null arguments,
 * and the OpenAI path put a non-conformant object on the wire (no `index`, no `type`, no
 * `function` wrapper) that a strict client cannot parse.
 *
 * Normalising once, where the bridge message lands, means the canonical shape is OpenAI's and
 * the other dialects' existing readers are simply correct. Already-shaped input is passed
 * through, only gaining `index`/`type` if it lacks them.
 */
/// Chat-templated upstream models leak their own end-of-turn sentinels into the text they
/// stream. Left alone a client renders them as visible garbage — most obviously on a turn that
/// ends in a tool call, where the sentinel is often the only text the model produced.
///
/// Stripping is unconditional: these tokens are never meaningful user-visible content, and an
/// upstream that genuinely wants to talk about them can escape them.
pub fn clean_assistant_text(raw: &str) -> String {
    let mut out = raw.to_string();
    for tok in ["<|im_end|>", "<|im_start|>", "<|endoftext|>", "<|end|>"] {
        out = out.replace(tok, "");
    }
    out
}

pub fn normalize_tool_calls(calls: Value) -> Value {
    let Some(arr) = calls.as_array() else { return calls };
    Value::Array(
        arr.iter()
            .enumerate()
            .map(|(i, tc)| {
                if tc.get("function").is_some() {
                    let mut out = tc.clone();
                    if let Some(obj) = out.as_object_mut() {
                        // `index` is how a streaming client ties argument fragments to a call.
                        if !obj.contains_key("index") {
                            obj.insert("index".into(), json!(i));
                        }
                        if !obj.contains_key("type") {
                            obj.insert("type".into(), json!("function"));
                        }
                    }
                    return out;
                }
                json!({
                    "index": i,
                    "id": tc.get("id").cloned().unwrap_or_else(|| json!(format!("call_{i}"))),
                    "type": "function",
                    "function": {
                        "name": tc.get("name").cloned().unwrap_or(Value::Null),
                        // A call with no arguments is `{}`, not absent: every reader parses
                        // this string, and null makes them fall back to the raw text.
                        "arguments": tc.get("arguments").cloned().unwrap_or_else(|| json!("{}")),
                    },
                })
            })
            .collect(),
    )
}

#[cfg(test)]
mod core_recovery_tests {
    use super::*;

    /// A core whose worker window has gone quiet, which is what a suspended hidden webview
    /// looks like from here.
    fn stale_core() -> Arc<GatewayCore> {
        let core = Arc::new(GatewayCore::new(
            Arc::new(NoopBridge),
            Arc::new(|| Some("sk-aip-test".to_string())),
        ));
        core.set_running(true);
        core.set_hidden(true);
        *core.last_heartbeat.lock().unwrap() = Instant::now() - Duration::from_secs(60);
        assert!(!core.is_available());
        core
    }

    struct NoopBridge;
    impl Bridge for NoopBridge {
        fn dispatch(&self, _req: BridgeRequest) {}
        fn cancel(&self, _id: u64) {}
    }

    #[tokio::test]
    async fn a_request_waits_out_a_lapsed_heartbeat_and_asks_for_a_re_warm() {
        let core = stale_core();
        let calls = Arc::new(AtomicUsize::new(0));
        let counted = calls.clone();
        // The real hook re-composites the window that hosts this very core, so it has to be
        // able to refer back to it — hence `set_warm` rather than the consuming builder.
        let weak = Arc::downgrade(&core);
        core.set_warm(Arc::new(move || {
            counted.fetch_add(1, Ordering::SeqCst);
            if let Some(core) = weak.upgrade() {
                core.heartbeat(); // stand in for the resumed webview beating again
            }
        }));

        assert!(await_core(&core).await, "a lapsed beat must be waited out, not refused");
        assert!(core.is_available());
        assert_eq!(calls.load(Ordering::SeqCst), 1, "asked for recovery exactly once");
    }

    #[test]
    fn a_core_with_no_host_hook_is_simply_not_warmed() {
        // `new()` attaches no hook, so tests and harnesses cannot be made to depend on one.
        let core = stale_core();
        core.request_warm();
        assert!(!core.is_available());
    }

    #[test]
    fn stopped_is_terminal_and_does_not_look_like_a_lapsed_beat() {
        let core = stale_core();
        core.set_running(false);
        assert!(!core.is_running());
        assert!(!core.is_available());
    }
}

#[cfg(test)]
mod assistant_text_tests {
    use super::clean_assistant_text;

    #[test]
    fn a_leaked_end_of_turn_sentinel_is_not_user_visible_text() {
        // Observed live: a forced tool call on agnes-2.5-flash returned a text block whose entire
        // content was "<|im_end|>", which an Anthropic client renders as garbage.
        assert_eq!(clean_assistant_text("<|im_end|>"), "");
        assert_eq!(clean_assistant_text("hello<|im_end|>"), "hello");
        assert_eq!(clean_assistant_text("<|im_start|>assistant\npong<|endoftext|>"), "assistant\npong");
    }

    #[test]
    fn ordinary_text_is_untouched() {
        assert_eq!(clean_assistant_text("\n\nping"), "\n\nping");
        assert_eq!(clean_assistant_text(""), "");
    }
}

#[cfg(test)]
mod tool_call_shape_tests {
    use super::*;

    #[test]
    fn flat_bridge_calls_become_openai_shaped() {
        let out = normalize_tool_calls(json!([{ "id": "call_1", "name": "Bash", "arguments": "{\"command\":\"ls\"}" }]));
        assert_eq!(out[0]["index"], 0);
        assert_eq!(out[0]["type"], "function");
        assert_eq!(out[0]["id"], "call_1");
        assert_eq!(out[0]["function"]["name"], "Bash");
        assert_eq!(out[0]["function"]["arguments"], "{\"command\":\"ls\"}");
    }

    #[test]
    fn already_shaped_calls_keep_their_fields() {
        let input = json!([{ "index": 3, "id": "call_9", "type": "function",
                             "function": { "name": "Read", "arguments": "{}" } }]);
        assert_eq!(normalize_tool_calls(input.clone()), input);
    }

    #[test]
    fn a_call_with_no_arguments_is_not_null() {
        let out = normalize_tool_calls(json!([{ "name": "Bash" }]));
        assert_eq!(out[0]["function"]["arguments"], "{}");
        assert_eq!(out[0]["id"], "call_0", "a call still needs an id clients can answer");
    }

    #[test]
    fn non_array_input_is_left_alone() {
        assert_eq!(normalize_tool_calls(json!(null)), json!(null));
    }
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
    /// Why the worker page failed to start, if it did. It runs in a window nobody can see, so
    /// without a channel back to the host its failures were unobservable.
    worker_error: Mutex<Option<String>>,
    /// Host hook that re-composites the worker window. `None` in tests, which never suspend
    /// anything; see `request_warm`.
    warm: Mutex<Option<WarmFn>>,
    /// When the hook last actually fired, for rate limiting.
    last_warm: Mutex<Option<Instant>>,
    /// Bound on the worker's first response to a request; see `FIRST_MSG_TIMEOUT`.
    first_msg_timeout: Mutex<Duration>,
}

/// Minimum gap between re-warms from the request path.
///
/// Every warm briefly puts the worker window on screen, which is precisely why the watchdog is
/// limited to once a minute. The request path needs to be able to recover faster than that, but
/// not so fast that a run of requests during one lapse turns into a flickering window.
const WARM_MIN_INTERVAL: Duration = Duration::from_secs(2);

/// Re-composites the worker window. Provided by the host, since only it can touch windows.
pub type WarmFn = Arc<dyn Fn() + Send + Sync + 'static>;

/// Where the sandboxed tools may write before the user picks a workspace.
///
/// Deliberately NOT the process working directory and NOT `$HOME`. A desktop app launched
/// from Finder inherits cwd `/`, and `$HOME` would hand a model the whole user directory;
/// either would make "write a file" a surprisingly dangerous instruction. A single
/// predictable folder under the home directory is both safe and usable, and
/// `gateway_set_workspace_root` can point it somewhere else at any time.
pub fn default_workspace_root() -> Option<std::path::PathBuf> {
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from)?;
    let dir = home.join("AI-Provider-Router-Workspace");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

impl GatewayCore {
    pub fn new(bridge: Arc<dyn Bridge>, key_provider: KeyProvider) -> Self {
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
            // On by default. Two things hang off this flag, and both are safe with it on:
            // a client that brings its own tools is passed through (the client runs them),
            // and a client that brings none gets the gateway's sandboxed registry instead —
            // confined to `default_workspace_root()`. Off means tool parameters are stripped
            // before the request ever leaves, which breaks coding agents, so off is opt-in.
            tools_enabled: AtomicBool::new(true),
            workspace_root: Mutex::new(default_workspace_root()),
            worker_error: Mutex::new(None),
            warm: Mutex::new(None),
            last_warm: Mutex::new(None),
            first_msg_timeout: Mutex::new(FIRST_MSG_TIMEOUT),
        }
    }

    /// Bound on the worker's first response. A field, not a constant, so a test can shorten it
    /// instead of waiting 30 seconds to prove the same thing.
    #[cfg(test)]
    pub fn set_first_msg_timeout(&self, d: Duration) {
        if let Ok(mut g) = self.first_msg_timeout.lock() {
            *g = d;
        }
    }

    pub fn first_msg_timeout(&self) -> Duration {
        self.first_msg_timeout.lock().map(|g| *g).unwrap_or(FIRST_MSG_TIMEOUT)
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

    /// Age of the last beat, for diagnostics: "stopped" is ambiguous on its own, because a
    /// lapsed heartbeat looks identical to an operator pressing Stop.
    pub fn heartbeat_age_ms(&self) -> u64 {
        self.last_heartbeat.lock().unwrap().elapsed().as_millis() as u64
    }

    /// Recorded by the worker page when it fails. Cleared when it reports in healthy.
    pub fn set_worker_error(&self, message: Option<String>) {
        if let Some(m) = &message {
            tracing::error!("gateway worker: {m}");
        }
        *self.worker_error.lock().unwrap() = message;
    }

    pub fn worker_error(&self) -> Option<String> {
        self.worker_error.lock().unwrap().clone()
    }

    pub fn is_available(&self) -> bool {
        self.is_running() && self.beat_is_fresh()
    }

    /// Whether the operator asked the gateway to serve at all. Separate from `is_available`
    /// because "stopped" and "heartbeat lapsed" need different answers: the first is terminal,
    /// the second is worth waiting out.
    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::Relaxed)
    }

    fn beat_is_fresh(&self) -> bool {
        let bound = if self.hidden.load(Ordering::Relaxed) {
            HEARTBEAT_STALE_HIDDEN_MS
        } else {
            HEARTBEAT_STALE_MS
        };
        self.last_heartbeat.lock().unwrap().elapsed() < Duration::from_millis(bound)
    }

    /// Ask the host to re-composite the worker window.
    ///
    /// A hidden webview's JS can be suspended by the OS, and showing the window again is what
    /// resumes it. The watchdog does this too, but it is rate-limited to once a minute so it
    /// cannot become a pacemaker — which leaves a request that arrives inside its cooldown with
    /// nothing to do but fail. Letting the request path ask for the same recovery is what turns
    /// that hard 503 into a short wait.
    /// Rate-limited, so a burst of requests during one lapse produces one re-composite rather
    /// than one each. Safe to call on every poll of `await_core`.
    pub fn request_warm(&self) {
        {
            let Ok(mut last) = self.last_warm.lock() else { return };
            if last.is_some_and(|t| t.elapsed() < WARM_MIN_INTERVAL) {
                return;
            }
            *last = Some(Instant::now());
        }
        // Clone the Arc out of the lock first — never hold a mutex across a callback that
        // touches windows, which can re-enter the host.
        let f = self.warm.lock().ok().and_then(|g| g.clone());
        if let Some(f) = f {
            f();
        }
    }

    /// Attach the host's re-warm hook. A builder, like `with_app_keys`, so `new()` — and every
    /// existing test — keeps working with no hook at all.
    pub fn with_warm(mut self, warm: WarmFn) -> Self {
        self.warm = Mutex::new(Some(warm));
        self
    }

    /// Same hook, attached later. Unlike the key/spend providers there is no reason this cannot
    /// change: it holds no state that could go stale, and a hook that wants to reference its own
    /// core (the real one re-composites the window that hosts it) can only be installed after
    /// the core exists.
    #[cfg(test)]
    pub fn set_warm(&self, warm: WarmFn) {
        if let Ok(mut g) = self.warm.lock() {
            *g = Some(warm);
        }
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
    /// Hand a bridge message to the HTTP handler waiting on this request.
    ///
    /// Returns whether anyone was still listening. That is load-bearing, not incidental: the
    /// bridge streams into this channel, and if the client has already gone (disconnect, or a
    /// completed pass-through response) there is no point paying for more upstream tokens.
    /// `false` lets the caller tear the loop down instead of streaming into a void.
    pub fn reply(&self, id: u64, msg: BridgeMsg) -> bool {
        let tx = self.pending.lock().unwrap().get(&id).cloned();
        match tx {
            Some(tx) => {
                let terminal = matches!(msg, BridgeMsg::Done | BridgeMsg::Error { .. });
                let sent = tx.send(msg).is_ok();
                if terminal {
                    self.pending.lock().unwrap().remove(&id);
                }
                sent
            }
            None => false,
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
}

/// How long a request waits for the worker to say ANYTHING before giving up.
///
/// The router core lives in a hidden webview whose JS the OS may suspend. When that happens
/// after a request has already been admitted — the beat looked fresh at `try_slot` — the event
/// sits in a queue nobody is draining, and the handler would otherwise wait forever with a
/// socket open and nothing logged. Failing with an error the client can retry is strictly
/// better than a hang: the retry re-enters `try_slot`, which now re-warms the window.
///
/// Only the FIRST message is bounded. Once the worker is demonstrably working on the request, a
/// slow stream is a slow stream, and cutting it off would break long answers.
pub const FIRST_MSG_TIMEOUT: Duration = Duration::from_secs(30);

/// RAII slot: permit + registration + receiver, all released on drop — including on client
/// disconnect mid-stream, which is what makes §3.5 cancellation work.
struct Slot {
    core: Arc<GatewayCore>,
    _permit: OwnedSemaphorePermit,
    id: u64,
    rx: mpsc::UnboundedReceiver<BridgeMsg>,
    /// Set once the worker has produced its first message; only that wait is bounded.
    started: bool,
}

impl Slot {
    /// Next bridge message, or `None` when the channel closed.
    ///
    /// A first message that never arrives is reported as an `Error` rather than `None` so every
    /// dialect's existing error path produces a real response — a closed channel would instead
    /// fall through to "completed, no content", which looks like a successful empty answer.
    async fn recv(&mut self) -> Option<BridgeMsg> {
        if self.started {
            return self.rx.recv().await;
        }
        let bound = self.core.first_msg_timeout();
        match tokio::time::timeout(bound, self.rx.recv()).await {
            Ok(msg) => {
                self.started = true;
                msg
            }
            Err(_) => {
                self.started = true; // already failed once; don't wait again
                tracing::warn!(
                    request_id = self.id,
                    "worker produced nothing for {}ms — failing the request instead of hanging",
                    bound.as_millis()
                );
                Some(BridgeMsg::Error {
                    status: 503,
                    message: "the router worker did not respond — the gateway window may be suspended".to_string(),
                })
            }
        }
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        self.core.close(self.id);
        self.core.bridge.cancel(self.id);
    }
}

/// How long a request will wait for the worker window to come back before giving up.
///
/// Long enough to cover a re-composite — the watchdog logs show one landing in well under a
/// second — and short enough that a genuinely dead worker costs a client one bad request, not a
/// hanging one.
const CORE_RECOVERY_GRACE: Duration = Duration::from_millis(5_000);
const CORE_RECOVERY_POLL: Duration = Duration::from_millis(150);

/**
 * Wait out a lapsed heartbeat instead of rejecting on it.
 *
 * The worker lives in a hidden webview, and macOS suspends hidden webviews. When that happens
 * the bridge stops beating and every request fails until the watchdog happens to re-warm the
 * window — and the watchdog is deliberately rate-limited to once a minute, so most requests
 * arriving during a lapse were simply refused. Recovery is a `show()` away, so a request can
 * ask for it directly and wait a bounded moment.
 *
 * Returns false only when the wait was exhausted. Called at most once per request, and only
 * when the beat is already stale, so a healthy gateway pays nothing.
 */
async fn await_core(core: &Arc<GatewayCore>) -> bool {
    let deadline = Instant::now() + CORE_RECOVERY_GRACE;
    loop {
        if core.beat_is_fresh() {
            return true;
        }
        // Called every poll rather than once: `request_warm` is rate-limited, and a warm that
        // lands while the window is still coming up may not resume the beat first time.
        core.request_warm();
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(CORE_RECOVERY_POLL).await;
    }
}

/// 503 if the core is unreachable, 429 if over capacity, otherwise the Slot.
async fn try_slot(core: &Arc<GatewayCore>) -> Result<Slot, Response> {
    // Stopped is terminal — waiting would only delay the same answer. A lapsed beat is not.
    if !core.is_running() {
        return Err(err_ra(
            StatusCode::SERVICE_UNAVAILABLE,
            "1",
            openai_error("AI-Provider Router gateway is stopped", "service_unavailable", None),
        ));
    }
    if !core.is_available() && !await_core(core).await {
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
    Ok(Slot { core: core.clone(), _permit: permit, id, rx, started: false })
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


// ---------- ingress dialects ----------
//
// Audit R8: this file used to hold every wire dialect and ran to ~2.4k lines. Each dialect now
// lives in its own module, so a framing change to Gemini cannot touch the OpenAI or Anthropic
// paths. What stays here is the part they all share: core state, the bridge protocol, auth,
// capacity, and the shared error/response helpers.

#[path = "gateway_anthropic.rs"]
mod anthropic;
#[path = "gateway_gemini.rs"]
mod gemini;
#[path = "gateway_handlers.rs"]
mod handlers;
#[path = "gateway_responses.rs"]
mod responses;

use anthropic::messages_h;
use gemini::gemini_h;
use handlers::{chat_h, image_h, models_h, unknown_route};
use responses::responses_h;

#[cfg(test)]
#[path = "gateway_tests.rs"]
mod tests;

fn map_generic_to_status(r: Response) -> Response {
    let status = r.status();
    let body = openai_error(
        if status == StatusCode::TOO_MANY_REQUESTS { "router at capacity" } else { "AI-Provider Router core unavailable — is the app open?" },
        if status == StatusCode::TOO_MANY_REQUESTS { "rate_limit" } else { "service_unavailable" },
        None,
    );
    (status, axum::Json(body)).into_response()
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
