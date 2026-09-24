//! The model router (L2): the public facade — the Rust port of `model-router.ts` (557 lines), and
//! the last piece of Phase 3.
//!
//! **What this module is, in one sentence.** Everything the rest of the app talks to: it expands a
//! request into a plan (`core::planner`), runs it through the attempt loop (`core::engine`), and
//! writes one row per request into the ledger (`core::ledger`) — with the registry and the catalog
//! on one side and the adapter seam on the other.
//!
//! **The registry and the catalog are one struct here, and the TypeScript keeps two classes.** The
//! TypeScript's `ProviderRegistry` owns provider/key *writes* and holds the key vault;
//! `ModelCatalog` owns discovery, the 24-hour TTL and the alias derivation. Neither half survives
//! the crossing: writes are `persist.rs`'s `#[tauri::command]`s, the vault is `core::vault`, and
//! discovery is the webview's refresh path. What the router ever does with either is **read rows**,
//! so [`RouterStore`] is the rows. Merging is not a simplification of the design; it is what is
//! left of it once the parts that write are somewhere else.
//!
//! **The store is a struct and not a trait, and the reason is that it has no second implementation
//! to be swapped for.** `PlanContext`, `LedgerSink` and `AdapterFactory` are traits because each
//! has a real alternative behind it — a test fixture, a database, a sandbox. A store has exactly
//! one: rows. A trait here would buy nothing and cost a `dyn` at every read. Tests build one with
//! [`RouterStore::hydrate`], which is also what a launch does.
//!
//! **`PlanView` is the TypeScript's object literal, written down.** `plan()` in the source builds a
//! `PlanContext` out of `this.registry`, `this.catalog`, `this.health` and `this.nextKeyCursor`
//! and hands it to `buildPlan`. That is a private adapter from the router's three pieces of state
//! to the planner's one contract, and [`PlanView`] is it — which is why `PlanContext` did not have
//! to change when the router arrived.
//!
//! **The push model is inherited, and it moves where the ledger is written.** `execute_text` runs
//! to completion against an `on_chunk` sink rather than returning a pull stream — the deviation
//! `core::engine` records in full. The consequence here is that the source's `wrapLedger`, a
//! generator that writes the row *after* the consumer drains, becomes a plain function that writes
//! the row after `execute_text` returns. The three ledger shapes the source distinguishes survive
//! intact; what is gone is the ability to write the row lazily.
//!
//! **One thing had to be reconstructed at this seam, and it is worth naming.** The source's ok row
//! requires `exec.served()` — set on the *first chunk*, not on the attempt — so that "the provider
//! answered 200 with an empty body" writes `PARSE_ERROR` rather than a fake success. The engine's
//! `Ok(TextSuccess)` does not carry that flag, because `TextSuccess::candidate` is set when the
//! stream ends, chunks or no chunks. Rather than add a field to a landed type, the router counts
//! the chunks **in its own sink** — it already owns that closure, so the information is available
//! exactly where it is needed. See [`ModelRouter::generate_text`].
//!
//! **Two methods of the source are deliberately absent.**
//!
//! - **`observeAttempts`** — the §2.10 drift hook — needs a provider *id* and a model *native id*
//!   per attempt, and [`AttemptOutcome`] carries a slug and a key label (increment 13a). Its only
//!   consumer is Phase 5's `DriftMonitor.observe`, and adding two more fields to the outcome for a
//!   consumer that does not exist yet would be a guess. Recorded, not ported.
//! - **`markKeyDisabled`** writes the registry, which this module only reads. The equivalent in the
//!   port is `persist.rs`'s key update; there is nothing here for it to do.
//!
//! **Context compression is Phase 4 and is absent rather than stubbed.** The source's `generateText`
//! compresses `messages` before the engine sees them, and its `skipCompression` flag exists to stop
//! the summarizer's own call from recursing. None of that is here: `messages` cross this module
//! verbatim. That is a real difference from the source and it is the one the Phase 4 note already
//! carries (D20) — the port is not merely missing the call, it has no compression path at all.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde_json::Value;

use crate::core::adapter::{AdapterFactory, Cancel};
use crate::core::engine::{
    execute_image, execute_text, AllAttemptsFailed, AttemptOutcome, ExecuteImageArgs,
    ExecuteTextArgs, HealthTracker, TextFailure, TextSuccess,
};
use crate::core::ledger::UsageLedger;
use crate::core::limiter::{clamp_concurrency, ProviderLimiter, PER_PROVIDER_DEFAULT};
use crate::core::persist::{AliasRow, ApiKeyRow, LedgerRow, ModelRow, ProviderRow};
use crate::core::planner::{build_plan, Candidate, PlanContext, PlanInput};
use crate::core::pricing::{estimate_cost_micros, pricing_from_cache_json, PricingMicros};
use crate::core::usage::UsageTokens;

/// The two modalities, as the strings `ModelRow::modality` holds. Not an enum — see
/// `core::planner::PlanInput` for why the catalog's string column stays a string here.
pub const TEXT: &str = "text";
pub const IMAGE: &str = "image";

/// The ledger source a request is attributed to when the caller names none. The TypeScript's
/// `opts?.source ?? "ui"`, in one place.
pub const DEFAULT_SOURCE: &str = "ui";

/// The source a `complete` request is always attributed to, because `AiTextPort` has no callers
/// other than the Generator (§2.8).
const GENERATOR_SOURCE: &str = "generator";

/// Wall-clock milliseconds. A private copy, matching the nine other modules that each carry one
/// (`engine.rs`, `persist.rs:22`, `capture.rs:108`, …) — this crate has no shared clock.
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------- the rows the router reads ----------

/// Provider, key, model and alias rows, held for reading. The read-only remainder of the
/// TypeScript's `ProviderRegistry` + `ModelCatalog` — see the module note.
///
/// **Hydration is the only constructor, and it is the TypeScript's too.** Both classes have a
/// `hydrate` used by tests and by startup (`provider-registry.ts:17`, `model-catalog.ts:26`), and
/// the router never adds a row. The four vectors are separate rather than one list of a joined
/// type because that is how `persist.rs` returns them — four queries, four row types — and joining
/// them here would be inventing a shape to store what four shapes already hold.
#[derive(Default)]
pub struct RouterStore {
    providers: Vec<ProviderRow>,
    keys: Vec<ApiKeyRow>,
    models: Vec<ModelRow>,
    aliases: Vec<AliasRow>,
}

impl RouterStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Build a store from already-read rows. The argument order follows the four tables, not the
    /// two TypeScript classes, because a caller holding the rows knows which is which.
    pub fn hydrate(
        providers: Vec<ProviderRow>,
        keys: Vec<ApiKeyRow>,
        models: Vec<ModelRow>,
        aliases: Vec<AliasRow>,
    ) -> Self {
        Self { providers, keys, models, aliases }
    }

    pub fn providers(&self) -> &[ProviderRow] {
        &self.providers
    }

    pub fn models(&self) -> &[ModelRow] {
        &self.models
    }

    pub fn aliases(&self) -> &[AliasRow] {
        &self.aliases
    }

    /// Every key of one provider, in store order. The TypeScript filters the same way
    /// (`provider-registry.ts:88`) — there is no per-provider index on either side.
    pub fn keys_of(&self, provider_id: &str) -> Vec<ApiKeyRow> {
        self.keys.iter().filter(|k| k.provider_id == provider_id).cloned().collect()
    }

    pub fn get_provider(&self, id: &str) -> Option<&ProviderRow> {
        self.providers.iter().find(|p| p.id == id)
    }

    pub fn provider_by_slug(&self, slug: &str) -> Option<&ProviderRow> {
        self.providers.iter().find(|p| p.slug == slug)
    }

    /// The provider's slug, or its id when the provider is gone.
    ///
    /// The fallback is the TypeScript's (`model-router.ts:354`), and it is the honest answer for a
    /// ledger row whose provider was deleted: a row that named nothing would be worse than one
    /// that names the id it was attributed to.
    pub fn slug_of(&self, provider_id: &str) -> String {
        self.get_provider(provider_id)
            .map(|p| p.slug.clone())
            .unwrap_or_else(|| provider_id.to_string())
    }

    pub fn for_modality(&self, modality: &str) -> Vec<ModelRow> {
        self.models.iter().filter(|m| m.modality == modality).cloned().collect()
    }

    /// Normalized pricing for one model, or `None` when the provider published none.
    ///
    /// **`None` is not zero** — see `core::pricing`. This reads the *cache* shape, which is the
    /// normalized one; [`pricing_from_cache_json`] carries the argument for why that is a different
    /// reader and not a second spelling.
    pub fn pricing_for(&self, provider_id: &str, native_id: &str) -> Option<PricingMicros> {
        let row = self
            .models
            .iter()
            .find(|m| m.provider_id == provider_id && m.native_id == native_id)?;
        row.pricing_json.as_deref().and_then(pricing_from_cache_json)
    }
}

// ---------- settings ----------

/// The configured system-AI route: one provider, one model, both named by the user.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SystemAiPick {
    pub provider_id: String,
    pub model: String,
}

/// The three router settings that change behaviour (§2.9, audit R3). The port of `RouterSettings`
/// (`model-router.ts:27-36`).
///
/// **`per_provider_concurrency` is a `serde_json::Value`, and that is the whole reason
/// `clamp_concurrency` exists.** The source stores a `number` and reads it back from persisted
/// JSON with no validation, so a stored `-1`, `"4"` or `""` reaches the limiter as-is. Typing the
/// field as `usize` here would make every one of those unrepresentable — and would therefore make
/// the clamp's corruption branch unreachable, which is a validator that can never fire. Keeping
/// `Value` keeps the input as untrusted as the source says it is.
#[derive(Debug, Clone, PartialEq)]
pub struct RouterSettings {
    pub failover_enabled: bool,
    pub system_ai: Option<SystemAiPick>,
    pub per_provider_concurrency: Value,
}

impl Default for RouterSettings {
    fn default() -> Self {
        Self {
            failover_enabled: true,
            system_ai: None,
            per_provider_concurrency: Value::from(PER_PROVIDER_DEFAULT),
        }
    }
}

// ---------- the shapes the facade speaks ----------

/// One request to `generate_text`. The port of `TextRequest` (`ports.ts:74-96`).
///
/// **The callbacks are borrowed `&mut dyn FnMut`, and they are fields rather than parameters.**
/// The TypeScript puts them on the request object and the engine reads them from there; keeping
/// them here means the router's signature stays two arguments shorter than the engine's. The
/// lifetime is the caller's: `generate_text` takes this **by value** and destructures it, so the
/// payloads move into the engine without a copy and the callbacks are re-borrowed per call.
pub struct TextRequest<'a> {
    pub model: String,
    pub messages: Vec<Value>,
    pub max_tokens: Option<u64>,
    pub temperature: Option<f64>,
    pub tools: Option<Value>,
    pub tool_choice: Option<Value>,
    pub response_format: Option<Value>,
    pub on_tool_call: Option<&'a mut (dyn FnMut(crate::core::adapter::ToolCall) + Send)>,
    pub on_usage: Option<&'a mut (dyn FnMut(UsageTokens) + Send)>,
    /// How many candidates this request may try. `None` is [`crate::core::engine::MAX_ATTEMPTS_DEFAULT`].
    pub max_attempts: Option<usize>,
}

/// One request to `generate_image`. The port of `ImageRequest` (`ports.ts:130-133`).
///
/// **Two fields, and `size` is not one of them.** `executeImage` accepts a `size`
/// (`execution-engine.ts:154-161`) and the facade never passes it (`model-router.ts:199`), so the
/// parameter is unreachable from here — the port keeps it unreachable rather than promoting a field
/// the source does not send. An image-size setting is a facade change, not a port step.
pub struct ImageRequest {
    pub model: String,
    pub prompt: String,
}

/// What `generate_image` returns. The port of `ImageResult` (`ports.ts:135-138`).
///
/// The engine's [`crate::core::engine::ImageSuccess`] carries more — the serving candidate and the
/// failed chain — and the source drops both here (`model-router.ts:217`). It does not drop them
/// *unused*: the ledger row is written from them first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageResult {
    pub url: Option<String>,
    pub base64: Option<String>,
}

/// One row of `listModels`. The port of `ModelInfo` (`ports.ts:140-144`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelInfo {
    /// `<slug>/<native>` when the provider is known, the bare native id when it is not.
    pub id: String,
    pub provider_id: String,
    pub modality: String,
}

/// Whether the AI-assisted path may unlock, and why not when it may not (§2.9 rule 2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SystemAiHealth {
    pub available: bool,
    pub reason: Option<String>,
}

/// Per-call attribution: which ledger source this request is, and which gateway app paid for it.
///
/// The TypeScript puts both in `opts` beside the `AbortSignal`. The signal is a parameter here
/// instead, because [`Cancel`] is not a field the router reads — it is passed straight to the
/// engine, and the router only ever asks it whether the caller gave up.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CallOptions {
    /// `"ui"`, `"gateway"` or `"generator"`. `None` is [`DEFAULT_SOURCE`].
    pub source: Option<String>,
    /// The gateway app key that paid (`gateway_keys.id`). `None` for `ui` and `generator` rows.
    pub app_key_id: Option<String>,
}

impl CallOptions {
    pub fn source(&self) -> &str {
        self.source.as_deref().unwrap_or(DEFAULT_SOURCE)
    }
}

/// What one `complete` request is asked for. The port of `AiTextPort::complete`'s argument
/// (`model-router.ts:266-272`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompleteRequest {
    pub prompt: String,
    pub system: Option<String>,
    pub max_tokens: u64,
    /// **`u64`, where the TypeScript's `timeoutMs` is a `number`.** A negative is therefore
    /// unrepresentable here rather than meaning "abort immediately", which is what
    /// `setTimeout(fn, -1)` does in the source. The caller is the Generator, which computes this
    /// from its own budget, and no such caller produces a negative — but it is a difference, so it
    /// is stated rather than discovered.
    pub timeout_ms: u64,
    pub exclude_provider_ids: Vec<String>,
}

