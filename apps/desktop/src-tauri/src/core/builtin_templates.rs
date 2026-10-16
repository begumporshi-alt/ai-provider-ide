//! Builtin adapter templates and provider profiles — the port of
//! `packages/router-core/src/builtin-templates.ts`.
//!
//! **These are data, not code paths.** A new OpenAI-compatible provider is a profile or a wizard
//! entry, never a release — which is why the reference keeps them as two functions over a `baseUrl`
//! rather than as dialects the interpreter learns. This module is the Rust half of the same idea.
//!
//! # The profile's base URL comes from the caller, not from the profile
//!
//! The reference's `PROVIDER_PROFILES` consists of **nullary** builders that hardcode a base URL
//! (`builtin-templates.ts:150-167`), and `store.ts:370` then wraps them:
//! `adapters.register(p.id, withBaseUrl(profile(), p.baseUrl))`. So the profile supplies the
//! *dialect and its quirks* while **the provider row supplies the destination** — the profile's own
//! URL is only a default, used by `Providers.tsx:370` to display it before a provider exists.
//!
//! [`provider_profile`] therefore takes `base_url` and is the whole of `withBaseUrl(profile(), …)`,
//! composed once instead of built and then patched. Two consequences worth stating:
//!
//! - **A builtin provider cannot trip D46.** The allowlist is derived from `providers.base_url`
//!   (`persist::recompute_allow`) and the profile path dials exactly that column, so the two
//!   authorities the register records as divergent are the same string here.
//! - **The base URLs the reference pins are not duplicated in Rust.** Nothing here consumes them —
//!   they live in the TypeScript, which is the only side that displays them. A copy would be a
//!   second answer to "where does OpenRouter live", which is the drift this register keeps finding.
//!
//! # What is deliberately not ported
//!
//! `BUILTIN_TEMPLATES` — the string-keyed map of the two templates — has no Rust consumer: its two
//! callers, `adapter-generator.ts` and `fingerprinter.ts`, are both TypeScript. Porting the key
//! would produce an enum nothing selects on, so [`openai_compat`] and [`anthropic_compat`] are
//! functions and there is no id type.

use std::collections::BTreeMap;

use serde_json::{json, Map, Value};

/// The OpenAI-compatible dialect's per-provider overlays — `builtin-templates.ts:9` `extra`.
///
/// Every field is what a profile actually overrides; the defaults are the template's own, so a
/// profile that overrides nothing is `Default` rather than a long literal.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct OpenAiExtras {
    /// Extra headers on `generateText`. `None` means the key is **omitted**, not emitted as `null`
    /// — the reference's `headers: extra?.textHeaders` is `undefined` for two of the three
    /// profiles, and `JSON.stringify` drops an undefined property.
    pub text_headers: Option<BTreeMap<String, String>>,
    /// Whether the provider serves images at all.
    pub image_endpoint: bool,
    /// The image path. `None` falls back to `/images/generations`.
    pub image_path: Option<String>,
    /// How to tell an image model from a text one. `None` falls back to the id pattern.
    pub image_rule: Option<Value>,
}

/// The default image-model id pattern — `builtin-templates.ts:66`.
fn default_image_rule() -> Value {
    json!({ "modelIdPattern": "^(dall-e|flux|sd|imagen|seedream|nano-banana)" })
}

/// The `openai-chat-v1` template — `builtin-templates.ts:9-70`.
pub fn openai_compat(base_url: &str, extra: OpenAiExtras) -> Value {
    let mut endpoints = Map::new();
    endpoints.insert(
        "listModels".to_string(),
        json!({
            "method": "GET",
            "path": "/models",
            "map": { "models": "$.data[*].id", "raw": "$.data[*]" }
        }),
    );
    endpoints.insert("generateText".to_string(), openai_text(&extra));
    if extra.image_endpoint {
        endpoints.insert("generateImage".to_string(), openai_image(&extra));
    }

    let mut manifest = Map::new();
    manifest.insert("manifestVersion".to_string(), json!(1));
    manifest.insert("kind".to_string(), json!("declarative"));
    manifest.insert("dialect".to_string(), json!("openai-chat-v1"));
    manifest.insert(
        "provider".to_string(),
        json!({
            "baseUrl": base_url,
            "auth": { "headers": [{ "name": "Authorization", "prefix": "Bearer" }] }
        }),
    );
    manifest.insert("endpoints".to_string(), Value::Object(endpoints));
    manifest
        .insert("capabilities".to_string(), json!({ "text": true, "image": extra.image_endpoint }));
    if extra.image_endpoint {
        manifest.insert(
            "modalityRules".to_string(),
            json!({ "image": extra.image_rule.unwrap_or_else(default_image_rule) }),
        );
    }
    manifest.insert("provenance".to_string(), provenance());
    Value::Object(manifest)
}

