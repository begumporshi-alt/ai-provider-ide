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

use crate::core::gateway::context_scope::{
    apply_memory_headers, finish_capture, inject_context, prepare_capture,
};
use crate::core::gateway::{
    check_gateway_key, clean_assistant_text, cooldown_secs, err, err_ra, err_with_cooldown,
    forwarded_headers, openai_error, peer_ip, try_slot, worker_status, BridgeMsg, BridgeRequest,
    GatewayCore,
};
use crate::core::persist;

pub(crate) async fn chat_h(
    State(core): State<Arc<GatewayCore>>,
    headers: HeaderMap,
    body: String,
) -> Response {
    let app_key = match check_gateway_key(&core, &headers, peer_ip(&headers)).await {
        Ok(k) => k,
        Err(r) => return r.openai(),
    };
    let Ok(mut req) = serde_json::from_str::<Value>(&body) else {
        return err(
            StatusCode::BAD_REQUEST,
            openai_error("invalid JSON body", "invalid_request", None),
        );
    };
    // §3.4 compatibility contract: only reject truly incompatible parameters.
    // Tools/tool_choice/response_format are now forwarded to upstream providers. `functions` —
    // the pre-tools OpenAI spelling — is the one parameter still refused, and the refusal names
    // it. (It was a one-element `for` loop: this is the only member the list has left.)
    if req.get("functions").is_some_and(|v| !v.is_null()) {
        return err(
            StatusCode::BAD_REQUEST,
            openai_error(
                "functions is not supported yet",
                "invalid_request",
                Some("unsupported_parameter"),
            ),
        );
    }
    if req.get("model").and_then(Value::as_str).unwrap_or("").is_empty() {
        return err(
            StatusCode::BAD_REQUEST,
            openai_error("model is required", "invalid_request", None),
        );
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

    // §A3 idempotency, on `Idempotency-Key`. Scoped to the caller — the app-key id, or `master`
    // for the master key — so two clients cannot collide on one key. The fingerprint is the raw
    // body: it is the request's identity, and byte comparison cannot silently equate two
    // different requests. Streaming is refused a key rather than silently deduplicated — a
    // replay must return the first byte stream, and reserving that is a different feature.
    let idem_key = headers
        .get("idempotency-key")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
        .filter(|k| !k.trim().is_empty());
    if wants_stream && idem_key.is_some() {
        return err(
            StatusCode::BAD_REQUEST,
            openai_error(
                "idempotency keys apply to non-streaming requests only",
                "invalid_request",
                None,
            ),
        );
    }
    let idem_scope = app_key.clone().unwrap_or_else(|| "master".to_string());
    let idem_begin = match (&idem_key, core.store()) {
        (Some(k), Some(store)) => {
            match persist::idempotency_begin(store, k, &idem_scope, &body) {
                Ok(b) => Some(b),
                // A store that cannot host the replay cache degrades to no dedup — never to a
                // failed request.
                Err(e) => {
                    tracing::warn!("idempotency lookup failed (continuing without): {e}");
                    None
                }
            }
        }
        _ => None,
    };
    match idem_begin {
        Some(persist::IdempotencyBegin::Replay { status, body: cached }) => {
            let mut r = (
                StatusCode::from_u16(status).unwrap_or(StatusCode::OK),
                [(header::CONTENT_TYPE, "application/json")],
                cached,
            )
                .into_response();
            r.headers_mut().insert(
                header::HeaderName::from_static("idempotency-replayed"),
                header::HeaderValue::from_static("true"),
            );
            return r;
        }
        Some(persist::IdempotencyBegin::Conflict { in_progress }) => {
            let msg = if in_progress {
                "a request with this idempotency key is already in progress"
            } else {
                "this idempotency key was already used with a different request body"
            };
            return err(StatusCode::CONFLICT, openai_error(msg, "conflict", None));
        }
        Some(persist::IdempotencyBegin::Reserved) | None => {}
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
    core.dispatch(BridgeRequest {
        request_id: id,
        kind: "chat",
        body: req.clone(),
        headers: fwd.clone(),
        app_key_id: app_key,
    });
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
            // A pass-through turn: tool calls went back to the client and the turn ends on them.
            // The chunk itself is not terminal — the bridge follows it with the turn's usage and
            // `Done`, and the terminal chunk below owes the client both (audit 2026-10-03 M2).
            let mut tool_turn = false;
            // Serving attribution (A1 Phase 2): arrives just before `Done`, rides the terminal
            // chunk as `served_by`.
            let mut served_by: Option<Value> = None;
            // The provider's own finish reason, already in the OpenAI vocabulary. Absent for a
            // dialect that declares no `responseFinish`, where `stop` stays the honest default.
            let mut finish_reason: Option<String> = None;
            while let Some(msg) = slot.recv().await {
                match msg {
                    // An empty delta carries no content, so it is not a wire event at all.
                    // The bridge relies on this: in gateway mode it holds text back until the
                    // model settles, and probes liveness between turns with an empty chunk —
                    // which must reach the client as nothing.
                    BridgeMsg::Delta(t) if t.is_empty() => {}
                    // The bridge's held-prose liveness frame (audit 2026-10-03 R2): it exists to
                    // disarm FIRST_MSG_TIMEOUT, never to reach the wire.
                    BridgeMsg::Liveness => {}
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
                    BridgeMsg::Reasoning(t) if t.is_empty() => {}
                    BridgeMsg::Reasoning(t) => {
                        // The OpenAI-compatible convention (DeepSeek-origin; OpenRouter and
                        // LiteLLM normalise to it): reasoning rides `delta.reasoning_content`,
                        // never `delta.content`. The role opens the *message* once, on whichever
                        // frame arrives first — reasoning usually precedes the answer — so the
                        // `started` flag is shared with the content arm.
                        let delta = if started {
                            json!({ "reasoning_content": t })
                        } else {
                            started = true;
                            json!({ "role": "assistant", "reasoning_content": t })
                        };
                        let payload = json!({ "id": format!("gw-{id}"), "object": "chat.completion.chunk", "model": model,
                            "choices": [{ "index": 0, "delta": delta }] });
                        yield Ok::<Event, std::convert::Infallible>(Event::default().data(payload.to_string()));
                    }
                    BridgeMsg::Result(_) => {}
                    BridgeMsg::Finish(reason) => finish_reason = Some(reason),
                    BridgeMsg::Done => {
                        if let Some(p) = &prep {
                            let _ = finish_capture(p, &streamed);
                        }
                        let (pt, ct) = usage.unwrap_or((0, 0));
                        let mut terminal = json!({
                            "id": format!("gw-{id}"),
                            "object": "chat.completion.chunk",
                            "model": model,
                            "choices": [{
                                "index": 0,
                                "delta": {},
                                // The provider's reason when it declared one — a truncation at
                                // `max_tokens` must not read as `stop` (drift D86).
                                "finish_reason": finish_reason
                                    .take()
                                    .unwrap_or_else(|| if tool_turn { "tool_calls" } else { "stop" }.to_string()),
                                "usage": {
                                    "prompt_tokens": pt,
                                    "completion_tokens": ct,
                                    "total_tokens": pt + ct
                                }
                            }]
                        });
                        // Serving attribution (A1 Phase 2): present when the turn was served at
                        // all; omitted when it was not, so clients can tell the difference.
                        if let Some(sb) = served_by.take() {
                            terminal["choices"][0]["served_by"] = sb;
                        }
                        yield Ok::<Event, std::convert::Infallible>(Event::default().data(
                            terminal.to_string(),
                        ));
                        // OpenAI terminates every stream with `data: [DONE]`. Clients that wait
                        // for that sentinel rather than for EOF otherwise hang until the socket
                        // closes, so both normal exits have to emit it.
                        yield Ok::<Event, std::convert::Infallible>(Event::default().data("[DONE]"));
                        break;
                    }
                    BridgeMsg::Error { status, message, .. } => {
                        // SSE is already committed as 200, so the payload is the only channel left.
                        // The non-stream path puts the status on the wire; here it has to be in the
                        // body, or a client cannot tell a bad request from a broken gateway.
                        // Retry-After cannot be set on a committed SSE response.
                        let code = worker_status(status);
                        let mut body = openai_error(&message, "upstream_error", None);
                        body["error"]["status"] = json!(code.as_u16());
                        yield Ok::<Event, std::convert::Infallible>(Event::default().data(body.to_string()));
                        break;
                    }
                    BridgeMsg::ToolCalls(calls) => {
                        // Pass-through: the client declared these tools and will run them
                        // itself, so hand them back shaped for the OpenAI wire. The frame
                        // carries no `finish_reason`: the turn ends on the bridge's `Done`
                        // arm below, which emits the one terminal chunk — with the provider's
                        // usage and the capture it owes. Ending here instead dropped both:
                        // usage the provider had already reported never reached the client,
                        // and the capture the every-other-exit runs was skipped (audit
                        // 2026-10-03 M2).
                        tool_turn = true;
                        let payload = json!({
                            "id": format!("gw-{}", id),
                            "object": "chat.completion.chunk",
                            "model": model,
                            "choices": [{
                                "index": 0,
                                "delta": { "tool_calls": calls },
                            }]
                        });
                        yield Ok::<Event, std::convert::Infallible>(Event::default().data(payload.to_string()));
                    }
                    BridgeMsg::Usage { prompt_tokens, completion_tokens } => {
                        usage = Some((prompt_tokens, completion_tokens));
                    }
                    BridgeMsg::Served { provider, model, key, fallbacks } => {
                        served_by = Some(json!({ "provider": provider, "model": model, "key": key, "fallbacks": fallbacks }));
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
    // The model's reasoning, upstream-gated. `full` is the answer and feeds the memory capture;
    // the notes ride beside it as `message.reasoning_content`, per the DeepSeek-origin convention
    // the OpenAI-compatible ecosystem normalised to.
    let mut reasoning = String::new();
    let mut tool_calls_json: Option<String> = None;
    let mut usage: Option<(u64, u64)> = None;
    let mut err_info: Option<(u16, String, Option<u64>)> = None;
    let mut finish_reason: Option<String> = None;
    // Serving attribution (A1 Phase 2), top-level on the body when the turn was served.
    let mut served_by: Option<Value> = None;
    while let Some(msg) = slot.recv().await {
        match msg {
            BridgeMsg::Delta(t) => full.push_str(&t),
            // Carries nothing by design; see the streaming arm (audit 2026-10-03 R2).
            BridgeMsg::Liveness => {}
            BridgeMsg::Reasoning(t) => reasoning.push_str(&t),
            BridgeMsg::Result(_) => {}
            BridgeMsg::Finish(reason) => finish_reason = Some(reason),
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
                // Pass-through: hand the client's tool calls back and finish the request.
                tool_calls_json = Some(calls.to_string());
                break;
            }
            BridgeMsg::Usage { prompt_tokens, completion_tokens } => {
                usage = Some((prompt_tokens, completion_tokens));
            }
            BridgeMsg::Served { provider, model, key, fallbacks } => {
                served_by = Some(
                    json!({ "provider": provider, "model": model, "key": key, "fallbacks": fallbacks }),
                );
            }
        }
    }
    drop(slot);
    match err_info {
        Some((status, message, retry_after_ms)) => {
            let code = worker_status(status);
            // Not upstream: the worker never answered. Say so, and tell the client it is
            // worth retrying — a retry re-enters `try_slot`, which re-warms the window.
            // A 503 is not a 429, so `ensure_retry_after` would not add a header here: set it
            // explicitly, using the provider's cooldown when the worker reported one.
            if code == StatusCode::SERVICE_UNAVAILABLE {
                let mut r = err_ra(
                    code,
                    cooldown_secs(retry_after_ms).unwrap_or_else(|| "1".to_string()),
                    openai_error(&message, "service_unavailable", None),
                );
                apply_memory_headers(&mut r, &outcome);
                return r;
            }
            let mut r = err_with_cooldown(
                code,
                retry_after_ms,
                openai_error(&message, "upstream_error", None),
            );
            apply_memory_headers(&mut r, &outcome);
            r
        }
        None => {
            // The provider's own reason when it declared one, `stop` otherwise. A truncation at
            // `max_tokens` must not read as a finished answer (drift D86).
            let reason = finish_reason.take().unwrap_or_else(|| "stop".to_string());
            let mut choice = json!({ "index": 0, "message": { "role": "assistant", "content": clean_assistant_text(&full) }, "finish_reason": reason });
            if !reasoning.is_empty() {
                // The sibling of the streaming field, mirroring DeepSeek's non-stream shape.
                // Passed through as the upstream sent it — never summarised, never merged into
                // `content`.
                choice["message"]["reasoning_content"] = Value::String(reasoning);
            }
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
            let mut payload = json!({ "id": format!("gw-{id}"), "object": "chat.completion", "model": model,
                    "choices": [choice],
                    "usage": usage.as_ref().map(|(pt, ct)| json!({ "prompt_tokens": pt, "completion_tokens": ct, "total_tokens": pt + ct })) });
            // Serving attribution (A1 Phase 2), top-level and omitted when the turn was never
            // served — the same omit-means-never-served rule the terminal chunk follows.
            if let Some(sb) = served_by.take() {
                payload["served_by"] = sb;
            }
            let payload = payload.to_string();
            // §A3: the completed response becomes the replay for this key's next identical
            // request. Best-effort — a store failure costs the *next* retry its replay, never
            // this response.
            if let (Some(k), Some(store)) = (&idem_key, core.store()) {
                if let Err(e) = persist::idempotency_complete(store, k, &idem_scope, 200, &payload)
                {
                    tracing::warn!("idempotency store failed (non-fatal): {e}");
                }
            }
            let mut r = (StatusCode::OK, [(header::CONTENT_TYPE, "application/json")], payload)
                .into_response();
            apply_memory_headers(&mut r, &outcome);
            r
        }
    }
}

pub(crate) async fn models_h(State(core): State<Arc<GatewayCore>>, headers: HeaderMap) -> Response {
    let app_key = match check_gateway_key(&core, &headers, peer_ip(&headers)).await {
        Ok(k) => k,
        Err(r) => return r.openai(),
    };
    let mut slot = match try_slot(&core).await {
        Ok(s) => s,
        Err(r) => return r,
    };
    let id = slot.id;
    core.dispatch(BridgeRequest {
        request_id: id,
        kind: "models",
        body: json!({}),
        headers: forwarded_headers(&headers),
        app_key_id: app_key,
    });
    tracing::info!(request_id = id, kind = "models", "dispatching models request");
    while let Some(msg) = slot.recv().await {
        match msg {
            BridgeMsg::Result(v) => {
                return (
                    StatusCode::OK,
                    [(header::CONTENT_TYPE, "application/json")],
                    v.to_string(),
                )
                    .into_response()
            }
            // Serving attribution is a text-turn frame; models and images do not emit it.
            BridgeMsg::Served { .. } => {}
            BridgeMsg::Error { status, message, retry_after_ms } => {
                return err_with_cooldown(
                    worker_status(status),
                    retry_after_ms,
                    openai_error(&message, "upstream_error", None),
                )
            }
            BridgeMsg::Done => break,
            BridgeMsg::Delta(_) => {}
            // The bridge's held-prose liveness frame — carries nothing for a model list or an
            // image reply (audit 2026-10-03 R2).
            BridgeMsg::Liveness => {}
            BridgeMsg::ToolCalls(_) => {}
            // No reasoning to carry in a model list or an image reply — enumerated so the match
            // stays exhaustive.
            BridgeMsg::Reasoning(_) => {}
            BridgeMsg::Usage { .. } => {}
            // Model listing and image generation carry no chat finish reason.
            BridgeMsg::Finish(_) => {}
        }
    }
    err(
        StatusCode::BAD_GATEWAY,
        openai_error("empty models response from core", "upstream_error", None),
    )
}

/// Catch-all for unknown `/v1/*` and `/v1beta/*` routes — returns a JSON 404 OpenAI-style error
/// instead of falling through to the Tauri webview HTML 404 page.
pub(crate) async fn unknown_route(
    State(core): State<Arc<GatewayCore>>,
    headers: HeaderMap,
) -> Response {
    // Invariant 10: authenticate before any routing work. Answering 404 to a caller that never
    // presented a credential makes the route table an oracle — 404-vs-401 separated a real route
    // from a typo with no key at all, which is exactly what the invariant exists to prevent.
    //
    // Identity discarded on purpose: nothing is dispatched from here, so nothing is billed.
    if let Err(r) = check_gateway_key(&core, &headers, peer_ip(&headers)).await {
        return r.openai();
    }
    tracing::warn!("unknown gateway route hit");
    err(StatusCode::NOT_FOUND, openai_error("route not found", "not_found", Some("unknown_route")))
}

/// Wrong method on a known route.
///
/// axum's default is a bare 405 with an empty body, which is the one refusal here a client parsing
/// JSON cannot read. It authenticates first for the same reason `unknown_route` does: a 405 is
/// itself a statement that the route exists.
pub(crate) async fn method_not_allowed(
    State(core): State<Arc<GatewayCore>>,
    headers: HeaderMap,
) -> Response {
    // Identity discarded on purpose: a 405 dispatches nothing.
    if let Err(r) = check_gateway_key(&core, &headers, peer_ip(&headers)).await {
        return r.openai();
    }
    err(
        StatusCode::METHOD_NOT_ALLOWED,
        openai_error("method not allowed", "invalid_request", Some("unsupported_method")),
    )
}

pub(crate) async fn image_h(
    State(core): State<Arc<GatewayCore>>,
    headers: HeaderMap,
    body: String,
) -> Response {
    let app_key = match check_gateway_key(&core, &headers, peer_ip(&headers)).await {
        Ok(k) => k,
        Err(r) => return r.openai(),
    };
    let Ok(req) = serde_json::from_str::<Value>(&body) else {
        return err(
            StatusCode::BAD_REQUEST,
            openai_error("invalid JSON body", "invalid_request", None),
        );
    };
    if req.get("model").and_then(Value::as_str).unwrap_or("").is_empty()
        || req.get("prompt").and_then(Value::as_str).unwrap_or("").is_empty()
    {
        return err(
            StatusCode::BAD_REQUEST,
            openai_error("model and prompt are required", "invalid_request", None),
        );
    }
    let mut slot = match try_slot(&core).await {
        Ok(s) => s,
        Err(r) => return r,
    };
    let id = slot.id;
    core.dispatch(BridgeRequest {
        request_id: id,
        kind: "image",
        body: req,
        headers: forwarded_headers(&headers),
        app_key_id: app_key,
    });
    tracing::info!(request_id = id, kind = "image", "dispatching image request");
    while let Some(msg) = slot.recv().await {
        match msg {
            // Serving attribution is a text-turn frame; images do not emit it.
            BridgeMsg::Served { .. } => {}
            BridgeMsg::Result(v) => {
                return (
                    StatusCode::OK,
                    [(header::CONTENT_TYPE, "application/json")],
                    v.to_string(),
                )
                    .into_response()
            }
            BridgeMsg::Error { status, message, retry_after_ms } => {
                return err_with_cooldown(
                    worker_status(status),
                    retry_after_ms,
                    openai_error(&message, "upstream_error", None),
                );
            }
            BridgeMsg::Done => break,
            BridgeMsg::Delta(_) => {}
            // The bridge's held-prose liveness frame — carries nothing for a model list or an
            // image reply (audit 2026-10-03 R2).
            BridgeMsg::Liveness => {}
            BridgeMsg::ToolCalls(_) => {}
            // No reasoning to carry in a model list or an image reply — enumerated so the match
            // stays exhaustive.
            BridgeMsg::Reasoning(_) => {}
            BridgeMsg::Usage { .. } => {}
            // Model listing and image generation carry no chat finish reason.
            BridgeMsg::Finish(_) => {}
        }
    }
    err(
        StatusCode::BAD_GATEWAY,
        openai_error("empty image response from core", "upstream_error", None),
    )
}
