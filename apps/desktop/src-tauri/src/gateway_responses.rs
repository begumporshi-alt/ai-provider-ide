//! OpenAI Responses ingress — Codex-style clients (§3.4 extended).
//!
//! Split out of `gateway.rs` (audit R8): one module per wire dialect.

use std::sync::Arc;
use std::time::Duration;

use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use serde_json::{json, Value};

use crate::gateway::context_scope::{
    apply_memory_headers, finish_capture, inject_context, prepare_capture,
};
use crate::gateway::{
    check_gateway_key, clean_assistant_text, err, err_with_cooldown, forwarded_headers,
    map_generic_to_status, peer_ip, try_slot, worker_status, BridgeMsg, BridgeRequest, GatewayCore,
};

/// OpenAI Responses API ingress (v1.1, 2026-09-16): Codex-style clients. Edge translation
/// to the normalized chat call; the router core stays single-surface.
/// The text of a Responses content part. `input_text` / `output_text` parts carry `text`; some
/// clients send `content` instead, so both are read.
fn item_text(item: &Value) -> String {
    match item.get("content") {
        Some(Value::String(t)) => t.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|p| {
                p.get("text")
                    .and_then(Value::as_str)
                    .or_else(|| p.get("content").and_then(Value::as_str))
            })
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

/// The payload of a `function_call_output`. Usually a string; anything else is stringified
/// rather than dropped, because a lost tool result is worse than an ugly one.
fn function_output_text(item: &Value) -> String {
    match item.get("output") {
        Some(Value::String(s)) => s.clone(),
        Some(v) if !v.is_null() => v.to_string(),
        _ => String::new(),
    }
}

/// Responses `input` items -> OpenAI messages.
///
/// The same class of fix as the Anthropic ingress: `function_call` items become `tool_calls` on
/// an assistant turn, and `function_call_output` items become `{"role":"tool"}` messages. Reading
/// only `role` / `content` off every item — which is what this did — turned a function call into
/// an empty *user* turn and discarded its result, so a Codex-style client was answering against
/// a transcript in which its own tool calls had never happened.
fn items_to_openai(req: &Value) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    // Consecutive `function_call` items are one assistant turn making several calls — that is
    // how parallel tool use arrives. They are merged so the tool messages that follow line up.
    let mut calls: Vec<Value> = Vec::new();
    for it in req.get("input").and_then(Value::as_array).into_iter().flatten() {
        let kind = it.get("type").and_then(Value::as_str).unwrap_or("");
        if kind == "function_call" {
            // Responses already carries arguments as a string; an object is stringified so the
            // provider is never handed a shape it cannot parse.
            let args = match it.get("arguments") {
                Some(Value::String(s)) => s.clone(),
                Some(v) if !v.is_null() => v.to_string(),
                _ => "{}".to_string(),
            };
            calls.push(json!({
                "id": it.get("call_id").and_then(Value::as_str).unwrap_or(""),
                "type": "function",
                "function": {
                    "name": it.get("name").and_then(Value::as_str).unwrap_or(""),
                    "arguments": args
                }
            }));
            continue;
        }
        if !calls.is_empty() {
            out.push(json!({ "role": "assistant", "content": "", "tool_calls": std::mem::take(&mut calls) }));
        }
        match kind {
            "function_call_output" => out.push(json!({
                "role": "tool",
                "tool_call_id": it.get("call_id").and_then(Value::as_str).unwrap_or(""),
                "content": function_output_text(it)
            })),
            // A reasoning item carries no role and no content. Emitting it as an empty user
            // turn — which is what happened — invents a turn the client never sent.
            "reasoning" => {}
            _ => {
                // Only items that actually carry content become turns; an unrecognised item is
                // skipped rather than emitted as an empty message.
                if it.get("role").is_some() || it.get("content").is_some() {
                    let role = it.get("role").and_then(Value::as_str).unwrap_or("user");
                    out.push(json!({ "role": role, "content": item_text(it) }));
                }
            }
        }
    }
    if !calls.is_empty() {
        out.push(json!({ "role": "assistant", "content": "", "tool_calls": calls }));
    }
    out
}

