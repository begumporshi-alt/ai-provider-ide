//! What an outgoing request body *looks like*, recorded at the moment a provider refuses it.
//!
//! **Why this exists.** Four refusals in a row reached the ledger as `500 … "invalid_request_error"`
//! and nothing else — D107, D108, D109 and D110. Nothing about the request survives a failure: no
//! outgoing body is persisted anywhere, `failure_detail` is written as `None` on every row, and the
//! refusal text describes the *response*, never the request that caused it. So each one was
//! diagnosed by archaeology — reading `agent_steps`, replaying a session transcript through the
//! real shaping pipeline, and probing the upstream by hand — and **D110 is still unexplained,
//! because its request was never written down at all.**
//!
//! A body a provider calls invalid is invalid *structurally*: an unanswered `tool_use`, a
//! duplicated id, a part type that is not a part, a `tool_use` naming a tool that was never
//! declared. Every one of those is visible in the request the instant it is sent. This module
//! renders them as a single line, and [`describe_request`] is called on the failure path where the
//! body is still in hand.
//!
//! **Structural only, by design.** Ids, counts, roles and part types — never message text, never
//! an image's bytes. That is what makes it safe to write to a log: it can say *"`call_2` at message
//! 1 is unanswered"* without putting the conversation in a file.
//!
//! Measured 2026-10-15 (D109): for the body that `agentrouter.org` refused, this produces
//! `UNANSWERED_TOOL_USE=["call_2@m1"]` — the same defect the provider named in its own words
//! (*"`tool_use` ids were found without `tool_result` blocks immediately after: call_2"*), from the
//! request side, without an external experiment. That is the diagnosis that cost a full
//! investigation and should have cost one log line.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Map, Value};

/// How many ids of a kind are named before the remainder are counted instead.
const MAX_NAMED: usize = 5;

/// Part types this router renders for at least one dialect. Anything else is reported: a part no
/// dialect can name is both the shape most likely to be refused and the hardest to see.
const KNOWN_PART_TYPES: [&str; 7] =
    ["text", "image", "document", "tool_use", "tool_result", "thinking", "redacted_thinking"];

/// Whether a status is one where the *body* is what the provider is objecting to.
///
/// The gate exists so the report lands only where it can be true. A `401`/`402`/`403`/`404`/`429` is
/// about the key, the balance, the route or the pace — the request's shape is not in question, and a
/// line about it there is noise that trains the reader to skip the line that matters. `400`/`422`
/// are the schema statuses proper; a `5xx` is included because the case this was built for arrived
/// as `500`: the aggregator reports a refusal past its own edge as a server error, with
/// `tokens_in = 0`, because the request never reached the model.
pub fn is_shape_refusal(status: u16) -> bool {
    matches!(status, 400 | 422) || status >= 500
}

/// The shape to report for a refusal, or `None` when the status is not about the body.
///
/// One call so the gate and the description cannot drift apart at the call site, and so the
/// composition is testable without a logging subscriber: the interpreter's refusal branch is then a
/// trivial `if let Some(line)`, and this is where the decision lives. TS twin: `refusalShape`.
pub fn refusal_shape(status: u16, body: &Map<String, Value>, bytes: usize) -> Option<String> {
    is_shape_refusal(status).then(|| describe_request(body, bytes))
}

