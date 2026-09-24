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
            "max_tokens": "{{maxTokens?}}",
            "temperature": "{{temperature?}}",
            "tools": "{{tools?}}",
            "tool_choice": "{{toolChoice?}}",
            "response_format": "{{responseFormat?}}"
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
                    "stream": "{{stream}}",
                    "max_tokens": "{{maxTokens}}",
                    "tools": "{{tools?}}",
                    "tool_choice": "{{toolChoice?}}"
                },
                "responseMap": {
                    "text": "$.content[0].text",
                    "usage": "$.usage",
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
    match slug {
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
    }
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
