//! Gemini `generateContent` ingress — one of four dialects the gateway speaks (§3.4 extended).
//!
//! Split out of `gateway.rs` (audit R8): the edge now has one module per wire dialect, so a
//! change to Gemini framing cannot touch the OpenAI or Anthropic paths.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::State;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use serde_json::{json, Value};

use crate::gateway::{
    check_gateway_key, forwarded_headers, map_generic_to_status, peer_ip, try_slot, BridgeMsg,
    BridgeRequest, GatewayCore,
};

/// One Gemini function declaration -> one OpenAI function declaration.
fn declaration_to_openai(d: &Value) -> Option<Value> {
    let name = d.get("name").and_then(Value::as_str)?;
    let mut function = json!({
        "name": name,
        "parameters": d.get("parameters").cloned()
            .unwrap_or_else(|| json!({ "type": "object", "properties": {} })),
    });
    if let Some(desc) = d.get("description").and_then(Value::as_str) {
        function["description"] = json!(desc);
    }
    Some(json!({ "type": "function", "function": function }))
}

/// Gemini nests declarations one level down (`tools: [{ functionDeclarations: [...] }]`), so
/// flatten while converting. Returns None rather than an empty array: "no tools" and "tools:
/// []" are not the same instruction to a model.
fn tools_to_openai(tools: &Value) -> Option<Value> {
    let arr = tools.as_array()?;
    let mut out = Vec::new();
    for t in arr {
        if let Some(decls) = t.get("functionDeclarations").and_then(Value::as_array) {
            out.extend(decls.iter().filter_map(declaration_to_openai));
        } else if let Some(c) = declaration_to_openai(t) {
            out.push(c);
        }
    }
    if out.is_empty() { None } else { Some(Value::Array(out)) }
}

/// Gemini `functionCallingConfig` -> OpenAI. `AUTO|ANY|NONE` plus an optional forced name.
fn tool_choice_to_openai(tc: &Value) -> Option<Value> {
    let cfg = tc.get("functionCallingConfig").cloned().unwrap_or_else(|| tc.clone());
    match cfg.get("mode").and_then(Value::as_str).unwrap_or("AUTO").to_uppercase().as_str() {
        "ANY" => match cfg
            .get("allowedFunctionNames")
            .and_then(Value::as_array)
            .and_then(|a| a.first())
            .and_then(Value::as_str)
        {
            Some(n) => Some(json!({ "type": "function", "function": { "name": n } })),
            None => Some(json!("required")),
        },
        "NONE" => Some(json!("none")),
        _ => Some(json!("auto")),
    }
}

#[cfg(test)]
mod tool_conversion_tests {
    use super::*;

    #[test]
    fn nested_function_declarations_are_flattened() {
        let out = tools_to_openai(&json!([{ "functionDeclarations": [
            { "name": "Bash", "description": "Run it", "parameters": { "type": "object" } },
            { "name": "Read" }
        ]}])).unwrap();
        assert_eq!(out.as_array().unwrap().len(), 2);
        assert_eq!(out[0]["function"]["name"], "Bash");
        assert_eq!(out[1]["function"]["name"], "Read");
        assert_eq!(out[1]["function"]["parameters"]["type"], "object");
    }

    #[test]
    fn bare_declarations_are_accepted_too() {
        let out = tools_to_openai(&json!([{ "name": "Bash" }])).unwrap();
        assert_eq!(out[0]["type"], "function");
    }

    #[test]
    fn an_empty_tools_array_means_no_tools_at_all() {
        assert_eq!(tools_to_openai(&json!([])), None);
    }

    #[test]
    fn function_calling_config_maps_onto_the_openai_vocabulary() {
        assert_eq!(tool_choice_to_openai(&json!({"functionCallingConfig":{"mode":"ANY"}})).unwrap(), json!("required"));
        assert_eq!(tool_choice_to_openai(&json!({"functionCallingConfig":{"mode":"NONE"}})).unwrap(), json!("none"));
        assert_eq!(tool_choice_to_openai(&json!({"functionCallingConfig":{"mode":"AUTO"}})).unwrap(), json!("auto"));
        assert_eq!(
            tool_choice_to_openai(&json!({"functionCallingConfig":{"mode":"ANY","allowedFunctionNames":["Bash"]}})).unwrap(),
            json!({ "type": "function", "function": { "name": "Bash" } })
        );
    }
}

fn gemini_error(message: &str, status: StatusCode) -> Response {
    (
        status,
        axum::Json(json!({ "error": { "code": status.as_u16(), "message": message, "status": match status.as_u16() {
            400 => "INVALID_ARGUMENT", 401 => "UNAUTHENTICATED", 429 => "RESOURCE_EXHAUSTED", 503 => "UNAVAILABLE", _ => "INTERNAL" } } })),
    )
        .into_response()
}

