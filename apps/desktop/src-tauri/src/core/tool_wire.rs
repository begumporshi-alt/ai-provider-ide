//! Tool-call wire normalisation — the port of `tools/wire.ts` (82 lines).
//!
//! The router reports tool calls in a dialect-neutral shape ([`crate::core::adapter::ToolCall`]: a
//! flat `{id?, name?, arguments?}`). What goes on the wire is different and stricter:
//!
//! 1. Each entry needs `type: "function"` and a nested `function: {name, arguments}`. A flat
//!    `{id, name, arguments}` is not the shape OpenAI-compatible servers accept.
//! 2. The *result* turn must carry a `tool_call_id` that matches a declared `tool_calls[].id`
//!    exactly. A result naming a call the assistant turn never declared is rejected — every
//!    OpenAI-compatible provider answers HTTP 400 — and the whole continuation dies with it.
//!
//! Two defects made rule 2 impossible to satisfy, and they are why "the router stops after a tool
//! call" was reported: the assistant turn and the tool result each applied their **own** fallback for
//! a missing id (`""` in one place, the tool *name* in the other, so the two could never match), and
//! both turns were built flat, with no `type` and no nested `function`.
//!
//! Nothing required the two halves to agree because nothing built them together. The fix is to build
//! them together: [`to_wire_tool_calls`] returns the wire entries *and* the ids it chose, so the
//! assistant turn and the results are always derived from one decision. **That is the property to
//! preserve** — the ids and the entries are index-aligned by construction, and
//! `the_ids_and_the_entries_are_index_aligned` pins it.

use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{json, Value};

use crate::core::adapter::ToolCall;
use crate::core::gateway_normalizer::to_base36;

/// One entry of an assistant turn's `tool_calls`, in OpenAI's wire shape.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WireToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

impl WireToolCall {
    /// The object as it goes on the wire. `type` is a constant of the shape, so it is emitted here
    /// rather than stored on every entry.
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "type": "function",
            "function": { "name": self.name, "arguments": self.arguments },
        })
    }
}

/// The wire entries and the ids chosen for them, index-aligned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WireToolCalls {
    pub wire: Vec<WireToolCall>,
    /// `ids[i]` is the id of `wire[i]` — the one value a result turn must name.
    pub ids: Vec<String>,
}

/// Counter behind [`synthesized_id`].
///
/// Process-wide, so ids stay unique across every turn in the process — a value only has to be
/// *consistent within one pair*, but a repeat across turns would be a real ambiguity if a transcript
/// were ever replayed wholesale. An `AtomicU64` rather than a `static mut`: the bridge runs several
/// requests concurrently, and two turns interleaving must not draw the same number.
static SEQ: AtomicU64 = AtomicU64::new(0);

/// An id for a call the provider did not identify. The value is arbitrary; its stability is not.
///
/// The rendering is the reference's `call_${n.toString(36)}`, which is why it shares
/// [`to_base36`] with the normalizer rather than inventing a second spelling of the same conversion.
fn synthesized_id() -> String {
    let n = SEQ.fetch_add(1, Ordering::Relaxed) + 1;
    format!("call_{}", to_base36(n))
}

/// Normalise a batch of calls into the wire shape, returning the ids alongside so the caller can
/// pair each result with the call it answers. Index-aligned with the input.
pub fn to_wire_tool_calls(calls: &[ToolCall]) -> WireToolCalls {
    let mut wire = Vec::with_capacity(calls.len());
    let mut ids = Vec::with_capacity(calls.len());
    for call in calls {
        let id = match call.id.as_deref() {
            // `typeof c.id === "string" && c.id` — only a non-empty string is an id.
            Some(existing) if !existing.is_empty() => existing.to_string(),
            _ => synthesized_id(),
        };
        ids.push(id.clone());
        wire.push(WireToolCall {
            id,
            name: call.name.clone().unwrap_or_default(),
            // `arguments` is JSON text. An empty string is not valid JSON, so an *absent* value
            // becomes `{}` rather than "" — some servers parse it before dispatch. An empty string
            // the provider actually sent is left alone.
            arguments: call.arguments.clone().unwrap_or_else(|| "{}".to_string()),
        });
    }
    WireToolCalls { wire, ids }
}