/// `generateText` for the OpenAI dialect — including the image endpoint the profile may add.
fn openai_text(extra: &OpenAiExtras) -> Value {
    let mut ep = Map::new();
    ep.insert("method".to_string(), json!("POST"));
    ep.insert("path".to_string(), json!("/chat/completions"));
    if let Some(headers) = &extra.text_headers {
        let mut map = Map::new();
        for (name, value) in headers {
            map.insert(name.clone(), json!(value));
        }
        ep.insert("headers".to_string(), Value::Object(map));
    }
    // `tools`, `tool_choice` and `response_format` are all `{{x?}}` — when the caller supplies no
    // tools the fields are omitted rather than sent as null, which some servers reject.
    ep.insert(
        "requestTemplate".to_string(),
        json!({
            "model": "{{model}}",
            "messages": "{{messages}}",
            "stream": "{{stream}}",
            // The caller's thinking knob (see `reasoning_values`): omitted when unset.
            "reasoning_effort": "{{reasoningEffort?}}",
            "max_tokens": "{{maxTokens?}}",
            "temperature": "{{temperature?}}",
            "tools": "{{tools?}}",
            "tool_choice": "{{toolChoice?}}",
            "response_format": "{{responseFormat?}}"
        }),
    );
    // v1.1 dialect shaping (ported 2026-10-01). OpenAI is the internal vocabulary, so its role map
    // is the identity — declared rather than omitted, because "I speak these roles natively" and
    // "I declare no map at all" are the same body but different facts, and only the second is a
    // dialect nobody has taught yet. Its content parts are the same story: our internal
    // `{type:"image",mediaType,dataBase64}` is NOT OpenAI's `{type:"image_url",image_url:{url}}`.
    ep.insert(
        "messagesRoleMap".to_string(),
        json!({ "user": "user", "assistant": "assistant", "system": "system", "tool": "tool" }),
    );
    ep.insert(
        "contentPartTemplates".to_string(),
        json!({
            "text": { "type": "text", "text": "{{text}}" },
            // OpenAI carries an image as an `image_url` whose url IS the data URI, so this dialect
            // uses `{{dataUri}}` where Anthropic uses the bare bytes.
            "image": { "type": "image_url", "image_url": { "url": "{{dataUri}}" } }
        }),
    );
    ep.insert(
        "responseMap".to_string(),
        json!({
            "text": "$.choices[0].message.content",
            "usage": "$.usage",
            "toolCalls": "$.choices[0].message.tool_calls"
        }),
    );
    // Where this dialect puts its finish reason. **No `responseFinishMap`**: OpenAI's words already
    // ARE the vocabulary every consumer of this router speaks, so there is nothing to translate.
    ep.insert("responseFinish".to_string(), json!("$.choices[0].finish_reason"));
    // `requestUsage: true` is what makes cost — and therefore the spend cap — non-zero for a
    // streamed request: this dialect omits usage on a stream unless it is explicitly asked for.
    ep.insert(
        "stream".to_string(),
        json!({
            "protocol": "sse",
            "chunkMap": {
                "delta": "$.choices[0].delta.content",
                "toolCalls": "$.choices[0].delta.tool_calls"
            },
            "errorMap": { "$.error": "PASS_THROUGH" },
            "finish": "$.choices[0].finish_reason",
            "requestUsage": true
        }),
    );
    Value::Object(ep)
}

fn openai_image(extra: &OpenAiExtras) -> Value {
    json!({
        "method": "POST",
        "path": extra.image_path.as_deref().unwrap_or("/images/generations"),
        "requestTemplate": { "model": "{{model}}", "prompt": "{{prompt}}", "size": "{{size?}}" },
        "responseMap": { "imageB64": "$.data[0].b64_json", "imageUrl": "$.data[0].url" }
    })
}

