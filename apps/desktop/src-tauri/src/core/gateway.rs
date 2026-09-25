//! local-gateway (L0, Phase 2b): OpenAI-compatible HTTP endpoint (axum) routing into a Rust-native
//! router core in this process (§3.3, §3.4, §3.5). Phase 5c put the router here; 25f deleted the
//! webview bridge it used to cross into, and with it the heartbeat, the worker window and the
//! `ready` seam that existed to describe them.
//!
//! Security posture (invariants 10, 11, 15, 16):
//! - binds 127.0.0.1 only;
//! - every request authenticated by the master key BEFORE any routing work; constant-time
//!   compare; per-IP exponential backoff on repeated auth failures;
//! - the master key lives only in the OS keychain (account `masterkey`); reveal is a
//!   Rust-side copy-to-clipboard (§14) — it never enters webview-observable state;
//!   rotation overwrites the account, so the old key dies on the NEXT request read (§3.3);
//! - gateway stopped: 503 + Retry-After: 1, nothing queued (§3.5);
//! - capacity: 8 concurrent + 32 queued -> 429 + Retry-After;
//! - cancellation: client disconnect drops the Slot -> bridge.cancel(id) -> the router loop
//!   aborts the call -> the provider stream closes.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
#[cfg(test)]
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::http::{header, HeaderMap, HeaderValue, Method, Request, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use rand::Rng as _;
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot, OwnedSemaphorePermit, Semaphore};

use crate::core::injection_log::{InjectionEvent, InjectionLog, InjectionStats};
use crate::core::vault;

pub const DEFAULT_PORT: u16 = 8787;
pub const MASTER_ACCOUNT: &str = "masterkey";
/// §3.5 concurrency: at most this many requests are *routed* (dispatched to the core) at once.
pub const MAX_CONCURRENT: usize = 8;
/// §3.5 bounded queue: this many further requests are admitted and wait for a routing slot.
pub const MAX_QUEUED: usize = 32;
/// Admission ceiling. Not a concurrency limit — see `dispatch`.
const MAX_TOTAL: usize = MAX_CONCURRENT + MAX_QUEUED;

/// Pluggable master-key lookup so the HTTP surface is testable without touching the real
/// OS keychain. Production passes the vault-backed closure.
pub type KeyProvider = Arc<dyn Fn() -> Option<String> + Send + Sync + 'static>;

/// R4: one active per-app key — its stable id *and* its secret.
///
/// The secret is what auth compares. The id is what the memory layer needs (§4a: a principal has
/// to be nameable by the operator). Returning both from one read is the whole reason identity is
/// affordable at all: the provider costs one keychain round-trip per key, so a second call that
/// asked only "which id was that secret?" would double the cost of every request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppKey {
    /// `ak-<hex>`, matching the `gateway_keys.id` row.
    pub id: String,
    pub secret: String,
}

/// R4: active per-app keys (keychain-backed). Returns only NON-revoked keys, so
/// revocation takes effect on the very next request without rotating anything else.
pub type AppKeyProvider = Arc<dyn Fn() -> Vec<AppKey> + Send + Sync + 'static>;

/// The three settings a [`BridgeHost`](crate::core::router_bridge::BridgeHost) reads, shared with
/// the core rather than copied.
///
/// **One copy, two holders.** The core owns the bridge (`Arc<dyn Bridge>`), so the bridge cannot
/// own the core — the cycle [`ReplyHandle`] exists to avoid, and `router_bridge`'s own note records
/// the same constraint one layer out. What the bridge actually needs is not the core but these
/// three answers (plus the store), so they live here, behind `Arc`s the core writes through and the
/// host reads through.
///
/// **Why not a `Weak<GatewayCore>`.** That breaks the cycle too, and it was the first shape
/// considered. It makes "the core is not wired yet" a state the host has to answer for, and every
/// answer it could give is a default the operator never chose — the `NULL` vs `0` defect with a
/// different subject. Sharing the fields removes the state instead of defaulting it.
///
/// This is what replaced the webview liveness subsystem (25f). It is deliberately *not* a
/// heartbeat: nothing here goes stale, because nothing here can be suspended.
#[derive(Clone)]
pub struct HostSettings {
    tools_enabled: Arc<AtomicBool>,
    tools_mutation_enabled: Arc<AtomicBool>,
    workspace_root: Arc<Mutex<Option<std::path::PathBuf>>>,
}

impl Default for HostSettings {
    fn default() -> Self {
        Self {
            // Both defaults are the ones `GatewayCore` has always had, moved rather than changed:
            // tools on (a client that brings its own is passed through; one that brings none gets
            // the gateway's sandboxed registry), mutation off (it executes code with no human in
            // the loop — see `tools_mutation_enabled`).
            tools_enabled: Arc::new(AtomicBool::new(true)),
            tools_mutation_enabled: Arc::new(AtomicBool::new(false)),
            workspace_root: Arc::new(Mutex::new(default_workspace_root())),
        }
    }
}

impl HostSettings {
    pub fn tools_enabled(&self) -> bool {
        self.tools_enabled.load(Ordering::Relaxed)
    }

    pub fn set_tools_enabled(&self, on: bool) {
        self.tools_enabled.store(on, Ordering::Relaxed);
    }

    pub fn tools_mutation_enabled(&self) -> bool {
        self.tools_mutation_enabled.load(Ordering::Relaxed)
    }

    pub fn set_tools_mutation_enabled(&self, on: bool) {
        self.tools_mutation_enabled.store(on, Ordering::Relaxed);
    }

    pub fn workspace_root(&self) -> Option<std::path::PathBuf> {
        self.workspace_root.lock().unwrap().clone()
    }

    pub fn set_workspace_root(&self, root: std::path::PathBuf) {
        *self.workspace_root.lock().unwrap() = Some(root);
    }
}

pub fn vault_key_provider() -> KeyProvider {
    Arc::new(|| vault::get(MASTER_ACCOUNT).ok().flatten())
}

/// How long a request waits for the master key before answering without it.
///
/// The lookup is a macOS keychain read, and that call can block *indefinitely*: when the item's
/// ACL no longer matches the app's code signature — which is what every reinstall produces — the
/// Security framework raises a SecurityAgent prompt and waits for a human. Unbounded, that does
/// not fail one request, it wedges the entire HTTP surface: the listener keeps accepting
/// connections and never answers one, and nothing is logged because the failure is a hang rather
/// than an error. Bounded, it degrades to a 503 on the requests that need the key.
const MASTER_KEY_WAIT: Duration = Duration::from_millis(1500);

/// Outcome of a master-key lookup.
///
/// `Unavailable` is deliberately distinct from `Absent`. The first means "the keychain did not
/// answer"; the second means "no key has been configured". Collapsing them would tell a
/// correctly-configured client that its key is wrong.
#[derive(Debug, PartialEq, Eq)]
pub enum MasterKeyLookup {
    Ready(String),
    Absent,
    Unavailable,
}

struct CacheState {
    /// The value found at `generation`. `None` alongside a matching generation means a load
    /// completed and found no key — which is `Absent`, not "not loaded yet".
    value: Option<String>,
    /// Generation this state describes. Starts at `u64::MAX` ("never loaded") so the first call
    /// always loads, even though generation 0 is itself a valid generation.
    generation: u64,
    loading: bool,
}

/// A cached, bounded, single-flight wrapper around the raw keychain lookup.
///
/// Each property fixes a different half of the same bug:
/// - **Cached** — the keychain is read once, not once per request. The old code re-read it on
///   every request precisely so rotation would take effect immediately; `invalidate()` keeps that
///   guarantee by stamping each value with a generation that rotation bumps.
/// - **Bounded** — no caller waits longer than `wait`, so a stalled keychain cannot hang the
///   request path.
/// - **Single-flight** — concurrent callers share one in-flight load, so a stuck keychain occupies
///   one thread instead of one per request. That thread is abandoned deliberately: nothing can
///   cancel a blocking `SecKeychainFindGenericPassword`, and it frees itself once the prompt is
///   answered.
struct MasterKeyCache {
    inner: KeyProvider,
    wait: Duration,
    /// Bumped by `invalidate`. A cached value stamped with an older generation is stale.
    generation: AtomicU64,
    shared: Arc<(Mutex<CacheState>, Condvar)>,
}

impl MasterKeyCache {
    fn new(inner: KeyProvider, wait: Duration) -> Self {
        Self {
            inner,
            wait,
            generation: AtomicU64::new(0),
            shared: Arc::new((
                Mutex::new(CacheState { value: None, generation: u64::MAX, loading: false }),
                Condvar::new(),
            )),
        }
    }

    /// Force the next `get` to re-read the keychain. Call after writing or deleting the key.
    fn invalidate(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
    }

    fn get(&self) -> MasterKeyLookup {
        let (lock, ready) = &*self.shared;
        let deadline = Instant::now() + self.wait;

        loop {
            // Re-read the generation on every pass. A rotation landing mid-load supersedes the
            // load already in flight, and re-reading here is what makes the next pass fetch the
            // new key rather than answering from the superseded one.
            let generation = self.generation.load(Ordering::SeqCst);
            // A poisoned lock means an earlier caller panicked while holding it; the state it
            // guards is still coherent, so recover rather than propagate that panic into a request.
            let mut state = lock.lock().unwrap_or_else(|e| e.into_inner());

            if !state.loading && state.generation == generation {
                return resolve(&state.value);
            }

            if !state.loading {
                state.loading = true;
                let inner = Arc::clone(&self.inner);
                let shared = Arc::clone(&self.shared);
                std::thread::spawn(move || {
                    // The only call that may block on the keychain, and never on a request path.
                    let found = inner();
                    let (lock, ready) = &*shared;
                    let mut state = lock.lock().unwrap_or_else(|e| e.into_inner());
                    state.value = found;
                    state.generation = generation;
                    state.loading = false;
                    ready.notify_all();
                });
            }

            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                return MasterKeyLookup::Unavailable;
            };
            let (guard, _) =
                ready.wait_timeout(state, remaining).unwrap_or_else(|e| e.into_inner());
            drop(guard);
        }
    }
}

