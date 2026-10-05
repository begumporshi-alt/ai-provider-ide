//! Dialect shaping — the Rust port of `packages/router-core/src/tool-shaping.ts`
//! (`attachToolParts`, `shapeToolDeclarations`) and `content-parts.ts` (`textOfContent`,
//! `shapeMessageContent`, `renderContentParts`), plus `normalizeDialectMessages` from
//! `manifest-interpreter.ts`.
//!
//! # Why this module exists
//!
//! The two engines implement one grammar. On 2026-10-01 the TypeScript reference gained the v1.1
//! *shaping* declarations — a dialect can now say how it spells a tool declaration, how it replays
//! a past call and its result, how it names a message's content field, and which role is hoisted to
//! a top-level system param. The Rust gateway kept forwarding an OpenAI-shaped body to every
//! dialect, because none of that was ported. The first live symptom was
//! `400 tool_choice must be an object` (drift D85); the rest of the family — a `role:"system"` left
//! inside `messages`, OpenAI's `{type:"function",…}` tool wrapping, a replayed call left on the
//! `tool_calls` sibling field — would have 400'd next on the same path.
//!
//! Each function mirrors its TypeScript namesake clause for clause, including the two orderings
//! that are load-bearing:
//!
//!   1. **Tool parts are attached BEFORE the role map runs.** The result's `tool_call_id` is what
//!      names the call, and the role map deletes it for a dialect with no `tool` role — so the
//!      pairing (the one relation between two messages a manifest cannot express) has to happen
//!      while the id is still there.
//!   2. **Content parts are rendered AFTER role normalization**, because a hoisted system message
//!      is plain text by then and has no parts left to render.
//!
//! A dialect that declares none of these gets its messages back untouched — the OpenAPI dialect's
//! shapes are already the internal shapes.

use std::collections::HashMap;

use serde_json::{json, Map, Value};

use crate::core::adapter::ToolCall;
use crate::core::manifest_view::ToolCallShape;
use crate::core::template::{render_template, TemplateError};

/// What an image counts as when a transcript is flattened. One token, deliberately the cheap
/// approximation: over-counting would push the router's compressor to drop conversation to make
/// room for a picture whose true cost is unknowable from the bytes.
const IMAGE_PLACEHOLDER: &str = "<image>";

/// `JSON.stringify` that cannot throw. `serde_json` cannot fail on a `Value`, so this is just the
/// serialisation — the source's try/catch exists for cyclic JS objects, which cannot occur here.
fn stringify(value: &Value) -> String {
    value.to_string()
}

/// Does this part carry image bytes? Covers our own shape and the dialects' shapes a gateway client
/// may forward verbatim (`image_url`, `input_image`, `inlineData`, `image`).
///
/// The source's pattern is `/image|inline\s*data/i`; whitespace is stripped rather than matched with
/// a regex, which is the same set for the realistic values (`inlineData`) without pulling the regex
/// crate into a module that has no other use for it.
fn is_image_part(ty: &str) -> bool {
    let t: String = ty.to_ascii_lowercase().chars().filter(|c| !c.is_ascii_whitespace()).collect();
    t.contains("image") || t.contains("inlinedata")
}

fn part_text(part: &Value) -> String {
    match part {
        Value::String(s) => s.clone(),
        Value::Object(p) => {
            if let Some(t) = p.get("text").and_then(Value::as_str) {
                return t.to_string();
            }
            let ty = p.get("type").and_then(Value::as_str).unwrap_or("");
            if !ty.is_empty() && is_image_part(ty) {
                return IMAGE_PLACEHOLDER.to_string();
            }
            // An unrecognised object part: measure it rather than reporting nothing. Reporting ""
            // would claim a message is empty, a worse error than a rough size for an unmodelled
            // shape.
            stringify(part)
        }
        _ => String::new(),
    }
}

/// The text of a message's content, whatever shape it arrived in.
///
/// Parts are joined with a space — arbitrary for the purposes this serves (token counting, a
/// transcript line, system hoisting) and the separator the pre-existing estimator used, so token
/// estimates do not shift for the string-and-text-parts case.
pub fn text_of_content(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        Value::Array(items) => {
            items.iter().map(part_text).filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" ")
        }
        other => stringify(other),
    }
}

/// `render_template` on a single object template, as a `Value`.
fn render_object(
    template: &Map<String, Value>,
    values: &Map<String, Value>,
) -> Result<Value, TemplateError> {
    render_template(template, values).map(Value::Object)
}

/* ------------------------------------------------------------------ content parts */

