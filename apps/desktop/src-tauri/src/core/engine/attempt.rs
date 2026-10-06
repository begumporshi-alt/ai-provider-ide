//! The attempt vocabulary and the per-attempt policy — moved verbatim from `engine.rs`
//! (D98 phase 2). Pure records and pure decisions: who tried, what came back, how long to wait,
//! and whether one attempt is retryable, affordable, or a gate stop. Depends on
//! `taxonomy::ErrorClass` and `planner::Candidate`; nothing here touches a provider.
use std::time::Duration;

use crate::core::planner::Candidate;
use super::taxonomy::{
    classify, reason_from_body, BodyHint, COOLDOWN_FLOOR_MS, ErrorClass,
};

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
    /// The provider's own words for the refusal (`reason_from_body` — a 400 content-policy block
    /// says "content-blocked", not "schema"). Display-only: the class decides behaviour, this
    /// decides what the operator reads. `chain_json` carries it into `fallback_chain_json` when
    /// present.
    pub reason: Option<String>,
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

/// The wall-clock budget for **one whole plan**, across every candidate it may try.
///
/// **This is the term that was missing, and its absence is the 2026-09-27 defect.** The egress
/// layer bounds one attempt (`egress::UPSTREAM_HEADER_TIMEOUT`) and one candidate's retries, but
/// nothing bounded the *plan* — and `execute_text` walks every candidate the plan offers. With two
/// candidates that was `2 x 20s = 40s` of worst case against a gateway that abandons the request at
/// `gateway::FIRST_MSG_TIMEOUT` (30s), so the last candidate was **always** cut off mid-attempt.
/// The old invariant test pinned only one candidate's budget and so could not see it.
///
/// **26s is chosen so the plan is a real bound, not a hope.** Every admitted candidate is funded
/// for a full `egress::UPSTREAM_HEADER_TIMEOUT` (20s) inside this budget, so nothing admitted can
/// run past it; and `26s < 30s` leaves 4s for the pre-dispatch work this clock starts after
/// (memory prepend, routing) plus scheduling slack. The three constants form one ordering —
/// `20s <= 26s < 30s` — pinned by
/// `egress::tests::the_plan_budget_fits_inside_the_gateway_bound`.
///
/// **Being below the gateway bound is also what makes the failure legible.** When this budget
/// refuses a candidate the loop ends in [`Ended::Spent`], so the router records the real class
/// from the attempt chain. Above the gateway bound the request is instead cancelled, and the
/// router files it as `CANCELLED` — which is how four failed requests on 2026-09-27
/// (rows 1652/1655/1656/1658, 30 010–30 025 ms) came to look like client aborts.
pub const PLAN_BUDGET: Duration = Duration::from_secs(26);

