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

use crate::gateway::{
    check_gateway_key, clean_assistant_text, err, forwarded_headers, map_generic_to_status,
    peer_ip, try_slot, worker_status, BridgeMsg, BridgeRequest, GatewayCore,
};
use crate::gateway::context_scope::{
    apply_memory_headers, finish_capture, inject_context, prepare_capture,
};

/// OpenAI Responses API ingress (v1.1, 2026-09-16): Codex-style clients. Edge translation
/// to the normalized chat call; the router core stays single-surface.
fn to_chat_body_responses(req: &Value) -> Option<Value> {
    let model = req.get("model").and_then(Value::as_str)?;
    let mut messages: Vec<Value> = Vec::new();
    if let Some(inst) = req.get("instructions").and_then(Value::as_str) {
        messages.push(json!({ "role": "system", "content": inst }));
    }
    match req.get("input") {
        Some(Value::String(t)) => messages.push(json!({ "role": "user", "content": t.clone() })),
        Some(Value::Array(items)) => {
            for it in items {
                let role = it.get("role").and_then(Value::as_str).unwrap_or("user");
                let content = match it.get("content") {
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
                };
                messages.push(json!({ "role": role, "content": content }));
            }
        }
        _ => return None,
    }
    let mut out = json!({
        "model": model,
        "messages": messages,
        "stream": req.get("stream").and_then(Value::as_bool).unwrap_or(false),
        "max_tokens": req.get("max_output_tokens").and_then(Value::as_i64).unwrap_or(1024),
    });
    // forward tools parameters to upstream providers
    if req.get("tools").is_some() {
        out["tools"] = req["tools"].clone();
    }
    if req.get("tool_choice").is_some() {
        out["tool_choice"] = req["tool_choice"].clone();
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

pub(crate) async fn responses_h(State(core): State<Arc<GatewayCore>>, headers: HeaderMap, uri: axum::http::Uri, body: String) -> Response {
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
        return err(StatusCode::BAD_REQUEST, responses_error("model and input are required", "missing_required_parameter"));
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
    core.bridge.dispatch(BridgeRequest { request_id: id, kind: "responses", body: chat.clone(), headers: fwd.clone() });
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
                    BridgeMsg::Error { status, message } => {
                        // The SSE stream is already committed as 200, so the failure has to be
                        // described in the event payload. Emitting only a message left the client
                        // to guess whether to retry, re-authenticate, or fix the request.
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
                    .or(tool_choice.as_ref().map(|tc| tc.clone()))
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
        let mut r = Sse::new(stream_body).keep_alive(KeepAlive::new().interval(Duration::from_secs(15))).into_response();
        apply_memory_headers(&mut r, &outcome);
        return r;
    }

    // Non-streaming path.
    let mut full = String::new();
    let mut err_info: Option<(u16, String)> = None;
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
            BridgeMsg::Error { status, message } => {
                err_info = Some((status, message));
                break;
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
                break;
            }
            BridgeMsg::Usage { prompt_tokens, completion_tokens } => {
                usage = Some((prompt_tokens, completion_tokens));
            }
        }
    }
    drop(slot);
    let mut r = match err_info {
        Some((status, message)) => {
            let code = worker_status(status);
            let (ty, kind) = responses_error_kind(code);
            err(code, json!({ "error": { "message": message, "type": ty, "code": kind } }))
        }
        None => {
            let mut content: Vec<Value> = vec![json!({ "type": "output_text", "text": clean_assistant_text(&full), "annotations": [] })];
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
            (StatusCode::OK, [(header::CONTENT_TYPE, "application/json")], resp_body.to_string()).into_response()
        }
    };
    apply_memory_headers(&mut r, &outcome);
    r
}
