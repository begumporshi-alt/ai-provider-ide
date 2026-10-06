//! The error taxonomy — the coldest code in the engine, moved verbatim from `engine.rs`
//! (D98 phase 1). No imports, no state: the class of a failure, the body hints that refine it,
//! and the one retryability rule both loops share.

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
    /// **The provider answered and composed nothing a caller could use** — a 200 with no text and
    /// no tool call. Distinct from `ParseError`, which is about a shape this router cannot read:
    /// here there is nothing to read, because the model never wrote an answer.
    ///
    /// The measured cause (2026-10-02, `agentrouter.org` / `deepseek-v4-flash`): extended thinking
    /// is on by default, `max_tokens` covers reasoning **and** answer, and the reasoning consumed
    /// the whole 8192-token budget, so the stream ended at `stop_reason: max_tokens` having opened
    /// no text block. Four such turns in 75 minutes, each ~40 s of waiting and an empty bubble,
    /// filed as a parse error against a manifest that was correct. The TypeScript union gained the
    /// same member on the same day; this is the mirror, not a divergence.
    NoOutput,
    /// 5xx — the provider is unwell; another provider is the better answer.
    ServerError,
    /// 408.
    Timeout,
    /// No usable status: a transport failure, or a status this taxonomy does not name.
    Network,
    /// **A 401/403 whose body names a client refusal** (`client_gate.rs`): the provider refused
    /// the *caller* and never read the credential. Folding it into `AuthFailed` was wrong twice
    /// over — the loop rotated through every other key of the provider (none of which would be
    /// read either, measured 2026-09-29 on `agentrouter.org`) and three failures opened an auth
    /// breaker on a healthy key. Not drift (nothing about the provider changed), not
    /// key-retryable (the client identity is per-request, not per-key), not evidence against the
    /// key. The operator's remedy is a header, which is auto setup's gate panel.
    ClientGate,
    /// 402 — the provider answered, the transport is fine, and the budget pool is empty. Filed
    /// `Network` before, which counted a billing condition against the provider's network health
    /// and sent the loop hunting for a "better connected" provider. Not drift, not key-retryable
    /// (the pool does not refill per key); failover to the next *provider* still applies, which
    /// is the only remedy a 402 has.
    Billing,
    /// **Refused by this process before anything was dialled.** See [`AttemptError::Blocked`].
    ///
    /// Its own class because the alternative is a lie with a direction: folded into `Network`, it
    /// tells the operator the provider is unreachable when the provider was never asked, and points
    /// them at the wrong system. It is **not** drift (nothing about the provider changed), **not**
    /// retryable with the next key (every key of a provider shares its host, so the next key fails
    /// identically), and **not** evidence against the key.
    ///
    /// **A deliberate divergence from the TypeScript union**, which has no such member because it
    /// has no allowlist to be refused by. `ALL_CLASSES` is walked against that union verbatim, so
    /// this appears there as a named exception rather than an oversight.
    EgressDenied,
    /// 2xx.
    Ok,
}

/// A body signal that overrides what the status alone would say.
///
/// `400` consults it to distinguish "your request is malformed" from "that model does not exist" —
/// the latter is drift and must not burn a key. `401`/`403` consult [`BodyHint::ClientGate`] for
/// the same reason with the polarity reversed: the status *over*-blames the key, and the body is
/// the only place the provider says so.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BodyHint {
    /// The body says the request does not match the schema.
    Schema,
    /// The body says the model or endpoint is not there.
    NotFound,
    /// The body names a **client** refusal (`client_gate.rs` mirrors the TypeScript markers): the
    /// provider answered 401/403 without reading the credential.
    ClientGate,
}