/// Gemini generateContent ingress (v1.1, 2026-09-16): `x-goog-api-key` or `?key=`, model
/// in the path, contents/parts request and candidates response shapes. SSE via ?alt=sse.
pub(crate) async fn gemini_h(State(core): State<Arc<GatewayCore>>, headers: HeaderMap, uri: axum::http::Uri, body: String) -> Response {
    let query: HashMap<String, String> = uri
        .query()
        .map(|q| {
            url::form_urlencoded::parse(q.as_bytes())
                .map(|(k, v)| (k.into_owned(), v.into_owned()))
                .collect()
        })
        .unwrap_or_default();
    // ?key= is Gemini's legacy auth; fold it into the header check.
    let mut headers2 = headers.clone();
    if headers2.get("x-goog-api-key").is_none() {
        if let Some(k) = query.get("key") {
            if let Ok(v) = HeaderValue::from_str(k) {
                headers2.insert("x-goog-api-key", v);
            }
        }
    }
    if let Some(r) = check_gateway_key(&core, &headers2, peer_ip(&headers)) {
        return r;
    }
    // path: /v1beta/models/<model>:generateContent | :streamGenerateContent
    let path = uri.path().to_string();
    let tail = match path.rsplit("/models/").next() {
        Some(t) => t,
        None => return gemini_error("bad path — expected /v1beta/models/<model>:generateContent", StatusCode::NOT_FOUND),
    };
    let (model, streaming) = match tail.split_once(':') {
        Some((m, "generateContent")) => (m.to_string(), false),
        Some((m, "streamGenerateContent")) => (m.to_string(), true),
        _ => return gemini_error("bad method suffix — expected :generateContent or :streamGenerateContent", StatusCode::BAD_REQUEST),
    };
    if streaming {
        if query.get("alt").map(|v| v.as_str()) != Some("sse") {
            // v1: Gemini streaming is served as SSE only (alt=sse); plain JSON-array
            // streaming is not implemented — refuse rather than answer wrongly.
            return gemini_error("streaming requires ?alt=sse", StatusCode::BAD_REQUEST);
        }
    }
    let Ok(req) = serde_json::from_str::<Value>(&body) else {
        return gemini_error("invalid JSON body", StatusCode::BAD_REQUEST);
    };
    let mut messages: Vec<Value> = Vec::new();
    if let Some(sys) = req.pointer("/systemInstruction/parts") {
        let text = sys
            .as_array()
            .map(|ps| ps.iter().filter_map(|p| p.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join(""))
            .unwrap_or_default();
        if !text.is_empty() {
            messages.push(json!({ "role": "system", "content": text }));
        }
    }
    let Some(contents) = req.get("contents").and_then(Value::as_array) else {
        return gemini_error("contents is required", StatusCode::BAD_REQUEST);
    };
    for c in contents {
        let role = if c.get("role").and_then(Value::as_str) == Some("model") { "assistant" } else { "user" };
        let text = c
            .get("parts")
            .and_then(Value::as_array)
            .map(|ps| ps.iter().filter_map(|p| p.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join(""))
            .unwrap_or_default();
        messages.push(json!({ "role": role, "content": text }));
    }
    let mut chat = json!({
        "model": model,
        "messages": messages,
        "stream": streaming,
        "max_tokens": req.pointer("/generationConfig/maxOutputTokens").and_then(Value::as_i64).unwrap_or(1024),
        "temperature": req.pointer("/generationConfig/temperature").and_then(Value::as_f64),
    });
    // Converted, not cloned — see the note in gateway_anthropic. Gemini wraps declarations in
    // `tools: [{ functionDeclarations: [...] }]`, which no OpenAI-shaped provider understands.
    if let Some(tools) = req.get("tools").and_then(tools_to_openai) {
        chat["tools"] = tools;
    }
    if let Some(tc) = req.get("tool_choice").and_then(tool_choice_to_openai) {
        chat["tool_choice"] = tc;
    }
    if let Some(rf) = req.get("response_format").cloned() {
        chat["response_format"] = rf;
    }
    let mut slot = match try_slot(&core).await {
        Ok(s) => s,
        Err(r) => return map_generic_to_status(r),
    };
    let id = slot.id;
    let fwd = forwarded_headers(&headers);
    core.bridge.dispatch(BridgeRequest { request_id: id, kind: "chat", body: chat, headers: fwd.clone() });
    tracing::info!(request_id = id, kind = "gemini", "dispatching gemini request");

    if streaming {
        let stream_body = async_stream::stream! {
            let mut usage: Option<(u64, u64)> = None;
            while let Some(msg) = slot.rx.recv().await {
                match msg {
                    BridgeMsg::Delta(t) => {
                        let chunk = json!({ "candidates": [{ "content": { "parts": [{ "text": t }], "role": "model" }, "index": 0 }] });
                        yield Ok::<Event, std::convert::Infallible>(Event::default().data(chunk.to_string()));
                    }
                    BridgeMsg::Result(_) => {}
                    BridgeMsg::Done => {
                        let (pt, ct) = usage.unwrap_or((0, 0));
                        let fin = json!({ "candidates": [{ "finishReason": "STOP" }], "usageMetadata": { "promptTokenCount": pt, "candidatesTokenCount": ct } });
                        yield Ok::<Event, std::convert::Infallible>(Event::default().data(fin.to_string()));
                        break;
                    }
                    BridgeMsg::Error { message, .. } => {
                        let e = json!({ "error": { "code": 502, "message": message, "status": "INTERNAL" } });
                        yield Ok::<Event, std::convert::Infallible>(Event::default().data(e.to_string()));
                        break;
                    }
                    BridgeMsg::ToolCalls(calls) => {
                        // Emit a Gemini functionCall part and signal completion so the client
                        // can send tool results back in the next generateContent call.
                        if let Some(arr) = calls.as_array() {
                            for tc in arr {
                                let _call_id = tc.get("id").and_then(Value::as_str).unwrap_or("");
                                let name = tc.get("function").and_then(|f| f.get("name")).and_then(Value::as_str).unwrap_or("");
                                let args_raw = tc.get("function").and_then(|f| f.get("arguments")).unwrap_or(&json!(null));
                                let args: String = if let Some(s) = args_raw.as_str() {
                                    s.to_string()
                                } else {
                                    args_raw.to_string()
                                };
                                let part = json!({ "functionCall": { "name": name, "args": serde_json::from_str(&args).unwrap_or(json!({})) } });
                                let chunk = json!({ "candidates": [{ "content": { "parts": [part], "role": "model" }, "index": 0, "finishReason": "STOP" }] });
                                yield Ok::<Event, std::convert::Infallible>(Event::default().data(chunk.to_string()));
                            }
                        }
                        // Pass-through: the tool calls have already been yielded above, so the
                        // request ends here rather than also emitting a normal STOP finish.
                        let (pt, ct) = usage.unwrap_or((0, 0));
                        let fin = json!({ "usageMetadata": { "promptTokenCount": pt, "candidatesTokenCount": ct } });
                        yield Ok::<Event, std::convert::Infallible>(Event::default().data(fin.to_string()));
                        break;
                    }
                    BridgeMsg::Usage { prompt_tokens, completion_tokens } => {
                        usage = Some((prompt_tokens, completion_tokens));
                    }
                }
            }
            drop(slot);
        };
        return Sse::new(stream_body).keep_alive(KeepAlive::new().interval(Duration::from_secs(15))).into_response();
    }

    let mut full = String::new();
    let mut usage: Option<(u64, u64)> = None;
    let mut err_info: Option<(u16, String)> = None;
    let mut has_tool_calls = false;
    let mut tool_parts: Vec<Value> = Vec::new();
    while let Some(msg) = slot.rx.recv().await {
        match msg {
            BridgeMsg::Delta(t) => full.push_str(&t),
            BridgeMsg::Result(_) => {}
            BridgeMsg::Done => break,
            BridgeMsg::Error { status, message } => {
                err_info = Some((status, message));
                break;
            }
            BridgeMsg::ToolCalls(calls) => {
                has_tool_calls = true;
                if let Some(arr) = calls.as_array() {
                    for tc in arr {
                        let _call_id = tc.get("id").and_then(Value::as_str).unwrap_or("");
                        let name = tc.get("function").and_then(|f| f.get("name")).and_then(Value::as_str).unwrap_or("");
                        let args_raw = tc.get("function").and_then(|f| f.get("arguments")).unwrap_or(&Value::Null);
                        let args: String = if let Some(s) = args_raw.as_str() {
                            s.to_string()
                        } else {
                            args_raw.to_string()
                        };
                        tool_parts.push(json!({ "functionCall": { "name": name, "args": serde_json::from_str(&args).unwrap_or(json!({})) } }));
                    }
                }
            }
            BridgeMsg::Usage { prompt_tokens, completion_tokens } => {
                usage = Some((prompt_tokens, completion_tokens));
            }
        }
    }
    drop(slot);
    match err_info {
        Some((503, _)) | Some((429, _)) => {
            let code = StatusCode::from_u16(503).unwrap();
            gemini_error("gateway unavailable or at capacity", code)
        }
        Some((_, message)) => gemini_error(&message, StatusCode::BAD_GATEWAY),
        None => {
            let (pt, ct) = usage.unwrap_or((0, 0));
            let finish_reason = if has_tool_calls { "STOP" } else { "STOP" };
            let parts = if has_tool_calls && !tool_parts.is_empty() {
                tool_parts
            } else {
                vec![json!({ "text": full })]
            };
            (
                StatusCode::OK,
                [(header::CONTENT_TYPE, "application/json")],
                json!({
                    "candidates": [{ "content": { "parts": parts, "role": "model" }, "finishReason": finish_reason, "index": 0 }],
                    "usageMetadata": { "promptTokenCount": pt, "candidatesTokenCount": ct, "totalTokenCount": pt + ct }
                })
                .to_string(),
            )
                .into_response()
        }
    }
}