/// A one-line structural description of an outgoing request body.
///
/// `bytes` is the serialized length, passed in rather than recomputed: the caller has just
/// serialized the body to send it, and re-serializing a multi-megabyte request on the failure path
/// would double the memory cost of the failure for a number it already knows.
pub fn describe_request(body: &Map<String, Value>, bytes: usize) -> String {
    let Some(messages) = body.get("messages").and_then(Value::as_array) else {
        return format!("request {bytes}B messages=absent");
    };

    // **Which pairing rule applies is decided by the body, once.** The part-array shape (Anthropic,
    // Gemini) answers a `tool_use` with a `tool_result` in the message immediately after it. The
    // OpenAI shape answers a `tool_calls` entry with a `role:"tool"` message. Applying the array
    // rule to an OpenAI body would accuse every turn it has, which is worse than saying nothing —
    // a diagnostic that cries wolf is one nobody reads.
    let array_shape = messages.iter().any(|m| {
        m.get("content")
            .and_then(Value::as_array)
            .map_or(false, |a| {
                a.iter().any(|p| {
                    matches!(
                        p.get("type").and_then(Value::as_str),
                        Some("tool_use") | Some("tool_result")
                    )
                })
            })
    });

    let declared: Vec<String> = body
        .get("tools")
        .and_then(Value::as_array)
        .map(|ts| ts.iter().filter_map(declared_tool_name).collect())
        .unwrap_or_default();

    let mut roles: BTreeMap<String, usize> = BTreeMap::new();
    let mut parts: BTreeMap<String, usize> = BTreeMap::new();
    let mut empty_content: Vec<String> = Vec::new();
    let mut empty_text_parts = 0usize;
    let mut unknown_parts: Vec<String> = Vec::new();
    let mut undeclared_tools: Vec<String> = Vec::new();
    let mut unanswered: Vec<String> = Vec::new();
    let mut orphan_results: Vec<String> = Vec::new();
    let mut duplicate_ids: Vec<String> = Vec::new();
    let mut declared_ids: BTreeSet<String> = BTreeSet::new();

    for (i, m) in messages.iter().enumerate() {
        let role = m.get("role").and_then(Value::as_str).unwrap_or("<no-role>");
        *roles.entry(role.to_string()).or_default() += 1;

        // An assistant turn with empty content is legal for a tool call (it is *required*, for
        // OpenAI) and is still worth counting: it is the message a naive reader calls "blank".
        match m.get("content") {
            Some(Value::String(s)) if s.is_empty() => empty_content.push(format!("m{i}")),
            Some(Value::Array(a)) if a.is_empty() => empty_content.push(format!("m{i}")),
            _ => {}
        }

        // The OpenAI shape's pairing, on its own terms: the `tool` messages that follow must answer
        // every id this turn called.
        if !array_shape {
            let calls = tool_call_ids(m);
            if !calls.is_empty() {
                let mut answered: BTreeSet<String> = BTreeSet::new();
                for next in messages.iter().skip(i + 1) {
                    if next.get("role").and_then(Value::as_str) != Some("tool") {
                        break;
                    }
                    if let Some(id) = next.get("tool_call_id").and_then(Value::as_str) {
                        answered.insert(id.to_string());
                    }
                }
                for id in calls {
                    if !answered.contains(&id) {
                        unanswered.push(format!("{id}@m{i}"));
                    }
                }
            }
        }

        let Some(arr) = m.get("content").and_then(Value::as_array) else {
            continue;
        };
        for p in arr {
            let Some(part) = p.as_object() else {
                unknown_parts.push(format!("<non-object>@m{i}"));
                continue;
            };
            let ty = part.get("type").and_then(Value::as_str).unwrap_or("<no-type>");
            *parts.entry(ty.to_string()).or_default() += 1;
            if !KNOWN_PART_TYPES.contains(&ty) {
                unknown_parts.push(format!("{ty}@m{i}"));
            }
            match ty {
                "text" => {
                    if part.get("text").and_then(Value::as_str).unwrap_or_default().is_empty() {
                        empty_text_parts += 1;
                    }
                }
                "tool_use" => {
                    if let Some(id) = part.get("id").and_then(Value::as_str) {
                        if !declared_ids.insert(id.to_string()) {
                            duplicate_ids.push(id.to_string());
                        }
                    }
                    // A call to a tool the request never declared has no schema to validate
                    // against, which strict providers refuse. Only checked when `tools` is present:
                    // a body with no `tools` at all is a different question.
                    if let Some(name) = part.get("name").and_then(Value::as_str) {
                        if !declared.is_empty() && !declared.iter().any(|d| d == name) {
                            undeclared_tools.push(format!("{name}@m{i}"));
                        }
                    }
                }
                "tool_result" => {
                    if let Some(id) = part.get("tool_use_id").and_then(Value::as_str) {
                        if !declared_ids.contains(id) {
                            orphan_results.push(format!("{id}@m{i}"));
                        }
                    }
                }
                _ => {}
            }
        }

        // **The check that would have named D109 on sight.** Every `tool_use` of this message must
        // be answered by a `tool_result` in the message immediately after it; the provider's own
        // words for a violation are quoted in that row's entry.
        if array_shape {
            let uses = tool_use_ids(m);
            if !uses.is_empty() {
                let answered = messages.get(i + 1).map(tool_result_ids).unwrap_or_default();
                for id in uses {
                    if !answered.contains(&id) {
                        unanswered.push(format!("{id}@m{i}"));
                    }
                }
            }
        }
    }

    let mut out = format!("request {bytes}B messages={}", messages.len());
    out.push_str(&format!(" roles{{{}}}", histogram(&roles)));
    if !parts.is_empty() {
        out.push_str(&format!(" parts{{{}}}", histogram(&parts)));
    }
    if !declared.is_empty() {
        out.push_str(&format!(" tools={}", declared.len()));
    }
    if !empty_content.is_empty() {
        out.push_str(&format!(" empty_content={}", capped(&empty_content)));
    }
    if empty_text_parts > 0 {
        out.push_str(&format!(" empty_text_parts={empty_text_parts}"));
    }
    if !unknown_parts.is_empty() {
        out.push_str(&format!(" unknown_parts={}", capped(&unknown_parts)));
    }
    // Capitalised, and first among the findings, because these four are the ones that make a body
    // *invalid* rather than merely unusual.
    if !unanswered.is_empty() {
        out.push_str(&format!(" UNANSWERED_TOOL_USE={}", capped(&unanswered)));
    }
    if !orphan_results.is_empty() {
        out.push_str(&format!(" ORPHAN_TOOL_RESULT={}", capped(&orphan_results)));
    }
    if !duplicate_ids.is_empty() {
        out.push_str(&format!(" DUPLICATE_TOOL_USE_ID={}", capped(&duplicate_ids)));
    }
    if !undeclared_tools.is_empty() {
        out.push_str(&format!(" UNDECLARED_TOOL={}", capped(&undeclared_tools)));
    }
    // Said out loud, because "nothing to see" is itself an answer: it rules the shape out and sends
    // the next investigation to the content, which is what D110 still needs.
    let clean = unanswered.is_empty()
        && orphan_results.is_empty()
        && duplicate_ids.is_empty()
        && undeclared_tools.is_empty()
        && unknown_parts.is_empty()
        && empty_content.is_empty()
        && empty_text_parts == 0;
    if clean {
        out.push_str(" shape=clean");
    }
    out
}

