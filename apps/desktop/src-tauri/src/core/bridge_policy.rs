//! The gateway bridge's decisions, separated from the I/O that carries them out.
//!
//! `router_bridge.rs` is the driver: it owns the router, spawns each request, and writes to
//! `ReplyHandle`. This module holds what the driver *decides* — the parts that are easy to get
//! wrong and cheap to pin — so the driver is left with wiring. The reference was
//! `apps/desktop/src/gateway-bridge.ts` (421 lines), **deleted in 25f** along with the webview it
//! ran in; this module and `router_bridge.rs` are now the only copy of that behaviour (D42).
//!
//! # Tool ownership is decided, never guessed
//!
//! The bridge has exactly two modes, and which one applies is decided by who declared the tools:
//!
//! - **Client** — the client sent its own `tools` array. Those are the client's tools and the
//!   client will run them. They go back on the wire untouched and the request ends. They are **not**
//!   also executed here: that would write the same file twice.
//! - **Gateway** — the client sent none and the operator turned gateway tools on. The gateway
//!   supplies its own sandboxed registry, runs each call, feeds the results back, and keeps going
//!   until the model stops asking.
//! - **None** — the client sent none and the toggle is off. Nothing is invented.
//!
//! [`decide_tool_ownership`] reads the toggle **only** when the client brought no tools. That is
//! not an optimisation: it is what makes the toggle unable to override a client that did declare
//! tools, and `the_toggle_cannot_override_the_clients_own_tools` pins it.
//!
//! # The status policy is a whitelist, not an echo
//!
//! [`gateway_status`] used to be `const status = /no route|not found/i.test(msg) ? 404 : 502` — a
//! regex over the error *message*, which is not a contract. It reported every schema rejection as
//! `502`, telling the client the gateway was broken and inviting a retry for a request that could
//! never succeed, and any rewording of a message would have silently changed the status. The router
//! already knows: the failed attempts carry the upstream's own status. The message heuristic
//! survives only for a chain with no attempt at all — the empty-plan guard, or a throw from outside
//! the engine.
//!
//! # What is deliberately not here
//!
//! - **The heartbeat and the pre-turn liveness probe.** The reference probed `gateway_chunk` before
//!   every turn, because a webview could be suspended and silence had to be told apart from a slow
//!   turn. A Rust bridge runs in this process and cannot be suspended, so the probe had no
//!   counterpart — and neither did the `503` it fed. Both the probe and the webview are gone as of
//!   25f. See D35 and D42 in the drift register.
//! - **Response shaping.** The `models` list and the `image` body are pure mappings with no decision
//!   in them, so they belong where the JSON is built, in the driver.
//! - **The chunk parser.** [`ProseGate`] takes text that has already been through
//!   [`crate::core::assistant_stream::visible_text`], so one chunk is parsed once rather than twice
//!   the way the reference parses it.

use serde_json::{json, Value};

use crate::core::adapter::ToolCall;
use crate::core::engine::{min_retry_after_ms, AttemptOutcome};

/// The request kinds the gateway routes to a bridge — `BridgeRequest::kind` (`gateway.rs:340`).
///
/// The field is a `&'static str` on the wire, so an unrecognised kind is representable and must be
/// answered rather than assumed. [`BridgeKind::parse`] returns `None` for it, and the driver
/// answers `400 unknown bridge kind …` — the reference's own branch, kept because a silent fallback
/// to `chat` would run a tool loop over a body shaped for something else.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BridgeKind {
    Chat,
    Responses,
    Models,
    Image,
}

impl BridgeKind {
    /// The kind a wire string names, or `None` when it names none of them.
    pub fn parse(kind: &str) -> Option<BridgeKind> {
        match kind {
            "chat" => Some(BridgeKind::Chat),
            "responses" => Some(BridgeKind::Responses),
            "models" => Some(BridgeKind::Models),
            "image" => Some(BridgeKind::Image),
            _ => None,
        }
    }

    /// Whether this kind goes through the tool loop. The other two answer from one call.
    pub fn runs_tool_loop(self) -> bool {
        matches!(self, BridgeKind::Chat | BridgeKind::Responses)
    }
}

