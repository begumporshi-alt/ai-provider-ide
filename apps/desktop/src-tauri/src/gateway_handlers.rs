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
    check_gateway_key, clean_assistant_text, err, err_ra, forwarded_headers, openai_error, peer_ip,
    try_slot, worker_status, BridgeMsg, BridgeRequest, GatewayCore,
};
use crate::gateway::context_scope::{
    apply_memory_headers, finish_capture, inject_context, prepare_capture,
};

pub(crate) async fn chat_h(State(core): State<Arc<GatewayCore>>, headers: HeaderMap, body: String) -> Response {
    if let Some(r) = check_gateway_key(&core, &headers, peer_ip(&headers)) {
        return r.openai();
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
    // Echoed on every response. Clients read `model` back to confirm what actually served them,
    // and some refuse a body without it. Failover here stays inside the requested id (same native
    // model, different carrier), so the requested id is what served.
    let model = req.get("model").and_then(Value::as_str).unwrap_or("").to_string();
    // §3.4: strip tool fields when the gateway toggle is off
    if !core.is_tools_enabled() {
        if let Some(obj) = req.as_object_mut() {
            obj.remove("tools");
            obj.remove("tool_choice");
            obj.remove("response_format");
        }
    }

    let mut slot = match try_slot(&core).await {
        Ok(s) => s,
        Err(r) => return r,
    };
    let id = slot.id;
    let fwd = forwarded_headers(&headers);
    // Memory/context layer: strips the gateway-invented `metadata.aip` before dispatch, and recalls
    // + injects a memory block when the toggle allows it. The outcome is reported on the response
    // as `AIP-Memory` / `AIP-Memory-Scope`.
    let outcome = inject_context(&core, &headers, None, &mut req);
    core.record_injection(id, &model, &outcome);
    // Capture inputs are computed before dispatch: the stream branch builds a `'static` body and so
    // cannot borrow the request.
    let prep = prepare_capture(&core, &headers, &req, id);
    core.bridge.dispatch(BridgeRequest { request_id: id, kind: "chat", body: req.clone(), headers: fwd.clone() });
    tracing::info!(request_id = id, kind = "chat", model = %req.get("model").unwrap_or(&json!("")).as_str().unwrap_or(""), "dispatching chat request");

    if wants_stream {
        // Slot (and its Drop -> bridge.cancel) lives inside the SSE stream: axum drops the
        // stream exactly when the client disconnects or the body finishes.
        let stream_body = async_stream::stream! {
            // Moved in: the stream must be 'static, so it cannot borrow the request or headers.
            let prep = prep;
            let mut usage: Option<(u64, u64)> = None;
            let mut started = false;
            let mut streamed = String::new();
            while let Some(msg) = slot.recv().await {
                match msg {
                    // An empty delta carries no content, so it is not a wire event at all.
                    // The bridge relies on this: in gateway mode it holds text back until the
                    // model settles, and probes liveness between turns with an empty chunk —
                    // which must reach the client as nothing.
                    BridgeMsg::Delta(t) if t.is_empty() => {}
                    BridgeMsg::Delta(t) => {
                        streamed.push_str(&t);
                        // The first content frame opens the message the way OpenAI does it, so
                        // clients that read delta.role instead of inferring it see an assistant.
                        let delta = if started {
                            json!({ "content": t })
                        } else {
                            started = true;
                            json!({ "role": "assistant", "content": t })
                        };
                        let payload = json!({ "id": format!("gw-{id}"), "object": "chat.completion.chunk", "model": model,
                            "choices": [{ "index": 0, "delta": delta }] });
                        yield Ok::<Event, std::convert::Infallible>(Event::default().data(payload.to_string()));
                    }
                    BridgeMsg::Result(_) => {}
                    BridgeMsg::Done => {
                        if let Some(p) = &prep {
                            let _ = finish_capture(p, &streamed);
                        }
                        let (pt, ct) = usage.unwrap_or((0, 0));
                        yield Ok::<Event, std::convert::Infallible>(Event::default().data(
                            json!({
                                "id": format!("gw-{id}"),
                                "object": "chat.completion.chunk",
                                "model": model,
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
                        // OpenAI terminates every stream with `data: [DONE]`. Clients that wait
                        // for that sentinel rather than for EOF otherwise hang until the socket
                        // closes, so both normal exits have to emit it.
                        yield Ok::<Event, std::convert::Infallible>(Event::default().data("[DONE]"));
                        break;
                    }
                    BridgeMsg::Error { status, message } => {
                        // SSE is already committed as 200, so the payload is the only channel left.
                        // The non-stream path puts the status on the wire; here it has to be in the
                        // body, or a client cannot tell a bad request from a broken gateway.
                        let code = worker_status(status);
                        let mut body = openai_error(&message, "upstream_error", None);
                        body["error"]["status"] = json!(code.as_u16());
                        yield Ok::<Event, std::convert::Infallible>(Event::default().data(body.to_string()));
                        break;
                    }
                    BridgeMsg::ToolCalls(calls) => {
                        // Pass-through: the client declared these tools and will run them
                        // itself, so hand them back shaped for the OpenAI wire and stop.
                        // The request ends here — the gateway does not also execute them.
                        let payload = json!({
                            "id": format!("gw-{}", id),
                            "object": "chat.completion.chunk",
                            "model": model,
                            "choices": [{
                                "index": 0,
                                "delta": { "tool_calls": calls },
                                "finish_reason": "tool_calls"
                            }]
                        });
                        yield Ok::<Event, std::convert::Infallible>(Event::default().data(payload.to_string()));
                        yield Ok::<Event, std::convert::Infallible>(Event::default().data("[DONE]"));
                        break;
                    }
                    BridgeMsg::Usage { prompt_tokens, completion_tokens } => {
                        usage = Some((prompt_tokens, completion_tokens));
                    }
                }
            }
            drop(slot);
        };
        let mut r = Sse::new(stream_body)
            .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
            .into_response();
        apply_memory_headers(&mut r, &outcome);
        return r;
    }

    let mut full = String::new();
    let mut tool_calls_json: Option<String> = None;
    let mut usage: Option<(u64, u64)> = None;
    let mut err_info: Option<(u16, String)> = None;
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
                // Pass-through: hand the client's tool calls back and finish the request.
                tool_calls_json = Some(calls.to_string());
                break;
            }
            BridgeMsg::Usage { prompt_tokens, completion_tokens } => {
                usage = Some((prompt_tokens, completion_tokens));
            }
        }
    }
    drop(slot);
    match err_info {
        Some((status, message)) => {
            let code = worker_status(status);
            // Not upstream: the worker never answered. Say so, and tell the client it is
            // worth retrying — a retry re-enters `try_slot`, which re-warms the window.
            if code == StatusCode::SERVICE_UNAVAILABLE {
                let mut r = err_ra(code, "1", openai_error(&message, "service_unavailable", None));
                apply_memory_headers(&mut r, &outcome);
                return r;
            }
            let mut r = err(code, openai_error(&message, "upstream_error", None));
            apply_memory_headers(&mut r, &outcome);
            r
        }
        None => {
            let mut choice = json!({ "index": 0, "message": { "role": "assistant", "content": clean_assistant_text(&full) }, "finish_reason": "stop" });
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
            let mut r = (
                StatusCode::OK,
                [(header::CONTENT_TYPE, "application/json")],
                json!({ "id": format!("gw-{id}"), "object": "chat.completion", "model": model,
                    "choices": [choice],
                    "usage": usage.as_ref().map(|(pt, ct)| json!({ "prompt_tokens": pt, "completion_tokens": ct })) })
                    .to_string(),
            )
                .into_response();
            apply_memory_headers(&mut r, &outcome);
            r
        }
    }
}

pub(crate) async fn models_h(State(core): State<Arc<GatewayCore>>, headers: HeaderMap) -> Response {
    if let Some(r) = check_gateway_key(&core, &headers, peer_ip(&headers)) {
        return r.openai();
    }
    let mut slot = match try_slot(&core).await {
        Ok(s) => s,
        Err(r) => return r,
    };
    let id = slot.id;
    core.bridge.dispatch(BridgeRequest { request_id: id, kind: "models", body: json!({}), headers: forwarded_headers(&headers) });
    tracing::info!(request_id = id, kind = "models", "dispatching models request");
    while let Some(msg) = slot.recv().await {
        match msg {
            BridgeMsg::Result(v) => {
                return (StatusCode::OK, [(header::CONTENT_TYPE, "application/json")], v.to_string()).into_response()
            }
            BridgeMsg::Error { status, message } => {
                return err(worker_status(status), openai_error(&message, "upstream_error", None))
            }
            BridgeMsg::Done => break,
            BridgeMsg::Delta(_) => {}
            BridgeMsg::ToolCalls(_) => {}
            BridgeMsg::Usage { .. } => {}
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
        return r.openai();
    }
    let Ok(req) = serde_json::from_str::<Value>(&body) else {
        return err(StatusCode::BAD_REQUEST, openai_error("invalid JSON body", "invalid_request", None));
    };
    if req.get("model").and_then(Value::as_str).unwrap_or("").is_empty()
        || req.get("prompt").and_then(Value::as_str).unwrap_or("").is_empty()
    {
        return err(StatusCode::BAD_REQUEST, openai_error("model and prompt are required", "invalid_request", None));
    }
    let mut slot = match try_slot(&core).await {
        Ok(s) => s,
        Err(r) => return r,
    };
    let id = slot.id;
    core.bridge.dispatch(BridgeRequest { request_id: id, kind: "image", body: req, headers: forwarded_headers(&headers) });
    tracing::info!(request_id = id, kind = "image", "dispatching image request");
    while let Some(msg) = slot.recv().await {
        match msg {
            BridgeMsg::Result(v) => {
                return (StatusCode::OK, [(header::CONTENT_TYPE, "application/json")], v.to_string()).into_response()
            }
            BridgeMsg::Error { status, message } => {
                return err(worker_status(status), openai_error(&message, "upstream_error", None));
            }
            BridgeMsg::Done => break,
            BridgeMsg::Delta(_) => {}
            BridgeMsg::ToolCalls(_) => {}
            BridgeMsg::Usage { .. } => {}
        }
    }
    err(StatusCode::BAD_GATEWAY, openai_error("empty image response from core", "upstream_error", None))
}

