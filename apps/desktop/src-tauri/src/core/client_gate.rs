//! client-gate (Rust port of `router-core/src/client-gate.ts`): a provider that refused **this
//! client** without ever judging the credential.
//!
//! Both halves of a split-brain port must ask the same question of a refusal body, so the marker
//! list here is a verbatim mirror of the TypeScript's `CLIENT_GATE_MARKERS` — the TypeScript stays
//! the single authority in design terms, and this module's contract test
//! (`engine.rs::every_class_has_the_spelling_the_typescript_uses` neighbourhood) is what keeps the
//! two lists from drifting. See the TypeScript module's note for the measurement behind the list
//! and for why it is deliberately narrow: a missed gate falls back to blaming the key (the status
//! quo), while a false positive would tell an operator their rejected key is fine.

/// Statuses a client gate is reported with. A `200` carrying the prose is not a refusal.
const GATE_STATUSES: [u16; 2] = [401, 403];

const CLIENT_GATE_MARKERS: [&str; 2] = ["unauthorized_client_error", "unauthorized client"];

/// Markers in a 400 body that name a model that does not exist on this provider, rather than a
/// request that is malformed. The distinction is drift vs. drift — both are failures of the
/// manifest or alias, but classifying "model not found" as `BAD_REQUEST_SCHEMA` misleads the
/// operator into checking their request shape when the provider simply does not serve that model.
const MODEL_NOT_FOUND_MARKERS: [&str; 8] = [
    "model not found",
    "model does not exist",
    "does not exist",
    "model not exist",
    "the model does not exist",
    "invalid model",
    "unknown model",
    "does not support model",
];

/// Whether a response is a client gate, and which marker identified it.
///
/// Returns the matched marker so the caller can quote the provider's own words. A non-`401`/`403`
/// status returns `None` regardless of body: a client gate is a *refusal*, and a body that merely
/// mentions the phrase is not evidence of one.
pub fn detect_client_gate(status: u16, body: Option<&str>) -> Option<&'static str> {
    if !GATE_STATUSES.contains(&status) {
        return None;
    }
    let body = body?;
    let hay = body.to_lowercase();
    CLIENT_GATE_MARKERS.iter().find(|m| hay.contains(**m)).copied()
}

/// Whether a 400 response body names a model that does not exist, rather than a malformed request.
///
/// A non-400 status returns `None`: "model not found" is a 400-class signal, not a 404 on every
/// provider (some gatekeepers return 400 for anything they refuse before routing). Narrow and
/// provider-measured, not speculative — a body that merely mentions "model" is not evidence.
pub fn detect_not_found(status: u16, body: Option<&str>) -> Option<&'static str> {
    if status != 400 {
        return None;
    }
    let body = body?;
    let hay = body.to_lowercase();
    MODEL_NOT_FOUND_MARKERS.iter().find(|m| hay.contains(**m)).copied()
}

/// Markers in a **5xx** body that name *our request* as the thing that was refused.
///
/// Measured 2026-10-14 on `agent-router`, which answered every dial of ledger 4280 and 4283 with
///
///   `500 {"error":{"message":"Upstream rejected the request as invalid","type":"invalid_request_error"},"type":"error"}`
///
/// and `tokens_in = 0`. Zero input tokens is the load-bearing half: the upstream refused before
/// reading the request, so the verdict is about the body's *shape* and not about the moment. An
/// aggregator reports that as 5xx because the failure happened past its own edge, which is exactly
/// why the status cannot be trusted and the body has to be.
///
/// **Narrow on purpose, in the manner of the lists above.** A missed marker falls back to
/// `SERVER_ERROR` — the status quo, which retries — while a false positive would stop retrying a
/// genuine upstream flap. Both entries are in a body this system actually received:
/// `invalid_request_error` is the OpenAI-standard type, and the prose is agent-router's own.
const INVALID_REQUEST_MARKERS: [&str; 2] =
    ["invalid_request_error", "rejected the request as invalid"];

