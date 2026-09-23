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

use crate::core::gateway::context_scope::{
    apply_memory_headers, finish_capture, inject_context, prepare_capture,
};
use crate::core::gateway::{
    anthropic_error, anthropic_error_kind, check_gateway_key, clean_assistant_text, err,
    err_with_cooldown, forwarded_headers, peer_ip, try_slot, worker_status, BridgeMsg,
    BridgeRequest, GatewayCore,
};

/// Anthropic Messages ingress (2026-09-16 amendment, DECISIONS.md): Claude Code and
/// anthropic-sdk clients can point at this IDE. The request is translated to the router's
/// normalized chat call; the reply is re-framed as Anthropic events. The router core stays
/// provider-agnostic — this is ingress-dialect translation at the edge, symmetric to the
/// egress dialects providers speak.
/// The payload of a `tool_result` block. Anthropic allows it to be a bare string or a further
/// array of content blocks, and a client that returns nothing sends no `content` at all.
fn tool_result_text(block: &Value) -> String {
    match block.get("content") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|p| p.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(""),
        Some(v) if !v.is_null() => v.to_string(),
        _ => String::new(),
    }
}

/// Flat per-image token constant for the count_tokens estimate.
///
/// Anthropic bills images by pixel-bucketed bands; a flat constant is a pre-flight
/// approximation, not a billing figure. 1024 is conservative for a typical 1024×1024 image.
/// Tune here if the estimate needs to track provider bills more closely.
const IMAGE_TOKENS: u64 = 1024;

