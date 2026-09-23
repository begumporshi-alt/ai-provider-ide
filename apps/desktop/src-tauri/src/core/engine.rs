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
//! **`Candidate` now exists; the label is still absent.** `AttemptOutcome` in TypeScript also
//! carries a `Candidate` (provider + key + model) so a failed chain can name what it tried
//! (`execution-engine.ts:199`). Increment 7 lands the type — see its definition below — so the gap
//! is no longer blocked by a missing shape. It is **not closed**, because in Rust the faithful
//! shape costs more than it does in JavaScript: the three fields are owned rows, so carrying one
//! in every `AttemptOutcome` clones three rows per failed attempt where the TypeScript copies a
//! reference. The cheap faithful alternative is to carry the `slug/label` string that `describe`
//! actually reads, and that is a decision rather than a port step. So the label stays absent: the
//! gap is narrowed in increment 4, unblocked in 7, and open.
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

use crate::core::adapter::{AdapterFactory, Cancel, ImageArgs};
use crate::core::limiter::ProviderLimiter;
use crate::core::persist::{ApiKeyRow, ModelRow, ProviderRow};

/// The shortest cooldown a rate-limited key is ever given, in milliseconds.
///
/// A provider that names a sub-second `Retry-After`, or none at all, still gets this, so a client
/// is never told to retry "now" into a window that has not closed.
///
/// **Two consumers, and they must agree.** `HealthTracker::record_result` cools a key for at
/// least this long, and `min_retry_after_ms` floors the value the client is *told* by the same
/// amount. The TypeScript original exports this for exactly that reason — "two hardcoded 1000s
/// would be free to drift apart" (`health-tracker.ts:23-25`). The port keeps one constant.
///
/// Note this is **not** "one second" and must not be used as a unit conversion. The header path
/// converts milliseconds to whole seconds (`gateway::cooldown_secs`, `div_ceil(1000).max(1)`);
/// that `1000` is milliseconds-per-second and is a different fact that happens to share the
/// value. Coupling them would mean a change to the cooldown floor silently rescaling every
/// `Retry-After` header.
pub const COOLDOWN_FLOOR_MS: u64 = 1000;

/// The attempt loop's only classification (TS `errors.ts` §2.10): rotate key, fail over provider,
/// or call it drift.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorClass {
    /// 401/403 — this key is bad; the next key of the same provider may work.
    AuthFailed,
    /// 429 — cooled, not burned.
    RateLimited,
    /// 404, or a 400 whose body says the model does not exist.
    NotFound,
    /// 400 otherwise — the request or the manifest is wrong.
    BadRequestSchema,
    /// A 2xx whose body could not be parsed, or a stream that broke mid-flight.
    ParseError,
    /// 5xx — the provider is unwell; another provider is the better answer.
    ServerError,
    /// 408.
    Timeout,
    /// No usable status: a transport failure, or a status this taxonomy does not name.
    Network,
    /// 2xx.
    Ok,
}

/// A body signal that overrides what the status alone would say.
///
/// Only `400` consults it, and only to distinguish "your request is malformed" from "that model
/// does not exist" — the latter is drift and must not burn a key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BodyHint {
    /// The body says the request does not match the schema.
    Schema,
    /// The body says the model or endpoint is not there.
    NotFound,
}

/// Every class, so completeness is checkable rather than assumed.
///
/// `every_class_has_the_spelling_the_typescript_uses` walks this list against the TypeScript
/// union spelled out verbatim. A variant added without a spelling fails there — which is the
/// point: the wire spellings are a cross-language contract, and a new class that quietly
/// rendered as `{:?}` would be a spelling nobody agreed to.
pub const ALL_CLASSES: [ErrorClass; 9] = [
    ErrorClass::AuthFailed,
    ErrorClass::RateLimited,
    ErrorClass::NotFound,
    ErrorClass::BadRequestSchema,
    ErrorClass::ParseError,
    ErrorClass::ServerError,
    ErrorClass::Timeout,
    ErrorClass::Network,
    ErrorClass::Ok,
];

impl ErrorClass {
    /// Errors that count toward provider drift (TS `DRIFT_CLASSES`, §2.10).
    ///
    /// Drift is a provider/manifest problem, not a key problem: `HealthTracker` leaves the key's
    /// health alone for these so a good key is not burned by a model-side change.
    pub fn is_drift(self) -> bool {
        matches!(
            self,
            ErrorClass::NotFound
                | ErrorClass::BadRequestSchema
                | ErrorClass::ParseError
                | ErrorClass::AuthFailed
        )
    }