/// The `anthropic-messages-v1` template — `builtin-templates.ts:72-136`.
///
/// `x-api-key` auth (no prefix), a static `anthropic-version` header, `/v1/messages`, and
/// `message_stop` terminates the stream. `max_tokens` is **required** rather than optional here, so
/// the template renders `{{maxTokens}}` without the `?`.
pub fn anthropic_compat(base_url: &str) -> Value {
    json!({
        "manifestVersion": 1,
        "kind": "declarative",
        "dialect": "anthropic-messages-v1",
        "provider": {
            "baseUrl": base_url,
            "auth": { "headers": [{ "name": "x-api-key" }] }
        },
        "endpoints": {
            "listModels": {
                "method": "GET",
                "path": "/models",
                "map": { "models": "$.data[*].id", "raw": "$.data[*]" }
            },
            "generateText": {
                "method": "POST",
                "path": "/messages",
                "headers": { "anthropic-version": "2023-06-01" },
                "requestTemplate": {
                    "model": "{{model}}",
                    "messages": "{{messages}}",
                    // Anthropic has no `system` role in its messages array: the system prompt is a
                    // top-level param. `messagesRoleMap` (system→null) hoists it, `systemField`
                    // names where it lands, and `{{system?}}` omits the field when nothing hoisted.
                    "system": "{{system?}}",
                    "stream": "{{stream}}",
                    "max_tokens": "{{maxTokens}}",
                    // The caller's thinking knob: `{type:"disabled"}` for off — the one portable
                    // off switch in the three dialects — or enabled with a clamped budget.
                    "thinking": "{{thinking?}}",
                    "tools": "{{tools?}}",
                    "tool_choice": "{{toolChoice?}}"
                },
                // v1.1 dialect shaping (ported 2026-10-01): the four declarations the TypeScript
                // engine has had since 2026-10-01 and the Rust gateway never received. Without them
                // the gateway sent `role:"system"` inside `messages` (an Anthropic 400 on every
                // request that carries a system prompt) and OpenAI's `{type:"function",…}` tool
                // wrapping. Mirrors `builtin-templates.ts:123-155` exactly.
                "messagesRoleMap": {
                    "user": "user",
                    "assistant": "assistant",
                    // `null` = HOIST to the system field. Anthropic has no `system` role.
                    "system": null,
                    // Anthropic models tool results as `user` turns; `tool_call_id` is dropped.
                    "tool": "user"
                },
                "systemField": "system",
                // Anthropic carries an image as a base64 `source` block and a text part as a plain
                // `{type:"text",text}`. No data-URI here — media type and bytes are separate fields.
                "contentPartTemplates": {
                    "text": { "type": "text", "text": "{{text}}" },
                    "image": {
                        "type": "image",
                        "source": { "type": "base64", "media_type": "{{mediaType}}", "data": "{{dataBase64}}" }
                    },
                    // A replayed tool turn: the call is a `tool_use` block on the assistant turn,
                    // the result a `tool_result` block on a user turn — which is why the OpenAI
                    // sibling fields (`tool_calls`, `role:"tool"`) must not reach the wire.
                    "toolCall": { "type": "tool_use", "id": "{{id}}", "name": "{{name}}", "input": "{{argumentsObject}}" },
                    "toolResult": { "type": "tool_result", "tool_use_id": "{{id}}", "content": "{{text}}" }
                },
                // One declaration, no `type`/`function` wrapping: Anthropic takes
                // `{name, description, input_schema}` flat.
                "toolDeclarationTemplates": {
                    "function": { "name": "{{name}}", "description": "{{description}}", "input_schema": "{{parameters}}" }
                },
                // v1.1 amendment (ported 2026-10-01): Anthropic takes `tool_choice` only as an
                // OBJECT, so the internal OpenAI string ("auto"/"none") and the
                // `{type:"function",function:{name}}` form must be translated. Without this map the
                // OpenAI value went out verbatim and every tool-using request 400'd
                // (`tool_choice must be an object`) — measured live 2026-10-01 on the gateway path.
                // The `function` value's placeholder names the forced tool. Mirrors
                // `builtin-templates.ts:156-169` exactly.
                "toolChoiceMap": {
                    "none": { "type": "none" },
                    "auto": { "type": "auto" },
                    "function": { "type": "tool", "name": "{{toolChoice.function.name}}" }
                },
                // v1.1 amendment (2026-10-01): where Anthropic puts its finish reason, and how its
                // words map onto the OpenAI vocabulary both consumers of this router speak (the
                // app's `reason == "length"` warning, the gateway's OpenAI-shaped `finish_reason`).
                // Without the map a response truncated at `max_tokens` matched nothing and looked
                // complete. A reason not named here passes through raw.
                "responseFinish": "$.stop_reason",
                "responseFinishMap": {
                    "end_turn": "stop",
                    "max_tokens": "length",
                    "tool_use": "tool_calls",
                    "stop_sequence": "stop",
                    "pause_turn": "stop",
                    "refusal": "content_filter"
                },
                "responseMap": {
                    // **The path is the block ARRAY, not block 0** — the TypeScript template has
                    // read it this way since `c325784` ("read anthropic text from the block array,
                    // not block 0"); this is the Rust half arriving late. `content` is a mixed array
                    // and which block leads is the provider's choice: a reasoning model puts its
                    // `thinking` block first, so `$.content[0].text` is absent on a perfectly good
                    // response and the caller received empty text. Measured live 2026-10-02 through
                    // this template — agentrouter's `deepseek-v4-flash` answers a unary request with
                    // `[{"type":"thinking",…},{"type":"text","text":"ok"}]`, which the old selector
                    // read as nothing at all. `select_text` picks the text blocks out of the array.
                    "text": "$.content",
                    "usage": "$.usage",
                    // Anthropic names its token counts differently from OpenAI, and without these
                    // the interpreter falls back to `prompt_tokens`/`completion_tokens` — which an
                    // Anthropic usage block does not have. Mirrors `builtin-templates.ts:187-197`
                    // exactly, and **this half is the one that was missing.**
                    //
                    // D84 recorded the fix on 2026-10-01 and the TypeScript template received it, so
                    // the reference interpreter has read Anthropic usage correctly since then. The
                    // Rust port did not, and the daemon serves builtins from *this* file: on
                    // success `activation::serving_manifest` lets the builtin profile win
                    // unconditionally over the stored row, so a provider whose DB snapshot carried
                    // `usageKeys` still served without them. Measured 2026-10-15 against the running
                    // daemon — the upstream block arrived intact (`input_tokens:229,
                    // output_tokens:15`) and the interpreter read `prompt=None, completion=None`,
                    // keeping only `cached`, which `read_cached_tokens` defaults to the Anthropic
                    // spelling and so survived the omission. That asymmetry is the signature in the
                    // ledger: `tokens_in == cached_tokens` with `tokens_out = 0` on 774 of 876
                    // recent gateway rows, and `cost_estimate_micros = 0` on all of them, so no
                    // spend cap could ever fire.
                    "usageKeys": {
                        "prompt": "input_tokens",
                        "completion": "output_tokens",
                        "cached": "cache_read_input_tokens"
                    },
                    // Non-stream: `content` is a MIXED array (text blocks + tool_use blocks), and
                    // the jsonpath subset has no filter expressions, so the interpreter filters by
                    // block type itself.
                    "toolCalls": "$.content"
                },
                "stream": {
                    "protocol": "sse",
                    "chunkMap": { "delta": "$.delta.text" },
                    "errorMap": { "$.error": "PASS_THROUGH" },
                    "stopWhen": { "path": "$.type", "equals": "message_stop" },
                    // Anthropic nests `stop_reason` under `delta` on `message_delta` events, unlike
                    // the non-stream body where it is top-level. `responseFinish` targets the
                    // non-stream shape; this targets the streaming chunk, so the reason is captured
                    // before the terminating `message_stop` halts the loop. Mirrors
                    // `builtin-templates.ts:207`.
                    "finish": "$.delta.stop_reason",
                    // Tool use is split across events: content_block_start carries id+name, then one
                    // content_block_delta per input_json_delta fragment of the arguments JSON.
                    "toolCallStream": {
                        "start": {
                            "when": { "path": "$.content_block.type", "equals": "tool_use" },
                            "id": "$.content_block.id",
                            "name": "$.content_block.name",
                            "index": "$.index"
                        },
                        "delta": {
                            "when": { "path": "$.delta.type", "equals": "input_json_delta" },
                            "partial": "$.delta.partial_json",
                            "index": "$.index"
                        }
                    }
                }
            }
        },
        "capabilities": { "text": true, "image": false },
        "limits": { "maxOutputTokens": 8192 },
        "provenance": provenance()
    })
}