/// Whether a candidate may be started, given how long the plan has already run.
///
/// **The first candidate is always admitted.** Otherwise a budget smaller than one attempt would
/// refuse every candidate and turn a slow request into an instant, silent failure — the budget
/// would stop being a bound and start being an outage. The first candidate is the one that
/// *defines* the plan's cost; the rule exists to stop the ones after it from overrunning.
///
/// **Every later candidate must be fundable in full**, which is what makes [`PLAN_BUDGET`] a bound
/// rather than a scheduling hint: a candidate admitted here is guaranteed a whole
/// `egress::UPSTREAM_HEADER_TIMEOUT` inside the budget, so the plan cannot exceed it. The
/// alternative — admitting a candidate and cutting it short — is strictly worse: it spends the
/// remaining time to reach a conclusion it already knew it could not reach.
pub fn candidate_is_affordable(elapsed: Duration, is_first: bool) -> bool {
    is_first || elapsed + crate::core::egress::UPSTREAM_HEADER_TIMEOUT <= PLAN_BUDGET
}

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
        /// A truncated slice of the refusal body, when one was read.
        ///
        /// The status alone cannot tell a client gate from a bad key, nor a content-policy block
        /// from a schema error — both of those facts live only here. Truncated at the projection
        /// boundary (`manifest.rs`) so a large error page never rides through the engine.
        body: Option<String>,
    },
    /// No HTTP answer: a transport failure, a timeout, or an adapter fault.
    Transport,
    /// **No HTTP answer because this process refused to ask.** The egress allowlist does not contain
    /// the destination host, or a `secret_ref` was pointed at a host it is not paired with.
    ///
    /// A third variant rather than a `Transport` with a flag on it, and the enum's own note is the
    /// invitation: *"a new failure shape cannot join the port without a decision about which side it
    /// belongs on."* This one belongs on **neither** of the TypeScript's two sides, because the
    /// TypeScript has no allowlist — the host does — so it is a deliberate divergence, recorded
    /// rather than smuggled in as a transport failure with a friendlier message.
    ///
    /// `reason` is the egress's own words, carried so the specific host stays recoverable:
    /// [`attempt_outcome`] logs it where the attempt is recorded. It is deliberately *not* part of
    /// the client-facing class token, which stays a single word.
    Blocked { reason: String },
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
            AttemptError::Transport | AttemptError::Blocked { .. } => 0,
        }
    }

    /// What the provider asked us to wait, when it said so at all.
    pub fn retry_after_ms(&self) -> Option<u64> {
        match self {
            AttemptError::Http { retry_after_ms, .. } => *retry_after_ms,
            AttemptError::Transport | AttemptError::Blocked { .. } => None,
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
        // The third case, and the one the TypeScript cannot have: a refusal by our own egress. It is
        // not `Network` — nothing was dialled — and it is not any status class, because there was no
        // status. See `AttemptError::Blocked`.
        AttemptError::Blocked { .. } => ErrorClass::EgressDenied,
        AttemptError::Http { status, kind, body, .. } => {
            if *kind == FailureKind::MidStream {
                return ErrorClass::ParseError;
            }
            // The body can contradict the status: a gated 401 is `ClientGate`, not `AuthFailed`,
            // and a 400 that says "model not found" is `NotFound`, not `BadRequestSchema`.
            let hint = crate::core::client_gate::detect_client_gate(*status, body.as_deref())
                .map(|_| BodyHint::ClientGate)
                .or_else(|| {
                    crate::core::client_gate::detect_not_found(*status, body.as_deref())
                        .map(|_| BodyHint::NotFound)
                });
            match classify(*status, hint) {
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
///
/// **`emitted` is folded with a tool-call count at the call site** (`engine.rs:execute_text`):
/// a delivered tool call also ends failover, because the consumer holds a tool call the next
/// candidate would re-issue. The predicate's contract is "did the candidate deliver *anything*",
/// and the caller decides what "anything" counts as.
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
    // **The last point at which the reason is in hand.** `AttemptError::Blocked` carries the
    // egress's own words — which host, and that the refusal was ours — and nothing downstream can
    // see them: the class token is a single word, and `AttemptOutcome` deliberately has no message
    // field (its own note records why the chain carries two names and not a candidate). So the
    // reason is logged rather than dropped, which is what makes the class *and* the host both
    // recoverable: the client gets `EGRESS_DENIED`, the operator gets the host from the log.
    if let AttemptError::Blocked { reason } = e {
        tracing::warn!("egress refused the request before dialling: {reason}");
    }
    AttemptOutcome {
        cls: classify_attempt_error(e),
        status: e.status_or_zero(),
        retry_after_ms: match disposition {
            AttemptDisposition::Rethrow => None,
            _ => e.retry_after_ms(),
        },
        reason: match e {
            AttemptError::Http { body, .. } => reason_from_body(body.as_deref()),
            _ => None,
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
///
/// **A tool-call-then-break is also `Rethrow`** (the call site folds the tool-call count into
/// `emitted`), and the same invariant covers it: a mid-stream break after a tool call classifies
/// the same way as one after a chunk — by status and kind, not by what preceded it — so it is
/// still a drift class.
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
    AttemptOutcome {
        cls: ErrorClass::RateLimited,
        status: 429,
        retry_after_ms: None,
        reason: None,
        label: None,
    }
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