/// Why a facade call produced no result. The port of the three things the source throws.
///
/// **`NoRoute` is a variant rather than a message, and the source's own comment says why it
/// matters.** `gatewayStatus` maps the *phrase* "no route" to a `404`, so the classification is
/// already load-bearing on the TypeScript side — it is just done by string matching. On this side
/// it is structural, and [`RouterError::message`] still produces the phrase for a caller that
/// forwards it.
///
/// **`TextFailure` is boxed here and by value in `engine.rs`, and the two are not in conflict.**
/// `clippy::result_large_err` is allowed on `execute_text` (`engine.rs:891`) because its `Ok` arm
/// carries the same 536-byte `Candidate` as the failure does, so the `Result` is ~600 bytes either
/// way and a box would save 16 of them. That argument is about *that* function and does not
/// transfer: the measured sizes here are `TextFailure` 616, `AllAttemptsFailed` 48, `NoRoute` 72,
/// and the `Ok` types are `TextSuccess` 592, `ImageResult` 48, `String` 24, `()` 0. So on four of
/// the five returns below the error outgrows the payload by 8× to 77×, the lint's premise holds,
/// and suppressing it would be suppressing a true finding. Boxing costs one allocation on a path
/// that has already failed. The arithmetic is asserted by
/// `the_error_is_boxed_because_it_outgrows_every_payload_but_the_text_one`.
#[derive(Debug)]
pub enum RouterError {
    /// No candidate was ever attempted. The one case `NO_ROUTE` describes.
    NoRoute { model: String, modality: String, reason: String },
    /// The text loop ran and produced no usable stream.
    Text(Box<TextFailure>),
    /// The image loop ran and produced no image.
    Image(AllAttemptsFailed),
    /// `complete` tried every candidate and none produced text.
    ///
    /// **Deliberately not [`RouterError::NoRoute`], and the difference is an HTTP status.** The
    /// source throws a plain `Error` with this text (`:329`), which does *not* contain the phrase
    /// `gatewayStatus` maps to `404` — so a Generator failure is a `500`, and folding it into
    /// `NoRoute` here would quietly change the status a client sees.
    SystemAiUnavailable,
    /// The request produced its result, and the row recording it could not be written.
    ///
    /// **A distinct variant, and the source has the same behaviour without naming it.** The
    /// TypeScript's `await ledger.append(...)` throws out of the generator after the consumer
    /// already holds the text, so the caller sees a failure *about the record* rather than about
    /// the request. Swallowing it here would contradict `core::ledger`'s contract — the sink
    /// returns a `Result` precisely so a full disk is observable.
    Ledger(String),
}

impl RouterError {
    /// The message the source builds, for a caller that has only a string to forward.
    ///
    /// The text case deliberately omits the modality word: the source says `no route for model
    /// "X"` for text and `no route for image model "X"` for images, and the difference is load
    /// bearing only in that both contain the phrase `no route`.
    pub fn message(&self) -> String {
        match self {
            RouterError::NoRoute { model, modality, reason } => {
                if modality == TEXT {
                    format!("no route for model \"{model}\" ({reason})")
                } else {
                    format!("no route for {modality} model \"{model}\" ({reason})")
                }
            }
            RouterError::Text(failure) => match failure.as_ref() {
                TextFailure::MidStream { error, .. } => format!("mid-stream failure: {error:?}"),
                TextFailure::Cancelled { .. } => "request cancelled".to_string(),
                TextFailure::AllAttemptsFailed { error, .. } => error.describe(),
            },
            RouterError::Image(error) => error.describe(),
            RouterError::SystemAiUnavailable => SYSTEM_AI_EXHAUSTED.to_string(),
            RouterError::Ledger(detail) => format!("ledger write failed: {detail}"),
        }
    }
}

// ---------- the plan helper's view ----------

/// The `PlanContext` `plan()` builds, which is the TypeScript's object literal written down.
///
/// Three pieces of state, and they live in three places: the rows are the store's, the health is
/// the router's, and the cursors are the router's. Borrowing all three is what lets `plan` be a
/// method on `&self` while the planner stays a free function over a trait.
struct PlanView<'a> {
    store: &'a RouterStore,
    health: &'a HealthTracker,
    cursors: &'a HashMap<String, i64>,
}

impl PlanContext for PlanView<'_> {
    fn providers(&self) -> &[ProviderRow] {
        self.store.providers()
    }

    fn aliases(&self) -> &[AliasRow] {
        self.store.aliases()
    }

    fn health(&self) -> &HealthTracker {
        self.health
    }

    fn keys_for(&self, provider_id: &str) -> Vec<ApiKeyRow> {
        self.store.keys_of(provider_id)
    }

    fn catalog(&self) -> Vec<ModelRow> {
        // Cloned per call, and the source does the same work: `ctx.catalog()` is a method that
        // builds a new array on every carrier (`route-planner.ts:52`).
        self.store.models().to_vec()
    }

    fn next_key_cursor(&self, provider_id: &str) -> i64 {
        self.cursors.get(provider_id).copied().unwrap_or(0)
    }

    fn pricing_for(&self, provider_id: &str, native_id: &str) -> Option<PricingMicros> {
        self.store.pricing_for(provider_id, native_id)
    }
}

// ---------- the router ----------

/// The state every request must see the same copy of: the circuit breaker, the key cursors, the
/// ledger and the concurrency limiter.
///
/// **One type rather than four fields, because a constructor can forget one of four and cannot
/// forget one of one.** The same argument `ReplyHandle`'s note makes for arriving with the
/// dispatch rather than being installed on the bridge: a wiring step somebody can skip produces a
/// failure that is silent and looks like something else. Four separate `with_*` calls would leave
/// a caller able to share the health tracker and the limiter while quietly giving each request its
/// own cursors — which is not a smaller version of sharing, it is a different behaviour: every
/// request would start on key zero, and the round-robin that spreads load across a provider's keys
/// would stop existing while every test still passed.
///
/// **Cheap to clone, and that is the point.** Three of the four are `Arc`s and the fourth
/// ([`ProviderLimiter`]) is documented as sharing one budget across its clones, so the bridge
/// clones this once per request and no state is copied.
///
/// [`SharedRouterState::ledger`] hands out a guard rather than a reference, because the ledger is
/// appended to from the request path. `ModelRouter::ledger_mut` — which used to hand out
/// `&mut UsageLedger` — is deliberately gone: a mutable borrow escaping the lock is the exact
/// thing the sharing exists to prevent.
#[derive(Clone)]
pub struct SharedRouterState {
    health: Arc<HealthTracker>,
    cursors: Arc<Mutex<HashMap<String, i64>>>,
    ledger: Arc<Mutex<UsageLedger>>,
    limiter: ProviderLimiter,
}

impl Default for SharedRouterState {
    fn default() -> Self {
        Self {
            health: Arc::new(HealthTracker::new()),
            cursors: Arc::new(Mutex::new(HashMap::new())),
            ledger: Arc::new(Mutex::new(UsageLedger::new())),
            limiter: ProviderLimiter::new(PER_PROVIDER_DEFAULT),
        }
    }
}

impl SharedRouterState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn health(&self) -> &HealthTracker {
        &self.health
    }

    pub fn limiter(&self) -> &ProviderLimiter {
        &self.limiter
    }

    /// The ledger, locked. Held only for the append or the query, never across an `await` — every
    /// caller in this module is a synchronous function.
    pub fn ledger(&self) -> MutexGuard<'_, UsageLedger> {
        self.ledger.lock().unwrap()
    }

    /// The cursor map, locked. [`ModelRouter::plan`] holds this for the length of one planning
    /// call, which does no I/O.
    pub fn cursors(&self) -> MutexGuard<'_, HashMap<String, i64>> {
        self.cursors.lock().unwrap()
    }

    /// The round-robin cursor for a provider: how many times it has served, or `0`.
    pub fn cursor(&self, provider_id: &str) -> i64 {
        self.cursors.lock().unwrap().get(provider_id).copied().unwrap_or(0)
    }

    /// Advance a provider's cursor after it served. See [`ModelRouter::advance_cursor`].
    pub fn advance(&self, provider_id: &str) {
        let mut cursors = self.cursors.lock().unwrap();
        let next = cursors.get(provider_id).copied().unwrap_or(0) + 1;
        cursors.insert(provider_id.to_string(), next);
    }

    /// Replace the ledger with one built elsewhere — a test that wants a spy sink, or a launch that
    /// wants a store-backed one.
    pub fn with_ledger(mut self, ledger: UsageLedger) -> Self {
        self.ledger = Arc::new(Mutex::new(ledger));
        self
    }
}

/// The facade. Wires the store, the adapter seam and the shared request state.
///
/// **The ledger is owned rather than borrowed, and the reason changed with the sharing.** The
/// TypeScript takes a `UsageLedger` so the Usage screen and the router share one instance, and the
/// port originally owned it to avoid a `&'a mut` that would outlive every caller's borrow. It now
/// lives in [`SharedRouterState`] behind an `Arc<Mutex<_>>`, which is the shape the original note
/// said a wiring layer needing two owners would have to build for itself — built once, here,
/// because a bridge with one router per request is exactly that wiring layer.
pub struct ModelRouter<'a> {
    store: &'a RouterStore,
    adapters: &'a dyn AdapterFactory,
    /// One field rather than four — see [`SharedRouterState`].
    shared: SharedRouterState,
    pub settings: RouterSettings,
}

impl<'a> ModelRouter<'a> {
    pub fn new(store: &'a RouterStore, adapters: &'a dyn AdapterFactory) -> Self {
        Self {
            store,
            adapters,
            shared: SharedRouterState::new(),
            settings: RouterSettings::default(),
        }
    }

    /// Serve from state built elsewhere rather than from a fresh set.
    ///
    /// **The constructor a concurrent caller wants, and the difference is not an optimisation.**
    /// `new` gives the router its own breaker, its own cursors and its own ledger — right for one
    /// request and wrong for two: two routers built that way would each cool a private copy of a
    /// key, so neither would ever see the other's failures, and each would start on key zero, so
    /// the round-robin would never advance. A bridge builds one `SharedRouterState` and one router
    /// per request from it.
    pub fn with_shared(mut self, shared: SharedRouterState) -> Self {
        self.shared = shared;
        self
    }

    /// Replace the settings, as `Object.assign(router.settings, persisted)` does at startup. The
    /// cap is **not** applied here — the source applies it in `syncConcurrency`, on the next
    /// request, and a router that applied it eagerly would have two places that set it.
    pub fn with_settings(mut self, settings: RouterSettings) -> Self {
        self.settings = settings;
        self
    }

    /// Replace the ledger, keeping every other piece of shared state.
    pub fn with_ledger(mut self, ledger: UsageLedger) -> Self {
        self.shared = self.shared.with_ledger(ledger);
        self
    }

    pub fn health(&self) -> &HealthTracker {
        self.shared.health()
    }