    /// The class's spelling on the wire, matching `errors.ts:5-14` exactly.
    ///
    /// Spelled out rather than derived from `Debug`, because the two are different strings and
    /// only one of them is a contract. `{:?}` yields `RateLimited` where every other surface in
    /// this system — the TypeScript, the audit notes, the docs — says `RATE_LIMITED`. An error
    /// message or a log line that renders the Rust form is a second vocabulary for one concept,
    /// which is how two halves of a port stop agreeing about what they are saying.
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorClass::AuthFailed => "AUTH_FAILED",
            ErrorClass::RateLimited => "RATE_LIMITED",
            ErrorClass::NotFound => "NOT_FOUND",
            ErrorClass::BadRequestSchema => "BAD_REQUEST_SCHEMA",
            ErrorClass::ParseError => "PARSE_ERROR",
            ErrorClass::ServerError => "SERVER_ERROR",
            ErrorClass::Timeout => "TIMEOUT",
            ErrorClass::Network => "NETWORK",
            ErrorClass::Ok => "OK",
        }
    }
}

/// Map an HTTP status, plus an optional body signal, to its class.
///
/// The arms are ordered and the fallthrough is load-bearing: any status this taxonomy does not
/// name — `402`, `418`, a `3xx` — classifies as [`ErrorClass::Network`]. That is the TypeScript
/// behaviour and the tests pin it, because "unknown status is a transport failure" is a
/// decision, not an accident.
pub fn classify(status: u16, body_hint: Option<BodyHint>) -> ErrorClass {
    if (200..300).contains(&status) {
        return ErrorClass::Ok;
    }
    if status == 401 || status == 403 {
        return ErrorClass::AuthFailed;
    }
    if status == 429 {
        return ErrorClass::RateLimited;
    }
    if status == 404 {
        return ErrorClass::NotFound;
    }
    if status == 400 {
        return match body_hint {
            Some(BodyHint::NotFound) => ErrorClass::NotFound,
            _ => ErrorClass::BadRequestSchema,
        };
    }
    if status == 408 {
        return ErrorClass::Timeout;
    }
    if status >= 500 {
        return ErrorClass::ServerError;
    }
    ErrorClass::Network
}

/// Errors where the next **key of the same provider** might work.
///
/// [`ErrorClass::Timeout`] is absent on purpose: the TypeScript original omits it, and a request
/// that timed out is not evidence about the key.
pub fn is_retryable_with_next_key(cls: ErrorClass) -> bool {
    matches!(
        cls,
        ErrorClass::AuthFailed
            | ErrorClass::RateLimited
            | ErrorClass::ServerError
            | ErrorClass::Network
    )
}

/// One failed attempt, as the wait arithmetic needs it.
///
/// TypeScript's version also carries the `Candidate` it tried, for the error message. That type
/// is Phase 3's — see the module note — so this holds only what `min_retry_after_ms` reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AttemptOutcome {
    /// What the failure was classified as.
    pub cls: ErrorClass,
    /// The HTTP status, or `0` when there was no response.
    pub status: u16,
    /// What the provider asked us to wait, when it said so at all.
    pub retry_after_ms: Option<u64>,
}

/// The shortest wait any attempt named, floored at [`COOLDOWN_FLOOR_MS`]; `0` when none named one.
///
/// **Shortest, not longest.** The route planner *drops* keys that are still cooling rather than
/// deprioritising them, so the earliest the next request can be served is the moment the *first*
/// of these keys frees up. Reporting the longest would make the client idle for a key the planner
/// would not have chosen anyway — with keys cooling in 58 s, 42 s and 71 s, the client can be
/// served at 42 s, not 71 s.
///
/// **Every named wait counts, whatever the class.** A `503` carrying `Retry-After: 30` leaves its
/// key technically usable — the tracker only cools on `RateLimited` — but the provider still said
/// it was overloaded, so filtering to `RateLimited` would tell the client to retry in a second
/// straight back into the overload. An attempt that named nothing contributes nothing: it can
/// neither raise nor lower the result.
///
/// Floored, so a provider naming `400 ms` never yields a hint of `0`, which would read to the
/// client as "retry now".
pub fn min_retry_after_ms(attempts: &[AttemptOutcome]) -> u64 {
    let mut shortest: Option<u64> = None;
    for a in attempts {
        // `Some(0)` is treated as unnamed, matching the TypeScript `!a.retryAfterMs` guard.
        let Some(ms) = a.retry_after_ms.filter(|&ms| ms > 0) else {
            continue;
        };
        let floored = ms.max(COOLDOWN_FLOOR_MS);
        shortest = Some(match shortest {
            Some(prev) => prev.min(floored),
            None => floored,
        });
    }
    shortest.unwrap_or(0)
}