/// Render an array of parts into the dialect's wire shape.
///
/// A manifest that declares no templates passes the parts through unchanged — the honest failure
/// mode for a dialect nobody has taught yet: sending our internal shape is at least *something* a
/// compatible server may accept, where silently dropping images would be a worse lie.
///
/// Only `text` and `image` are rendered here. `toolCall`/`toolResult` are **deliberately** left
/// alone: they are produced by [`attach_tool_parts`], and rendering a block the shaper already built
/// would run it through its template a second time (the source keys its tool parts by our internal
/// names for exactly this reason — a dialect's own block type must not be a template key here).
fn render_content_parts(
    content: &Value,
    templates: Option<&Map<String, Value>>,
) -> Result<Value, TemplateError> {
    let Some(templates) = templates else {
        return Ok(content.clone());
    };
    let Value::Array(items) = content else {
        return Ok(content.clone());
    };
    let mut out = Vec::with_capacity(items.len());
    for part in items {
        let Value::Object(p) = part else {
            out.push(part.clone());
            continue;
        };
        let ty = p.get("type").and_then(Value::as_str).unwrap_or("");
        let template =
            if ty.is_empty() { None } else { templates.get(ty).and_then(Value::as_object) };
        let Some(template) = template else {
            out.push(part.clone());
            continue;
        };
        let rendered = match ty {
            "text" => {
                let mut v = Map::new();
                v.insert(
                    "text".to_string(),
                    p.get("text").cloned().unwrap_or_else(|| Value::String(String::new())),
                );
                render_object(template, &v)?
            }
            "image" => {
                let media = p
                    .get("mediaType")
                    .and_then(Value::as_str)
                    .unwrap_or("application/octet-stream")
                    .to_string();
                let data = p.get("dataBase64").and_then(Value::as_str).unwrap_or("").to_string();
                let mut v = Map::new();
                v.insert("mediaType".to_string(), Value::String(media.clone()));
                v.insert("dataBase64".to_string(), Value::String(data.clone()));
                // The data-URI form is what OpenAI's `image_url.url` wants; Anthropic's and
                // Gemini's templates use the bare bytes. Both are offered so a dialect does not
                // have to concatenate strings inside a template it cannot execute.
                v.insert(
                    "dataUri".to_string(),
                    Value::String(format!("data:{media};base64,{data}")),
                );
                render_object(template, &v)?
            }
            _ => part.clone(),
        };
        out.push(rendered);
    }
    Ok(Value::Array(out))
}

/// Shape every message's content for one dialect: render part arrays, and rename the content field
/// when the dialect calls it something else (Gemini's `parts`).
///
/// One function rather than two loops, because the two decisions are one decision — "what does this
/// dialect expect where the content goes" — and splitting them is how a dialect ends up with
/// rendered parts in a field its API does not read.
///
/// A dialect that declares nothing gets its messages back untouched: no rename, no re-render, so a
/// manifest written before this existed behaves exactly as it did.
pub fn shape_message_content(
    messages: &[Value],
    templates: Option<&Map<String, Value>>,
    content_field: Option<&str>,
) -> Result<Vec<Value>, TemplateError> {
    let renames = matches!(content_field, Some(f) if f != "content");
    if templates.is_none() && !renames {
        return Ok(messages.to_vec());
    }
    let mut out = Vec::with_capacity(messages.len());
    for m in messages {
        let Value::Object(msg) = m else {
            out.push(m.clone());
            continue;
        };
        let content = msg.get("content").cloned().unwrap_or(Value::Null);
        let mut rendered = render_content_parts(&content, templates)?;
        if !renames {
            if rendered == content {
                out.push(m.clone());
            } else {
                let mut o = msg.clone();
                o.insert("content".to_string(), rendered);
                out.push(Value::Object(o));
            }
            continue;
        }
        // A dialect that names its own content field wants *parts*, always an array: a plain string
        // becomes a single text part, wrapped through the dialect's OWN text template. Without the
        // wrap, every plain-text message to Gemini would go out as `parts:[{type:"text",text}]`,
        // carrying a `type` field its Part proto does not define.
        if let Value::String(s) = &rendered {
            rendered = if s.is_empty() {
                Value::Array(Vec::new())
            } else {
                let wrapped = match templates.and_then(|t| t.get("text")).and_then(Value::as_object)
                {
                    Some(template) => {
                        let mut v = Map::new();
                        v.insert("text".to_string(), Value::String(s.clone()));
                        render_object(template, &v)?
                    }
                    None => json!({ "type": "text", "text": s }),
                };
                Value::Array(vec![wrapped])
            };
        }
        // `content ?? []` — a message with no content field becomes an empty parts array, because a
        // `parts` field that is absent and one that is `null` are both rejected.
        if rendered.is_null() {
            rendered = Value::Array(Vec::new());
        }
        let mut o = msg.clone();
        o.remove("content");
        o.insert(content_field.unwrap_or("content").to_string(), rendered);
        out.push(Value::Object(o));
    }
    Ok(out)
}

/* ------------------------------------------------------------------ roles */