/// Responses tool declarations -> OpenAI function declarations.
///
/// Responses declares a tool FLAT (`{type, name, description, parameters, strict}`) while chat
/// completions nests the same fields under `function`. Forwarding them unchanged — which is what
/// this did — handed a chat-completions provider a shape it rejects outright. The Anthropic
/// ingress already converted; this is the same conversion for the other dialect.
fn responses_tools_to_openai(tools: &Value) -> Option<Value> {
    let arr = tools.as_array()?;
    let out: Vec<Value> = arr
        .iter()
        .filter_map(|t| {
            // Already nested — some clients send the chat shape. Leave those alone.
            if t.get("function").is_some() {
                return Some(t.clone());
            }
            let name = t.get("name").and_then(Value::as_str)?;
            let mut function = json!({
                "name": name,
                // A tool with no schema still needs one, or the model has nowhere to put args.
                "parameters": t.get("parameters").cloned()
                    .unwrap_or_else(|| json!({ "type": "object", "properties": {} })),
            });
            // Omitted rather than null: providers reject a null description.
            if let Some(d) = t.get("description").and_then(Value::as_str) {
                function["description"] = json!(d);
            }
            Some(json!({ "type": "function", "function": function }))
        })
        .collect();
    if out.is_empty() {
        None
    } else {
        Some(Value::Array(out))
    }
}

/// Responses `tool_choice` -> OpenAI. A bare string (`auto` / `none` / `required`) means the same
/// thing on both wires; only the object form, which names the tool at the top level, needs nesting.
fn responses_tool_choice_to_openai(tc: &Value) -> Option<Value> {
    if !tc.is_string() {
        if let Some("function") = tc.get("type").and_then(Value::as_str) {
            if let Some(n) = tc.get("name").and_then(Value::as_str) {
                return Some(json!({ "type": "function", "function": { "name": n } }));
            }
        }
    }
    Some(tc.clone())
}

fn to_chat_body_responses(req: &Value) -> Option<Value> {
    let model = req.get("model").and_then(Value::as_str)?;
    let mut messages: Vec<Value> = Vec::new();
    if let Some(inst) = req.get("instructions").and_then(Value::as_str) {
        messages.push(json!({ "role": "system", "content": inst }));
    }
    match req.get("input") {
        Some(Value::String(t)) => messages.push(json!({ "role": "user", "content": t.clone() })),
        Some(Value::Array(_)) => messages.extend(items_to_openai(req)),
        _ => return None,
    }
    let mut out = json!({
        "model": model,
        "messages": messages,
        "stream": req.get("stream").and_then(Value::as_bool).unwrap_or(false),
        "max_tokens": req.get("max_output_tokens").and_then(Value::as_i64).unwrap_or(1024),
    });
    // Converted, not cloned: Responses declares these flat and the bridge speaks chat
    // completions. Forwarding them verbatim sent the provider a shape it rejects.
    if let Some(tools) = req.get("tools").and_then(responses_tools_to_openai) {
        out["tools"] = tools;
    }
    if let Some(tc) = req.get("tool_choice").and_then(responses_tool_choice_to_openai) {
        out["tool_choice"] = tc;
    }
    Some(out)
}

fn responses_error(message: &str, code: &str) -> Value {
    json!({ "error": { "message": message, "type": "invalid_request_error", "code": code } })
}

/// The `(type, code)` pair that belongs to an HTTP status for an *upstream* failure.
///
/// `responses_error` hardcodes `type: "invalid_request_error"`, which is correct for the local
/// validation failures it was written for but wrong for a fault that came from upstream: a 503
/// labelled `invalid_request_error` tells the client its request was malformed and that editing
/// it will help. Derive both fields from the status instead.
fn responses_error_kind(status: StatusCode) -> (&'static str, &'static str) {
    match status.as_u16() {
        400 | 404 | 413 | 422 => ("invalid_request_error", "invalid_request_error"),
        429 => ("rate_limit_error", "rate_limit_exceeded"),
        503 => ("server_error", "service_unavailable"),
        _ => ("server_error", "server_error"),
    }
}

/// Strip tools/tool_choice/response_format from a forwarded chat body when the
/// gateway's tools toggle is disabled. Called after translating ingress dialects
/// so the router core never receives those fields when tools are off.
#[allow(dead_code)]
fn strip_tool_fields(body: &mut Value, enabled: bool) {
    if !enabled {
        if let Some(obj) = body.as_object_mut() {
            obj.remove("tools");
            obj.remove("tool_choice");
            obj.remove("response_format");
        }
    }
}

