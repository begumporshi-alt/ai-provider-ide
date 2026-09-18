//! OpenAI Chat / models / images ingress, plus the catch-all route.
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
    check_gateway_key, err, forwarded_headers, openai_error, peer_ip, try_slot, BridgeMsg,
    BridgeRequest, GatewayCore,
};

pub(crate) async fn chat_h(State(core): State<Arc<GatewayCore>>, headers: HeaderMap, body: String) -> Response {
    if let Some(r) = check_gateway_key(&core, &headers, peer_ip(&headers)) {
        return r;
    }
    let Ok(mut req) = serde_json::from_str::<Value>(&body) else {
        return err(StatusCode::BAD_REQUEST, openai_error("invalid JSON body", "invalid_request", None));
    };
    // §3.4 compatibility contract: only reject truly incompatible parameters.
    // Tools/tool_choice/response_format are now forwarded to upstream providers.
    for unsupported in ["functions"] {
        if req.get(unsupported).is_some_and(|v| !v.is_null()) {
            return err(
                StatusCode::BAD_REQUEST,
                openai_error(&format!("{unsupported} is not supported yet"), "invalid_request", Some("unsupported_parameter")),
            );
        }
    }
    if req.get("model").and_then(Value::as_str).unwrap_or("").is_empty() {
        return err(StatusCode::BAD_REQUEST, openai_error("model is required", "invalid_request", None));
    }
    let wants_stream = req.get("stream").and_then(Value::as_bool).unwrap_or(false);
    // §3.4: strip tool fields when the gateway toggle is off
    if !core.is_tools_enabled() {
        if let Some(obj) = req.as_object_mut() {
            obj.remove("tools");
            obj.remove("tool_choice");
            obj.remove("response_format");
        }
    }

    let mut slot = match try_slot(&core) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let id = slot.id;
    let fwd = forwarded_headers(&headers);
    core.bridge.dispatch(BridgeRequest { request_id: id, kind: "chat", body: req.clone(), headers: fwd.clone() });
    tracing::info!(request_id = id, kind = "chat", model = %req.get("model").unwrap_or(&json!("")).as_str().unwrap_or(""), "dispatching chat request");

    if wants_stream {
        // Slot (and its Drop -> bridge.cancel) lives inside the SSE stream: axum drops the
        // stream exactly when the client disconnects or the body finishes.
        let stream_body = async_stream::stream! {
            let mut usage: Option<(u64, u64)> = None;
            let mut tool_pending = false;
            while let Some(msg) = slot.rx.recv().await {
                match msg {
                    BridgeMsg::Delta(t) => {
                        let payload = json!({ "id": format!("gw-{id}"), "object": "chat.completion.chunk",
                            "choices": [{ "index": 0, "delta": { "content": t } }] });
                        yield Ok::<Event, std::convert::Infallible>(Event::default().data(payload.to_string()));
                    }
                    BridgeMsg::Result(_) => {}
                    BridgeMsg::Done => {
                        if tool_pending {
                            // Bridge executed tools and re-dispatched; break to let the
                            // FollowUp handler take over with the next turn.
                            break;
                        }
                        let (pt, ct) = usage.unwrap_or((0, 0));
                        yield Ok::<Event, std::convert::Infallible>(Event::default().data(
                            json!({
                                "id": format!("gw-{id}"),
                                "object": "chat.completion.chunk",
                                "choices": [{
                                    "index": 0,
                                    "delta": {},
                                    "finish_reason": "stop",
                                    "usage": {
                                        "prompt_tokens": pt,
                                        "completion_tokens": ct,
                                        "total_tokens": pt + ct
                                    }
                                }]
                            }).to_string(),
                        ));
                        break;
                    }
                    BridgeMsg::Error { message, .. } => {
                        yield Ok::<Event, std::convert::Infallible>(Event::default().data(
                            json!({ "error": { "message": message, "type": "upstream_error", "code": null } }).to_string(),
                        ));
                        break;
                    }
                    BridgeMsg::ToolCalls(calls) => {
                        // Emit tool calls as OpenAI-shaped SSE chunk so clients receive
                        // structured tool_calls instead of mercury-2.5 pseudo-markup.
                        let payload = json!({
                            "id": format!("gw-{}", id),
                            "object": "chat.completion.chunk",
                            "choices": [{
                                "index": 0,
                                "delta": { "tool_calls": calls },
                                "finish_reason": "tool_calls"
                            }]
                        });
                        yield Ok::<Event, std::convert::Infallible>(Event::default().data(payload.to_string()));
                        tool_pending = true;
                        break;
                    }
                    BridgeMsg::Usage { prompt_tokens, completion_tokens } => {
                        usage = Some((prompt_tokens, completion_tokens));
                    }
                    BridgeMsg::FollowUp { messages } => {
                        // Bridge executed tools and re-dispatched with updated messages.
                        let mut new_chat = req.clone();
                        new_chat["messages"] = json!(messages);
                        core.bridge.dispatch(BridgeRequest { request_id: id, kind: "chat", body: new_chat, headers: fwd.clone() });
                    }
                    BridgeMsg::ToolResult { .. } => {}
                }
            }
            drop(slot);
        };
        return Sse::new(stream_body)
            .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
            .into_response();
    }

    let mut full = String::new();
    let mut tool_calls_json: Option<String> = None;
    let mut tool_pending = false;
    let mut usage: Option<(u64, u64)> = None;
    let mut err_info: Option<(u16, String)> = None;
    while let Some(msg) = slot.rx.recv().await {
        match msg {
            BridgeMsg::Delta(t) => full.push_str(&t),
            BridgeMsg::Result(_) => {}
            BridgeMsg::Done => {
                if tool_pending { break; }
                break;
            }
            BridgeMsg::Error { status, message } => {
                err_info = Some((status, message));
                break;
            }
            BridgeMsg::ToolCalls(calls) => {
                // Buffer tool calls for non-streaming response.
                tool_calls_json = Some(calls.to_string());
                tool_pending = true;
                break;
            }
            BridgeMsg::Usage { prompt_tokens, completion_tokens } => {
                usage = Some((prompt_tokens, completion_tokens));
            }
            BridgeMsg::FollowUp { messages } => {
                let mut new_chat = req.clone();
                new_chat["messages"] = json!(messages);
                core.bridge.dispatch(BridgeRequest { request_id: id, kind: "chat", body: new_chat, headers: fwd.clone() });
            }
            BridgeMsg::ToolResult { .. } => {}
        }
    }
    drop(slot);
    match err_info {
        Some((status, message)) => {
            let code = match status {
                404 => StatusCode::NOT_FOUND,
                429 => StatusCode::TOO_MANY_REQUESTS,
                401 => StatusCode::UNAUTHORIZED,
                _ => StatusCode::BAD_GATEWAY,
            };
            err(code, openai_error(&message, "upstream_error", None))
        }
        None => {
            let mut choice = json!({ "index": 0, "message": { "role": "assistant", "content": full }, "finish_reason": "stop" });
            if let Some(tc) = tool_calls_json {
                let parsed: Value = serde_json::from_str(&tc).unwrap_or_default();
                if !parsed.is_null() {
                    choice["message"]["tool_calls"] = parsed;
                    choice["finish_reason"] = "tool_calls".into();
                }
            }
            if let Some((pt, ct)) = usage {
                choice["usage"] = json!({ "prompt_tokens": pt, "completion_tokens": ct });
            }
            (
                StatusCode::OK,
                [(header::CONTENT_TYPE, "application/json")],
                json!({ "id": format!("gw-{id}"), "object": "chat.completion",
                    "choices": [choice],
                    "usage": usage.as_ref().map(|(pt, ct)| json!({ "prompt_tokens": pt, "completion_tokens": ct })) })
                    .to_string(),
            )
                .into_response()
        }
    }
}