/// Sum the character count of everything a count_tokens request would actually send the model.
///
/// Walks the raw Anthropic body (not the OpenAI-normalized form, which is what `to_chat_body`
/// produces) so the estimate is independent of translation success. Mirrors the same content
/// `to_chat_body` forwards:
/// - `system`: string or array of `{"text": …}` blocks (Claude Code sends the array form)
/// - `messages[].content`: string, or array of blocks:
///   - `text`        → `.text`
///   - `tool_use`   → serialized `.input` + `.name` (the call payload is real tokens)
///   - `tool_result`→ its `content` (string, or array of text blocks)
///   - `image`      → flat `IMAGE_TOKENS` constant
///   - `thinking`   → dropped (no Anthropic equivalent that costs tokens)
/// - `tools[]`      → serialized JSON (tool declarations are part of the prompt bytes the model sees)
fn count_text_chars(req: &Value) -> usize {
    let mut chars: usize = 0;

    // system
    match req.get("system") {
        Some(Value::String(s)) => chars += s.len(),
        Some(Value::Array(blocks)) => {
            for b in blocks {
                if let Some(t) = b.get("text").and_then(Value::as_str) {
                    chars += t.len();
                }
            }
        }
        _ => {}
    }

    // messages
    for m in req.get("messages").and_then(Value::as_array).into_iter().flatten() {
        match m.get("content") {
            Some(Value::String(t)) => {
                chars += t.len();
            }
            Some(Value::Array(blocks)) => {
                for b in blocks {
                    match b.get("type").and_then(Value::as_str).unwrap_or("") {
                        "text" => {
                            if let Some(t) = b.get("text").and_then(Value::as_str) {
                                chars += t.len();
                            }
                        }
                        "tool_use" => {
                            if let Some(name) = b.get("name").and_then(Value::as_str) {
                                chars += name.len();
                            }
                            if let Some(input) = b.get("input") {
                                chars += input.to_string().len();
                            }
                        }
                        "tool_result" => {
                            chars += tool_result_text(b).len();
                        }
                        "image" => {
                            // Flat constant; see IMAGE_TOKENS doc above.
                            chars += (IMAGE_TOKENS as usize) * 4; // 1024 tokens ≈ 4096 chars at 4 c/t
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }

    // tools (declarations the model sees even when no tool is called)
    if let Some(tools) = req.get("tools") {
        chars += tools.to_string().len();
    }

    chars
}

/// `POST /v1/messages/count_tokens` — estimate input tokens locally, no upstream round-trip.
///
/// Claude Code and other Anthropic-SDK clients call this before sending a real `messages`
/// request to pre-flight the prompt. Answering 404 forces a client to fall back to its own
/// estimate; a client that does not gracefully handle that would break.
///
/// The estimate is 4-chars-per-token over the same content `to_chat_body` would forward,
/// plus a flat `IMAGE_TOKENS` per image block. `model` is accepted but unused: the count is
/// model-agnostic, so an unknown model id does not 404 and clients can probe freely.
///
/// No ledger entry: this is a no-cost probe, not a billed model call.
pub(crate) async fn count_tokens_h(
    State(core): State<Arc<GatewayCore>>,
    headers: HeaderMap,
    body: String,
) -> Response {
    // Identity discarded on purpose: this probe dispatches nothing, so it writes no ledger row.
    if let Err(r) = check_gateway_key(&core, &headers, peer_ip(&headers)) {
        return r.anthropic();
    }
    let Ok(req) = serde_json::from_str::<Value>(&body) else {
        return err(
            StatusCode::BAD_REQUEST,
            anthropic_error("invalid JSON body", "invalid_request_error"),
        );
    };
    let text_chars = count_text_chars(&req);
    let input_tokens = text_chars / 4;
    tracing::debug!(chars = text_chars, input_tokens = input_tokens, "count_tokens estimate");
    (StatusCode::OK, axum::Json(json!({ "input_tokens": input_tokens }))).into_response()
}

/// Anthropic transcript -> OpenAI messages.
///
/// A protocol mapping, not a flattening. `tool_use` blocks become `tool_calls` on the assistant
/// turn that made them; `tool_result` blocks become their own `{"role":"tool"}` messages. Keeping
/// only `.text` — which is what this did — discarded every call the agent had made and every
/// result it had received, so from the second round onwards the model answered against a
/// transcript in which its own actions had never happened and its tool output never arrived.
fn messages_to_openai(req: &Value) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    for m in req.get("messages").and_then(Value::as_array).into_iter().flatten() {
        let role = m.get("role").and_then(Value::as_str).unwrap_or("user");
        match m.get("content") {
            // The common case, and the only one with no blocks to lose.
            Some(Value::String(t)) => out.push(json!({ "role": role, "content": t })),
            Some(Value::Array(blocks)) => {
                let mut text = String::new();
                let mut calls: Vec<Value> = Vec::new();
                let mut answered_a_call = false;
                for b in blocks {
                    match b.get("type").and_then(Value::as_str).unwrap_or("") {
                        "text" => {
                            if let Some(t) = b.get("text").and_then(Value::as_str) {
                                text.push_str(t);
                            }
                        }
                        "tool_use" => calls.push(json!({
                            "id": b.get("id").and_then(Value::as_str).unwrap_or(""),
                            "type": "function",
                            "function": {
                                "name": b.get("name").and_then(Value::as_str).unwrap_or(""),
                                // OpenAI carries arguments as a JSON *string*; Anthropic
                                // carries an object. A missing input becomes `{}` and not null,
                                // so a provider always has an object to read them from.
                                "arguments": b.get("input").cloned().unwrap_or_else(|| json!({})).to_string()
                            }
                        })),
                        "tool_result" => {
                            // A result is its own message on the OpenAI wire, so any prose that
                            // preceded it is flushed first — block order is preserved either way.
                            if !text.is_empty() {
                                out.push(json!({ "role": role, "content": std::mem::take(&mut text) }));
                            }
                            answered_a_call = true;
                            out.push(json!({
                                "role": "tool",
                                "tool_call_id": b.get("tool_use_id").and_then(Value::as_str).unwrap_or(""),
                                "content": tool_result_text(b)
                            }));
                        }
                        // Anything else (thinking, images) has no OpenAI equivalent here and is
                        // dropped rather than guessed at.
                        _ => {}
                    }
                }
                if !calls.is_empty() {
                    out.push(json!({ "role": role, "content": text, "tool_calls": calls }));
                } else if !text.is_empty() || !answered_a_call {
                    // A turn of nothing but unrecognised blocks still has to exist, or the
                    // assistant turn it answers is left dangling. A turn that was only a
                    // tool result must NOT also produce an empty message — that empty turn is
                    // what made providers reject the body outright.
                    out.push(json!({ "role": role, "content": text }));
                }
            }
            _ => out.push(json!({ "role": role, "content": "" })),
        }
    }
    out
}

fn to_chat_body(req: &Value) -> Option<Value> {
    let model = req.get("model").and_then(Value::as_str)?;
    let mut messages: Vec<Value> = Vec::new();
    // `system` is a string OR an array of content blocks. Claude Code always sends the array
    // form, so reading only `.as_str()` dropped the whole system prompt — silently, because
    // nothing here rejects a shape it does not recognise. `cache_control` markers are still
    // discarded, so the prompt arrives but is not cached.
    match req.get("system") {
        Some(Value::String(s)) => messages.push(json!({ "role": "system", "content": s })),
        Some(Value::Array(blocks)) => {
            let text: String = blocks
                .iter()
                .filter_map(|b| b.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("");
            if !text.is_empty() {
                messages.push(json!({ "role": "system", "content": text }));
            }
        }
        _ => {}
    }
    // `messages` is still required — an absent array stays a 400 rather than an empty transcript.
    req.get("messages").and_then(Value::as_array)?;
    messages.extend(messages_to_openai(req));
    let mut out = json!({
        "model": model,
        "messages": messages,
        "stream": req.get("stream").and_then(Value::as_bool).unwrap_or(false),
        "max_tokens": req.get("max_tokens").and_then(Value::as_i64).unwrap_or(1024),
    });
    // Tools must be CONVERTED, not cloned. The bridge speaks OpenAI; Anthropic's
    // `{name, description, input_schema}` is not the same object, and forwarding it verbatim
    // sends an OpenAI-shaped provider a body it rejects outright (502 SERVER_ERROR). That was
    // invisible while no manifest forwarded tools at all — it only surfaced once they did.
    if let Some(tools) = req.get("tools").and_then(tools_to_openai) {
        out["tools"] = tools;
    }
    if let Some(tc) = req.get("tool_choice").and_then(tool_choice_to_openai) {
        out["tool_choice"] = tc;
    }
    if req.get("response_format").is_some() {
        out["response_format"] = req["response_format"].clone();
    }
    Some(out)
}

/// Anthropic tool declarations -> OpenAI function declarations.
fn tools_to_openai(tools: &Value) -> Option<Value> {
    let arr = tools.as_array()?;
    let out: Vec<Value> = arr
        .iter()
        .filter_map(|t| {
            let name = t.get("name").and_then(Value::as_str)?;
            let mut function = json!({
                "name": name,
                // A tool with no schema still needs one, or the model has nowhere to put args.
                "parameters": t.get("input_schema").cloned()
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

/// Anthropic `tool_choice` -> OpenAI. `auto|any|none|tool` maps onto `auto|required|none|forced`.
fn tool_choice_to_openai(tc: &Value) -> Option<Value> {
    match tc.get("type").and_then(Value::as_str).unwrap_or("auto") {
        "tool" => tc
            .get("name")
            .and_then(Value::as_str)
            .map(|n| json!({ "type": "function", "function": { "name": n } })),
        "any" => Some(json!("required")),
        "none" => Some(json!("none")),
        _ => Some(json!("auto")),
    }
}

fn anthropic_stop_reason(cls: Option<&str>) -> &'static str {
    match cls {
        Some("length") => "max_tokens",
        Some("tool_use") => "tool_use",
        _ => "end_turn",
    }
}

pub(crate) async fn messages_h(
    State(core): State<Arc<GatewayCore>>,
    headers: HeaderMap,
    body: String,
) -> Response {
    let app_key = match check_gateway_key(&core, &headers, peer_ip(&headers)) {
        Ok(k) => k,
        Err(r) => return r.anthropic(),
    };
    let Ok(req) = serde_json::from_str::<Value>(&body) else {
        return err(
            StatusCode::BAD_REQUEST,
            anthropic_error("invalid JSON body", "invalid_request_error"),
        );
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
    let mut slot = match try_slot(&core).await {
        Ok(s) => s,
        Err(r) => {
            // The status is already right; only the envelope and the error type need translating.
            // This used to hardcode `overloaded_error` / "at capacity" for every refusal, so a
            // *stopped* gateway asserted a capacity problem and told Claude Code to back off and
            // retry a service that was simply switched off.
            let status = r.status();
            let message = if status == StatusCode::TOO_MANY_REQUESTS {
                "gateway at capacity"
            } else {
                "AI-Provider Router core unavailable — is the app open?"
            };
            return err(status, anthropic_error(message, anthropic_error_kind(status)));
        }
    };
    let id = slot.id;
    let msg_id = format!("msg_gw_{id}");
    let model = chat.get("model").and_then(Value::as_str).unwrap_or("").to_string();
    tracing::info!(request_id = id, kind = "anthropic", model = %model, body = %chat.to_string().chars().take(500).collect::<String>(), "dispatching anthropic messages request");
    let fwd = forwarded_headers(&headers);
    // `Some(&req)`: translation rebuilds the body and drops unknown fields, so the `metadata.aip`
    // fallback has to be read from what the client actually sent.
    let outcome = inject_context(&core, &headers, Some(&req), &mut chat);
    core.record_injection(id, &model, &outcome);
    // `chat`, not `req`: the canonical body is the one with normalized messages and a model.
    let prep = prepare_capture(&core, &headers, &chat, id);
    core.bridge.dispatch(BridgeRequest {
        request_id: id,
        kind: "chat",
        body: chat,
        headers: fwd.clone(),
        app_key_id: app_key,
    });

    if wants_stream {
        let mid = msg_id.clone();
        let stream_body = async_stream::stream! {
            // Moved in: the stream must be 'static, so it cannot borrow the request or headers.
            let prep = prep;
            let mut streamed = String::new();
            // Anthropic SSE: `event: <name>` + `data: <json>` — emit the full lifecycle.
            let start = json!({ "type": "message_start", "message": { "id": mid, "type": "message", "role": "assistant",
                "content": [], "model": model, "stop_reason": null, "usage": { "input_tokens": 0, "output_tokens": 0 } } });
            yield Ok::<Event, std::convert::Infallible>(Event::default().event("message_start").data(start.to_string()));
            yield Ok::<Event, std::convert::Infallible>(Event::default().event("content_block_start")
                .data(json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "text", "text": "" } }).to_string()));
            let mut usage: Option<(u64, u64)> = None;
            let mut has_tool_calls = false;
            while let Some(msg) = slot.recv().await {
                match msg {
                    BridgeMsg::Delta(t) => {
                        streamed.push_str(&t);
                        tracing::info!(request_id = id, delta_len = t.len(), "anthropic stream delta received");
                        let d = json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": t } });
                        yield Ok::<Event, std::convert::Infallible>(Event::default().event("content_block_delta").data(d.to_string()));
                    }
                    BridgeMsg::Result(_) => {}
                    BridgeMsg::Done => {
                        if let Some(p) = &prep {
                            let _ = finish_capture(p, &streamed);
                        }
                        break;
                    }
                    BridgeMsg::Error { status, message, .. } => {
                        // The SSE response is already committed as 200, so the HTTP status can no
                        // longer carry the outcome — the error type is the only signal the client
                        // receives. `Retry-After` is unavailable for the same reason: the status
                        // line is long gone, so a cooldown could not be attached even if the worker
                        // reported one. Hardcoding `overloaded_error` here told Claude Code to back
                        // off and retry a request that had failed on its own contents.
                        let kind = anthropic_error_kind(worker_status(status));
                        let e = json!({ "type": "error", "error": { "type": kind, "message": message } });
                        yield Ok::<Event, std::convert::Infallible>(Event::default().event("error").data(e.to_string()));
                        return;
                    }
                    BridgeMsg::ToolCalls(calls) => {
                        // Model returned structured tool calls — emit them as Anthropic tool_use
                        // blocks alongside the accumulated text, then signal stop_reason: tool_use
                        // so clients know a round-trip is required.
                        has_tool_calls = true;
                        // Close the text block here, before the first tool block opens.
                        // Anthropic orders content blocks strictly, so a stop for index 0
                        // emitted after index 1 has opened is out of sequence — and leaving
                        // it open means the client's parser waits for a stop that never comes.
                        yield Ok::<Event, std::convert::Infallible>(Event::default().event("content_block_stop")
                            .data(json!({ "type": "content_block_stop", "index": 0 }).to_string()));
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
            // A tool turn already closed the text block above; a plain text turn closes it here.
            if !has_tool_calls {
                yield Ok::<Event, std::convert::Infallible>(Event::default().event("content_block_stop")
                    .data(json!({ "type": "content_block_stop", "index": 0 }).to_string()));
            }
            // Terminate the turn either way. `stop_reason` is the client's signal that it must
            // run the tools it declared, and `message_stop` is how it knows the turn ended at
            // all. Both used to be skipped on exactly the turn where they mattered, so a
            // streaming agent loop stopped after one step with no error anywhere.
            let stop_reason = if has_tool_calls { "tool_use" } else { "end_turn" };
            yield Ok::<Event, std::convert::Infallible>(Event::default().event("message_delta")
                .data(json!({ "type": "message_delta", "delta": { "stop_reason": stop_reason, "stop_sequence": null },
                    "usage": { "output_tokens": usage.as_ref().map(|(_, ct)| ct).unwrap_or(&0) } }).to_string()));
            yield Ok::<Event, std::convert::Infallible>(Event::default().event("message_stop").data(json!({ "type": "message_stop" }).to_string()));
            drop(slot);
        };
        let mut r = Sse::new(stream_body)
            .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
            .into_response();
        apply_memory_headers(&mut r, &outcome);
        return r;
    }

    let mut full = String::new();
    let mut usage: Option<(u64, u64)> = None;
    let mut err_info: Option<(u16, String, Option<u64>)> = None;
    let mut tool_content_blocks: Vec<Value> = Vec::new();
    let mut has_tool_calls = false;
    while let Some(msg) = slot.recv().await {
        match msg {
            BridgeMsg::Delta(t) => {
                tracing::info!(
                    request_id = id,
                    delta_len = t.len(),
                    "anthropic non-stream delta received"
                );
                full.push_str(&t);
            }
            BridgeMsg::Result(_) => {}
            BridgeMsg::Done => {
                tracing::info!(request_id = id, full_len = full.len(), "anthropic non-stream done");
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
                // Buffer tool calls to include as tool_use blocks in the response.
                has_tool_calls = true;
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
    let mut r = match err_info {
        Some((status, message, retry_after_ms)) => {
            let code = worker_status(status);
            err_with_cooldown(
                code,
                retry_after_ms,
                anthropic_error(&message, anthropic_error_kind(code)),
            )
        }
        None => {
            let prompt_tokens = usage.as_ref().map(|(pt, _)| pt).unwrap_or(&0);
            let completion_tokens = usage.as_ref().map(|(_, ct)| ct).unwrap_or(&0);
            // Build content: text block first, then any tool_use blocks.
            let text = clean_assistant_text(&full);
            let mut content: Vec<Value> = Vec::new();
            // Anthropic carries a text block only when there is text. On a pure tool-call turn
            // the cleaned text is empty, and emitting an empty block renders as a stray bubble.
            if !text.trim().is_empty() || tool_content_blocks.is_empty() {
                content.push(json!({ "type": "text", "text": text }));
            }
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
    };
    apply_memory_headers(&mut r, &outcome);
    r
}

#[cfg(test)]
mod tool_conversion_tests {
    use super::*;

    #[test]
    fn anthropic_tools_become_openai_functions() {
        let out = tools_to_openai(&json!([{ "name": "Bash", "description": "Run it",
                                            "input_schema": { "type": "object", "properties": { "command": { "type": "string" } } } }]))
            .unwrap();
        assert_eq!(out[0]["type"], "function");
        assert_eq!(out[0]["function"]["name"], "Bash");
        assert_eq!(out[0]["function"]["parameters"]["properties"]["command"]["type"], "string");
    }

    #[test]
    fn a_tool_without_a_schema_still_gets_one() {
        let out = tools_to_openai(&json!([{ "name": "Bash" }])).unwrap();
        assert_eq!(out[0]["function"]["parameters"]["type"], "object");
        assert!(out[0]["function"].get("description").is_none(), "absent, not null");
    }

    /// A minimal Anthropic request wrapper, so the transcript cases below read as transcripts.
    fn transcript(messages: Value) -> Value {
        json!({ "model": "mock-fast", "messages": messages })
    }

    #[test]
    fn an_assistant_tool_use_becomes_openai_tool_calls() {
        let out = messages_to_openai(&transcript(json!([
            { "role": "assistant", "content": [
                { "type": "text", "text": "Let me look" },
                { "type": "tool_use", "id": "toolu_1", "name": "Bash", "input": { "command": "ls" } } ] }
        ])));
        assert_eq!(out.len(), 1, "{out:?}");
        assert_eq!(out[0]["role"], "assistant");
        assert_eq!(out[0]["content"], "Let me look", "the text must survive alongside the call");
        assert_eq!(out[0]["tool_calls"][0]["id"], "toolu_1");
        assert_eq!(out[0]["tool_calls"][0]["type"], "function");
        assert_eq!(out[0]["tool_calls"][0]["function"]["name"], "Bash");
        // OpenAI carries arguments as a JSON *string*; Anthropic carries an object.
        assert_eq!(out[0]["tool_calls"][0]["function"]["arguments"], "{\"command\":\"ls\"}");
    }

    #[test]
    fn a_tool_result_becomes_its_own_tool_message() {
        let out = messages_to_openai(&transcript(json!([
            { "role": "user", "content": [
                { "type": "tool_result", "tool_use_id": "toolu_1", "content": "3 files" } ] }
        ])));
        // One message, not two: emitting an empty user turn as well is what made providers
        // reject the body outright and left the assistant turn dangling.
        assert_eq!(out.len(), 1, "no stray empty turn: {out:?}");
        assert_eq!(out[0]["role"], "tool");
        assert_eq!(out[0]["tool_call_id"], "toolu_1");
        assert_eq!(out[0]["content"], "3 files");
    }

    #[test]
    fn a_block_shaped_tool_result_keeps_its_text() {
        let out = messages_to_openai(&transcript(json!([
            { "role": "user", "content": [
                { "type": "tool_result", "tool_use_id": "t1",
                  "content": [{ "type": "text", "text": "line one" }] } ] }
        ])));
        assert_eq!(out[0]["content"], "line one", "{out:?}");
    }

    #[test]
    fn text_and_a_tool_result_keep_their_order() {
        let out = messages_to_openai(&transcript(json!([
            { "role": "user", "content": [
                { "type": "text", "text": "what came back:" },
                { "type": "tool_result", "tool_use_id": "toolu_1", "content": "3 files" } ] }
        ])));
        assert_eq!(out.len(), 2, "{out:?}");
        assert_eq!(out[0]["role"], "user", "the prose precedes the result: {out:?}");
        assert_eq!(out[1]["role"], "tool");
    }

    #[test]
    fn a_block_array_system_prompt_survives() {
        // Claude Code always sends the array form, with cache_control markers beside the text.
        // Reading only `.as_str()` dropped the entire system prompt.
        let out = to_chat_body(&json!({
            "model": "mock-fast",
            "system": [{ "type": "text", "text": "You are helpful", "cache_control": { "type": "ephemeral" } }],
            "messages": [{ "role": "user", "content": "hi" }]
        }))
        .expect("a body");
        assert_eq!(out["messages"][0]["role"], "system", "{out}");
        assert_eq!(out["messages"][0]["content"], "You are helpful", "{out}");
    }

    #[test]
    fn a_plain_string_transcript_is_untouched() {
        let out = messages_to_openai(&transcript(json!([
            { "role": "user", "content": "hi" },
            { "role": "assistant", "content": "hello" }
        ])));
        assert_eq!(
            out,
            vec![
                json!({ "role": "user", "content": "hi" }),
                json!({ "role": "assistant", "content": "hello" })
            ]
        );
    }

    #[test]
    fn tool_choice_maps_onto_the_openai_vocabulary() {
        assert_eq!(tool_choice_to_openai(&json!({"type":"auto"})).unwrap(), json!("auto"));
        assert_eq!(tool_choice_to_openai(&json!({"type":"any"})).unwrap(), json!("required"));
        assert_eq!(tool_choice_to_openai(&json!({"type":"none"})).unwrap(), json!("none"));
        assert_eq!(
            tool_choice_to_openai(&json!({"type":"tool","name":"Bash"})).unwrap(),
            json!({ "type": "function", "function": { "name": "Bash" } })
        );
    }

    // ── count_text_chars unit tests ─────────────────────────────────────────────

    #[test]
    fn count_plain_string_message() {
        let req = json!({
            "model": "mock",
            "messages": [{ "role": "user", "content": "hello world" }]
        });
        assert_eq!(count_text_chars(&req), 11);
    }

    #[test]
    fn count_system_string_plus_message() {
        let req = json!({
            "model": "mock",
            "system": "You are helpful",
            "messages": [{ "role": "user", "content": "hi" }]
        });
        assert_eq!(count_text_chars(&req), 15 + 2);
    }

    #[test]
    fn count_system_array_blocks() {
        let req = json!({
            "model": "mock",
            "system": [
                { "type": "text", "text": "block one", "cache_control": { "type": "ephemeral" } },
                { "type": "text", "text": "block two" }
            ],
            "messages": []
        });
        assert_eq!(count_text_chars(&req), 9 + 9);
    }

    #[test]
    fn count_tool_use_block_counts_name_and_input() {
        let req = json!({
            "model": "mock",
            "messages": [{
                "role": "assistant",
                "content": [
                    { "type": "tool_use", "id": "t1", "name": "Bash",
                      "input": { "command": "ls -la" } }
                ]
            }]
        });
        // "Bash" = 4, input.to_string() = {"command":"ls -la"} = 20
        assert_eq!(count_text_chars(&req), 4 + 20);
    }

    #[test]
    fn count_image_block_uses_flat_constant() {
        let req = json!({
            "model": "mock",
            "messages": [{
                "role": "user",
                "content": [
                    { "type": "text", "text": "describe" },
                    { "type": "image", "source": { "type": "base64", "data": "…" } }
                ]
            }]
        });
        // "describe" = 8, image = IMAGE_TOKENS * 4 = 4096
        assert_eq!(count_text_chars(&req), 8 + 4096);
    }

    #[test]
    fn count_tools_declaration_is_included() {
        let req = json!({
            "model": "mock",
            "tools": [{ "name": "Bash", "description": "Run a shell command" }],
            "messages": [{ "role": "user", "content": "hi" }]
        });
        // "hi" = 2
        // tools.to_string() = [{"description":"Run a shell command","name":"Bash"}]
        // (serde_json sorts keys alphabetically; the exact string length is what matters)
        let tools_chars =
            json!({ "name": "Bash", "description": "Run a shell command" }).to_string().len();
        // tools array adds 2 chars for "[", "]"
        assert_eq!(count_text_chars(&req), 2 + (tools_chars + 2));
    }

    #[test]
    fn count_empty_body_is_zero() {
        let req = json!({ "model": "mock", "messages": [] });
        assert_eq!(count_text_chars(&req), 0);
    }

    #[test]
    fn count_tool_result_block_counts_content() {
        let req = json!({
            "model": "mock",
            "messages": [{
                "role": "user",
                "content": [
                    { "type": "tool_result", "tool_use_id": "t1", "content": "3 files found" }
                ]
            }]
        });
        assert_eq!(count_text_chars(&req), 13);
    }
}