pub(crate) async fn responses_h(
    State(core): State<Arc<GatewayCore>>,
    headers: HeaderMap,
    uri: axum::http::Uri,
    body: String,
) -> Response {
    // ?key= fallback for Gemini-style query auth is handled in gemini_h; Responses uses Bearer.
    if let Some(r) = check_gateway_key(&core, &headers, peer_ip(&headers)) {
        // The Responses API error envelope is the OpenAI one, so this needs no translation.
        return r.openai();
    }
    let _ = uri;
    let Ok(req) = serde_json::from_str::<Value>(&body) else {
        return err(StatusCode::BAD_REQUEST, responses_error("invalid JSON body", "invalid_json"));
    };
    let Some(mut chat) = to_chat_body_responses(&req) else {
        return err(
            StatusCode::BAD_REQUEST,
            responses_error("model and input are required", "missing_required_parameter"),
        );
    };
    // Forward tools/tool_choice from the original Responses API request to upstream providers.
    let tools: Option<Value> = req.get("tools").cloned();
    let tool_choice: Option<Value> = req.get("tool_choice").cloned();
    // §3.4: strip when toggle is off
    if !core.is_tools_enabled() {
        if let Some(obj) = chat.as_object_mut() {
            obj.remove("tools");
            obj.remove("tool_choice");
            obj.remove("response_format");
        }
    }
    let wants_stream = chat.get("stream").and_then(Value::as_bool).unwrap_or(false);
    let mut slot = match try_slot(&core).await {
        Ok(s) => s,
        Err(r) => return map_generic_to_status(r),
    };
    let id = slot.id;
    let resp_id = format!("resp_gw_{id}");
    let fwd = forwarded_headers(&headers);
    let outcome = inject_context(&core, &headers, Some(&req), &mut chat);
    // Read from `chat`, not `req`: translation is what puts a model on the canonical body, and the
    // same value is what the upstream dispatch below reports.
    core.record_injection(id, chat.get("model").and_then(Value::as_str).unwrap_or(""), &outcome);
    // `chat`, not `req`: the canonical body is the one with normalized messages and a model.
    let prep = prepare_capture(&core, &headers, &chat, id);
    core.bridge.dispatch(BridgeRequest {
        request_id: id,
        kind: "responses",
        body: chat.clone(),
        headers: fwd.clone(),
    });
    tracing::info!(request_id = id, kind = "responses", model = %chat.get("model").unwrap_or(&json!("")).as_str().unwrap_or(""), "dispatching responses request");

    if wants_stream {
        let rid = resp_id.clone();
        let stream_tools = tools.clone();
        let stream_body = async_stream::stream! {
            // Moved in: the stream must be 'static, so it cannot borrow the request or headers.
            let prep = prep;
            let ev = |name: &str, payload: Value| Ok::<Event, std::convert::Infallible>(
                Event::default().event(name).data(payload.to_string()),
            );
            yield ev("response.created", json!({ "type": "response.created", "response": { "id": rid, "object": "response", "status": "in_progress" } }));
            yield ev("response.output_item.added", json!({ "type": "response.output_item.added", "output_index": 0,
                "item": { "id": format!("{rid}_out"), "type": "message", "role": "assistant", "status": "in_progress", "content": [] } }));
            yield ev("response.content_part.added", json!({ "type": "response.content_part.added", "item_id": format!("{rid}_out"), "output_index": 0,
                "content_index": 0, "part": { "type": "output_text", "text": "", "annotations": [] } }));
            let mut text = String::new();
            let mut tool_calls: Vec<(String, String, Value)> = Vec::new(); // call_id, name, arguments
            let mut usage: Option<(u64, u64)> = None;
            let mut tool_pending = false;
            while let Some(msg) = slot.recv().await {
                match msg {
                    BridgeMsg::Delta(t) => {
                        text.push_str(&t);
                        yield ev("response.output_text.delta", json!({ "type": "response.output_text.delta", "item_id": format!("{rid}_out"),
                            "output_index": 0, "content_index": 0, "delta": t }));
                    }
                    BridgeMsg::Result(_) => {}
                    BridgeMsg::Done => {
                        // `text` is the accumulated assistant output; this is the stream's Done.
                        if let Some(p) = &prep {
                            let _ = finish_capture(p, &text);
                        }
                        break;
                    }
                    BridgeMsg::Error { status, message, .. } => {
                        // The SSE stream is already committed as 200, so the failure has to be
                        // described in the event payload. Emitting only a message left the client
                        // to guess whether to retry, re-authenticate, or fix the request.
                        // `Retry-After` cannot help here — the status line was sent long ago.
                        let code = worker_status(status);
                        let (ty, kind) = responses_error_kind(code);
                        yield ev("response.failed", json!({ "type": "response.failed",
                            "response": { "id": rid, "object": "response", "status": "failed",
                                          "error": { "message": message, "type": ty, "code": kind } } }));
                        return;
                    }
                    BridgeMsg::ToolCalls(calls) => {
                        if let Some(arr) = calls.as_array() {
                            for tc in arr {
                                let call_id = tc.get("id").and_then(Value::as_str).unwrap_or("");
                                let name = tc.get("function").and_then(|f| f.get("name")).and_then(Value::as_str).unwrap_or("");
                                let args_raw = tc.get("function").and_then(|f| f.get("arguments")).unwrap_or(&Value::Null);
                                let args: Value = if let Some(s) = args_raw.as_str() {
                                    serde_json::from_str(s).unwrap_or(json!(s))
                                } else {
                                    args_raw.clone()
                                };
                                tool_calls.push((call_id.to_string(), name.to_string(), args));
                            }
                        }
                        tool_pending = true;
                        break;
                    }
                    BridgeMsg::Usage { prompt_tokens, completion_tokens } => {
                        usage = Some((prompt_tokens, completion_tokens));
                    }
                }
            }
            if !tool_pending {
                yield ev("response.output_text.done", json!({ "type": "response.output_text.done", "item_id": format!("{rid}_out"),
                "output_index": 0, "content_index": 0, "text": text.clone() }));
                // Emit any tool-call output items interleaved with the text content.
                let mut content_parts: Vec<Value> = vec![json!({ "type": "output_text", "text": text.clone(), "annotations": [] })];
                for (call_id, name, args) in &tool_calls {
                    yield ev("response.output_item.added", json!({ "type": "response.output_item.added", "output_index": 0,
                        "item": { "id": format!("{rid}_fc_{call_id}"), "type": "function_call", "call_id": call_id, "name": name, "arguments": args.to_string() } }));
                    yield ev("response.function_call_arguments.done", json!({ "type": "response.function_call_arguments.done", "item_id": format!("{rid}_fc_{call_id}"),
                        "output_index": 0, "arguments": args.to_string() }));
                    content_parts.push(json!({ "type": "function_call", "call_id": call_id, "name": name, "arguments": args.to_string() }));
                }
                yield ev("response.content_part.done", json!({ "type": "response.content_part.done", "item_id": format!("{rid}_out"),
                    "output_index": 0, "content_index": 0, "part": { "type": "output_text", "text": text.clone(), "annotations": [] } }));
                yield ev("response.output_item.done", json!({ "type": "response.output_item.done", "output_index": 0,
                    "item": { "id": format!("{rid}_out"), "type": "message", "role": "assistant", "status": "completed",
                        "content": content_parts } }));
                let resolved_tool_choice = stream_tools
                    .as_ref()
                    .map(|_| json!("auto"))
                    .or(tool_choice.clone())
                    .unwrap_or(json!("auto"));
                yield ev("response.completed", json!({ "type": "response.completed",
                    "response": { "id": rid, "object": "response", "status": "completed",
                        "output": [{ "type": "message", "role": "assistant", "content": content_parts }],
                        "usage": { "input_tokens": usage.map(|(p, _c)| p).unwrap_or(0), "output_tokens": usage.map(|(_p, c)| c).unwrap_or(0) },
                        "tools": stream_tools.unwrap_or(json!([])),
                        "tool_choice": resolved_tool_choice
                    } }));
            } else {
                return;
            }
            drop(slot);
        };
        let mut r = Sse::new(stream_body)
            .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
            .into_response();
        apply_memory_headers(&mut r, &outcome);
        return r;
    }

    // Non-streaming path.
    let mut full = String::new();
    let mut err_info: Option<(u16, String, Option<u64>)> = None;
    let mut tool_calls: Vec<(String, String, Value)> = Vec::new();
    let mut usage: Option<(u64, u64)> = None;
    while let Some(msg) = slot.recv().await {
        match msg {
            BridgeMsg::Delta(t) => full.push_str(&t),
            BridgeMsg::Result(_) => {}
            BridgeMsg::Done => {
                if let Some(p) = &prep {
                    let _ = finish_capture(p, &full);
                }
                break;
            }
            BridgeMsg::Error { status, message, retry_after_ms } => {
                err_info = Some((status, message, retry_after_ms));
                break;
            }
            BridgeMsg::ToolCalls(calls) => {
                if let Some(arr) = calls.as_array() {
                    for tc in arr {
                        let call_id = tc.get("id").and_then(Value::as_str).unwrap_or("");
                        let name = tc
                            .get("function")
                            .and_then(|f| f.get("name"))
                            .and_then(Value::as_str)
                            .unwrap_or("");
                        let args_raw = tc
                            .get("function")
                            .and_then(|f| f.get("arguments"))
                            .unwrap_or(&Value::Null);
                        let args: Value = if let Some(s) = args_raw.as_str() {
                            serde_json::from_str(s).unwrap_or(json!(s))
                        } else {
                            args_raw.clone()
                        };
                        tool_calls.push((call_id.to_string(), name.to_string(), args));
                    }
                }
                break;
            }
            BridgeMsg::Usage { prompt_tokens, completion_tokens } => {
                usage = Some((prompt_tokens, completion_tokens));
            }
        }
    }
    drop(slot);
    let mut r = match err_info {
        Some((status, message, retry_after_ms)) => {
            let code = worker_status(status);
            let (ty, kind) = responses_error_kind(code);
            err_with_cooldown(
                code,
                retry_after_ms,
                json!({ "error": { "message": message, "type": ty, "code": kind } }),
            )
        }
        None => {
            let mut content: Vec<Value> = vec![
                json!({ "type": "output_text", "text": clean_assistant_text(&full), "annotations": [] }),
            ];
            for (call_id, name, args) in &tool_calls {
                content.push(json!({ "type": "function_call", "call_id": call_id, "name": name, "arguments": args.to_string() }));
            }
            let (pt, ct) = usage.unwrap_or((0, 0));
            let resp_body = json!({
                "id": resp_id, "object": "response", "status": "completed",
                "output": [{ "type": "message", "role": "assistant", "content": content }],
                "usage": { "input_tokens": pt, "output_tokens": ct },
                "tools": tools.unwrap_or(json!([])),
                "tool_choice": tool_choice.unwrap_or(json!("auto"))
            });
            (StatusCode::OK, [(header::CONTENT_TYPE, "application/json")], resp_body.to_string())
                .into_response()
        }
    };
    apply_memory_headers(&mut r, &outcome);
    r
}