/// Translate the internal OpenAI role vocabulary to the dialect's own, per the manifest's
/// `messagesRoleMap`.
///
/// A `null` map value hoists those messages' content into the dialect's system field (declared by
/// `systemField`); a string value remaps the role inline; a role the map does not mention passes
/// through verbatim (a dialect that declares a map but omits a role is saying "I speak this role
/// natively too"). When the map is absent, messages pass through untouched — the OpenAI dialect.
///
/// `tool_call_id` is dropped when the role is translated away from `tool`, because it is an OpenAI
/// concept that Anthropic and Gemini reject.
pub fn normalize_dialect_messages(
    messages: &[Value],
    role_map: Option<&Map<String, Value>>,
    system_field: Option<&str>,
) -> (Vec<Value>, Option<String>) {
    let Some(role_map) = role_map else {
        return (messages.to_vec(), None);
    };
    let mut out = Vec::with_capacity(messages.len());
    let mut system_parts: Vec<String> = Vec::new();
    for msg in messages {
        let Value::Object(m) = msg else {
            out.push(msg.clone());
            continue;
        };
        let role = m.get("role").and_then(Value::as_str).unwrap_or("user");
        match role_map.get(role) {
            // Present with `null`: hoist. `text_of_content`, not `String(..)`: a system message may
            // carry parts, and rendering `[object Object]` would send that to the provider as the
            // system prompt.
            Some(Value::Null) => {
                let content = m.get("content").map(text_of_content).unwrap_or_default();
                if !content.is_empty() {
                    system_parts.push(content);
                }
            }
            // The role is not in the map — pass through verbatim.
            None => out.push(msg.clone()),
            Some(target) => {
                let mut translated = m.clone();
                translated.insert("role".to_string(), target.clone());
                // `tool_call_id` is an OpenAI concept that Anthropic and Gemini reject; drop it
                // whenever the role is being translated away from `tool`.
                if target.as_str() != Some("tool") {
                    translated.remove("tool_call_id");
                }
                out.push(Value::Object(translated));
            }
        }
    }
    let system_content =
        if system_parts.is_empty() { None } else { Some(system_parts.join("\n\n")) };
    // With no system field there is no channel to receive hoisted content, so drop it rather than
    // silently losing it into a field no template reads.
    if system_field.is_none() {
        return (out, None);
    }
    (out, system_content)
}

/* ------------------------------------------------------------------ tool declarations */

/// Reshape the caller's OpenAI-shaped `tools` array into the dialect's own declaration shape.
///
/// A dialect that declares nothing gets the array back untouched, which is what keeps every
/// manifest written before this working exactly as it did.
///
/// `parameters` is defaulted rather than passed through as absent: a declaration without a
/// parameter schema is rejected by Gemini, and the repo already carries the same default in the
/// other direction (`declaration_to_openai` in `gateway_gemini.rs` fills in the empty object schema
/// when *reading* a Gemini declaration). One default, stated once on each side.
pub fn shape_tool_declarations(
    tools: Option<&Value>,
    templates: Option<&Map<String, Value>>,
    wrapper: Option<&Map<String, Value>>,
) -> Result<Option<Value>, TemplateError> {
    let Some(templates) = templates else {
        return Ok(tools.cloned());
    };
    let Some(Value::Array(items)) = tools else {
        return Ok(tools.cloned());
    };
    let mut declarations = Vec::with_capacity(items.len());
    for tool in items {
        let Value::Object(t) = tool else {
            declarations.push(tool.clone());
            continue;
        };
        let ty = t.get("type").and_then(Value::as_str).unwrap_or("function");
        let Some(template) = templates.get(ty).and_then(Value::as_object) else {
            declarations.push(tool.clone());
            continue;
        };
        let empty = Map::new();
        let f = t.get("function").and_then(Value::as_object).unwrap_or(&empty);
        let mut v = Map::new();
        v.insert(
            "name".to_string(),
            f.get("name").cloned().unwrap_or_else(|| Value::String(String::new())),
        );
        v.insert(
            "description".to_string(),
            f.get("description").cloned().unwrap_or_else(|| Value::String(String::new())),
        );
        v.insert(
            "parameters".to_string(),
            f.get("parameters")
                .cloned()
                .unwrap_or_else(|| json!({ "type": "object", "properties": {} })),
        );
        declarations.push(render_object(template, &v)?);
    }
    // The container goes on LAST and only when declarations exist. `tools` is the value substituted
    // for `{{tools}}`, so a wrapper declared here is what makes a dialect's nested array (Gemini's
    // `[{functionDeclarations:[…]}]`) expressible at all.
    let Some(wrapper) = wrapper else {
        return Ok(Some(Value::Array(declarations)));
    };
    if declarations.is_empty() {
        return Ok(Some(Value::Array(declarations)));
    }
    let mut wv = Map::new();
    wv.insert("declarations".to_string(), Value::Array(declarations));
    Ok(Some(Value::Array(vec![render_object(wrapper, &wv)?])))
}

/* ------------------------------------------------------------------ tool replay */

/// Our internal content as an array of parts — the neutral side, before the rename.
fn as_parts(content: &Value) -> Vec<Value> {
    match content {
        Value::Array(items) => items.clone(),
        Value::String(s) if !s.is_empty() => vec![json!({ "type": "text", "text": s })],
        _ => Vec::new(),
    }
}

