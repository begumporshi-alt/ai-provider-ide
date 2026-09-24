//! The interpreter's typed view of a manifest — what it reads, and nothing else.
//!
//! # This is a read model, not the grammar
//!
//! The grammar is `adapter-spec/src/manifest.ts` (193 lines of zod) and it does four things this
//! file does not: it **validates** (a manifest that fails is rejected before it is stored), it
//! applies **defaults** (`kind` defaults to `"declarative"`, `pagination.style` to `"none"`), it
//! enforces **cross-field rules** (`superRefine`: `kind: "code"` requires a code body; a
//! declarative manifest requires `listModels` and `generateText`), and it is the **gate** an
//! AI-generated manifest passes through before a human ever sees it (`manifest.ts:6-8`).
//!
//! None of that belongs here. The interpreter receives a manifest that has already been through
//! that gate — from the `manifests` table, written by the onboarding path — and its job is to read
//! fields, not to judge them. A validator on this side would be a second gate, and a second gate is
//! a second answer to "is this manifest usable", which is the defect class this port keeps finding.
//!
//! **Unknown fields are ignored, and here that is correct rather than sloppy.** A stored manifest
//! is a *superset* of what the interpreter reads: it also carries `manifestVersion`, `kind`,
//! `provenance`, and often `modalityRules`. The repository's rule for a nested payload crossing a
//! boundary is `deny_unknown_fields`, because an ignored key is a silently dropped fact. This is
//! the opposite situation: the ignored keys are ignored *by design*, they are read elsewhere (the
//! planner reads `modalityRules`; the runtime reads `kind`), and a `deny_unknown_fields` here would
//! reject every manifest on disk. The difference is that a boundary payload is *produced* for its
//! reader, and this is a projection *taken from* a shared record.
//!
//! # Drift, and what guards it
//!
//! A field the interpreter reads must appear here, and a field that appears here must be read.
//! Neither direction is enforced by the compiler, so the guard is the test that parses the exact
//! JSON of both builtin templates: if a template starts carrying something the interpreter needs
//! and this model drops, that test is where it shows up. What the test cannot catch is a *new*
//! grammar field the interpreter ought to read — no test can see a field that does not exist yet,
//! which is the same limit `core::usage`'s exhaustive literal exists to work around. The honest
//! statement is that this file is a projection and must be updated by whoever adds the reading.

use std::collections::BTreeMap;

use serde::Deserialize;
use serde_json::{Map, Value};

use crate::core::manifest::AuthHeader;

/// The manifest fields the interpreter reads.
///
/// **`kind` is not here.** `adapter-runtime.ts:52-58` branches on it to choose between this
/// interpreter and the QuickJS sandbox, and that branch belongs to the runtime — by the time an
/// interpreter exists, the question has been answered. Reading it here would give the interpreter
/// an opinion about a decision already made.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestView {
    /// Which dialect this manifest speaks. Read for exactly one decision: whether a stream must
    /// ask the provider for a usage block (see `interpreter::wants_usage`).
    pub dialect: String,
    pub provider: Provider,
    pub endpoints: Endpoints,
    pub capabilities: Capabilities,
    #[serde(default)]
    pub limits: Option<Limits>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    pub base_url: String,
    pub auth: Auth,
}

/// The auth headers, in the manifest's order.
///
/// Order is preserved because the interpreter's [`crate::core::manifest::auth_headers`] applies
/// "a later duplicate name wins", which is `Object.fromEntries`'s behaviour and needs the order to
/// mean something. A `BTreeMap` here would sort the headers and silently change which duplicate
/// survives.
#[derive(Debug, Clone, Deserialize)]
pub struct Auth {
    pub headers: Vec<AuthHeader>,
}

