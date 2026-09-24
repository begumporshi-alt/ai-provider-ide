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

use futures_util::StreamExt;
use serde_json::Value;

use crate::core::adapter::{AdapterFactory, Cancel, ImageArgs, TextArgs, ToolCall};
use crate::core::limiter::ProviderLimiter;
use crate::core::persist::{ApiKeyRow, ProviderRow};
use crate::core::planner::Candidate;
use crate::core::usage::UsageTokens;

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

/// Who tried, in the two names every reader of a chain actually uses.
///
/// **This is the decision the module note called open, and Phase 3's router is what forced it.**
/// Three consumers wanted the same missing thing: [`AllAttemptsFailed::describe`], which the
/// TypeScript builds as `<provider.slug>/<key.label>:<cls>`; the router's `fallback_chain_json`,
/// which the Activity screen renders as `provider · key → cls` (`store.ts:124-128`); and Phase 5's
/// drift hook, which wants the provider id and the model native id as well.
///
/// The TypeScript gets all of it by carrying a whole `Candidate` on every outcome
/// (`execution-engine.ts:199`). The port cannot: the three rows are *owned* here, so that shape
/// clones three of them per failed attempt where the original copies a reference. The note
/// suggested carrying the joined `slug/label` string instead — which is enough for `describe` and
/// **not** enough for the ledger, whose chain entries are `{provider, key, cls}` as three
/// separate JSON fields; a joined string would have to be split by its reader, and splitting on
/// the wrong separator is a defect waiting for a label that contains one. So: two fields.
///
/// **`Copy` is the price, and it is paid.** `AttemptOutcome` was `Copy` before this and is not
/// now. Two call sites in the text loop read `outcome.cls` after pushing the outcome into the
/// chain and now read them first; that is the whole of the churn. What it buys is `describe`
/// naming its provider, which has been listed as a gap since increment 4, and a ledger chain the
/// Rust router can write at all.
///
/// **Still absent: the provider *id* and the model.** The drift hook needs both, so it stays
/// unported — see `core::router`'s module note. Adding fields for a consumer that does not exist
/// yet would be a guess, and this type has been burned by a guessed field before.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttemptLabel {
    /// The provider's slug, as the plan resolved it. Never the id: `slug` is what a person reads.
    pub provider_slug: String,
    /// The key's label — the human name for the credential, never the secret.
    pub key_label: String,
}

impl AttemptLabel {
    pub fn of(candidate: &Candidate) -> Self {
        Self {
            provider_slug: candidate.provider.slug.clone(),
            key_label: candidate.key.label.clone(),
        }
    }
}

/// One failed attempt, as the wait arithmetic and the chain's readers need it.
///
/// TypeScript's version also carries the `Candidate` it tried. This carries [`AttemptLabel`]
/// instead — the two fields of it that are read, rather than three owned rows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttemptOutcome {
    /// What the failure was classified as.
    pub cls: ErrorClass,
    /// The HTTP status, or `0` when there was no response.
    pub status: u16,
    /// What the provider asked us to wait, when it said so at all.
    pub retry_after_ms: Option<u64>,
    /// Who tried, when the outcome came from a candidate at all.
    ///
    /// `None` is "unknown" and stays unknown. The three constructors below default to it, and the
    /// loops attach it with [`labelled`] — so an outcome that never had a candidate cannot forge
    /// a name, and the two paths that do have one are the two that say so.
    pub label: Option<AttemptLabel>,
}