/// §3.6: how many candidates one request may try when the caller names no budget.
pub const MAX_ATTEMPTS_DEFAULT: usize = 6;

/// How many of a plan's candidates this request may actually try.
///
/// `None` means "the caller named none" and takes [`MAX_ATTEMPTS_DEFAULT`]. `Some(0)` means
/// **zero**, and the two are not the same thing — which is the whole reason this takes an
/// `Option` rather than an `usize` whose default the caller applies. The TypeScript uses `??`
/// (`execution-engine.ts:73`), so a caller passing `0` gets no attempts at all and the request
/// fails with an empty chain. A port that used `||`, or that pre-parsed an empty string into `0`
/// and then treated `0` as falsy, would silently turn "try nothing" into "try six" — the same
/// shape as the clamp bug where `Number("")` comes out as *unlimited*.
pub fn attempt_budget(plan_len: usize, max_attempts: Option<usize>) -> usize {
    plan_len.min(max_attempts.unwrap_or(MAX_ATTEMPTS_DEFAULT))
}

// ---------- the per-attempt policy ----------
//
// Everything `executeText` decides *between* attempts, as pure functions: what class a caught
// error gets, and what the loop does next. The one thing left out is the adapter call itself,
// which needs `AdapterInstance` — a trait written over `manifest-interpreter.ts`'s types, so it
// cannot land until the adapter layer does. Splitting the policy out means the decisions that are
// easy to get wrong are pinned now, and the Phase 3 loop is left with the I/O.

/// When a provider failure arrived relative to the first byte of the stream.
///
/// The TypeScript carries this as a string literal on `ManifestHttpError`
/// (`manifest-interpreter.ts:210`). It matters because a stream that has already yielded cannot be
/// retried: the consumer would see the text twice.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureKind {
    /// The provider refused the request before any body was read.
    Response,
    /// The failure arrived after the stream had started.
    MidStream,
}

/// A caught attempt failure — the port of `ManifestHttpError | unknown` as `executeText` sees it.
///
/// The TypeScript separates these with `instanceof`, which silently folds every *other* error into
/// the same branch as a transport failure. An enum makes the split exhaustive, so a new failure
/// shape cannot join the port without a decision about which side it belongs on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AttemptError {
    /// The provider answered. `200` is a real value here rather than a placeholder: the sole
    /// mid-stream producer reports `200` because the *request* succeeded and the *stream* broke
    /// (`manifest-interpreter.ts:360`).
    Http {
        status: u16,
        kind: FailureKind,
        /// What the provider asked us to wait, when the header was readable at all.
        retry_after_ms: Option<u64>,
    },
    /// No HTTP answer: a transport failure, a timeout, or an adapter fault.
    Transport,
}

impl AttemptError {
    /// The status the chain and the ledger record, or `0` when there was no answer.
    ///
    /// `0` is the TypeScript's own sentinel (`execution-engine.ts:114`: `e instanceof
    /// ManifestHttpError ? e.status : 0`). A `u16` cannot hold `None`, so the sentinel is part of
    /// the contract rather than a value nobody chose.
    pub fn status_or_zero(&self) -> u16 {
        match self {
            AttemptError::Http { status, .. } => *status,
            AttemptError::Transport => 0,
        }
    }

    /// What the provider asked us to wait, when it said so at all.
    pub fn retry_after_ms(&self) -> Option<u64> {
        match self {
            AttemptError::Http { retry_after_ms, .. } => *retry_after_ms,
            AttemptError::Transport => None,
        }
    }
}