/// The three endpoints a declarative manifest may declare.
///
/// All three are optional *in this model* even though the grammar requires two of them for
/// `kind: "declarative"` — because the requirement is the grammar's, already enforced, and a
/// `Option` here is how the interpreter expresses "this provider has no image path", which is a
/// normal state rather than a defect.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Endpoints {
    #[serde(default)]
    pub list_models: Option<ListModelsEndpoint>,
    #[serde(default)]
    pub generate_text: Option<TextEndpoint>,
    #[serde(default)]
    pub generate_image: Option<ImageEndpoint>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ListModelsEndpoint {
    pub path: String,
    pub map: ModelMap,
}

/// Where the model list and the raw model objects sit in the catalogue response.
#[derive(Debug, Clone, Deserialize)]
pub struct ModelMap {
    pub models: String,
    /// v1.1: the raw model objects, index-aligned with `models`. Absent for a manifest written
    /// before the amendment, which is why the interpreter falls back to the id item itself.
    #[serde(default)]
    pub raw: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextEndpoint {
    pub path: String,
    /// Per-endpoint static request headers (v1.1). Defaulted to empty rather than `Option`:
    /// `renderHeaders` returns `{}` for `undefined` and for `{}` alike, so the two inputs are the
    /// same input and two spellings of one state would be a distinction with no reader.
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    pub request_template: Map<String, Value>,
    pub response_map: ResponseMap,
    #[serde(default)]
    pub stream: Option<StreamSpec>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseMap {
    pub text: String,
    /// Where the usage block sits. **Its presence is load-bearing twice**: it is where
    /// `read_cached_tokens` is pointed, and for an `openai-chat-v1` manifest it is half the default
    /// for "ask the provider for usage on a stream" — without it, every streamed request reports
    /// zero tokens and the spend cap can never bite.
    #[serde(default)]
    pub usage: Option<String>,
    /// Where a real tool call sits in a **non-stream** response. Absent means this dialect never
    /// reports them, which is the pre-amendment behaviour.
    #[serde(default)]
    pub tool_calls: Option<String>,
}

/// The SSE shape (v1.1).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamSpec {
    pub chunk_map: ChunkMap,
    /// Selector → `"PASS_THROUGH"`.
    ///
    /// **The values are never read.** The interpreter iterates `Object.keys(errorMap)` and throws
    /// on the first path that selects something (`manifest-interpreter.ts:357-362`); the declared
    /// `z.string()` value is dead weight the grammar carries. Typed as `Value` here for that
    /// reason: being strict about a field nothing reads would refuse a manifest the source accepts.
    ///
    /// **Order is sorted, not the manifest's.** The source walks a JavaScript object, which for
    /// string keys iterates in insertion order; a `BTreeMap` iterates by key. The two agree
    /// whenever at most one path matches — which is every case on disk, since each builtin template
    /// declares the single key `"$.error"` — and the divergence is recorded rather than assumed
    /// away.
    #[serde(default)]
    pub error_map: BTreeMap<String, Value>,
    #[serde(default)]
    pub finish: Option<String>,
    /// Events that end the stream, e.g. Anthropic's `message_stop`.
    #[serde(default)]
    pub stop_when: Option<Condition>,
    /// Multi-event tool-call framing (Anthropic): a start event declares the call, then one delta
    /// event per argument fragment.
    #[serde(default)]
    pub tool_call_stream: Option<ToolCallStream>,
    /// Ask the provider for a usage block on the stream. `None` is not `false` — see
    /// `interpreter::wants_usage`, where the difference decides whether an
    /// `openai-chat-v1` manifest gets the dialect's default.
    #[serde(default)]
    pub request_usage: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChunkMap {
    pub delta: String,
    /// Where streaming tool-call fragments sit (OpenAI: `delta.tool_calls`).
    #[serde(default)]
    pub tool_calls: Option<String>,
}

/// `selectOne(json, path) === equals`.
///
/// `equals` is a `Value` because the grammar admits a string, a number, a boolean or `null`
/// (`manifest.ts:49`), and the source compares with `===` — strict equality, so `1` never matches
/// `"1"`. Structural comparison on `Value` preserves that: a number and a string are different
/// values, and comparing them is false without anyone having to write the rule down.
#[derive(Debug, Clone, Deserialize)]
pub struct Condition {
    pub path: String,
    pub equals: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallStream {
    pub start: StartEvent,
    pub delta: DeltaEvent,
}

/// The event that declares a tool call. `id`, `name` and `index` are each optional because a
/// dialect with one call per event may omit the index and still name the call.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartEvent {
    pub when: Condition,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub index: Option<String>,
}

/// The event that carries an argument fragment.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeltaEvent {
    pub when: Condition,
    pub partial: String,
    #[serde(default)]
    pub index: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageEndpoint {
    pub path: String,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    pub request_template: Map<String, Value>,
    pub response_map: ImageResponseMap,
}

/// Where the generated image sits. Both are optional and **at least one is expected but neither is
/// required**: a provider may answer with a URL, with inline base64, or — in the degenerate case —
/// with neither, and the interpreter reports what it found rather than insisting.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageResponseMap {
    #[serde(default)]
    pub image_b64: Option<String>,
    #[serde(default)]
    pub image_url: Option<String>,
}

/// What a manifest says about a provider's capabilities.
///
/// **A declaration, not a measurement.** It is what the manifest's author asserted; whether the
/// provider actually serves images is what the contract suite and the drift monitor exist to
/// check.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub struct Capabilities {
    pub text: bool,
    pub image: bool,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    #[serde(default)]
    pub max_output_tokens: Option<u64>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parse(v: Value) -> ManifestView {
        serde_json::from_value(v).expect("the fixture should read as a manifest view")
    }