/// The ceiling on model turns in one gateway request.
///
/// The reference imports this from `lib/tools/agentLoop.ts:35` rather than declaring its own
/// `= 8`, and the comment there records why: a second copy kept in step by a comment means the
/// gateway and the Assistant silently disagree the moment either one changes. That single source
/// does not exist in Rust yet — the Assistant's loop is still TypeScript — so the value is declared
/// here, and `the_iteration_ceiling_matches_the_reference` pins it so a change has to be deliberate.
/// **When the Assistant's loop is ported, this constant should move to it and be imported back**,
/// for the same reason the reference imports it.
pub const MAX_TOOL_ITERATIONS: usize = 8;

/// Upstream statuses that may be handed to the client unchanged.
///
/// A whitelist, deliberately, not an echo. A `401`/`403` from an upstream means *our stored key* was
/// rejected — the client's own credentials are not in question, so passing it through would send the
/// client hunting for a problem it does not have. A `5xx` is the provider's failure, which from the
/// client's side is a gateway failure. What remains is the set where the client's request is the
/// cause and a retry either helps (`429`) or never will (`400`/`404`/`413`/`422`).
pub const CLIENT_ATTRIBUTABLE_STATUS: [u16; 5] = [400, 404, 413, 422, 429];

/// Whether a status says something about the client's request rather than about us.
pub fn client_attributable(status: u16) -> bool {
    CLIENT_ATTRIBUTABLE_STATUS.contains(&status)
}

/// The HTTP status to report to the client for a failed request.
///
/// `last_attempt_status` is the status of the **last** attempt in the chain, or `None` when there
/// was no attempt at all. `status: 0` means the attempt never reached the provider (DNS, TLS,
/// timeout) — a gateway-side failure, not a client one — and it is not client-attributable, so it
/// falls through to `502` on its own.
///
/// The status wins over the message: a chain whose last attempt was a `400` is reported `400` even
/// if the message happens to contain "no route", because the upstream's own status is evidence and
/// the message is not.
pub fn gateway_status(last_attempt_status: Option<u16>, msg: &str) -> u16 {
    if let Some(status) = last_attempt_status {
        if client_attributable(status) {
            return status;
        }
    }
    if message_says_no_route(msg) {
        404
    } else {
        502
    }
}

/// [`gateway_status`] for a failure whose attempt chain is known.
///
/// Split out so "**last**, not first" is a decision with a name and a test. The first attempt is
/// usually the one that failed for the least interesting reason, and the last is the one that
/// actually stopped the request.
pub fn gateway_status_for_attempts(attempts: &[AttemptOutcome], msg: &str) -> u16 {
    gateway_status(attempts.last().map(|a| a.status), msg)
}

/// The reference's `/no route|not found/i`, hand-rolled.
///
/// This crate has no `regex` in its *runtime* graph — the same constraint that deferred `modality.rs`
/// and that `sandbox.rs:44` records for its header names. Two fixed literals are matched directly.
///
/// **ASCII case folding is exactly equivalent here, and that is a measurement rather than an
/// assumption.** JavaScript's `/i` folds Unicode, so it would match a non-ASCII character that
/// uppercases to one of the needle's letters. Neither needle contains `s`, `k` or `i`, which are the
/// letters with non-ASCII case-fold partners (`ſ`/U+017F, `K`/U+212A, `İ`/U+0130) — so no non-ASCII
/// character can match either literal, and the two foldings agree.
/// `no_non_ascii_character_can_stand_in_for_a_letter_here` pins the reasoning.
fn message_says_no_route(msg: &str) -> bool {
    contains_ci(msg, "no route") || contains_ci(msg, "not found")
}

/// A case-insensitive substring test over ASCII.
fn contains_ci(haystack: &str, needle: &str) -> bool {
    let h = haystack.as_bytes();
    let n = needle.as_bytes();
    if n.is_empty() {
        return true;
    }
    if n.len() > h.len() {
        return false;
    }
    h.windows(n.len()).any(|w| w.eq_ignore_ascii_case(n))
}

/// Who owns the tools for this request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolOwnership {
    /// The client declared tools. They are the client's to run; the gateway forwards them.
    Client,
    /// The client declared none and the operator turned gateway tools on.
    Gateway,
    /// The client declared none and the toggle is off. No tools are supplied or invented.
    None,
}