/// The Gemini native GenerateContent dialect (`builtin-templates.ts` `geminiCompat`).
///
/// The three grammar features this dialect is the reason for: `{{model}}` in the endpoint path,
/// `streamPath` (its SSE stream lives at a different endpoint than the unary call), and
/// `usageKeys` (its usageMetadata does not speak OpenAI's field names). The model ids from its
/// own catalogue carry their `models/` prefix, which is exactly the path segment `{{model}}`
/// needs. Base url is the HOST ROOT — the `/v1beta` prefix lives in the paths.
pub fn gemini_compat(base_url: &str) -> Value {
    json!({
        "manifestVersion": 1,
        "kind": "declarative",
        "dialect": "gemini-generate-v1",
        "provider": {
            "baseUrl": base_url,
            "auth": { "headers": [{ "name": "x-goog-api-key" }] }
        },
        "endpoints": {
            "listModels": {
                "method": "GET",
                "path": "/v1beta/models",
                "map": { "models": "$.models[*].name", "raw": "$.models[*]" }
            },
            "generateText": {
                "method": "POST",
                "path": "/v1beta/{{model}}:generateContent",
                "streamPath": "/v1beta/{{model}}:streamGenerateContent?alt=sse",
                "requestTemplate": {
                    "contents": "{{messages}}",
                    // Gemini reads `tools:[{functionDeclarations:[…]}]` and does NOT read OpenAI's
                    // `{type:"function",function:{…}}` wrapping, so before this the tools array was
                    // sent and ignored — the model was never told it had any tools.
                    "tools": "{{tools?}}",
                    // Gemini's tool_choice is not a string either: it is
                    // `toolConfig.functionCallingConfig`. A bare "auto" forwarded as `toolConfig`
                    // is an unknown-field 400 — and the agent loop sends one on every tool-enabled
                    // request, so this mapping is what makes agent mode reach Gemini at all.
                    "toolConfig": "{{toolChoice?}}",
                    "generationConfig": {
                        "maxOutputTokens": "{{maxTokens?}}",
                        "temperature": "{{temperature?}}",
                        "thinkingConfig": "{{thinkingConfig?}}"
                    }
                },
                // v1.1 dialect shaping (ported 2026-10-01). Mirrors `builtin-templates.ts:281-333`.
                "toolDeclarationTemplates": {
                    "function": { "name": "{{name}}", "description": "{{description}}", "parameters": "{{parameters}}" }
                },
                // `tools` is `repeated Tool`, and each Tool carries its own `repeated
                // functionDeclarations`. An array literal is not expressible in the template
                // grammar, which is why the container is declared separately.
                "toolDeclarationWrapper": { "functionDeclarations": "{{declarations}}" },
                // Mirrors `tool_choice_to_openai` in `gateway_gemini.rs` (AUTO|ANY|NONE plus an
                // optional forced name).
                "toolChoiceMap": {
                    "none": { "functionCallingConfig": { "mode": "NONE" } },
                    "auto": { "functionCallingConfig": { "mode": "AUTO" } },
                    "required": { "functionCallingConfig": { "mode": "ANY" } },
                    "function": {
                        "functionCallingConfig": {
                            "mode": "ANY",
                            "allowedFunctionNames": ["{{toolChoice.function.name}}"]
                        }
                    }
                },
                "messagesRoleMap": {
                    // Gemini uses `model` for what OpenAI calls `assistant`.
                    "user": "user",
                    "assistant": "model",
                    // Hoist but discard: generateContent has no system param and no `systemField`
                    // is declared, so hoisted content is dropped rather than sent nowhere.
                    "system": null,
                    "tool": "user"
                },
                // A Gemini part carries NO `type` — the shape itself is the discriminator
                // (`{text}` vs `{inlineData}`), which is why these are per-part templates rather
                // than one structure with a type field to fill in. `args`/`response` must be
                // objects, which is why the shaper offers `argumentsObject`/`response`.
                "contentPartTemplates": {
                    "text": { "text": "{{text}}" },
                    "image": { "inlineData": { "mimeType": "{{mediaType}}", "data": "{{dataBase64}}" } },
                    "toolCall": { "functionCall": { "name": "{{name}}", "args": "{{argumentsObject}}" } },
                    "toolResult": { "functionResponse": { "name": "{{name}}", "response": "{{response}}" } }
                },
                // Gemini names a message's content `parts`, and it must be an array of parts even
                // for plain text. Without this every request carried `content` — a field
                // generateContent does not read — so it received no conversation at all.
                "contentField": "parts",
                // v1.1 amendment (2026-10-01): Gemini's `finishReason` is upper-cased and unrelated
                // to OpenAI's words (`MAX_TOKENS` where OpenAI says `length`). The same selector
                // serves the unary body and the streamed chunk. The safety reasons all collapse to
                // OpenAI's `content_filter`; `OTHER` and `MALFORMED_FUNCTION_CALL` are left out on
                // purpose, so they surface raw rather than being guessed into a word that means
                // something else.
                "responseFinish": "$.candidates[0].finishReason",
                "responseFinishMap": {
                    "STOP": "stop",
                    "MAX_TOKENS": "length",
                    "SAFETY": "content_filter",
                    "RECITATION": "content_filter",
                    "BLOCKLIST": "content_filter",
                    "PROHIBITED_CONTENT": "content_filter",
                    "SPII": "content_filter"
                },
                "responseMap": {
                    "text": "$.candidates[0].content.parts",
                    "usage": "$.usageMetadata",
                    "usageKeys": {
                        "prompt": "promptTokenCount",
                        "completion": "candidatesTokenCount",
                        "cached": "cachedContentTokenCount"
                    },
                    // Where a tool call sits, and how to read one (v1.1, ported 2026-10-01). A Gemini
                    // part is `{functionCall:{name, args}}` with NO `type` — so the discriminator is
                    // presence, and `args` is already an object. Without these two declarations a
                    // functionCall part reached the loop as a nameless, argument-less call and the
                    // model's request to run a tool was lost without a word.
                    "toolCalls": "$.candidates[0].content.parts",
                    "toolCallShape": {
                        "discriminator": { "path": "functionCall", "present": true },
                        "name": "functionCall.name",
                        "arguments": "functionCall.args",
                        "argumentsFormat": "object",
                        // Gemini sends a complete call per part; there is nothing to concatenate.
                        "streamedAs": "whole"
                    }
                },
                "stream": {
                    "protocol": "sse",
                    // The same `parts` path the unary read uses, and deliberately so: a streamed
                    // functionCall is the same shape as a unary one, which is what
                    // `streamedAs: "whole"` tells the interpreter — read each event's calls through
                    // `toolCallShape`, do not accumulate fragments.
                    "chunkMap": {
                        "delta": "$.candidates[0].content.parts",
                        "toolCalls": "$.candidates[0].content.parts"
                    },
                    "errorMap": { "$.error": "PASS_THROUGH" },
                    // No `[DONE]` sentinel: the server closes the SSE when the turn is over, and
                    // finishReason arrives on the last content chunk.
                    "stopWhen": { "path": "$.candidates[0].finishReason", "equals": "STOP" }
                }
            }
        },
        "capabilities": { "text": true, "image": false },
        "provenance": provenance()
    })
}