/// Every class, so completeness is checkable rather than assumed.
///
/// `every_class_has_the_spelling_the_typescript_uses` walks this list against the TypeScript
/// union spelled out verbatim. A variant added without a spelling fails there — which is the
/// point: the wire spellings are a cross-language contract, and a new class that quietly
/// rendered as `{:?}` would be a spelling nobody agreed to.
pub const ALL_CLASSES: [ErrorClass; 13] = [
    ErrorClass::AuthFailed,
    ErrorClass::RateLimited,
    ErrorClass::NotFound,
    ErrorClass::BadRequestSchema,
    ErrorClass::ParseError,
    ErrorClass::NoOutput,
    ErrorClass::ServerError,
    ErrorClass::Timeout,
    ErrorClass::Network,
    ErrorClass::ClientGate,
    ErrorClass::Billing,
    ErrorClass::EgressDenied,
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
            ErrorClass::NoOutput => "NO_OUTPUT",
            ErrorClass::ServerError => "SERVER_ERROR",
            ErrorClass::Timeout => "TIMEOUT",
            ErrorClass::Network => "NETWORK",
            ErrorClass::ClientGate => "CLIENT_GATE",
            ErrorClass::Billing => "BILLING",
            // The one spelling the TypeScript union does not have — see `ErrorClass::EgressDenied`.
            ErrorClass::EgressDenied => "EGRESS_DENIED",
            ErrorClass::Ok => "OK",
        }
    }
}

/// Map an HTTP status, plus an optional body signal, to its class.
///
/// The arms are ordered and the fallthrough is load-bearing: any status this taxonomy does not
/// name — `409`, `418`, a `3xx` — classifies as [`ErrorClass::Network`]. That is the TypeScript
/// behaviour and the tests pin it, because "unknown status is a transport failure" is a decision,
/// not an accident. (`402` left that bucket deliberately — see [`ErrorClass::Billing`].)
pub fn classify(status: u16, body_hint: Option<BodyHint>) -> ErrorClass {
    if (200..300).contains(&status) {
        return ErrorClass::Ok;
    }
    if status == 401 || status == 403 {
        // A gate hint is the body contradicting the status: the provider answered 401/403 without
        // reading the credential, so "this key is bad" is exactly wrong. Without the hint the
        // status quo stands — an unrecognised refusal blames the key (client_gate.rs).
        if body_hint == Some(BodyHint::ClientGate) {
            return ErrorClass::ClientGate;
        }
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
    if status == 402 {
        return ErrorClass::Billing;
    }
    if status >= 500 {
        return ErrorClass::ServerError;
    }
    ErrorClass::Network
}

/// Longest provider reason kept, in code points. Mirror of `errors.ts:MAX_REASON_CHARS` — these two
/// are a pair a reader compares, so a divergence would mean the app and the daemon report the same
/// refusal at different lengths.
///
/// 120 was too tight for the message the field exists to carry. Measured from `agentrouter.org`'s
/// Anthropic route (2026-10-02), a rejected `tool_result` answers with 186 characters *before* the
/// aggregator appends its own request/trace ids:
///
///   unexpected `messages.2.content.0: tool_use_id` found in `tool_result` blocks: toolu_x.
///   Each `tool_result` block must have a corresponding `tool_use` block in the previous message.
///
/// The old cut landed at "Each `…", dropping both the offending id and the rule that explains it,
/// so a live 400 could not be diagnosed from the ledger. The cap only bounds a text column.
pub const MAX_REASON_CHARS: usize = 400;

/// The provider's own words for why it refused, short enough for a chain entry.
///
/// Rust mirror of `errors.ts:reasonFromBody` — one of the pair a reader compares. Before this
/// existed the classifier kept only the class token, so an upstream
/// `400 {"error":{"code":"content-blocked",…}}` reached the operator as "schema" — a word about
/// *our* request shape, for a refusal that was about the provider's content policy.
pub fn reason_from_body(body: Option<&str>) -> Option<String> {
    let body = body?;
    let mut reason = match serde_json::from_str::<serde_json::Value>(body) {
        Ok(v) => v.get("error").and_then(|e| {
            let code = e.get("code").and_then(|c| c.as_str());
            let message = e.get("message").and_then(|m| m.as_str());
            match (code, message) {
                (Some(c), Some(m)) => Some(format!("{c}: {m}")),
                (Some(c), None) => Some(c.to_string()),
                (None, Some(m)) => Some(m.to_string()),
                (None, None) => None,
            }
        }),
        Err(_) => None,
    };
    if reason.is_none() {
        reason = Some(body.to_string());
    }
    let reason = reason.unwrap();
    // char-counted, not byte-counted: a CJK error message (the measurement saw 无效的令牌) would
    // panic on a byte slice that splits a code point.
    Some(if reason.chars().count() > MAX_REASON_CHARS {
        format!("{}…", reason.chars().take(MAX_REASON_CHARS).collect::<String>())
    } else {
        reason
    })
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