fn non_null(v: Option<&Value>) -> Option<&Value> {
    v.filter(|v| !v.is_null())
}

fn call_id(call: &Value) -> Option<String> {
    call.get("id").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string)
}

fn call_name(call: &Value) -> String {
    // Both stored shapes: the internal one (`name`) and OpenAI's nested one (`function.name`), the
    // same tolerance `lib/tools/render.ts` applies on the UI side.
    let v = non_null(call.get("name"))
        .or_else(|| non_null(call.get("function").and_then(|f| f.get("name"))));
    v.and_then(Value::as_str).unwrap_or("").to_string()
}

fn call_arguments(call: &Value) -> String {
    let v = non_null(call.get("arguments"))
        .or_else(|| non_null(call.get("function").and_then(|f| f.get("arguments"))));
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(other) => stringify(other),
        None => String::new(),
    }
}

/// `JSON.parse` that cannot throw, for turning a call's argument text back into an object. A
/// malformed argument string still has to reach the dialect as *something*, because dropping the
/// call would lose the turn entirely; the host reports the model's mistake.
fn parse_arguments(text: &str) -> Value {
    if text.trim().is_empty() {
        return json!({});
    }
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Null) | Err(_) => json!({}),
        Ok(v) => v,
    }
}

/// Move replayed tool traffic out of the OpenAI fields and into the dialect's content parts.
///
/// One structural change beyond renaming: a run of consecutive `tool` messages **collapses** into a
/// single message holding one part per result. Both non-OpenAI dialects require it — Anthropic wants
/// every `tool_result` of a turn in the one user message that follows it, Gemini wants one user turn
/// with N `functionResponse` parts — and it is measured, not theoretical (drift D82).
///
/// A dialect that declares neither template gets its messages back untouched.
pub fn attach_tool_parts(
    messages: &[Value],
    tool_call: Option<&Map<String, Value>>,
    tool_result: Option<&Map<String, Value>>,
) -> Result<Vec<Value>, TemplateError> {
    if tool_call.is_none() && tool_result.is_none() {
        return Ok(messages.to_vec());
    }

    // Which call each result answers. Gemini's `functionResponse` names the *tool*, and the internal
    // shape carries only `tool_call_id` — so the name is resolved by looking back at the assistant
    // turn that declared the call. The one step a manifest cannot express: a relation between two
    // messages, which a template language that could walk the conversation would be a program, not
    // a mapping.
    let mut name_by_id: HashMap<String, String> = HashMap::new();
    for m in messages {
        let Some(tcs) = m.get("tool_calls").and_then(Value::as_array) else {
            continue;
        };
        for c in tcs {
            if let Some(id) = call_id(c) {
                name_by_id.insert(id, call_name(c));
            }
        }
    }

    // Pass 1: collapse tool runs. `merged` holds the index of the message the run is folding into.
    let mut pass1: Vec<Value> = Vec::with_capacity(messages.len());
    let mut merged: Option<usize> = None;
    for m in messages {
        let is_tool = m.get("role").and_then(Value::as_str) == Some("tool");
        if let (true, Some(tool_result)) = (is_tool, tool_result) {
            let id = m.get("tool_call_id").and_then(Value::as_str).unwrap_or("").to_string();
            // `text_of_content`, not a string-only read: the gateway normalizer converts every
            // message's string content to a `[{type:"text",text}]` array (Phase F,
            // `ensure_array_content`) before the interpreter sees it, so a result the client sent
            // as a plain string arrives here as an array — and a string-only read turned every
            // tool result into an empty block (measured 2026-10-05: ZCode client,
            // Anthropic-dialect provider, every tool result empty).
            let text = m.get("content").map(text_of_content).unwrap_or_default();
            let mut v = Map::new();
            v.insert("id".to_string(), Value::String(id.clone()));
            v.insert(
                "name".to_string(),
                Value::String(name_by_id.get(&id).cloned().unwrap_or_default()),
            );
            v.insert("text".to_string(), Value::String(text.clone()));
            // Gemini's `functionResponse.response` must be a Struct; a bare string is rejected, so
            // the text is wrapped. `result` is our field name inside that Struct and nothing reads
            // it back out — it exists only to satisfy the shape.
            v.insert("response".to_string(), json!({ "result": text }));
            let block = render_object(tool_result, &v)?;
            if let Some(idx) = merged {
                if let Some(Value::Array(content)) = pass1[idx].get_mut("content") {
                    content.push(block);
                }
                continue;
            }
            // Replaced, not appended: the result *is* the message. Its text is carried inside the
            // rendered block, so keeping the original text part beside it would send the same output
            // to the model twice.
            pass1.push(json!({ "role": "tool", "content": [block] }));
            merged = Some(pass1.len() - 1);
            continue;
        }
        merged = None;
        pass1.push(m.clone());
    }

    // Pass 2: move each assistant turn's calls into content parts and drop the OpenAI sibling field.
    let mut out = Vec::with_capacity(pass1.len());
    for m in pass1 {
        let Value::Object(mut msg) = m else {
            out.push(m);
            continue;
        };
        let tcs = msg.get("tool_calls").and_then(Value::as_array);
        let Some(tcs) = tcs.filter(|t| !t.is_empty()) else {
            out.push(Value::Object(msg));
            continue;
        };
        let Some(tool_call) = tool_call else {
            out.push(Value::Object(msg));
            continue;
        };
        let content = msg.get("content").cloned().unwrap_or(Value::Null);
        let mut parts = as_parts(&content);
        for c in tcs {
            let name = call_name(c);
            let args_text = call_arguments(c);
            let mut v = Map::new();
            v.insert("id".to_string(), Value::String(call_id(c).unwrap_or_default()));
            v.insert("name".to_string(), Value::String(name));
            // Both spellings, because the dialects disagree on which they carry: OpenAI replays a
            // string, Gemini and Anthropic want the object.
            v.insert("arguments".to_string(), Value::String(args_text.clone()));
            v.insert("argumentsObject".to_string(), parse_arguments(&args_text));
            parts.push(render_object(tool_call, &v)?);
        }
        msg.insert("content".to_string(), Value::Array(parts));
        msg.remove("tool_calls");
        out.push(Value::Object(msg));
    }
    Ok(out)
}

