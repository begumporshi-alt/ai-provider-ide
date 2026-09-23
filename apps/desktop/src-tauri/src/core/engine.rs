//! The execution engine's pure core — the Rust port of three TypeScript modules that
//! `execution-engine.ts` cannot run without: `errors.ts` (the taxonomy), the
//! `COOLDOWN_FLOOR_MS` half of `health-tracker.ts`, and `AllAttemptsFailedError.minRetryAfterMs`
//! (the wait the client is told).
//!
//! Phase 2 of the headless plan (`docs/dev-book/10-headless-service.md` §7). This file is the
//! first increment and it is deliberately the part with **no I/O, no async and no store**: the
//! attempt loop that consumes it needs `route_planner` (Phase 3) for its `Candidate` type, and
//! the streaming half needs a `Stream` adapter. Landing the pure core first means the taxonomy
//! and the wait arithmetic can be tested in isolation, which is what the plan's "port the tests
//! first" asks for.
//!
//! **The contract this file exists to hold.** The client-facing `Retry-After` is the *shortest*
//! wait any attempt named, floored at `COOLDOWN_FLOOR_MS`. The Rust gateway already consumes
//! that value (`gateway::cooldown_secs`, `err_with_cooldown`) and its doc-comment on
//! `BridgeMsg::Error::retry_after_ms` states the same "shortest, not longest" rule — so the two
//! halves of the port already agree, and the tests below are what keep them agreeing.
//!
//! **What is deliberately NOT here yet.** `AttemptOutcome` in TypeScript also carries a
//! `Candidate` (provider + key + model) so a failed chain can name what it tried. That type is
//! Phase 3's, so the label is still absent: `AllAttemptsFailed` has a home and an arithmetic, but
//! it cannot yet say *which* provider failed. A recorded gap, narrowed in increment 4 and not
//! closed.
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

use crate::core::persist::{ApiKeyRow, ProviderRow};

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
}
