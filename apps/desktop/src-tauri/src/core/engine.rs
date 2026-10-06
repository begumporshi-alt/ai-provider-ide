//! The execution engine's pure core — the Rust port of three TypeScript modules that
//! `execution-engine.ts` cannot run without: `errors.ts` (the taxonomy), the
//! `COOLDOWN_FLOOR_MS` half of `health-tracker.ts`, and `AllAttemptsFailedError.minRetryAfterMs`
//! (the wait the client is told).
//!
//! Phase 2 of the headless plan (`docs/dev-book/10-headless-service.md` §7). Increments 1–6 were
//! deliberately the part with **no I/O, no async and no store**, so the taxonomy and the wait
//! arithmetic could be tested in isolation — the plan's "port the tests first". Increment 7 is the
//! first to cross that line: `execute_image` is `async`, calls an adapter, and is the first
//! consumer of the seam in `core::adapter`. The streaming half still needs a `Stream` adapter for
//! `chunks: AsyncIterable<string>` and is not here.
//!
//! **The contract this file exists to hold.** The client-facing `Retry-After` is the *shortest*
//! wait any attempt named, floored at `COOLDOWN_FLOOR_MS`. The Rust gateway already consumes
//! that value (`gateway::cooldown_secs`, `err_with_cooldown`) and its doc-comment on
//! `BridgeMsg::Error::retry_after_ms` states the same "shortest, not longest" rule — so the two
//! halves of the port already agree, and the tests below are what keep them agreeing.
//!
//! **The label gap is closed, and Phase 3's router is what closed it (increment 13a).**
//! `AttemptOutcome` in TypeScript carries a whole `Candidate` (provider + key + model) so a failed
//! chain can name what it tried (`execution-engine.ts:199`). The port could not copy that shape —
//! the three rows are owned here, so it would clone three of them per failed attempt where the
//! original copies a reference — and the note that used to live here said so while leaving the
//! decision open. Two consumers then made it unavoidable: `AllAttemptsFailed::describe`, and the
//! router's `fallback_chain_json`, which the Activity screen renders as `provider · key → cls`
//! (`store.ts:124-128`). [`AttemptLabel`] is the answer — the two strings those readers use, and
//! nothing else. **`AttemptOutcome` therefore lost `Copy`**, which is the whole cost: two call
//! sites read the class and the wait before pushing rather than after. The drift hook still cannot
//! be ported, because it wants the provider *id* and the model native id as well; that stays
//! recorded rather than guessed at.
//!
//! **The per-provider limiter is not here.** `concurrency.ts` is the fifth of the six dependency
//! modules, and it is the one piece of the port that is *shared mutable state* rather than a pure
//! function, so it lives in `core::limiter` instead of in this file. See `limiter.rs` for the
//! three places that port deliberately differs from the original.
//!
//! **Increment 2 adds the enforcement half.** `HealthTracker` is the module that *cools* a key,
//! and `min_retry_after_ms` is the one that *reports* the wait. The TypeScript exports
//! `COOLDOWN_FLOOR_MS` from the tracker specifically so the two cannot drift apart
//! (`health-tracker.ts:23-25`); here they share one constant, and
//! `the_enforced_floor_and_the_reported_floor_agree` is what keeps it that way.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;

use futures_util::StreamExt;
use serde_json::Value;

use crate::core::adapter::{
    AdapterFactory, Cancel, ImageArgs, ReasoningEffort, StreamObservation, TextArgs, ToolCall,
};
use crate::core::limiter::ProviderLimiter;
use crate::core::persist::{ApiKeyRow, ProviderRow};
use crate::core::planner::Candidate;
use crate::core::usage::UsageTokens;

// ---------- the error taxonomy (moved verbatim to engine/taxonomy.rs, D98 phase 1) ----------

pub mod taxonomy;

pub use taxonomy::*;


// ---------- attempt records + per-attempt policy (moved verbatim to engine/attempt.rs, D98 phase 2) ----------

pub mod attempt;

pub use attempt::*;


// ---------- the plan, and the image loop over it ----------

// `Candidate` — one planned attempt: which provider to call, with which key, for which model.
//
// It moved to `core::planner` in increment 11b. The type was parked in this module from increment 7
// with a note saying it was here only "because the planner itself is not ported yet"; the planner is
// now ported and owns its own output type, and this file imports it, so no call site changed. The
// definition and its history — the D21 renaming of `context_scope::Candidate`, and why `Debug` and
// only `Debug` — are with it.
//
// (A plain comment, not a doc comment: there is no item here for it to document any more, and
// clippy's `empty_line_after_doc_comments` would otherwise attach it to `transport_outcome`.)

/// What the image path records when the adapter did not answer at all.
///
/// The TypeScript's `catch {}` arm (`execution-engine.ts:187`) names `NETWORK` and status `0`, and
/// **keeps nothing else the error carried** — not the status, not the `Retry-After`. See
/// [`execute_image`] for why that is faithful and what it costs.
pub fn transport_outcome() -> AttemptOutcome {
    AttemptOutcome {
        cls: ErrorClass::Network,
        status: 0,
        retry_after_ms: None,
        reason: None,
        label: None,
    }
}

/// What one image request is asked to do. The Rust port of `executeImage`'s argument
/// (`execution-engine.ts:154-161`).
///
/// The plan is taken **by value**, where the TypeScript borrows its array: the serving candidate is
/// returned to the caller, and moving it out of the plan is how that is done without cloning three
/// rows. The plan is not reused after a request either way.
pub struct ExecuteImageArgs {
    pub plan: Vec<Candidate>,
    pub prompt: String,
    /// The model the caller asked for, as the caller named it — carried only so a failure can name
    /// it. The candidate's own `model.native_id` is what is actually sent.
    pub model: String,
    pub size: Option<String>,
    pub max_attempts: Option<usize>,
}

/// A served image request. The TypeScript returns this shape inline (`execution-engine.ts:161`).
#[derive(Debug)]
pub struct ImageSuccess {
    /// The candidate that served it.
    pub candidate: Candidate,
    pub base64: Option<String>,
    pub url: Option<String>,
    /// Every attempt that failed before this one succeeded, in the order they were tried.
    pub attempts: Vec<AttemptOutcome>,
}

/// Try each candidate in the plan until one returns an image. The Rust port of `executeImage`
/// (`execution-engine.ts:154-194`).
///
/// **`Err` is the whole-failure case, and an empty plan is one of them.** The TypeScript falls out
/// of the loop and throws unconditionally (`:193`), so a plan of zero candidates is a failure
/// rather than an empty success. [`attempt_budget`] is what turns `None` into
/// [`MAX_ATTEMPTS_DEFAULT`] and `Some(0)` into *zero* — the distinction that function exists to
/// keep, and the one a `||` would silently lose.
///
/// **Cancellation is checked before the cap** (`:165` then `:167`). The order is observable: a
/// cancelled request must not take a limiter slot on its way out.
///
/// **A saturation skip is recorded, not merely skipped.** [`saturated_outcome`] supplies the
/// `RATE_LIMITED`/`429` the TypeScript pushes at `:169`, even though the provider was never
/// contacted — `core::limiter` carries the argument for keeping that class.
///
/// **`Err` from the adapter is always `Network`, whatever it carries — and that is asymmetric with
/// the text path.** `executeText` classifies a thrown `ManifestHttpError` by its status (`:113`,
/// `:117-121`); `executeImage`'s `catch {}` (`:186`) discards the error and names no class but
/// `NETWORK`. The two agree today only because `generateImage` **returns** a refusal as
/// `{ok: false, status}` (`manifest-interpreter.ts:461`) rather than throwing it, so a
/// status-bearing error never reaches that arm. The port keeps the image path's behaviour, and
/// `a_status_bearing_adapter_error_still_records_network` is what pins it. Recorded as D22.
///
/// **A refusal cools its key by the tracker's floor, never by the provider's own wait.** That
/// follows from the same place: `ImageAttemptResult` is `{ok, status, errorBody?}`
/// (`manifest-interpreter.ts:57-60`) and has **nowhere to put** a `Retry-After`, so `:184-185`
/// records an outcome with no `retry_after_ms` and `recordResult` falls through to
/// [`COOLDOWN_FLOOR_MS`]. A `429 Retry-After: 30` on the image path therefore retries after one
/// second — the exact failure the text path's fix describes at `:126-128`, one path away. Recorded
/// as D22; `an_image_refusal_cools_its_key_by_the_floor_not_the_named_wait` pins it.
pub async fn execute_image(
    adapters: &dyn AdapterFactory,
    health: &HealthTracker,
    limiter: Option<&ProviderLimiter>,
    args: ExecuteImageArgs,
    cancel: &Cancel,
) -> Result<ImageSuccess, AllAttemptsFailed> {
    let mut attempts: Vec<AttemptOutcome> = Vec::new();
    let budget = attempt_budget(args.plan.len(), args.max_attempts);

    for candidate in args.plan.into_iter().take(budget) {
        // `:165`, before the cap so a cancelled request takes no slot.
        if cancel.is_cancelled() {
            break;
        }
        // `:167-171`. `acquire` is the check *and* the increment; asking `has_capacity` first would
        // reintroduce the race `limiter.rs` exists to remove. `None` from `acquire` is a saturated
        // provider, and `None` from `limiter` is no limiter at all — which is why the two are told
        // apart by `limiter.is_some()` rather than by the `Option` alone.
        let release = limiter.and_then(|l| l.acquire(&candidate.provider.id));
        if limiter.is_some() && release.is_none() {
            attempts.push(labelled(saturated_outcome(), &candidate));
            continue;
        }

        // `:174-178`. Owned rather than borrowed, so one is built per attempt; the TypeScript
        // builds a fresh object literal per call too.
        let image_args = ImageArgs {
            model: candidate.model.native_id.clone(),
            prompt: args.prompt.clone(),
            size: args.size.clone(),
        };

        // `:172-188`, with the factory rejection and the adapter rejection collapsed into the one
        // `catch {}` the TypeScript has — both are `Network`/`0` there.
        let outcome = match adapters.for_provider(&candidate.provider.id).await {
            Err(_) => labelled(transport_outcome(), &candidate),
            Ok(adapter) => {
                match adapter.generate_image(&candidate.key.secret_ref, image_args, cancel).await {
                    Err(_) => labelled(transport_outcome(), &candidate),
                    // `:179-182` — the only success arm, and the only one that returns.
                    Ok(reply) if reply.ok => {
                        health.record_result(&candidate.key.id, ErrorClass::Ok, None, now_ms());
                        return Ok(ImageSuccess {
                            candidate,
                            base64: reply.base64,
                            url: reply.url,
                            attempts,
                        });
                    }
                    // `:183-185` — a refusal is an `Ok` reply with `ok: false`, and its status is
                    // what gets classified. `retry_after_ms` is `None` because the reply shape has
                    // no field for it; see the doc comment above and D22.
                    Ok(reply) => labelled(
                        AttemptOutcome {
                            // `classify`, not `classify_attempt_error`: the reply is a *value*,
                            // not an error, so the gate hint comes straight from its body.
                            cls: {
                                let hint = crate::core::client_gate::detect_client_gate(
                                    reply.status,
                                    reply.error_body.as_deref(),
                                )
                                .map(|_| BodyHint::ClientGate)
                                .or_else(|| {
                                    crate::core::client_gate::detect_not_found(
                                        reply.status,
                                        reply.error_body.as_deref(),
                                    )
                                    .map(|_| BodyHint::NotFound)
                                });
                                classify(reply.status, hint)
                            },
                            status: reply.status,
                            retry_after_ms: None,
                            reason: reason_from_body(reply.error_body.as_deref()),
                            label: None,
                        },
                        &candidate,
                    ),
                }
            }
        };

        // Read before the push, because an outcome is no longer `Copy` — it carries its label.
        let (cls, retry_after_ms) = (outcome.cls, outcome.retry_after_ms);
        health.record_result(&candidate.key.id, cls, retry_after_ms, now_ms());
        attempts.push(outcome);
        // `:189-191`'s `finally` is the `Permit`'s `Drop` here — on this path, on the `return`
        // above, and on a panic alike. There is nothing to remember to call.
    }

    Err(AllAttemptsFailed::new(args.model, attempts))
}

/// Wall-clock milliseconds. A private copy, matching the eight other modules that each carry one
/// (`persist.rs:22`, `capture.rs:108`, …) — this crate has no shared clock.
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// `AllAttemptsFailedError` — every candidate the budget allowed was tried, and none served.
///
/// The chain is carried rather than summarised: it is both what `min_retry_after_ms` folds and
/// what `describe` names, and a caller that wants only the wait still gets it from the same list.
///
/// Deliberately a plain data type rather than an `Error` impl. This crate's error type is
/// `core::error::CommandError`, which exists to carry a message to the webview; coupling the
/// ported arithmetic to that would make it untestable without the crate's surface, for no gain —
/// the bridge converts at the boundary anyway.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AllAttemptsFailed {
    /// The model the caller asked for, as the caller named it.
    pub model: String,
    /// Every attempt that failed, in the order they were tried.
    pub chain: Vec<AttemptOutcome>,
}

impl AllAttemptsFailed {
    pub fn new(model: impl Into<String>, chain: Vec<AttemptOutcome>) -> Self {
        Self { model: model.into(), chain }
    }

    /// The shortest wait any attempt named; `0` when none named one.
    ///
    /// **Delegates, deliberately.** The TypeScript spells this fold twice — once as
    /// `minRetryAfterMs` on the error (`execution-engine.ts:220-227`) and once as the same loop
    /// in the engine's own reporting — and two spellings of one floor is how the floor drifts.
    /// Here there is one arithmetic with two entry points, and
    /// `the_error_reports_the_same_wait_as_the_free_fold` is what keeps it that way.
    pub fn min_retry_after_ms(&self) -> u64 {
        min_retry_after_ms(&self.chain)
    }

    /// The message the TypeScript builds. **The gap this carried since increment 4 is closed.**
    ///
    /// The TypeScript names each attempt `<provider.slug>/<key.label>:<cls>`
    /// (`execution-engine.ts:199`), and that is exactly what an outcome carrying an
    /// [`AttemptLabel`] renders. An outcome with **no** label renders as the class and the status
    /// instead — the spelling this function used while the label did not exist. That path is now
    /// unreachable from either of the engine's loops (they label every outcome they push), so it
    /// is a statement about a caller-built chain rather than a second rule: a chain that cannot
    /// name its attempts says so, and does not forge a name to fill the space.
    pub fn describe(&self) -> String {
        // The reason rides in the entry when a provider gave one — `[p1/k1:BAD_REQUEST_SCHEMA
        // (content-blocked: …)]` instead of a bare class token that named our request, not theirs.
        // Mirrors `execution-engine.ts`'s AllAttemptsFailedError, which does the same.
        let detail = self
            .chain
            .iter()
            .map(|a| match (&a.label, &a.reason) {
                (Some(l), Some(r)) => {
                    format!("{}/{}:{} ({})", l.provider_slug, l.key_label, a.cls.as_str(), r)
                }
                (Some(l), None) => {
                    format!("{}/{}:{}", l.provider_slug, l.key_label, a.cls.as_str())
                }
                (None, _) => format!("{}:{}", a.cls.as_str(), a.status),
            })
            .collect::<Vec<_>>()
            .join(" -> ");
        // The TypeScript's `detail || "empty plan"`. An empty chain is a real state — reached
        // whenever the budget is zero — and rendering it as `[]` would read as a bug rather than
        // as a budget.
        let detail = if detail.is_empty() { "empty plan".to_string() } else { detail };
        format!("all attempts failed for {} [{}]", self.model, detail)
    }
}

// ---------- the text loop over the same plan ----------

/// What one text request is asked to do. The Rust port of `executeText`'s argument
/// (`execution-engine.ts:23-39`).
///
/// **The plan is taken by value, like the image path's** — the serving candidate is returned to the
/// caller, and moving it out of the plan is how that is done without cloning three rows.
///
/// **The payloads are owned here and borrowed by `TextArgs`, and that asymmetry is deliberate.**
/// This struct is built once per request; `core::adapter::TextArgs` is built once per *attempt*, so
/// the borrow is what keeps a retry from deep-copying the conversation. See `TextArgs`' own note.
///
/// **The two callbacks are the caller's own.** `on_tool_call` is passed through untouched (`:97`);
/// `on_usage` is *wrapped*, because the engine must record the counts as well as forward them.
pub struct ExecuteTextArgs<'a> {
    pub plan: Vec<Candidate>,
    pub messages: Vec<Value>,
    /// The model the caller asked for, as the caller named it — carried so a failure can name it.
    /// The candidate's own `model.native_id` is what is actually sent.
    pub model: String,
    pub stream: bool,
    pub max_tokens: Option<u64>,
    pub temperature: Option<f64>,
    /// How much the model should think — forwarded untouched to the adapter's render.
    pub reasoning: Option<ReasoningEffort>,
    pub tools: Option<Value>,
    pub tool_choice: Option<Value>,
    pub response_format: Option<Value>,
    pub on_tool_call: Option<&'a mut (dyn FnMut(ToolCall) + Send)>,
    pub on_usage: Option<&'a mut (dyn FnMut(UsageTokens) + Send)>,
    /// Forwarded untouched, like `on_tool_call` — the finish reason mapped to the OpenAI vocabulary.
    pub on_finish: Option<&'a mut (dyn FnMut(Option<String>) + Send)>,
    /// Forwarded untouched, like `on_finish` — the model's reasoning, as it streams. Kept out of the
    /// chunk stream and out of the disposition entirely: reasoning is not delivered output, so a
    /// stream that carries only reasoning is still a drained stream for every classification.
    pub on_reasoning: Option<&'a mut (dyn FnMut(&str) + Send)>,
    pub max_attempts: Option<usize>,
    /// Mark the last system message block with `cache_control` on egress. See
    /// [`crate::core::router::TextRequest::prompt_cache_enabled`] for the read-side note.
    pub prompt_cache_enabled: bool,
}