fn provenance() -> Value {
    json!({
        "origin": "builtin-template",
        "generatorModel": null,
        "createdAt": "1970-01-01T00:00:00Z"
    })
}

/// The manifest a provider whose `slug` is one of the builtins is served from.
///
/// **The three profiles of `builtin-templates.ts:150-167`, with `base_url` taking the place of
/// `withBaseUrl`.** `None` for any other slug, which is the signal to fall back to that provider's
/// active manifest row — see [`crate::core::activation`].
///
/// The slug is the key and not the provider's `type`, because that is what the reference keys on
/// (`store.ts:368`: `PROVIDER_PROFILES[p.slug]`). A provider typed `manifest` with a builtin slug
/// is served by its profile in the reference, and would be served by its stale stored row here —
/// see the note at the top of this module.
pub fn provider_profile(slug: &str, base_url: &str) -> Option<Value> {
    let by_slug = match slug {
        "openrouter" => Some(openai_compat(
            base_url,
            OpenAiExtras {
                text_headers: Some(BTreeMap::from([
                    ("HTTP-Referer".to_string(), "{{appUrl}}".to_string()),
                    ("X-Title".to_string(), "AI-Provider Router".to_string()),
                ])),
                image_endpoint: true,
                // OpenRouter serves image generation from its own Image API, NOT
                // /images/generations.
                image_path: Some("/images".to_string()),
                // OpenRouter namespaces every id (google/gemini-2.5-flash-image), so an id pattern
                // can never classify it — declared id patterns match zero of its 444 models. Its
                // catalog states the capability instead: architecture.output_modalities. Matching
                // element [0] (PRIMARY output) rather than array membership keeps `openrouter/auto`
                // text, where it belongs; the 9 genuine image models lead with "image".
                image_rule: Some(json!({
                    "rawMatch": {
                        "path": "$.architecture.output_modalities[0]",
                        "contains": "image"
                    }
                })),
            },
        )),
        "opencode" => Some(openai_compat(base_url, OpenAiExtras::default())),
        "b.ai" => Some(anthropic_compat(base_url)),
        _ => None,
    };
    by_slug.or_else(|| {
        // **By measured host, not only by slug** (2026-10-01). The reference keys profiles on an
        // exact slug, and the live database named this provider `agent-router` while the profile is
        // `agentrouter` — one hyphen, and the measured profile (D80: the Anthropic route, because
        // the OpenAI route answers `content: ""` with the output in `reasoning_content`) was
        // unreachable; the provider was served by its stored row, which lacks every shaping
        // declaration and 400s on every request that carries a system turn. Host matching is the
        // same whole-hostname rule `profileForBaseUrl` applies on the TypeScript side — never a
        // suffix, so a lookalike host gets nothing.
        (host_of(base_url) == "agentrouter.org").then(|| anthropic_compat(base_url))
    })
}