fn resolve(value: &Option<String>) -> MasterKeyLookup {
    match value {
        Some(v) => MasterKeyLookup::Ready(v.clone()),
        None => MasterKeyLookup::Absent,
    }
}

/// Keychain account prefix for a per-app gateway key (audit R4).
pub const APP_KEY_PREFIX: &str = "gwkey:";

/// R4: secrets of every non-revoked per-app key, read from the keychain. Metadata (label,
/// revocation, last-used) lives in SQLite — see `persist.rs`.
pub fn vault_app_key_provider(store: Arc<crate::core::store::Store>) -> AppKeyProvider {
    Arc::new(move || {
        let ids = crate::core::persist::active_gateway_key_ids(&store).unwrap_or_default();
        ids.into_iter()
            .filter_map(|id| {
                let secret = vault::get(&format!("{APP_KEY_PREFIX}{id}")).ok().flatten()?;
                Some(AppKey { id, secret })
            })
            .collect()
    })
}

/// How long the memoised app-key map may be replayed without re-reading the keychain.
///
/// This is a **backstop, not the primary invalidation**. The primary one is the active-key set
/// (see `AppKeyCache`), which is re-read from SQLite on every request precisely so that creating
/// and revoking a key still take effect on the very next call — the contract the provider's own
/// comment promises. The TTL covers the one case SQLite cannot see: a secret changed or deleted
/// in the keychain underneath an active row.
const APP_KEY_CACHE_TTL: Duration = Duration::from_secs(60);

/// Memo over `app_key_provider`.
///
/// Needed because the provider is one keychain read per key, and that call can block *indefinitely*
/// on a macOS SecurityAgent prompt — see `MASTER_KEY_WAIT`. Uncached, a gateway with N app keys
/// takes N blocking calls per request, so one stale keychain ACL stops the whole HTTP surface.
///
/// Keyed on the **set of active ids** rather than on time alone: that set is read fresh from
/// SQLite each request (one indexed scan, no keychain), so create and revoke invalidate the memo
/// immediately. Keying on a bare TTL instead would have quietly broken revocation, which today
/// takes effect on the very next request.
struct AppKeyCache {
    /// Active ids as of `keys`. `None` until first filled.
    ids: Option<Vec<String>>,
    keys: Vec<AppKey>,
    at: Option<Instant>,
    ttl: Duration,
}

impl Default for AppKeyCache {
    fn default() -> Self {
        Self { ids: None, keys: Vec::new(), at: None, ttl: APP_KEY_CACHE_TTL }
    }
}

impl AppKeyCache {
    /// `active` is the freshly-read id set, or `None` when there is no store to ask (a harness).
    fn fresh(&self, active: &Option<Vec<String>>) -> bool {
        let Some(at) = self.at else {
            return false;
        };
        if at.elapsed() >= self.ttl {
            return false;
        }
        match (active, &self.ids) {
            // The set is the authority: unchanged ids mean unchanged secrets behind them.
            (Some(a), Some(c)) => a == c,
            // No store to consult (a harness), or nothing memoised yet. An unchecked memo would
            // let a revoked key keep authenticating for the whole TTL — see
            // `r4_revoked_app_key_rejected_immediately` — so never cache blind.
            _ => false,
        }
    }
}

/// Everything the spend gate needs about one caller, read in one pass.
///
/// Two independent limits, not one narrowed one. The global cap bounds what the *owner* pays;
/// a per-app cap bounds what *one connected app* may spend. Neither implies the other, and the
/// binding one cannot be computed as a minimum: with a $10 global and a $100 app cap, a single
/// app can breach the global limit while sitting far under its own — so both have to be checked
/// against their own numerator, which is why this carries two pairs rather than one.
///
/// `total_cap_micros <= 0` means the global cap is off. `app_*` are `None` when the caller is not
/// a per-app key (the master key) or has no cap of its own.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SpendLimits {
    /// Month-to-date across every source — the global cap's numerator.
    pub total_micros: i64,
    /// The global monthly cap; `<= 0` = uncapped.
    pub total_cap_micros: i64,
    /// Month-to-date for the calling app. `None` when the caller names no app.
    pub app_micros: Option<i64>,
    /// That app's own cap. `None` when it has none.
    pub app_cap_micros: Option<i64>,
}

/// R4: the caller's spend and caps. Takes the authenticated app key so a per-app budget can be
/// enforced; `None` is the master key, which is subject only to the global cap.
///
/// Injected the same way as the key providers, so the HTTP surface is testable without SQLite.
pub type SpendProvider = Arc<dyn Fn(Option<&str>) -> SpendLimits + Send + Sync + 'static>;

/// Production spend gate. Reads on every request (not cached): the ledger is capped at 90 days
/// and both SUMs are indexed range scans, so the cost is negligible next to an upstream LLM
/// round-trip — and a stale cap is exactly the failure this feature exists to prevent.
///
/// The per-app half is only read when there *is* an app, so a master-key request pays for one
/// query rather than two.
pub fn vault_spend_provider(store: Arc<crate::core::store::Store>) -> SpendProvider {
    Arc::new(move |app_key_id: Option<&str>| {
        let (app_micros, app_cap_micros) = match app_key_id {
            Some(id) => (
                Some(crate::core::persist::app_month_spend_micros(&store, id)),
                crate::core::persist::gateway_key_cap(&store, id),
            ),
            None => (None, None),
        };
        SpendLimits {
            total_micros: crate::core::persist::month_spend_micros(&store),
            total_cap_micros: crate::core::persist::spend_cap_micros(&store).unwrap_or(0),
            app_micros,
            app_cap_micros,
        }
    })
}