/// The class `executeText` assigns to a caught attempt error — **one rule, spelled once**.
///
/// Three cases, in this order:
///
/// 1. **No answer → `NETWORK`.** There is no status to classify.
/// 2. **Mid-stream → `PARSE_ERROR`, whatever the status.** The failure arrived after the consumer
///    had already been given bytes, so what broke is the *stream*, not the request. The status is
///    deliberately ignored, not merely unused.
/// 3. **Otherwise the status decides** — with one exception: a `2xx` maps to `PARSE_ERROR` rather
///    than `OK`. A provider that answers `200` and then throws has a body we could not read; it is
///    not a request that succeeded.
///
/// **This is the stricter of the two spellings the TypeScript has.** The engine spells this rule
/// twice, and the two disagree for a mid-stream error carrying a non-2xx status:
/// `execution-engine.ts:113` (the already-emitted path) tests only `classify(status) === "OK"`,
/// while `:118` (the not-yet-emitted path) also tests `kind === "mid-stream"`. They agree on every
/// input reachable today, and *only* because the one producer of a mid-stream error hardcodes
/// status `200` (`manifest-interpreter.ts:360`). Rule 2 above is the `:118` spelling, kept because
/// it is the one that holds regardless of the status a future call site passes — and because the
/// emitted path is the one that skips `record_result`, so under the `:113` spelling a mid-stream
/// `429` would classify as `RateLimited` and then never cool its key. See D19.
pub fn classify_attempt_error(e: &AttemptError) -> ErrorClass {
    match e {
        AttemptError::Transport => ErrorClass::Network,
        AttemptError::Http { status, kind, .. } => {
            if *kind == FailureKind::MidStream {
                return ErrorClass::ParseError;
            }
            match classify(*status, None) {
                ErrorClass::Ok => ErrorClass::ParseError,
                other => other,
            }
        }
    }
}

/// What the loop does after an attempt failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttemptDisposition {
    /// Fail loud: rethrow the original error and try no further candidate.
    Rethrow,
    /// Stop quietly: the caller cancelled. **No `AllAttemptsFailed` is raised** — the `return` at
    /// `execution-engine.ts:133` leaves the loop before the terminal throw at `:141`, so an
    /// aborted request ends in an empty stream rather than an error.
    Stop,
    /// Record the outcome and advance to the next candidate.
    Next,
}

/// The loop's decision after an attempt failed.
///
/// **`emitted` is checked before `aborted`, and that order is load-bearing.** Once a byte has
/// reached the consumer the request can neither be retried nor quietly abandoned — the caller
/// holds partial output, so the only honest end is the error itself. A cancelled stream that had
/// already produced text therefore *rethrows* rather than stopping.
pub fn attempt_disposition(emitted: bool, aborted: bool) -> AttemptDisposition {
    if emitted {
        AttemptDisposition::Rethrow
    } else if aborted {
        AttemptDisposition::Stop
    } else {
        AttemptDisposition::Next
    }
}

/// The outcome the loop records for a failed attempt.
///
/// **The retry hint is dropped on the one path that cannot act on it.** The mid-stream path
/// rethrows, so a wait it will never honour would be noise in the chain — and the TypeScript says
/// so by omission (`execution-engine.ts:114` pushes `{candidate, cls, status}` with no
/// `retryAfterMs`), while both other paths carry it (`:122-130`).
pub fn attempt_outcome(e: &AttemptError, disposition: AttemptDisposition) -> AttemptOutcome {
    AttemptOutcome {
        cls: classify_attempt_error(e),
        status: e.status_or_zero(),
        retry_after_ms: match disposition {
            AttemptDisposition::Rethrow => None,
            _ => e.retry_after_ms(),
        },
    }
}

/// Whether a failed attempt cools its key.
///
/// The mid-stream path records the outcome in the chain but **not** in key health: the TypeScript
/// pushes to `fallbackChain` and throws, never reaching `recordResult`
/// (`execution-engine.ts:113-116`). Skipping it is safe today only because a mid-stream failure
/// classifies as `PARSE_ERROR` and [`HealthTracker::record_result`] ignores the drift classes —
/// a dependency between two functions, so
/// `a_rethrown_failure_is_always_a_drift_class_so_skipping_health_cannot_lose_a_cooldown` states
/// it rather than leaving it implied.
pub fn records_key_health(disposition: AttemptDisposition) -> bool {
    !matches!(disposition, AttemptDisposition::Rethrow)
}

/// The outcome a candidate gets when its provider is already at its in-flight cap.
///
/// Audit R3's contract with [`crate::core::limiter`], written down because the limiter has no
/// consumer in the shipping gateway yet. The class and the status are not decorative:
/// `RATE_LIMITED` is the class [`HealthTracker::record_result`] cools a key on, and `429` is what
/// the ledger shows, so a caller inventing its own pair would change both.
///
/// **It is recorded in the chain and deliberately *not* in key health.** The provider is busy, not
/// the key bad; cooling the key would punish it for a limit the provider imposed on everyone.
pub fn saturated_outcome() -> AttemptOutcome {
    AttemptOutcome { cls: ErrorClass::RateLimited, status: 429, retry_after_ms: None }
}