    /// The `openai-compat` template, character for character as `builtin-templates.ts:9-70` builds
    /// it. **This is the guard the module note names**: the read model is only correct if it can
    /// read the manifests that actually exist, and these two are the ones every installed provider
    /// is a profile of.
    fn openai_compat() -> Value {
        json!({
            "manifestVersion": 1,
            "kind": "declarative",
            "dialect": "openai-chat-v1",
            "provider": {
                "baseUrl": "https://openrouter.ai/api/v1",
                "auth": { "headers": [{ "name": "Authorization", "prefix": "Bearer" }] }
            },
            "endpoints": {
                "listModels": {
                    "method": "GET",
                    "path": "/models",
                    "map": { "models": "$.data[*].id", "raw": "$.data[*]" }
                },
                "generateText": {
                    "method": "POST",
                    "path": "/chat/completions",
                    "headers": { "HTTP-Referer": "{{appUrl}}", "X-Title": "AI-Provider Router" },
                    "requestTemplate": {
                        "model": "{{model}}",
                        "messages": "{{messages}}",
                        "stream": "{{stream}}",
                        "max_tokens": "{{maxTokens?}}",
                        "temperature": "{{temperature?}}",
                        "tools": "{{tools?}}",
                        "tool_choice": "{{toolChoice?}}",
                        "response_format": "{{responseFormat?}}"
                    },
                    "responseMap": {
                        "text": "$.choices[0].message.content",
                        "usage": "$.usage",
                        "toolCalls": "$.choices[0].message.tool_calls"
                    },
                    "stream": {
                        "protocol": "sse",
                        "chunkMap": {
                            "delta": "$.choices[0].delta.content",
                            "toolCalls": "$.choices[0].delta.tool_calls"
                        },
                        "errorMap": { "$.error": "PASS_THROUGH" },
                        "finish": "$.choices[0].finish_reason",
                        "requestUsage": true
                    }
                },
                "generateImage": {
                    "method": "POST",
                    "path": "/images",
                    "requestTemplate": { "model": "{{model}}", "prompt": "{{prompt}}", "size": "{{size?}}" },
                    "responseMap": { "imageB64": "$.data[0].b64_json", "imageUrl": "$.data[0].url" }
                }
            },
            "capabilities": { "text": true, "image": true },
            "modalityRules": {
                "image": { "rawMatch": { "path": "$.architecture.output_modalities[0]", "contains": "image" } }
            },
            "provenance": {
                "origin": "builtin-template",
                "generatorModel": null,
                "createdAt": "1970-01-01T00:00:00Z"
            }
        })
    }