// ---------- bridge protocol (Rust <-> webview) ----------

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeRequest {
    pub request_id: u64,
    pub kind: &'static str, // "chat" | "responses" | "models" | "image"
    pub body: Value,
    /// Select headers forwarded for client detection (User-Agent, X-Client-Name, etc.).
    pub headers: HashMap<String, String>,
    /// The per-app key that authenticated this request (`gateway_keys.id`), or `None` when the
    /// master key did.
    ///
    /// Carried across the bridge because the ledger row is written on the webview side: without
    /// it the column exists and every row is `NULL`, which reads as "no app ever spent anything"
    /// rather than "attribution was never wired up".
    pub app_key_id: Option<String>,
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
    Error {
        status: u16,
        message: String,
        /// The **shortest** upstream retry-after across all failed key attempts, in
        /// milliseconds — not the longest. The route planner *drops* cooled keys rather than
        /// deprioritising them (`route-planner.ts` filters on `isKeyUsable`), so the earliest a
        /// retry can be served is when the first cooled key frees, and the honest hint to the
        /// client is that shortest wait. Zero/None when the worker didn't report one. The HTTP
        /// handler converts this to the `Retry-After` header (in seconds).
        retry_after_ms: Option<u64>,
    },
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
mod assistant_text_tests {
    use super::clean_assistant_text;

    #[test]
    fn a_leaked_end_of_turn_sentinel_is_not_user_visible_text() {
        // Observed live: a forced tool call on agnes-2.5-flash returned a text block whose entire
        // content was "<|im_end|>", which an Anthropic client renders as garbage.
        assert_eq!(clean_assistant_text("<|im_end|>"), "");
        assert_eq!(clean_assistant_text("hello<|im_end|>"), "hello");
        assert_eq!(
            clean_assistant_text("<|im_start|>assistant\npong<|endoftext|>"),
            "assistant\npong"
        );
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
        let out = normalize_tool_calls(
            json!([{ "id": "call_1", "name": "Bash", "arguments": "{\"command\":\"ls\"}" }]),
        );
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

/// Hand-off surface to the router core. Phase 5c put a Rust router core here: the production
/// implementation is `RouterBridge`, which runs the tool loop in this process. The synthetic
/// bridges in `gateway_tests` remain for the §3.5 entry-gate spike.
pub trait Bridge: Send + Sync + 'static {
    /// Route one request, answering it through `replies`.
    ///
    /// The handle arrives *with the dispatch* rather than being installed on the bridge at
    /// construction. That is deliberate. A stored handle is a wiring step somebody can forget,
    /// and the failure it produces is silent: the request waits out `FIRST_MSG_TIMEOUT` and
    /// answers a generic 503, which reads as "the core is down" rather than "nobody gave the
    /// bridge a way to answer". A parameter cannot be forgotten — the call does not compile.
    fn dispatch(&self, req: BridgeRequest, replies: ReplyHandle);
    fn cancel(&self, request_id: u64);
}

// **`ready` used to be here, and its absence is the 25f result rather than an omission.**
//
// Increment 24c added `fn ready(&self, beat: Beat) -> bool` so the core would stop asking every
// bridge whether a *webview* was awake (D35). It was the right seam for the transition and it is
// the wrong one afterwards: with `EventBridge` deleted, the only bridge that ever answers is
// `RouterBridge`, which runs in this process and is therefore always ready. Every remaining
// implementor would answer `true`, so the method would be a constant, and `try_slot`'s
// "core unavailable" branch would be reachable only from a test double — a branch that cannot
// fire in production is the defect class this register keeps recording.
//
// The question that survives is `is_running()`: whether the operator asked the gateway to serve.
// `Beat` went with it, because its whole content was the webview's heartbeat.
//
// This is a `//` note and not a `///` one on purpose: there is no item here for it to document,
// and as a doc comment it attached itself to `ReplyHandle` below (clippy:
// `empty_line_after_doc_comments`), which is a different type with a different job.

/// The bridge's way back to the request that is waiting for it.
///
/// Holds the pending map and nothing else — deliberately **not** an `Arc<GatewayCore>`. The
/// core owns the bridge (`Arc<dyn Bridge>`) and the bridge owns this, so a handle that held
/// the core would close a reference cycle and neither would ever drop: the core, its store,
/// its semaphores and its injection log would all outlive every reference to them. The bridge
/// does not need the core; it needs somewhere to put messages, and that is exactly this.
///
/// A consequence worth stating: `reply` after the core is gone is an ordinary `false` —
/// "nobody is listening", the same answer it already gives for a stale id — not a panic, and
/// not a reason to keep anything alive.
#[derive(Clone, Default)]
pub struct ReplyHandle {
    pending: Arc<Mutex<HashMap<u64, mpsc::UnboundedSender<BridgeMsg>>>>,
}

impl ReplyHandle {
    /// Register a waiting request. Called by the core when a request takes a slot; not part of
    /// the bridge's surface.
    fn register(&self, id: u64, tx: mpsc::UnboundedSender<BridgeMsg>) {
        self.pending.lock().unwrap().insert(id, tx);
    }

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

    /// Drop a request's registration without answering it — the client is gone.
    fn close(&self, id: u64) {
        self.pending.lock().unwrap().remove(&id);
    }

    /// Register a request and hand back the receiving end — **test-only**.
    ///
    /// A driver's test has to observe what the bridge wrote, and `register` is private to this
    /// module: `gateway_tests` reaches it because it is a *child* of this module, and
    /// `core::router_bridge`'s tests are a sibling and cannot. This is the same accommodation
    /// `HealthTracker::keys` makes for assertions that need the shape rather than the accessor.
    #[cfg(test)]
    pub(crate) fn test_channel(&self, id: u64) -> mpsc::UnboundedReceiver<BridgeMsg> {
        let (tx, rx) = mpsc::unbounded_channel();
        self.register(id, tx);
        rx
    }
}

pub struct GatewayCore {
    next_id: AtomicU64,
    /// Where bridge replies land. A separate value rather than an inline map so the bridge can
    /// be handed it directly — see `ReplyHandle` for why it must be handed *that* and not the
    /// core it belongs to.
    replies: ReplyHandle,
    /// Admission: how many requests may be in the building at all, dispatched + waiting.
    permits: Arc<Semaphore>,
    /// Routing: how many may be dispatched to the core at once (§3.5). This is the half the
    /// single 40-permit pool was missing — acquiring `permits` used to dispatch immediately, so
    /// 40 upstream calls could go out together.
    dispatch: Arc<Semaphore>,
    failures: Mutex<HashMap<IpAddr, (u32, Instant)>>,
    bridge: Arc<dyn Bridge>,
    /// Bounded, cached, single-flight wrapper around the injected master-key lookup. Request paths
    /// must go through this and never touch the keychain directly — see `MasterKeyCache`.
    master_key: MasterKeyCache,
    /// R4: optional per-app key secrets. `None` = master key only (all existing tests).
    /// Behind a Mutex so it can be swapped after create/revoke without rebuilding the core.
    app_key_provider: Mutex<Option<AppKeyProvider>>,
    /// Memo over `app_key_provider` — see `AppKeyCache`. Without it, resolving a presented key
    /// back to its id would cost a keychain read per key *per request*.
    app_key_cache: Mutex<AppKeyCache>,
    /// R4: optional monthly spend gate. `None` = uncapped (all existing tests).
    spend_provider: Mutex<Option<SpendProvider>>,
    running: AtomicBool,
    port: Mutex<u16>,
    /// The three settings a `BridgeHost` reads: whether gateway-supplied tools are on, whether they
    /// may mutate, and the workspace root they execute against.
    ///
    /// A shared handle rather than three fields on the core and a copy on the host. The core owns
    /// the bridge, so the bridge cannot own the core, and a second copy of these is how the operator
    /// flips a switch, the core updates, and the bridge keeps serving the old answer with nothing to
    /// report it. See [`HostSettings`].
    settings: HostSettings,
    /// The store, so the memory/context layer can be reached from the request path.
    ///
    /// `Option` and `None` by default for the same reason `app_key_provider` is: every existing test
    /// builds a core with `new()`, and none of them have a store. It is attached in production by
    /// `with_store`. Nothing on the request path touches it until the memory toggle is on.
    store: Option<Arc<crate::core::store::Store>>,
    /// The egress allowlist, so admin provider CRUD can keep it in step with `providers.base_url`
    /// (invariant 9). `Option` and `None` by default for the same reason `store` is: every existing
    /// test builds a core with `new()` and none of them have one. See `with_allowlist` for why the
    /// HTTP routes need it.
    allowlist: Option<Arc<crate::core::egress::AllowList>>,
    /// Host-side kill switch for the memory/context layer. **Off by default** — see
    /// `GATEWAY_MEMORY_LAYER.md` §0: injecting memory bills tokens on every request from every
    /// client and is invisible at a layer with no review step, which is exactly why skills were kept
    /// frontend-only. Off means `inject_context` strips `metadata.aip` and does nothing else.
    memory_enabled: AtomicBool,
    /// Bound on the bridge's first response to a request; see `FIRST_MSG_TIMEOUT`.
    first_msg_timeout: Mutex<Duration>,
    /// §5.5: composed memory blocks frozen per `(scope, session)`, so the bytes at system position 0
    /// stop changing between requests and the provider's prefix cache can actually hit. See
    /// `FrozenMemory`.
    memory_freeze: Mutex<HashMap<String, FrozenMemory>>,
    /// How long a frozen block is served before recall runs again. A field, not a constant, for the
    /// same reason `first_msg_timeout` is one: ten minutes is not something a test can wait for.
    memory_freeze_ttl: Mutex<Duration>,
    /// What the memory layer actually did, request by request, for the Control screen.
    ///
    /// The `AIP-Memory` response header already carries these facts — but it goes to the *client* and
    /// nowhere else, so the operator had no way to answer "why didn't the model know X" without
    /// attaching a proxy to their own gateway. This keeps a bounded in-process copy.
    ///
    /// In-memory deliberately: the memory path is built never to block a request (`MEMORY_DEADLINE`,
    /// 15 ms), so its telemetry must not either. One uncontended lock, no SQLite write — a per-request
    /// row would contradict the design it exists to observe. A field rather than a global so tests
    /// stay isolated; see `injection_log`.
    injection_log: Mutex<InjectionLog>,
}

/// §5.5: a composed memory block held still across requests.
///
/// Coding agents are the one workload deliberately built around provider prompt caching, and the
/// memory block sits at system position 0 — so *any* change to its bytes invalidates the entire
/// cached prefix and every request pays full input price plus the cache-write premium. Freezing the
/// bytes is worth more than the freshness lost inside the TTL.
#[derive(Debug, Clone)]
pub struct FrozenMemory {
    /// The `<memory>…</memory>` block, byte for byte. Live context is deliberately **not** part of
    /// it: it carries the latest turns, so freezing it would break the thing Phase 3 exists for. It
    /// is concatenated *after* this block, so the stable prefix still covers everything up to it.
    pub block: String,
    /// Atoms in the block, for the `AIP-Memory` header.
    pub items: usize,
    /// Cost at freeze time. A later request with a smaller budget must not be handed a block that
    /// was composed for a roomier one.
    pub tokens: usize,
    /// Whether recall found anything at all — kept separately from `items` because "found five, none
    /// of them fit" is `BelowFloor`, not `NoCandidates`, and the two send the operator to different
    /// fixes.
    pub had_candidates: bool,
    frozen_at: Instant,
}

/// §5.5: how long a frozen block is served. The design suggests ten minutes. A long TTL costs
/// freshness (a newly distilled atom waits); a short one costs a cold prefix cache, which is the
/// only reason this exists.
pub const MEMORY_FREEZE_TTL: Duration = Duration::from_secs(600);

/// Ceiling on frozen blocks. Sessions come and go, so without a cap a long-lived gateway
/// accumulates one entry per session for ever.
const MAX_FROZEN_BLOCKS: usize = 256;

/// Gateway-side tools that can change the workspace. Everything else only reads it.
pub const MUTATING_TOOLS: [&str; 4] = ["write_file", "edit_file", "mkdir", "run_command"];

/// Audit H1b: is `tool` permitted on the gateway path? `Some(reason)` = refused.
///
/// **A free function rather than a method, because two callers need the same answer and only one of
/// them has a `GatewayCore`.** The `gateway_tool_run` command reads it through the core; the
/// Rust-native bridge ([`crate::core::router_bridge::RouterBridge`]) cannot, because the core owns
/// the bridge and a bridge holding the core would close the reference cycle `ReplyHandle` exists to
/// avoid. It asks its host for the *toggle* and calls this for the *rule*, so the message the model
/// reads is written once.
///
/// The message is written for the model that will read it: it says what is disabled, why, and what
/// to do instead — a bare "forbidden" sends the model retrying.
pub fn gateway_tool_refusal(tool: &str, mutation_enabled: bool) -> Option<String> {
    if MUTATING_TOOLS.contains(&tool) && !mutation_enabled {
        Some(format!(
            "\"{tool}\" is disabled on the gateway. The gateway executes tools with no user \
             confirmation, so mutation is off by default. Enable it in Gateway settings, or use \
             the Assistant, which asks before every call."
        ))
    } else {
        None
    }
}

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
        Self::new_with_key_wait(bridge, key_provider, MASTER_KEY_WAIT)
    }

    /// `new` with an explicit key wait, so tests can exercise the bounded path without sitting
    /// through the production timeout.
    pub fn new_with_key_wait(
        bridge: Arc<dyn Bridge>,
        key_provider: KeyProvider,
        key_wait: Duration,
    ) -> Self {
        Self {
            next_id: AtomicU64::new(1),
            replies: ReplyHandle::default(),
            permits: Arc::new(Semaphore::new(MAX_TOTAL)),
            dispatch: Arc::new(Semaphore::new(MAX_CONCURRENT)),
            failures: Mutex::new(HashMap::new()),
            bridge,
            master_key: MasterKeyCache::new(key_provider, key_wait),
            app_key_provider: Mutex::new(None),
            app_key_cache: Mutex::new(AppKeyCache::default()),
            spend_provider: Mutex::new(None),
            running: AtomicBool::new(false),
            port: Mutex::new(DEFAULT_PORT),
            // The defaults `GatewayCore` has always had, now owned by a handle that can be shared
            // with a `BridgeHost` — see `with_host_settings` and `HostSettings`.
            settings: HostSettings::default(),
            store: None,
            allowlist: None,
            memory_enabled: AtomicBool::new(false),
            first_msg_timeout: Mutex::new(FIRST_MSG_TIMEOUT),
            memory_freeze: Mutex::new(HashMap::new()),
            memory_freeze_ttl: Mutex::new(MEMORY_FREEZE_TTL),
            injection_log: Mutex::new(InjectionLog::new()),
        }
    }

    /// Drop the cached master key so the next request re-reads the keychain.
    ///
    /// Call this after writing or deleting the key. Caching the key would otherwise silently
    /// break rotation: the old key would keep working until the cache aged out, and
    /// `criterion8_rotation_kills_old_key_instantly` exists precisely to forbid that.
    pub fn invalidate_master_key(&self) {
        self.master_key.invalidate();
    }

    /// Master-key state for the status surface.
    ///
    /// Goes through the bounded cache for the same reason requests do: `gateway_status` is polled
    /// by the UI, and a raw keychain read here froze the Gateway screen whenever the keychain
    /// stalled. Note the cache keeps its last value across a stall, so a key read once stays
    /// reported as present.
    pub fn master_key_state(&self) -> MasterKeyLookup {
        self.master_key.get()
    }

    /// Rotate the master key, dropping the cached one as part of the same operation.
    ///
    /// One method rather than two calls on purpose: a caller that wrote the keychain and forgot
    /// to invalidate would leave the old key working, silently. Returns the new key for one-time
    /// display (§3.3); the webview never sees it (invariant 10).
    pub fn rotate_master_key(&self) -> Result<String, String> {
        let key = self::generate_master_key()?;
        self.invalidate_master_key();
        Ok(key)
    }

    /// Delete the master key, dropping the cached one as part of the same operation.
    pub fn revoke_master_key(&self) -> Result<(), String> {
        self::revoke_master_key()?;
        self.invalidate_master_key();
        Ok(())
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

    /// R4: the active per-app keys, memoised — see `AppKeyCache`.
    ///
    /// Every request-path caller must come through here rather than through the provider directly.
    /// Returns empty when no provider is attached, so the master-key-only path costs nothing.
    pub fn app_keys(&self) -> Vec<AppKey> {
        // Clone the Arc out of the lock before calling it — never hold a mutex across a
        // keychain read (which can block on a macOS security prompt).
        let Some(provider) = self.app_key_provider.lock().ok().and_then(|g| g.clone()) else {
            return Vec::new();
        };
        // Cheap and authoritative: one indexed SQLite scan, no keychain.
        let active =
            self.store.as_ref().and_then(|s| crate::core::persist::active_gateway_key_ids(s).ok());
        if let Ok(cache) = self.app_key_cache.lock() {
            if cache.fresh(&active) {
                return cache.keys.clone();
            }
        }
        let keys = provider();
        if let Ok(mut cache) = self.app_key_cache.lock() {
            cache.ids = active.or_else(|| Some(keys.iter().map(|k| k.id.clone()).collect()));
            cache.keys = keys.clone();
            cache.at = Some(Instant::now());
        }
        keys
    }

    /// §4a: the id of the per-app key presenting this request, if any.
    ///
    /// Constant-time over every candidate, and deliberately **without an early break**: `find`
    /// would stop at the first match and turn the order of the key list into a timing oracle.
    /// Costs nothing when no provider is attached, and is never called with memory off.
    pub fn app_key_for(&self, presented: &str) -> Option<String> {
        if presented.is_empty() {
            return None;
        }
        let mut hit = None;
        for k in self.app_keys() {
            if constant_time_eq(presented, &k.secret) {
                hit = Some(k.id.clone());
            }
        }
        hit
    }

    /// The principal a presented key is governed by, for the memory policy table (§4a).
    ///
    /// `None` means the secret is one we do not recognise: no row can name it, and absence
    /// inherits. That is deliberate — a caller we cannot identify is not thereby refused, it is
    /// simply ungoverned, and the master switch still applies.
    ///
    /// The master key resolves to `key:master`, **not** to `None`. It is the key most operators
    /// actually hand out, so leaving it unnameable would mean the busiest caller could never be
    /// governed: traffic presenting it with no `AIP-Agent` label would have no identity at all and
    /// would inherit whatever the operator had decided for everyone else. Cost is nil — the master
    /// key is already cached, so this is a comparison against a value in memory, never a keychain
    /// read.
    pub fn key_principal_for(&self, presented: &str) -> Option<String> {
        if presented.is_empty() {
            return None;
        }
        if let MasterKeyLookup::Ready(k) = self.master_key.get() {
            if constant_time_eq(presented, &k) {
                return Some(principal::master_principal());
            }
        }
        self.app_key_for(presented).map(|id| principal::key_principal(&id))
    }

    /// Shorten the app-key cache TTL. Test-only, for the same reason as `set_memory_freeze_ttl`.
    #[cfg(test)]
    pub fn set_app_key_cache_ttl(&self, d: Duration) {
        if let Ok(mut c) = self.app_key_cache.lock() {
            c.ttl = d;
        }
    }

    /// Attach the store so the request path can reach the memory/context layer. Builder, for the
    /// same reason as `with_app_keys`: `new()` must keep working without one.
    pub fn with_store(mut self, store: Arc<crate::core::store::Store>) -> Self {
        self.store = Some(store);
        self
    }

    /// The store, when one was attached. `None` in tests and whenever the gateway was built before
    /// the store existed — in which case the memory layer degrades to "no memory", never an error.
    #[allow(dead_code)] // Phase 2: the recall path reads through this.
    pub fn store(&self) -> Option<&Arc<crate::core::store::Store>> {
        self.store.as_ref()
    }

    /// Attach the egress allowlist so admin provider CRUD can keep it in step with
    /// `providers.base_url`. Builder, same as `with_store`.
    ///
    /// Without this, a provider created over HTTP would get a row and no grant: the allowlist
    /// derives from that column, so the adapter would dial a host `check_url` refuses and every
    /// request to it would fail — D46, created by the CRUD path rather than by a bad manifest.
    /// `aiproviderd` has no CRUD path of its own today (it computes the list once at boot), which
    /// is exactly why the routes need this handle.
    pub fn with_allowlist(mut self, allow: Arc<crate::core::egress::AllowList>) -> Self {
        self.allowlist = Some(allow);
        self
    }

    /// The allowlist, when one was attached.
    #[allow(dead_code)] // wired by the admin provider routes; the binary attaches it at boot.
    pub fn allowlist(&self) -> Option<&Arc<crate::core::egress::AllowList>> {
        self.allowlist.as_ref()
    }

    /// Whether the memory/context layer may recall and inject. Off by default; see the field.
    pub fn memory_enabled(&self) -> bool {
        self.memory_enabled.load(Ordering::Relaxed)
    }

    /// Flip the host-side memory toggle. Takes effect on the next request.
    ///
    /// The frozen blocks are dropped with it: a block frozen before the operator switched memory off
    /// was composed under a decision that has since changed, and serving it on the way back on would
    /// make the toggle feel like it had not worked.
    pub fn set_memory_enabled(&self, enabled: bool) {
        self.memory_enabled.store(enabled, Ordering::Relaxed);
        self.clear_frozen_memory();
    }

    /// §5.5: the frozen memory block for a `(scope, session)`, when one is still fresh and still
    /// fits `budget`.
    ///
    /// `None` means the caller has to recall, rank, trim and compose for itself. A block that no
    /// longer fits is treated the same way — re-composing is one cache miss, whereas shipping a
    /// block too large for the request is a correctness failure.
    pub fn frozen_memory(&self, key: &str, budget: usize) -> Option<FrozenMemory> {
        let ttl = self.memory_freeze_ttl();
        let mut map = self.memory_freeze.lock().ok()?;
        let entry = map.get(key)?;
        if entry.frozen_at.elapsed() >= ttl {
            map.remove(key);
            return None;
        }
        (entry.tokens <= budget).then(|| entry.clone())
    }

    /// §5.5: hold a composed block still for the next request in this `(scope, session)`.
    pub fn freeze_memory(
        &self,
        key: String,
        block: String,
        items: usize,
        tokens: usize,
        had_candidates: bool,
    ) {
        let Ok(mut map) = self.memory_freeze.lock() else {
            return;
        };
        // Swept on the way in rather than by a timer: there is no background task, and a request is
        // the only moment this map is ever touched.
        let ttl = self.memory_freeze_ttl();
        map.retain(|_, v| v.frozen_at.elapsed() < ttl);
        if map.len() >= MAX_FROZEN_BLOCKS && !map.contains_key(&key) {
            // Oldest out. The sweep already removed everything expired, so this only ever fires on a
            // genuinely busy gateway, and losing the oldest block costs one cache miss.
            if let Some(oldest) =
                map.iter().min_by_key(|(_, v)| v.frozen_at).map(|(k, _)| k.clone())
            {
                map.remove(&oldest);
            }
        }
        map.insert(
            key,
            FrozenMemory { block, items, tokens, had_candidates, frozen_at: Instant::now() },
        );
    }

    /// Drop every frozen block. Used by the memory toggle and by tests.
    pub fn clear_frozen_memory(&self) {
        if let Ok(mut m) = self.memory_freeze.lock() {
            m.clear();
        }
    }

    /// Shorten the freeze TTL. Test-only for the same reason `set_first_msg_timeout` is.
    #[cfg(test)]
    pub fn set_memory_freeze_ttl(&self, d: Duration) {
        if let Ok(mut g) = self.memory_freeze_ttl.lock() {
            *g = d;
        }
    }

    pub fn memory_freeze_ttl(&self) -> Duration {
        self.memory_freeze_ttl.lock().map(|g| *g).unwrap_or(MEMORY_FREEZE_TTL)
    }

    /// Record one request's memory outcome, for the Control screen.
    ///
    /// Called from the four ingress handlers — the only place that holds both the outcome and the
    /// client-visible request id. Deliberately *not* called from inside `inject_context`: that
    /// function has ~30 call sites in tests, none of which should be writing telemetry, and keeping
    /// the injection contract free of side effects is worth the four extra call sites.
    ///
    /// The `InjectionOutcome` → `InjectionEvent` mapping lives here rather than in the handlers: it is
    /// mechanical, and four copies of it are four chances to drop a field. `id` is the bridge slot id;
    /// the client-visible form is `gw-{id}`.
    ///
    /// Cannot fail a request. A poisoned lock is impossible (`panic = "abort"`), so the `unwrap` needs
    /// no handling.
    pub fn record_injection(
        &self,
        id: u64,
        model: &str,
        outcome: &context_scope::InjectionOutcome,
    ) {
        self.injection_log.lock().unwrap().record(InjectionEvent {
            ts_ms: crate::core::injection_log::now_ms(),
            id: format!("gw-{id}"),
            model: model.to_string(),
            scope: outcome.scope.clone(),
            injected: outcome.injected,
            items: outcome.items,
            context: outcome.context,
            tokens: outcome.tokens,
            reason: outcome.reason.as_str().to_string(),
        });
    }

    /// What the memory layer has done since launch.
    pub fn injection_stats(&self) -> InjectionStats {
        self.injection_log.lock().unwrap().snapshot()
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

    /// Attach the settings handle a `BridgeHost` reads, so the bridge and the core share one copy.
    ///
    /// A builder, like `with_app_keys`. The default it replaces is dropped rather than kept, so
    /// there is one live copy from the moment this returns — see [`HostSettings`] for why the two
    /// must not be two.
    pub fn with_host_settings(mut self, settings: HostSettings) -> Self {
        self.settings = settings;
        self
    }

    /// Whether the operator asked the gateway to serve at all.
    ///
    /// **This is the only liveness question the request path asks.** Increment 24c split it from a
    /// second one — `bridge_ready` — so that a Rust bridge would not be measured against a webview's
    /// heartbeat (D35); 25f deleted the webview, and with it the second question. See the note under
    /// `Bridge` for why the seam went rather than being kept with a constant answer.
    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::Relaxed)
    }

    pub fn set_running(&self, on: bool) {
        self.running.store(on, Ordering::Relaxed);
    }

    pub fn port(&self) -> u16 {
        *self.port.lock().unwrap()
    }

    /// Deliver one bridge message to the request waiting for it. Unknown/stale id = the client is
    /// already gone -> idempotent no-op.
    ///
    /// **No production caller, and that is the 25f result rather than a gap.** The eight
    /// `gateway_*` commands that used to be the webview's way back are deleted; the Rust bridge
    /// holds the `ReplyHandle` it was dispatched with and writes to it directly. What remains are
    /// the tests that pin `ReplyHandle`'s contract (`a_reply_for_a_finished_request_is_a_no_op`
    /// and friends), which reach it through this method.
    ///
    /// Delegates to the core's own `ReplyHandle` rather than keeping a second copy of the map, so
    /// the map has one owner and one authority. `ReplyHandle::reply` documents the return value.
    pub fn reply(&self, id: u64, msg: BridgeMsg) -> bool {
        self.replies.reply(id, msg)
    }

    /// Hand one request to the bridge, attaching the way back.
    ///
    /// The single dispatch entry point. Six handlers route requests and four of them live
    /// outside this module; giving each one `bridge.dispatch(req, replies)` by hand would be
    /// four chances to pass the wrong thing. Here they cannot.
    pub fn dispatch(&self, req: BridgeRequest) {
        self.bridge.dispatch(req, self.replies.clone());
    }

    fn close(&self, id: u64) {
        self.replies.close(id);
    }

    /// Whether gateway-supplied tools are on. Delegates to the shared handle — the same copy the
    /// bridge's host reads, so a toggle flipped on the Control screen reaches the request path.
    pub fn is_tools_enabled(&self) -> bool {
        self.settings.tools_enabled()
    }

    pub fn set_tools_enabled(&self, enabled: bool) {
        self.settings.set_tools_enabled(enabled);
    }

    /// Audit H1b: may gateway-side tools mutate the workspace? See [`HostSettings`] for why this is
    /// separate from `tools_enabled` and why it defaults to false.
    pub fn is_tools_mutation_enabled(&self) -> bool {
        self.settings.tools_mutation_enabled()
    }

    /// Audit H1b: is `tool` permitted on the gateway path? `Some(reason)` = refused.
    ///
    /// Delegates to the free [`gateway_tool_refusal`], which is where the rule and its message live
    /// — the Rust-native bridge needs the same answer and cannot hold a `GatewayCore`.
    pub fn gateway_tool_refusal(&self, tool: &str) -> Option<String> {
        gateway_tool_refusal(tool, self.is_tools_mutation_enabled())
    }

    pub fn set_tools_mutation_enabled(&self, enabled: bool) {
        self.settings.set_tools_mutation_enabled(enabled);
    }

    /// Set the workspace root for local tool execution. Must be set before any tool calls.
    pub fn set_workspace_root(&self, root: std::path::PathBuf) {
        self.settings.set_workspace_root(root);
    }

    /// Get the current workspace root. `None` only if it was explicitly cleared — `new()` starts at
    /// `default_workspace_root()`, which is what a gateway tool call executes against by default.
    pub fn workspace_root(&self) -> Option<std::path::PathBuf> {
        self.settings.workspace_root()
    }
}

