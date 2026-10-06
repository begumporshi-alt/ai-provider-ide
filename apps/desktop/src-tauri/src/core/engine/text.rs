//! The text loop — the hot path (D98 phase 5): plan walked to one streamed answer, with usage
//! forwarding (A1), the mapped finish reason (D86), the reasoning knob (D87), the failover chain,
//! and the same-key 5xx re-probe. The seam comments inside `execute_text` are measurement records —
//! do not clean them up.
use futures_util::StreamExt;
use serde_json::Value;
use std::collections::VecDeque;
use std::time::{Duration, Instant};

use crate::core::adapter::{
    AdapterFactory, Cancel, ReasoningEffort, StreamObservation, TextArgs, ToolCall,
};
use crate::core::limiter::ProviderLimiter;
use crate::core::planner::Candidate;
use crate::core::usage::UsageTokens;

use super::attempt::{
    attempt_budget, attempt_disposition, attempt_outcome, candidate_is_affordable, labelled,
    records_key_health, saturated_outcome, transport_outcome, AttemptDisposition, AttemptError,
    AttemptOutcome, SERVER_ERROR_RETRY_BACKOFF,
};
use super::health::HealthTracker;
use super::taxonomy::{ErrorClass, COOLDOWN_FLOOR_MS};
use super::{now_ms, AllAttemptsFailed};

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
        // **The plan is a queue, not an iterator, because of the same-key re-probe.** Everything
        // else reads exactly as the `for` it replaced: one `pop_front` per attempt, drained left to
        // right. The flag rides *with* the candidate — being re-probed is a per-candidate fact, not
        // a loop fact — so a re-queued candidate comes back already marked and cannot be probed
        // twice.
        let mut plan: VecDeque<(Candidate, bool)> =
            args.plan.into_iter().take(budget).map(|c| (c, false)).collect();
        while let Some((candidate, reprobed)) = plan.pop_front() {
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
                // Read before the push: an outcome is not `Copy`, and the `Next` arm below decides
                // the re-probe from the class and wait it recorded.
                let (outcome_cls, outcome_status, outcome_retry_after) =
                    (outcome.cls, outcome.status, outcome.retry_after_ms);
                if records_key_health(disposition) {
                    health.record_result(
                        &candidate.key.id,
                        outcome_cls,
                        outcome_retry_after,
                        now_ms(),
                    );
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
                    AttemptDisposition::Next => {
                        // **The same-key re-probe: the plan just ran out on a 5xx.** A plan with a
                        // next candidate fails over immediately — a healthy provider beats a wait
                        // on a wobbling one. With none, the only thing failover could do is give
                        // up, so the wait-and-redial any competent client performs happens here
                        // instead: once per candidate, only before anything reached the sink, and
                        // only for `SERVER_ERROR` — the class the egress layer already treats as
                        // "the failure is real, but what it predicts may not be" (see
                        // `SERVER_ERROR_RETRY_BACKOFF`).
                        //
                        // **The wait is the provider's own `Retry-After` when it named one**,
                        // floored like every other named wait, and 2 s otherwise. **Admission is
                        // the plan budget's own rule**: a re-probe is a candidate start, so it is
                        // priced by `candidate_is_affordable` with the wait added to the elapsed
                        // time — one full `UPSTREAM_HEADER_TIMEOUT` must still fit, which is what
                        // keeps this from becoming the 2026-09-27 overrun again. A provider that
                        // names a wait too long to afford simply does not get a re-probe.
                        //
                        // The failed attempt above is already in the chain, so a ledger row shows
                        // the re-probe as the second attempt it is.
                        let wait = outcome_retry_after
                            .filter(|&ms| ms > 0)
                            .map(|ms| Duration::from_millis(ms.max(COOLDOWN_FLOOR_MS)))
                            .unwrap_or(SERVER_ERROR_RETRY_BACKOFF);
                        if outcome_cls == ErrorClass::ServerError
                            && plan.is_empty()
                            && !reprobed
                            && !cancel.is_cancelled()
                            && candidate_is_affordable(plan_started.elapsed() + wait, false)
                        {
                            tracing::info!(
                                provider = %candidate.provider.slug,
                                key = %candidate.key.label,
                                status = outcome_status,
                                wait_ms = wait.as_millis() as u64,
                                "plan exhausted on SERVER_ERROR — re-probing the same key once",
                            );
                            tokio::time::sleep(wait).await;
                            plan.push_front((candidate, true));
                        }
                        continue;
                    }
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