/* ------------------------------------------------------------------ finish reason */

/// Translate a dialect's own finish reason into the **OpenAI vocabulary**, per the endpoint's
/// `responseFinishMap`. The port of `translateFinishReason` (`manifest-interpreter.ts`).
///
/// The raw value is whatever the `responseFinish` selector read — Anthropic's `max_tokens`,
/// Gemini's `MAX_TOKENS`. Both consumers of this router speak OpenAI: the app warns when
/// `reason == "length"`, and the gateway writes it onto an OpenAI-shaped `finish_reason` where
/// clients switch on `stop` / `length` / `tool_calls`. Comparing a dialect word against an OpenAI
/// one never matches, so before this a response truncated at `max_tokens` looked complete — on both
/// paths, silently.
///
/// A reason the map does not name passes through **raw** rather than being dropped: a dialect that
/// knows three of its six reasons should still surface the other three, and an unrecognised word is
/// more useful to a caller than nothing. With no map declared the value is untouched — the OpenAI
/// dialect, whose words already are the target.
pub fn translate_finish_reason(reason: &str, map: Option<&Map<String, Value>>) -> String {
    let Some(map) = map else {
        return reason.to_string();
    };
    match map.get(reason).and_then(Value::as_str) {
        Some(mapped) if !mapped.is_empty() => mapped.to_string(),
        _ => reason.to_string(),
    }
}

/* ------------------------------------------------------------------ reading a tool call */

/// Read a dotted field out of one tool-call block (`"function.name"`, `"functionCall.args"`).
///
/// Deliberately NOT the `$`-selector language used elsewhere in a manifest: those pick *where in the
/// response* the blocks are; this picks a field *inside one already-selected block*, and it has no
/// reason to support filters, wildcards or indexing — a shape that could address more than one value
/// would make "which name?" a question the shaper cannot answer.
///
/// A missing field is `None`, never an error: reading a shape off a response must not fail on a
/// provider that omitted an optional piece.
pub fn block_field<'a>(block: &'a Value, path: &str) -> Option<&'a Value> {
    let mut cur = block;
    for seg in path.split('.') {
        // JavaScript's `typeof cur !== "object"` — an array counts, a string/null/number does not.
        if !(cur.is_object() || cur.is_array()) {
            return None;
        }
        cur = cur.get(seg)?;
    }
    Some(cur)
}

/// Does this block look like a tool call under the dialect's declared shape?
pub fn is_tool_call_block(block: &Value, shape: &ToolCallShape) -> bool {
    let Some(d) = &shape.discriminator else {
        return true;
    };
    let v = block_field(block, &d.path);
    if let Some(present) = d.present {
        return if present {
            v.is_some_and(|v| !v.is_null())
        } else {
            v.is_none() || v.is_some_and(|v| v.is_null())
        };
    }
    let Some(equals) = &d.equals else {
        return true;
    };
    v == Some(equals)
}