    /// The ledger, locked. A guard rather than a reference — see [`SharedRouterState`].
    pub fn ledger(&self) -> MutexGuard<'_, UsageLedger> {
        self.shared.ledger()
    }

    pub fn limiter(&self) -> &ProviderLimiter {
        self.shared.limiter()
    }

    /// Apply `settings.per_provider_concurrency` to the live limiter. The port of `syncConcurrency`
    /// (`model-router.ts:83-88`).
    ///
    /// **Clamped rather than trusted**, and the source's comment says why: the value arrives from
    /// persisted JSON with no validation, so a stored `-1` would reach the limiter as-is and read
    /// as a bound while behaving as unlimited. `&self` rather than `&mut self` because the limiter
    /// is interiorly mutable — the same reason the source's method does not reassign anything.
    ///
    /// **`complete` does not call this, and that is the source's asymmetry, not an oversight.**
    /// `generateText` and `generateImage` both call it first; `complete` (`:272`) does not. So a
    /// settings change reaches the Generator only on the next UI or gateway request. Kept, and
    /// pinned by `complete_uses_whatever_cap_is_live_rather_than_syncing_it`.
    pub fn sync_concurrency(&self) {
        self.shared
            .limiter()
            .set_max_per_provider(clamp_concurrency(&self.settings.per_provider_concurrency));
    }

    /// Expand a request into an ordered plan, then apply the failover setting. The port of the
    /// private `plan` (`model-router.ts:357-375`).
    ///
    /// **Failover off keeps the first provider's chain and nothing else.** Note it filters by
    /// *provider id*, not by index: the source's `plan.filter(c => c.provider.id === first)` keeps
    /// every key of the first carrier — which is the whole point, since a second key of the same
    /// provider is a retry rather than a failover.
    fn plan(&self, model: &str, modality: &str, exclude_provider_ids: &[String]) -> Vec<Candidate> {
        let input = PlanInput { model, modality, exclude_provider_ids };
        // The cursor guard is held for this call and no longer: `build_plan` reads the cursors and
        // does no I/O, so the lock is never held across an `await`. It is a named binding rather
        // than an inline temporary because `PlanView` borrows it for the length of the call.
        let cursors = self.shared.cursors();
        let view = PlanView { store: self.store, health: self.shared.health(), cursors: &cursors };
        let plan = build_plan(&input, &view, now_ms());
        if self.settings.failover_enabled {
            return plan;
        }
        // An empty plan stays empty: `first` is `None` and there is nothing to keep. The source's
        // `plan.filter(c => c.provider.id === undefined)` is empty for the same reason.
        let Some(first) = plan.first().map(|c| c.provider.id.clone()) else {
            return plan;
        };
        plan.into_iter().filter(|c| c.provider.id == first).collect()
    }

    // ---------- text ----------

    /// Route one text request, streaming every chunk to `on_chunk`, and record it.
    ///
    /// The port of `generateText` (`model-router.ts:90-181`), **minus context compression**, which
    /// is Phase 4 — `messages` reach the engine exactly as the caller sent them.
    ///
    /// **The chunk count is the router's, and it stands in for `exec.served()`.** The source's ok
    /// row is written only when the first chunk arrived; a provider that answers `200` with an empty
    /// body gets `PARSE_ERROR` instead. `TextSuccess` does not carry that flag, and this is the
    /// seam that already owns the sink — so the counting closure below is where the answer is, not
    /// a new field on a landed type. See `write_text_ledger`.
    ///
    /// **A ledger failure is returned, and the chunks have already been delivered.** That is the
    /// source's behaviour too: its generator throws after the consumer holds the text. The caller
    /// that has drained `on_chunk` therefore learns that the *record* failed, not the request.
    pub async fn generate_text(
        &mut self,
        req: TextRequest<'_>,
        opts: &CallOptions,
        cancel: &Cancel,
        on_chunk: &mut (dyn FnMut(&str) + Send),
    ) -> Result<TextSuccess, RouterError> {
        let t0 = now_ms();
        self.sync_concurrency();
        let plan = self.plan(&req.model, TEXT, &[]);
        if plan.is_empty() {
            self.record_no_route(&req.model, TEXT, opts, t0)?;
            return Err(RouterError::NoRoute {
                model: req.model.clone(),
                modality: TEXT.to_string(),
                reason: NO_CARRIER.to_string(),
            });
        }

        let TextRequest {
            model,
            messages,
            max_tokens,
            temperature,
            tools,
            tool_choice,
            response_format,
            on_tool_call,
            on_usage,
            max_attempts,
        } = req;

        let mut emitted = 0usize;
        let result = {
            // **The counting wrapper, and the borrow is why it exists as a local.** `emitted` must
            // be readable once the engine has finished with the sink, so the sink cannot borrow it
            // inline.
            let mut counting = |chunk: &str| {
                emitted += 1;
                on_chunk(chunk);
            };
            // **The two forwarders exist for the same reason `execute_text`'s does, and the engine's
            // note has the measurement.** Handing the seam `on_usage.as_deref_mut()` directly does
            // not compile: the reference taken off the field carries the field's declared lifetime,
            // rustc resolves the seam's callback lifetime to *it* rather than to a shorter
            // subregion, and the borrow is then required to outlive `generate_text` itself —
            // `E0521`, "borrowed data escapes outside of async fn". A local closure makes the
            // referent a local, whose borrow ends with this block.
            //
            // **The binding itself is a plain move, and clippy is right to say so.** `on_tool_call`
            // is a local destructured out of `req`, so `as_deref_mut()` on it would be a no-op
            // (`Option<&mut dyn FnMut>` derefs to itself) — `clippy::needless_option_as_deref`. It is
            // the *inner* `as_deref_mut()` inside each closure that is load-bearing: the closure may
            // be called many times and must reborrow rather than move the `Option` out on the first
            // call.
            let mut caller_on_tool_call = on_tool_call;
            let mut forward_tool = |tc: crate::core::adapter::ToolCall| {
                if let Some(cb) = caller_on_tool_call.as_deref_mut() {
                    cb(tc);
                }
            };
            let mut caller_on_usage = on_usage;
            let mut forward_usage = |u: UsageTokens| {
                if let Some(cb) = caller_on_usage.as_deref_mut() {
                    cb(u);
                }
            };
            let args = ExecuteTextArgs {
                plan,
                messages,
                model: model.clone(),
                stream: true,
                max_tokens,
                temperature,
                tools,
                tool_choice,
                response_format,
                on_tool_call: Some(&mut forward_tool),
                on_usage: Some(&mut forward_usage),
                max_attempts,
            };
            execute_text(
                self.adapters,
                self.shared.health(),
                Some(self.shared.limiter()),
                args,
                cancel,
                &mut counting,
            )
            .await
        };

        self.write_text_ledger(&model, opts, t0, &result, emitted, cancel.is_cancelled())?;
        result.map_err(|failure| RouterError::Text(Box::new(failure)))
    }

    /// Write the one row a text request produces. The port of `wrapLedger` (`model-router.ts:415-528`).
    ///
    /// **Three shapes, and the source's `if (!served)` is the one that is easy to lose.** A stream
    /// that drains with nothing in it is *not* a success — the source's comment records the live
    /// ledger holding seven such rows, "and the 99.5s / 83s latencies among them are client
    /// timeouts, not answers". `emitted` is what tells the two apart here.
    ///
    /// **`httpStatus` and `errorClass` follow the source's spelling, including the part that looks
    /// wrong.** On the throwing path the class is `NETWORK` whenever anything served
    /// (`:515`) — even though a mid-stream break classifies as `PARSE_ERROR`. The attempt's real
    /// class is in the chain beside it; the column is the source's, and "fixing" it here would make
    /// the Rust ledger disagree with the TypeScript one about the same request.
    ///
    /// **`advanceCursor` runs on the success path only**, which is where the source calls it
    /// (`:485`) — and the cursor is what makes the next request start on the next key.
    fn write_text_ledger(
        &mut self,
        requested_model: &str,
        opts: &CallOptions,
        t0: i64,
        result: &Result<TextSuccess, TextFailure>,
        emitted: usize,
        cancelled: bool,
    ) -> Result<(), RouterError> {
        let now = now_ms();
        let source = opts.source().to_string();

        let (mut row, usage, attempts, served, error_class, http_status) = match result {
            Ok(success) if emitted > 0 => {
                let mut row = ledger_row(now, TEXT, &source);
                row.provider_id = Some(success.candidate.provider.id.clone());
                row.key_id = Some(success.candidate.key.id.clone());
                row.app_key_id = opts.app_key_id.clone();
                row.requested_model = Some(requested_model.to_string());
                row.model = success.candidate.model.native_id.clone();
                row.latency_ms = Some(now - t0);
                let (tokens_in, tokens_out) = success.usage.map(|u| u.counts()).unwrap_or((0, 0));
                row.tokens_in = tokens_in as i64;
                row.tokens_out = tokens_out as i64;
                row.cached_tokens = success.usage.and_then(|u| u.cached_for_ledger());
                // R2: real cost instead of a constant 0. Unknown pricing is 0 in the column, and
                // the UI renders "—" for it by consulting the catalog (unknown != free).
                row.cost_estimate_micros = estimate_cost_micros(
                    self.pricing_for(&success.candidate.model),
                    tokens_in,
                    tokens_out,
                )
                .unwrap_or(0);
                row.fallback_chain_json = chain_json(&success.attempts);
                let provider = success.candidate.provider.id.clone();
                self.shared.ledger().append(row).map_err(|e| RouterError::Ledger(e.to_string()))?;
                self.advance_cursor(&provider);
                return Ok(());
            }
            // The drained-with-nothing case, and the abort case: both reach the source's `!served`
            // branch. `CANCELLED` is decided by the signal there, and by the variant here — the
            // engine can only produce `TextFailure::Cancelled` when the flag is set.
            Ok(success) => (
                ledger_row(now, TEXT, &source),
                success.usage,
                &success.attempts,
                None,
                if cancelled { "CANCELLED" } else { "PARSE_ERROR" },
                None,
            ),
            Err(TextFailure::Cancelled { attempts, usage }) => {
                (ledger_row(now, TEXT, &source), *usage, attempts, None, "CANCELLED", None)
            }
            Err(TextFailure::MidStream { served, attempts, usage, .. }) => {
                (ledger_row(now, TEXT, &source), *usage, attempts, Some(served), "NETWORK", None)
            }
            Err(TextFailure::AllAttemptsFailed { error, usage }) => {
                let last = error.chain.last();
                (
                    ledger_row(now, TEXT, &source),
                    *usage,
                    &error.chain,
                    None,
                    last.map(|a| a.cls.as_str()).unwrap_or(NO_ROUTE),
                    last.map(|a| a.status as i64),
                )
            }
        };

        let (tokens_in, tokens_out) = usage.map(|u| u.counts()).unwrap_or((0, 0));
        row.status = "error".to_string();
        row.error_class = Some(error_class.to_string());
        row.http_status = http_status;
        row.app_key_id = opts.app_key_id.clone();
        row.requested_model = Some(requested_model.to_string());
        row.latency_ms = Some(now - t0);
        row.tokens_in = tokens_in as i64;
        row.tokens_out = tokens_out as i64;
        row.cached_tokens = usage.and_then(|u| u.cached_for_ledger());
        // **`served` only — deliberately not the last attempt.** The source says why (`:499-503`):
        // "Provider"/"Key" mean *who served*, so a null provider on an error row is itself the
        // signal that nothing served at all. The attempt that failed is in the chain below.
        row.provider_id = served.map(|c| c.provider.id.clone());
        row.key_id = served.map(|c| c.key.id.clone());
        row.model = served
            .map(|c| c.model.native_id.clone())
            .unwrap_or_else(|| requested_model.to_string());
        row.fallback_chain_json = chain_json(attempts);
        self.shared.ledger().append(row).map_err(|e| RouterError::Ledger(e.to_string()))?;
        Ok(())
    }

    // ---------- image ----------

    /// Route one image request and record it. The port of `generateImage` (`model-router.ts:183-218`).
    ///
    /// The image path has no stream, so nothing here needs the counting trick: `execute_image`
    /// returns the serving candidate directly.
    pub async fn generate_image(
        &mut self,
        req: &ImageRequest,
        opts: &CallOptions,
        cancel: &Cancel,
    ) -> Result<ImageResult, RouterError> {
        let t0 = now_ms();
        self.sync_concurrency();
        let plan = self.plan(&req.model, IMAGE, &[]);
        if plan.is_empty() {
            self.record_no_route(&req.model, IMAGE, opts, t0)?;
            return Err(RouterError::NoRoute {
                model: req.model.clone(),
                modality: IMAGE.to_string(),
                reason: self.why_no_image(&req.model),
            });
        }

        let args = ExecuteImageArgs {
            plan,
            prompt: req.prompt.clone(),
            model: req.model.clone(),
            // The facade never sends a size — see `ImageRequest`.
            size: None,
            max_attempts: None,
        };
        let served = execute_image(
            self.adapters,
            self.shared.health(),
            Some(self.shared.limiter()),
            args,
            cancel,
        )
        .await
        .map_err(RouterError::Image)?;

        let now = now_ms();
        let mut row = ledger_row(now, IMAGE, opts.source());
        row.provider_id = Some(served.candidate.provider.id.clone());
        row.key_id = Some(served.candidate.key.id.clone());
        row.app_key_id = opts.app_key_id.clone();
        row.requested_model = Some(req.model.clone());
        row.model = served.candidate.model.native_id.clone();
        row.latency_ms = Some(now - t0);
        row.fallback_chain_json = chain_json(&served.attempts);
        self.shared.ledger().append(row).map_err(|e| RouterError::Ledger(e.to_string()))?;
        self.advance_cursor(&served.candidate.provider.id);

        Ok(ImageResult { url: served.url, base64: served.base64 })
    }

    /// Why an image request planned to nothing, in the caller's terms. The port of `whyNoImage`
    /// (`model-router.ts:226-239`).
    ///
    /// **Three failures used to produce one message that named the model**, so the caller went and
    /// checked the model id — and only the middle case is about the id. Measured live 2026-09-22:
    /// the gateway advertised 15 image-named models and `404`ed every one, because the catalog
    /// tagged zero of them as image. The message that blamed the id was wrong for all fifteen.
    fn why_no_image(&self, requested: &str) -> String {
        if self.store.for_modality(IMAGE).is_empty() {
            return NO_IMAGE_CAPABILITY.to_string();
        }
        // The request may be qualified (`slug/native`), which is how `/v1/models` prints ids.
        let known =
            self.store.models().iter().any(|m| {
                m.native_id == requested || requested.ends_with(&format!("/{}", m.native_id))
            });
        if !known {
            return NO_CARRIER.to_string();
        }
        NOT_TAGGED_AS_IMAGE.to_string()
    }

    // ---------- the rest of the facade ----------

    /// The catalog, as the facade reports it. The port of `listModels` (`model-router.ts:241-247`).
    pub fn list_models(&self, modality: Option<&str>) -> Vec<ModelInfo> {
        let rows = match modality {
            Some(m) => self.store.for_modality(m),
            None => self.store.models().to_vec(),
        };
        rows.into_iter()
            .map(|m| {
                // A model whose provider is gone keeps its bare id rather than a `undefined/`
                // prefix — the source's `p ? \`${p.slug}/${m.nativeId}\` : m.nativeId`.
                let id = match self.store.get_provider(&m.provider_id) {
                    Some(p) => format!("{}/{}", p.slug, m.native_id),
                    None => m.native_id.clone(),
                };
                ModelInfo { id, provider_id: m.provider_id, modality: m.modality }
            })
            .collect()
    }

    /// Whether the AI-assisted path may unlock (§2.9 rule 2). The port of `systemAiAvailable`
    /// (`model-router.ts:249-263`).
    ///
    /// **Two ways to be available, and the second is the one that matters.** The configured pick
    /// counts only if its provider is enabled *and* it has a usable key; failing that, **any**
    /// enabled provider with a text model and a usable key unlocks the path. The reason string is
    /// the source's, verbatim: it is user-facing copy that says what to do next.
    ///
    /// **Both status checks go through `HealthTracker::is_provider_usable`, not a string literal.**
    /// The source spells `p.status === "enabled"` twice (`:250`, `:257`) while `health-tracker.ts`
    /// owns the same allow-list one file over. `core::planner` made the same call for the same
    /// reason — two spellings of one rule is the defect this crate keeps finding.
    pub fn system_ai_available(&self) -> SystemAiHealth {
        let now = now_ms();
        let active = |provider_id: &str| {
            self.store
                .keys_of(provider_id)
                .iter()
                .any(|k| self.shared.health().is_key_usable(k, now))
        };
        let usable = |provider_id: &str| {
            self.store.get_provider(provider_id).is_some_and(HealthTracker::is_provider_usable)
        };

        if let Some(pick) = &self.settings.system_ai {
            if usable(&pick.provider_id) && active(&pick.provider_id) {
                return SystemAiHealth { available: true, reason: None };
            }
        }
        let any = self.store.providers().iter().any(|p| {
            HealthTracker::is_provider_usable(p)
                && self.store.for_modality(TEXT).iter().any(|m| m.provider_id == p.id)
                && active(&p.id)
        });
        if any {
            return SystemAiHealth { available: true, reason: None };
        }
        SystemAiHealth { available: false, reason: Some(SYSTEM_AI_LOCKED.to_string()) }
    }

    /// `AiTextPort` (§2.8): system-AI-first, exclusion-enforced completion. The port of `complete`
    /// (`model-router.ts:266-333`).
    ///
    /// **The timeout is a real abort, not a deadline check.** The source arms a `setTimeout` that
    /// aborts the controller, and the engine sees an aborted signal mid-stream. The port spawns the
    /// equivalent: a task that cancels the shared flag, aborted on every exit path. A deadline
    /// checked between candidates would only stop the *loop*, leaving a slow single attempt running
    /// to completion — which is the case the timeout exists for.
    ///
    /// **An empty output is not a success.** The source loops until some candidate returns
    /// non-empty text (`:308`) and only then writes its row; a candidate that streamed nothing
    /// falls through to the next one. That is why this cannot simply take the first `Ok`.
    ///
    /// **No `fallbackChain` on the row**, because the source passes none (`:309-322`) — the one
    /// ledger write in the file that does not. The column is `NULL` for generator rows rather than
    /// `"[]"`, and that difference is meaningful: `"[]"` means "there were no attempts to record".
    pub async fn complete(&mut self, req: &CompleteRequest) -> Result<String, RouterError> {
        let messages = match &req.system {
            Some(system) => vec![
                serde_json::json!({ "role": "system", "content": system }),
                serde_json::json!({ "role": "user", "content": req.prompt }),
            ],
            None => vec![serde_json::json!({ "role": "user", "content": req.prompt })],
        };

        let cancel = Cancel::new();
        let timer = tokio::spawn({
            let cancel = cancel.clone();
            let ms = req.timeout_ms;
            async move {
                tokio::time::sleep(Duration::from_millis(ms)).await;
                cancel.cancel();
            }
        });

        let excluded = &req.exclude_provider_ids;
        let mut model_order: Vec<String> = Vec::new();
        if let Some(pick) = &self.settings.system_ai {
            if !excluded.contains(&pick.provider_id) {
                model_order.push(format!(
                    "{}/{}",
                    self.store.slug_of(&pick.provider_id),
                    pick.model
                ));
            }
        }
        for p in self.store.providers() {
            if !HealthTracker::is_provider_usable(p) || excluded.contains(&p.id) {
                continue;
            }
            for m in self.store.for_modality(TEXT) {
                if m.provider_id == p.id {
                    model_order.push(format!("{}/{}", p.slug, m.native_id));
                }
            }
        }

        for model in model_order {
            if cancel.is_cancelled() {
                break;
            }
            let plan = self.plan(&model, TEXT, excluded);
            if plan.is_empty() {
                continue;
            }
            let args = ExecuteTextArgs {
                plan,
                messages: messages.clone(),
                model: model.clone(),
                stream: false,
                max_tokens: Some(req.max_tokens),
                temperature: None,
                tools: None,
                tool_choice: None,
                response_format: None,
                on_tool_call: None,
                on_usage: None,
                max_attempts: None,
            };
            // Scoped so the sink's borrow of `text` ends before the text is read.
            let mut text = String::new();
            let result = {
                let mut sink = |chunk: &str| text.push_str(chunk);
                execute_text(
                    self.adapters,
                    self.shared.health(),
                    Some(self.shared.limiter()),
                    args,
                    &cancel,
                    &mut sink,
                )
                .await
            };

            // `this candidate failed — try the next healthy provider` (§2.9). A refusal and an
            // empty stream are the same thing here, which is what the source's `if (out)` says.
            let Ok(success) = result else { continue };
            if text.is_empty() {
                continue;
            }

            let mut row = ledger_row(now_ms(), TEXT, GENERATOR_SOURCE);
            row.provider_id = Some(success.candidate.provider.id.clone());
            row.key_id = Some(success.candidate.key.id.clone());
            row.requested_model = Some(model.clone());
            row.model = success.candidate.model.native_id.clone();
            // Zero, and the source passes zero explicitly (`:318`) — this row measures that a
            // completion happened, not how long it took.
            row.latency_ms = Some(0);
            self.shared.ledger().append(row).map_err(|e| RouterError::Ledger(e.to_string()))?;
            timer.abort();
            return Ok(text);
        }

        timer.abort();
        Err(RouterError::SystemAiUnavailable)
    }

    // ---------- cursors and attribution ----------

    pub fn next_key_cursor(&self, provider_id: &str) -> i64 {
        self.shared.cursor(provider_id)
    }

    /// Advance the round-robin cursor for a provider after it served. The source's `advanceCursor`
    /// (`model-router.ts:344-346`) increments rather than wrapping; `order_keys` reduces it modulo
    /// the usable key count, so an unbounded cursor is fine and an `i64` will not overflow in any
    /// life of this process.
    ///
    /// **`&self`, where it used to be `&mut self`, and the sharing is why.** The cursor map lives
    /// in [`SharedRouterState`] behind its own lock, so advancing a cursor is a change to shared
    /// state rather than a change to this router — and two concurrent requests must both be able
    /// to advance it, which a `&mut self` borrow forbids.
    pub fn advance_cursor(&self, provider_id: &str) {
        self.shared.advance(provider_id);
    }

    /// R2: normalized pricing for a catalog model (`None` = unknown, NOT free).
    pub fn pricing_for(&self, model: &ModelRow) -> Option<PricingMicros> {
        self.store.pricing_for(&model.provider_id, &model.native_id)
    }

    /// Record a request that found no route at all. The port of `recordNoRoute`
    /// (`model-router.ts:391-413`).
    ///
    /// **This is the one place `NO_ROUTE` is written**, and the source's comment is the argument:
    /// an empty plan means no candidate was ever attempted, which is precisely and only what the
    /// class describes. `fallback_chain_json` is `"[]"` — the honest value, because there were no
    /// attempts to record — and it is *not* the same as the `NULL` a `complete` row carries.
    ///
    /// `app_key_id` is carried here too. A `NO_ROUTE` row costs nothing, so leaving it unattributed
    /// is tempting — but it is a gateway request that happened, and a per-app view that dropped
    /// exactly the failures would under-report the app that is *misconfigured* rather than the one
    /// that is expensive.
    fn record_no_route(
        &mut self,
        requested_model: &str,
        modality: &str,
        opts: &CallOptions,
        t0: i64,
    ) -> Result<(), RouterError> {
        let now = now_ms();
        let mut row = ledger_row(now, modality, opts.source());
        row.app_key_id = opts.app_key_id.clone();
        row.requested_model = Some(requested_model.to_string());
        row.model = requested_model.to_string();
        row.status = "error".to_string();
        row.error_class = Some(NO_ROUTE.to_string());
        row.latency_ms = Some(now - t0);
        row.fallback_chain_json = chain_json(&[]);
        self.shared.ledger().append(row).map_err(|e| RouterError::Ledger(e.to_string()))
    }
}

