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
//! Phase 3's; until it exists the label is absent and `AllAttemptsFailedError` has no home. This
//! is a recorded gap, not an oversight.

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
}