/// A served text request. The Rust port of the three readers on `TextExecution`
/// (`execution-engine.ts:41-47`): `served()`, `fallbackChain()`, `usage()`.
#[derive(Debug)]
pub struct TextSuccess {
    /// The candidate that served it, set once the first chunk reached the sink (`:100-103`).
    pub candidate: Candidate,
    /// Every attempt that failed before this one succeeded, in the order they were tried.
    pub attempts: Vec<AttemptOutcome>,
    /// Whatever the upstream reported, if it reported anything at all.
    pub usage: Option<UsageTokens>,
    /// What the stream carried, when it delivered nothing — the drained arm's only evidence, and
    /// the difference between "the provider streamed nothing" and "it streamed a shape the
    /// manifest cannot read". `None` whenever output was delivered.
    ///
    /// Boxed: `TextSuccess` is compared against `ImageSuccess` by size in the test below, and a
    /// 48-byte inline field tipped it over — the guard doing precisely what it exists for.
    pub observation: Option<Box<StreamObservation>>,
}

/// A text request that produced no successful stream — and the state the caller can still read.
///
/// **The attempts and the usage ride on the failure, because the TypeScript leaves them readable
/// after the throw.** `executeText` returns the `TextExecution` object *before* `chunks` is
/// iterated, so `model-router.ts`'s `catch` reads `exec.served()`, `exec.fallbackChain()` and
/// `exec.usage()` on the failing path (`:488`, `:517-519`) and writes all three to the ledger. A
/// `Result` whose error carried only a message would drop them on the floor.
///
/// **The variants encode which of those are possible, which is why this is three variants and not
/// one struct with an `Option<Candidate>`.** A mid-stream break can only happen after a chunk has
/// reached the sink, so it always carries the serving candidate; cancellation and exhaustion only
/// happen with nothing served, so they do not carry one at all. An `Option` would make "cancelled,
/// yet somehow served" representable.
/// **`large_enum_variant`, and the measurement is why.** `MidStream` carries a whole `Candidate`
/// (536 bytes), which makes it the largest variant at 616 bytes against `TextSuccess`'s 592 — but
/// the `Result` is ~600 bytes either way, because *both* arms carry that payload by value. Boxing
/// `served` would save 16 of those 616 bytes and add a heap allocation to every failure. The image
/// path is the control: the same 536-byte `Candidate` in its `Ok`, a 48-byte `Err` clippy never
/// mentions, and a 608-byte `Result`. See
/// `the_text_results_size_comes_from_the_payload_not_from_the_error`, which fails if that stops
/// being true.
#[allow(clippy::large_enum_variant)]
#[derive(Debug)]
pub enum TextFailure {
    /// The break arrived after the sink already held text (`:112-116`).
    ///
    /// **The original adapter error is carried, not a classification.** The TypeScript rethrows `e`
    /// itself (`:115`), and that is deliberate rather than incidental: the consumer already has
    /// output, so what it needs is the error itself — re-running the attempt would show it the text
    /// twice. The classification is not lost; it is in `attempts`.
    MidStream {
        error: AttemptError,
        served: Candidate,
        attempts: Vec<AttemptOutcome>,
        usage: Option<UsageTokens>,
    },
    /// Cancellation ended the loop before any chunk reached the sink (`:80`, `:133`).
    ///
    /// **Not a failure in the TypeScript.** It `return`s from the generator, so no
    /// `AllAttemptsFailedError` is raised and the caller sees an empty stream — which is why this is
    /// a variant rather than an empty `Ok`: `Ok` with no candidate would be two spellings of one
    /// state, and the caller writes a different ledger row for each (`:451`).
    Cancelled { attempts: Vec<AttemptOutcome>, usage: Option<UsageTokens> },
    /// Nothing reached the sink and the budget was spent (`:141-143`).
    AllAttemptsFailed { error: AllAttemptsFailed, usage: Option<UsageTokens> },
}

/// Try each candidate in the plan until one streams to `on_chunk`. The Rust port of `executeText`
/// (`execution-engine.ts:68-152`).
///
/// **The sink is this increment's one shape decision, and it is a deviation from the source.** The
/// TypeScript returns `TextExecution { chunks: AsyncGenerator }` — a *pull* stream the caller
/// iterates. This takes `on_chunk` and runs to completion instead. Two reasons:
///
/// 1. **The source's generator is not a plain generator.** `yield chunk` sits inside an
///    `await`-driven retry loop, so a pull port would have to express "await the factory, then await
///    `generate_text`, then poll its stream, then decide whether to retry" as a hand-written state
///    machine — there is no `async-stream` dependency in this crate and this port may not add one.
///    Here every `await` is a real `await` and every `yield` is a call, so the loop is a
///    transcription rather than a re-derivation.
/// 2. **A pull port cannot report plan exhaustion honestly.** The source *throws*
///    `AllAttemptsFailedError` from inside the generator (`:141-143`), which a
///    `BoxStream<Item = Result<String, AttemptError>>` has no room for. The alternatives are to widen
///    the item type, or to leave the caller to infer exhaustion from an empty stream — and the second
///    is how a failed request becomes a `200` with no body.
///
/// The cost is stated rather than hidden: **a caller can no longer stop early by not draining.** It
/// cancels instead, which the loop honours at `:80` and `:133` — an explicit signal in place of an
/// implicit one, and the same mechanism the source already relies on.
///
/// **A chunk reaches the sink as it arrives, and the sink owns it from there.** `&str` rather than
/// `String` so a caller that only writes it out does not copy.
///
/// **The failure handling is not re-derived.** `attempt_disposition`, `attempt_outcome` and
/// `records_key_health` (increment 6) are the loop's whole classification policy, and they reproduce
/// `:112-133` exactly: `emitted` alone decides whether a break can be retried, a rethrown failure
/// carries no retry hint and does not cool its key, and the abort check comes *after* the record so
/// a cancelled attempt still lands in the chain.
///
/// **The loop cannot end having served, and the structure is what makes that true.** The source
/// guards its terminal throw with `if (!served)` (`:141`), which is defensive: a served attempt
/// returns at `:107`, so the loop can only fall through with nothing served. Here the success
/// `return` is inside the iteration, so there is no guard to get wrong.
///
/// **`result_large_err`, and the measurement is the reason.** The lint sees a 616-byte `Err` and
/// proposes boxing it. But the `Ok` type is 592 bytes carrying the same 536-byte `Candidate`, so the
/// `Result` is ~600 bytes either way and the box would buy 16 of them at the cost of a heap
/// allocation on every failure. `gateway.rs:1402` allows this lint on `try_slot` for the same shape
/// of reason: the lint's premise — a large error paid on the happy path — does not hold. The
/// arithmetic is asserted by `the_text_results_size_comes_from_the_payload_not_from_the_error`.
#[allow(clippy::result_large_err)]
pub async fn execute_text(
    adapters: &dyn AdapterFactory,
    health: &HealthTracker,
    limiter: Option<&ProviderLimiter>,
    mut args: ExecuteTextArgs<'_>,
    cancel: &Cancel,
    on_chunk: &mut (dyn FnMut(&str) + Send),
) -> Result<TextSuccess, TextFailure> {
    let mut attempts: Vec<AttemptOutcome> = Vec::new();
    let mut usage: Option<UsageTokens> = None;
    let budget = attempt_budget(args.plan.len(), args.max_attempts);

    // How the loop stopped. It cannot return directly, because `usage` is written by a callback the
    // adapter may hold for as long as its stream lives — so a read *inside* the body would sit
    // inside that borrow, and the borrow checker is right to refuse it: a closure created in a loop
    // body keeps its captures borrowed for the whole body. The loop `break`s with an outcome
    // instead, and every reader lives after it — which is also where the TypeScript's readers are,
    // on the object it returned *before* the throw.
    enum Ended {
        /// A candidate streamed to the sink (`:107`). The observation rides along only when the
        /// stream delivered nothing — the drained arm is where the ledger needs it, and on any
        /// other success the output itself is the answer to "what did the provider send".
        Served { candidate: Candidate, observation: Option<Box<StreamObservation>> },
        /// The break arrived after the sink already held text (`:112-116`).
        MidStream { error: AttemptError, served: Candidate },
        /// Cancellation stopped the loop (`:80`, `:133`).
        Cancelled,
        /// The budget was spent with nothing served (`:141-143`).
        Spent,
    }

    // The plan's own clock, and the flag that keeps the *first attempted* candidate exempt from the
    // budget. Stamped here rather than in the caller because this is the layer that knows how many
    // candidates there are — see `PLAN_BUDGET`.
    let plan_started = Instant::now();
    let mut attempted_any = false;

    let ended = 'plan: {
        for candidate in args.plan.into_iter().take(budget) {
            // `:80`, checked *before* the permit is taken — see `candidate_gate`, which states the
            // order and why: a cancelled request must not consume a slot on its way out.
            if cancel.is_cancelled() {
                break 'plan Ended::Cancelled;
            }
            // `:83-87`. `acquire` is the check *and* the increment. `None` from `limiter` is no
            // limiter at all; `None` from `acquire` is a saturated provider — told apart by
            // `limiter.is_some()`.
            let release = limiter.and_then(|l| l.acquire(&candidate.provider.id));
            if limiter.is_some() && release.is_none() {
                attempts.push(labelled(saturated_outcome(), &candidate));
                continue;
            }

            // **The plan-level admission check, and it sits after the saturation skip on purpose.**
            // A candidate the limiter skipped was never contacted and cost nothing, so it must not
            // consume the first-attempt exemption — otherwise a saturated first provider would make
            // the second one subject to a budget it never spent.
            //
            // Ending as `Spent` rather than `Cancelled` is the point: it carries the attempt chain,
            // so the router records the class the attempts actually produced. Letting the request
            // run on instead would let the gateway's bound fire first and file the row as
            // `CANCELLED` — which is what made rows 1652/1655/1656/1658 look like client aborts.
            if !candidate_is_affordable(plan_started.elapsed(), !attempted_any) {
                break 'plan Ended::Spent;
            }
            attempted_any = true;

            // `:90` — a factory rejection lands in the same `catch` as a thrown `generateText`,
            // where it is not a `ManifestHttpError`, so it is `NETWORK`/`0` with no wait.
            let adapter = match adapters.for_provider(&candidate.provider.id).await {
                Ok(adapter) => adapter,
                Err(_) => {
                    let outcome = labelled(transport_outcome(), &candidate);
                    // Read before the push: an outcome carries its label and is no longer `Copy`.
                    let (cls, retry_after_ms) = (outcome.cls, outcome.retry_after_ms);
                    health.record_result(&candidate.key.id, cls, retry_after_ms, now_ms());
                    attempts.push(outcome);
                    if cancel.is_cancelled() {
                        break 'plan Ended::Cancelled;
                    }
                    continue;
                }
            };

            // **`emitted` is chunk-only, and a tool call is output too.** A break after a tool call
            // was delivered cannot be retried either — the consumer holds a tool call, not partial
            // text, but the next candidate re-issuing it would be just as wrong. `tool_calls` counts
            // what `forward_tool` delivered, and the predicate below folds them: a delivered tool
            // call ends failover just as a delivered chunk does.
            let mut emitted = false;
            let mut tool_calls = 0usize;
            let mut broke: Option<AttemptError> = None;
            // What this attempt's stream carried. Reset per attempt so the evidence always names
            // the candidate the row will blame; read only on the drained arm in `write_text_ledger`.
            let mut observation = StreamObservation::default();
            let refused = {
                // `:97` — the engine's own `onUsage` does double duty: it fills the box the ledger
                // reads, and it forwards to the caller's callback. Dropping the caller's here is how
                // every gateway response came to report `usage: null` on requests that had usage.
                let mut caller_on_usage = args.on_usage.as_deref_mut();
                let mut record_usage = |u: UsageTokens| {
                    usage = Some(u);
                    if let Some(cb) = caller_on_usage.as_deref_mut() {
                        cb(u);
                    }
                };
                // **`forward_tool` exists to give the borrow a local to live in, and that is not a
                // stylistic choice.** Handing the seam `args.on_tool_call.as_deref_mut()` directly
                // does not compile: the reference taken off that field carries the field's declared
                // object lifetime, rustc resolves the seam's callback lifetime to *it* rather than
                // to a shorter subregion, and the borrow is then required to outlive `execute_text`
                // itself — `E0499` on the next iteration, `E0597` at the end of the function. A
                // local closure makes the referent a local, whose borrow ends with the iteration.
                //
                // **This was measured, and the first diagnosis was wrong.** The obvious reading is
                // that `TextArgs` needs two lifetimes — payloads for the request, callbacks for the
                // attempt. Splitting them changes nothing; a 60-line reproduction (`/tmp`) shows the
                // same four errors either way, and a single `'a` compiles the moment this closure
                // exists. So the seam did not need changing and the call site did.
                let mut caller_on_tool_call = args.on_tool_call.as_deref_mut();
                let mut forward_tool = |tc: ToolCall| {
                    tool_calls += 1;
                    if let Some(cb) = caller_on_tool_call.as_deref_mut() {
                        cb(tc);
                    }
                };
                // The same local-closure shape as `forward_tool`, for the same documented reason: the
                // reference taken off the field directly would carry the field's declared lifetime.
                let mut caller_on_finish = args.on_finish.as_deref_mut();
                let mut forward_finish = |reason: Option<String>| {
                    if let Some(cb) = caller_on_finish.as_deref_mut() {
                        cb(reason);
                    }
                };
                // The same shape again, and deliberately NOTHING beside the forward: no counter, no
                // `emitted`, no disposition. Reasoning is not delivered output — a stream that only
                // reasoned is still a drained stream (`NO_OUTPUT` when the observation says it
                // reasoned), and the pass-through consumer renders what it receives without that
                // changing what the turn was.
                let mut caller_on_reasoning = args.on_reasoning.as_deref_mut();
                let mut forward_reasoning = |text: &str| {
                    if let Some(cb) = caller_on_reasoning.as_deref_mut() {
                        cb(text);
                    }
                };
                let text_args = TextArgs {
                    model: candidate.model.native_id.clone(),
                    messages: &args.messages,
                    stream: args.stream,
                    max_tokens: args.max_tokens,
                    temperature: args.temperature,
                    reasoning: args.reasoning,
                    tools: args.tools.as_ref(),
                    tool_choice: args.tool_choice.as_ref(),
                    response_format: args.response_format.as_ref(),
                    on_tool_call: Some(&mut forward_tool),
                    on_usage: Some(&mut record_usage),
                    on_finish: Some(&mut forward_finish),
                    on_reasoning: Some(&mut forward_reasoning),
                    prompt_cache_enabled: args.prompt_cache_enabled,
                    observation: Some(&mut observation),
                };

                // **The `let` is load-bearing, not stylistic.** `Result<BoxStream<…>, _>` is a
                // temporary that holds the callbacks' borrow, and the stream inside it borrows
                // `record_usage` and `forward_tool` by name. As this block's *tail expression* its
                // destructor would run after those locals are dropped — `E0597`, "borrowed value does
                // not live long enough", with the compiler pointing at the whole `match`. Binding the
                // result first drops the temporary at the end of this statement, which is before the
                // locals and after the stream has been drained.
                let refusal =
                    match adapter.generate_text(&candidate.key.secret_ref, text_args, cancel).await
                    {
                        // The response phase refused: nothing reached the sink, so this attempt is
                        // retryable and the loop classifies it below.
                        Err(e) => Some(e),
                        Ok(mut stream) => {
                            while let Some(item) = stream.next().await {
                                match item {
                                    Ok(chunk) => {
                                        // `:100-103`. Only the flag is needed: the candidate is the loop
                                        // variable, so `served` is carried out rather than cloned.
                                        emitted = true;
                                        on_chunk(&chunk);
                                    }
                                    Err(e) => {
                                        broke = Some(e);
                                        break;
                                    }
                                }
                            }
                            None
                        }
                    };
                refusal
            };

            // One handler for both failure shapes, because `attempt_disposition` is what tells them
            // apart — a delivered chunk or tool call is its whole input, and it is the predicate
            // increment 6 pinned (and generalised to tool calls here).
            if let Some(e) = refused.or(broke) {
                let disposition =
                    attempt_disposition(emitted || tool_calls > 0, cancel.is_cancelled());
                let outcome = labelled(attempt_outcome(&e, disposition), &candidate);
                if records_key_health(disposition) {
                    let (cls, retry_after_ms) = (outcome.cls, outcome.retry_after_ms);
                    health.record_result(&candidate.key.id, cls, retry_after_ms, now_ms());
                }
                attempts.push(outcome);
                match disposition {
                    // Only reachable when something was delivered — a chunk (`emitted`) or a tool
                    // call — so `served` is this candidate. The original error travels, not the
                    // class.
                    AttemptDisposition::Rethrow => {
                        if !emitted && tool_calls > 0 {
                            tracing::info!(
                                tool_calls,
                                "rethrow on a tool call alone — failover ended, not advanced",
                            );
                        }
                        break 'plan Ended::MidStream { error: e, served: candidate };
                    }
                    AttemptDisposition::Stop => break 'plan Ended::Cancelled,
                    AttemptDisposition::Next => continue,
                }
            }

            // `:106-107` — the stream ended and the attempt served, so the loop stops rather than
            // advancing. This is why the source's `if (!served)` guard has nothing to guard.
            let drained = !(emitted || tool_calls > 0);
            let observation = if drained { Some(Box::new(observation)) } else { None };
            // **The attempt is recorded, because an attempt happened.** The chain held only
            // failures, so a provider that answered 200 and streamed thousands of events while
            // producing nothing left no trace in it — and the chain then read as if the model had
            // never been tried. The status is 200 because that is what the provider returned: this
            // is not a failed request, it is a request that was answered and whose answer was not
            // usable. Deliberately NOT a reason to advance to the next candidate — the plan has
            // already run, and changing that is a behaviour decision, not bookkeeping. Key health
            // still says OK below, because the key and the provider did their job.
            if drained {
                attempts.push(labelled(
                    AttemptOutcome {
                        cls: ErrorClass::NoOutput,
                        status: 200,
                        retry_after_ms: None,
                        reason: None,
                        label: None,
                    },
                    &candidate,
                ));
            }
            break 'plan Ended::Served { candidate, observation };
        }
        Ended::Spent
    };

    match ended {
        Ended::Served { candidate, observation } => {
            health.record_result(&candidate.key.id, ErrorClass::Ok, None, now_ms());
            Ok(TextSuccess { candidate, attempts, usage, observation })
        }
        Ended::MidStream { error, served } => {
            Err(TextFailure::MidStream { error, served, attempts, usage })
        }
        Ended::Cancelled => Err(TextFailure::Cancelled { attempts, usage }),
        // The only way the loop can fall through: nothing was served. A served attempt breaks with
        // `Ended::Served` above.
        Ended::Spent => Err(TextFailure::AllAttemptsFailed {
            error: AllAttemptsFailed::new(args.model, attempts),
            usage,
        }),
    }
}