/// A tool's name, from either declaration shape: Anthropic's flat `{name,…}` or OpenAI's nested
/// `{type:"function",function:{name}}`.
fn declared_tool_name(t: &Value) -> Option<String> {
    if let Some(n) = t.get("name").and_then(Value::as_str) {
        return Some(n.to_string());
    }
    t.get("function").and_then(|f| f.get("name")).and_then(Value::as_str).map(str::to_string)
}

/// The `tool_use` ids a part-array message declares.
fn tool_use_ids(m: &Value) -> Vec<String> {
    m.get("content")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter(|p| p.get("type").and_then(Value::as_str) == Some("tool_use"))
                .filter_map(|p| p.get("id").and_then(Value::as_str).map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// The ids a message answers: `tool_result` parts, plus a bare `tool_call_id` so a `role:"tool"`
/// message counts as an answer too. Tolerating both keeps the check from reporting a violation for
/// a body that mixes the two shapes — a false accusation is the failure mode worth avoiding here.
fn tool_result_ids(m: &Value) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    if let Some(arr) = m.get("content").and_then(Value::as_array) {
        for p in arr {
            if p.get("type").and_then(Value::as_str) == Some("tool_result") {
                if let Some(id) = p.get("tool_use_id").and_then(Value::as_str) {
                    out.insert(id.to_string());
                }
            }
        }
    }
    if let Some(id) = m.get("tool_call_id").and_then(Value::as_str) {
        out.insert(id.to_string());
    }
    out
}

/// The ids an OpenAI-shaped turn calls.
fn tool_call_ids(m: &Value) -> Vec<String> {
    m.get("tool_calls")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|c| c.get("id").and_then(Value::as_str).map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn histogram(map: &BTreeMap<String, usize>) -> String {
    map.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join(",")
}

/// The named items, or the first [`MAX_NAMED`] and a count of the rest — a body can carry thousands
/// of ids and the line has to stay a line.
fn capped(items: &[String]) -> String {
    if items.len() <= MAX_NAMED {
        format!("{items:?}")
    } else {
        format!("{:?}+{}more", &items[..MAX_NAMED], items.len() - MAX_NAMED)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn describe(v: Value) -> String {
        let obj = v.as_object().expect("a body is an object");
        describe_request(obj, 1234)
    }

    /// **The D109 shape, and the line that would have named it.** Two calls in one assistant turn,
    /// an image message wedged between their results — the second `tool_result` is one message too
    /// late, which is exactly what `agentrouter.org` refused:
    ///
    /// ```text
    /// messages.1:`tool_use` ids were found without `tool_result` blocks immediately after: call_2.
    /// ```
    ///
    /// The expectation is the *specific id*, not "something is wrong": a report that flags the
    /// wrong turn is worse than none, because it sends the next reader to the wrong place.
    #[test]
    fn the_d109_split_shape_names_the_unanswered_id() {
        let out = describe(json!({
            "model": "m",
            "messages": [
                { "role": "user", "content": "load it" },
                { "role": "assistant", "content": [
                    { "type": "tool_use", "id": "call_1", "name": "read_image", "input": {} },
                    { "type": "tool_use", "id": "call_2", "name": "run_command", "input": {} },
                ]},
                { "role": "user", "content": [
                    { "type": "tool_result", "tool_use_id": "call_1", "content": "loaded" },
                ]},
                { "role": "user", "content": [
                    { "type": "text", "text": "[image]" },
                    { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "AA==" } },
                ]},
                { "role": "user", "content": [
                    { "type": "tool_result", "tool_use_id": "call_2", "content": "done" },
                ]},
            ],
        }));
        assert!(out.contains("UNANSWERED_TOOL_USE=[\"call_2@m1\"]"), "{out}");
        // `call_1` was answered in the next message, so it must not be named.
        assert!(!out.contains("call_1@"), "the answered call is not accused: {out}");
        assert!(!out.contains("shape=clean"), "{out}");
    }

    /// The same turn with both results together — the arrangement the fix produces, and the one the
    /// upstream answers `200`. It must come back clean, or the report is unusable as a signal.
    #[test]
    fn the_corrected_ordering_is_reported_clean() {
        let out = describe(json!({
            "model": "m",
            "messages": [
                { "role": "user", "content": "load it" },
                { "role": "assistant", "content": [
                    { "type": "tool_use", "id": "call_1", "name": "read_image", "input": {} },
                    { "type": "tool_use", "id": "call_2", "name": "run_command", "input": {} },
                ]},
                { "role": "user", "content": [
                    { "type": "tool_result", "tool_use_id": "call_1", "content": "loaded" },
                    { "type": "tool_result", "tool_use_id": "call_2", "content": "done" },
                ]},
            ],
        }));
        assert!(out.contains("shape=clean"), "{out}");
    }

    /// **An OpenAI-shaped body must not be accused by the array rule.** Its tool results ride on
    /// `role:"tool"` messages, so the array check would find every turn unanswered. A diagnostic
    /// that fires on valid traffic is one that gets filtered out of the log and stops being read.
    #[test]
    fn an_openai_shaped_body_is_judged_by_its_own_rule() {
        let out = describe(json!({
            "model": "m",
            "messages": [
                { "role": "user", "content": "go" },
                { "role": "assistant", "content": "", "tool_calls": [
                    { "id": "call_1", "type": "function", "function": { "name": "ls", "arguments": "{}" } },
                ]},
                { "role": "tool", "content": "a.txt", "tool_call_id": "call_1" },
            ],
        }));
        assert!(!out.contains("UNANSWERED"), "{out}");

        // …and the same shape with the result missing *is* caught.
        let missing = describe(json!({
            "model": "m",
            "messages": [
                { "role": "user", "content": "go" },
                { "role": "assistant", "content": "", "tool_calls": [
                    { "id": "call_1", "type": "function", "function": { "name": "ls", "arguments": "{}" } },
                ]},
                { "role": "user", "content": "and now?" },
            ],
        }));
        assert!(missing.contains("UNANSWERED_TOOL_USE=[\"call_1@m1\"]"), "{missing}");
    }

    #[test]
    fn an_orphan_result_a_duplicate_id_and_an_undeclared_tool_are_each_named() {
        let orphan = describe(json!({
            "messages": [
                { "role": "user", "content": [
                    { "type": "tool_result", "tool_use_id": "call_ghost", "content": "x" },
                ]},
            ],
        }));
        assert!(orphan.contains("ORPHAN_TOOL_RESULT=[\"call_ghost@m0\"]"), "{orphan}");

        let dupe = describe(json!({
            "messages": [
                { "role": "assistant", "content": [
                    { "type": "tool_use", "id": "call_1", "name": "ls", "input": {} },
                    { "type": "tool_use", "id": "call_1", "name": "ls", "input": {} },
                ]},
                { "role": "user", "content": [
                    { "type": "tool_result", "tool_use_id": "call_1", "content": "x" },
                ]},
            ],
        }));
        assert!(dupe.contains("DUPLICATE_TOOL_USE_ID=[\"call_1\"]"), "{dupe}");

        let undeclared = describe(json!({
            "tools": [{ "name": "ls", "input_schema": { "type": "object" } }],
            "messages": [
                { "role": "assistant", "content": [
                    { "type": "tool_use", "id": "call_1", "name": "rm_rf", "input": {} },
                ]},
                { "role": "user", "content": [
                    { "type": "tool_result", "tool_use_id": "call_1", "content": "x" },
                ]},
            ],
        }));
        assert!(undeclared.contains("UNDECLARED_TOOL=[\"rm_rf@m0\"]"), "{undeclared}");
    }

    #[test]
    fn empty_content_empty_text_and_unknown_parts_are_counted_not_ignored() {
        let out = describe(json!({
            "messages": [
                { "role": "assistant", "content": "" },
                { "role": "assistant", "content": [] },
                { "role": "assistant", "content": [
                    { "type": "text", "text": "" },
                    { "type": "video", "source": {} },
                ]},
            ],
        }));
        assert!(out.contains("empty_content=[\"m0\", \"m1\"]"), "{out}");
        assert!(out.contains("empty_text_parts=1"), "{out}");
        assert!(out.contains("unknown_parts=[\"video@m2\"]"), "{out}");
        // None of these makes the body invalid on its own, so the line must not claim it is.
        assert!(!out.contains("UNANSWERED"), "{out}");
    }

    /// A body with no `messages` at all still has to describe itself rather than panic or lie.
    #[test]
    fn a_body_without_messages_says_so() {
        assert_eq!(describe(json!({ "model": "m" })), "request 1234B messages=absent");
    }

    /// The gate, stated: a schema refusal is reported, and a status about the key, the balance, the
    /// route or the pace is not. `500` is in the first set because that is the status this was
    /// built for — an aggregator reporting a body refusal past its own edge.
    #[test]
    fn only_a_shape_refusal_is_described() {
        for s in [400, 422, 500, 502, 503, 529] {
            assert!(is_shape_refusal(s), "{s} is a shape refusal");
        }
        for s in [200, 401, 402, 403, 404, 409, 413, 429] {
            assert!(!is_shape_refusal(s), "{s} is about something else");
        }

        // And the composed seam the interpreter calls: a description for a shape refusal, nothing
        // for the rest. `usize::MAX` as the size so the number can never be mistaken for the
        // default — the point is that the caller's byte count is the one reported.
        let body = json!({ "messages": [{ "role": "user", "content": "hi" }] });
        let body = body.as_object().unwrap();
        let line = refusal_shape(500, body, 1234).expect("a 500 refusal is described");
        assert!(line.contains("request 1234B messages=1"), "{line}");
        assert!(line.contains("shape=clean"), "{line}");
        assert_eq!(refusal_shape(429, body, 1234), None);
    }

    /// The line stays one line however many ids there are: a log entry that runs for a page is not
    /// read, and the count is what matters once the first few are named.
    #[test]
    fn a_long_id_list_is_capped_and_counted() {
        let calls: Vec<Value> = (0..9)
            .map(|i| json!({ "type": "tool_use", "id": format!("call_{i}"), "name": "ls", "input": {} }))
            .collect();
        let out = describe(json!({
            "messages": [{ "role": "assistant", "content": calls }],
        }));
        assert!(out.contains("+4more"), "{out}");
        assert!(!out.contains("call_8"), "the tail is counted, not named: {out}");
    }
}