/// How long a request waits for the bridge to say ANYTHING before giving up.
///
/// This was written for a suspended webview and it survives the webview because the property it
/// bounds is not about one: a bridge that accepts a dispatch and then never writes to its
/// `ReplyHandle` would otherwise hold the socket open forever with nothing logged. Failing with an
/// error the client can retry is strictly better than a hang. The suspected cause is now a bug in
/// the router loop rather than a napping renderer, and the message says what was observed rather
/// than guessing at which.
///
/// Only the FIRST message is bounded. Once the bridge is demonstrably working on the request, a
/// slow stream is a slow stream, and cutting it off would break long answers.
pub const FIRST_MSG_TIMEOUT: Duration = Duration::from_secs(30);

/// RAII slot: permit + registration + receiver, all released on drop — including on client
/// disconnect mid-stream, which is what makes §3.5 cancellation work.
struct Slot {
    core: Arc<GatewayCore>,
    _permit: OwnedSemaphorePermit,
    /// Held for the same lifetime as the slot, so a request that has been routed keeps its
    /// routing slot until it finishes — dropping it earlier would let a ninth request dispatch.
    _dispatch: OwnedSemaphorePermit,
    id: u64,
    rx: mpsc::UnboundedReceiver<BridgeMsg>,
    /// Set once the bridge has produced its first message; only that wait is bounded.
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
                    "bridge produced nothing for {}ms — failing the request instead of hanging",
                    bound.as_millis()
                );
                Some(BridgeMsg::Error {
                    status: 503,
                    // Report what was OBSERVED, not a guessed cause. This used to assert the
                    // window "may be suspended" — a hypothesis, never a measurement. That
                    // guess actively misdirected a diagnosis: a worker that was alive and
                    // merely slow on a large prompt was reported to the client as a dead
                    // window, and the search went after suspension instead of latency.
                    message: format!(
                        "the router produced no response within {}ms — the request was abandoned; retry",
                        bound.as_millis()
                    ),
                    // No upstream was contacted, so there is no real cooldown to report.
                    retry_after_ms: None,
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

/// 503 if the core is unreachable, 429 if over capacity, otherwise the Slot.
///
/// The `Err` is a whole `Response`, which `clippy::result_large_err` flags. Boxing it would be
/// worse, not better: the value is built once and consumed once, and no caller propagates with `?`
/// — three return it straight to hyper, two read only its `status()` and rebuild the envelope, and
/// one maps it. Boxing would buy a smaller `Result` and pay for it with a heap allocation on every
/// refusal, including the at-capacity 429, which is the one refusal that is hot by construction. So
/// the lint's premise (a large `Err` paid on the happy path) does not hold here.
#[allow(clippy::result_large_err)]
async fn try_slot(core: &Arc<GatewayCore>) -> Result<Slot, Response> {
    // Stopped is terminal, and it is now the *only* refusal here.
    //
    // There used to be a second gate below this one — `!is_available() && !await_core(core).await`
    // — which waited out a bridge that could not answer yet. It existed because the bridge was a
    // webview the OS could suspend. 25f deleted the webview, and with it the wait: nothing that can
    // become ready by waiting is left in the process, so a second gate could only ever fire from a
    // test double. See the note under `Bridge`.
    if !core.is_running() {
        return Err(err_ra(
            StatusCode::SERVICE_UNAVAILABLE,
            "1",
            openai_error("AI-Provider Router gateway is stopped", "service_unavailable", None),
        ));
    }
    // Admission first: the 41st request is refused outright, before it can occupy a socket.
    let Ok(permit) = core.permits.clone().try_acquire_owned() else {
        return Err(err_ra(
            StatusCode::TOO_MANY_REQUESTS,
            "1",
            openai_error("router at capacity", "rate_limit", None),
        ));
    };
    // Then wait for a ROUTING slot. This wait is the §3.5 queue: admitted, not yet dispatched.
    // `Semaphore::acquire_owned` is cancel-safe, and hyper drops this future when the client
    // disconnects, so a queued request never holds a routing slot for a caller that has gone.
    let dispatch = match core.dispatch.clone().acquire_owned().await {
        Ok(d) => d,
        Err(_) => {
            // Only reachable if the pool is closed (shutdown). Refuse rather than dispatch
            // unboundedly — an unbounded dispatch is exactly the defect this gate exists for.
            return Err(err_ra(
                StatusCode::TOO_MANY_REQUESTS,
                "1",
                openai_error("router at capacity", "rate_limit", None),
            ));
        }
    };
    let id = core.next_id.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = mpsc::unbounded_channel();
    core.replies.register(id, tx);
    Ok(Slot { core: core.clone(), _permit: permit, _dispatch: dispatch, id, rx, started: false })
}

// ---------- auth (invariants 10, 11, 15) ----------

/// The credential a client presented, whichever of the three dialects it used. Shared by auth and
/// by the memory path so the two can never disagree about who is asking — if a fourth header is
/// ever accepted, one edit covers both.
pub(crate) fn presented_key(headers: &HeaderMap) -> &str {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        // Anthropic clients (Claude Code, anthropic-sdk) send the key in x-api-key;
        // Gemini clients use x-goog-api-key (or ?key=, handled in the Gemini handler).
        .or_else(|| headers.get("x-api-key").and_then(|v| v.to_str().ok()))
        .or_else(|| headers.get("x-goog-api-key").and_then(|v| v.to_str().ok()))
        .unwrap_or("")
}

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

/// `Err(response)` denies; `Ok(app_key_id)` allows — `Some` naming the per-app key that
/// authenticated, `None` meaning the master key did.
///
/// The master key comes from a bounded cache that `gateway_key_generate` / `gateway_key_revoke`
/// invalidate, so rotation still kills the old key on the very next request (§3.3, criterion 8)
/// — but without a keychain read per request. That read can block indefinitely, and unbounded it
/// takes the entire HTTP surface down with it. Per-app keys are still read per request.
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
///
/// The identity is returned rather than recomputed by the caller: this is the one place that
/// knows *which* credential matched, and a second lookup elsewhere would be a second authority
/// free to drift from this one.
fn check_gateway_key(
    core: &GatewayCore,
    headers: &HeaderMap,
    ip: IpAddr,
) -> Result<Option<String>, GateRefusal> {
    if !core.running.load(Ordering::Relaxed) {
        return Err(GateRefusal {
            status: StatusCode::SERVICE_UNAVAILABLE,
            message: "gateway disabled".into(),
            retry_after: Some("1"),
            openai_type: "service_unavailable",
            openai_code: None,
        });
    }
    let stored = match core.master_key.get() {
        MasterKeyLookup::Ready(k) => k,
        MasterKeyLookup::Absent => {
            return Err(GateRefusal {
                status: StatusCode::UNAUTHORIZED,
                message: "no master key configured".into(),
                retry_after: None,
                openai_type: "invalid_request",
                openai_code: Some("invalid_api_key"),
            });
        }
        MasterKeyLookup::Unavailable => {
            // The keychain did not answer in time. A 401 here would blame the caller's credential
            // for a purely local fault and send it hunting for a new key, so say what happened.
            return Err(GateRefusal {
                status: StatusCode::SERVICE_UNAVAILABLE,
                message: "master key unavailable — the OS keychain did not respond; approve the keychain prompt for this app, then retry".into(),
                retry_after: Some("5"),
                openai_type: "service_unavailable",
                openai_code: None,
            });
        }
    };
    let presented = presented_key(headers);
    // Stays `None` on the master-key path: the master is not a per-app key, so there is no
    // `gateway_keys.id` to attribute the spend to.
    let mut matched_app: Option<String> = None;
    let mut matched = constant_time_eq(presented, &stored);
    if !matched {
        // R4: per-app key. Every comparison is constant-time, and we deliberately do NOT break
        // early on a match that is followed by more keys (no length/first-byte oracle).
        // `app_keys` memoises the keychain reads, so this is not N of them per request.
        for k in core.app_keys() {
            if constant_time_eq(presented, &k.secret) {
                matched = true;
                matched_app = Some(k.id);
            }
        }
    }
    if matched {
        core.failures.lock().unwrap().remove(&ip);
        // The identity is passed, not just the fact of authentication: a per-app cap can only be
        // enforced against the app that is actually asking. `None` is the master key.
        if let Some(r) = spend_gate(core, matched_app.as_deref()) {
            return Err(r);
        }
        return Ok(matched_app);
    }
    if !auth_allowed(core, ip) {
        return Err(GateRefusal {
            status: StatusCode::TOO_MANY_REQUESTS,
            message: "too many failed auth attempts — backing off".into(),
            retry_after: Some("30"),
            openai_type: "rate_limit",
            openai_code: None,
        });
    }
    note_auth_failure(core, ip);
    Err(GateRefusal {
        status: StatusCode::UNAUTHORIZED,
        message: "invalid gateway key".into(),
        retry_after: None,
        openai_type: "invalid_request",
        openai_code: Some("invalid_api_key"),
    })
}

/// R4: deny once a spend limit has been reached. Checked *after* auth so the caps (and the
/// current spend) are never disclosed to an unauthenticated caller.
///
/// Two limits, checked in order, with **different codes**:
///
/// - the **global** cap, which applies to every caller including the master key;
/// - the **per-app** cap, which applies only when the request authenticated with a per-app key
///   that has one.
///
/// The distinct code matters more than it looks. Both are `402 insufficient_quota`, so a client
/// that branches on `error.type` alone cannot tell "the owner's whole budget is gone" from "this
/// one app's slice is gone" — and those have opposite remedies. The first is an operator problem
/// that stops every app; the second is fixed by raising one key's budget, or by the app waiting
/// for the month to turn. A body that says which is the difference between a diagnosable refusal
/// and a support ticket.
///
/// 402 is deliberate: it is the one status clients already read as "you are out of credit",
/// so a runaway agent loop stops retrying instead of hammering a 429/403.
fn spend_gate(core: &GatewayCore, app_key_id: Option<&str>) -> Option<GateRefusal> {
    // Clone the Arc out of the lock before calling it — never hold a mutex across a DB read.
    let provider = core.spend_provider.lock().ok().and_then(|g| g.clone())?;
    let limits = provider(app_key_id);

    if limits.total_cap_micros > 0 && limits.total_micros >= limits.total_cap_micros {
        return Some(GateRefusal {
            status: StatusCode::PAYMENT_REQUIRED,
            message: format!(
                "monthly spend cap reached — {}/{} micro-USD this month",
                limits.total_micros, limits.total_cap_micros
            ),
            retry_after: Some("0"),
            openai_type: "insufficient_quota",
            openai_code: Some("spend_cap_exceeded"),
        });
    }

    // Both halves are required: `app_micros` is `None` for the master key, and `app_cap_micros`
    // is `None` for an app that was never given a budget. Either alone means "no per-app limit
    // applies", so the pair is destructured rather than collapsed into one number.
    //
    // Two independent defences guard the uncapped case, and it is worth knowing which is which:
    // the destructure, and the `cap > 0` test below. Measured 2026-09-23 — collapsing to
    // `app_cap_micros.unwrap_or(0)` is *harmless while `cap > 0` stands*, because the guard
    // short-circuits first; the zero only becomes a refusal of every uncapped app when both are
    // removed together. The test for this pins the observable property, not either mechanism.
    if let (Some(spent), Some(cap)) = (limits.app_micros, limits.app_cap_micros) {
        if cap > 0 && spent >= cap {
            return Some(GateRefusal {
                status: StatusCode::PAYMENT_REQUIRED,
                message: format!(
                    "this app's monthly budget is spent — {spent}/{cap} micro-USD this month"
                ),
                retry_after: Some("0"),
                openai_type: "insufficient_quota",
                openai_code: Some("app_budget_exceeded"),
            });
        }
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

/// Why the gate refused a request, before any upstream work.
///
/// Deliberately **not** a `Response`. The gate is shared by every dialect, and *framing* its refusal
/// is the dialect's job — returning a finished response from here is what put an OpenAI-shaped error
/// envelope in front of Anthropic, Responses and Gemini clients, whose SDKs read different fields
/// (`error.type`; `error.code` as an integer plus `error.status` as an enum). A Gemini client was
/// handed `error.code: null` with no `status` at all, so it could not classify its own auth failure.
///
/// Same rule as `worker_status`: the layer holding the evidence decides the outcome, and the dialect
/// decides the shape.
pub(crate) struct GateRefusal {
    pub status: StatusCode,
    pub message: String,
    /// Seconds before a retry is worth attempting. Only set where retrying can actually help.
    pub retry_after: Option<&'static str>,
    /// OpenAI's `(type, code)` pair — used only by the dialects that share that envelope.
    pub openai_type: &'static str,
    pub openai_code: Option<&'static str>,
}

impl GateRefusal {
    fn frame(self, body: Value) -> Response {
        match self.retry_after {
            Some(secs) => {
                (self.status, [(header::RETRY_AFTER, secs)], axum::Json(body)).into_response()
            }
            None => (self.status, axum::Json(body)).into_response(),
        }
    }

    /// OpenAI envelope. Also correct for the Responses API, which shares the shape.
    pub fn openai(self) -> Response {
        let body = openai_error(&self.message, self.openai_type, self.openai_code);
        self.frame(body)
    }

    /// Anthropic envelope — `error.type` follows the status, because clients branch on it.
    pub fn anthropic(self) -> Response {
        let body = anthropic_error(&self.message, anthropic_error_kind(self.status));
        self.frame(body)
    }

    /// Gemini envelope — `code` and `status` both follow the HTTP status.
    pub fn gemini(self) -> Response {
        let body = gemini::gemini_error_body(&self.message, self.status);
        self.frame(body)
    }
}

fn err(status: StatusCode, body: Value) -> Response {
    (status, axum::Json(body)).into_response()
}

/// Map the status the bridge decided onto the status we answer with.
///
/// The bridge applied a deliberate whitelist (`gatewayStatus()` in `gateway-bridge.ts`, deleted in
/// 25f and ported to Rust as `bridge_policy::gateway_status`): it passes through only
/// client-attributable upstream codes (400/404/413/422/429), maps a missing route to 404, and maps
/// everything else to 502.
///
/// Re-deciding here with a second, narrower list silently threw most of that away. The OpenAI chat
/// path knew only 404/429/401/503, so a 400 became 502; the Anthropic, Responses, models and Gemini
/// paths discarded the status entirely and answered 502 for everything. The effect was to tell a
/// client its request had hit a broken gateway when the request itself could never succeed —
/// inviting retries that can never work.
///
/// So trust the bridge's decision, and reject only a value that cannot be a real HTTP error status.
pub(crate) fn worker_status(status: u16) -> StatusCode {
    StatusCode::from_u16(status)
        .ok()
        .filter(|c| c.is_client_error() || c.is_server_error())
        .unwrap_or(StatusCode::BAD_GATEWAY)
}

/// The Anthropic error `type` that belongs to an HTTP status.
///
/// Anthropic clients branch on `error.type`, not on the status alone — Claude Code decides whether
/// to retry, re-authenticate, or fix the request from it. Answering `api_error` to a 400 tells the
/// client to retry a request that can never succeed, which is the same defect as answering 502.
/// The mapping mirrors Anthropic's published error taxonomy.
pub(crate) fn anthropic_error_kind(status: StatusCode) -> &'static str {
    match status.as_u16() {
        400 => "invalid_request_error",
        401 => "authentication_error",
        403 => "permission_error",
        404 => "not_found_error",
        413 => "request_too_large",
        429 => "rate_limit_error",
        503 | 529 => "overloaded_error",
        _ => "api_error",
    }
}

/// An error response carrying a `Retry-After` header. `retry` accepts anything that becomes a
/// `String`, so a literal (`"1"`) and a computed cooldown both work at the call site.
fn err_ra(status: StatusCode, retry: impl Into<String>, body: Value) -> Response {
    (status, [(header::RETRY_AFTER, retry.into())], axum::Json(body)).into_response()
}

/// Whole seconds for a `Retry-After` header, from a worker-reported cooldown in milliseconds.
///
/// Rounds up, and never returns `0`: a sub-second cooldown still reads as "wait 1s". `None` when
/// the worker reported no cooldown — the caller then leaves the header off, and the
/// `ensure_retry_after` middleware supplies its own 1s floor.
pub(crate) fn cooldown_secs(retry_after_ms: Option<u64>) -> Option<String> {
    retry_after_ms.filter(|&ms| ms > 0).map(|ms| ms.div_ceil(1000).max(1).to_string())
}

/// Error response for a failed worker request, honouring the provider's own cooldown.
///
/// A 429 carrying the cooldown the provider asked for sets `Retry-After` to it, so the client
/// waits the window out. Without this the client gets the middleware's 1s floor and retries
/// straight back into the window it was told to wait — the shape of the ZCode burst (seven 429s
/// in thirteen seconds). Every other status is answered exactly as `err` would.
pub(crate) fn err_with_cooldown(
    status: StatusCode,
    retry_after_ms: Option<u64>,
    body: Value,
) -> Response {
    if status == StatusCode::TOO_MANY_REQUESTS {
        if let Some(secs) = cooldown_secs(retry_after_ms) {
            return err_ra(status, secs, body);
        }
    }
    err(status, body)
}

/// The peer identity the auth backoff is bucketed by.
///
/// Returning a constant looks like a bug and is not one. `spawn()` binds `127.0.0.1` (invariant
/// 11, pinned by `the_listener_binds_loopback_only`), so *every* peer genuinely is loopback —
/// reading the real address would return this same value. One bucket is therefore correct today.
///
/// Two things follow, and both are deliberate:
/// 1. If the bind is ever widened, this MUST change to the real peer address, or distinct clients
///    merge into one bucket. The test above fails the build when that day comes.
/// 2. Keying on the peer *socket* (IP + port) instead would separate concurrent callers, but a
///    client that opens a fresh connection per attempt then gets a fresh bucket each time —
///    trading cross-caller attribution for a backoff any attacker can reset. On a loopback-only
///    gateway the shared bucket is the stronger of the two. See audit finding H2.
fn peer_ip(_headers: &HeaderMap) -> IpAddr {
    IpAddr::V4(Ipv4Addr::LOCALHOST)
}

/// Extract headers relevant for client detection (User-Agent, X-Client-Name, etc.).
fn forwarded_headers(headers: &HeaderMap) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for key in [
        "user-agent",
        "x-client-name",
        "x-codex-client",
        "accept",
        "x-api-key",
        "anthropic-version",
    ] {
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

/// Admin HTTP routes for the UI (dev-book §10 §5.3 + Phase 6 step 4).
///
/// A child of `gateway` for the same reason `handlers` is: these routes need the request-path
/// helpers (`check_gateway_key`, `peer_ip`) without widening them to the whole crate. Declared
/// `pub` so the headless binary can name the surface in its own docs, but the routes themselves
/// are registered by `spawn` below, which every caller goes through.
#[path = "gateway_admin.rs"]
pub mod admin;
#[path = "gateway_anthropic.rs"]
mod anthropic;
#[path = "context_scope.rs"]
pub mod context_scope;
#[path = "gateway_gemini.rs"]
mod gemini;
#[path = "gateway_handlers.rs"]
mod handlers;
#[path = "model_context.rs"]
pub mod model_context;
#[path = "principal.rs"]
pub mod principal;
#[path = "gateway_responses.rs"]
mod responses;
#[path = "session_context.rs"]
pub mod session_context;

use anthropic::{count_tokens_h, messages_h};
use gemini::gemini_h;
use handlers::{chat_h, image_h, method_not_allowed, models_h, unknown_route};
use responses::responses_h;

#[cfg(test)]
#[path = "gateway_tests.rs"]
mod tests;

fn map_generic_to_status(r: Response) -> Response {
    let status = r.status();
    let body = openai_error(
        if status == StatusCode::TOO_MANY_REQUESTS {
            "router at capacity"
        } else {
            "AI-Provider Router core unavailable — is the app open?"
        },
        if status == StatusCode::TOO_MANY_REQUESTS { "rate_limit" } else { "service_unavailable" },
        None,
    );
    (status, axum::Json(body)).into_response()
}

// ---------- master key + server lifecycle ----------

/// A crypto-random gateway credential. 32 hex chars from OsRng (same shape as the master key,
/// so external apps cannot tell a per-app key from the master one).
pub fn generate_random_key() -> String {
    let raw: String =
        (0..32).map(|_| format!("{:x}", rand::rngs::OsRng.gen_range(0..16))).collect();
    format!("sk-aip-{raw}")
}

/// Copy arbitrary text to the clipboard host-side (invariant 14: never crosses the DOM).
pub fn copy_text(text: &str) -> Result<(), String> {
    let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    cb.set_text(text.to_string()).map_err(|e| e.to_string())
}

/// Generate a fresh master key (`sk-aip-` + 32 hex), store it in the keychain, return it
/// exactly once for display (§3.3).
///
/// Private deliberately. Rotation must go through `GatewayCore::rotate_master_key`, which drops
/// the cached key as part of the same operation. A caller that wrote the keychain without
/// invalidating the cache would leave the OLD key working — silently, with no failing test,
/// because the write itself succeeds.
fn generate_master_key() -> Result<String, String> {
    let raw: String =
        (0..32).map(|_| format!("{:x}", rand::rngs::OsRng.gen_range(0..16))).collect();
    let key = format!("sk-aip-{raw}");
    vault::put(MASTER_ACCOUNT, &key).map_err(|e| e.to_string())?;
    Ok(key)
}

/// Delete the master key. Private for the same reason as `generate_master_key`.
fn revoke_master_key() -> Result<(), String> {
    vault::delete(MASTER_ACCOUNT).map_err(|e| e.to_string())
}

/// Copy the master key to the clipboard host-side (invariant 14: never crosses the DOM).
pub fn copy_master_key() -> Result<(), String> {
    let key =
        vault::get(MASTER_ACCOUNT).map_err(|e| e.to_string())?.ok_or("no master key exists")?;
    let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    cb.set_text(key).map_err(|e| e.to_string())
}

/// The port the gateway should come back up on, or `None` when it was left off.
///
/// The gateway is a local endpoint other processes point at — WorkBuddy's custom-provider entry
/// among them — so "was serving" is a setting, not a session detail. A gateway that needs a click
/// after every relaunch silently breaks every client configured against it.
///
/// Lives in `core/` because two processes now read it: the desktop app restoring its own
/// gateway, and `aiproviderd` picking a port at boot. One authority — two copies of this query
/// would drift the moment one of them gained a fallback.
pub fn persisted_gateway_port(store: &crate::core::store::Store) -> Option<u16> {
    let conn = store.conn.lock().unwrap();
    let value: String = conn
        .query_row("SELECT value_json FROM settings WHERE key = 'gateway'", [], |r| r.get(0))
        .ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&value).ok()?;
    if !(parsed.get("enabled")?.as_bool()?) {
        return None;
    }
    Some(parsed.get("port")?.as_u64()? as u16)
}

pub struct ServerHandle {
    pub shutdown: oneshot::Sender<()>,
    pub addr: SocketAddr,
}

/// Every 429 this gateway emits carries a `Retry-After`.
///
/// Enforced here rather than at the ten places a dialect frames an upstream error: one dialect
/// that forgot would drift from the others with no failing test. The gap this closes is the
/// upstream 429 — a provider rate limit reached the client as a bare 429, which reads as "retry
/// immediately". Capacity and auth-backoff refusals already set their own value, so a value that
/// is already present is never overwritten.
///
/// `1` is a floor, not the provider's real window: the worker reports a status but no retry hint.
/// It matches the core's own key-cooldown floor (`health-tracker.ts`:
/// `cooldownUntil = now + max(retryAfterMs ?? 0, 1000)`), so the key is eligible again by the time
/// a client that honours the header comes back.
async fn ensure_retry_after(req: Request<Body>, next: Next) -> Response {
    let mut resp = next.run(req).await;
    if resp.status() == StatusCode::TOO_MANY_REQUESTS
        && !resp.headers().contains_key(header::RETRY_AFTER)
    {
        resp.headers_mut().insert(header::RETRY_AFTER, HeaderValue::from_static("1"));
    }
    resp
}

/// CORS middleware for the gateway (dev-book §10, step 5).
///
/// The UI runs on `tauri://localhost` (production) or `http://localhost:<vite-port>` (dev),
/// while the gateway listens on `http://127.0.0.1:<port>`. Without CORS headers the browser's
/// same-origin policy blocks every `fetch()` the UI makes.
///
/// Allowed origins: `tauri://localhost`, `http://localhost*`, `http://127.0.0.1*`. External
/// clients (curl, AI Hub) send no `Origin` header and are unaffected — CORS is a browser-only
/// mechanism.
///
/// `OPTIONS` preflight is answered here (204 No Content) before any route or auth check, so an
/// unauthenticated preflight never reaches `check_gateway_key`. This is correct: a preflight
/// carries no credentials and must not be gated by the master key.
async fn cors_headers(req: Request<Body>, next: Next) -> Response {
    let origin = req.headers().get(header::ORIGIN).cloned();
    if req.method() == Method::OPTIONS {
        let mut resp = Response::new(Body::empty());
        *resp.status_mut() = StatusCode::NO_CONTENT;
        apply_cors(&mut resp, origin.as_ref());
        return resp;
    }
    let mut resp = next.run(req).await;
    apply_cors(&mut resp, origin.as_ref());
    resp
}

/// Set CORS headers on a response, allowing the request's origin if it is local.
fn apply_cors(resp: &mut Response, origin: Option<&HeaderValue>) {
    let Some(origin) = origin else { return };
    let Ok(s) = origin.to_str() else { return };
    let allowed = s == "tauri://localhost"
        || s.starts_with("http://localhost")
        || s.starts_with("http://127.0.0.1");
    if !allowed {
        return;
    }
    let h = resp.headers_mut();
    h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin.clone());
    h.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, POST, PUT, DELETE, OPTIONS"),
    );
    h.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static(
            "Authorization, Content-Type, x-api-key, x-goog-api-key, AIP-Agent, AIP-Memory",
        ),
    );
    h.insert(header::ACCESS_CONTROL_MAX_AGE, HeaderValue::from_static("86400"));
}