/// Decide who owns the tools.
///
/// `client_tool_count` is the length of the normalised `tools` array — `0` covers both "absent" and
/// "an empty array", which the reference folds together with `length > 0`. `gateway_tools_enabled`
/// is the operator's toggle, and it is read **only** when the client brought nothing: a client that
/// declared its own tools is never overridden by a setting, which is the whole point of asking the
/// question in this order.
pub fn decide_tool_ownership(
    client_tool_count: usize,
    gateway_tools_enabled: bool,
) -> ToolOwnership {
    if client_tool_count > 0 {
        ToolOwnership::Client
    } else if gateway_tools_enabled {
        ToolOwnership::Gateway
    } else {
        ToolOwnership::None
    }
}

/// The `tool_choice` to send, given who owns the tools.
///
/// Only the gateway's own registry is ours to steer, so it is the only case that gets `"auto"`. A
/// client's choice is forwarded as it arrived — including when there are no tools at all, which is
/// what the reference does and is harmless: a provider that receives no `tools` has nothing to
/// choose between.
///
/// The value is a [`Value`], not a `&str`, because `tool_choice` is not always a string — it may be
/// `{"type":"function","function":{"name":"…"}}`, and narrowing it here would silently drop a
/// client's forced call.
pub fn tool_choice_for(ownership: ToolOwnership, client_choice: Option<Value>) -> Option<Value> {
    match ownership {
        ToolOwnership::Gateway => Some(json!("auto")),
        ToolOwnership::Client | ToolOwnership::None => client_choice,
    }
}

/// The prose a gateway-mode turn holds back until it knows the turn is an answer.
///
/// Gateway mode runs several model turns and only the last one is an answer. Text from a turn that
/// goes on to call a tool is a preamble — "on it:" — and the client did not ask for it, so it is
/// held here and released only once a turn ends without asking for anything. Pass-through and
/// tools-off have no follow-up turn, so they stream straight through; there is nothing to wait for.
///
/// The distinction that matters is [`discard`](ProseGate::discard) versus
/// [`release`](ProseGate::release): starting a new turn throws the previous preamble away, and
/// finishing a turn hands it over. Using the wrong one at the wrong site is the defect this type
/// exists to make visible, and `a_new_turn_discards_the_previous_preamble_rather_than_releasing_it`
/// is the guard.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProseGate {
    hold: bool,
    held: String,
}

impl ProseGate {
    /// A gate for a request whose tools belong to `ownership`. Only [`ToolOwnership::Gateway`] holds.
    pub fn new(ownership: ToolOwnership) -> Self {
        Self { hold: ownership == ToolOwnership::Gateway, held: String::new() }
    }

    /// Whether this gate holds text back rather than emitting it.
    pub fn holds(&self) -> bool {
        self.hold
    }

    /// What has been held so far, without taking it.
    pub fn held(&self) -> &str {
        &self.held
    }

    /// Offer one chunk's visible text.
    ///
    /// Returns `Some(text)` when it must go to the client **now**, and `None` when the gate is
    /// holding it. Empty text is never offered in either mode: the reference guards with
    /// `if (!visible) return`, and emitting an empty delta would be a chunk the client cannot use.
    pub fn offer(&mut self, visible: &str) -> Option<String> {
        if visible.is_empty() {
            return None;
        }
        if self.hold {
            self.held.push_str(visible);
            None
        } else {
            Some(visible.to_string())
        }
    }

    /// Start a new turn: the previous turn's preamble is **dropped**, not handed over.
    pub fn discard(&mut self) {
        self.held.clear();
    }

    /// Finish a turn and take what it produced. `None` when nothing was held, so the caller emits
    /// no chunk rather than an empty one. The gate is empty afterwards, so a second release is a
    /// second `None`.
    pub fn release(&mut self) -> Option<String> {
        if self.held.is_empty() {
            return None;
        }
        Some(std::mem::take(&mut self.held))
    }
}

/// What the bridge does after one model turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnOutcome {
    /// Inline `mercury` markers were found in the text. They are ours whoever declared the real
    /// tools — they are not part of any client tool contract — so they always run locally.
    SandboxMercury,
    /// The model asked for tools the gateway supplied: run them and keep the conversation going.
    SandboxCollected,
    /// The client's own calls came back: hand them over untouched and end the request.
    PassThrough,
    /// Nothing was called. The turn is the answer.
    Finish,
}