/// What the loop does with one candidate before calling the adapter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CandidateGate {
    /// Try it.
    Try,
    /// Skip it and advance: the provider is at its in-flight cap.
    SkipSaturated,
    /// Stop: the caller cancelled.
    Stop,
}

/// The gate at the top of each iteration of `executeText`'s loop.
///
/// **Cancellation is checked before the permit is taken** (`execution-engine.ts:80` precedes
/// `:83`), so a cancelled request does not consume a slot even when one is free. A port that
/// acquired first and checked after would hold a permit on a request that is already over.
///
/// `saturated` is true only when a limiter is configured *and* refused. An unconfigured limiter is
/// not a saturated one — conflating them would turn R3's opt-in behaviour into a mandatory one.
pub fn candidate_gate(aborted: bool, saturated: bool) -> CandidateGate {
    if aborted {
        CandidateGate::Stop
    } else if saturated {
        CandidateGate::SkipSaturated
    } else {
        CandidateGate::Try
    }
}

// ---------- the plan, and the image loop over it ----------

/// One planned attempt: which provider to call, with which key, for which model.
///
/// The Rust home of `route-planner.ts`'s `Candidate` (`:13-17`). It lives in this module rather
/// than in a `route_planner` of its own because the planner itself is not ported yet, and a module
/// named for the planner that held only its type would promise more than it carries. The three row
/// types are already the crate's (`persist.rs:33`, `:176`, `:321`), so the shape needs nothing new.
///
/// **The name was taken, and the other holder gave way.** `context_scope.rs` already had a
/// `Candidate` — a *recalled memory* headed for the prompt, `{id, layer, text, pinned}` — now
/// `context_scope::MemoryItem`. The TypeScript is this port's reference and cannot move, so the
/// port keeps the source's name and the Rust-only type is the one renamed. Recorded as D21.
///
/// **`Debug`, and only `Debug`.** The three row types carried `Serialize`/`Deserialize` alone, so
/// this meant adding one derive to each — done, because the buyer is concrete rather than
/// speculative: `Result::expect_err` requires `Debug` on the **success** type, which is how the
/// loop's failure tests are written. `Clone` and `PartialEq` are deliberately still absent; see the
/// module note for why `AttemptOutcome` does not carry a candidate yet.
#[derive(Debug)]
pub struct Candidate {
    pub provider: ProviderRow,
    pub key: ApiKeyRow,
    pub model: ModelRow,
}

/// What the image path records when the adapter did not answer at all.
///
/// The TypeScript's `catch {}` arm (`execution-engine.ts:187`) names `NETWORK` and status `0`, and
/// **keeps nothing else the error carried** — not the status, not the `Retry-After`. See
/// [`execute_image`] for why that is faithful and what it costs.
pub fn transport_outcome() -> AttemptOutcome {
    AttemptOutcome { cls: ErrorClass::Network, status: 0, retry_after_ms: None }
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
    health: &mut HealthTracker,
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
            attempts.push(saturated_outcome());
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
            Err(_) => transport_outcome(),
            Ok(adapter) => {
                match adapter.generate_image(&candidate.key.secret_ref, image_args, cancel).await {
                    Err(_) => transport_outcome(),
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
                    Ok(reply) => AttemptOutcome {
                        cls: classify(reply.status, None),
                        status: reply.status,
                        retry_after_ms: None,
                    },
                }
            }
        };

        health.record_result(&candidate.key.id, outcome.cls, outcome.retry_after_ms, now_ms());
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

    /// The message the TypeScript builds — minus the part that cannot be built yet.
    ///
    /// The TypeScript names each attempt `<provider.slug>/<key.label>:<cls>`
    /// (`execution-engine.ts:199`). Those two fields live on `Candidate`, which is Phase 3's
    /// type, so this names the class and the status and leaves the provider unnamed. The recorded
    /// gap is therefore narrowed rather than closed: the arithmetic has a home now, the label
    /// still does not.
    pub fn describe(&self) -> String {
        let detail = self
            .chain
            .iter()
            .map(|a| format!("{}:{}", a.cls.as_str(), a.status))
            .collect::<Vec<_>>()
            .join(" -> ");
        // The TypeScript's `detail || "empty plan"`. An empty chain is a real state — reached
        // whenever the budget is zero — and rendering it as `[]` would read as a bug rather than
        // as a budget.
        let detail = if detail.is_empty() { "empty plan".to_string() } else { detail };
        format!("all attempts failed for {} [{}]", self.model, detail)
    }
}