    /// The `anthropic-compat` template — `builtin-templates.ts:72-136`.
    fn anthropic_compat() -> Value {
        json!({
            "manifestVersion": 1,
            "kind": "declarative",
            "dialect": "anthropic-messages-v1",
            "provider": {
                "baseUrl": "https://api.b.ai/v1",
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
                        "stream": "{{stream}}",
                        "max_tokens": "{{maxTokens}}",
                        "tools": "{{tools?}}",
                        "tool_choice": "{{toolChoice?}}"
                    },
                    "responseMap": {
                        "text": "$.content[0].text",
                        "usage": "$.usage",
                        "toolCalls": "$.content"
                    },
                    "stream": {
                        "protocol": "sse",
                        "chunkMap": { "delta": "$.delta.text" },
                        "errorMap": { "$.error": "PASS_THROUGH" },
                        "stopWhen": { "path": "$.type", "equals": "message_stop" },
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
            "provenance": {
                "origin": "builtin-template",
                "generatorModel": null,
                "createdAt": "1970-01-01T00:00:00Z"
            }
        })
    }

    #[test]
    fn reads_the_openai_compat_template() {
        let m = parse(openai_compat());

        assert_eq!(m.dialect, "openai-chat-v1");
        assert_eq!(m.provider.base_url, "https://openrouter.ai/api/v1");
        assert_eq!(m.provider.auth.headers.len(), 1);
        assert_eq!(m.provider.auth.headers[0].name, "Authorization");
        assert_eq!(m.provider.auth.headers[0].prefix.as_deref(), Some("Bearer"));
        assert_eq!(m.capabilities, Capabilities { text: true, image: true });

        let list = m.endpoints.list_models.expect("listModels");
        assert_eq!(list.path, "/models");
        assert_eq!(list.map.models, "$.data[*].id");
        assert_eq!(list.map.raw.as_deref(), Some("$.data[*]"));

        let text = m.endpoints.generate_text.expect("generateText");
        assert_eq!(text.path, "/chat/completions");
        assert_eq!(text.headers["HTTP-Referer"], "{{appUrl}}");
        assert_eq!(text.response_map.usage.as_deref(), Some("$.usage"));

        let stream = text.stream.expect("stream");
        assert_eq!(stream.chunk_map.delta, "$.choices[0].delta.content");
        assert_eq!(stream.chunk_map.tool_calls.as_deref(), Some("$.choices[0].delta.tool_calls"));
        assert_eq!(stream.finish.as_deref(), Some("$.choices[0].finish_reason"));
        assert_eq!(stream.request_usage, Some(true));
        // The `protocol: "sse"` key is in the JSON and is deliberately not modelled: nothing reads
        // it. `stream` being present is the whole of the fact.
        assert!(stream.error_map.contains_key("$.error"));
        assert!(stream.stop_when.is_none());
        assert!(stream.tool_call_stream.is_none());

        let image = m.endpoints.generate_image.expect("generateImage");
        assert_eq!(image.path, "/images");
        assert_eq!(image.response_map.image_b64.as_deref(), Some("$.data[0].b64_json"));
    }

    #[test]
    fn reads_the_anthropic_compat_template() {
        let m = parse(anthropic_compat());

        assert_eq!(m.dialect, "anthropic-messages-v1");
        // A prefix-less auth header is absent, not empty — the interpreter's falsy test turns both
        // into the bare sentinel, but the two are different inputs and the model keeps them apart.
        assert_eq!(m.provider.auth.headers[0].prefix, None);
        assert_eq!(m.capabilities, Capabilities { text: true, image: false });
        assert!(m.endpoints.generate_image.is_none());
        assert_eq!(m.limits.expect("limits").max_output_tokens, Some(8192));

        let stream = m.endpoints.generate_text.expect("generateText").stream.expect("stream");
        assert_eq!(stream.request_usage, None, "absent is not false");
        let stop = stream.stop_when.expect("stopWhen");
        assert_eq!(stop.path, "$.type");
        assert_eq!(stop.equals, json!("message_stop"));

        let tcs = stream.tool_call_stream.expect("toolCallStream");
        assert_eq!(tcs.start.when.equals, json!("tool_use"));
        assert_eq!(tcs.start.index.as_deref(), Some("$.index"));
        assert_eq!(tcs.delta.partial, "$.delta.partial_json");
    }

    /// **The projection ignores what it does not read, and it must.** Both fixtures carry
    /// `manifestVersion`, `kind`, `provenance` and (for OpenAI) `modalityRules` — keys no field here
    /// names. A `deny_unknown_fields` on any struct in this module would reject both real
    /// templates, which is the opposite of the rule the repository applies to boundary payloads.
    #[test]
    fn the_fields_the_interpreter_does_not_read_are_ignored() {
        let m = parse(openai_compat());
        // Reading it at all is the assertion; the fixture carries four keys nothing here names.
        assert_eq!(m.provider.base_url, "https://openrouter.ai/api/v1");
    }

    /// A manifest with no optional endpoint still reads, and each absence stays distinguishable
    /// from a present-but-empty one.
    #[test]
    fn a_minimal_manifest_reads_with_its_absences_intact() {
        let m = parse(json!({
            "dialect": "openai-chat-v1",
            "provider": { "baseUrl": "https://x.test/v1", "auth": { "headers": [{ "name": "k" }] } },
            "endpoints": {},
            "capabilities": { "text": true, "image": false }
        }));

        assert!(m.endpoints.list_models.is_none());
        assert!(m.endpoints.generate_text.is_none());
        assert!(m.endpoints.generate_image.is_none());
        assert!(m.limits.is_none());
    }

    /// The header map defaults to empty, because the source renders `undefined` and `{}` alike.
    #[test]
    fn an_absent_header_map_and_an_empty_one_are_the_same_input() {
        let base = |headers: Option<Value>| {
            let mut ep = json!({
                "path": "/p",
                "requestTemplate": {},
                "responseMap": { "text": "$.t" }
            });
            if let Some(h) = headers {
                ep["headers"] = h;
            }
            parse(json!({
                "dialect": "d",
                "provider": { "baseUrl": "https://x.test", "auth": { "headers": [{ "name": "k" }] } },
                "endpoints": { "generateText": ep },
                "capabilities": { "text": true, "image": false }
            }))
        };

        let absent = base(None).endpoints.generate_text.unwrap().headers;
        let empty = base(Some(json!({}))).endpoints.generate_text.unwrap().headers;
        assert_eq!(absent, empty);
        assert!(absent.is_empty());
    }

    /// `equals` keeps the JSON type, so a strict comparison stays strict: `1` is not `"1"`.
    #[test]
    fn a_condition_keeps_the_type_of_its_equals_value() {
        let m = parse(json!({
            "dialect": "d",
            "provider": { "baseUrl": "https://x.test", "auth": { "headers": [{ "name": "k" }] } },
            "endpoints": {
                "generateText": {
                    "path": "/p",
                    "requestTemplate": {},
                    "responseMap": { "text": "$.t" },
                    "stream": {
                        "chunkMap": { "delta": "$.d" },
                        "stopWhen": { "path": "$.n", "equals": 1 }
                    }
                }
            },
            "capabilities": { "text": true, "image": false }
        }));

        let stop = m.endpoints.generate_text.unwrap().stream.unwrap().stop_when.unwrap();
        assert_eq!(stop.equals, json!(1));
        assert_ne!(stop.equals, json!("1"), "`===` is strict and the model must not soften it");
    }
}