/// Consecutive auth failures before a key is treated as invalid rather than merely unlucky.
pub const AUTH_BREAKER_THRESHOLD: u32 = 3;

/// How long an open auth breaker excludes its key before one re-probe is allowed.
///
/// **A breaker with no half-open state is a permanent exclusion, and that was this crate's
/// behaviour until now.** [`KeyHealth::breaker_open_at`] was cleared *only* by an
/// [`ErrorClass::Ok`], and an open breaker meant the key was never tried again — so no `Ok` could
/// ever arrive to clear it. A credential rotated back into service, or an upstream that had a bad
/// five minutes, stayed dead to the router for the life of the process. This window bounds that:
/// past it the key is admissible again, and the next attempt decides — an `Ok` clears the breaker,
/// an `AuthFailed` re-stamps it and excludes the key for another window. A genuinely revoked key
/// therefore costs **one** `401` per window rather than one per request.
///
/// **The re-probe is safe because an auth failure is retryable with the next key** — see
/// [`is_retryable_with_next_key`], which lists [`ErrorClass::AuthFailed`]. The cost of admitting a
/// dead key is one wasted attempt, not a failed request.
///
/// One minute: long enough that a revoked credential is not sampled per request, short enough that
/// a credential restored by an operator comes back without restarting the daemon. **The breaker is
/// a heuristic layered on the persisted `status` column** — the way to exclude a key permanently is
/// `status = "disabled"`, which is [`KeyBlock::Denied`] and is genuinely not on a clock.
pub const BREAKER_HALF_OPEN_MS: u64 = 60_000;

/// The key statuses that make a key unusable outright.
///
/// **This is a deny-list, and that is load-bearing.** [`HealthTracker::is_key_usable`] rejects
/// these two and accepts *everything else*, including a status string this code has never seen. A
/// key left at `"pending"` is therefore tried. The TypeScript behaves the same way, and its
/// polarity is the **opposite** of the provider check below — a reader who assumes one rule for
/// both gets it backwards in one direction or the other.
const KEY_STATUS_DENIED: [&str; 2] = ["disabled", "invalid"];

/// The one provider status that makes a provider usable. An **allow-list**, unlike the key check.
const PROVIDER_STATUS_ENABLED: &str = "enabled";

/// Per-key circuit state. Every time is epoch **milliseconds**.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct KeyHealth {
    /// Epoch ms; `0` means ready.
    pub cooldown_until_ms: i64,
    /// Reset to zero by any `Ok`, because the breaker counts *consecutive* failures.
    pub consecutive_auth_failures: u32,
    /// When the auth breaker opened, epoch ms — `None` while it is closed.
    ///
    /// **The moment rather than a flag, and that is what bounds the exclusion.** A `bool` plus a
    /// separate `opened_at` would be two fields that must agree, and the pair has a state the flag
    /// cannot describe on its own: open, with no idea when it started. Storing the moment makes
    /// that state unrepresentable, and it is the moment — not the flag — that
    /// [`HealthTracker::key_block`] reads, so the half-open window cannot be defeated by a missing
    /// stamp. See [`BREAKER_HALF_OPEN_MS`].
    pub breaker_open_at: Option<i64>,
}

/// Why a key cannot be tried right now.
///
/// **The variant is what decides whether waiting is worth anything**, which is why this is an enum
/// and not a `bool`. `Cooling` carries the moment the key comes back, so a caller can sleep exactly
/// that long; `Denied` and `Breaker` carry nothing, and they carry nothing for **different**
/// reasons — which is the distinction a single `bool` would lose. `Denied` is permanent, because
/// the persisted status is a decision an operator made. `Breaker` is not permanent: it expires
/// after [`BREAKER_HALF_OPEN_MS`], but on a scale of minutes, so it is still not something a
/// request should sleep on — the right answer to a dead credential is to fail over to the next key,
/// which [`is_retryable_with_next_key`] permits. A caller that could not tell the three apart would
/// either give up on a key that was about to be free, or wait on one that would not be free in time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum KeyBlock {
    /// The persisted status is `disabled` or `invalid`. Waiting does not help, ever.
    Denied,
    /// Too many consecutive auth failures, inside the half-open window. Waiting does not help
    /// *in time*; the key returns after [`BREAKER_HALF_OPEN_MS`].
    Breaker,
    /// A cooldown that expires at this epoch-ms. Waiting **is** the remedy.
    Cooling(i64),
}

/// Per-key and per-provider circuit state, kept free of I/O so failover ordering can be tested
/// against it (TS `health-tracker.ts`).
///
/// **Interiorly mutable, and that is what makes a concurrent bridge possible.** This tracker is
/// process-wide state — one breaker, one cooldown per key — so every request must see the same one.
/// The engine used to take `&mut HealthTracker` and hold it for the whole of a request, which made
/// "two requests at once" unrepresentable: the borrow checker forced the caller to serialise, and
/// the serialisation stayed invisible until something tried to serve two clients. A `Mutex` inside
/// the type, rather than a `&mut` at the boundary, keeps the sharing honest — and the lock is taken
/// per *record*, never across an `await`, because every method here is synchronous.
///
/// The `Mutex` is never observed poisoned: `panic = "abort"` (`Cargo.toml`), so a panic that held
/// this lock does not unwind past it. `.lock().unwrap()` is therefore this crate's existing
/// convention rather than a new bet.
#[derive(Debug, Default)]
pub struct HealthTracker {
    keys: Mutex<HashMap<String, KeyHealth>>,
}