#[cfg(test)]
mod tool_conversion_tests {
    use super::*;

    fn req_with(input: Value) -> Value {
        json!({ "model": "mock-fast", "input": input })
    }

    #[test]
    fn a_function_call_becomes_openai_tool_calls() {
        let out = items_to_openai(&req_with(json!([
            { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "fix it" }] },
            { "type": "function_call", "call_id": "call_1", "name": "Bash", "arguments": "{\"command\":\"ls\"}" }
        ])));
        assert_eq!(out.len(), 2, "{out:?}");
        assert_eq!(out[1]["role"], "assistant");
        assert_eq!(out[1]["tool_calls"][0]["id"], "call_1");
        assert_eq!(out[1]["tool_calls"][0]["type"], "function");
        assert_eq!(out[1]["tool_calls"][0]["function"]["name"], "Bash");
        assert_eq!(out[1]["tool_calls"][0]["function"]["arguments"], "{\"command\":\"ls\"}");
    }

    #[test]
    fn a_function_call_output_becomes_a_tool_message() {
        let out = items_to_openai(&req_with(json!([
            { "type": "function_call_output", "call_id": "call_1", "output": "3 files" }
        ])));
        assert_eq!(out.len(), 1, "no stray empty turn: {out:?}");
        assert_eq!(out[0]["role"], "tool");
        assert_eq!(out[0]["tool_call_id"], "call_1");
        assert_eq!(out[0]["content"], "3 files");
    }

    #[test]
    fn a_reasoning_item_is_dropped_not_turned_into_an_empty_turn() {
        // A reasoning item has neither role nor content, so the old code turned it into
        // `{"role":"user","content":""}` — a turn the client never sent.
        let out = items_to_openai(&req_with(json!([
            { "type": "reasoning", "summary": [{ "type": "summary_text", "text": "thinking" }] }
        ])));
        assert!(out.is_empty(), "a reasoning item is not a turn: {out:?}");
    }

    #[test]
    fn a_flat_responses_tool_becomes_a_nested_openai_function() {
        let out = to_chat_body_responses(&json!({
            "model": "mock-fast",
            "input": "hi",
            "tools": [{ "type": "function", "name": "Bash", "description": "Run it",
                        "parameters": { "type": "object", "properties": { "command": { "type": "string" } } },
                        "strict": null }]
        }))
        .expect("a body");
        // Nested under `function`, not flat: a chat-completions provider rejects the flat shape.
        assert_eq!(out["tools"][0]["type"], "function");
        assert_eq!(out["tools"][0]["function"]["name"], "Bash");
        assert!(out["tools"][0].get("name").is_none(), "the flat name must not survive: {out}");
        assert_eq!(
            out["tools"][0]["function"]["parameters"]["properties"]["command"]["type"],
            "string"
        );
    }

    #[test]
    fn a_plain_message_transcript_is_untouched() {
        let out = items_to_openai(&req_with(json!([
            { "type": "message", "role": "user", "content": "hi" },
            { "type": "message", "role": "assistant", "content": "hello" }
        ])));
        assert_eq!(
            out,
            vec![
                json!({ "role": "user", "content": "hi" }),
                json!({ "role": "assistant", "content": "hello" })
            ]
        );
    }
}
