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

/// The root's own wall clock — the "no shared clock" convention: each module carries its copy.
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------- the image loop (moved verbatim to engine/image.rs, D98 phase 4) ----------

pub mod image;

pub use image::*;

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

// ---------- the text loop (moved verbatim to engine/text.rs, D98 phase 5) ----------

pub mod text;

pub use text::*;

// ---------- the health records (moved verbatim to engine/health.rs, D98 phase 3) ----------

pub mod health;

pub use health::*;

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::StreamExt;
    use std::time::Duration;
    // Only the tests name the model row: the engine reads a candidate's `model.native_id` without
    // ever spelling the type, so importing it at the top would be unused in a non-test build.
    use crate::core::adapter::{AdapterFactory, Cancel, ImageArgs, ToolCall};
    use crate::core::limiter::ProviderLimiter;
    use crate::core::persist::{ApiKeyRow, ModelRow, ProviderRow};
    use crate::core::planner::Candidate;
    use crate::core::usage::UsageTokens;

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
    async fn a_final_candidate_server_error_is_reprobed_once_and_can_serve() {
        // The measured case (2026-10-06): a provider-qualified id with one key plans exactly one
        // candidate, so the old `Next => continue` exhausted the plan on the first 500 and a
        // transient upstream blip became a hard failure. The re-probe is the wait-and-redial the
        // plan had nowhere left to do.
        let adapter = TextScripted::new(vec![refused(503), chunks_of(&["recovered"])]).shared();
        let health = HealthTracker::new();
        let (seen, mut on_chunk) = sink();

        let served = execute_text(
            &Always(adapter.clone()),
            &health,
            None,
            text_args(vec![candidate("p1", "k1", "m1")]),
            &Cancel::new(),
            &mut on_chunk,
        )
        .await
        .expect("the re-probe serves");

        assert_eq!(served.candidate.provider.id, "p1", "the same candidate serves");
        assert_eq!(adapter.calls().len(), 2, "the same key was dialled twice");
        assert_eq!(adapter.calls(), vec!["key:p1:k1|m1".to_string(), "key:p1:k1|m1".to_string()],);
        assert_eq!(served.attempts.len(), 1, "the 500 stays in the chain");
        assert_eq!(served.attempts[0].cls, ErrorClass::ServerError);
        assert_eq!(served.attempts[0].status, 503);
        assert_eq!(*seen.lock().unwrap(), vec!["recovered".to_string()]);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_second_server_error_on_the_reprobed_candidate_gets_no_third_dial() {
        // Bounded means bounded: one re-probe per candidate, whatever it returns. The chain records
        // both attempts, which is what the ledger's "attempt 2" line reads from.
        let adapter = TextScripted::new(vec![refused(503), refused(500)]).shared();
        let health = HealthTracker::new();
        let (_seen, mut on_chunk) = sink();

        let failure = execute_text(
            &Always(adapter.clone()),
            &health,
            None,
            text_args(vec![candidate("p1", "k1", "m1")]),
            &Cancel::new(),
            &mut on_chunk,
        )
        .await
        .expect_err("both dials 500'd");

        match failure {
            TextFailure::AllAttemptsFailed { error, .. } => {
                let classes: Vec<ErrorClass> = error.chain.iter().map(|a| a.cls).collect();
                assert_eq!(classes, vec![ErrorClass::ServerError, ErrorClass::ServerError]);
            }
            other => panic!("expected AllAttemptsFailed, got {other:?}"),
        }
        assert_eq!(adapter.calls().len(), 2, "exactly one re-probe, never a third");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_mid_plan_server_error_fails_over_without_reprobing() {
        // With a next candidate, failover is immediate: a healthy provider beats a wait on the
        // provider that just 500'd. The re-probe exists only where failover has nothing to do.
        let adapter = TextScripted::new(vec![refused(503), chunks_of(&["second"])]).shared();
        let health = HealthTracker::new();
        let (_seen, mut on_chunk) = sink();

        let served = execute_text(
            &Always(adapter.clone()),
            &health,
            None,
            text_args(vec![candidate("p1", "k1", "m1"), candidate("p2", "k2", "m2")]),
            &Cancel::new(),
            &mut on_chunk,
        )
        .await
        .expect("the second candidate serves");

        assert_eq!(served.candidate.provider.id, "p2");
        assert_eq!(
            adapter.calls(),
            // `key_row` hardcodes `key:p1:{label}` into the secret_ref, so the second
            // candidate's ref spells p1 even though its provider id is p2.
            vec!["key:p1:k1|m1".to_string(), "key:p1:k2|m2".to_string()],
            "one dial per candidate — p1 was not re-dialled",
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn only_server_error_earns_a_reprobe_on_the_final_candidate() {
        // 429 already has a remedy the re-probe would corrupt: the key cools, and a wait inside
        // this request would run straight back into the named window. The re-probe is a 5xx
        // behaviour and nothing else.
        let adapter = TextScripted::new(vec![refused(429)]).shared();
        let health = HealthTracker::new();
        let (_seen, mut on_chunk) = sink();

        let failure = execute_text(
            &Always(adapter.clone()),
            &health,
            None,
            text_args(vec![candidate("p1", "k1", "m1")]),
            &Cancel::new(),
            &mut on_chunk,
        )
        .await
        .expect_err("rate-limited is not re-probed");

        match failure {
            TextFailure::AllAttemptsFailed { error, .. } => {
                assert_eq!(error.chain.len(), 1);
                assert_eq!(error.chain[0].cls, ErrorClass::RateLimited);
            }
            other => panic!("expected AllAttemptsFailed, got {other:?}"),
        }
        assert_eq!(adapter.calls().len(), 1, "one dial, no re-probe");
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