/// Read a call's name from either shape — the flat internal one or the OpenAI wire one.
///
/// The context graph walks stored transcripts, which may hold either (an assistant turn written
/// before this module existed is flat; one written after is nested), so the reader is tolerant
/// rather than assuming the current writer.
pub fn tool_call_name(call: &Value) -> &str {
    if let Some(name) = call.get("name").and_then(Value::as_str) {
        if !name.is_empty() {
            return name;
        }
    }
    if let Some(name) = call.get("function").and_then(|f| f.get("name")).and_then(Value::as_str) {
        if !name.is_empty() {
            return name;
        }
    }
    "tool"
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(id: Option<&str>, name: Option<&str>, arguments: Option<&str>) -> ToolCall {
        ToolCall {
            id: id.map(str::to_string),
            name: name.map(str::to_string),
            arguments: arguments.map(str::to_string),
            raw: None,
        }
    }

    #[test]
    fn renders_the_openai_wire_shape() {
        let out =
            to_wire_tool_calls(&[call(Some("c1"), Some("read_file"), Some("{\"path\":\"a\"}"))]);
        assert_eq!(out.ids, vec!["c1".to_string()]);
        assert_eq!(
            out.wire[0].to_json(),
            json!({
                "id": "c1",
                "type": "function",
                "function": { "name": "read_file", "arguments": "{\"path\":\"a\"}" },
            })
        );
    }

    /// The defect this module exists to close: an absent id used to become `""` on one side and the
    /// tool *name* on the other, so the result could never match the declaration.
    #[test]
    fn synthesizes_an_id_when_the_provider_omits_one() {
        let out = to_wire_tool_calls(&[call(None, Some("read_file"), Some("{}"))]);
        assert_eq!(out.ids.len(), 1);
        assert!(!out.ids[0].is_empty());
        assert_eq!(out.wire[0].id, out.ids[0]);
    }

    /// An empty string is not an id either — `typeof c.id === "string" && c.id` is falsy for `""`.
    #[test]
    fn an_empty_string_id_is_replaced_too() {
        let out = to_wire_tool_calls(&[call(Some(""), Some("read_file"), None)]);
        assert!(!out.ids[0].is_empty());
    }

    /// The property the whole module is built around: entry `i` and id `i` describe one call.
    #[test]
    fn the_ids_and_the_entries_are_index_aligned() {
        let calls = vec![
            call(Some("keep"), Some("read_file"), Some("{}")),
            call(None, Some("list_dir"), None),
            call(Some(""), Some("file_info"), Some("{\"path\":\"x\"}")),
        ];
        let out = to_wire_tool_calls(&calls);
        assert_eq!(out.wire.len(), 3);
        assert_eq!(out.ids.len(), 3);
        assert_eq!(out.ids[0], "keep", "a supplied id is preserved verbatim");
        for (entry, id) in out.wire.iter().zip(out.ids.iter()) {
            assert_eq!(&entry.id, id);
        }
        assert_eq!(out.wire[1].name, "list_dir");
        assert_eq!(out.wire[2].name, "file_info");
    }

    /// Two calls with no id must not share one — a repeat inside a single turn is the ambiguity the
    /// ids exist to prevent.
    #[test]
    fn two_unidentified_calls_get_distinct_ids() {
        let out = to_wire_tool_calls(&[call(None, Some("a"), None), call(None, Some("b"), None)]);
        assert_ne!(out.ids[0], out.ids[1]);
    }

    /// An absent `arguments` becomes `{}` because an empty string is not valid JSON; a provider's
    /// own empty string is passed through, because that is what it said.
    #[test]
    fn an_absent_arguments_becomes_an_empty_object_but_an_empty_string_does_not() {
        let out = to_wire_tool_calls(&[
            call(Some("a"), Some("t"), None),
            call(Some("b"), Some("t"), Some("")),
        ]);
        assert_eq!(out.wire[0].arguments, "{}");
        assert_eq!(out.wire[1].arguments, "");
    }

    #[test]
    fn an_absent_name_becomes_an_empty_string() {
        let out = to_wire_tool_calls(&[call(Some("a"), None, Some("{}"))]);
        assert_eq!(out.wire[0].name, "");
    }

    #[test]
    fn an_empty_batch_is_empty() {
        let out = to_wire_tool_calls(&[]);
        assert!(out.wire.is_empty());
        assert!(out.ids.is_empty());
    }

    // ── tool_call_name ────────────────────────────────────────────────────

    #[test]
    fn reads_a_name_from_the_flat_shape() {
        assert_eq!(tool_call_name(&json!({ "name": "read_file" })), "read_file");
    }

    #[test]
    fn reads_a_name_from_the_nested_wire_shape() {
        assert_eq!(
            tool_call_name(&json!({ "type": "function", "function": { "name": "Bash" } })),
            "Bash"
        );
    }

    #[test]
    fn prefers_the_flat_name_when_both_are_present() {
        assert_eq!(
            tool_call_name(&json!({ "name": "flat", "function": { "name": "nested" } })),
            "flat"
        );
    }

    #[test]
    fn falls_back_to_tool_for_anything_unnameable() {
        assert_eq!(tool_call_name(&json!({})), "tool");
        assert_eq!(tool_call_name(&json!({ "name": "" })), "tool");
        assert_eq!(tool_call_name(&json!({ "name": 7 })), "tool");
        assert_eq!(tool_call_name(&json!({ "function": { "name": "" } })), "tool");
        assert_eq!(tool_call_name(&json!(null)), "tool");
        assert_eq!(tool_call_name(&json!("a string")), "tool");
        assert_eq!(tool_call_name(&json!([1, 2])), "tool");
    }
}