/// Liveness probe for the standalone service (`aiproviderd`) and for the UI's service
/// discovery (dev-book §10 4.2).
///
/// Deliberately the one unauthenticated route. Every other route — including the 404 and 405
/// refusals — authenticates first, because an unauthenticated answer is a statement that the
/// route exists. This one answers before any key is produced, because a client that does not
/// yet hold a key must still be able to find the service; and it reports exactly one bit ("a
/// process is listening"), never the version, the key state, or the route inventory.
async fn health_h() -> Response {
    (StatusCode::OK, axum::Json(json!({ "status": "ok" }))).into_response()
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
        .route("/health", get(health_h))
        .route("/v1/models", get(models_h))
        .route("/v1/chat/completions", post(chat_h))
        .route("/v1/images/generations", post(image_h))
        .route("/v1/messages", post(messages_h))
        .route("/v1/messages/count_tokens", post(count_tokens_h))
        .route("/v1/responses", post(responses_h))
        .route("/v1beta/models/{*tail}", post(gemini_h))
        // Admin surface for the UI (dev-book §10 §5.3). The `PUT`-less set is deliberate: a
        // settings write is a *merge*, so `POST /admin/settings` is the only one there is — see
        // `gateway_admin`. Declared here rather than in the headless binary so the in-app gateway
        // serves the identical surface, which is the whole point of the pure-HTTP decision: one
        // contract, whichever process is listening on the port.
        .route("/admin/settings", get(admin::settings_get_h).post(admin::settings_set_h))
        .route("/admin/keys", get(admin::keys_list_h).post(admin::key_create_h))
        .route("/admin/keys/{id}", delete(admin::key_revoke_h))
        .route("/admin/spend", get(admin::spend_h))
        .route("/admin/providers", get(admin::providers_list_h).post(admin::provider_upsert_h))
        .route("/admin/providers/{id}", delete(admin::provider_delete_h))
        .route("/admin/api-keys", get(admin::api_keys_list_h).post(admin::api_key_upsert_h))
        .route("/admin/api-keys/{id}", delete(admin::api_key_delete_h))
        .route(
            "/admin/manifests",
            get(admin::manifests_list_h).post(admin::manifest_upsert_active_h),
        )
        .route("/admin/manifests/{id}/activate", post(admin::manifest_activate_h))
        .route(
            "/admin/models-cache",
            get(admin::models_cache_list_h).post(admin::models_cache_replace_h),
        )
        .route("/admin/aliases", get(admin::aliases_list_h).post(admin::aliases_replace_h))
        .route("/admin/ledger", get(admin::ledger_recent_h))
        // Memory and context. The static segments are declared before `/admin/memory/{id}` so a
        // literal path is never captured as an id — the ordering is load-bearing, not cosmetic.
        .route(
            "/admin/memory",
            get(admin::memory_list_h).post(admin::memory_capture_h).delete(admin::memory_clear_h),
        )
        .route("/admin/memory/batch", post(admin::memory_capture_batch_h))
        .route("/admin/memory/recall", post(admin::memory_recall_h))
        .route("/admin/memory/stats", get(admin::memory_stats_h))
        .route("/admin/memory/conflicts", get(admin::memory_conflicts_h))
        .route("/admin/memory/prune", post(admin::memory_prune_h))
        .route("/admin/memory/supersede", post(admin::memory_supersede_h))
        .route(
            "/admin/memory/principals",
            get(admin::memory_principal_list_h).post(admin::memory_principal_set_h),
        )
        .route("/admin/memory/session/{session_id}", get(admin::memory_session_atoms_h))
        .route("/admin/memory/{id}", delete(admin::memory_forget_h).put(admin::memory_update_h))
        .route("/admin/memory/{id}/pin", post(admin::memory_set_pinned_h))
        .route("/admin/memory/{id}/scope", post(admin::memory_assign_scope_h))
        .route("/admin/memory/{id}/unsupersede", post(admin::memory_unsupersede_h))
        .route(
            "/admin/context",
            get(admin::context_graph_h)
                .post(admin::context_record_h)
                .delete(admin::context_clear_h),
        )
        // Both refusals authenticate first, for the same reason `unknown_route` does: an
        // unauthenticated 404 or 405 is a statement that the route exists.
        .method_not_allowed_fallback(method_not_allowed)
        .fallback(unknown_route)
        .layer(middleware::from_fn(ensure_retry_after))
        .layer(middleware::from_fn(cors_headers))
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