/// Whether a 5xx response body says the **request** was invalid rather than the server unwell.
///
/// A non-5xx status returns `None`: below 500 the taxonomy already reads the body for its own
/// reasons (`detect_not_found` at 400, `detect_client_gate` at 401/403), and a 4xx that names an
/// invalid request is already classified as one. This exists for the one case where the status
/// lies upward.
pub fn detect_invalid_request(status: u16, body: Option<&str>) -> Option<&'static str> {
    if status < 500 {
        return None;
    }
    let body = body?;
    let hay = body.to_lowercase();
    INVALID_REQUEST_MARKERS.iter().find(|m| hay.contains(**m)).copied()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mirrors_the_typescript_markers() {
        // quoted from the 2026-09-29 measurement (client-gate.ts)
        assert_eq!(
            detect_client_gate(
                401,
                Some(
                    r#"{"error":{"type":"unauthorized_client_error","message":"unauthorized client detected"}}"#
                )
            ),
            Some("unauthorized_client_error"),
        );
        assert_eq!(
            detect_client_gate(401, Some("unauthorized client detected")),
            Some("unauthorized client")
        );
        // case-insensitive, like the source's toLowerCase
        assert_eq!(
            detect_client_gate(401, Some("UNAUTHORIZED CLIENT")),
            Some("unauthorized client")
        );
        // status-gated
        assert_eq!(detect_client_gate(200, Some("unauthorized client")), None);
        assert_eq!(detect_client_gate(400, Some("unauthorized_client_error")), None);
        // no body, no gate
        assert_eq!(detect_client_gate(401, None), None);
        assert_eq!(detect_client_gate(401, Some("")), None);
        // an unrecognised refusal is not a gate — blame the key, as before
        assert_eq!(detect_client_gate(401, Some("invalid api key")), None);
    }

    #[test]
    fn detect_not_found_only_triggers_on_400() {
        // not a 400 — not a model-not-found, regardless of body
        assert_eq!(detect_not_found(200, Some("model not found")), None);
        assert_eq!(detect_not_found(404, Some("model not found")), None);
        assert_eq!(detect_not_found(0, Some("model not found")), None);
        // 400 with no body
        assert_eq!(detect_not_found(400, None), None);
        assert_eq!(detect_not_found(400, Some("")), None);
    }

    #[test]
    fn detect_not_found_matches_provider_markers() {
        // OpenAI-style — "does not exist" matches first (shorter marker precedes)
        assert_eq!(
            detect_not_found(
                400,
                Some(r#"{"error":{"message":"The model `gpt-5` does not exist"}}"#)
            ),
            Some("does not exist"),
        );
        // Anthropic-style
        assert_eq!(
            detect_not_found(
                400,
                Some(r#"{"error":{"message":"invalid model: claude-nonexistent"}}"#)
            ),
            Some("invalid model"),
        );
        // bare text
        assert_eq!(detect_not_found(400, Some("model not found")), Some("model not found"),);
        // case-insensitive
        assert_eq!(detect_not_found(400, Some("UNKNOWN MODEL")), Some("unknown model"),);
    }

    #[test]
    fn detect_not_found_does_not_match_unrelated_400s() {
        // a schema error mentions "model" only incidentally — not a match
        assert_eq!(detect_not_found(400, Some("model field is required")), None);
        assert_eq!(detect_not_found(400, Some("invalid api key")), None);
        assert_eq!(detect_not_found(400, Some("content-blocked")), None);
    }

    #[test]
    fn detect_invalid_request_reads_the_measured_500() {
        // quoted verbatim from ledger 4280/4283 (2026-10-14, agent-router)
        let body = r#"{"error":{"message":"Upstream rejected the request as invalid","type":"invalid_request_error"},"type":"error"}"#;
        assert_eq!(detect_invalid_request(500, Some(body)), Some("invalid_request_error"));
        // the prose alone, for a body that carries it without the standard `type`
        assert_eq!(
            detect_invalid_request(502, Some("Upstream rejected the request as invalid")),
            Some("rejected the request as invalid")
        );
        // case-insensitive, like every other detector here
        assert_eq!(
            detect_invalid_request(500, Some(r#"{"error":{"type":"INVALID_REQUEST_ERROR"}}"#)),
            Some("invalid_request_error")
        );
    }

    #[test]
    fn detect_invalid_request_is_gated_to_5xx() {
        let body = r#"{"error":{"type":"invalid_request_error"}}"#;
        // Below 500 the taxonomy already reads the body for its own reasons, and a 4xx that names an
        // invalid request is already classified as one — so the hint must not fire and double-count.
        assert_eq!(detect_invalid_request(400, Some(body)), None);
        assert_eq!(detect_invalid_request(429, Some(body)), None);
        assert_eq!(detect_invalid_request(200, Some(body)), None);
        assert_eq!(detect_invalid_request(500, None), None);
        assert_eq!(detect_invalid_request(500, Some("")), None);
    }

    #[test]
    fn detect_invalid_request_leaves_a_plain_upstream_flap_alone() {
        // A 5xx that says nothing about the request must stay `SERVER_ERROR`, because that class is
        // what retries: a false positive here would stop retrying a genuine outage.
        assert_eq!(detect_invalid_request(503, Some(r#"{"error":{"message":"overloaded"}}"#)), None);
        assert_eq!(detect_invalid_request(500, Some("internal server error")), None);
    }
}