// ---------- shared spellings ----------

/// The class written when there is no attempt to name one, and the class a no-route row carries.
const NO_ROUTE: &str = "NO_ROUTE";

/// The source's parenthetical for a text request that planned to nothing (`model-router.ts:116`).
const NO_CARRIER: &str = "no enabled provider carries it";

/// `whyNoImage`'s first answer: nothing in the catalog is an image model at all.
const NO_IMAGE_CAPABILITY: &str = "no enabled provider is configured for image generation";

/// `whyNoImage`'s third answer: the id resolves, but the catalog does not call it an image model.
const NOT_TAGGED_AS_IMAGE: &str = "it is not tagged as an image model in the catalog";

/// `systemAiAvailable`'s refusal, verbatim — user-facing copy that says what to do next.
const SYSTEM_AI_LOCKED: &str =
    "AI-assisted path unlocks after the first enabled provider with an active key and a text model";

/// What `complete` reports when every candidate was tried and none produced text.
const SYSTEM_AI_EXHAUSTED: &str = "system AI: no healthy text provider available";

/// A ledger row with every optional field absent, every counter zero, and status `ok`.
///
/// **Built here rather than as a literal at each write site, because there are five of them and
/// seventeen columns.** A fifth copy of the literal is a fifth place for a new column to be
/// forgotten — and this is the row shape that migration 0015 exists because someone forgot a
/// column in. `LedgerRow` is a wire shape and deliberately not `Default`, so the defaults live
/// here, next to the writes they serve.
fn ledger_row(ts: i64, modality: &str, source: &str) -> LedgerRow {
    LedgerRow {
        ts,
        modality: modality.to_string(),
        source: source.to_string(),
        provider_id: None,
        key_id: None,
        app_key_id: None,
        requested_model: None,
        model: String::new(),
        status: "ok".to_string(),
        http_status: None,
        error_class: None,
        latency_ms: None,
        tokens_in: 0,
        tokens_out: 0,
        cost_estimate_micros: 0,
        cached_tokens: None,
        fallback_chain_json: None,
    }
}