/// Read one block as a tool call, or `None` when it is not one.
///
/// `None` rather than a call with empty fields: a nameless tool call is not a degraded call, it is
/// not a call at all. (Before this, an unrecognised block produced exactly that — a `ToolCall` with
/// no name and no arguments — which the loop then handed to a host that could only refuse it.)
pub fn read_tool_call(block: &Value, shape: &ToolCallShape) -> Option<ToolCall> {
    if !(block.is_object() || block.is_array()) {
        return None;
    }
    if !is_tool_call_block(block, shape) {
        return None;
    }
    let name = block_field(block, &shape.name).and_then(Value::as_str).unwrap_or("");
    if name.is_empty() {
        return None;
    }
    let raw_args = block_field(block, &shape.arguments);
    let arguments = match shape.arguments_format.as_deref() {
        // The value is already the arguments object (Gemini's `args`, Anthropic's `input`), and the
        // internal `ToolCall.arguments` is JSON text — so it is serialised on the way in.
        Some("object") => match raw_args {
            None | Some(Value::Null) => String::new(),
            Some(v) => stringify(v),
        },
        _ => match raw_args {
            Some(Value::String(s)) => s.clone(),
            None | Some(Value::Null) => String::new(),
            Some(v) => stringify(v),
        },
    };
    let id = shape
        .id
        .as_deref()
        .and_then(|p| block_field(block, p))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    Some(ToolCall {
        id,
        name: Some(name.to_string()),
        arguments: Some(arguments),
        raw: Some(block.clone()),
    })
}