/// Consecutive auth failures before a key is treated as invalid rather than merely unlucky.
pub const AUTH_BREAKER_THRESHOLD: u32 = 3;

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
    /// Too many auth failures in a row: treat the key as invalid, not merely rate-limited.
    pub breaker_open: bool,
}

/// Per-key and per-provider circuit state, kept free of I/O so failover ordering can be tested
/// against it (TS `health-tracker.ts`).
#[derive(Debug, Default)]
pub struct HealthTracker {
    keys: HashMap<String, KeyHealth>,
}

impl HealthTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Whether `key` may be tried at `now_ms`.
    ///
    /// Four independent ways to be unusable, deliberately separate: the persisted status, this
    /// tracker's breaker, this tracker's cooldown, and the key record's **own** `cooldown_until` —
    /// a different field from the in-memory one, and currently unreachable. See
    /// `a_key_cooldown_on_the_record_is_honoured`.
    pub fn is_key_usable(&self, key: &ApiKeyRow, now_ms: i64) -> bool {
        if KEY_STATUS_DENIED.contains(&key.status.as_str()) {
            return false;
        }
        // A read must not create an entry. The TypeScript `health()` inserts on read, which grows
        // the map for every key ever *considered*; the answer is identical either way, because an
        // absent entry means default health.
        if let Some(h) = self.keys.get(&key.id) {
            if h.breaker_open || h.cooldown_until_ms > now_ms {
                return false;
            }
        }
        if let Some(until) = key.cooldown_until {
            if until > now_ms {
                return false;
            }
        }
        true
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
    pub fn record_result(
        &mut self,
        key_id: &str,
        cls: ErrorClass,
        retry_after_ms: Option<u64>,
        now_ms: i64,
    ) {
        let h = self.keys.entry(key_id.to_string()).or_default();
        match cls {
            ErrorClass::Ok => {
                h.consecutive_auth_failures = 0;
                h.cooldown_until_ms = 0;
                h.breaker_open = false;
            }
            ErrorClass::RateLimited => {
                let wait = retry_after_ms.unwrap_or(0).max(COOLDOWN_FLOOR_MS);
                h.cooldown_until_ms = now_ms + wait as i64;
            }
            ErrorClass::AuthFailed => {
                h.consecutive_auth_failures += 1;
                if h.consecutive_auth_failures >= AUTH_BREAKER_THRESHOLD {
                    h.breaker_open = true;
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
            | ErrorClass::ServerError
            | ErrorClass::Timeout
            | ErrorClass::Network => {}
        }
    }

    /// Forget everything known about a key.
    pub fn reset_key(&mut self, key_id: &str) {
        self.keys.remove(key_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn outcome(cls: ErrorClass, status: u16, retry_after_ms: Option<u64>) -> AttemptOutcome {
        AttemptOutcome { cls, status, retry_after_ms }
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
        // Pinned because it is a decision, not an accident: 402 (payment required) and a 3xx
        // redirect are both "not named by this taxonomy", and the TypeScript falls through to
        // NETWORK for them. A future port that "improved" this would change failover behaviour.
        assert_eq!(classify(402, None), ErrorClass::Network);
        assert_eq!(classify(301, None), ErrorClass::Network);
        assert_eq!(classify(0, None), ErrorClass::Network);
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
        let mut asked = HealthTracker::new();
        asked.record_result("k1", ErrorClass::RateLimited, Some(60_000), NOW);
        assert_eq!(asked.keys["k1"].cooldown_until_ms, NOW + 60_000, "the provider's wait is kept");

        // A sub-second wait, and no wait at all, both land on the floor.
        for wait in [Some(400u64), Some(0), None] {
            let mut t = HealthTracker::new();
            t.record_result("k1", ErrorClass::RateLimited, wait, NOW);
            assert_eq!(
                t.keys["k1"].cooldown_until_ms,
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
            let mut t = HealthTracker::new();
            t.record_result("k1", ErrorClass::RateLimited, Some(ms), NOW);
            let enforced = t.keys["k1"].cooldown_until_ms - NOW;
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
        let mut t = HealthTracker::new();
        t.record_result("k1", ErrorClass::RateLimited, Some(0), NOW);
        assert_eq!(t.keys["k1"].cooldown_until_ms - NOW, COOLDOWN_FLOOR_MS as i64);
        assert_eq!(min_retry_after_ms(&[outcome(ErrorClass::RateLimited, 429, Some(0))]), 0);
    }

    #[test]
    fn three_consecutive_auth_failures_open_the_breaker_and_an_ok_closes_it() {
        let key = key_row("k1", "active", None);
        let mut t = HealthTracker::new();

        for i in 1..AUTH_BREAKER_THRESHOLD {
            t.record_result("k1", ErrorClass::AuthFailed, None, NOW);
            assert!(!t.keys["k1"].breaker_open, "still closed after {i} failure(s)");
            assert!(t.is_key_usable(&key, NOW));
        }
        t.record_result("k1", ErrorClass::AuthFailed, None, NOW);
        assert!(t.keys["k1"].breaker_open, "opens on failure {AUTH_BREAKER_THRESHOLD}");
        assert!(!t.is_key_usable(&key, NOW));

        // One success clears it: the breaker counts *consecutive* failures, so the count resets
        // too rather than merely closing.
        t.record_result("k1", ErrorClass::Ok, None, NOW);
        assert!(!t.keys["k1"].breaker_open);
        assert_eq!(t.keys["k1"].consecutive_auth_failures, 0);
        assert!(t.is_key_usable(&key, NOW));
    }

    #[test]
    fn an_ok_result_clears_the_cooldown_the_breaker_and_the_failure_count() {
        let mut t = HealthTracker::new();
        for _ in 0..AUTH_BREAKER_THRESHOLD {
            t.record_result("k1", ErrorClass::AuthFailed, None, NOW);
        }
        t.record_result("k1", ErrorClass::RateLimited, Some(60_000), NOW);
        let before = t.keys["k1"];
        assert!(
            before.breaker_open
                && before.cooldown_until_ms > NOW
                && before.consecutive_auth_failures > 0
        );

        t.record_result("k1", ErrorClass::Ok, None, NOW);
        assert_eq!(t.keys["k1"], KeyHealth::default(), "an Ok leaves nothing behind");
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
            let mut t = HealthTracker::new();
            t.record_result("k1", cls, None, NOW);
            assert_eq!(t.keys["k1"], KeyHealth::default(), "{cls:?} changed key health");
        }
    }

    #[test]
    fn server_error_network_and_timeout_also_leave_key_health_alone() {
        // These three reach the end of the TypeScript chain rather than its explicit early
        // return, and the outcome is the same: nothing. Asserted separately, and with a wait
        // attached, so that if the port ever grows a backoff for them it is a deliberate change
        // rather than a silent one — `retry_after_ms` is ignored for every class but RATE_LIMITED.
        for cls in [ErrorClass::ServerError, ErrorClass::Network, ErrorClass::Timeout] {
            let mut t = HealthTracker::new();
            t.record_result("k1", cls, Some(60_000), NOW);
            assert_eq!(t.keys["k1"], KeyHealth::default(), "{cls:?} changed key health");
        }
    }

    #[test]
    fn resetting_a_key_forgets_its_cooldown_and_its_breaker() {
        let key = key_row("k1", "active", None);
        let mut t = HealthTracker::new();
        for _ in 0..AUTH_BREAKER_THRESHOLD {
            t.record_result("k1", ErrorClass::AuthFailed, None, NOW);
        }
        assert!(!t.is_key_usable(&key, NOW));

        t.reset_key("k1");
        assert!(t.is_key_usable(&key, NOW));
        // A reset key starts from nothing, not from "cooldown cleared but breaker open".
        assert!(!t.keys.contains_key("k1"));
    }

    #[test]
    fn reading_a_keys_health_does_not_create_an_entry_for_it() {
        // A deliberate divergence from the TypeScript, whose `health()` inserts on read. The
        // answer is the same — an absent entry means default health — but considering a thousand
        // keys does not grow the map.
        let t = HealthTracker::new();
        assert!(t.is_key_usable(&key_row("never-seen", "active", None), NOW));
        assert!(t.keys.is_empty(), "a read must not insert");
    }

    #[test]
    fn the_map_does_grow_when_something_is_recorded() {
        // The companion to the test above: `is_empty()` there is only evidence if the map *is*
        // populated when it should be. Without this, a tracker whose `record_result` silently did
        // nothing would make the non-inserting read look correct for the wrong reason.
        let mut t = HealthTracker::new();
        t.record_result("k1", ErrorClass::RateLimited, Some(60_000), NOW);
        assert_eq!(t.keys.len(), 1);
        t.record_result("k2", ErrorClass::AuthFailed, None, NOW);
        assert_eq!(t.keys.len(), 2);
        t.reset_key("k1");
        assert_eq!(t.keys.len(), 1);
    }

    // ---------- increment 4: the attempt budget and the terminal error ----------

    /// The TypeScript union, verbatim from `errors.ts:5-14`.
    ///
    /// Spelled out rather than derived from anything, so a variant added to `ErrorClass` without
    /// a wire spelling fails here instead of quietly rendering as its `Debug` form.
    const TS_SPELLINGS: [&str; 9] = [
        "AUTH_FAILED",
        "RATE_LIMITED",
        "NOT_FOUND",
        "BAD_REQUEST_SCHEMA",
        "PARSE_ERROR",
        "SERVER_ERROR",
        "TIMEOUT",
        "NETWORK",
        "OK",
    ];

    #[test]
    fn every_class_has_the_spelling_the_typescript_uses() {
        let mut got: Vec<&str> = ALL_CLASSES.iter().map(|c| c.as_str()).collect();
        got.sort_unstable();
        let mut want = TS_SPELLINGS.to_vec();
        want.sort_unstable();
        // Comparing the sorted vectors covers three things at once, which is why there is no
        // separate length or uniqueness test: a missing variant shortens `got`, an extra one
        // lengthens it, and two classes sharing a spelling duplicates an entry. Each fails here.
        assert_eq!(got, want, "the wire spellings are a cross-language contract");
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

    // ---------- increment 6: the per-attempt policy ----------

    fn http(status: u16, kind: FailureKind, retry_after_ms: Option<u64>) -> AttemptError {
        AttemptError::Http { status, kind, retry_after_ms }
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

            let mut t = HealthTracker::new();
            t.record_result("k1", cls, e.retry_after_ms(), NOW);
            assert!(
                t.is_key_usable(&key_row("k1", "enabled", None), NOW),
                "a drift class must not cool the key"
            );
            assert_eq!(t.keys["k1"].cooldown_until_ms, 0);
        }

        // The contrast that makes the rule non-vacuous: a class that is *not* drift does cool it,
        // so "skipping health" is a real omission rather than a no-op for every class.
        let mut t = HealthTracker::new();
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
        let mut t = HealthTracker::new();
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

    use crate::core::adapter::{AdapterInstance, ImageReply};
    use futures_util::future::BoxFuture;
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
        let mut health = HealthTracker::new();

        let served = execute_image(
            &Always(adapter.clone()),
            &mut health,
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
        let mut health = HealthTracker::new();

        execute_image(
            &Always(adapter.clone()),
            &mut health,
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
        let mut health = HealthTracker::new();

        let served = execute_image(
            &Always(adapter.clone()),
            &mut health,
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
        let mut health = HealthTracker::new();

        let err = execute_image(
            &Always(adapter.clone()),
            &mut health,
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
    async fn an_empty_plan_fails_rather_than_succeeding_with_nothing() {
        // `:193` throws unconditionally once the loop ends, so zero candidates is a failure.
        let adapter = Scripted::new(vec![]);
        let mut health = HealthTracker::new();

        let err = execute_image(
            &Always(adapter.clone()),
            &mut health,
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
        let mut health = HealthTracker::new();
        let mut args = image_args(vec![candidate("p1", "k1", "m1")]);
        args.max_attempts = Some(0);

        let err = execute_image(&Always(adapter.clone()), &mut health, None, args, &Cancel::new())
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
        let mut health = HealthTracker::new();
        let limiter = ProviderLimiter::new(1);
        let _held = limiter.acquire("p1").expect("the slot is free to start with");

        let cancel = Cancel::new();
        cancel.cancel();

        let err = execute_image(
            &Always(adapter.clone()),
            &mut health,
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
        let mut health = HealthTracker::new();
        let limiter = ProviderLimiter::new(1);
        let _held = limiter.acquire("p1").expect("free to start with");

        let err = execute_image(
            &Always(adapter.clone()),
            &mut health,
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
        let mut health = HealthTracker::new();

        let err = execute_image(
            &NoneResolved,
            &mut health,
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
        })]);
        let mut health = HealthTracker::new();

        let err = execute_image(
            &Always(adapter.clone()),
            &mut health,
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
        let mut health = HealthTracker::new();

        execute_image(
            &Always(adapter.clone()),
            &mut health,
            None,
            image_args(vec![candidate("p1", "k1", "m1")]),
            &Cancel::new(),
        )
        .await
        .expect_err("refused");

        let cooled_until = health.keys["k1"].cooldown_until_ms;
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
        let mut health = HealthTracker::new();

        let served_adapter = Scripted::new(vec![ok_reply("AAAA")]);
        execute_image(
            &Always(served_adapter),
            &mut health,
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
            &mut health,
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
}