/// Build updated messages from the original chat body + tool call results, then re-dispatch
/// through the bridge so the handler loop can continue collecting more turns.
///
/// Tool result messages are appended as role="tool" entries; the assistant turn that
/// requested the calls is kept as-is so upstream providers see a complete conversation.
fn re_dispatch_with_tool_results(
    core: &Arc<GatewayCore>,
    request_id: u64,
    original_chat: &serde_json::Value,
    tool_calls: &serde_json::Value,
) {
    let mut msgs: Vec<Value> = original_chat.get("messages").cloned().unwrap_or(json!([])).as_array().cloned().unwrap_or_default();
    if let Some(arr) = tool_calls.as_array() {
        for tc in arr {
            let call_id = tc.get("id").and_then(Value::as_str).unwrap_or("");
            let name = tc.get("function").and_then(|f| f.get("name")).and_then(Value::as_str).unwrap_or("");
            let args_raw = tc.get("function").and_then(|f| f.get("arguments")).unwrap_or(&json!(null));
            let _args: String = if let Some(s) = args_raw.as_str() { s.to_string() } else { args_raw.to_string() };
            // Append a tool result message: the bridge will set content via gateway_re_dispatch.
            msgs.push(json!({
                "role": "tool",
                "tool_call_id": call_id,
                "content": format!("[gateway: tool '{}' called, awaiting result]", name),
            }));
        }
    }
    core.re_dispatch(request_id, msgs);
}