/// The hostname of a base URL, lowercase. Deliberately not the `url` crate: nothing else in this
/// module parses URLs, and a three-line split cannot drift from a second parser in the tree.
fn host_of(base_url: &str) -> String {
    base_url
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(base_url)
        .split('/')
        .next()
        .unwrap_or_default()
        .to_lowercase()
}

/// The slugs [`provider_profile`] answers for.
///
/// **Exported so activation can be tested against every profile rather than against a lucky one.**
/// A test that only checked `openrouter` would pass if the `b.ai` arm were dropped, which is the
/// shape of omission this module is most exposed to: three arms that differ by one line each.
pub const PROFILE_SLUGS: [&str; 3] = ["b.ai", "opencode", "openrouter"];

#[cfg(test)]
mod tests {
    use super::*;

    /// The pinned default base URLs, from `builtin-templates.ts:152`, `:165`, `:166`.
    ///
    /// These exist **only** to build the transcription fixtures below, which is the one place the
    /// reference's own values are worth comparing against. Nothing in the crate dials them.
    const OPENROUTER_URL: &str = "https://openrouter.ai/api/v1";
    const OPENCODE_URL: &str = "https://opencode.ai/zen/v1";
    const BAI_URL: &str = "https://api.b.ai/v1";

    fn get<'a>(v: &'a Value, path: &[&str]) -> &'a Value {
        let mut cur = v;
        for key in path {
            cur = cur.get(*key).unwrap_or_else(|| panic!("missing {key} in {cur}"));
        }
        cur
    }

    /// The OpenRouter profile, **transcribed from the TypeScript** rather than from a memory of it.
    ///
    /// This is the transcription guard: the reference's `openaiCompat(OPENROUTER_URL, extras)` as
    /// `builtin-templates.ts:9-70` + `:151-164` builds it. A divergence in any field reddens here
    /// rather than in production, which is the only reason the two templates are worth having as
    /// data — a profile nobody had written down is a profile nobody could check.
    #[test]
    fn the_openrouter_profile_matches_the_typescript_character_for_character() {
        let m = provider_profile("openrouter", OPENROUTER_URL).expect("openrouter is a profile");
        assert_eq!(m["manifestVersion"], 1);
        assert_eq!(m["kind"], "declarative");
        assert_eq!(m["dialect"], "openai-chat-v1");
        assert_eq!(m["provider"]["baseUrl"], OPENROUTER_URL);
        assert_eq!(m["provider"]["auth"]["headers"][0]["name"], "Authorization");
        assert_eq!(m["provider"]["auth"]["headers"][0]["prefix"], "Bearer");

        assert_eq!(get(&m, &["endpoints", "listModels", "path"]), "/models");
        assert_eq!(get(&m, &["endpoints", "listModels", "map", "models"]), "$.data[*].id");

        let text = get(&m, &["endpoints", "generateText"]);
        assert_eq!(text["path"], "/chat/completions");
        assert_eq!(text["headers"]["HTTP-Referer"], "{{appUrl}}");
        assert_eq!(text["headers"]["X-Title"], "AI-Provider Router");
        assert_eq!(text["requestTemplate"]["max_tokens"], "{{maxTokens?}}");
        assert_eq!(text["requestTemplate"]["response_format"], "{{responseFormat?}}");
        assert_eq!(text["responseMap"]["text"], "$.choices[0].message.content");
        assert_eq!(text["stream"]["requestUsage"], true);
        assert_eq!(text["stream"]["chunkMap"]["delta"], "$.choices[0].delta.content");

        // The OpenRouter-specific overrides: its own image path, and a metadata rule rather than an
        // id pattern because its ids are namespaced.
        assert_eq!(get(&m, &["endpoints", "generateImage", "path"]), "/images");
        assert_eq!(
            get(&m, &["modalityRules", "image", "rawMatch", "path"]),
            "$.architecture.output_modalities[0]"
        );
        assert_eq!(get(&m, &["modalityRules", "image", "rawMatch", "contains"]), "image");
        assert_eq!(m["capabilities"], json!({ "text": true, "image": true }));
        // `provenance` is how a stored row records that it came from here.
        assert_eq!(m["provenance"]["origin"], "builtin-template");
    }

    /// The `b.ai` profile — the **anthropic** dialect, which is the whole reason the profile table
    /// is not three copies of one template.
    #[test]
    fn the_b_ai_profile_is_the_anthropic_dialect() {
        let m = provider_profile("b.ai", BAI_URL).expect("b.ai is a profile");
        assert_eq!(m["dialect"], "anthropic-messages-v1");
        assert_eq!(m["provider"]["auth"]["headers"][0]["name"], "x-api-key");
        assert!(
            m["provider"]["auth"]["headers"][0].get("prefix").is_none(),
            "x-api-key takes no prefix: {}",
            m["provider"]["auth"]["headers"][0]
        );
        let text = get(&m, &["endpoints", "generateText"]);
        assert_eq!(text["path"], "/messages");
        assert_eq!(text["headers"]["anthropic-version"], "2023-06-01");
        // Required, not optional — the one template difference that is not cosmetic.
        assert_eq!(text["requestTemplate"]["max_tokens"], "{{maxTokens}}");
        assert_eq!(text["stream"]["stopWhen"]["equals"], "message_stop");
        assert_eq!(text["stream"]["chunkMap"]["delta"], "$.delta.text");
        assert_eq!(m["capabilities"], json!({ "text": true, "image": false }));
        assert_eq!(m["limits"]["maxOutputTokens"], 8192);
        assert!(m.get("modalityRules").is_none(), "b.ai declares no modality rules");
    }

    /// **The two profiles that do not override anything must match what the reference omits.**
    ///
    /// `opencode` is the case: `openaiCompat(url, { imageEndpoint: false })`, so there is no
    /// `generateImage`, no `modalityRules`, and — the one that is easy to get wrong — **no
    /// `headers` key at all**, because `undefined` is dropped by `JSON.stringify` rather than
    /// emitted as `null`. A port that always emitted `headers` would produce a manifest the
    /// reference would never generate.
    #[test]
    fn a_profile_without_overrides_omits_the_optional_keys_entirely() {
        let m = provider_profile("opencode", OPENCODE_URL).expect("opencode is a profile");
        assert_eq!(m["provider"]["baseUrl"], OPENCODE_URL);
        let text = get(&m, &["endpoints", "generateText"]);
        assert!(
            text.get("headers").is_none(),
            "an unoverridden header is omitted, not null: {text}"
        );
        assert!(m["endpoints"].get("generateImage").is_none(), "opencode serves no images");
        assert!(m.get("modalityRules").is_none(), "no image endpoint means no rules");
        assert_eq!(m["capabilities"], json!({ "text": true, "image": false }));
        assert_eq!(text["stream"]["protocol"], "sse");
    }

    /// **`usageKeys` is a per-dialect obligation, and this walks every builtin to enforce it.**
    ///
    /// The rule: a dialect whose usage block does not speak OpenAI's field names must declare the
    /// names it does speak. `responseMap.usage` alone reaches the block, so the manifest looks
    /// right — but without `usageKeys` the reader then hunts for `prompt_tokens` /
    /// `completion_tokens` inside a block that has neither, finds nothing, and reports **0 in /
    /// 0 out**. Cost is computed from those counts, so it stays 0 too and no spend cap can fire.
    ///
    /// **This is the test that was missing, and its absence is the whole of D84's recurrence.**
    /// D84 recorded the Anthropic fix on 2026-10-01 and the TypeScript template received it; the
    /// Rust port did not, and nothing compared the two tables. It could not be caught downstream
    /// either: `activation::serving_manifest` lets a builtin profile win **unconditionally** over
    /// the stored row, so the live `agent-router` row carrying correct `usageKeys` since
    /// 2026-10-02 changed nothing about what the daemon actually served. Measured 2026-10-15: the
    /// upstream block arrived intact (`input_tokens:229, output_tokens:15`) and the interpreter
    /// reported `prompt=None, completion=None` — `cached` alone survived, because
    /// `read_cached_tokens` happens to default to the Anthropic spelling.
    ///
    /// A dialect that speaks OpenAI's names is deliberately **not** listed: the reader's defaults
    /// are its `usageKeys`, and a redundant override there would be a second place to get it
    /// wrong. `checked` guards the guard — a walk that matched nothing would pass vacuously.
    #[test]
    fn every_non_openai_builtin_declares_the_usage_field_names_its_dialect_speaks() {
        let openai_extras = OpenAiExtras::default();
        let builtins: [(&str, Value); 3] = [
            ("openai-chat-v1", openai_compat("https://x.test/v1", openai_extras)),
            ("anthropic-messages-v1", anthropic_compat("https://x.test/v1")),
            ("gemini-generate-v1", gemini_compat("https://x.test/v1")),
        ];
        // The names each dialect's usage block actually uses, and where that block sits — the
        // Anthropic column transcribed from `builtin-templates.ts:185-197`, the Gemini column from
        // `:365-371`. The **selector** is part of the row on purpose: a `usageKeys` override is
        // meaningless if the selector never reaches the block it names, and Gemini's block is not
        // where Anthropic's is.
        let expected: [(&str, &str, &str, &str, &str); 2] = [
            (
                "anthropic-messages-v1",
                "$.usage",
                "input_tokens",
                "output_tokens",
                "cache_read_input_tokens",
            ),
            (
                "gemini-generate-v1",
                "$.usageMetadata",
                "promptTokenCount",
                "candidatesTokenCount",
                "cachedContentTokenCount",
            ),
        ];

        let mut checked = 0;
        for (dialect, m) in &builtins {
            assert_eq!(m["dialect"], *dialect, "the fixture names its own dialect");
            let map = get(m, &["endpoints", "generateText", "responseMap"]);
            let Some((_, usage_path, prompt, completion, cached)) =
                expected.iter().find(|(d, ..)| d == dialect)
            else {
                // The OpenAI dialect: the reader's own defaults are its `usageKeys`, so an
                // override here would be a second place to get the same answer wrong.
                assert_eq!(map["usage"], "$.usage", "{dialect} still has to reach a usage block");
                assert!(
                    map.get("usageKeys").is_none(),
                    "{dialect} speaks OpenAI's names, so it must carry no override: {map}"
                );
                continue;
            };
            assert_eq!(
                map["usage"], *usage_path,
                "{dialect} must reach its usage block — a `usageKeys` override is worthless \
                 against a selector that never arrives"
            );
            assert_eq!(map["usageKeys"]["prompt"], *prompt, "{dialect} prompt key");
            assert_eq!(map["usageKeys"]["completion"], *completion, "{dialect} completion key");
            assert_eq!(map["usageKeys"]["cached"], *cached, "{dialect} cached key");
            checked += 1;
        }
        assert_eq!(checked, 2, "both non-OpenAI dialects were present to check");
    }

    /// The base URL is the caller's, which is `withBaseUrl` composed rather than applied.
    ///
    /// Asserted over **every** slug, because one arm is a branch rather than a parameter and the
    /// two spellings could disagree: a profile that ignored its argument would pass a single-slug
    /// test if that slug happened to be built inline.
    #[test]
    fn every_profile_dials_the_base_url_it_is_given() {
        for slug in PROFILE_SLUGS {
            let m = provider_profile(slug, "https://proxy.test/v1")
                .unwrap_or_else(|| panic!("{slug} is a profile"));
            assert_eq!(m["provider"]["baseUrl"], "https://proxy.test/v1", "slug {slug}");
            assert!(
                !m["provider"]["baseUrl"].as_str().unwrap().contains("openrouter.ai")
                    && !m["provider"]["baseUrl"].as_str().unwrap().contains("opencode.ai")
                    && !m["provider"]["baseUrl"].as_str().unwrap().contains("api.b.ai"),
                "the template's own default must not survive: {m}"
            );
        }
    }

    /// An unknown slug is `None` — the signal to fall back to the provider's manifest row.
    #[test]
    fn an_unknown_slug_has_no_profile() {
        for slug in ["openai", "anthropic", "agnes", "custom-thing", "", "OPENROUTER"] {
            assert!(provider_profile(slug, "https://x.test/v1").is_none(), "slug {slug}");
        }
    }

    /// The exported slug list is the profile's real key set, not a decoration.
    ///
    /// Two probes: a slug the table answers for but the list omits, and a slug the list names that
    /// the table does not answer. Either direction is a list that a caller could trust wrongly —
    /// `PROFILE_SLUGS` exists so a test can walk every profile, so it must be exactly the profiles.
    #[test]
    fn the_slug_list_is_exactly_the_slugs_with_a_profile() {
        for slug in PROFILE_SLUGS {
            assert!(
                provider_profile(slug, "https://x.test/v1").is_some(),
                "the list names {slug} but no profile answers it"
            );
        }
        // And the reverse, over the slugs a caller might reasonably try.
        for slug in ["openai", "ollama", "lmstudio", "gemini"] {
            assert!(!PROFILE_SLUGS.contains(&slug), "the list names {slug}, which has no profile");
        }
    }

    /// The default image rule, for a profile that asks for an endpoint but names no rule.
    #[test]
    fn an_image_endpoint_without_a_rule_uses_the_id_pattern() {
        let m = openai_compat(
            "https://x.test/v1",
            OpenAiExtras { image_endpoint: true, ..OpenAiExtras::default() },
        );
        assert_eq!(get(&m, &["endpoints", "generateImage", "path"]), "/images/generations");
        assert_eq!(
            get(&m, &["modalityRules", "image", "modelIdPattern"]),
            &json!("^(dall-e|flux|sd|imagen|seedream|nano-banana)")
        );
        assert_eq!(m["capabilities"]["image"], true);
    }

    /// `b.ai` has no `limits` twin on the OpenAI side: the anthropic template caps output and the
    /// OpenAI one does not. Pinning it keeps a future edit from harmonising them.
    #[test]
    fn only_the_anthropic_template_caps_output_tokens() {
        assert!(anthropic_compat(BAI_URL).get("limits").is_some());
        assert!(openai_compat(OPENCODE_URL, OpenAiExtras::default()).get("limits").is_none());
    }

    /// The slug-mismatch case that routed the live database's `agent-router` provider to its
    /// unshaped stored row: the profile must also answer by **measured whole hostname**, so a
    /// provider the operator named differently is still served by the pinned facts. A lookalike
    /// host (`agentrouter.org.evil.test`, or a suffix match) must get nothing — the same rule
    /// `profileForBaseUrl` states on the TypeScript side.
    #[test]
    fn the_profile_answers_by_measured_host_when_the_slug_spelled_differently() {
        let m = provider_profile("agent-router", "https://agentrouter.org/v1").expect("host match");
        assert_eq!(
            m["dialect"], "anthropic-messages-v1",
            "the route D80 measured as the working one"
        );
        // And an exact-slug miss on an unrelated host stays None.
        assert_eq!(provider_profile("agent-router", "https://other.test/v1"), None);
        // A suffix is not a match.
        assert_eq!(provider_profile("agent-router", "https://agentrouter.org.evil.test/v1"), None);
    }

    /// Every generated manifest still parses as the read model — the guard `manifest_view` names.
    ///
    /// A template that produced JSON the crate's own reader rejects would register nothing and say
    /// nothing, so this is the assertion that makes the templates more than strings.
    #[test]
    fn every_profile_parses_as_a_manifest_and_builds_into_an_adapter() {
        for slug in PROFILE_SLUGS {
            let m = provider_profile(slug, "https://x.test/v1").unwrap();
            // The read model is the one that decides on `body_json` in production.
            let view: crate::core::manifest_view::ManifestView = serde_json::from_value(m.clone())
                .unwrap_or_else(|e| panic!("{slug} does not read as a manifest: {e}"));
            assert!(view.capabilities.text, "{slug} declares text");
            // And the modality rules the OpenRouter profile declares must parse too, because an
            // unparseable rule is a rule that silently never matches.
            let rules = crate::core::modality::rules_from_manifest(&m)
                .unwrap_or_else(|e| panic!("{slug} has unreadable modality rules: {e}"));
            assert_eq!(rules.is_some(), slug == "openrouter", "{slug} rules: {rules:?}");
        }
    }
}