/// Attach the candidate's identity to an outcome, for the chain a caller reads.
///
/// A free function rather than a constructor parameter so the three constructors keep their
/// signatures — and therefore so does every test that calls them. The name is deliberately
/// verb-shaped: it states that this is the step where an outcome learns who it was.
pub fn labelled(mut outcome: AttemptOutcome, candidate: &Candidate) -> AttemptOutcome {
    outcome.label = Some(AttemptLabel::of(candidate));
    outcome
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
        // Attached by the loop, which is the only place that holds the candidate.
        label: None,
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
    AttemptOutcome { cls: ErrorClass::RateLimited, status: 429, retry_after_ms: None, label: None }
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
    AttemptOutcome { cls: ErrorClass::Network, status: 0, retry_after_ms: None, label: None }
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
                            cls: classify(reply.status, None),
                            status: reply.status,
                            retry_after_ms: None,
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
        let detail = self
            .chain
            .iter()
            .map(|a| match &a.label {
                Some(l) => format!("{}/{}:{}", l.provider_slug, l.key_label, a.cls.as_str()),
                None => format!("{}:{}", a.cls.as_str(), a.status),
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
    pub tools: Option<Value>,
    pub tool_choice: Option<Value>,
    pub response_format: Option<Value>,
    pub on_tool_call: Option<&'a mut (dyn FnMut(ToolCall) + Send)>,
    pub on_usage: Option<&'a mut (dyn FnMut(UsageTokens) + Send)>,
    pub max_attempts: Option<usize>,
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
    health: &mut HealthTracker,
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
        /// A candidate streamed to the sink (`:107`).
        Served(Candidate),
        /// The break arrived after the sink already held text (`:112-116`).
        MidStream { error: AttemptError, served: Candidate },
        /// Cancellation stopped the loop (`:80`, `:133`).
        Cancelled,
        /// The budget was spent with nothing served (`:141-143`).
        Spent,
    }

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

            let mut emitted = false;
            let mut broke: Option<AttemptError> = None;
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
                    if let Some(cb) = caller_on_tool_call.as_deref_mut() {
                        cb(tc);
                    }
                };
                let text_args = TextArgs {
                    model: candidate.model.native_id.clone(),
                    messages: &args.messages,
                    stream: args.stream,
                    max_tokens: args.max_tokens,
                    temperature: args.temperature,
                    tools: args.tools.as_ref(),
                    tool_choice: args.tool_choice.as_ref(),
                    response_format: args.response_format.as_ref(),
                    on_tool_call: Some(&mut forward_tool),
                    on_usage: Some(&mut record_usage),
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
            // apart — `emitted` is its whole input, and it is the predicate increment 6 pinned.
            if let Some(e) = refused.or(broke) {
                let disposition = attempt_disposition(emitted, cancel.is_cancelled());
                let outcome = labelled(attempt_outcome(&e, disposition), &candidate);
                if records_key_health(disposition) {
                    let (cls, retry_after_ms) = (outcome.cls, outcome.retry_after_ms);
                    health.record_result(&candidate.key.id, cls, retry_after_ms, now_ms());
                }
                attempts.push(outcome);
                match disposition {
                    // Only reachable with `emitted`, so the sink already holds text and `served` is
                    // this candidate. The original error travels, not the class.
                    AttemptDisposition::Rethrow => {
                        break 'plan Ended::MidStream { error: e, served: candidate }
                    }
                    AttemptDisposition::Stop => break 'plan Ended::Cancelled,
                    AttemptDisposition::Next => continue,
                }
            }

            // `:106-107` — the stream ended and the attempt served, so the loop stops rather than
            // advancing. This is why the source's `if (!served)` guard has nothing to guard.
            break 'plan Ended::Served(candidate);
        }
        Ended::Spent
    };

    match ended {
        Ended::Served(candidate) => {
            health.record_result(&candidate.key.id, ErrorClass::Ok, None, now_ms());
            Ok(TextSuccess { candidate, attempts, usage })
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
    // Only the tests name the model row: the engine reads a candidate's `model.native_id` without
    // ever spelling the type, so importing it at the top would be unused in a non-test build.
    use crate::core::persist::ModelRow;

    fn outcome(cls: ErrorClass, status: u16, retry_after_ms: Option<u64>) -> AttemptOutcome {
        AttemptOutcome { cls, status, retry_after_ms, label: None }
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
    async fn every_attempt_the_image_loop_records_names_the_provider_and_key_it_tried() {
        // The image path's label, and the reason the router can write a `fallback_chain_json` at
        // all: the chain's entries are `{provider, key, cls}` (`store.ts:124-128`), and before
        // this the Rust chain could produce only the third. The status is *not* part of what the
        // ledger renders, which is why the assertion is on the label rather than on the whole row.
        let adapter = Scripted::new(vec![refusal(404), refusal(429)]);
        let mut health = HealthTracker::new();

        let err = execute_image(
            &Always(adapter.clone()),
            &mut health,
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
        // And the whole error message now names both, which it could not before increment 13a.
        assert_eq!(
            err.describe(),
            "all attempts failed for as-the-caller-typed-it [p1/k1:NOT_FOUND -> p2/k2:RATE_LIMITED]"
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
            tools: None,
            tool_choice: None,
            response_format: None,
            on_tool_call: None,
            on_usage: None,
            max_attempts: None,
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
        Err(AttemptError::Http { status, kind: FailureKind::Response, retry_after_ms: None })
    }

    /// A **mid-stream** break, as the script records it: one item of an otherwise-answered stream.
    /// The type is the *stream's*, not the script's — that is the two-phase split written down.
    fn broke(status: u16) -> Result<String, AttemptError> {
        Err(AttemptError::Http { status, kind: FailureKind::MidStream, retry_after_ms: None })
    }

    /// The same error value, for comparing against what the loop carried out. `AttemptError` is
    /// `PartialEq` precisely so a test can assert the *original* travelled rather than a summary.
    fn http_error(status: u16, kind: FailureKind) -> AttemptError {
        AttemptError::Http { status, kind, retry_after_ms: None }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_first_candidate_that_streams_serves_and_the_rest_are_never_tried() {
        let adapter = TextScripted::new(vec![chunks_of(&["Hel", "lo"])]).shared();
        let mut health = HealthTracker::new();
        let (seen, mut on_chunk) = sink();

        let served = execute_text(
            &Always(adapter.clone()),
            &mut health,
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
        let mut health = HealthTracker::new();
        let (_seen, mut on_chunk) = sink();

        execute_text(
            &Always(adapter.clone()),
            &mut health,
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
            }),
            chunks_of(&["ok"]),
        ])
        .shared();
        let mut health = HealthTracker::new();
        let (seen, mut on_chunk) = sink();

        let served = execute_text(
            &Always(adapter.clone()),
            &mut health,
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
        let mut health = HealthTracker::new();
        let (seen, mut on_chunk) = sink();

        let failure = execute_text(
            &Always(adapter.clone()),
            &mut health,
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
        let mut health = HealthTracker::new();
        let (seen, mut on_chunk) = sink();

        let served = execute_text(
            &Always(response),
            &mut health,
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
        let mut health = HealthTracker::new();
        let (seen, mut on_chunk) = sink();

        let failure = execute_text(
            &Always(mid.clone()),
            &mut health,
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
        let mut health = HealthTracker::new();
        let limiter = ProviderLimiter::new(1);
        // Hold p0's only slot so its candidate is skipped rather than called.
        let _held = limiter.acquire("p0").expect("free to start with");
        let (_seen, mut on_chunk) = sink();

        let served = execute_text(
            &Always(adapter.clone()),
            &mut health,
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
        let mut health = HealthTracker::new();
        let limiter = ProviderLimiter::new(1);
        let _held = limiter.acquire("p1").expect("free to start with");
        let (_seen, mut on_chunk) = sink();

        let failure = execute_text(
            &Always(adapter.clone()),
            &mut health,
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
        let mut health = HealthTracker::new();
        let (_seen, mut on_chunk) = sink();
        let mut args = text_args(vec![candidate("p1", "k1", "m1")]);
        args.max_attempts = Some(0);

        let failure = execute_text(
            &Always(adapter.clone()),
            &mut health,
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
        let mut health = HealthTracker::new();
        let (_seen, mut on_chunk) = sink();
        let cancel = Cancel::new();
        cancel.cancel();

        let failure = execute_text(
            &Always(adapter.clone()),
            &mut health,
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
            }),
        ])
        .shared();
        let mut health = HealthTracker::new();
        let (_seen, mut on_chunk) = sink();

        let failure = execute_text(
            &Always(adapter.clone()),
            &mut health,
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
        let mut health = HealthTracker::new();
        let (_seen, mut on_chunk) = sink();
        let plan = || vec![candidate("p1", "k1", "m1")];

        let served = TextScripted::new(vec![chunks_of(&["x"])]).shared();
        execute_text(
            &Always(served),
            &mut health,
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
            &mut health,
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
            &mut health,
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
            &mut health,
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
        let mut health = HealthTracker::new();
        let (_seen, mut on_chunk) = sink();
        let (forwarded, mut on_usage) = usage_sink();
        let mut args = text_args(vec![candidate("p1", "k1", "m1")]);
        args.on_usage = Some(&mut on_usage);

        let served = execute_text(
            &Always(adapter.clone()),
            &mut health,
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
        let mut health = HealthTracker::new();
        let (seen, mut on_chunk) = sink();
        let (tool_calls, mut on_tool_call) = tool_sink();
        let mut args = text_args(vec![candidate("p1", "k1", "m1")]);
        args.on_tool_call = Some(&mut on_tool_call);

        let served = execute_text(
            &Always(adapter.clone()),
            &mut health,
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