pub(crate) async fn models_h(State(core): State<Arc<GatewayCore>>, headers: HeaderMap) -> Response {
    if let Some(r) = check_gateway_key(&core, &headers, peer_ip(&headers)) {
        return r;
    }
    let mut slot = match try_slot(&core) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let id = slot.id;
    core.bridge.dispatch(BridgeRequest { request_id: id, kind: "models", body: json!({}), headers: forwarded_headers(&headers) });
    tracing::info!(request_id = id, kind = "models", "dispatching models request");
    while let Some(msg) = slot.rx.recv().await {
        match msg {
            BridgeMsg::Result(v) => {
                return (StatusCode::OK, [(header::CONTENT_TYPE, "application/json")], v.to_string()).into_response()
            }
            BridgeMsg::Error { message, .. } => {
                return err(StatusCode::BAD_GATEWAY, openai_error(&message, "upstream_error", None))
            }
            BridgeMsg::Done => break,
            BridgeMsg::Delta(_) => {}
            BridgeMsg::ToolCalls(_) => {}
            BridgeMsg::Usage { .. } => {}
            BridgeMsg::ToolResult { .. } => {}
            BridgeMsg::FollowUp { .. } => {}
        }
    }
    err(StatusCode::BAD_GATEWAY, openai_error("empty models response from core", "upstream_error", None))
}

/// Catch-all for unknown `/v1/*` and `/v1beta/*` routes — returns a JSON 404 OpenAI-style error
/// instead of falling through to the Tauri webview HTML 404 page.
pub(crate) async fn unknown_route() -> Response {
    tracing::warn!("unknown gateway route hit");
    err(StatusCode::NOT_FOUND, openai_error("route not found", "not_found", Some("unknown_route")))
}


pub(crate) async fn image_h(State(core): State<Arc<GatewayCore>>, headers: HeaderMap, body: String) -> Response {
    if let Some(r) = check_gateway_key(&core, &headers, peer_ip(&headers)) {
        return r;
    }
    let Ok(req) = serde_json::from_str::<Value>(&body) else {
        return err(StatusCode::BAD_REQUEST, openai_error("invalid JSON body", "invalid_request", None));
    };
    if req.get("model").and_then(Value::as_str).unwrap_or("").is_empty()
        || req.get("prompt").and_then(Value::as_str).unwrap_or("").is_empty()
    {
        return err(StatusCode::BAD_REQUEST, openai_error("model and prompt are required", "invalid_request", None));
    }
    let mut slot = match try_slot(&core) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let id = slot.id;
    core.bridge.dispatch(BridgeRequest { request_id: id, kind: "image", body: req, headers: forwarded_headers(&headers) });
    tracing::info!(request_id = id, kind = "image", "dispatching image request");
    while let Some(msg) = slot.rx.recv().await {
        match msg {
            BridgeMsg::Result(v) => {
                return (StatusCode::OK, [(header::CONTENT_TYPE, "application/json")], v.to_string()).into_response()
            }
            BridgeMsg::Error { status, message } => {
                let code = if status == 404 { StatusCode::NOT_FOUND } else { StatusCode::BAD_GATEWAY };
                return err(code, openai_error(&message, "upstream_error", None));
            }
            BridgeMsg::Done => break,
            BridgeMsg::Delta(_) => {}
            BridgeMsg::ToolCalls(_) => {}
            BridgeMsg::Usage { .. } => {}
            BridgeMsg::ToolResult { .. } => {}
            BridgeMsg::FollowUp { .. } => {}
        }
    }    err(StatusCode::BAD_GATEWAY, openai_error("empty image response from core", "upstream_error", None))
}