/// Decide what a finished turn leads to.
///
/// The order is the reference's, and each step outranks the next:
///
/// 1. Mercury markers first — they are ours regardless of who declared the real tools.
/// 2. No calls at all: the model answered, and the turn is over.
/// 3. Ownership decides whether the collected calls run here or go back to the client.
///
/// Note that [`ToolOwnership::None`] with calls present yields [`TurnOutcome::PassThrough`], which
/// is the reference's behaviour: a client that declared no tools should not receive calls, but if a
/// provider returns some anyway they are forwarded rather than run, because running tools nobody
/// asked for is the worse failure.
pub fn decide_turn(
    mercury_calls: usize,
    collected_calls: usize,
    ownership: ToolOwnership,
) -> TurnOutcome {
    if mercury_calls > 0 {
        return TurnOutcome::SandboxMercury;
    }
    if collected_calls == 0 {
        return TurnOutcome::Finish;
    }
    if ownership == ToolOwnership::Gateway {
        TurnOutcome::SandboxCollected
    } else {
        TurnOutcome::PassThrough
    }
}

/// Collect one of a turn's tool calls, skipping a call that repeats an id already collected.
///
/// **A call with no id is always kept.** The reference is
/// `if (!collected.some((c) => c.id && c.id === call.id)) collected.push(call)`, and the `c.id &&`
/// is load-bearing: it makes the comparison false whenever the *call* has no id, so an id-less call
/// is pushed rather than matched against the id-less calls already there. Comparing the ids
/// directly — `collected.iter().any(|c| c.id == call.id)` — would make `None == None` true and
/// silently drop every id-less call after the first, so a turn that asked for three writes would
/// run one. That is the whole reason this is a named function rather than a line in the loop.
///
/// An empty id is treated as no id, matching the reference's falsy `c.id` test.
pub fn push_tool_call(collected: &mut Vec<ToolCall>, call: ToolCall) {
    let duplicate = call
        .id
        .as_deref()
        .filter(|id| !id.is_empty())
        .is_some_and(|id| collected.iter().any(|c| c.id.as_deref() == Some(id)));
    if !duplicate {
        collected.push(call);
    }
}