impl HealthTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Why `key` cannot be tried at `now_ms`, or `None` when it can.
    ///
    /// **One spelling of the rule, two readers.** [`Self::is_key_usable`] asks "may I try it" and
    /// [`Self::key_retry_at`] asks "when may I try it again" — and the second is only answerable
    /// for [`KeyBlock::Cooling`]. Two independent predicates would be two spellings of one rule,
    /// which is the defect this crate keeps finding; they are derived from this one instead.
    fn key_block(&self, key: &ApiKeyRow, now_ms: i64) -> Option<KeyBlock> {
        if KEY_STATUS_DENIED.contains(&key.status.as_str()) {
            return Some(KeyBlock::Denied);
        }
        // A read must not create an entry. The TypeScript `health()` inserts on read, which grows
        // the map for every key ever *considered*; the answer is identical either way, because an
        // absent entry means default health.
        let h = self.keys.lock().unwrap().get(&key.id).copied().unwrap_or_default();
        // **Half-open: an open breaker excludes the key for one window, then admits it again.**
        // See [`BREAKER_HALF_OPEN_MS`]. Past the window this *falls through* rather than returning,
        // so the key is tried once more — and that attempt decides the breaker's fate: an `Ok`
        // clears it, an `AuthFailed` re-stamps it and excludes the key for another window. The
        // alternative, an unbounded `if h.breaker_open { return .. }`, is a latch: nothing but an
        // `Ok` could clear it, and an open breaker means no `Ok` is ever attempted.
        if let Some(opened_at) = h.breaker_open_at {
            // `saturating_add` rather than `+`: the stamp is wall-clock derived, so a clock step
            // could make the sum exceed `i64::MAX` — and that is a panic in a debug build, on the
            // path that decides whether a request may proceed. Saturating excludes the key instead.
            if now_ms < opened_at.saturating_add(BREAKER_HALF_OPEN_MS as i64) {
                return Some(KeyBlock::Breaker);
            }
        }
        // **The tracker's cooldown and the row's own `cooldown_until` are two different fields**,
        // and the later of the two is when the key is actually free again. Taking the max rather
        // than checking them separately keeps `is_key_usable`'s answer and `key_retry_at`'s time
        // from disagreeing about which one is in force.
        let until = h.cooldown_until_ms.max(key.cooldown_until.unwrap_or(0));
        (until > now_ms).then_some(KeyBlock::Cooling(until))
    }

    /// Whether `key` may be tried at `now_ms`.
    ///
    /// Four independent ways to be unusable, deliberately separate: the persisted status, this
    /// tracker's breaker, this tracker's cooldown, and the key record's **own** `cooldown_until` —
    /// a different field from the in-memory one, and currently unreachable. See
    /// `a_key_cooldown_on_the_record_is_honoured`.
    pub fn is_key_usable(&self, key: &ApiKeyRow, now_ms: i64) -> bool {
        self.key_block(key, now_ms).is_none()
    }

    /// When `key` becomes tryable again, if a cooldown is the **only** reason it is not now.
    ///
    /// **`None` is the load-bearing answer, and it means "do not wait on this key".** It covers
    /// three cases: the key is usable already; its status is `disabled`/`invalid`; or its auth
    /// breaker is open. `Denied` is permanent — no clock clears it, so a caller that slept on it
    /// would sleep until the gateway gave up. **`Breaker` is different, and the difference is the
    /// point**: it *does* expire now, but after [`BREAKER_HALF_OPEN_MS`], which is minutes against a
    /// request's seconds — so waiting for it is still the wrong answer and failing over to the next
    /// key is still the right one. Only a genuine cooldown yields a time, and that time is strictly
    /// greater than `now_ms`, so a caller looping on this answer is guaranteed to make progress
    /// rather than spin.
    pub fn key_retry_at(&self, key: &ApiKeyRow, now_ms: i64) -> Option<i64> {
        match self.key_block(key, now_ms) {
            Some(KeyBlock::Cooling(until)) => Some(until),
            _ => None,
        }
    }

    /// Whether `provider` may be tried at all. An allow-list: only `"enabled"` passes.
    pub fn is_provider_usable(provider: &ProviderRow) -> bool {
        provider.status == PROVIDER_STATUS_ENABLED
    }

    /// Record what an attempt did to `key_id`'s health.
    ///
    /// `retry_after_ms` is what the provider asked us to wait, and the cooldown is floored at
    /// [`COOLDOWN_FLOOR_MS`] — the same constant [`min_retry_after_ms`] uses, so the wait enforced
    /// and the wait reported are one number rather than two 1000s free to drift apart.
    ///
    /// `&self`, not `&mut self`: the tracker is shared, so a request records through it rather than
    /// owning it. See the type's note for why that is the shape a concurrent bridge needs.
    pub fn record_result(
        &self,
        key_id: &str,
        cls: ErrorClass,
        retry_after_ms: Option<u64>,
        now_ms: i64,
    ) {
        let mut keys = self.keys.lock().unwrap();
        let h = keys.entry(key_id.to_string()).or_default();
        match cls {
            ErrorClass::Ok => {
                // Taken rather than cleared so the recovery can be *observed*: a key that was
                // excluded by a breaker and has just served a request is the one event that proves
                // the half-open window did its job, and it is otherwise indistinguishable from a
                // key that was never blocked at all.
                let recovered = h.breaker_open_at.take();
                h.consecutive_auth_failures = 0;
                h.cooldown_until_ms = 0;
                if recovered.is_some() {
                    tracing::info!(key_id = key_id, "auth breaker cleared by a successful re-probe");
                }
            }
            ErrorClass::RateLimited => {
                let wait = retry_after_ms.unwrap_or(0).max(COOLDOWN_FLOOR_MS);
                h.cooldown_until_ms = now_ms + wait as i64;
                // **A 429 says nothing about the credential, so a half-open breaker stays
                // half-open.** The key is cooled but its stamp is left alone, which is what makes
                // the two readers agree: the key is unusable *now* (cooling) yet not re-armed, so
                // the next attempt — not this rate limit — decides the breaker.
            }
            ErrorClass::AuthFailed => {
                h.consecutive_auth_failures += 1;
                if h.consecutive_auth_failures >= AUTH_BREAKER_THRESHOLD {
                    // **Stamped on every failure past the threshold, not only on the transition.**
                    // A half-open re-probe that fails again must re-arm the window; if the stamp
                    // were written only when the breaker first opened, the key would be admitted on
                    // every request from then on — the latch traded for the opposite defect.
                    let re_armed = h.breaker_open_at.is_some();
                    h.breaker_open_at = Some(now_ms);
                    // The event is otherwise invisible: without this line "the breaker just
                    // excluded this key" and "the key was already excluded" leave the same trace,
                    // which is none. `re_armed` is what distinguishes a dead credential from a
                    // fresh one, and it is the only place that distinction is recorded.
                    tracing::warn!(
                        key_id = key_id,
                        failures = h.consecutive_auth_failures,
                        re_armed = re_armed,
                        "auth breaker opened; the key is excluded for one half-open window"
                    );
                }
            }
            // Everything else leaves key health alone, and this arm is *explicit* on purpose. The
            // TypeScript spells it as `else if (!isRetryableWithNextKey(cls)) return;`, which is a
            // no-op: the classes it names would fall through to the same "do nothing" anyway, and
            // SERVER_ERROR, NETWORK and TIMEOUT are not named by it at all yet still reach it.
            // Listing them exhaustively keeps the cases that change nothing visible instead of
            // implied by an absent branch.
            ErrorClass::NotFound
            | ErrorClass::BadRequestSchema
            | ErrorClass::ParseError
            // The provider honoured its contract and the model never wrote an answer — nothing here
            // is evidence against the credential, and counting it would cool a healthy key for a
            // request-side cause.
            | ErrorClass::NoOutput
            | ErrorClass::ServerError
            | ErrorClass::Timeout
            | ErrorClass::Network
            // A refusal by our own egress says nothing about the key — every key of a provider dials
            // the same host, so cooling this one would burn a good credential for a policy decision.
            | ErrorClass::EgressDenied
            // **The whole point of the class**: a client gate refused the caller without reading
            // any credential, so counting it here would open the breaker on a healthy key — the
            // exact defect `CLIENT_GATE` exists to prevent.
            | ErrorClass::ClientGate
            // A budget pool is per-provider, not per-key; rotating keys cannot refill it.
            | ErrorClass::Billing => {}
        }
    }

    /// Forget everything known about a key.
    pub fn reset_key(&self, key_id: &str) {
        self.keys.lock().unwrap().remove(key_id);
    }

    /// What is recorded about one key, or `None` when nothing has been.
    ///
    /// **`None` is not `Some(KeyHealth::default())`, and the distinction is the reason this returns
    /// an `Option`.** An absent entry and an entry whose every field sits at its default are
    /// different findings: the first means no attempt has touched this key, the second means
    /// attempts were recorded and changed nothing. [`HealthTracker::record_result`] inserts an entry
    /// even for the classes that leave health alone, so both states are reachable — and a caller
    /// that flattened them could not tell "never tried" from "tried, no effect".
    pub fn key_health(&self, key_id: &str) -> Option<KeyHealth> {
        self.keys.lock().unwrap().get(key_id).copied()
    }

    /// The raw map, for tests that assert on the shape of what was recorded.
    ///
    /// **Test-only on purpose.** Production readers want [`HealthTracker::key_health`], which
    /// answers the only question that exists outside a test — "what is recorded about this key?" —
    /// and does not hand out the map's own type. This exists because fourteen assertions in this
    /// module compare a whole `KeyHealth` or read one field off it, and rewriting each of them
    /// through `key_health(..).unwrap()` would be fourteen chances to change what is being asserted
    /// while claiming only to have moved it.
    #[cfg(test)]
    pub(crate) fn keys(&self) -> std::sync::MutexGuard<'_, HashMap<String, KeyHealth>> {
        self.keys.lock().unwrap()
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;
    use super::*;
    // Only the tests name the model row: the engine reads a candidate's `model.native_id` without
    // ever spelling the type, so importing it at the top would be unused in a non-test build.
    use crate::core::persist::ModelRow;

    fn outcome(cls: ErrorClass, status: u16, retry_after_ms: Option<u64>) -> AttemptOutcome {
        AttemptOutcome { cls, status, retry_after_ms, reason: None, label: None }
    }

    /// The same, with the identity the loops attach. Used by the `describe` tests, which are the
    /// only place a named chain is built by hand.
    fn named(
        slug: &str,
        key_label: &str,
        cls: ErrorClass,
        status: u16,
        retry_after_ms: Option<u64>,
    ) -> AttemptOutcome {
        AttemptOutcome {
            cls,
            status,
            retry_after_ms,
            label: Some(AttemptLabel {
                provider_slug: slug.to_string(),
                key_label: key_label.to_string(),
            }),
            reason: None,
        }
    }

    // ---- classify: the taxonomy table, ported from `errors.ts` -------------------------------

    #[test]
    fn classify_names_the_statuses_the_engine_rotates_on() {
        assert_eq!(classify(200, None), ErrorClass::Ok);
        assert_eq!(classify(204, None), ErrorClass::Ok);
        assert_eq!(classify(401, None), ErrorClass::AuthFailed);
        assert_eq!(classify(403, None), ErrorClass::AuthFailed);
        assert_eq!(classify(429, None), ErrorClass::RateLimited);
        assert_eq!(classify(404, None), ErrorClass::NotFound);
        assert_eq!(classify(408, None), ErrorClass::Timeout);
        assert_eq!(classify(500, None), ErrorClass::ServerError);
        assert_eq!(classify(503, None), ErrorClass::ServerError);
    }

    #[test]
    fn a_400_splits_on_the_body_between_a_bad_request_and_a_missing_model() {
        assert_eq!(classify(400, None), ErrorClass::BadRequestSchema);
        assert_eq!(classify(400, Some(BodyHint::Schema)), ErrorClass::BadRequestSchema);
        assert_eq!(classify(400, Some(BodyHint::NotFound)), ErrorClass::NotFound);
        // Both 400 variants are drift, so neither burns the key. They are still not the same
        // failure, and the chain reported to the client should say which one happened — which is
        // the whole reason the body is consulted rather than the status alone.
        assert!(classify(400, Some(BodyHint::NotFound)).is_drift());
        assert!(classify(400, Some(BodyHint::Schema)).is_drift());
        assert_ne!(classify(400, Some(BodyHint::NotFound)), classify(400, Some(BodyHint::Schema)));
    }

    #[test]
    fn an_unnamed_status_is_a_transport_failure_rather_than_a_guess() {
        // Pinned because it is a decision, not an accident: a 3xx redirect is "not named by this
        // taxonomy", and the TypeScript falls through to NETWORK for it. 402 left that bucket on
        // 2026-09-29 — a budget-pool answer is the provider speaking, not the transport failing —
        // and is pinned separately below.
        assert_eq!(classify(301, None), ErrorClass::Network);
        assert_eq!(classify(0, None), ErrorClass::Network);
    }

    #[test]
    fn a_client_gate_is_not_an_auth_failure_and_billing_is_not_a_network_fault() {
        // Measured 2026-09-29 on agentrouter.org: a 401 whose body names the client rotates
        // through every key of the provider and opens auth breakers on healthy keys, because none
        // of the keys is ever read. And a 402 counted a full budget pool against the provider's
        // network health.
        assert_eq!(classify(401, Some(BodyHint::ClientGate)), ErrorClass::ClientGate);
        assert_eq!(classify(403, Some(BodyHint::ClientGate)), ErrorClass::ClientGate);
        // without the body naming it, the status quo stands
        assert_eq!(classify(401, None), ErrorClass::AuthFailed);
        assert_eq!(classify(402, None), ErrorClass::Billing);
        // neither is drift (nothing about the provider changed) ...
        assert!(!ErrorClass::ClientGate.is_drift());
        assert!(!ErrorClass::Billing.is_drift());
        // ... and neither is retried with the next key (the client identity and the pool are
        // per-request facts, not per-key ones)
        assert!(!is_retryable_with_next_key(ErrorClass::ClientGate));
        assert!(!is_retryable_with_next_key(ErrorClass::Billing));
    }

    #[test]
    fn the_reason_is_the_providers_own_words_truncated() {
        assert_eq!(
            reason_from_body(Some(r#"{"error":{"code":"content-blocked","message":"content-blocked (request id: x)"}}"#)).as_deref(),
            Some("content-blocked: content-blocked (request id: x)"),
        );
        // not JSON: the raw text is still the provider's own words
        assert_eq!(reason_from_body(Some("plain refusal")).as_deref(), Some("plain refusal"));
        // char-counted truncation: a CJK message must not panic on a split code point
        let long = "无".repeat(MAX_REASON_CHARS + 100);
        let got = reason_from_body(Some(&long)).unwrap();
        assert!(got.chars().count() <= MAX_REASON_CHARS + 1);
        assert!(got.ends_with('…'));
        assert_eq!(reason_from_body(None), None);
    }

    #[test]
    fn a_validation_error_keeps_the_rule_that_explains_it() {
        // Measured from agentrouter.org's Anthropic route (2026-10-02), verbatim apart from the id.
        // It is 186 characters before the aggregator appends its own request/trace suffixes, so the
        // old 120-character cut landed at "Each `…" and dropped both the offending id and the rule —
        // thereby making a live 400 undiagnosable from the ledger, which is this field's whole job.
        let message = "unexpected `messages.2.content.0: tool_use_id` found in `tool_result` blocks: \
                       toolu_bogus_123. Each `tool_result` block must have a corresponding `tool_use` \
                       block in the previous message.";
        let body = serde_json::json!({ "error": { "message": message } }).to_string();
        let got = reason_from_body(Some(&body)).unwrap();

        assert!(got.contains("toolu_bogus_123"), "{got}");
        assert!(got.contains("must have a corresponding"), "{got}");
        assert!(!got.ends_with('…'), "the rule must survive: {got}");
    }

    #[test]
    fn only_the_four_named_classes_are_retryable_with_the_next_key() {
        assert!(is_retryable_with_next_key(ErrorClass::AuthFailed));
        assert!(is_retryable_with_next_key(ErrorClass::RateLimited));
        assert!(is_retryable_with_next_key(ErrorClass::ServerError));
        assert!(is_retryable_with_next_key(ErrorClass::Network));
        // TIMEOUT is absent in the TypeScript original, and a timeout is not evidence about a key.
        assert!(!is_retryable_with_next_key(ErrorClass::Timeout));
        assert!(!is_retryable_with_next_key(ErrorClass::NotFound));
        assert!(!is_retryable_with_next_key(ErrorClass::ParseError));
        assert!(!is_retryable_with_next_key(ErrorClass::BadRequestSchema));
        assert!(!is_retryable_with_next_key(ErrorClass::Ok));
    }

    #[test]
    fn the_drift_set_is_exactly_the_four_provider_side_failures() {
        let drift: Vec<ErrorClass> = [
            ErrorClass::Ok,
            ErrorClass::AuthFailed,
            ErrorClass::RateLimited,
            ErrorClass::NotFound,
            ErrorClass::BadRequestSchema,
            ErrorClass::ParseError,
            ErrorClass::ServerError,
            ErrorClass::Timeout,
            ErrorClass::Network,
        ]
        .into_iter()
        .filter(|c| c.is_drift())
        .collect();
        assert_eq!(
            drift,
            vec![
                ErrorClass::AuthFailed,
                ErrorClass::NotFound,
                ErrorClass::BadRequestSchema,
                ErrorClass::ParseError,
            ]
        );
    }

    // ---- min_retry_after_ms: ported from `retry-after.test.ts` ------------------------------

    #[test]
    fn takes_the_shortest_cooldown_across_attempts_and_zero_when_none_was_named() {
        // Ported from `retry-after.test.ts`: "takes the shortest cooldown across attempts, and
        // zero when none was named". The shortest is deliberately in the MIDDLE — a fold that
        // kept the first or the last value would answer 45_000 or 60_000, so this pins the
        // direction of the fold rather than the input.
        assert_eq!(
            min_retry_after_ms(&[
                outcome(ErrorClass::RateLimited, 429, Some(45_000)),
                outcome(ErrorClass::RateLimited, 429, Some(30_000)),
                outcome(ErrorClass::RateLimited, 429, Some(60_000)),
            ]),
            30_000
        );
        assert_eq!(
            min_retry_after_ms(&[
                outcome(ErrorClass::RateLimited, 429, None),
                outcome(ErrorClass::RateLimited, 429, None),
            ]),
            0
        );
    }

    #[test]
    fn every_named_wait_counts_and_an_unnamed_one_contributes_nothing() {
        // Ported from `retry-after.test.ts`: "ignores a wait that a provider never named, and
        // keeps one it did". A 503's `Retry-After` leaves its key technically usable — the
        // tracker only cools on RATE_LIMITED — but the provider still said it was overloaded, so
        // its wait must count. This assertion is why the fold reads `cls`-independent waits
        // rather than filtering to RATE_LIMITED.
        assert_eq!(
            min_retry_after_ms(&[outcome(ErrorClass::ServerError, 503, Some(30_000))]),
            30_000
        );
        assert_eq!(
            min_retry_after_ms(&[
                outcome(ErrorClass::Network, 0, None),
                outcome(ErrorClass::RateLimited, 429, Some(20_000)),
            ]),
            20_000
        );
    }

    #[test]
    fn floors_a_sub_second_wait_at_the_tracker_own_floor() {
        // Ported from `retry-after.test.ts`: "floors a sub-second wait at the tracker's own
        // floor". A `0` would read to the client as "retry now" — the window the provider asked
        // us to wait out.
        assert_eq!(
            min_retry_after_ms(&[outcome(ErrorClass::RateLimited, 429, Some(400))]),
            COOLDOWN_FLOOR_MS
        );
        // `Some(0)` is "named nothing", not "retry now".
        assert_eq!(min_retry_after_ms(&[outcome(ErrorClass::RateLimited, 429, Some(0))]), 0);
    }

    #[test]
    fn an_empty_chain_names_no_wait() {
        assert_eq!(min_retry_after_ms(&[]), 0);
    }

    // ---- HealthTracker: the enforcement half ------------------------------------------------

    fn key_row(id: &str, status: &str, cooldown_until: Option<i64>) -> ApiKeyRow {
        ApiKeyRow {
            id: id.to_string(),
            provider_id: "p1".to_string(),
            label: id.to_string(),
            secret_ref: format!("key:p1:{id}"),
            secret_hint: None,
            status: status.to_string(),
            priority: 0,
            cooldown_until,
            added_at: 1,
            last_used_at: None,
            last_tested_at: None,
        }
    }

    fn provider_row(status: &str) -> ProviderRow {
        ProviderRow {
            id: "p1".to_string(),
            slug: "p1".to_string(),
            name: "p1".to_string(),
            r#type: Some("builtin".to_string()),
            base_url: "https://p1.test/v1".to_string(),
            status: status.to_string(),
            rotation_strategy: "round_robin".to_string(),
            created_at: 1,
            updated_at: 1,
        }
    }

    const NOW: i64 = 1_000_000;

    #[test]
    fn a_rate_limited_key_is_cooled_for_at_least_the_floor() {
        let asked = HealthTracker::new();
        asked.record_result("k1", ErrorClass::RateLimited, Some(60_000), NOW);
        assert_eq!(
            asked.keys()["k1"].cooldown_until_ms,
            NOW + 60_000,
            "the provider's wait is kept"
        );

        // A sub-second wait, and no wait at all, both land on the floor.
        for wait in [Some(400u64), Some(0), None] {
            let t = HealthTracker::new();
            t.record_result("k1", ErrorClass::RateLimited, wait, NOW);
            assert_eq!(
                t.keys()["k1"].cooldown_until_ms,
                NOW + COOLDOWN_FLOOR_MS as i64,
                "wait {wait:?} must be floored, not honoured as-is"
            );
        }
    }

    #[test]
    fn the_enforced_floor_and_the_reported_floor_agree() {
        // This is the invariant the TypeScript exports COOLDOWN_FLOOR_MS for: the cooldown the
        // tracker *enforces* must equal the wait the client is *told*. Two hardcoded 1000s would
        // be free to drift apart; here one constant backs both, and this is what keeps it so.
        for ms in [1u64, 400, 999, 1000, 1001, 30_000, 60_000] {
            let t = HealthTracker::new();
            t.record_result("k1", ErrorClass::RateLimited, Some(ms), NOW);
            let enforced = t.keys()["k1"].cooldown_until_ms - NOW;
            let reported = min_retry_after_ms(&[outcome(ErrorClass::RateLimited, 429, Some(ms))]);
            assert_eq!(enforced, reported as i64, "provider named {ms}ms");
        }
    }

    #[test]
    fn a_wait_of_zero_is_the_one_place_the_two_deliberately_differ() {
        // `Some(0)` means "the provider named nothing", not "retry now". The tracker still cools
        // for the floor; the report returns 0, which means *omit the header*, after which the
        // middleware's own floor applies. Both end up telling the client to wait — only the
        // reporting path defers. Pinned so the divergence is a decision rather than a surprise.
        let t = HealthTracker::new();
        t.record_result("k1", ErrorClass::RateLimited, Some(0), NOW);
        assert_eq!(t.keys()["k1"].cooldown_until_ms - NOW, COOLDOWN_FLOOR_MS as i64);
        assert_eq!(min_retry_after_ms(&[outcome(ErrorClass::RateLimited, 429, Some(0))]), 0);
    }

    #[test]
    fn a_cooled_key_reports_the_moment_it_comes_back() {
        // The reader the router's cooldown wait is built on. `agnes` names no `Retry-After`, so the
        // wait is the floor — and the answer must be that floor rather than "unknown", or the
        // caller has no number to sleep on.
        let key = key_row("k1", "active", None);
        let t = HealthTracker::new();
        t.record_result("k1", ErrorClass::RateLimited, None, NOW);

        assert!(!t.is_key_usable(&key, NOW));
        assert_eq!(t.key_retry_at(&key, NOW), Some(NOW + COOLDOWN_FLOOR_MS as i64));

        // ...and once that moment arrives the key is usable, so there is nothing left to wait for.
        // This is also what guarantees the caller's loop makes progress: the time it is handed is
        // always strictly in the future, so it always sleeps rather than spinning.
        let after = NOW + COOLDOWN_FLOOR_MS as i64;
        assert!(t.is_key_usable(&key, after));
        assert_eq!(t.key_retry_at(&key, after), None);
    }

    #[test]
    fn a_blocked_key_reports_no_retry_time_when_waiting_cannot_help() {
        // **The distinction the whole fix rests on.** A denied status and an open breaker both make
        // a key unusable, and **neither clears on a clock** — so a caller that slept until they did
        // would sleep until its own bound killed the request. Both must answer `None`, and the
        // router must then fall back to `NO_ROUTE` rather than waiting.
        let t = HealthTracker::new();

        for denied in ["disabled", "invalid"] {
            let key = key_row("k1", denied, None);
            assert!(!t.is_key_usable(&key, NOW), "{denied} is not usable");
            assert_eq!(t.key_retry_at(&key, NOW), None, "{denied} must never be waited on");
        }

        let key = key_row("k1", "active", None);
        for _ in 0..AUTH_BREAKER_THRESHOLD {
            t.record_result("k1", ErrorClass::AuthFailed, None, NOW);
        }
        assert!(!t.is_key_usable(&key, NOW));
        assert_eq!(t.key_retry_at(&key, NOW), None, "an open breaker must never be waited on");
    }

    #[test]
    fn a_retry_time_honours_whichever_cooldown_lasts_longer() {
        // The tracker's cooldown and the row's own `cooldown_until` are **two different fields**,
        // and the key is free only when *both* have cleared. A reader that consulted one of them
        // would report a wait that is too short and re-plan into the same empty plan.
        let row_cooled = key_row("k1", "active", Some(NOW + 4_000));
        let t = HealthTracker::new();
        assert_eq!(t.key_retry_at(&row_cooled, NOW), Some(NOW + 4_000));

        // A tracker cooldown that outlasts the row's wins, because it is the later of the two.
        t.record_result("k1", ErrorClass::RateLimited, Some(9_000), NOW);
        assert_eq!(t.key_retry_at(&row_cooled, NOW), Some(NOW + 9_000));
    }

    #[test]
    fn three_consecutive_auth_failures_open_the_breaker_and_an_ok_closes_it() {
        let key = key_row("k1", "active", None);
        let t = HealthTracker::new();

        for i in 1..AUTH_BREAKER_THRESHOLD {
            t.record_result("k1", ErrorClass::AuthFailed, None, NOW);
            assert!(t.keys()["k1"].breaker_open_at.is_none(), "still closed after {i} failure(s)");
            assert!(t.is_key_usable(&key, NOW));
        }
        t.record_result("k1", ErrorClass::AuthFailed, None, NOW);
        assert!(
            t.keys()["k1"].breaker_open_at.is_some(),
            "opens on failure {AUTH_BREAKER_THRESHOLD}"
        );
        assert!(!t.is_key_usable(&key, NOW));

        // One success clears it: the breaker counts *consecutive* failures, so the count resets
        // too rather than merely closing.
        t.record_result("k1", ErrorClass::Ok, None, NOW);
        assert!(t.keys()["k1"].breaker_open_at.is_none());
        assert_eq!(t.keys()["k1"].consecutive_auth_failures, 0);
        assert!(t.is_key_usable(&key, NOW));
    }

    #[test]
    fn an_open_breaker_admits_its_key_again_after_the_half_open_window() {
        // **The regression test for the latch.** Only an `Ok` could clear an open breaker, and an
        // open breaker meant the key was never tried again — so no `Ok` could ever arrive. A
        // credential restored by an operator stayed dead to the router for the life of the process.
        // The window is what makes the exclusion finite. Both sides of the boundary are asserted,
        // because an off-by-one here is the difference between "one probe per window" and "never".
        let key = key_row("k1", "active", None);
        let t = HealthTracker::new();
        for _ in 0..AUTH_BREAKER_THRESHOLD {
            t.record_result("k1", ErrorClass::AuthFailed, None, NOW);
        }
        assert_eq!(
            t.keys()["k1"].breaker_open_at,
            Some(NOW),
            "the window starts when the breaker opens"
        );

        let half_open = NOW + BREAKER_HALF_OPEN_MS as i64;
        assert!(
            !t.is_key_usable(&key, half_open - 1),
            "excluded one millisecond before the window"
        );
        assert!(t.is_key_usable(&key, half_open), "the window bounds the exclusion");
        // Usable is not the same as cleared. The breaker is *half* open: the key may be tried, but
        // it is not yet trusted, and the next attempt is what closes it.
        assert_eq!(t.keys()["k1"].breaker_open_at, Some(NOW), "still half-open, not cleared");

        // A re-probe that fails again re-arms the window. Without the re-stamp the key would be
        // admitted on every request from here on — the latch traded for the opposite defect.
        t.record_result("k1", ErrorClass::AuthFailed, None, half_open);
        assert_eq!(t.keys()["k1"].breaker_open_at, Some(half_open), "re-armed by the re-probe");
        assert!(!t.is_key_usable(&key, half_open), "excluded again");
        assert!(t.is_key_usable(&key, half_open + BREAKER_HALF_OPEN_MS as i64));

        // A re-probe that succeeds closes it for real.
        t.record_result("k1", ErrorClass::Ok, None, half_open);
        assert_eq!(t.keys()["k1"].breaker_open_at, None, "cleared");
        assert!(t.is_key_usable(&key, half_open));
    }

    #[test]
    fn a_half_open_breaker_is_never_waited_on() {
        // **The increment-29 contract, preserved across a change that makes a breaker look like a
        // cooldown.** A breaker does now clear on a clock — but on a scale of minutes, against a
        // request budget measured in seconds, so a caller that slept on it would sleep past the
        // gateway's own bound and fail anyway. Every instant must answer `None`: while the window
        // runs, at the half-open instant, and past it (where the key is usable, so there is nothing
        // left to wait for either).
        let key = key_row("k1", "active", None);
        let t = HealthTracker::new();
        for _ in 0..AUTH_BREAKER_THRESHOLD {
            t.record_result("k1", ErrorClass::AuthFailed, None, NOW);
        }
        let half_open = NOW + BREAKER_HALF_OPEN_MS as i64;

        for at in [NOW, half_open - 1, half_open, half_open + 1] {
            assert_eq!(
                t.key_retry_at(&key, at),
                None,
                "a breaker must never be waited on (at {at})"
            );
        }

        // ...and the two mechanisms stay separate: a cooldown recorded while the breaker is
        // half-open still yields its own time, because *there* waiting is the remedy.
        t.record_result("k1", ErrorClass::RateLimited, Some(2_000), half_open);
        assert_eq!(t.key_retry_at(&key, half_open), Some(half_open + 2_000));
    }

    #[test]
    fn an_ok_result_clears_the_cooldown_the_breaker_and_the_failure_count() {
        let t = HealthTracker::new();
        for _ in 0..AUTH_BREAKER_THRESHOLD {
            t.record_result("k1", ErrorClass::AuthFailed, None, NOW);
        }
        t.record_result("k1", ErrorClass::RateLimited, Some(60_000), NOW);
        let before = t.keys()["k1"];
        assert!(
            before.breaker_open_at.is_some()
                && before.cooldown_until_ms > NOW
                && before.consecutive_auth_failures > 0
        );

        t.record_result("k1", ErrorClass::Ok, None, NOW);
        assert_eq!(t.keys()["k1"], KeyHealth::default(), "an Ok leaves nothing behind");
        assert!(t.is_key_usable(&key_row("k1", "active", None), NOW));
    }

    #[test]
    fn a_disabled_or_invalid_key_is_unusable_and_an_unknown_status_is_not() {
        let t = HealthTracker::new();
        for denied in ["disabled", "invalid"] {
            assert!(
                !t.is_key_usable(&key_row("k1", denied, None), NOW),
                "{denied} must be refused"
            );
        }
        // A deny-list, so anything else is tried — including a status this code has never seen.
        // Pinned because the intuitive reading ("only `active` is usable") is the wrong one, and
        // the comparison is case-sensitive: `"ACTIVE"` is not `"active"` but passes anyway.
        for allowed in ["active", "pending", "", "ACTIVE"] {
            assert!(
                t.is_key_usable(&key_row("k1", allowed, None), NOW),
                "{allowed:?} must be tried"
            );
        }
    }

    #[test]
    fn a_provider_is_usable_only_when_its_status_is_enabled() {
        // The opposite polarity to the key check above: an allow-list, so an unrecognised
        // provider status is refused rather than tried. Both polarities are pinned so that
        // "fixing" either one to match the other fails a test.
        assert!(HealthTracker::is_provider_usable(&provider_row("enabled")));
        for refused in ["disabled", "invalid", "pending", "", "ENABLED"] {
            assert!(
                !HealthTracker::is_provider_usable(&provider_row(refused)),
                "{refused:?} must be refused"
            );
        }
    }

    #[test]
    fn a_key_cooldown_on_the_record_is_honoured() {
        // The record's own `cooldown_until` is a *different* field from this tracker's in-memory
        // one, and it is the only place the unit is asserted. Nothing in the codebase ever writes
        // a non-null value: every `updateKey` call site passes `status`, `lastTestedAt`, or both
        // (measured 2026-09-23, four call sites in source). The TypeScript compares the field
        // against `Date.now()`, which is milliseconds, so milliseconds is the contract — pinned
        // here so the first writer to arrive has it stated rather than guessed.
        let t = HealthTracker::new();
        assert!(
            !t.is_key_usable(&key_row("k1", "active", Some(NOW + 1)), NOW),
            "a future cooldown blocks"
        );
        assert!(
            t.is_key_usable(&key_row("k1", "active", Some(NOW - 1)), NOW),
            "an elapsed one does not"
        );
        assert!(
            t.is_key_usable(&key_row("k1", "active", Some(NOW)), NOW),
            "the boundary is exclusive"
        );
    }

    #[test]
    fn a_model_side_drift_class_leaves_key_health_alone() {
        // NOT_FOUND, BAD_REQUEST_SCHEMA and PARSE_ERROR are provider/manifest problems, not key
        // problems. Burning a good key for them is the bug this prevents.
        for cls in [ErrorClass::NotFound, ErrorClass::BadRequestSchema, ErrorClass::ParseError] {
            let t = HealthTracker::new();
            t.record_result("k1", cls, None, NOW);
            assert_eq!(t.keys()["k1"], KeyHealth::default(), "{cls:?} changed key health");
        }
    }

    #[test]
    fn server_error_network_and_timeout_also_leave_key_health_alone() {
        // These three reach the end of the TypeScript chain rather than its explicit early
        // return, and the outcome is the same: nothing. Asserted separately, and with a wait
        // attached, so that if the port ever grows a backoff for them it is a deliberate change
        // rather than a silent one — `retry_after_ms` is ignored for every class but RATE_LIMITED.
        for cls in [ErrorClass::ServerError, ErrorClass::Network, ErrorClass::Timeout] {
            let t = HealthTracker::new();
            t.record_result("k1", cls, Some(60_000), NOW);
            assert_eq!(t.keys()["k1"], KeyHealth::default(), "{cls:?} changed key health");
        }
    }

    #[test]
    fn resetting_a_key_forgets_its_cooldown_and_its_breaker() {
        let key = key_row("k1", "active", None);
        let t = HealthTracker::new();
        for _ in 0..AUTH_BREAKER_THRESHOLD {
            t.record_result("k1", ErrorClass::AuthFailed, None, NOW);
        }
        assert!(!t.is_key_usable(&key, NOW));

        t.reset_key("k1");
        assert!(t.is_key_usable(&key, NOW));
        // A reset key starts from nothing, not from "cooldown cleared but breaker open".
        assert!(!t.keys().contains_key("k1"));
    }

    #[test]
    fn reading_a_keys_health_does_not_create_an_entry_for_it() {
        // A deliberate divergence from the TypeScript, whose `health()` inserts on read. The
        // answer is the same — an absent entry means default health — but considering a thousand
        // keys does not grow the map.
        let t = HealthTracker::new();
        assert!(t.is_key_usable(&key_row("never-seen", "active", None), NOW));
        assert!(t.keys().is_empty(), "a read must not insert");
    }

    #[test]
    fn the_map_does_grow_when_something_is_recorded() {
        // The companion to the test above: `is_empty()` there is only evidence if the map *is*
        // populated when it should be. Without this, a tracker whose `record_result` silently did
        // nothing would make the non-inserting read look correct for the wrong reason.
        let t = HealthTracker::new();
        t.record_result("k1", ErrorClass::RateLimited, Some(60_000), NOW);
        assert_eq!(t.keys().len(), 1);
        t.record_result("k2", ErrorClass::AuthFailed, None, NOW);
        assert_eq!(t.keys().len(), 2);
        t.reset_key("k1");
        assert_eq!(t.keys().len(), 1);
    }

    // ---------- increment 4: the attempt budget and the terminal error ----------

    /// The TypeScript union, verbatim from `errors.ts`.
    ///
    /// Spelled out rather than derived from anything, so a variant added to `ErrorClass` without
    /// a wire spelling fails here instead of quietly rendering as its `Debug` form. `CLIENT_GATE`
    /// and `BILLING` joined both unions on 2026-09-29: a gated 401 is not about the key, and a
    /// 402 is not about the network.
    const TS_SPELLINGS: [&str; 12] = [
        "AUTH_FAILED",
        "RATE_LIMITED",
        "NOT_FOUND",
        "BAD_REQUEST_SCHEMA",
        "PARSE_ERROR",
        // Gained 2026-10-02 on both sides of the port: a stream that reasoned and never answered
        // is not a parse error. See `ErrorClass::NoOutput`.
        "NO_OUTPUT",
        "SERVER_ERROR",
        "TIMEOUT",
        "NETWORK",
        "CLIENT_GATE",
        "BILLING",
        "OK",
    ];

    /// **The one class the TypeScript union does not have, named so that it stays one.**
    ///
    /// `EGRESS_DENIED` describes something the TypeScript cannot see: the egress allowlist lives in
    /// the host, so a refusal by it has no counterpart on the other side of the port. Adding it was
    /// a deliberate divergence (D46) — and this constant is what keeps it *deliberate*, because a
    /// second unagreed spelling has to be added here by name, in a diff a reviewer reads, instead of
    /// being absorbed by an assertion someone loosened.
    const RUST_ONLY_SPELLINGS: [&str; 1] = ["EGRESS_DENIED"];

    /// **The cross-language contract, with its one named exception.**
    ///
    /// Two assertions rather than one set-equality, because they are two different claims:
    /// "the port has not lost a class the TypeScript can send" and "it has gained exactly the
    /// recorded ones". A set-equality would have had to be *loosened* to accommodate the
    /// divergence, and a loosened assertion is how a second divergence arrives unnoticed.
    #[test]
    fn every_class_has_the_spelling_the_typescript_uses() {
        let mut got: Vec<&str> = ALL_CLASSES.iter().map(|c| c.as_str()).collect();
        got.sort_unstable();
        let mut want = TS_SPELLINGS.to_vec();
        want.sort_unstable();

        for ts in &want {
            assert!(got.contains(ts), "the port lost a TypeScript class: {ts}");
        }

        let mut extra: Vec<&str> = got.iter().copied().filter(|c| !want.contains(c)).collect();
        extra.sort_unstable();
        let mut recorded = RUST_ONLY_SPELLINGS.to_vec();
        recorded.sort_unstable();
        assert_eq!(extra, recorded, "an unrecorded class joined the wire vocabulary");

        // Two classes sharing a spelling would satisfy both assertions above, so it is asked
        // separately — and it is the one property the old set-equality got for free.
        assert_eq!(got.len(), ALL_CLASSES.len(), "two classes share a wire spelling");
    }

    #[test]
    fn the_attempt_budget_treats_a_named_zero_as_zero() {
        // The TypeScript is `args.maxAttempts ?? MAX_ATTEMPTS_DEFAULT` — `??`, not `||`. So a
        // caller that names zero gets zero attempts and an empty chain, not six.
        assert_eq!(attempt_budget(10, Some(0)), 0, "a named zero is a budget, not an absence");
        assert_eq!(attempt_budget(10, None), MAX_ATTEMPTS_DEFAULT);
        // The plan is the other bound, and it wins when it is the smaller one.
        assert_eq!(attempt_budget(3, None), 3);
        assert_eq!(attempt_budget(0, None), 0);
        assert_eq!(attempt_budget(3, Some(9)), 3);
        assert_eq!(attempt_budget(9, Some(3)), 3);
    }

    #[test]
    fn no_output_is_neither_drift_nor_key_retryable() {
        // The provider honoured its contract and the model never wrote an answer. Drift would push
        // a healthy provider toward repair for a request-side cause; key-retryability would rotate
        // through every other key of the provider for a decision no key took part in.
        assert!(!ErrorClass::NoOutput.is_drift());
        assert!(!is_retryable_with_next_key(ErrorClass::NoOutput));
        // And the tracker's own match leaves the key untouched — the arm is exhaustive, so this is
        // the behavioural half of the same claim.
        let tracker = HealthTracker::default();
        tracker.record_result("k", ErrorClass::NoOutput, None, now_ms());
        // No assertion beyond "this ran and changed nothing observable" — the entry is created
        // lazily and stays at its defaults, which is the point.
    }

    #[test]
    fn the_plan_budget_admits_the_first_candidate_and_funds_the_rest() {
        use crate::core::egress::UPSTREAM_HEADER_TIMEOUT as ATTEMPT;

        // **The first candidate is always admitted, even past the budget.** Otherwise a budget
        // below one attempt would refuse everything and turn a slow request into an instant,
        // silent failure — the budget would stop being a bound and start being an outage.
        assert!(candidate_is_affordable(Duration::ZERO, true));
        assert!(
            candidate_is_affordable(PLAN_BUDGET * 10, true),
            "the first candidate defines the plan's cost; the rule exists for the ones after it"
        );

        // **Every later candidate must be fundable in full, and the boundary is exact.** The
        // second candidate on the 2026-09-27 timeline arrives at 20s having spent a whole attempt,
        // and `20s + 20s > 26s` is what refuses it — which is the fix. A candidate is admitted at
        // the last instant that still fits, and refused one tick later.
        assert!(
            candidate_is_affordable(PLAN_BUDGET - ATTEMPT, false),
            "a candidate that exactly fits the remaining budget must still be admitted"
        );
        assert!(
            !candidate_is_affordable(PLAN_BUDGET - ATTEMPT + Duration::from_millis(1), false),
            "one millisecond later it no longer fits, and admitting it would overrun the plan"
        );

        // The production timeline, stated as the case rather than as arithmetic: entry 1 spent a
        // full header budget timing out, so entry 2 must be refused rather than cut off.
        assert!(
            !candidate_is_affordable(ATTEMPT, false),
            "entry 2 after entry 1 burned a whole attempt is exactly requests 22/25/26/27"
        );

        // A *fast* failure leaves room, so a genuinely different provider still gets its chance —
        // the retry on the transport arm and the failover to another host both depend on this.
        assert!(
            candidate_is_affordable(Duration::from_millis(200), false),
            "a candidate refused in 200ms must leave the next one affordable"
        );
    }

    #[test]
    fn the_error_reports_the_same_wait_as_the_free_fold() {
        // One arithmetic, two entry points. If they ever disagree, the client is told a different
        // wait depending on which path produced the failure — and the TypeScript spells this fold
        // twice, so there is a real precedent for them drifting.
        let chains: Vec<Vec<AttemptOutcome>> = vec![
            vec![],
            vec![outcome(ErrorClass::Network, 0, None)],
            vec![outcome(ErrorClass::RateLimited, 429, Some(58_000))],
            vec![
                outcome(ErrorClass::RateLimited, 429, Some(58_000)),
                outcome(ErrorClass::ServerError, 503, Some(42_000)),
                outcome(ErrorClass::RateLimited, 429, Some(71_000)),
            ],
            vec![
                outcome(ErrorClass::RateLimited, 429, Some(400)),
                outcome(ErrorClass::ServerError, 503, Some(30_000)),
            ],
            vec![outcome(ErrorClass::RateLimited, 429, Some(0))],
            vec![
                outcome(ErrorClass::AuthFailed, 401, None),
                outcome(ErrorClass::RateLimited, 429, Some(1)),
            ],
        ];
        for chain in chains {
            let err = AllAttemptsFailed::new("gpt-4o", chain.clone());
            assert_eq!(
                err.min_retry_after_ms(),
                min_retry_after_ms(&chain),
                "the error and the free fold must be one arithmetic, for {chain:?}"
            );
        }
    }

    #[test]
    fn an_empty_chain_is_named_as_a_budget_not_as_an_empty_list() {
        let err = AllAttemptsFailed::new("gpt-4o", vec![]);
        assert_eq!(err.describe(), "all attempts failed for gpt-4o [empty plan]");
        assert_eq!(err.min_retry_after_ms(), 0, "and it names no wait at all");
    }

    #[test]
    fn the_message_names_each_attempt_in_order_with_the_wire_spelling() {
        let err = AllAttemptsFailed::new(
            "gpt-4o",
            vec![
                outcome(ErrorClass::AuthFailed, 401, None),
                outcome(ErrorClass::RateLimited, 429, Some(60_000)),
            ],
        );
        assert_eq!(
            err.describe(),
            "all attempts failed for gpt-4o [AUTH_FAILED:401 -> RATE_LIMITED:429]"
        );
    }

    /// The other half of `describe`, and the half the gap was about.
    ///
    /// **`slug/label`, not `slug label` and not `label/slug`.** The TypeScript is
    /// `` `${a.candidate.provider.slug}/${a.candidate.key.label}:${a.cls}` `` (`:199`), and the
    /// order is load-bearing for a reader: the provider comes first because that is the unit that
    /// failed. A mutation swapping the two fields still produces a plausible-looking string, which
    /// is exactly why this asserts the whole thing rather than `contains("p1")`.
    #[test]
    fn a_labelled_attempt_is_named_by_its_provider_and_key() {
        let err = AllAttemptsFailed::new(
            "gpt-4o",
            vec![
                named("openrouter", "primary", ErrorClass::AuthFailed, 401, None),
                named("groq", "spare-key", ErrorClass::RateLimited, 429, Some(60_000)),
            ],
        );
        assert_eq!(
            err.describe(),
            "all attempts failed for gpt-4o [openrouter/primary:AUTH_FAILED -> groq/spare-key:RATE_LIMITED]"
        );
    }

    /// The two spellings coexist, and each is honest about what it knows.
    ///
    /// A chain can mix them — a caller-built outcome beside an engine-built one — and the
    /// label-less half must not borrow the labelled half's shape. `p1/k1` here would be a forged
    /// name for the second attempt, which never had a candidate.
    #[test]
    fn an_unlabelled_attempt_states_that_it_cannot_be_named() {
        let err = AllAttemptsFailed::new(
            "gpt-4o",
            vec![
                named("p1", "k1", ErrorClass::NotFound, 404, None),
                outcome(ErrorClass::Network, 0, None),
            ],
        );
        assert_eq!(err.describe(), "all attempts failed for gpt-4o [p1/k1:NOT_FOUND -> NETWORK:0]");
    }

    #[test]
    fn the_label_is_built_from_the_candidate_and_not_from_its_id() {
        // `slug` and `label` are what a person reads; the provider id and the key's secret_ref are
        // not in the string at all. A port that reached for `provider.id` would pass every
        // assertion above whenever the fixture happens to use the same string for both — which the
        // shared fixtures do, so this one does not.
        let mut c = candidate("p1", "k1", "m1");
        c.provider.slug = "openrouter".to_string();
        c.key.label = "work key".to_string();
        c.key.secret_ref = "key:p1:SUPER-SECRET".to_string();

        let label = AttemptLabel::of(&c);
        assert_eq!(label.provider_slug, "openrouter");
        assert_eq!(label.key_label, "work key");
        assert!(!label.key_label.contains("SUPER-SECRET"));
    }

    // ---------- increment 6: the per-attempt policy ----------

    fn http(status: u16, kind: FailureKind, retry_after_ms: Option<u64>) -> AttemptError {
        AttemptError::Http { status, kind, retry_after_ms, body: None }
    }

    /// Every status the taxonomy names, plus the two bands it falls through on.
    const ALL_STATUSES: [u16; 10] = [0, 200, 204, 400, 401, 404, 408, 429, 500, 503];

    #[test]
    fn a_transport_failure_is_network_because_there_is_no_status_to_classify() {
        assert_eq!(classify_attempt_error(&AttemptError::Transport), ErrorClass::Network);
        assert_eq!(AttemptError::Transport.status_or_zero(), 0);
        assert_eq!(AttemptError::Transport.retry_after_ms(), None);
    }

    #[test]
    fn a_policy_refusal_is_egress_denied_rather_than_network() {
        // The mapping D46 turned on, and the reason `EGRESS_DENIED` exists at all. `Blocked` is the
        // one variant the TypeScript has no counterpart for, so the token it maps to is the one
        // spelling the union lacks — and this asserts the token is a *decision*, not decoration:
        // point `classify_attempt_error`'s `Blocked` arm at `Network` and this reddens.
        let blocked =
            AttemptError::Blocked { reason: "host api.example.test is not allowlisted".into() };
        assert_eq!(classify_attempt_error(&blocked), ErrorClass::EgressDenied);
        assert_eq!(blocked.status_or_zero(), 0);
        assert_eq!(blocked.retry_after_ms(), None);

        // Not drift, so `record_result` must leave the key alone. The property is the same one the
        // drift test pins, asked of the class that carries no status: a refusal by our own policy
        // says nothing about a credential whose provider was never dialled.
        let t = HealthTracker::new();
        t.record_result("k1", classify_attempt_error(&blocked), blocked.retry_after_ms(), NOW);
        assert_eq!(t.keys()["k1"].cooldown_until_ms, 0, "a policy refusal is not the key's fault");
        assert!(t.is_key_usable(&key_row("k1", "enabled", None), NOW));
    }

    #[test]
    fn a_midstream_failure_is_a_parse_error_whatever_status_it_carries() {
        // The status is *ignored*, not merely unused. This is the rule that keeps the emitted
        // path's skipped `record_result` harmless — see the D19 test below.
        for status in ALL_STATUSES {
            let e = http(status, FailureKind::MidStream, Some(60_000));
            assert_eq!(
                classify_attempt_error(&e),
                ErrorClass::ParseError,
                "a mid-stream failure carrying {status} must still be drift"
            );
        }
    }

    #[test]
    fn a_two_hundred_that_threw_is_a_parse_error_rather_than_ok() {
        // A provider that answers 200 and then throws has a body we could not read. Classifying it
        // OK would make the loop treat a broken stream as a served request.
        for status in [200u16, 201, 204, 299] {
            assert_eq!(
                classify_attempt_error(&http(status, FailureKind::Response, None)),
                ErrorClass::ParseError,
                "status {status}"
            );
        }
        // The boundary is the 2xx band, not a named code.
        assert_eq!(
            classify_attempt_error(&http(300, FailureKind::Response, None)),
            ErrorClass::Network
        );
    }

    #[test]
    fn a_refusal_is_classified_from_the_status_alone() {
        // The engine calls `classify(status)` with no body hint, so a 400 is BAD_REQUEST_SCHEMA
        // here even though the adapter *could* have known it was a missing model. Pinned because
        // it is a consequence of the call site, not of the taxonomy.
        let cases = [
            (401u16, ErrorClass::AuthFailed),
            (403, ErrorClass::AuthFailed),
            (429, ErrorClass::RateLimited),
            (404, ErrorClass::NotFound),
            (400, ErrorClass::BadRequestSchema),
            (408, ErrorClass::Timeout),
            (500, ErrorClass::ServerError),
            (503, ErrorClass::ServerError),
            (418, ErrorClass::Network),
        ];
        for (status, want) in cases {
            assert_eq!(
                classify_attempt_error(&http(status, FailureKind::Response, None)),
                want,
                "status {status}"
            );
        }
    }

    #[test]
    fn the_two_spellings_agree_only_because_the_midstream_producer_reports_two_hundred() {
        // D19. The engine spells this rule twice: `execution-engine.ts:113` (already-emitted)
        // tests only `classify(status) === "OK"`, while `:118` (not-yet-emitted) also tests
        // `kind === "mid-stream"`. They differ for a mid-stream error with a non-2xx status — and
        // the only producer of one hardcodes 200 (`manifest-interpreter.ts:360`), which is the
        // whole reason the difference is invisible today.
        //
        // The reachable input, on which both spellings agree:
        assert_eq!(
            classify_attempt_error(&http(200, FailureKind::MidStream, None)),
            ErrorClass::ParseError
        );

        // The input that separates them. The port takes rule 2, so the class does not depend on a
        // constant chosen at the throw site.
        let divergent = http(429, FailureKind::MidStream, None);
        assert_eq!(classify_attempt_error(&divergent), ErrorClass::ParseError);
        assert!(
            classify_attempt_error(&divergent).is_drift(),
            "under the other spelling this is RATE_LIMITED, and the emitted path never records it"
        );
    }

    #[test]
    fn a_rethrown_failure_is_always_a_drift_class_so_skipping_health_cannot_lose_a_cooldown() {
        // The emitted path records the outcome in the chain but never in key health. That is only
        // safe while every mid-stream failure is a drift class, which `record_result` ignores — a
        // dependency between two functions, so it is asserted rather than assumed.
        for status in ALL_STATUSES {
            let e = http(status, FailureKind::MidStream, Some(60_000));
            let cls = classify_attempt_error(&e);
            assert!(cls.is_drift(), "a mid-stream {status} classified as {}", cls.as_str());

            let t = HealthTracker::new();
            t.record_result("k1", cls, e.retry_after_ms(), NOW);
            assert!(
                t.is_key_usable(&key_row("k1", "enabled", None), NOW),
                "a drift class must not cool the key"
            );
            assert_eq!(t.keys()["k1"].cooldown_until_ms, 0);
        }

        // The contrast that makes the rule non-vacuous: a class that is *not* drift does cool it,
        // so "skipping health" is a real omission rather than a no-op for every class.
        let t = HealthTracker::new();
        t.record_result("k1", ErrorClass::RateLimited, Some(60_000), NOW);
        assert!(!t.is_key_usable(&key_row("k1", "enabled", None), NOW));
    }

    #[test]
    fn an_emitted_failure_rethrows_even_when_the_caller_cancelled() {
        // `emitted` is checked before `aborted` (`execution-engine.ts:112` precedes `:133`). Once a
        // byte has reached the consumer the only honest end is the error: the caller holds partial
        // output, and a quiet stop would look like an empty response.
        assert_eq!(attempt_disposition(true, true), AttemptDisposition::Rethrow);
        assert_eq!(attempt_disposition(true, false), AttemptDisposition::Rethrow);
    }

    #[test]
    fn a_failure_before_the_first_byte_stops_on_cancel_and_advances_otherwise() {
        assert_eq!(attempt_disposition(false, true), AttemptDisposition::Stop);
        assert_eq!(attempt_disposition(false, false), AttemptDisposition::Next);
    }

    #[test]
    fn only_the_emitted_path_skips_key_health() {
        assert!(!records_key_health(AttemptDisposition::Rethrow));
        assert!(records_key_health(AttemptDisposition::Stop));
        assert!(records_key_health(AttemptDisposition::Next));
    }

    #[test]
    fn the_outcome_writes_the_class_and_the_status_the_chain_reports() {
        let e = http(401, FailureKind::Response, Some(30_000));
        assert_eq!(
            attempt_outcome(&e, AttemptDisposition::Next),
            outcome(ErrorClass::AuthFailed, 401, Some(30_000))
        );

        // No answer at all: status 0 is the sentinel, not a status.
        assert_eq!(
            attempt_outcome(&AttemptError::Transport, AttemptDisposition::Next),
            outcome(ErrorClass::Network, 0, None)
        );
    }

    #[test]
    fn the_rethrown_path_drops_the_wait_it_will_never_honour() {
        // The TypeScript says this by omission (`:114` pushes no `retryAfterMs`), while both paths
        // that can act on a wait carry it (`:122-130`, and `:129` for the stopped path).
        let e = http(429, FailureKind::MidStream, Some(60_000));
        assert_eq!(
            attempt_outcome(&e, AttemptDisposition::Rethrow).retry_after_ms,
            None,
            "a path that rethrows must not advertise a wait"
        );
        assert_eq!(
            attempt_outcome(&e, AttemptDisposition::Stop).retry_after_ms,
            Some(60_000),
            "a stopped attempt still reports what the provider asked for"
        );
        assert_eq!(attempt_outcome(&e, AttemptDisposition::Next).retry_after_ms, Some(60_000));
    }

    #[test]
    fn a_saturated_provider_is_reported_as_rate_limited_429_and_is_not_a_key_problem() {
        let o = saturated_outcome();
        assert_eq!(o.cls, ErrorClass::RateLimited);
        assert_eq!(o.status, 429);
        assert_eq!(o.retry_after_ms, None, "the provider named no wait; the cap is ours, not its");

        // RATE_LIMITED *would* cool a key if it were recorded, so the skip being absent from
        // `record_result` is a decision rather than a no-op. This is the contrast that proves it —
        // and the reason the loop must not record it: the provider is busy, not the key bad.
        let t = HealthTracker::new();
        t.record_result("k1", o.cls, o.retry_after_ms, NOW);
        assert!(
            !t.is_key_usable(&key_row("k1", "enabled", None), NOW),
            "if the skip were recorded it would cool the key for the floor"
        );
    }

    #[test]
    fn the_gate_checks_cancellation_before_the_cap() {
        // Abort precedes the acquire in the TypeScript (`:80` before `:83`), so a cancelled request
        // never takes a slot even when one is free.
        assert_eq!(candidate_gate(true, true), CandidateGate::Stop);
        assert_eq!(candidate_gate(true, false), CandidateGate::Stop);
        assert_eq!(candidate_gate(false, true), CandidateGate::SkipSaturated);
        // An unconfigured limiter is not a saturated one: `false` here means "no limiter, or one
        // that admitted", and both must try the candidate.
        assert_eq!(candidate_gate(false, false), CandidateGate::Try);
    }

    // ---------- execute_image: the loop, over doubles ----------
    //
    // The doubles are the point of the seam. `AdapterInstance` and `AdapterFactory` are traits so
    // the loop can be driven without a manifest, a sandbox or a socket — which is also what keeps
    // the sandbox decision open (`core::adapter`).

    use crate::core::adapter::{
        AdapterInstance, Capabilities, ImageReply, ModelEntry, PingResult, TextArgs,
    };
    use futures_util::future::BoxFuture;
    use futures_util::stream::BoxStream;
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};

    /// An adapter that answers from a script, one reply per call, and records what it was asked.
    ///
    /// Interior mutability is not a convenience here: `AdapterInstance` is `Send + Sync` and
    /// `generate_image` takes `&self`, so a `&mut self` recorder would not be callable at all.
    struct Scripted {
        replies: Mutex<VecDeque<Result<ImageReply, AttemptError>>>,
        calls: Mutex<Vec<String>>,
    }

    impl Scripted {
        fn new(replies: Vec<Result<ImageReply, AttemptError>>) -> Arc<Self> {
            Arc::new(Self { replies: Mutex::new(replies.into()), calls: Mutex::new(Vec::new()) })
        }

        /// `"<secret_ref>|<model>"` per call, so a test can prove which *key* and which *native*
        /// model id actually reached the wire.
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
            self.calls.lock().unwrap().push(format!("{secret_ref}|{}", args.model));
            // A script that runs out answers as a transport failure, so an under-scripted test
            // fails loudly instead of passing on a silent default.
            let next =
                self.replies.lock().unwrap().pop_front().unwrap_or(Err(AttemptError::Transport));
            Box::pin(async move { next })
        }

        /// **This double is the image half's, and it says so rather than pretending.** The text
        /// half has its own double in `core::adapter`, so a test that reaches here asked a question
        /// this double was never built to answer. It fails the way an under-scripted image call
        /// fails — loudly, on the response phase, before any chunk exists — so the mistake surfaces
        /// as a failed attempt instead of an empty stream that reads like a model saying nothing.
        fn generate_text<'a>(
            &'a self,
            _secret_ref: &'a str,
            _args: TextArgs<'a>,
            _cancel: &'a Cancel,
        ) -> BoxFuture<'a, Result<BoxStream<'a, Result<String, AttemptError>>, AttemptError>>
        {
            Box::pin(async { Err(AttemptError::Transport) })
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

    /// A factory that always resolves to one adapter.
    struct Always(Arc<dyn AdapterInstance>);

    impl AdapterFactory for Always {
        fn for_provider<'a>(
            &'a self,
            _provider_id: &'a str,
        ) -> BoxFuture<'a, Result<Arc<dyn AdapterInstance>, String>> {
            let adapter = Arc::clone(&self.0);
            Box::pin(async move { Ok(adapter) })
        }
    }

    /// A factory that resolves nothing — the `forProvider` rejection (`execution-engine.ts:173`).
    struct NoneResolved;

    impl AdapterFactory for NoneResolved {
        fn for_provider<'a>(
            &'a self,
            provider_id: &'a str,
        ) -> BoxFuture<'a, Result<Arc<dyn AdapterInstance>, String>> {
            let msg = format!("no adapter for {provider_id}");
            Box::pin(async move { Err(msg) })
        }
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

    fn refusal(status: u16) -> Result<ImageReply, AttemptError> {
        Ok(ImageReply {
            ok: false,
            status,
            base64: None,
            url: None,
            error_body: Some("refused".to_string()),
        })
    }

    fn provider_named(id: &str) -> ProviderRow {
        ProviderRow {
            id: id.to_string(),
            slug: id.to_string(),
            name: id.to_string(),
            r#type: None,
            base_url: "https://example.invalid".to_string(),
            status: "enabled".to_string(),
            rotation_strategy: "round_robin".to_string(),
            created_at: 0,
            updated_at: 0,
        }
    }

    fn model_row(provider_id: &str, native_id: &str) -> ModelRow {
        ModelRow {
            provider_id: provider_id.to_string(),
            native_id: native_id.to_string(),
            modality: "image".to_string(),
            context_window: None,
            fetched_at: 0,
            pricing_json: None,
            capabilities_json: None,
            origin: "discovered".to_string(),
        }
    }

    /// One candidate on provider `p`, with key `k` and native model id `m`.
    fn candidate(p: &str, k: &str, m: &str) -> Candidate {
        let mut key = key_row(k, "enabled", None);
        key.provider_id = p.to_string();
        Candidate { provider: provider_named(p), key, model: model_row(p, m) }
    }

    fn image_args(plan: Vec<Candidate>) -> ExecuteImageArgs {
        ExecuteImageArgs {
            plan,
            prompt: "a cat".to_string(),
            model: "as-the-caller-typed-it".to_string(),
            size: Some("1024x1024".to_string()),
            max_attempts: None,
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_first_candidate_that_answers_serves_and_the_rest_are_never_tried() {
        let adapter = Scripted::new(vec![ok_reply("AAAA")]);
        let health = HealthTracker::new();

        let served = execute_image(
            &Always(adapter.clone()),
            &health,
            None,
            image_args(vec![candidate("p1", "k1", "m1"), candidate("p2", "k2", "m2")]),
            &Cancel::new(),
        )
        .await
        .expect("the first candidate answers");

        assert_eq!(served.candidate.provider.id, "p1");
        assert_eq!(served.base64.as_deref(), Some("AAAA"));
        assert!(served.attempts.is_empty(), "nothing failed before the success");
        assert_eq!(adapter.calls().len(), 1, "a served request must not try the rest of the plan");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_native_model_id_is_what_reaches_the_adapter_not_the_requested_name() {
        // `:176` sends `c.model.nativeId`; `args.model` is only ever used to *name* the failure.
        // A port that sent the requested name would pass every other test in this block.
        let adapter = Scripted::new(vec![ok_reply("AAAA")]);
        let health = HealthTracker::new();

        execute_image(
            &Always(adapter.clone()),
            &health,
            None,
            image_args(vec![candidate("p1", "k1", "gpt-image-1")]),
            &Cancel::new(),
        )
        .await
        .expect("served");

        assert_eq!(adapter.calls(), vec!["key:p1:k1|gpt-image-1".to_string()]);
        assert!(
            !adapter.calls()[0].contains("as-the-caller-typed-it"),
            "the requested name must not reach the wire"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_refusal_advances_to_the_next_candidate_and_is_recorded_with_its_status() {
        let adapter = Scripted::new(vec![refusal(429), ok_reply("BBBB")]);
        let health = HealthTracker::new();

        let served = execute_image(
            &Always(adapter.clone()),
            &health,
            None,
            image_args(vec![candidate("p1", "k1", "m1"), candidate("p2", "k2", "m2")]),
            &Cancel::new(),
        )
        .await
        .expect("the second candidate answers");

        assert_eq!(served.candidate.provider.id, "p2");
        assert_eq!(served.attempts.len(), 1, "the refusal is reported");
        assert_eq!(served.attempts[0].cls, ErrorClass::RateLimited);
        assert_eq!(served.attempts[0].status, 429, "the refusal keeps its status");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_whole_chain_of_failures_reports_every_attempt_in_order() {
        let adapter = Scripted::new(vec![refusal(404), refusal(500), refusal(429)]);
        let health = HealthTracker::new();

        let err = execute_image(
            &Always(adapter.clone()),
            &health,
            None,
            image_args(vec![
                candidate("p1", "k1", "m1"),
                candidate("p2", "k2", "m2"),
                candidate("p3", "k3", "m3"),
            ]),
            &Cancel::new(),
        )
        .await
        .expect_err("nothing served");

        let classes: Vec<ErrorClass> = err.chain.iter().map(|a| a.cls).collect();
        assert_eq!(
            classes,
            vec![ErrorClass::NotFound, ErrorClass::ServerError, ErrorClass::RateLimited],
            "in the order they were tried"
        );
        assert_eq!(adapter.calls().len(), 3);
        // **Zero, not the floor** — and this is D22 seen from the reporting side. `min_retry_after_ms`
        // folds only waits an attempt actually *named* (`:220-227`: "Zero when none named one — the
        // caller then omits the hint entirely and the middleware's floor stands"). The image path
        // cannot name one, because `ImageAttemptResult` has no field for it, so a chain of image
        // failures tells the client nothing at all. The floor is what *cools* the key
        // (`record_result`), not what gets reported.
        assert_eq!(
            err.min_retry_after_ms(),
            0,
            "no image attempt can name a wait, so the client is told nothing"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn every_attempt_the_image_loop_records_names_the_provider_and_key_it_tried() {
        // The image path's label, and the reason the router can write a `fallback_chain_json` at
        // all: the chain's entries are `{provider, key, cls}` (`store.ts:124-128`), and before
        // this the Rust chain could produce only the third. The status is *not* part of what the
        // ledger renders, which is why the assertion is on the label rather than on the whole row.
        let adapter = Scripted::new(vec![refusal(404), refusal(429)]);
        let health = HealthTracker::new();

        let err = execute_image(
            &Always(adapter.clone()),
            &health,
            None,
            image_args(vec![candidate("p1", "k1", "m1"), candidate("p2", "k2", "m2")]),
            &Cancel::new(),
        )
        .await
        .expect_err("nothing served");

        let labels: Vec<(String, String)> = err
            .chain
            .iter()
            .map(|a| {
                let l = a.label.as_ref().expect("every recorded attempt names what it tried");
                (l.provider_slug.clone(), l.key_label.clone())
            })
            .collect();
        assert_eq!(
            labels,
            vec![("p1".to_string(), "k1".to_string()), ("p2".to_string(), "k2".to_string())],
            "the second attempt's label must be its own, not the first's"
        );
        // And the whole error message now names both, which it could not before increment 13a —
        // and now quotes each provider's own refusal word as well.
        assert_eq!(
            err.describe(),
            "all attempts failed for as-the-caller-typed-it \
             [p1/k1:NOT_FOUND (refused) -> p2/k2:RATE_LIMITED (refused)]"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_empty_plan_fails_rather_than_succeeding_with_nothing() {
        // `:193` throws unconditionally once the loop ends, so zero candidates is a failure.
        let adapter = Scripted::new(vec![]);
        let health = HealthTracker::new();

        let err = execute_image(
            &Always(adapter.clone()),
            &health,
            None,
            image_args(vec![]),
            &Cancel::new(),
        )
        .await
        .expect_err("an empty plan cannot serve");

        assert!(err.chain.is_empty());
        assert!(err.describe().contains("empty plan"), "got: {}", err.describe());
        assert!(adapter.calls().is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_zero_budget_tries_nothing_even_with_candidates_to_try() {
        // `Some(0)` is zero, not "unset". `attempt_budget` exists to keep that distinction, and
        // this is the loop's half of it: the adapter must never be reached.
        let adapter = Scripted::new(vec![ok_reply("AAAA")]);
        let health = HealthTracker::new();
        let mut args = image_args(vec![candidate("p1", "k1", "m1")]);
        args.max_attempts = Some(0);

        let err = execute_image(&Always(adapter.clone()), &health, None, args, &Cancel::new())
            .await
            .expect_err("a budget of zero cannot serve");

        assert!(err.chain.is_empty());
        assert!(adapter.calls().is_empty(), "no candidate may be contacted");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_cancelled_request_breaks_before_the_cap_and_takes_no_slot() {
        // The order at `:165` then `:167`, pinned by the *distinguishing* case: the limiter is
        // saturated too, so a port that checked the cap first would record a RATE_LIMITED skip.
        // Breaking first leaves the chain empty.
        let adapter = Scripted::new(vec![ok_reply("AAAA")]);
        let health = HealthTracker::new();
        let limiter = ProviderLimiter::new(1);
        let _held = limiter.acquire("p1").expect("the slot is free to start with");

        let cancel = Cancel::new();
        cancel.cancel();

        let err = execute_image(
            &Always(adapter.clone()),
            &health,
            Some(&limiter),
            image_args(vec![candidate("p1", "k1", "m1")]),
            &cancel,
        )
        .await
        .expect_err("cancelled");

        assert!(err.chain.is_empty(), "cancellation breaks before anything is recorded");
        assert_eq!(limiter.in_flight_count("p1"), 1, "the held slot is the only one taken");
        assert!(adapter.calls().is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_saturated_provider_is_skipped_and_recorded_as_rate_limited_429() {
        let adapter = Scripted::new(vec![ok_reply("AAAA")]);
        let health = HealthTracker::new();
        let limiter = ProviderLimiter::new(1);
        let _held = limiter.acquire("p1").expect("free to start with");

        let err = execute_image(
            &Always(adapter.clone()),
            &health,
            Some(&limiter),
            image_args(vec![candidate("p1", "k1", "m1"), candidate("p1", "k2", "m2")]),
            &Cancel::new(),
        )
        .await
        .expect_err("both candidates are on the saturated provider");

        assert_eq!(err.chain.len(), 2, "consecutive candidates of one provider are skipped too");
        for attempt in &err.chain {
            assert_eq!(attempt.cls, ErrorClass::RateLimited);
            assert_eq!(
                attempt.status, 429,
                "the class the client-facing Retry-After is built from"
            );
        }
        assert!(adapter.calls().is_empty(), "a saturated provider is never contacted");
        assert_eq!(limiter.in_flight_count("p1"), 1, "a skip must not consume a slot");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_factory_that_resolves_nothing_is_a_transport_failure() {
        let health = HealthTracker::new();

        let err = execute_image(
            &NoneResolved,
            &health,
            None,
            image_args(vec![candidate("p1", "k1", "m1")]),
            &Cancel::new(),
        )
        .await
        .expect_err("no adapter");

        assert_eq!(err.chain.len(), 1);
        assert_eq!(err.chain[0].cls, ErrorClass::Network);
        assert_eq!(err.chain[0].status, 0, "there was no response to name a status from");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_status_bearing_adapter_error_still_records_network_on_the_image_path() {
        // D22. `executeText` classifies a thrown `ManifestHttpError` by its status (`:117-121`);
        // `executeImage`'s `catch {}` (`:186`) names `NETWORK` and nothing else. The port keeps the
        // image path's behaviour. This is the *unreachable* case — `generateImage` returns refusals
        // rather than throwing them (`manifest-interpreter.ts:461`) — so it is pinned here rather
        // than left to be discovered by whoever writes a status-carrying adapter.
        let adapter = Scripted::new(vec![Err(AttemptError::Http {
            status: 429,
            kind: FailureKind::Response,
            retry_after_ms: Some(30_000),
            body: None,
        })]);
        let health = HealthTracker::new();

        let err = execute_image(
            &Always(adapter.clone()),
            &health,
            None,
            image_args(vec![candidate("p1", "k1", "m1")]),
            &Cancel::new(),
        )
        .await
        .expect_err("the adapter did not answer");

        assert_eq!(err.chain[0].cls, ErrorClass::Network, "not RateLimited, whatever it carried");
        assert_eq!(err.chain[0].status, 0, "and the status is discarded with it");
        assert_eq!(err.chain[0].retry_after_ms, None, "so is the wait it named");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_image_refusal_cools_its_key_by_the_floor_not_the_named_wait() {
        // D22, the reachable half. `ImageAttemptResult` is `{ok, status, errorBody?}`
        // (`manifest-interpreter.ts:57-60`) — there is nowhere for a `Retry-After` to travel — so
        // `:184-185` records an outcome with no wait and `recordResult` falls through to the floor.
        // A `429 Retry-After: 30` on the image path therefore retries after one second, which is
        // the failure the text path's fix describes at `:126-128`, one path away.
        //
        // Asserted against the clock rather than a captured `now`, because the loop reads its own
        // (`record_result`'s `now` parameter is the port of the TypeScript's `Date.now()` default).
        // The bound is the point: had a named wait survived, the cooldown would be ~30 s out.
        let adapter = Scripted::new(vec![refusal(429)]);
        let health = HealthTracker::new();

        execute_image(
            &Always(adapter.clone()),
            &health,
            None,
            image_args(vec![candidate("p1", "k1", "m1")]),
            &Cancel::new(),
        )
        .await
        .expect_err("refused");

        let cooled_until = health.keys()["k1"].cooldown_until_ms;
        assert!(cooled_until > 0, "a 429 refusal must cool the key at all");
        assert!(
            cooled_until <= now_ms() + COOLDOWN_FLOOR_MS as i64,
            "the image path cools for the floor only — a named wait has nowhere to travel (D22)"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_permit_comes_back_on_both_the_served_and_the_failed_path() {
        // `:189-191` is a `finally` in the TypeScript. Here it is `Drop`, so the property to pin is
        // that the slot is free afterwards on *both* paths — a port that released only on success
        // would leak a slot per failure until the provider stopped being admitted.
        let limiter = ProviderLimiter::new(1);
        let health = HealthTracker::new();

        let served_adapter = Scripted::new(vec![ok_reply("AAAA")]);
        execute_image(
            &Always(served_adapter),
            &health,
            Some(&limiter),
            image_args(vec![candidate("p1", "k1", "m1")]),
            &Cancel::new(),
        )
        .await
        .expect("served");
        assert_eq!(limiter.in_flight_count("p1"), 0, "the served path released");

        let failed_adapter = Scripted::new(vec![refusal(500)]);
        execute_image(
            &Always(failed_adapter),
            &health,
            Some(&limiter),
            image_args(vec![candidate("p1", "k1", "m1")]),
            &Cancel::new(),
        )
        .await
        .expect_err("failed");
        assert_eq!(limiter.in_flight_count("p1"), 0, "the failed path released too");

        // And the slot is genuinely reusable rather than merely absent from the map.
        let _again = limiter.acquire("p1").expect("the cap admits again");
    }

    // ---------- execute_text: the loop, over doubles ----------
    //
    // `Scripted` above is the *image* half's double and answers text by failing loudly, so the text
    // loop needs its own. The split is the same defence the trait's missing default bodies are: a
    // double that answered both halves could hide a call site that reached the wrong one.

    /// One scripted text attempt, split the way the seam is: the **response** phase, and — only if
    /// it answered — the **stream** it answered with.
    ///
    /// `Err` is a refusal before any byte. `Ok(items)` is a stream whose items are each either a
    /// chunk or a mid-stream break. Keeping the two apart *in the script* is what lets a test say
    /// "this attempt refused" and "this attempt broke after two chunks" without the double having to
    /// guess which one was meant — and the loop's whole classification turns on which it was.
    type TextReply = Result<Vec<Result<String, AttemptError>>, AttemptError>;

    struct TextScripted {
        replies: Mutex<VecDeque<TextReply>>,
        usage: Option<UsageTokens>,
        tool_call: Option<ToolCall>,
        calls: Mutex<Vec<String>>,
    }

    impl TextScripted {
        fn new(replies: Vec<TextReply>) -> Self {
            Self {
                replies: Mutex::new(replies.into()),
                usage: None,
                tool_call: None,
                calls: Mutex::new(Vec::new()),
            }
        }

        fn reporting_usage(mut self, usage: UsageTokens) -> Self {
            self.usage = Some(usage);
            self
        }

        fn calling_tool(mut self, tool_call: ToolCall) -> Self {
            self.tool_call = Some(tool_call);
            self
        }

        fn shared(self) -> Arc<Self> {
            Arc::new(self)
        }

        /// `"<secret_ref>|<model>"` per call — the same shape `Scripted` records, so a test can prove
        /// which *key* and which *native* model id actually reached the wire.
        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl AdapterInstance for TextScripted {
        fn generate_image<'a>(
            &'a self,
            _secret_ref: &'a str,
            _args: ImageArgs,
            _cancel: &'a Cancel,
        ) -> BoxFuture<'a, Result<ImageReply, AttemptError>> {
            // The mirror of `Scripted`'s text half: failing loudly beats answering a question this
            // double was never built to answer.
            Box::pin(async { Err(AttemptError::Transport) })
        }

        fn generate_text<'a>(
            &'a self,
            secret_ref: &'a str,
            mut args: TextArgs<'a>,
            _cancel: &'a Cancel,
        ) -> BoxFuture<'a, Result<BoxStream<'a, Result<String, AttemptError>>, AttemptError>>
        {
            Box::pin(async move {
                self.calls.lock().unwrap().push(format!("{secret_ref}|{}", args.model));

                // An under-scripted test fails loudly rather than passing on a silent default.
                let next = self
                    .replies
                    .lock()
                    .unwrap()
                    .pop_front()
                    .unwrap_or(Err(AttemptError::Transport));
                let items = match next {
                    Err(e) => return Err(e),
                    Ok(items) => items,
                };

                // **The callbacks are taken here and fired at exhaustion, which is the source's
                // stream branch** — `manifest-interpreter.ts:424` for tool calls, `:430` for usage,
                // both in the loop's `finally`. Firing them as the *future* resolves would make this
                // the non-stream branch (`:312-329`) while `args.stream` says otherwise, and the
                // difference is exactly what the loop depends on: `execute_text` reads `usage` after
                // the stream has been drained, not after the future returned.
                let usage = self.usage;
                let tool_call = self.tool_call.clone();
                let mut on_usage = args.on_usage.take();
                let mut on_tool_call = args.on_tool_call.take();

                let mut inner = futures_util::stream::iter(items);
                let mut flushed = false;
                let stream: BoxStream<'a, Result<String, AttemptError>> =
                    Box::pin(futures_util::stream::poll_fn(move |cx| {
                        match inner.poll_next_unpin(cx) {
                            std::task::Poll::Ready(Some(item)) => {
                                std::task::Poll::Ready(Some(item))
                            }
                            std::task::Poll::Ready(None) => {
                                if !flushed {
                                    flushed = true;
                                    if let (Some(cb), Some(tc)) =
                                        (on_tool_call.as_deref_mut(), tool_call.clone())
                                    {
                                        cb(tc);
                                    }
                                    if let (Some(cb), Some(u)) = (on_usage.as_deref_mut(), usage) {
                                        cb(u);
                                    }
                                }
                                std::task::Poll::Ready(None)
                            }
                            std::task::Poll::Pending => std::task::Poll::Pending,
                        }
                    }));
                Ok(stream)
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

    fn text_args<'a>(plan: Vec<Candidate>) -> ExecuteTextArgs<'a> {
        ExecuteTextArgs {
            plan,
            messages: vec![serde_json::json!({"role": "user", "content": "hi"})],
            model: "as-the-caller-typed-it".to_string(),
            stream: true,
            max_tokens: None,
            temperature: None,
            reasoning: None,
            tools: None,
            tool_choice: None,
            response_format: None,
            on_tool_call: None,
            on_usage: None,
            on_finish: None,
            on_reasoning: None,
            max_attempts: None,
            prompt_cache_enabled: false,
        }
    }

    /// A sink and the buffer behind it. Shared rather than borrowed because `execute_text` holds the
    /// sink for the whole call, which would keep a plain `Vec` borrowed past the assertions.
    fn sink() -> (Arc<Mutex<Vec<String>>>, impl FnMut(&str) + Send) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let writer = Arc::clone(&seen);
        (seen, move |chunk: &str| writer.lock().unwrap().push(chunk.to_string()))
    }

    fn usage_sink() -> (Arc<Mutex<Vec<UsageTokens>>>, impl FnMut(UsageTokens) + Send) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let writer = Arc::clone(&seen);
        (seen, move |u: UsageTokens| writer.lock().unwrap().push(u))
    }

    fn tool_sink() -> (Arc<Mutex<Vec<ToolCall>>>, impl FnMut(ToolCall) + Send) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let writer = Arc::clone(&seen);
        (seen, move |tc: ToolCall| writer.lock().unwrap().push(tc))
    }

    /// A stream that answered with these chunks, in order.
    fn chunks_of(parts: &[&str]) -> TextReply {
        Ok(parts.iter().map(|p| Ok((*p).to_string())).collect())
    }

    /// A **response-phase** refusal, as the script records it: the attempt answered with a failure
    /// before a single byte, so the loop may retry it.
    fn refused(status: u16) -> TextReply {
        Err(AttemptError::Http {
            status,
            kind: FailureKind::Response,
            retry_after_ms: None,
            body: None,
        })
    }

    /// A **mid-stream** break, as the script records it: one item of an otherwise-answered stream.
    /// The type is the *stream's*, not the script's — that is the two-phase split written down.
    fn broke(status: u16) -> Result<String, AttemptError> {
        Err(AttemptError::Http {
            status,
            kind: FailureKind::MidStream,
            retry_after_ms: None,
            body: None,
        })
    }

    /// The same error value, for comparing against what the loop carried out. `AttemptError` is
    /// `PartialEq` precisely so a test can assert the *original* travelled rather than a summary.
    fn http_error(status: u16, kind: FailureKind) -> AttemptError {
        AttemptError::Http { status, kind, retry_after_ms: None, body: None }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_first_candidate_that_streams_serves_and_the_rest_are_never_tried() {
        let adapter = TextScripted::new(vec![chunks_of(&["Hel", "lo"])]).shared();
        let health = HealthTracker::new();
        let (seen, mut on_chunk) = sink();

        let served = execute_text(
            &Always(adapter.clone()),
            &health,
            None,
            text_args(vec![candidate("p1", "k1", "m1"), candidate("p2", "k2", "m2")]),
            &Cancel::new(),
            &mut on_chunk,
        )
        .await
        .expect("the first candidate streams");

        assert_eq!(served.candidate.provider.id, "p1");
        assert_eq!(*seen.lock().unwrap(), vec!["Hel".to_string(), "lo".to_string()], "in order");
        assert!(served.attempts.is_empty(), "nothing failed before the success");
        assert_eq!(adapter.calls().len(), 1, "a served request must not try the rest of the plan");
        assert_eq!(served.usage, None, "this script reported none");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_native_model_id_is_what_reaches_a_text_adapter_not_the_requested_name() {
        // The same rule as the image path (`:176`): `c.model.nativeId` is sent and `args.model` is
        // only ever used to *name* the failure. A port that sent the requested name would pass every
        // other test in this block.
        let adapter = TextScripted::new(vec![chunks_of(&["x"])]).shared();
        let health = HealthTracker::new();
        let (_seen, mut on_chunk) = sink();

        execute_text(
            &Always(adapter.clone()),
            &health,
            None,
            text_args(vec![candidate("p1", "k1", "gpt-4o")]),
            &Cancel::new(),
            &mut on_chunk,
        )
        .await
        .expect("served");

        assert_eq!(adapter.calls(), vec!["key:p1:k1|gpt-4o".to_string()]);
        assert!(
            !adapter.calls()[0].contains("as-the-caller-typed-it"),
            "the requested name must not reach the wire"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_response_phase_refusal_advances_and_is_recorded_with_its_status() {
        let adapter = TextScripted::new(vec![
            Err(AttemptError::Http {
                status: 429,
                kind: FailureKind::Response,
                retry_after_ms: Some(30_000),
                body: None,
            }),
            chunks_of(&["ok"]),
        ])
        .shared();
        let health = HealthTracker::new();
        let (seen, mut on_chunk) = sink();

        let served = execute_text(
            &Always(adapter.clone()),
            &health,
            None,
            text_args(vec![candidate("p1", "k1", "m1"), candidate("p2", "k2", "m2")]),
            &Cancel::new(),
            &mut on_chunk,
        )
        .await
        .expect("the second candidate streams");

        assert_eq!(served.candidate.provider.id, "p2");
        assert_eq!(served.attempts.len(), 1, "the refusal is reported");
        assert_eq!(served.attempts[0].cls, ErrorClass::RateLimited);
        assert_eq!(served.attempts[0].status, 429, "the refusal keeps its status");
        assert_eq!(*seen.lock().unwrap(), vec!["ok".to_string()]);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_mid_stream_break_is_midstream_and_does_not_try_the_next_candidate() {
        // `:112-116`. The consumer already holds text, so re-running the attempt would show it the
        // text twice. The distinguishing case is a plan with somewhere to go: a port that advanced
        // would serve from `p2` and report no failure at all.
        let adapter =
            TextScripted::new(vec![Ok(vec![Ok("half".to_string()), broke(200)])]).shared();
        let health = HealthTracker::new();
        let (seen, mut on_chunk) = sink();

        let failure = execute_text(
            &Always(adapter.clone()),
            &health,
            None,
            text_args(vec![candidate("p1", "k1", "m1"), candidate("p2", "k2", "m2")]),
            &Cancel::new(),
            &mut on_chunk,
        )
        .await
        .expect_err("the break is not retryable");

        match failure {
            TextFailure::MidStream { error, served, attempts, .. } => {
                assert_eq!(served.provider.id, "p1", "the break names who had already served");
                assert_eq!(
                    error,
                    http_error(200, FailureKind::MidStream),
                    "the original error travels, not a classification"
                );
                assert_eq!(attempts.len(), 1, "the break is still in the chain");
                // Mid-stream is `ParseError` whatever the status — the status here is `200`, because
                // the *request* succeeded and the *stream* broke.
                assert_eq!(attempts[0].cls, ErrorClass::ParseError);
                assert_eq!(attempts[0].status, 200);
            }
            other => panic!("expected MidStream, got {other:?}"),
        }
        assert_eq!(*seen.lock().unwrap(), vec!["half".to_string()], "the text it did get is kept");
        assert_eq!(adapter.calls().len(), 1, "a mid-stream break must not be retried");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_same_status_is_a_refusal_or_a_break_depending_on_which_phase_threw() {
        // The seam's two phases (`AdapterInstance::generate_text`), seen from the loop: two
        // identical `AttemptError` values, opposite handling. A port that classified by status alone
        // would retry the second and show the consumer its text twice.
        let response = TextScripted::new(vec![refused(429), chunks_of(&["second"])]).shared();
        let health = HealthTracker::new();
        let (seen, mut on_chunk) = sink();

        let served = execute_text(
            &Always(response),
            &health,
            None,
            text_args(vec![candidate("p1", "k1", "m1"), candidate("p2", "k2", "m2")]),
            &Cancel::new(),
            &mut on_chunk,
        )
        .await
        .expect("the second candidate streams");
        assert_eq!(served.candidate.provider.id, "p2", "a response-phase 429 advances");
        assert_eq!(*seen.lock().unwrap(), vec!["second".to_string()]);

        let mid = TextScripted::new(vec![Ok(vec![Ok("first".to_string()), broke(429)])]).shared();
        let health = HealthTracker::new();
        let (seen, mut on_chunk) = sink();

        let failure = execute_text(
            &Always(mid.clone()),
            &health,
            None,
            text_args(vec![candidate("p1", "k1", "m1"), candidate("p2", "k2", "m2")]),
            &Cancel::new(),
            &mut on_chunk,
        )
        .await
        .expect_err("the mid-stream 429 rethrows");

        assert!(matches!(failure, TextFailure::MidStream { .. }), "got {failure:?}");
        assert_eq!(mid.calls().len(), 1, "and it is not retried");
        assert_eq!(*seen.lock().unwrap(), vec!["first".to_string()]);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn every_attempt_the_text_loop_records_names_the_provider_and_key_it_tried() {
        // The label is attached at three separate `labelled(..)` call sites on this path — the
        // saturation skip, the transport failure, and the classified refusal — and each is its own
        // statement. Labelling only the refusal would leave the ledger chain's first entries
        // anonymous, and nothing else in this module would notice: the classes and the statuses
        // are all still right.
        let adapter = TextScripted::new(vec![refused(503), chunks_of(&["served"])]).shared();
        let health = HealthTracker::new();
        let limiter = ProviderLimiter::new(1);
        // Hold p0's only slot so its candidate is skipped rather than called.
        let _held = limiter.acquire("p0").expect("free to start with");
        let (_seen, mut on_chunk) = sink();

        let served = execute_text(
            &Always(adapter.clone()),
            &health,
            Some(&limiter),
            text_args(vec![
                candidate("p0", "skipped", "m0"),
                candidate("p1", "k1", "m1"),
                candidate("p2", "k2", "m2"),
            ]),
            &Cancel::new(),
            &mut on_chunk,
        )
        .await
        .expect("the third candidate streams");

        let labels: Vec<(String, String, ErrorClass)> = served
            .attempts
            .iter()
            .map(|a| {
                let l = a.label.as_ref().expect("every recorded attempt names what it tried");
                (l.provider_slug.clone(), l.key_label.clone(), a.cls)
            })
            .collect();
        assert_eq!(
            labels,
            vec![
                ("p0".to_string(), "skipped".to_string(), ErrorClass::RateLimited),
                ("p1".to_string(), "k1".to_string(), ErrorClass::ServerError),
            ],
            "in the order they were tried, each with its own provider and key"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_saturated_provider_is_skipped_on_the_text_path_and_recorded_rate_limited() {
        let adapter = TextScripted::new(vec![chunks_of(&["x"])]).shared();
        let health = HealthTracker::new();
        let limiter = ProviderLimiter::new(1);
        let _held = limiter.acquire("p1").expect("free to start with");
        let (_seen, mut on_chunk) = sink();

        let failure = execute_text(
            &Always(adapter.clone()),
            &health,
            Some(&limiter),
            text_args(vec![candidate("p1", "k1", "m1"), candidate("p1", "k2", "m2")]),
            &Cancel::new(),
            &mut on_chunk,
        )
        .await
        .expect_err("both candidates are on the saturated provider");

        match failure {
            TextFailure::AllAttemptsFailed { error, .. } => {
                assert_eq!(error.chain.len(), 2, "consecutive candidates of one provider too");
                for attempt in &error.chain {
                    assert_eq!(attempt.cls, ErrorClass::RateLimited);
                    assert_eq!(attempt.status, 429);
                }
            }
            other => panic!("expected AllAttemptsFailed, got {other:?}"),
        }
        assert!(adapter.calls().is_empty(), "a saturated provider is never contacted");
        assert_eq!(limiter.in_flight_count("p1"), 1, "a skip must not consume a slot");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_zero_budget_tries_nothing_on_the_text_path_either() {
        // `Some(0)` is zero, not "unset" — the loop's half of what `attempt_budget` pins.
        let adapter = TextScripted::new(vec![chunks_of(&["x"])]).shared();
        let health = HealthTracker::new();
        let (_seen, mut on_chunk) = sink();
        let mut args = text_args(vec![candidate("p1", "k1", "m1")]);
        args.max_attempts = Some(0);

        let failure = execute_text(
            &Always(adapter.clone()),
            &health,
            None,
            args,
            &Cancel::new(),
            &mut on_chunk,
        )
        .await
        .expect_err("a budget of zero cannot serve");

        match failure {
            TextFailure::AllAttemptsFailed { error, .. } => assert!(error.chain.is_empty()),
            other => panic!("expected AllAttemptsFailed, got {other:?}"),
        }
        assert!(adapter.calls().is_empty(), "no candidate may be contacted");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_cancelled_request_returns_cancelled_rather_than_all_attempts_failed() {
        // `:80`/`:133`. The source `return`s from the generator, so no `AllAttemptsFailedError` is
        // raised, and the caller writes a different ledger row for each (`:451`). Collapsing the two
        // would make "cancelled" indistinguishable from "tried and lost".
        let adapter = TextScripted::new(vec![chunks_of(&["x"])]).shared();
        let health = HealthTracker::new();
        let (_seen, mut on_chunk) = sink();
        let cancel = Cancel::new();
        cancel.cancel();

        let failure = execute_text(
            &Always(adapter.clone()),
            &health,
            None,
            text_args(vec![candidate("p1", "k1", "m1")]),
            &cancel,
            &mut on_chunk,
        )
        .await
        .expect_err("cancelled");

        assert!(matches!(failure, TextFailure::Cancelled { .. }), "got {failure:?}");
        assert!(adapter.calls().is_empty(), "cancellation breaks before the adapter is reached");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn exhausting_the_plan_reports_every_attempt_in_order() {
        let adapter = TextScripted::new(vec![
            refused(404),
            Err(AttemptError::Transport),
            Err(AttemptError::Http {
                status: 429,
                kind: FailureKind::Response,
                retry_after_ms: Some(1_500),
                body: None,
            }),
        ])
        .shared();
        let health = HealthTracker::new();
        let (_seen, mut on_chunk) = sink();

        let failure = execute_text(
            &Always(adapter.clone()),
            &health,
            None,
            text_args(vec![
                candidate("p1", "k1", "m1"),
                candidate("p2", "k2", "m2"),
                candidate("p3", "k3", "m3"),
            ]),
            &Cancel::new(),
            &mut on_chunk,
        )
        .await
        .expect_err("nothing served");

        match failure {
            TextFailure::AllAttemptsFailed { error, .. } => {
                let classes: Vec<ErrorClass> = error.chain.iter().map(|a| a.cls).collect();
                assert_eq!(
                    classes,
                    vec![ErrorClass::NotFound, ErrorClass::Network, ErrorClass::RateLimited],
                    "in the order they were tried"
                );
                assert_eq!(
                    error.model, "as-the-caller-typed-it",
                    "the caller's own name, not the native id that was sent"
                );
                // **Not zero**, and that is the text path's half of D22: a text attempt *can* name a
                // wait, so the client is told the shortest one. The image path cannot.
                assert_eq!(error.min_retry_after_ms(), 1_500);
            }
            other => panic!("expected AllAttemptsFailed, got {other:?}"),
        }
        assert_eq!(adapter.calls().len(), 3);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_permit_comes_back_on_every_text_path() {
        // The text loop has more exits than the image one — served, exhausted, mid-stream,
        // cancelled — so the `Drop` that releases the slot has more ways to leak.
        let limiter = ProviderLimiter::new(1);
        let health = HealthTracker::new();
        let (_seen, mut on_chunk) = sink();
        let plan = || vec![candidate("p1", "k1", "m1")];

        let served = TextScripted::new(vec![chunks_of(&["x"])]).shared();
        execute_text(
            &Always(served),
            &health,
            Some(&limiter),
            text_args(plan()),
            &Cancel::new(),
            &mut on_chunk,
        )
        .await
        .expect("served");
        assert_eq!(limiter.in_flight_count("p1"), 0, "the served path released");

        let exhausted = TextScripted::new(vec![Err(AttemptError::Transport)]).shared();
        execute_text(
            &Always(exhausted),
            &health,
            Some(&limiter),
            text_args(plan()),
            &Cancel::new(),
            &mut on_chunk,
        )
        .await
        .expect_err("exhausted");
        assert_eq!(limiter.in_flight_count("p1"), 0, "the exhausted path released");

        let broke = TextScripted::new(vec![Ok(vec![broke(200)])]).shared();
        execute_text(
            &Always(broke),
            &health,
            Some(&limiter),
            text_args(plan()),
            &Cancel::new(),
            &mut on_chunk,
        )
        .await
        .expect_err("mid-stream");
        assert_eq!(limiter.in_flight_count("p1"), 0, "the mid-stream path released");

        // Cancelled takes nothing at all, because the break precedes the acquire.
        let cancel = Cancel::new();
        cancel.cancel();
        let never = TextScripted::new(vec![chunks_of(&["x"])]).shared();
        execute_text(
            &Always(never),
            &health,
            Some(&limiter),
            text_args(plan()),
            &cancel,
            &mut on_chunk,
        )
        .await
        .expect_err("cancelled");
        assert_eq!(limiter.in_flight_count("p1"), 0, "the cancelled path took nothing");

        let _again = limiter.acquire("p1").expect("the cap admits again");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn usage_reaches_both_the_result_and_the_caller_callback() {
        // `:97`. The engine's own `onUsage` does double duty — it fills the box the ledger reads
        // *and* forwards to the caller's callback. Dropping the caller's is how every gateway
        // response came to report `usage: null` on requests that had usage, so both halves are
        // asserted rather than only the one the ledger happens to read.
        let reported = UsageTokens::new(120, 34, Some(64));
        let adapter = TextScripted::new(vec![chunks_of(&["x"])]).reporting_usage(reported).shared();
        let health = HealthTracker::new();
        let (_seen, mut on_chunk) = sink();
        let (forwarded, mut on_usage) = usage_sink();
        let mut args = text_args(vec![candidate("p1", "k1", "m1")]);
        args.on_usage = Some(&mut on_usage);

        let served = execute_text(
            &Always(adapter.clone()),
            &health,
            None,
            args,
            &Cancel::new(),
            &mut on_chunk,
        )
        .await
        .expect("served");

        assert_eq!(served.usage, Some(reported), "the box the ledger reads");
        assert_eq!(*forwarded.lock().unwrap(), vec![reported], "and the caller's own callback");
        // `cached_tokens` is the field migration 0015 exists to take, so it has to survive the
        // callback rather than being flattened to the two counts `BridgeMsg::Usage` carries (D23).
        assert_eq!(served.usage.unwrap().cached_for_ledger(), Some(64));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_tool_call_passes_through_untouched_and_carries_no_chunk() {
        // `:97` passes the caller's `onToolCall` through unwrapped. Tool calls cannot ride in the
        // chunk stream — a chunk is a string — so a port that forgot this callback would answer a
        // tool-call turn with an empty body and no error at all.
        let call = ToolCall {
            id: Some("call_1".to_string()),
            name: Some("get_weather".to_string()),
            arguments: Some("{\"city\":\"Dhaka\"}".to_string()),
            raw: None,
        };
        let adapter = TextScripted::new(vec![Ok(vec![])]).calling_tool(call.clone()).shared();
        let health = HealthTracker::new();
        let (seen, mut on_chunk) = sink();
        let (tool_calls, mut on_tool_call) = tool_sink();
        let mut args = text_args(vec![candidate("p1", "k1", "m1")]);
        args.on_tool_call = Some(&mut on_tool_call);

        let served = execute_text(
            &Always(adapter.clone()),
            &health,
            None,
            args,
            &Cancel::new(),
            &mut on_chunk,
        )
        .await
        .expect("a tool-call turn still serves");

        assert_eq!(*tool_calls.lock().unwrap(), vec![call], "byte-for-byte, not re-derived");
        assert!(seen.lock().unwrap().is_empty(), "the text is empty on a tool-call turn");
        assert_eq!(served.candidate.provider.id, "p1");
    }

    /// **The two `#[allow]`s on the text path rest on this arithmetic, so it is asserted.**
    ///
    /// Clippy proposes boxing the error — `large_enum_variant` on `TextFailure`, `result_large_err`
    /// on `execute_text`. Both lints assume a large `Err` makes the `Result` large and is paid on the
    /// happy path. Here it is not: `Candidate` is 536 bytes and **both** arms carry one by value
    /// (`TextSuccess.candidate`, `TextFailure::MidStream.served`), so the `Result` is the payload's
    /// size with or without the box — `TextSuccess` 592, `TextFailure` 616, and boxing `served`
    /// would save 16 of those 616 bytes while adding a heap allocation to every failure, including
    /// the mid-stream one where the caller already holds text.
    ///
    /// The image path is the control, and it is the clearest evidence: its `Err` is 48 bytes, clippy
    /// says nothing about it, and its `Result` is *still* 608 bytes — because the size comes from
    /// `ImageSuccess.candidate`. Same 536-byte payload, same ~600-byte `Result`, no lint.
    ///
    /// If a future field makes the error dominate the payload, this fails and the allowances have to
    /// be re-argued rather than inherited.
    #[test]
    fn the_text_results_size_comes_from_the_payload_not_from_the_error() {
        let payload = std::mem::size_of::<TextSuccess>();
        let error = std::mem::size_of::<TextFailure>();
        let image = std::mem::size_of::<ImageSuccess>();

        assert!(
            error <= payload + 64,
            "TextFailure ({error}) has outgrown TextSuccess ({payload}); boxing it may now be the \
             cheaper fix, so the two `#[allow]`s need re-arguing"
        );
        assert!(
            image >= payload,
            "the image path's Ok type ({image}) is the control: it is at least as large as the text \
             path's, which is why `result_large_err` cannot be about the text path's Err"
        );
    }
}
