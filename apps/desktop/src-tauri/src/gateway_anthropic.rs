//! Anthropic Messages ingress — Claude Code / anthropic-sdk clients (§3.4 extended).
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
    anthropic_error, check_gateway_key, err, forwarded_headers, peer_ip, try_slot, BridgeMsg,
    BridgeRequest, GatewayCore,
};

/// Anthropic Messages ingress (2026-09-16 amendment, DECISIONS.md): Claude Code and
/// anthropic-sdk clients can point at this IDE. The request is translated to the router's
/// normalized chat call; the reply is re-framed as Anthropic events. The router core stays
/// provider-agnostic — this is ingress-dialect translation at the edge, symmetric to the
/// egress dialects providers speak.
fn to_chat_body(req: &Value) -> Option<Value> {
    let model = req.get("model").and_then(Value::as_str)?;
    let mut messages: Vec<Value> = Vec::new();
    if let Some(system) = req.get("system").and_then(Value::as_str) {
        messages.push(json!({ "role": "system", "content": system }));
    }
    for m in req.get("messages").and_then(Value::as_array)? {
        let role = m.get("role").and_then(Value::as_str).unwrap_or("user");
        // content: string OR content blocks [{type:"text",text:…}] -> flattened to text
        let content = match m.get("content") {
            Some(Value::String(t)) => t.clone(),
            Some(Value::Array(blocks)) => blocks
                .iter()
                .filter_map(|b| b.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join(""),
            _ => String::new(),
        };
        messages.push(json!({ "role": role, "content": content }));
    }
    let mut out = json!({
        "model": model,
        "messages": messages,
        "stream": req.get("stream").and_then(Value::as_bool).unwrap_or(false),
        "max_tokens": req.get("max_tokens").and_then(Value::as_i64).unwrap_or(1024),
    });
    // forward tools parameters to upstream providers
    if req.get("tools").is_some() {
        out["tools"] = req["tools"].clone();
    }
    if req.get("tool_choice").is_some() {
        out["tool_choice"] = req["tool_choice"].clone();
    }
    if req.get("response_format").is_some() {
        out["response_format"] = req["response_format"].clone();
    }
    Some(out)
}

fn anthropic_stop_reason(cls: Option<&str>) -> &'static str {
    match cls {
        Some("length") => "max_tokens",
        Some("tool_use") => "tool_use",
        _ => "end_turn",
    }
}