/// The `retry_after_ms` to send the client, or `None` to omit the hint entirely.
///
/// [`min_retry_after_ms`] already floors a named wait and returns `0` when no attempt named one. The
/// two zeroes are not the same fact, and the client cannot tell them apart once they are on the
/// wire: `retry_after_ms: 0` reads as "retry now", which is exactly the wrong advice after a
/// provider just said it was overloaded. So an unnamed wait is an **absent field**, not a zero.
pub fn retry_after_hint(attempts: &[AttemptOutcome]) -> Option<u64> {
    match min_retry_after_ms(attempts) {
        0 => None,
        ms => Some(ms),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::engine::{AttemptLabel, ErrorClass};

    fn attempt(status: u16, retry_after_ms: Option<u64>) -> AttemptOutcome {
        AttemptOutcome {
            cls: if status == 429 { ErrorClass::RateLimited } else { ErrorClass::Network },
            status,
            retry_after_ms,
            label: Some(AttemptLabel { provider_slug: "agnes".into(), key_label: "key-01".into() }),
        }
    }

    fn call(id: Option<&str>) -> ToolCall {
        ToolCall {
            id: id.map(str::to_string),
            name: Some("write_file".into()),
            arguments: Some("{}".into()),
            raw: None,
        }
    }

    // ---------- the route kinds ----------

    #[test]
    fn every_route_kind_the_gateway_sends_is_recognised() {
        assert_eq!(BridgeKind::parse("chat"), Some(BridgeKind::Chat));
        assert_eq!(BridgeKind::parse("responses"), Some(BridgeKind::Responses));
        assert_eq!(BridgeKind::parse("models"), Some(BridgeKind::Models));
        assert_eq!(BridgeKind::parse("image"), Some(BridgeKind::Image));
    }

    #[test]
    fn an_unknown_kind_is_not_silently_treated_as_chat() {
        // A fallback to `chat` would run a tool loop over a body shaped for something else.
        assert_eq!(BridgeKind::parse("image_edit"), None);
        assert_eq!(BridgeKind::parse(""), None);
        assert_eq!(BridgeKind::parse("Chat"), None, "the wire spelling is lowercase");
    }

    #[test]
    fn only_chat_and_responses_run_the_tool_loop() {
        assert!(BridgeKind::Chat.runs_tool_loop());
        assert!(BridgeKind::Responses.runs_tool_loop());
        assert!(!BridgeKind::Models.runs_tool_loop());
        assert!(!BridgeKind::Image.runs_tool_loop());
    }

    // ---------- the status policy ----------

    #[test]
    fn a_client_attributable_status_is_exactly_the_five_named() {
        for status in [400u16, 404, 413, 422, 429] {
            assert!(client_attributable(status), "{status} is client-attributable");
        }
        for status in [0u16, 200, 401, 403, 500, 502, 503] {
            assert!(!client_attributable(status), "{status} is not");
        }
    }

    #[test]
    fn the_upstream_status_is_reported_when_the_request_was_the_cause() {
        assert_eq!(gateway_status(Some(400), "all attempts failed"), 400);
        assert_eq!(gateway_status(Some(429), "all attempts failed"), 429);
        assert_eq!(gateway_status(Some(404), "all attempts failed"), 404);
    }

    #[test]
    fn a_status_about_our_key_is_not_passed_through() {
        // A 401 here means *our* stored key was rejected. Echoing it would send the client hunting
        // for a credential problem it does not have.
        assert_eq!(gateway_status(Some(401), "all attempts failed"), 502);
        assert_eq!(gateway_status(Some(403), "all attempts failed"), 502);
        assert_eq!(gateway_status(Some(500), "all attempts failed"), 502);
    }

    #[test]
    fn status_zero_is_a_gateway_side_failure() {
        // 0 means the attempt never reached the provider at all (DNS, TLS, timeout).
        assert_eq!(gateway_status(Some(0), "all attempts failed"), 502);
    }

    #[test]
    fn the_message_heuristic_survives_only_for_a_chain_with_no_attempt() {
        assert_eq!(gateway_status(None, "no route for model \"x\""), 404);
        assert_eq!(gateway_status(None, "boom"), 502);
    }

    #[test]
    fn the_message_heuristic_is_case_insensitive() {
        assert_eq!(gateway_status(None, "NO ROUTE for model"), 404);
        assert_eq!(gateway_status(None, "Not Found"), 404);
        assert_eq!(gateway_status(None, "No RoUtE"), 404);
    }

    #[test]
    fn no_non_ascii_character_can_stand_in_for_a_letter_here() {
        // The needles are pure ASCII over letters with no non-ASCII case-fold partner, so ASCII
        // folding and JavaScript's Unicode folding agree. A haystack built from the lookalikes must
        // therefore NOT match — if this ever goes green as a 404, the folding assumption is wrong.
        assert_eq!(gateway_status(None, "no rou\u{212a}e"), 502, "K is not k");
        assert_eq!(gateway_status(None, "no rou\u{017f}e"), 502, "long s is not s");
        assert_eq!(gateway_status(None, "no route\u{0130}"), 404, "the real needle still matches");
    }

    #[test]
    fn a_client_attributable_status_outranks_a_message_that_says_no_route() {
        // The status is evidence; the message is not.
        assert_eq!(gateway_status(Some(422), "no route for model"), 422);
    }

    #[test]
    fn the_last_attempt_decides_the_status_not_the_first() {
        let chain = vec![attempt(400, None), attempt(500, None), attempt(429, None)];
        assert_eq!(gateway_status_for_attempts(&chain, "all attempts failed"), 429);
        // Reversed, the same chain reports the 429 that is now last.
        let reversed = vec![attempt(429, None), attempt(500, None), attempt(400, None)];
        assert_eq!(gateway_status_for_attempts(&reversed, "all attempts failed"), 400);
    }

    #[test]
    fn an_empty_chain_falls_back_to_the_message() {
        assert_eq!(gateway_status_for_attempts(&[], "all attempts failed [empty plan]"), 502);
        assert_eq!(gateway_status_for_attempts(&[], "no route for model \"x\""), 404);
    }

    // ---------- tool ownership ----------

    #[test]
    fn the_toggle_is_read_only_when_the_client_brought_no_tools() {
        assert_eq!(decide_tool_ownership(0, true), ToolOwnership::Gateway);
        assert_eq!(decide_tool_ownership(0, false), ToolOwnership::None);
    }

    #[test]
    fn the_toggle_cannot_override_the_clients_own_tools() {
        assert_eq!(decide_tool_ownership(1, true), ToolOwnership::Client);
        assert_eq!(decide_tool_ownership(7, false), ToolOwnership::Client);
    }

    #[test]
    fn an_empty_tools_array_is_not_a_client_toolset() {
        // `length > 0`, so `[]` behaves as absent rather than as "the client wants no tools".
        assert_eq!(decide_tool_ownership(0, true), ToolOwnership::Gateway);
        assert_eq!(decide_tool_ownership(0, false), ToolOwnership::None);
    }

    #[test]
    fn the_gateway_steers_only_its_own_registry() {
        assert_eq!(tool_choice_for(ToolOwnership::Gateway, None), Some(json!("auto")));
        assert_eq!(
            tool_choice_for(ToolOwnership::Gateway, Some(json!("required"))),
            Some(json!("auto")),
            "the client's choice does not apply to a registry it never sent"
        );
    }

    #[test]
    fn a_clients_tool_choice_is_forwarded_untouched_including_an_object() {
        let forced = json!({ "type": "function", "function": { "name": "write_file" } });
        assert_eq!(
            tool_choice_for(ToolOwnership::Client, Some(forced.clone())),
            Some(forced.clone())
        );
        assert_eq!(
            tool_choice_for(ToolOwnership::Client, Some(json!("none"))),
            Some(json!("none"))
        );
        assert_eq!(tool_choice_for(ToolOwnership::Client, None), None);
        // No tools at all: the choice is still forwarded, as the reference does.
        assert_eq!(tool_choice_for(ToolOwnership::None, Some(forced.clone())), Some(forced));
        assert_eq!(tool_choice_for(ToolOwnership::None, None), None);
    }

    // ---------- the held-prose gate ----------

    #[test]
    fn gateway_mode_holds_prose_and_passing_mode_emits_it() {
        let mut gateway = ProseGate::new(ToolOwnership::Gateway);
        assert!(gateway.holds());
        assert_eq!(gateway.offer("on it"), None);
        assert_eq!(gateway.offer(": writing"), None);
        assert_eq!(gateway.held(), "on it: writing");

        let mut client = ProseGate::new(ToolOwnership::Client);
        assert!(!client.holds());
        assert_eq!(client.offer("hello"), Some("hello".to_string()));
        assert_eq!(client.held(), "", "nothing is held in passing mode");

        let mut none = ProseGate::new(ToolOwnership::None);
        assert_eq!(none.offer("hello"), Some("hello".to_string()));
    }

    #[test]
    fn a_new_turn_discards_the_previous_preamble_rather_than_releasing_it() {
        let mut gate = ProseGate::new(ToolOwnership::Gateway);
        assert_eq!(gate.offer("I'll write that file"), None);
        gate.discard();
        assert_eq!(gate.held(), "", "the preamble is gone, not waiting");
        assert_eq!(gate.release(), None, "and it is not handed over by a later release");
    }

    #[test]
    fn release_returns_nothing_when_nothing_was_held() {
        let mut gate = ProseGate::new(ToolOwnership::Gateway);
        assert_eq!(gate.release(), None);
        let mut client = ProseGate::new(ToolOwnership::Client);
        assert_eq!(client.release(), None, "passing mode never held anything");
    }

    #[test]
    fn release_takes_the_text_once() {
        let mut gate = ProseGate::new(ToolOwnership::Gateway);
        gate.offer("the answer");
        assert_eq!(gate.release(), Some("the answer".to_string()));
        assert_eq!(gate.release(), None, "a second release emits nothing");
        assert_eq!(gate.held(), "");
    }

    #[test]
    fn an_empty_chunk_is_never_offered_in_either_mode() {
        let mut gateway = ProseGate::new(ToolOwnership::Gateway);
        assert_eq!(gateway.offer(""), None);
        assert_eq!(gateway.held(), "");
        let mut client = ProseGate::new(ToolOwnership::Client);
        assert_eq!(client.offer(""), None, "an empty delta is a chunk the client cannot use");
    }

    // ---------- the turn outcome ----------

    #[test]
    fn mercury_markers_are_run_whatever_declared_the_real_tools() {
        for ownership in [ToolOwnership::Client, ToolOwnership::Gateway, ToolOwnership::None] {
            assert_eq!(
                decide_turn(1, 0, ownership),
                TurnOutcome::SandboxMercury,
                "{ownership:?}: inline markers are not part of any client tool contract"
            );
            assert_eq!(
                decide_turn(2, 5, ownership),
                TurnOutcome::SandboxMercury,
                "{ownership:?}: markers outrank the provider's own calls"
            );
        }
    }

    #[test]
    fn a_turn_with_no_calls_finishes_regardless_of_who_owns_the_tools() {
        for ownership in [ToolOwnership::Client, ToolOwnership::Gateway, ToolOwnership::None] {
            assert_eq!(decide_turn(0, 0, ownership), TurnOutcome::Finish, "{ownership:?}");
        }
    }

    #[test]
    fn the_ownership_decides_whether_collected_calls_run_or_pass_through() {
        assert_eq!(decide_turn(0, 1, ToolOwnership::Gateway), TurnOutcome::SandboxCollected);
        assert_eq!(decide_turn(0, 3, ToolOwnership::Client), TurnOutcome::PassThrough);
        assert_eq!(
            decide_turn(0, 3, ToolOwnership::None),
            TurnOutcome::PassThrough,
            "running tools nobody asked for is the worse failure"
        );
    }

    // ---------- collecting calls ----------

    #[test]
    fn a_call_with_no_id_is_always_kept() {
        // The defect this guards: comparing the ids directly makes `None == None` true, so a turn
        // that asked for three writes would run one.
        let mut collected = Vec::new();
        push_tool_call(&mut collected, call(None));
        push_tool_call(&mut collected, call(None));
        push_tool_call(&mut collected, call(None));
        assert_eq!(collected.len(), 3, "three id-less calls are three calls");
    }

    #[test]
    fn a_call_with_an_empty_id_is_always_kept() {
        let mut collected = Vec::new();
        push_tool_call(&mut collected, call(Some("")));
        push_tool_call(&mut collected, call(Some("")));
        assert_eq!(collected.len(), 2, "an empty id is no id");
    }

    #[test]
    fn a_repeated_id_is_dropped() {
        let mut collected = Vec::new();
        push_tool_call(&mut collected, call(Some("abc")));
        push_tool_call(&mut collected, call(Some("abc")));
        push_tool_call(&mut collected, call(Some("def")));
        assert_eq!(collected.len(), 2);
        assert_eq!(collected[0].id.as_deref(), Some("abc"));
        assert_eq!(collected[1].id.as_deref(), Some("def"));
    }

    #[test]
    fn an_id_less_call_does_not_match_a_named_one() {
        let mut collected = Vec::new();
        push_tool_call(&mut collected, call(Some("abc")));
        push_tool_call(&mut collected, call(None));
        push_tool_call(&mut collected, call(Some("abc")));
        assert_eq!(
            collected.len(),
            2,
            "the id-less call is kept and does not dedupe the named one"
        );
    }

    // ---------- the ceiling and the retry hint ----------

    #[test]
    fn the_iteration_ceiling_matches_the_reference() {
        // `lib/tools/agentLoop.ts:35` is the single source the reference imports from. If the
        // Assistant's loop is ported, this constant should move there rather than be copied.
        assert_eq!(MAX_TOOL_ITERATIONS, 8);
    }

    #[test]
    fn an_unnamed_wait_omits_the_hint_rather_than_sending_zero() {
        assert_eq!(retry_after_hint(&[]), None);
        assert_eq!(retry_after_hint(&[attempt(429, None)]), None);
        assert_eq!(
            retry_after_hint(&[attempt(429, Some(0))]),
            None,
            "Some(0) is an unnamed wait, not 'retry now'"
        );
    }

    #[test]
    fn the_shortest_named_wait_is_the_hint_and_it_is_floored() {
        // The planner drops cooling keys, so the earliest a retry can be served is when the first
        // of them frees up — 42 s, not 71 s.
        let chain = vec![
            attempt(429, Some(58_000)),
            attempt(429, Some(42_000)),
            attempt(429, Some(71_000)),
        ];
        assert_eq!(retry_after_hint(&chain), Some(42_000));
        // A provider naming 400 ms must not yield a hint that reads as "retry now".
        assert_eq!(retry_after_hint(&[attempt(429, Some(400))]), Some(1_000));
    }

    #[test]
    fn a_wait_is_counted_whatever_the_class_that_named_it() {
        // A 503 carrying Retry-After leaves its key technically usable, so filtering to RATE_LIMITED
        // would tell the client to retry in a second straight back into the overload.
        let chain = vec![attempt(503, Some(30_000)), attempt(429, None)];
        assert_eq!(retry_after_hint(&chain), Some(30_000));
    }
}
