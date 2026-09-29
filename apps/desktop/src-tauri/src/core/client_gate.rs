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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mirrors_the_typescript_markers() {
        // quoted from the 2026-09-29 measurement (client-gate.ts)
        assert_eq!(
            detect_client_gate(401, Some(r#"{"error":{"type":"unauthorized_client_error","message":"unauthorized client detected"}}"#)),
            Some("unauthorized_client_error"),
        );
        assert_eq!(detect_client_gate(401, Some("unauthorized client detected")), Some("unauthorized client"));
        // case-insensitive, like the source's toLowerCase
        assert_eq!(detect_client_gate(401, Some("UNAUTHORIZED CLIENT")), Some("unauthorized client"));
        // status-gated
        assert_eq!(detect_client_gate(200, Some("unauthorized client")), None);
        assert_eq!(detect_client_gate(400, Some("unauthorized_client_error")), None);
        // no body, no gate
        assert_eq!(detect_client_gate(401, None), None);
        assert_eq!(detect_client_gate(401, Some("")), None);
        // an unrecognised refusal is not a gate — blame the key, as before
        assert_eq!(detect_client_gate(401, Some("invalid api key")), None);
    }
}