pub(crate) async fn messages_h(State(core): State<Arc<GatewayCore>>, headers: HeaderMap, body: String) -> Response {
    if let Some(r) = check_gateway_key(&core, &headers, peer_ip(&headers)) {
        return r;
    }
    let Ok(req) = serde_json::from_str::<Value>(&body) else {
        return err(StatusCode::BAD_REQUEST, anthropic_error("invalid JSON body", "invalid_request_error"));
    };
    let Some(mut chat) = to_chat_body(&req) else {
        return err(
            StatusCode::BAD_REQUEST,
            anthropic_error("model and messages are required", "invalid_request_error"),
        );
    };
    // tools/tool_choice are now forwarded to upstream providers
    // §3.4: strip when toggle is off
    if !core.is_tools_enabled() {
        if let Some(obj) = chat.as_object_mut() {
            obj.remove("tools");
            obj.remove("tool_choice");
            obj.remove("response_format");
        }
    }
    let wants_stream = chat.get("stream").and_then(Value::as_bool).unwrap_or(false);
    let mut slot = match try_slot(&core) {
        Ok(s) => s,
        Err(r) => {
            // map the generic responses to anthropic shape
            let status = r.status().as_u16();
            return err(
                StatusCode::from_u16(status).unwrap_or(StatusCode::SERVICE_UNAVAILABLE),
                anthropic_error("gateway unavailable or at capacity", "overloaded_error"),
            );
        }
    };
    let id = slot.id;
    let msg_id = format!("msg_gw_{id}");
    let model = chat.get("model").and_then(Value::as_str).unwrap_or("").to_string();
    tracing::info!(request_id = id, kind = "anthropic", model = %model, body = %chat.to_string().chars().take(500).collect::<String>(), "dispatching anthropic messages request");
    let fwd = forwarded_headers(&headers);
    core.bridge.dispatch(BridgeRequest { request_id: id, kind: "chat", body: chat, headers: fwd.clone() });

    if wants_stream {
        let mid = msg_id.clone();
        let stream_body = async_stream::stream! {
            // Anthropic SSE: `event: <name>` + `data: <json>` — emit the full lifecycle.
            let start = json!({ "type": "message_start", "message": { "id": mid, "type": "message", "role": "assistant",
                "content": [], "model": model, "stop_reason": null, "usage": { "input_tokens": 0, "output_tokens": 0 } } });
            yield Ok::<Event, std::convert::Infallible>(Event::default().event("message_start").data(start.to_string()));
            yield Ok::<Event, std::convert::Infallible>(Event::default().event("content_block_start")
                .data(json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "text", "text": "" } }).to_string()));
            let mut usage: Option<(u64, u64)> = None;
            let mut has_tool_calls = false;
            while let Some(msg) = slot.rx.recv().await {
                match msg {
                    BridgeMsg::Delta(t) => {
                        tracing::info!(request_id = id, delta_len = t.len(), "anthropic stream delta received");
                        let d = json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": t } });
                        yield Ok::<Event, std::convert::Infallible>(Event::default().event("content_block_delta").data(d.to_string()));
                    }
                    BridgeMsg::Result(_) => {}
                    BridgeMsg::Done => break,
                    BridgeMsg::Error { message, .. } => {
                        let e = json!({ "type": "error", "error": { "type": "overloaded_error", "message": message } });
                        yield Ok::<Event, std::convert::Infallible>(Event::default().event("error").data(e.to_string()));
                        return;
                    }
                    BridgeMsg::ToolCalls(calls) => {
                        // Model returned structured tool calls — emit them as Anthropic tool_use
                        // blocks alongside the accumulated text, then signal stop_reason: tool_use
                        // so clients know a round-trip is required.
                        has_tool_calls = true;
                        if let Some(arr) = calls.as_array() {
                            for (idx, tc) in arr.iter().enumerate() {
                                let call_id = tc.get("id").and_then(Value::as_str).unwrap_or("");
                                let name = tc.get("function").and_then(|f| f.get("name")).and_then(Value::as_str).unwrap_or("");
                                let args_raw = tc.get("function").and_then(|f| f.get("arguments")).unwrap_or(&json!(null));
                                let args: String = if let Some(s) = args_raw.as_str() {
                                    s.to_string()
                                } else {
                                    args_raw.to_string()
                                };
                                let payload = json!({
                                    "type": "content_block_start",
                                    "index": 1 + idx,
                                    "content_block": { "type": "tool_use", "id": call_id, "name": name }
                                });
                                yield Ok::<Event, std::convert::Infallible>(
                                    Event::default().event("content_block_start").data(payload.to_string()),
                                );
                                // input_json_delta: emit the full argument string so the client
                                // receives the completed tool call in one event (Anthropic allows
                                // a single delta carrying the whole JSON).
                                let delta_ev = json!({
                                    "type": "content_block_delta",
                                    "index": 1 + idx,
                                    "delta": { "type": "input_json_delta", "partial_json": args.clone() }
                                });
                                yield Ok::<Event, std::convert::Infallible>(
                                    Event::default().event("content_block_delta").data(delta_ev.to_string()),
                                );
                                let stop_ev = json!({
                                    "type": "content_block_stop",
                                    "index": 1 + idx
                                });
                                yield Ok::<Event, std::convert::Infallible>(
                                    Event::default().event("content_block_stop").data(stop_ev.to_string()),
                                );
                            }
                        }
                        // Fall through to send message_delta + usage on the Done chunk.
                    }
                    BridgeMsg::Usage { prompt_tokens, completion_tokens } => {
                        usage = Some((prompt_tokens, completion_tokens));
                    }
                }
            }
            // Only emit stop events if we didn't break for tool execution.
            if !has_tool_calls {
                yield Ok::<Event, std::convert::Infallible>(Event::default().event("content_block_stop")
                    .data(json!({ "type": "content_block_stop", "index": 0 }).to_string()));
                let stop_reason = if has_tool_calls { "tool_use" } else { "end_turn" };
                yield Ok::<Event, std::convert::Infallible>(Event::default().event("message_delta")
                    .data(json!({ "type": "message_delta", "delta": { "stop_reason": stop_reason, "stop_sequence": null },
                        "usage": { "output_tokens": usage.as_ref().map(|(_, ct)| ct).unwrap_or(&0) } }).to_string()));
                yield Ok::<Event, std::convert::Infallible>(Event::default().event("message_stop").data(json!({ "type": "message_stop" }).to_string()));
            }
            drop(slot);
        };
        return Sse::new(stream_body)
            .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
            .into_response();
    }

    let mut full = String::new();
    let mut usage: Option<(u64, u64)> = None;
    let mut err_info: Option<(u16, String)> = None;
    let mut tool_content_blocks: Vec<Value> = Vec::new();
    let mut has_tool_calls = false;
    while let Some(msg) = slot.rx.recv().await {
        match msg {
            BridgeMsg::Delta(t) => {
                tracing::info!(request_id = id, delta_len = t.len(), "anthropic non-stream delta received");
                full.push_str(&t);
            }
            BridgeMsg::Result(_) => {}
            BridgeMsg::Done => {
                tracing::info!(request_id = id, full_len = full.len(), "anthropic non-stream done");
                break;
            }
            BridgeMsg::Error { status, message } => {
                err_info = Some((status, message));
                break;
            }
            BridgeMsg::ToolCalls(calls) => {
                // Buffer tool calls to include as tool_use blocks in the response.
                has_tool_calls = true;
                if let Some(arr) = calls.as_array() {
                    for tc in arr {
                        let call_id = tc.get("id").and_then(Value::as_str).unwrap_or("");
                        let name = tc.get("function").and_then(|f| f.get("name")).and_then(Value::as_str).unwrap_or("");
                        let args_raw = tc.get("function").and_then(|f| f.get("arguments")).unwrap_or(&Value::Null);
                        let args: String = if let Some(s) = args_raw.as_str() {
                            s.to_string()
                        } else {
                            args_raw.to_string()
                        };
                        tool_content_blocks.push(json!({
                            "type": "tool_use",
                            "id": call_id,
                            "name": name,
                            "input": serde_json::from_str(&args).unwrap_or(json!(args))
                        }));
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
    match err_info {
        Some((_, message)) => err(StatusCode::BAD_GATEWAY, anthropic_error(&message, "api_error")),
        None => {
            let prompt_tokens = usage.as_ref().map(|(pt, _)| pt).unwrap_or(&0);
            let completion_tokens = usage.as_ref().map(|(_, ct)| ct).unwrap_or(&0);
            // Build content: text block first, then any tool_use blocks.
            let mut content: Vec<Value> = vec![json!({ "type": "text", "text": full })];
            content.append(&mut tool_content_blocks);
            (
                StatusCode::OK,
                [(header::CONTENT_TYPE, "application/json")],
                json!({
                    "id": msg_id, "type": "message", "role": "assistant",
                    "content": content,
                    "model": model, "stop_reason": anthropic_stop_reason(if has_tool_calls { Some("tool_use") } else { None }), "stop_sequence": null,
                    "usage": { "input_tokens": prompt_tokens, "output_tokens": completion_tokens }
                })
                .to_string(),
            )
                .into_response()
        }
    }
}