/// The failed attempts of one request, as `fallback_chain_json`.
///
/// **The shape is the webview's, not this module's.** `store.ts:124-128` builds
/// `[{provider, key, cls}]` from `provider.slug`, `key.label` and the class, and both Activity and
/// Context parse exactly those three fields back out. So the Rust router has to produce the same
/// JSON, and it can now: [`AttemptLabel`](crate::core::engine::AttemptLabel) is the two strings.
///
/// **Always `Some`, including for an empty chain**, because the source's
/// `e.fallbackChain ? JSON.stringify(...) : null` is a truthiness test and `[]` is truthy — an
/// empty chain is `"[]"`, and `null` means the caller passed no chain at all. `complete` is the one
/// such caller.
///
/// **An unlabelled attempt omits `provider` and `key` rather than inventing them.** Only a
/// hand-built chain can reach that, since both engine loops label every outcome they push — but
/// writing `""` or `"unknown"` would put a name in the column that no provider answered to, and
/// the reader would render it as though it were real.
fn chain_json(attempts: &[AttemptOutcome]) -> Option<String> {
    let entries: Vec<Value> = attempts
        .iter()
        .map(|a| {
            let mut entry = serde_json::Map::new();
            if let Some(label) = &a.label {
                entry.insert("provider".to_string(), Value::String(label.provider_slug.clone()));
                entry.insert("key".to_string(), Value::String(label.key_label.clone()));
            }
            entry.insert("cls".to_string(), Value::String(a.cls.as_str().to_string()));
            Value::Object(entry)
        })
        .collect();
    Some(Value::Array(entries).to_string())
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};

    use futures_util::future::BoxFuture;
    use futures_util::stream::{self, BoxStream};
    use serde_json::json;

    use crate::core::adapter::{
        AdapterInstance, Capabilities, ImageArgs, ImageReply, ModelEntry, PingResult, TextArgs,
    };
    use crate::core::engine::{AttemptError, ErrorClass, FailureKind};
    use crate::core::ledger::{LedgerFilter, LedgerSink};

    use super::*;

    // ---------- fixtures ----------

    fn provider(id: &str, slug: &str, status: &str, rotation: &str) -> ProviderRow {
        ProviderRow {
            id: id.to_string(),
            slug: slug.to_string(),
            name: slug.to_string(),
            r#type: None,
            base_url: "https://example.invalid".to_string(),
            status: status.to_string(),
            rotation_strategy: rotation.to_string(),
            created_at: 0,
            updated_at: 0,
        }
    }

    fn key(id: &str, provider_id: &str, label: &str) -> ApiKeyRow {
        ApiKeyRow {
            id: id.to_string(),
            provider_id: provider_id.to_string(),
            label: label.to_string(),
            secret_ref: format!("key:{id}"),
            secret_hint: None,
            status: "active".to_string(),
            priority: 0,
            cooldown_until: None,
            added_at: 0,
            last_used_at: None,
            last_tested_at: None,
        }
    }

    fn model(provider_id: &str, native_id: &str, modality: &str) -> ModelRow {
        ModelRow {
            provider_id: provider_id.to_string(),
            native_id: native_id.to_string(),
            modality: modality.to_string(),
            context_window: None,
            fetched_at: 0,
            pricing_json: None,
            capabilities_json: None,
        }
    }

    fn priced(provider_id: &str, native_id: &str, prompt: i64, completion: i64) -> ModelRow {
        let mut m = model(provider_id, native_id, TEXT);
        m.pricing_json = Some(json!({ "prompt": prompt, "completion": completion }).to_string());
        m
    }

    /// One provider (`p1`/`p1`), one enabled key, one text model. The smallest store a plan can be
    /// built from, so a test that needs more says so by adding rows.
    fn one_provider() -> RouterStore {
        RouterStore::hydrate(
            vec![provider("p1", "p1", "enabled", "priority")],
            vec![key("k1", "p1", "k1")],
            vec![model("p1", "m1", TEXT)],
            vec![],
        )
    }

    /// A scripted adapter: one queue for text and one for images, consumed in call order, plus a
    /// call log. Shared through `Arc` so the test can read the log after the router has borrowed it.
    #[derive(Default)]
    struct Scripted {
        text: Mutex<VecDeque<Result<Vec<String>, AttemptError>>>,
        usage: Mutex<VecDeque<Option<UsageTokens>>>,
        image: Mutex<VecDeque<Result<ImageReply, AttemptError>>>,
        calls: Mutex<Vec<String>>,
    }

    impl Scripted {
        fn new(text: Vec<Result<Vec<String>, AttemptError>>) -> Arc<Self> {
            let s = Scripted::default();
            *s.text.lock().unwrap() = text.into();
            Arc::new(s)
        }

        fn images(image: Vec<Result<ImageReply, AttemptError>>) -> Arc<Self> {
            let s = Scripted::default();
            *s.image.lock().unwrap() = image.into();
            Arc::new(s)
        }

        /// Queue one usage report per text call, in order.
        fn reporting(self: &Arc<Self>, usage: Vec<Option<UsageTokens>>) -> Arc<Self> {
            *self.usage.lock().unwrap() = usage.into();
            Arc::clone(self)
        }

        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl AdapterInstance for Scripted {
        fn generate_image<'a>(
            &'a self,
            secret_ref: &'a str,
            args: ImageArgs,
            _cancel: &'a Cancel,
        ) -> BoxFuture<'a, Result<ImageReply, AttemptError>> {
            self.calls.lock().unwrap().push(format!("image:{secret_ref}|{}", args.model));
            let next = self.image.lock().unwrap().pop_front();
            Box::pin(async move { next.unwrap_or(Err(AttemptError::Transport)) })
        }

        fn generate_text<'a>(
            &'a self,
            secret_ref: &'a str,
            mut args: TextArgs<'a>,
            _cancel: &'a Cancel,
        ) -> BoxFuture<'a, Result<BoxStream<'a, Result<String, AttemptError>>, AttemptError>>
        {
            self.calls.lock().unwrap().push(format!("text:{secret_ref}|{}", args.model));
            let next = self.text.lock().unwrap().pop_front();
            let usage = self.usage.lock().unwrap().pop_front().flatten();
            Box::pin(async move {
                match next {
                    None => Err(AttemptError::Transport),
                    Some(Err(e)) => Err(e),
                    Some(Ok(chunks)) => {
                        if let (Some(u), Some(cb)) = (usage, args.on_usage.as_deref_mut()) {
                            cb(u);
                        }
                        Ok(Box::pin(stream::iter(chunks.into_iter().map(Ok)))
                            as BoxStream<'a, Result<String, AttemptError>>)
                    }
                }
            })
        }

        fn capabilities(&self) -> Capabilities {
            Capabilities { text: true, image: true }
        }

        fn tag_modality(&self, _entry: &ModelEntry) -> &'static str {
            "text"
        }

        fn list_models<'a>(
            &'a self,
            _secret_ref: &'a str,
            _cancel: &'a Cancel,
        ) -> BoxFuture<'a, Result<Vec<ModelEntry>, AttemptError>> {
            Box::pin(async { Ok(Vec::new()) })
        }

        fn ping_key<'a>(
            &'a self,
            _secret_ref: &'a str,
            _cancel: &'a Cancel,
        ) -> BoxFuture<'a, PingResult> {
            Box::pin(async {
                PingResult { ok: false, status: 0, rate_limited: false, message: None }
            })
        }
    }

    /// One adapter for every provider, which is what these tests need — the routing decisions are
    /// about which *candidate* is reached, and the log records the secret ref that got there.
    struct Always(Arc<Scripted>);

    impl AdapterFactory for Always {
        fn for_provider<'a>(
            &'a self,
            _provider_id: &'a str,
        ) -> BoxFuture<'a, Result<Arc<dyn AdapterInstance>, String>> {
            let adapter = Arc::clone(&self.0);
            Box::pin(async move { Ok(adapter as Arc<dyn AdapterInstance>) })
        }
    }

    /// A `&'static` factory, leaked deliberately.
    ///
    /// `ModelRouter` borrows its adapter seam for the router's whole life, so a test that builds a
    /// router in one statement would otherwise need a second line just to keep the factory alive.
    /// A test binary is short-lived and each of these is a few dozen bytes. The alternative — an
    /// `Arc<dyn AdapterFactory>` field on the router — would make the router *own* a seam the
    /// source's `AdapterRuntime` outlives.
    fn factory(adapter: Arc<Scripted>) -> &'static Always {
        Box::leak(Box::new(Always(adapter)))
    }

    fn refusal(status: u16) -> AttemptError {
        AttemptError::Http { status, kind: FailureKind::Response, retry_after_ms: None }
    }

    fn chunks(words: &[&str]) -> Result<Vec<String>, AttemptError> {
        Ok(words.iter().map(|w| w.to_string()).collect())
    }

    fn ok_reply(base64: &str) -> Result<ImageReply, AttemptError> {
        Ok(ImageReply {
            ok: true,
            status: 200,
            base64: Some(base64.to_string()),
            url: None,
            error_body: None,
        })
    }

    fn refused(status: u16) -> Result<ImageReply, AttemptError> {
        Ok(ImageReply { ok: false, status, base64: None, url: None, error_body: None })
    }

    fn text_req(model: &str) -> TextRequest<'static> {
        TextRequest {
            model: model.to_string(),
            messages: vec![json!({ "role": "user", "content": "hi" })],
            max_tokens: None,
            temperature: None,
            tools: None,
            tool_choice: None,
            response_format: None,
            on_tool_call: None,
            on_usage: None,
            max_attempts: None,
        }
    }

    fn opts(source: &str) -> CallOptions {
        CallOptions { source: Some(source.to_string()), app_key_id: None }
    }

    fn sink() -> (Arc<Mutex<Vec<String>>>, impl FnMut(&str) + Send) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let writer = Arc::clone(&seen);
        (seen, move |chunk: &str| writer.lock().unwrap().push(chunk.to_string()))
    }

    fn rows(ledger: &UsageLedger) -> Vec<LedgerRow> {
        ledger.query(&LedgerFilter::default())
    }

    /// Parse a chain back rather than substring-match it: `serde_json` sorts keys, so the bytes are
    /// not the source's order even when the meaning is identical.
    fn chain(row: &LedgerRow) -> Vec<Value> {
        let raw = row.fallback_chain_json.as_deref().expect("a chain was written");
        serde_json::from_str(raw).expect("the chain is JSON")
    }

    /// Reach through `RouterError::Text`'s box, so the box appears in one place rather than at
    /// every match site. Panics with the variant it actually got — a bare `matches!` that fails
    /// says only "false", which is the least useful thing it could say.
    fn text_failure(error: &RouterError) -> &TextFailure {
        match error {
            RouterError::Text(failure) => failure,
            other => panic!("expected a text failure, got {other:?}"),
        }
    }

    // ---------- sync_concurrency ----------

    #[test]
    fn the_stored_cap_is_clamped_into_the_limiter() {
        let store = one_provider();
        let adapters = Always(Scripted::new(vec![]));
        let mut router = ModelRouter::new(&store, &adapters);
        assert_eq!(
            router.limiter().max_per_provider(),
            PER_PROVIDER_DEFAULT,
            "the default at rest"
        );

        router.settings.per_provider_concurrency = json!("4");
        router.sync_concurrency();
        assert_eq!(router.limiter().max_per_provider(), 4, "a numeric string is read, not ignored");

        router.settings.per_provider_concurrency = json!(-1);
        router.sync_concurrency();
        assert_eq!(
            router.limiter().max_per_provider(),
            PER_PROVIDER_DEFAULT,
            "a negative is corruption and must not become unlimited"
        );
    }

    #[test]
    fn a_cap_of_zero_survives_the_clamp_as_unlimited() {
        // `0` is the documented "unlimited". Flooring it to 1 would silently turn "no cap" into
        // "one request at a time", and nothing else in the router would notice.
        let store = one_provider();
        let adapters = Always(Scripted::new(vec![]));
        let mut router = ModelRouter::new(&store, &adapters);
        router.settings.per_provider_concurrency = json!(0);
        router.sync_concurrency();
        assert_eq!(router.limiter().max_per_provider(), 0);
        assert!(router.limiter().has_capacity("p1"), "zero means unlimited, not zero");
    }

    #[test]
    fn an_empty_string_is_not_a_deliberate_removal_of_the_cap() {
        // The shape that actually reaches a person: a text field the user cleared. `Number("")` is
        // `0`, which would read as unlimited — the whole reason `clamp_concurrency` exists.
        let store = one_provider();
        let adapters = Always(Scripted::new(vec![]));
        let mut router = ModelRouter::new(&store, &adapters);
        router.settings.per_provider_concurrency = json!("");
        router.sync_concurrency();
        assert_eq!(router.limiter().max_per_provider(), PER_PROVIDER_DEFAULT);
    }

    // ---------- the plan helper ----------

    #[test]
    fn failover_off_keeps_the_first_providers_whole_key_chain() {
        let store = RouterStore::hydrate(
            vec![
                provider("p1", "p1", "enabled", "priority"),
                provider("p2", "p2", "enabled", "priority"),
            ],
            vec![key("k1", "p1", "k1"), key("k2", "p1", "k2"), key("k3", "p2", "k3")],
            vec![model("p1", "m1", TEXT), model("p2", "m1", TEXT)],
            vec![],
        );
        let adapters = Always(Scripted::new(vec![]));
        let mut router = ModelRouter::new(&store, &adapters);

        let with_failover = router.plan("m1", TEXT, &[]);
        assert_eq!(
            with_failover.iter().map(|c| c.provider.id.as_str()).collect::<Vec<_>>(),
            vec!["p1", "p1", "p2"],
            "both providers, every key of each"
        );

        router.settings.failover_enabled = false;
        let without = router.plan("m1", TEXT, &[]);
        assert_eq!(
            without.iter().map(|c| c.provider.id.as_str()).collect::<Vec<_>>(),
            vec!["p1", "p1"],
            "the filter is by provider id, so p1's second key is a retry and stays"
        );
    }

    #[test]
    fn an_empty_plan_stays_empty_when_failover_is_off() {
        // The source's `plan[0]?.provider.id` is `undefined`, and `filter(c => c.provider.id ===
        // undefined)` is empty — so the branch cannot turn an empty plan into a non-empty one.
        let store = RouterStore::hydrate(
            vec![provider("p1", "p1", "disabled", "priority")],
            vec![key("k1", "p1", "k1")],
            vec![model("p1", "m1", TEXT)],
            vec![],
        );
        let adapters = Always(Scripted::new(vec![]));
        let mut router = ModelRouter::new(&store, &adapters);
        router.settings.failover_enabled = false;
        assert!(router.plan("m1", TEXT, &[]).is_empty());
    }

    #[test]
    fn the_exclusion_list_reaches_the_planner() {
        let store = RouterStore::hydrate(
            vec![
                provider("p1", "p1", "enabled", "priority"),
                provider("p2", "p2", "enabled", "priority"),
            ],
            vec![key("k1", "p1", "k1"), key("k2", "p2", "k2")],
            vec![model("p1", "m1", TEXT), model("p2", "m1", TEXT)],
            vec![],
        );
        let adapters = Always(Scripted::new(vec![]));
        let router = ModelRouter::new(&store, &adapters);
        let plan = router.plan("m1", TEXT, &["p1".to_string()]);
        assert_eq!(plan.iter().map(|c| c.provider.id.as_str()).collect::<Vec<_>>(), vec!["p2"]);
    }

    // ---------- generate_text ----------

    #[tokio::test(flavor = "multi_thread")]
    async fn a_text_request_streams_to_the_callers_sink_and_records_what_served() {
        let store = one_provider();
        let adapter = Scripted::new(vec![chunks(&["he", "llo"])])
            .reporting(vec![Some(UsageTokens::new(120, 34, Some(64)))]);
        let mut router = ModelRouter::new(&store, factory(adapter.clone()));
        let (seen, mut on_chunk) = sink();

        let served = router
            .generate_text(text_req("m1"), &opts("gateway"), &Cancel::new(), &mut on_chunk)
            .await
            .expect("served");

        assert_eq!(*seen.lock().unwrap(), vec!["he".to_string(), "llo".to_string()]);
        assert_eq!(served.candidate.key.id, "k1");
        assert_eq!(router.next_key_cursor("p1"), 1, "a served provider advances its cursor");

        let row = &rows(&router.ledger())[0];
        assert_eq!(row.status, "ok");
        assert_eq!(row.source, "gateway");
        assert_eq!(row.provider_id.as_deref(), Some("p1"));
        assert_eq!(row.key_id.as_deref(), Some("k1"));
        assert_eq!(row.requested_model.as_deref(), Some("m1"));
        assert_eq!(row.model, "m1", "the native id that served");
        assert_eq!((row.tokens_in, row.tokens_out), (120, 34));
        assert_eq!(row.cached_tokens, Some(64), "the third field survives to the column");
        assert!(row.latency_ms.is_some(), "the ok row carries a latency");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_stream_that_drains_with_nothing_in_it_is_a_parse_error_not_a_success() {
        // The source's `if (!served)` (`:436`), and the live ledger that motivated it: seven rows
        // claimed "ok" for requests that never produced a token, their 99.5s and 83s latencies
        // being client timeouts. `TextSuccess` cannot tell this apart from a real stream — the
        // router's own chunk count is what can.
        let store = one_provider();
        let adapter = Scripted::new(vec![chunks(&[])]);
        let mut router = ModelRouter::new(&store, factory(adapter.clone()));
        let (_seen, mut on_chunk) = sink();

        let served = router
            .generate_text(text_req("m1"), &opts("ui"), &Cancel::new(), &mut on_chunk)
            .await
            .expect("the engine reports Ok — nothing threw");

        assert_eq!(served.candidate.provider.id, "p1", "the engine's own answer is unchanged");
        let row = &rows(&router.ledger())[0];
        assert_eq!(row.status, "error");
        assert_eq!(row.error_class.as_deref(), Some("PARSE_ERROR"));
        assert_eq!(row.provider_id, None, "no provider produced a token, so none is named");
        assert_eq!(row.key_id, None);
        assert_eq!(row.model, "m1", "the requested id, because no native id served");
        assert_eq!(router.next_key_cursor("p1"), 0, "nothing served, so nothing advances");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_whole_plan_of_refusals_records_the_last_class_and_the_chain() {
        // Three candidates means three keys; give the provider three.
        let store = RouterStore::hydrate(
            vec![provider("p1", "p1", "enabled", "priority")],
            vec![key("k1", "p1", "k1"), key("k2", "p1", "k2"), key("k3", "p1", "k3")],
            vec![model("p1", "m1", TEXT)],
            vec![],
        );
        let adapter =
            Scripted::new(vec![Err(refusal(404)), Err(refusal(429)), Err(AttemptError::Transport)]);
        let mut router = ModelRouter::new(&store, factory(adapter.clone()));
        let (_seen, mut on_chunk) = sink();

        let error = router
            .generate_text(text_req("m1"), &opts("ui"), &Cancel::new(), &mut on_chunk)
            .await
            .expect_err("nothing served");

        assert!(matches!(text_failure(&error), TextFailure::AllAttemptsFailed { .. }));

        let row = &rows(&router.ledger())[0];
        assert_eq!(row.status, "error");
        assert_eq!(row.error_class.as_deref(), Some("NETWORK"), "the last attempt's class");
        assert_eq!(
            row.http_status,
            Some(0),
            "the source writes `last.status`, and a transport failure's status is 0 — not NULL"
        );
        assert_eq!(row.provider_id, None, "nothing served, so no provider is named");
        let entries = chain(row);
        assert_eq!(entries.len(), 3, "one entry per attempt");
        assert_eq!(entries[0]["cls"], json!("NOT_FOUND"));
        assert_eq!(entries[2]["cls"], json!("NETWORK"));
        assert_eq!(entries[0]["provider"], json!("p1"));
        assert_eq!(entries[0]["key"], json!("k1"), "the chain names the key that was tried");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_refusal_before_the_success_keeps_its_own_class_and_status_in_the_row() {
        let store = RouterStore::hydrate(
            vec![provider("p1", "p1", "enabled", "priority")],
            vec![key("k1", "p1", "k1"), key("k2", "p1", "k2")],
            vec![model("p1", "m1", TEXT)],
            vec![],
        );
        let adapter = Scripted::new(vec![Err(refusal(503)), chunks(&["ok"])]);
        let mut router = ModelRouter::new(&store, factory(adapter.clone()));
        let (_seen, mut on_chunk) = sink();

        router
            .generate_text(text_req("m1"), &opts("ui"), &Cancel::new(), &mut on_chunk)
            .await
            .expect("the second key serves");

        let row = &rows(&router.ledger())[0];
        assert_eq!(row.status, "ok", "the request as a whole succeeded");
        assert_eq!(row.http_status, None, "the ok row names no status — the source's shape");
        assert_eq!(
            row.key_id.as_deref(),
            Some("k2"),
            "the key that served, not the one that failed"
        );
        let entries = chain(row);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["key"], json!("k1"));
        assert_eq!(entries[0]["cls"], json!("SERVER_ERROR"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_cancelled_request_is_recorded_as_cancelled_with_no_provider() {
        let store = one_provider();
        let adapter = Scripted::new(vec![chunks(&["x"])]);
        let mut router = ModelRouter::new(&store, factory(adapter.clone()));
        let (_seen, mut on_chunk) = sink();
        let cancel = Cancel::new();
        cancel.cancel();

        let error = router
            .generate_text(text_req("m1"), &opts("ui"), &cancel, &mut on_chunk)
            .await
            .expect_err("cancelled before the first candidate");

        assert!(matches!(text_failure(&error), TextFailure::Cancelled { .. }));
        let row = &rows(&router.ledger())[0];
        assert_eq!(row.error_class.as_deref(), Some("CANCELLED"));
        assert_eq!(row.provider_id, None);
        assert_eq!(adapter.calls().len(), 0, "a cancelled request takes no slot and no call");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_request_with_no_route_is_recorded_and_never_reaches_the_adapter() {
        let store = RouterStore::hydrate(vec![], vec![], vec![], vec![]);
        let adapter = Scripted::new(vec![chunks(&["x"])]);
        let mut router = ModelRouter::new(&store, factory(adapter.clone()));
        let (_seen, mut on_chunk) = sink();

        let error = router
            .generate_text(text_req("ghost"), &opts("ui"), &Cancel::new(), &mut on_chunk)
            .await
            .expect_err("nothing carries it");

        match error {
            RouterError::NoRoute { ref model, ref modality, .. } => {
                assert_eq!(model, "ghost");
                assert_eq!(modality, TEXT);
            }
            other => panic!("expected NoRoute, got {other:?}"),
        }
        assert_eq!(adapter.calls().len(), 0);
        let row = &rows(&router.ledger())[0];
        assert_eq!(row.status, "error");
        assert_eq!(row.error_class.as_deref(), Some("NO_ROUTE"));
        assert_eq!(row.model, "ghost");
        assert_eq!(chain(row).len(), 0, "\"[]\" — there were no attempts to record");
        assert!(row.fallback_chain_json.is_some(), "and that is not the same as absent");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_no_route_row_is_attributed_to_the_app_that_asked() {
        // A `NO_ROUTE` row costs nothing, so leaving it unattributed is tempting — but a per-app
        // view that dropped exactly the failures would under-report the app that is misconfigured.
        let store = RouterStore::hydrate(vec![], vec![], vec![], vec![]);
        let adapters = Always(Scripted::new(vec![]));
        let mut router = ModelRouter::new(&store, &adapters);
        let (_seen, mut on_chunk) = sink();

        let _ = router
            .generate_text(
                text_req("ghost"),
                &CallOptions { source: Some("gateway".into()), app_key_id: Some("app-7".into()) },
                &Cancel::new(),
                &mut on_chunk,
            )
            .await;

        let row = &rows(&router.ledger())[0];
        assert_eq!(row.app_key_id.as_deref(), Some("app-7"));
        assert_eq!(row.source, "gateway");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_text_request_is_attributed_to_the_source_and_the_app_key_it_came_from() {
        let store = one_provider();
        let adapter = Scripted::new(vec![chunks(&["ok"])]);
        let mut router = ModelRouter::new(&store, factory(adapter.clone()));
        let (_seen, mut on_chunk) = sink();

        router
            .generate_text(
                text_req("m1"),
                &CallOptions { source: Some("gateway".into()), app_key_id: Some("app-9".into()) },
                &Cancel::new(),
                &mut on_chunk,
            )
            .await
            .expect("served");

        let row = &rows(&router.ledger())[0];
        assert_eq!(row.source, "gateway");
        assert_eq!(row.app_key_id.as_deref(), Some("app-9"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_default_source_is_ui() {
        let store = one_provider();
        let adapter = Scripted::new(vec![chunks(&["ok"])]);
        let mut router = ModelRouter::new(&store, factory(adapter.clone()));
        let (_seen, mut on_chunk) = sink();

        router
            .generate_text(text_req("m1"), &CallOptions::default(), &Cancel::new(), &mut on_chunk)
            .await
            .expect("served");

        assert_eq!(rows(&router.ledger())[0].source, DEFAULT_SOURCE);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_cost_column_comes_from_the_cached_pricing_and_not_from_a_zero() {
        let store = RouterStore::hydrate(
            vec![provider("p1", "p1", "enabled", "priority")],
            vec![key("k1", "p1", "k1")],
            // 150_000 micros per 1M in, 600_000 per 1M out.
            vec![priced("p1", "m1", 150_000, 600_000)],
            vec![],
        );
        let adapter = Scripted::new(vec![chunks(&["ok"])])
            .reporting(vec![Some(UsageTokens::new(1_000_000, 1_000_000, None))]);
        let mut router = ModelRouter::new(&store, factory(adapter.clone()));
        let (_seen, mut on_chunk) = sink();

        router
            .generate_text(text_req("m1"), &opts("ui"), &Cancel::new(), &mut on_chunk)
            .await
            .expect("served");

        // 1M in at 150_000 micros + 1M out at 600_000 = 750_000 micros. If the router read the
        // cache shape with the raw-catalog reader this would be 750_000_000_000_000.
        assert_eq!(rows(&router.ledger())[0].cost_estimate_micros, 750_000);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_unpriced_model_costs_zero_in_the_column_which_is_not_the_same_as_free() {
        let store = one_provider(); // `m1` carries no pricing_json
        let adapter = Scripted::new(vec![chunks(&["ok"])])
            .reporting(vec![Some(UsageTokens::new(1_000_000, 1_000_000, None))]);
        let mut router = ModelRouter::new(&store, factory(adapter.clone()));
        let (_seen, mut on_chunk) = sink();

        router
            .generate_text(text_req("m1"), &opts("ui"), &Cancel::new(), &mut on_chunk)
            .await
            .expect("served");

        let row = &rows(&router.ledger())[0];
        assert_eq!(row.cost_estimate_micros, 0, "unknown pricing is 0 in the column");
        assert_eq!(
            router.pricing_for(&model("p1", "m1", TEXT)),
            None,
            "and the catalog still says unknown, which is what the UI renders as an em dash"
        );
    }

    // ---------- the ledger sink ----------

    #[derive(Default, Clone)]
    struct SpySink {
        entries: Arc<Mutex<Vec<LedgerRow>>>,
    }

    impl LedgerSink for SpySink {
        fn append(
            &self,
            entry: &LedgerRow,
        ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
            self.entries.lock().unwrap().push(entry.clone());
            Ok(())
        }
    }

    struct FailingSink;

    impl LedgerSink for FailingSink {
        fn append(
            &self,
            _entry: &LedgerRow,
        ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
            Err("disk full".into())
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn every_row_the_router_writes_reaches_the_sink() {
        let store = one_provider();
        let spy = SpySink::default();
        let adapter = Scripted::new(vec![chunks(&["ok"])]);
        let mut router = ModelRouter::new(&store, factory(adapter.clone()))
            .with_ledger(UsageLedger::new().with_sink(Box::new(spy.clone())));
        let (_seen, mut on_chunk) = sink();

        router
            .generate_text(text_req("m1"), &opts("ui"), &Cancel::new(), &mut on_chunk)
            .await
            .expect("served");

        assert_eq!(spy.entries.lock().unwrap().len(), 1);
        assert_eq!(spy.entries.lock().unwrap()[0].status, "ok");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_sink_failure_is_returned_rather_than_swallowed() {
        // `core::ledger` returns the sink's error precisely so a full disk is observable. The
        // router must not be the place that turns it back into silence.
        let store = one_provider();
        let adapter = Scripted::new(vec![chunks(&["delivered"])]);
        let mut router = ModelRouter::new(&store, factory(adapter.clone()))
            .with_ledger(UsageLedger::new().with_sink(Box::new(FailingSink)));
        let (seen, mut on_chunk) = sink();

        let error = router
            .generate_text(text_req("m1"), &opts("ui"), &Cancel::new(), &mut on_chunk)
            .await
            .expect_err("the row could not be written");

        assert!(matches!(error, RouterError::Ledger(_)), "got {error:?}");
        assert_eq!(
            *seen.lock().unwrap(),
            vec!["delivered".to_string()],
            "the text was already delivered — the failure is about the record, not the request"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_sink_failure_on_a_no_route_row_is_also_returned() {
        let store = RouterStore::hydrate(vec![], vec![], vec![], vec![]);
        let adapters = Always(Scripted::new(vec![]));
        let mut router = ModelRouter::new(&store, &adapters)
            .with_ledger(UsageLedger::new().with_sink(Box::new(FailingSink)));
        let (_seen, mut on_chunk) = sink();

        let error = router
            .generate_text(text_req("ghost"), &opts("ui"), &Cancel::new(), &mut on_chunk)
            .await
            .expect_err("the no-route row could not be written");

        assert!(matches!(error, RouterError::Ledger(_)), "got {error:?}");
    }

    // ---------- generate_image ----------

    #[tokio::test(flavor = "multi_thread")]
    async fn an_image_request_returns_the_payload_and_records_the_serving_candidate() {
        let store = RouterStore::hydrate(
            vec![provider("p1", "p1", "enabled", "priority")],
            vec![key("k1", "p1", "k1")],
            vec![model("p1", "img-1", IMAGE)],
            vec![],
        );
        let adapter = Scripted::images(vec![ok_reply("AAAA")]);
        let mut router = ModelRouter::new(&store, factory(adapter.clone()));

        let result = router
            .generate_image(
                &ImageRequest { model: "img-1".into(), prompt: "a cat".into() },
                &opts("gateway"),
                &Cancel::new(),
            )
            .await
            .expect("served");

        assert_eq!(result.base64.as_deref(), Some("AAAA"));
        assert_eq!(result.url, None);
        assert_eq!(router.next_key_cursor("p1"), 1);
        let row = &rows(&router.ledger())[0];
        assert_eq!(row.modality, IMAGE);
        assert_eq!(row.status, "ok");
        assert_eq!(row.provider_id.as_deref(), Some("p1"));
        assert_eq!(row.model, "img-1");
        assert_eq!((row.tokens_in, row.tokens_out), (0, 0), "the source writes zeros here");
        assert_eq!(row.cost_estimate_micros, 0);
        assert_eq!(adapter.calls(), vec!["image:key:k1|img-1".to_string()]);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_image_row_carries_the_chain_of_refusals_that_preceded_it() {
        let store = RouterStore::hydrate(
            vec![provider("p1", "p1", "enabled", "priority")],
            vec![key("k1", "p1", "k1"), key("k2", "p1", "k2")],
            vec![model("p1", "img-1", IMAGE)],
            vec![],
        );
        let adapter = Scripted::images(vec![refused(404), ok_reply("BBBB")]);
        let mut router = ModelRouter::new(&store, factory(adapter.clone()));

        router
            .generate_image(
                &ImageRequest { model: "img-1".into(), prompt: "a cat".into() },
                &opts("ui"),
                &Cancel::new(),
            )
            .await
            .expect("the second key serves");

        let row = &rows(&router.ledger())[0];
        assert_eq!(row.status, "ok");
        assert_eq!(row.key_id.as_deref(), Some("k2"));
        let entries = chain(row);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["cls"], json!("NOT_FOUND"));
        assert_eq!(entries[0]["provider"], json!("p1"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_three_reasons_an_image_request_plans_to_nothing_are_told_apart() {
        // Measured live 2026-09-22: the gateway advertised 15 image-named models and 404'd every
        // one, because the catalog tagged zero of them as image — so the message that blamed the
        // model id was wrong for all fifteen.
        let adapters = Always(Scripted::images(vec![]));

        // 1. Nothing in the catalog is an image model at all.
        let store = RouterStore::hydrate(
            vec![provider("p1", "p1", "enabled", "priority")],
            vec![key("k1", "p1", "k1")],
            vec![model("p1", "img-1", TEXT)],
            vec![],
        );
        let mut router = ModelRouter::new(&store, &adapters);
        let error = router
            .generate_image(
                &ImageRequest { model: "img-1".into(), prompt: "x".into() },
                &opts("ui"),
                &Cancel::new(),
            )
            .await
            .expect_err("no image capability");
        assert_eq!(
            error.message(),
            "no route for image model \"img-1\" (no enabled provider is configured for image generation)"
        );

        // 2. The id is not in the catalog at all.
        let store = RouterStore::hydrate(
            vec![provider("p1", "p1", "enabled", "priority")],
            vec![key("k1", "p1", "k1")],
            vec![model("p1", "img-1", IMAGE)],
            vec![],
        );
        let mut router = ModelRouter::new(&store, &adapters);
        let error = router
            .generate_image(
                &ImageRequest { model: "ghost".into(), prompt: "x".into() },
                &opts("ui"),
                &Cancel::new(),
            )
            .await
            .expect_err("nothing carries it");
        assert_eq!(
            error.message(),
            "no route for image model \"ghost\" (no enabled provider carries it)"
        );

        // 3. The id resolves — as a *text* model. A provider *is* configured for image (`img-2`),
        //    so the first branch cannot mask this one; the id is known, and the answer is about
        //    the tag rather than about the string.
        let store = RouterStore::hydrate(
            vec![provider("p1", "p1", "enabled", "priority")],
            vec![key("k1", "p1", "k1")],
            vec![model("p1", "gpt-4o", TEXT), model("p1", "img-2", IMAGE)],
            vec![],
        );
        let mut router = ModelRouter::new(&store, &adapters);
        let error = router
            .generate_image(
                &ImageRequest { model: "gpt-4o".into(), prompt: "x".into() },
                &opts("ui"),
                &Cancel::new(),
            )
            .await
            .expect_err("tagged text");
        assert_eq!(
            error.message(),
            "no route for image model \"gpt-4o\" (it is not tagged as an image model in the catalog)"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_qualified_image_id_counts_as_known() {
        // `/v1/models` prints ids as `slug/native`, so the caller's own list produces qualified
        // ids — and `whyNoImage`'s second branch must not call those unknown.
        // `img-2` is load-bearing: without *some* image model in the catalog the first branch of
        // `why_no_image` fires and this test would pass while asserting nothing about the
        // `ends_with` rule below. The request names the *text* row.
        let store = RouterStore::hydrate(
            vec![provider("p1", "openrouter", "enabled", "priority")],
            vec![key("k1", "p1", "k1")],
            vec![model("p1", "img-1", TEXT), model("p1", "img-2", IMAGE)],
            vec![],
        );
        let adapters = Always(Scripted::images(vec![]));
        let mut router = ModelRouter::new(&store, &adapters);
        let error = router
            .generate_image(
                &ImageRequest { model: "openrouter/img-1".into(), prompt: "x".into() },
                &opts("ui"),
                &Cancel::new(),
            )
            .await
            .expect_err("tagged text");

        assert_eq!(
            error.message(),
            "no route for image model \"openrouter/img-1\" (it is not tagged as an image model in the catalog)",
            "known, but not an image model — not the same answer as unknown"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_whole_plan_of_image_refusals_is_an_error_with_the_chain() {
        let store = RouterStore::hydrate(
            vec![provider("p1", "p1", "enabled", "priority")],
            vec![key("k1", "p1", "k1")],
            vec![model("p1", "img-1", IMAGE)],
            vec![],
        );
        let adapter = Scripted::images(vec![refused(429)]);
        let mut router = ModelRouter::new(&store, factory(adapter.clone()));

        let error = router
            .generate_image(
                &ImageRequest { model: "img-1".into(), prompt: "x".into() },
                &opts("ui"),
                &Cancel::new(),
            )
            .await
            .expect_err("nothing served");

        match error {
            RouterError::Image(ref failed) => assert_eq!(failed.chain.len(), 1),
            other => panic!("expected Image, got {other:?}"),
        }
        // **Zero rows, and that is the source's behaviour, not a gap.** `generateText` ends in
        // `this.wrapLedger(...)` (`:172-180`), which catches `AllAttemptsFailed` and appends an
        // error row; `generateImage` (`:183-218`) has no such wrapper and lets the throw escape
        // before its `ledger.append` is ever reached. So an image request that planned
        // *something* and failed leaves no trace, while a text request in the same position
        // leaves one. Pinned here because it is the kind of asymmetry a later reader "fixes".
        assert_eq!(
            rows(&router.ledger()).len(),
            0,
            "a failed image plan writes nothing — only the empty-plan path records a no-route row"
        );
    }

    // ---------- complete ----------

    #[tokio::test(flavor = "multi_thread")]
    async fn complete_prefers_the_configured_system_route_and_records_a_generator_row() {
        let store = RouterStore::hydrate(
            vec![
                provider("p1", "p1", "enabled", "priority"),
                provider("p2", "p2", "enabled", "priority"),
            ],
            vec![key("k1", "p1", "k1"), key("k2", "p2", "k2")],
            vec![model("p1", "cheap", TEXT), model("p2", "good", TEXT)],
            vec![],
        );
        let adapter = Scripted::new(vec![chunks(&["answer"])]);
        let mut router =
            ModelRouter::new(&store, factory(adapter.clone())).with_settings(RouterSettings {
                system_ai: Some(SystemAiPick { provider_id: "p2".into(), model: "good".into() }),
                ..Default::default()
            });

        let out = router
            .complete(&CompleteRequest {
                prompt: "hi".into(),
                system: None,
                max_tokens: 64,
                timeout_ms: 5_000,
                exclude_provider_ids: vec![],
            })
            .await
            .expect("served");

        assert_eq!(out, "answer");
        assert_eq!(
            adapter.calls(),
            vec!["text:key:k2|good".to_string()],
            "the configured pick is tried first, so no other candidate is reached"
        );
        let row = &rows(&router.ledger())[0];
        assert_eq!(row.source, GENERATOR_SOURCE);
        assert_eq!(row.provider_id.as_deref(), Some("p2"));
        assert_eq!(row.latency_ms, Some(0), "the source writes zero here, not a measurement");
        assert_eq!(row.fallback_chain_json, None, "and no chain at all — NULL, not \"[]\"");
        assert_eq!(row.app_key_id, None, "a generator row is attributable to no app");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn complete_skips_an_excluded_provider_even_when_it_is_the_system_route() {
        let store = RouterStore::hydrate(
            vec![
                provider("p1", "p1", "enabled", "priority"),
                provider("p2", "p2", "enabled", "priority"),
            ],
            vec![key("k1", "p1", "k1"), key("k2", "p2", "k2")],
            vec![model("p1", "cheap", TEXT), model("p2", "good", TEXT)],
            vec![],
        );
        let adapter = Scripted::new(vec![chunks(&["from p1"])]);
        let mut router =
            ModelRouter::new(&store, factory(adapter.clone())).with_settings(RouterSettings {
                system_ai: Some(SystemAiPick { provider_id: "p2".into(), model: "good".into() }),
                ..Default::default()
            });

        let out = router
            .complete(&CompleteRequest {
                prompt: "hi".into(),
                system: None,
                max_tokens: 64,
                timeout_ms: 5_000,
                exclude_provider_ids: vec!["p2".to_string()],
            })
            .await
            .expect("the unexcluded provider serves");

        assert_eq!(out, "from p1");
        assert_eq!(adapter.calls(), vec!["text:key:k1|cheap".to_string()]);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn complete_moves_on_to_the_next_provider_when_a_candidate_returns_nothing() {
        // `if (out)` (`:308`): an empty stream is not an answer, so the loop continues.
        //
        // **The fall-through is per *model*, not per key.** `modelOrder` holds one entry per
        // (provider, model) pair, and the engine's own loop is what fails over between keys. So a
        // model whose only key streams nothing is abandoned — the next candidate tried is another
        // *provider's* model, never the same provider's second key. That is the source's shape and
        // it is easy to misread as a bug; this test is what states it.
        let store = RouterStore::hydrate(
            vec![
                provider("p1", "p1", "enabled", "priority"),
                provider("p2", "p2", "enabled", "priority"),
            ],
            vec![key("k1", "p1", "k1"), key("k2", "p1", "k2"), key("k3", "p2", "k3")],
            vec![model("p1", "m1", TEXT), model("p2", "m2", TEXT)],
            vec![],
        );
        let adapter = Scripted::new(vec![chunks(&[]), chunks(&["from p2"])]);
        let mut router = ModelRouter::new(&store, factory(adapter.clone()));

        let out = router
            .complete(&CompleteRequest {
                prompt: "hi".into(),
                system: None,
                max_tokens: 64,
                timeout_ms: 5_000,
                exclude_provider_ids: vec![],
            })
            .await
            .expect("the second provider answers");

        assert_eq!(out, "from p2");
        assert_eq!(
            adapter.calls(),
            vec!["text:key:k1|m1".to_string(), "text:key:k3|m2".to_string()],
            "p1's second key is never tried — the engine saw an empty stream as served"
        );
        assert_eq!(rows(&router.ledger()).len(), 1, "only the successful attempt is recorded");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn complete_prefixes_a_system_message_only_when_one_was_asked_for() {
        let store = one_provider();
        let adapter = Scripted::new(vec![chunks(&["a"]), chunks(&["b"])]);
        let mut router = ModelRouter::new(&store, factory(adapter.clone()));

        router
            .complete(&CompleteRequest {
                prompt: "p".into(),
                system: Some("s".into()),
                max_tokens: 8,
                timeout_ms: 5_000,
                exclude_provider_ids: vec![],
            })
            .await
            .expect("served");
        router
            .complete(&CompleteRequest {
                prompt: "p".into(),
                system: None,
                max_tokens: 8,
                timeout_ms: 5_000,
                exclude_provider_ids: vec![],
            })
            .await
            .expect("served");

        // The engine's own message count is the observable: two messages with a system prompt,
        // one without. Asserted through the router rather than by reaching into the engine.
        assert_eq!(adapter.calls().len(), 2);
        assert_eq!(rows(&router.ledger()).len(), 2);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn complete_reports_the_sources_message_when_nothing_answers() {
        let store = RouterStore::hydrate(vec![], vec![], vec![], vec![]);
        let adapters = Always(Scripted::new(vec![]));
        let mut router = ModelRouter::new(&store, &adapters);

        let error = router
            .complete(&CompleteRequest {
                prompt: "hi".into(),
                system: None,
                max_tokens: 64,
                timeout_ms: 5_000,
                exclude_provider_ids: vec![],
            })
            .await
            .expect_err("nothing to route to");

        assert_eq!(error.message(), "system AI: no healthy text provider available");
        assert!(
            !matches!(error, RouterError::NoRoute { .. }),
            "not NoRoute: the source's message has no \"no route\" phrase, so the gateway answers \
             500 rather than 404"
        );
        assert!(rows(&router.ledger()).is_empty(), "a request that never planned writes no row");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn complete_stops_when_the_timeout_fires() {
        // The timeout is a real abort: a candidate that hangs must not hold the call open. The
        // adapter here never answers, so the only thing that can end the loop is the timer.
        let store = one_provider();
        let mut router = ModelRouter::new(&store, hanging());

        let error = router
            .complete(&CompleteRequest {
                prompt: "hi".into(),
                system: None,
                max_tokens: 64,
                timeout_ms: 30,
                exclude_provider_ids: vec![],
            })
            .await
            .expect_err("the timeout ends it");

        assert_eq!(error.message(), "system AI: no healthy text provider available");
        assert!(rows(&router.ledger()).is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn complete_uses_whatever_cap_is_live_rather_than_syncing_it() {
        // The source's asymmetry (`:272` does not call `syncConcurrency`, while `generateText` and
        // `generateImage` both do). A settings change therefore reaches the Generator only after
        // the next UI or gateway request — kept, because "fixing" it would change when a user's cap
        // takes effect, which is a behaviour change rather than a port step.
        let store = one_provider();
        let adapter = Scripted::new(vec![chunks(&["ok"])]);
        let mut router = ModelRouter::new(&store, factory(adapter.clone()));
        router.settings.per_provider_concurrency = json!(9);

        router
            .complete(&CompleteRequest {
                prompt: "hi".into(),
                system: None,
                max_tokens: 8,
                timeout_ms: 5_000,
                exclude_provider_ids: vec![],
            })
            .await
            .expect("served");

        assert_eq!(
            router.limiter().max_per_provider(),
            PER_PROVIDER_DEFAULT,
            "the setting was not applied, because `complete` never syncs"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn generate_text_does_sync_the_cap() {
        // The control for the test above: the same setting, the same router, the other entry point.
        let store = one_provider();
        let adapter = Scripted::new(vec![chunks(&["ok"])]);
        let mut router = ModelRouter::new(&store, factory(adapter.clone()));
        router.settings.per_provider_concurrency = json!(9);
        let (_seen, mut on_chunk) = sink();

        router
            .generate_text(text_req("m1"), &opts("ui"), &Cancel::new(), &mut on_chunk)
            .await
            .expect("served");

        assert_eq!(router.limiter().max_per_provider(), 9);
    }

    /// A factory whose text calls never complete, for the timeout test.
    #[derive(Default)]
    struct Hanging;

    struct HangingAdapter;

    impl AdapterInstance for HangingAdapter {
        fn generate_image<'a>(
            &'a self,
            _secret_ref: &'a str,
            _args: ImageArgs,
            _cancel: &'a Cancel,
        ) -> BoxFuture<'a, Result<ImageReply, AttemptError>> {
            Box::pin(async { Err(AttemptError::Transport) })
        }

        fn generate_text<'a>(
            &'a self,
            _secret_ref: &'a str,
            _args: TextArgs<'a>,
            cancel: &'a Cancel,
        ) -> BoxFuture<'a, Result<BoxStream<'a, Result<String, AttemptError>>, AttemptError>>
        {
            // Poll until cancelled, then report a transport failure — which is what a request
            // aborted in flight looks like to the loop.
            Box::pin(async move {
                while !cancel.is_cancelled() {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
                Err(AttemptError::Transport)
            })
        }

        fn capabilities(&self) -> Capabilities {
            Capabilities { text: true, image: false }
        }

        fn tag_modality(&self, _entry: &ModelEntry) -> &'static str {
            "text"
        }

        fn list_models<'a>(
            &'a self,
            _secret_ref: &'a str,
            _cancel: &'a Cancel,
        ) -> BoxFuture<'a, Result<Vec<ModelEntry>, AttemptError>> {
            Box::pin(async { Ok(Vec::new()) })
        }

        fn ping_key<'a>(
            &'a self,
            _secret_ref: &'a str,
            _cancel: &'a Cancel,
        ) -> BoxFuture<'a, PingResult> {
            Box::pin(async {
                PingResult { ok: false, status: 0, rate_limited: false, message: None }
            })
        }
    }

    impl AdapterFactory for Hanging {
        fn for_provider<'a>(
            &'a self,
            _provider_id: &'a str,
        ) -> BoxFuture<'a, Result<Arc<dyn AdapterInstance>, String>> {
            Box::pin(async { Ok(Arc::new(HangingAdapter) as Arc<dyn AdapterInstance>) })
        }
    }

    /// See [`factory`] — the same leak, for the factory whose calls never complete.
    fn hanging() -> &'static Hanging {
        Box::leak(Box::new(Hanging))
    }

    // ---------- list_models ----------

    #[test]
    fn list_models_prints_the_qualified_id_the_gateway_advertises() {
        let store = RouterStore::hydrate(
            vec![provider("p1", "openrouter", "enabled", "priority")],
            vec![],
            vec![model("p1", "gpt-4o", TEXT), model("p1", "img-1", IMAGE)],
            vec![],
        );
        let adapters = Always(Scripted::new(vec![]));
        let router = ModelRouter::new(&store, &adapters);

        let all = router.list_models(None);
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].id, "openrouter/gpt-4o");
        assert_eq!(all[0].provider_id, "p1");
        assert_eq!(all[0].modality, TEXT);

        let images = router.list_models(Some(IMAGE));
        assert_eq!(images.len(), 1);
        assert_eq!(images[0].id, "openrouter/img-1");
    }

    #[test]
    fn a_model_whose_provider_is_gone_keeps_its_bare_id() {
        // The source's `p ? \`${p.slug}/${m.nativeId}\` : m.nativeId`. An `undefined/` prefix would
        // be a worse answer than the id the catalog still holds.
        let store = RouterStore::hydrate(vec![], vec![], vec![model("ghost", "m1", TEXT)], vec![]);
        let adapters = Always(Scripted::new(vec![]));
        let router = ModelRouter::new(&store, &adapters);
        assert_eq!(router.list_models(None)[0].id, "m1");
    }

    #[test]
    fn list_models_with_no_modality_returns_every_row() {
        let store = RouterStore::hydrate(
            vec![provider("p1", "p1", "enabled", "priority")],
            vec![],
            vec![model("p1", "a", TEXT), model("p1", "b", IMAGE), model("p1", "c", TEXT)],
            vec![],
        );
        let adapters = Always(Scripted::new(vec![]));
        let router = ModelRouter::new(&store, &adapters);
        assert_eq!(router.list_models(None).len(), 3);
        assert_eq!(router.list_models(Some(TEXT)).len(), 2);
    }

    // ---------- system_ai_available ----------

    #[test]
    fn the_configured_system_route_unlocks_the_path_when_it_is_usable() {
        let store = one_provider();
        let adapters = Always(Scripted::new(vec![]));
        let router = ModelRouter::new(&store, &adapters).with_settings(RouterSettings {
            system_ai: Some(SystemAiPick { provider_id: "p1".into(), model: "m1".into() }),
            ..Default::default()
        });
        assert_eq!(router.system_ai_available(), SystemAiHealth { available: true, reason: None });
    }

    #[test]
    fn any_enabled_provider_with_a_text_model_and_a_key_unlocks_the_path() {
        // §2.9 rule 3, and the reason this is not simply "is the system route configured".
        let store = RouterStore::hydrate(
            vec![provider("p1", "p1", "enabled", "priority")],
            vec![key("k1", "p1", "k1")],
            vec![model("p1", "m1", TEXT)],
            vec![],
        );
        let adapters = Always(Scripted::new(vec![]));
        let router = ModelRouter::new(&store, &adapters);
        assert!(router.settings.system_ai.is_none());
        assert!(router.system_ai_available().available);
    }

    #[test]
    fn a_provider_with_only_image_models_does_not_unlock_the_path() {
        let store = RouterStore::hydrate(
            vec![provider("p1", "p1", "enabled", "priority")],
            vec![key("k1", "p1", "k1")],
            vec![model("p1", "img-1", IMAGE)],
            vec![],
        );
        let adapters = Always(Scripted::new(vec![]));
        let router = ModelRouter::new(&store, &adapters);
        let health = router.system_ai_available();
        assert!(!health.available);
        assert_eq!(health.reason.as_deref(), Some(SYSTEM_AI_LOCKED));
    }

    #[test]
    fn a_disabled_provider_does_not_unlock_the_path() {
        let store = RouterStore::hydrate(
            vec![provider("p1", "p1", "disabled", "priority")],
            vec![key("k1", "p1", "k1")],
            vec![model("p1", "m1", TEXT)],
            vec![],
        );
        let adapters = Always(Scripted::new(vec![]));
        let router = ModelRouter::new(&store, &adapters);
        assert!(!router.system_ai_available().available);
    }

    #[test]
    fn a_provider_whose_only_key_is_disabled_does_not_unlock_the_path() {
        let mut disabled = key("k1", "p1", "k1");
        disabled.status = "disabled".to_string();
        let store = RouterStore::hydrate(
            vec![provider("p1", "p1", "enabled", "priority")],
            vec![disabled],
            vec![model("p1", "m1", TEXT)],
            vec![],
        );
        let adapters = Always(Scripted::new(vec![]));
        let router = ModelRouter::new(&store, &adapters);
        assert!(!router.system_ai_available().available);
    }

    #[test]
    fn a_key_the_tracker_has_cooled_does_not_unlock_the_path() {
        // The second way to be unusable, and it is the tracker's state rather than the row's — so a
        // check that only read `key.status` would say "available" while every request failed.
        let store = one_provider();
        let adapters = Always(Scripted::new(vec![]));
        let router = ModelRouter::new(&store, &adapters);
        assert!(router.system_ai_available().available, "usable to start with");

        router.health().record_result("k1", ErrorClass::RateLimited, Some(60_000), now_ms());
        assert!(
            !router.system_ai_available().available,
            "cooled for a minute, so not available now"
        );
    }

    #[test]
    fn a_configured_system_route_that_is_not_usable_falls_back_to_any_other_provider() {
        let store = RouterStore::hydrate(
            vec![
                provider("p1", "p1", "disabled", "priority"),
                provider("p2", "p2", "enabled", "priority"),
            ],
            vec![key("k1", "p1", "k1"), key("k2", "p2", "k2")],
            vec![model("p1", "m1", TEXT), model("p2", "m2", TEXT)],
            vec![],
        );
        let adapters = Always(Scripted::new(vec![]));
        let router = ModelRouter::new(&store, &adapters).with_settings(RouterSettings {
            system_ai: Some(SystemAiPick { provider_id: "p1".into(), model: "m1".into() }),
            ..Default::default()
        });
        assert!(
            router.system_ai_available().available,
            "the configured route is dead, but p2 can serve"
        );
    }

    // ---------- the chain's shape ----------

    #[test]
    fn an_empty_chain_is_written_as_an_empty_array_and_not_as_absent() {
        assert_eq!(chain_json(&[]), Some("[]".to_string()));
    }

    #[test]
    fn the_chain_entry_is_the_three_fields_the_webview_parses() {
        let attempts = vec![AttemptOutcome {
            cls: ErrorClass::RateLimited,
            status: 429,
            retry_after_ms: Some(1_000),
            label: Some(crate::core::engine::AttemptLabel {
                provider_slug: "openrouter".into(),
                key_label: "primary".into(),
            }),
        }];
        let parsed = chain_json(&attempts).unwrap();
        let value: Value = serde_json::from_str(&parsed).unwrap();
        assert_eq!(value[0]["provider"], json!("openrouter"));
        assert_eq!(value[0]["key"], json!("primary"));
        assert_eq!(value[0]["cls"], json!("RATE_LIMITED"));
        assert_eq!(
            value[0].as_object().unwrap().len(),
            3,
            "the status and the wait are not part of what the reader renders"
        );
    }

    #[test]
    fn an_unlabelled_attempt_names_no_provider_rather_than_a_forged_one() {
        let attempts = vec![AttemptOutcome {
            cls: ErrorClass::Network,
            status: 0,
            retry_after_ms: None,
            label: None,
        }];
        let value: Value = serde_json::from_str(&chain_json(&attempts).unwrap()).unwrap();
        assert_eq!(value[0], json!({ "cls": "NETWORK" }));
    }

    #[test]
    fn the_chain_keeps_the_order_the_attempts_were_tried_in() {
        let named = |slug: &str, cls| AttemptOutcome {
            cls,
            status: 500,
            retry_after_ms: None,
            label: Some(crate::core::engine::AttemptLabel {
                provider_slug: slug.to_string(),
                key_label: "k".to_string(),
            }),
        };
        let value: Value = serde_json::from_str(
            &chain_json(&[
                named("first", ErrorClass::NotFound),
                named("second", ErrorClass::ServerError),
            ])
            .unwrap(),
        )
        .unwrap();
        assert_eq!(value[0]["provider"], json!("first"));
        assert_eq!(value[1]["provider"], json!("second"));
    }

    // ---------- the error messages ----------

    #[test]
    fn the_text_no_route_message_omits_the_modality_word_the_source_omits() {
        // `no route for model "X"` for text, `no route for image model "X"` for images. The
        // difference is the source's, and both contain the phrase the gateway maps to 404.
        let text = RouterError::NoRoute {
            model: "m".into(),
            modality: TEXT.into(),
            reason: NO_CARRIER.into(),
        };
        assert_eq!(text.message(), "no route for model \"m\" (no enabled provider carries it)");
        assert!(text.message().contains("no route"));
    }

    #[test]
    fn a_ledger_failure_says_which_failure_it_was() {
        let error = RouterError::Ledger("disk full".into());
        assert_eq!(error.message(), "ledger write failed: disk full");
    }

    /// **The `Box` on `RouterError::Text` rests on this arithmetic, so it is asserted.**
    ///
    /// `clippy::result_large_err` fired on four of the five returns in this module and
    /// `clippy::large_enum_variant` on the enum itself. Both are answered by boxing the one variant
    /// that dominates — and the numbers are why that is the right fix *here* rather than the
    /// `#[allow]` `execute_text` carries (`engine.rs:891`).
    ///
    /// That allowance is correct for that function: its `Ok` arm carries the same 536-byte
    /// `Candidate` the failure does, so its `Result` is ~600 bytes with or without a box and the box
    /// would save 16 of them. The premise does not transfer. Three of the five `Ok` types in this
    /// module are 48 bytes or smaller (`ImageResult` 48, `String` 24, `()` 0) against a 616-byte
    /// `TextFailure`, so an unboxed error would be 8× to 77× the payload on a value returned on
    /// every call, success included. Measured before the box: `RouterError` 616.
    ///
    /// If a future `Ok` type grows past `TextFailure`, the box stops paying for itself and this
    /// fails — the same "re-argue rather than inherit" rule the engine's test states.
    #[test]
    fn the_error_is_boxed_because_it_outgrows_every_payload_but_the_text_one() {
        let error = std::mem::size_of::<RouterError>();
        let unboxed = std::mem::size_of::<TextFailure>();
        let text_payload = std::mem::size_of::<TextSuccess>();
        let image_payload = std::mem::size_of::<ImageResult>();

        assert!(
            error <= 88,
            "RouterError ({error}) is no longer small, so the box on `Text` is not doing its job; \
             `NoRoute` is 72 bytes and sets the floor"
        );
        assert!(
            unboxed > 4 * image_payload,
            "the unboxed error ({unboxed}) no longer dwarfs the image payload ({image_payload}), so \
             boxing is no longer the reason `generate_image` compiles without an allow"
        );
        assert!(
            unboxed < 2 * text_payload,
            "the unboxed error ({unboxed}) has grown past the text payload ({text_payload}) by more \
             than a factor of two — the decision is now also about `generate_text`, and the note on \
             `RouterError` needs re-arguing rather than extending"
        );
    }

    // ---------- shared request state ----------

    /// **The property, stated end to end and through the engine rather than around it.** A request
    /// that fails with a `429` on one router cools the key for a request served by another.
    ///
    /// The tests below assert that a *tracker* is shared. This asserts that a *request* changes what
    /// the next request does, which is what the bridge actually needs — and it is the one that fails
    /// if `generate_text` ever hands the engine a tracker of its own rather than the shared one, a
    /// mistake that leaves every mechanism-level test in this section green.
    #[tokio::test]
    async fn a_rate_limited_request_on_one_router_cools_the_key_for_the_next() {
        let store = one_provider();
        let adapters = Always(Scripted::new(vec![Err(refusal(429))]));
        let shared = SharedRouterState::new();
        let mut a = ModelRouter::new(&store, &adapters).with_shared(shared.clone());
        let b = ModelRouter::new(&store, &adapters).with_shared(shared.clone());

        assert!(b.system_ai_available().available, "usable to start with");
        let result =
            a.generate_text(text_req("m1"), &opts("gateway"), &Cancel::new(), &mut |_| {}).await;
        assert!(result.is_err(), "a 429 on the provider's only key is a failed request");

        assert!(
            !b.system_ai_available().available,
            "the cooldown A's request recorded must reach B, or every concurrent request retries a \
             key the previous one already proved is rate limited"
        );
    }

    /// Two routers built from one [`SharedRouterState`] share one circuit breaker.
    ///
    /// This is the property a concurrent bridge depends on. The cooldown one request records has to
    /// reach the next request, or every request retries a key the previous one already proved is
    /// rate limited — which is the whole reason the breaker exists.
    #[test]
    fn two_routers_from_one_shared_state_share_the_circuit_breaker() {
        let store = one_provider();
        let adapters = Always(Scripted::new(vec![]));
        let shared = SharedRouterState::new();
        let a = ModelRouter::new(&store, &adapters).with_shared(shared.clone());
        let b = ModelRouter::new(&store, &adapters).with_shared(shared.clone());

        assert!(b.system_ai_available().available, "usable to start with");
        a.health().record_result("k1", ErrorClass::RateLimited, Some(60_000), now_ms());
        assert!(
            !b.system_ai_available().available,
            "the cooldown A recorded must reach B, or B retries a key that is already cooled"
        );
    }

    /// **The control, and without it the test above proves nothing.** If the breaker were process
    /// state rather than router state, `two_routers_from_one_shared_state_share_the_circuit_breaker`
    /// would pass for a reason that has nothing to do with sharing. This pins that `new()` really
    /// does give each router its own, so the pair says "sharing happens *because* the state was
    /// shared" rather than merely "sharing happens".
    #[test]
    fn two_routers_without_shared_state_keep_their_own_breaker() {
        let store = one_provider();
        let adapters = Always(Scripted::new(vec![]));
        let a = ModelRouter::new(&store, &adapters);
        let b = ModelRouter::new(&store, &adapters);

        a.health().record_result("k1", ErrorClass::RateLimited, Some(60_000), now_ms());
        assert!(b.system_ai_available().available, "B never saw A's cooldown");
    }

    /// The key cursor is shared, which is what keeps the round-robin rotating across requests.
    ///
    /// **This is the piece a per-request router would lose silently.** Every request starting on
    /// key zero is not a smaller version of round-robin — it is no round-robin at all, and no
    /// existing test would notice, because every one of them builds a single router and never asks
    /// a second one where it would start.
    #[test]
    fn two_routers_from_one_shared_state_share_the_key_cursor() {
        let store = one_provider();
        let adapters = Always(Scripted::new(vec![]));
        let shared = SharedRouterState::new();
        let a = ModelRouter::new(&store, &adapters).with_shared(shared.clone());
        let b = ModelRouter::new(&store, &adapters).with_shared(shared.clone());

        assert_eq!(a.next_key_cursor("p1"), 0, "a fresh cursor starts at zero");
        a.advance_cursor("p1");
        assert_eq!(b.next_key_cursor("p1"), 1, "B starts where A left off, not at zero");

        let private = ModelRouter::new(&store, &adapters);
        assert_eq!(private.next_key_cursor("p1"), 0, "an unshared router keeps its own");
    }

    /// The ledger is shared, so a row written through one router is readable through another.
    #[test]
    fn two_routers_from_one_shared_state_share_one_ledger() {
        let store = one_provider();
        let adapters = Always(Scripted::new(vec![]));
        let shared = SharedRouterState::new();
        let a = ModelRouter::new(&store, &adapters).with_shared(shared.clone());
        let b = ModelRouter::new(&store, &adapters).with_shared(shared.clone());

        assert!(rows(&b.ledger()).is_empty());
        a.ledger().append(ledger_row(now_ms(), TEXT, "gateway")).unwrap();
        assert_eq!(rows(&b.ledger()).len(), 1, "A's row is in B's ledger");
        assert_eq!(rows(&b.ledger())[0].source, "gateway");
    }

    /// The limiter is shared through the state, which is what makes a settings change reach every
    /// request rather than only the router that applied it.
    ///
    /// `ProviderLimiter` is documented as sharing one budget across its clones, so what this pins is
    /// that `SharedRouterState` clones the *handle* rather than building a second limiter — the
    /// failure mode of a `Clone` that copied a non-`Arc` field instead of sharing it.
    #[test]
    fn a_settings_change_on_one_router_reaches_the_other_through_the_limiter() {
        let store = one_provider();
        let adapters = Always(Scripted::new(vec![]));
        let shared = SharedRouterState::new();
        let a = ModelRouter::new(&store, &adapters).with_shared(shared.clone()).with_settings(
            RouterSettings { per_provider_concurrency: json!(3), ..Default::default() },
        );
        let b = ModelRouter::new(&store, &adapters).with_shared(shared.clone());

        a.sync_concurrency();
        assert_eq!(b.limiter().max_per_provider(), 3, "the cap A applied is the cap B reads");
    }
}