/// Read every tool call out of an already-selected array of blocks.
pub fn read_tool_calls(blocks: &Value, shape: &ToolCallShape) -> Vec<ToolCall> {
    match blocks {
        Value::Array(items) => items.iter().filter_map(|b| read_tool_call(b, shape)).collect(),
        other => read_tool_call(other, shape).into_iter().collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn obj(v: Value) -> Map<String, Value> {
        match v {
            Value::Object(m) => m,
            other => panic!("expected an object, got {other}"),
        }
    }

    /// The Anthropic content-part declarations, transcribed from `builtin-templates.ts:136-148`.
    fn anthropic_parts() -> Map<String, Value> {
        obj(json!({
            "text": { "type": "text", "text": "{{text}}" },
            "image": {
                "type": "image",
                "source": { "type": "base64", "media_type": "{{mediaType}}", "data": "{{dataBase64}}" }
            },
            "toolCall": { "type": "tool_use", "id": "{{id}}", "name": "{{name}}", "input": "{{argumentsObject}}" },
            "toolResult": { "type": "tool_result", "tool_use_id": "{{id}}", "content": "{{text}}" }
        }))
    }

    fn anthropic_role_map() -> Map<String, Value> {
        obj(json!({ "user": "user", "assistant": "assistant", "system": null, "tool": "user" }))
    }

    fn messages() -> Vec<Value> {
        vec![
            json!({ "role": "system", "content": "You are a helpful assistant." }),
            json!({ "role": "user", "content": "Hello" }),
            json!({ "role": "assistant", "content": "Hi there" }),
            json!({ "role": "tool", "content": "result of tool call", "tool_call_id": "call_123" }),
        ]
    }

    #[test]
    fn text_of_content_flattens_parts_and_marks_images() {
        assert_eq!(text_of_content(&json!("plain")), "plain");
        assert_eq!(
            text_of_content(&json!([{ "type": "text", "text": "a" }, { "type": "image" }])),
            "a <image>"
        );
        assert_eq!(text_of_content(&Value::Null), "");
    }

    #[test]
    fn system_is_hoisted_out_of_messages_and_tool_becomes_user() {
        let (out, system) =
            normalize_dialect_messages(&messages(), Some(&anthropic_role_map()), Some("system"));
        let roles: Vec<&str> = out.iter().filter_map(|m| m["role"].as_str()).collect();
        assert_eq!(roles, vec!["user", "assistant", "user"]);
        assert_eq!(system.as_deref(), Some("You are a helpful assistant."));
        // The translated tool turn lost the OpenAI-only id field.
        assert!(out[2].get("tool_call_id").is_none(), "tool_call_id must not survive: {}", out[2]);
    }

    #[test]
    fn a_role_the_map_does_not_name_passes_through() {
        let map = obj(json!({ "system": null }));
        let (out, _) = normalize_dialect_messages(&messages(), Some(&map), None);
        // Only the system turn was hoisted; the rest kept their OpenAI roles.
        let roles: Vec<&str> = out.iter().filter_map(|m| m["role"].as_str()).collect();
        assert_eq!(roles, vec!["user", "assistant", "tool"]);
    }

    #[test]
    fn no_role_map_means_pass_through() {
        let (out, system) = normalize_dialect_messages(&messages(), None, Some("system"));
        assert_eq!(out.len(), 4);
        assert!(system.is_none());
    }

    #[test]
    fn anthropic_parts_render_a_replayed_tool_turn() {
        let replay = vec![
            json!({ "role": "user", "content": "read it" }),
            json!({
                "role": "assistant", "content": "Reading.",
                "tool_calls": [{ "id": "c1", "type": "function", "function": { "name": "read_file", "arguments": "{\"path\":\"a\"}" } }]
            }),
            json!({ "role": "tool", "content": "file text", "tool_call_id": "c1" }),
        ];
        let parts = anthropic_parts();
        let with_parts = attach_tool_parts(
            &replay,
            parts.get("toolCall").and_then(Value::as_object),
            parts.get("toolResult").and_then(Value::as_object),
        )
        .unwrap();
        // The assistant turn's call is now a content block and the sibling field is gone.
        assert!(with_parts[1].get("tool_calls").is_none(), "{}", with_parts[1]);
        assert_eq!(
            with_parts[1]["content"],
            json!([
                { "type": "text", "text": "Reading." },
                { "type": "tool_use", "id": "c1", "name": "read_file", "input": { "path": "a" } }
            ])
        );
        let (out, _) =
            normalize_dialect_messages(&with_parts, Some(&anthropic_role_map()), Some("system"));
        assert_eq!(
            out[2]["content"],
            json!([{ "type": "tool_result", "tool_use_id": "c1", "content": "file text" }])
        );
    }

    /// Drift D82: a turn that made two calls collapses into ONE user message. Anthropic rejects a
    /// second `tool_result` message — only the single message after the assistant turn may answer.
    #[test]
    fn a_run_of_tool_results_collapses_into_one_message() {
        let parallel = vec![
            json!({ "role": "user", "content": "read both" }),
            json!({
                "role": "assistant", "content": "Reading.",
                "tool_calls": [
                    { "id": "c1", "type": "function", "function": { "name": "read_file", "arguments": "{\"path\":\"a\"}" } },
                    { "id": "c2", "type": "function", "function": { "name": "read_file", "arguments": "{\"path\":\"b\"}" } }
                ]
            }),
            json!({ "role": "tool", "content": "file a", "tool_call_id": "c1" }),
            json!({ "role": "tool", "content": "file b", "tool_call_id": "c2" }),
        ];
        let parts = anthropic_parts();
        let with_parts = attach_tool_parts(
            &parallel,
            parts.get("toolCall").and_then(Value::as_object),
            parts.get("toolResult").and_then(Value::as_object),
        )
        .unwrap();
        let (out, _) =
            normalize_dialect_messages(&with_parts, Some(&anthropic_role_map()), Some("system"));
        let roles: Vec<&str> = out.iter().filter_map(|m| m["role"].as_str()).collect();
        assert_eq!(roles, vec!["user", "assistant", "user"]);
        assert_eq!(
            out[2]["content"],
            json!([
                { "type": "tool_result", "tool_use_id": "c1", "content": "file a" },
                { "type": "tool_result", "tool_use_id": "c2", "content": "file b" }
            ])
        );
    }

    #[test]
    fn anthropic_tool_declarations_are_flat() {
        let templates = obj(json!({
            "function": { "name": "{{name}}", "description": "{{description}}", "input_schema": "{{parameters}}" }
        }));
        let tools = json!([
            { "type": "function", "function": { "name": "read_file", "description": "read", "parameters": { "type": "object" } } }
        ]);
        let out = shape_tool_declarations(Some(&tools), Some(&templates), None).unwrap().unwrap();
        assert_eq!(
            out,
            json!([{ "name": "read_file", "description": "read", "input_schema": { "type": "object" } }])
        );
    }

    #[test]
    fn gemini_tool_declarations_are_wrapped() {
        let templates = obj(json!({
            "function": { "name": "{{name}}", "description": "{{description}}", "parameters": "{{parameters}}" }
        }));
        let wrapper = obj(json!({ "functionDeclarations": "{{declarations}}" }));
        // No parameters supplied → the empty object schema is filled in, not omitted.
        let tools =
            json!([{ "type": "function", "function": { "name": "t", "description": "d" } }]);
        let out = shape_tool_declarations(Some(&tools), Some(&templates), Some(&wrapper))
            .unwrap()
            .unwrap();
        assert_eq!(
            out,
            json!([{ "functionDeclarations": [
                { "name": "t", "description": "d", "parameters": { "type": "object", "properties": {} } }
            ] }])
        );
    }

    #[test]
    fn a_dialect_without_declarations_keeps_the_caller_array() {
        let tools = json!([{ "type": "function", "function": { "name": "t" } }]);
        assert_eq!(shape_tool_declarations(Some(&tools), None, None).unwrap().unwrap(), tools);
    }

    #[test]
    fn gemini_renames_content_to_parts_and_wraps_plain_text() {
        let templates = obj(json!({ "text": { "text": "{{text}}" } }));
        let out = shape_message_content(
            &[json!({ "role": "user", "content": "hi" })],
            Some(&templates),
            Some("parts"),
        )
        .unwrap();
        // No `type` field: Gemini's Part proto has none.
        assert_eq!(out[0]["parts"], json!([{ "text": "hi" }]));
        assert!(out[0].get("content").is_none());
    }

    #[test]
    fn anthropic_image_uses_a_base64_source_block() {
        let templates = anthropic_parts();
        let out = shape_message_content(
            &[json!({ "role": "user", "content": [
                { "type": "text", "text": "what is this?" },
                { "type": "image", "mediaType": "image/png", "dataBase64": "AAAA" }
            ] })],
            Some(&templates),
            None,
        )
        .unwrap();
        assert_eq!(
            out[0]["content"],
            json!([
                { "type": "text", "text": "what is this?" },
                { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "AAAA" } }
            ])
        );
    }

    #[test]
    fn a_string_content_is_left_alone_without_a_rename() {
        let templates = anthropic_parts();
        let out = shape_message_content(
            &[json!({ "role": "user", "content": "plain" })],
            Some(&templates),
            None,
        )
        .unwrap();
        assert_eq!(out[0]["content"], json!("plain"));
        assert!(!out[0]["content"].is_array(), "a plain string must not be upgraded to parts");
    }

    /* ---------------------------------------------------------- reading a tool call */

    /// Built through `serde` on purpose: this also proves the view model deserializes the shape, so
    /// a field the struct forgot to declare reads as "no constraint" rather than failing loudly.
    fn shape(v: Value) -> ToolCallShape {
        serde_json::from_value(v).expect("the shape decl reads")
    }

    /// Gemini's `functionCall` part: no `type` at all, so presence is the discriminator, and `args`
    /// is an object that must be serialised into the internal JSON-text form.
    #[test]
    fn a_gemini_function_call_is_read_by_presence() {
        let s = shape(json!({
            "discriminator": { "path": "functionCall", "present": true },
            "name": "functionCall.name",
            "arguments": "functionCall.args",
            "argumentsFormat": "object",
            "streamedAs": "whole"
        }));
        let parts = json!([
            { "text": "let me look" },
            { "functionCall": { "name": "read_file", "args": { "path": "a" } } }
        ]);
        let calls = read_tool_calls(&parts, &s);
        assert_eq!(calls.len(), 1, "the text part must not be read as a call");
        assert_eq!(calls[0].name.as_deref(), Some("read_file"));
        assert_eq!(calls[0].arguments.as_deref(), Some("{\"path\":\"a\"}"));
    }

    #[test]
    fn a_block_the_discriminator_rejects_is_not_a_call() {
        let s = shape(json!({
            "discriminator": { "path": "type", "equals": "tool_use" },
            "id": "id", "name": "name", "arguments": "input", "argumentsFormat": "object"
        }));
        // Anthropic's mixed `content`: the text block is filtered out by the discriminator.
        assert!(read_tool_calls(&json!([{ "type": "text", "text": "hi" }]), &s).is_empty());
    }

    /// A nameless block is not a degraded call, it is not a call — the refusal the shape-less path
    /// deliberately does not make (see `emit_tool_calls`).
    #[test]
    fn a_nameless_block_is_refused() {
        let s = shape(json!({
            "discriminator": { "path": "type", "equals": "tool_use" },
            "id": "id", "name": "name", "arguments": "input", "argumentsFormat": "object"
        }));
        assert!(read_tool_calls(&json!([{ "type": "tool_use", "id": "c1" }]), &s).is_empty());
        assert!(read_tool_calls(&json!([{ "type": "tool_use", "name": "" }]), &s).is_empty());
    }

    /// A non-array selection is one block, not zero — the source's `readToolCalls` shape.
    #[test]
    fn a_single_block_is_read_as_one_call() {
        let s = shape(
            json!({ "id": "id", "name": "function.name", "arguments": "function.arguments" }),
        );
        let calls = read_tool_calls(
            &json!({ "id": "c1", "function": { "name": "f", "arguments": "{}" } }),
            &s,
        );
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].id.as_deref(), Some("c1"));
        // `json-string` (the default) carries the text through untouched.
        assert_eq!(calls[0].arguments.as_deref(), Some("{}"));
    }

    /// An absent optional field must not refuse the call — reading a shape off a response cannot
    /// fail on a provider that omitted a piece.
    #[test]
    fn a_missing_arguments_field_yields_an_empty_string() {
        let s = shape(json!({ "name": "name", "arguments": "arguments" }));
        let calls = read_tool_calls(&json!([{ "name": "no_args" }]), &s);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].arguments.as_deref(), Some(""));
    }

    /* ------------------------------------------------------------------ finish reason */

    #[test]
    fn a_dialect_finish_reason_is_mapped_to_openais_word() {
        let map =
            obj(json!({ "max_tokens": "length", "end_turn": "stop", "tool_use": "tool_calls" }));
        assert_eq!(translate_finish_reason("max_tokens", Some(&map)), "length");
        assert_eq!(translate_finish_reason("tool_use", Some(&map)), "tool_calls");
        // **A reason the map does not name passes through raw, not `undefined`.** A dialect that
        // knows some of its reasons should still surface the rest, and Anthropic has added stop
        // reasons before.
        assert_eq!(translate_finish_reason("new_reason", Some(&map)), "new_reason");
        // No map declared: the value is untouched — the OpenAI dialect, whose words are the target.
        assert_eq!(translate_finish_reason("length", None), "length");
        // A non-string map value is not a word; the raw reason stands rather than becoming `""`.
        let odd = obj(json!({ "weird": 7 }));
        assert_eq!(translate_finish_reason("weird", Some(&odd)), "weird");
    }
}
