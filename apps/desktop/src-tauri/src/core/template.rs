//! `{{placeholder}}` request-template rendering — the port of `template.ts` (41 lines).
//!
//! A manifest's `requestTemplate` maps a wire field name to either a literal or a placeholder, and
//! this resolves the placeholders. Two spellings, and the difference is a frozen rule rather than a
//! convenience:
//!
//! | spelling | when the value is absent | why |
//! |---|---|---|
//! | `"{{x}}"` | the whole call fails | the manifest declared the field required |
//! | `"{{x?}}"` | **the field is omitted entirely** | sending `null` breaks some servers — frozen in §2.6 |
//!
//! Omitting rather than sending `null` is the point of the `?`. A field that arrives as
//! `"max_tokens": null` is rejected outright by some providers, so "I have no value" has to be
//! expressible as "say nothing", not as "say null".
//!
//! **Mixed text is not supported, by design.** `"Bearer {{token}}"` is *not* a placeholder — the
//! grammar only recognises a value that is *entirely* `{{…}}`. It passes through as a literal
//! string, which is the source's behaviour and the manifest lint's intent: templating that stays
//! auditable is templating that cannot interpolate into a larger string.
//!
//! # Two divergences from the source, both recorded rather than discovered later
//!
//! **Field order.** The returned map is `serde_json`'s `Map`, which without the `preserve_order`
//! feature is a `BTreeMap` — so fields come out **sorted by name** where the JavaScript object keeps
//! **insertion order**, which is the order the manifest declared them. JSON object order is not
//! semantically significant and no provider is known to care, but the serialised bytes differ from
//! the source's, so anything that hashes or byte-compares a request body will see a difference. The
//! same root cause makes `[*]` over an object sorted in [`crate::core::jsonpath`]; one lever
//! (`preserve_order`) would change both, and neither is worth it today. The signature names `Map`
//! rather than `BTreeMap` on purpose: the module follows the crate's `serde_json` configuration
//! instead of contradicting it, so enabling that feature stays a one-line decision elsewhere.
//!
//! **JavaScript's `\s` is not Rust's `char::is_whitespace`.** They disagree on exactly two code
//! points, and the disagreement is handled explicitly by [`is_js_whitespace`] rather than left to
//! chance — because a space the parser fails to recognise turns the *whole* placeholder into a
//! literal, and the provider is then sent the text `{{ model }}` in place of the caller's value.
//! That is a silently wrong request, not a visible failure, which is why it gets ten lines.

use serde_json::{Map, Value};

/// The template could not be rendered. One variant, because there is one way for it to fail: a
/// required placeholder with nothing to put in it.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum TemplateError {
    /// The braces are the source's, brace for brace — `{{model}}` is how a manifest *spells* a
    /// placeholder, so the doubled braces are content and not format specifiers. Hence `{{{{` and
    /// `}}}}` below, each pair rendering as one literal brace.
    #[error("template placeholder {{{{{key}}}}} is required but missing for field {field}")]
    MissingRequired { key: String, field: String },
}

/// JavaScript's `\s`: the `WhiteSpace` and `LineTerminator` productions.
///
/// **Deliberately not `char::is_whitespace`**, which is the Unicode `White_Space` property. The two
/// sets differ on exactly two code points: `White_Space` includes U+0085 (NEL), which JavaScript
/// excludes, and excludes U+FEFF (ZWNBSP), which JavaScript includes. Listing the set is the
/// faithful reading of the source's regex; approximating it would be wrong in the one direction
/// that fails silently.
///
/// `pub(crate)` because `manifest.rs`'s header renderer is the *other* place a JavaScript `\s`
/// appears in the interpreter, and one spelling of the set is the point.
pub(crate) fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{000B}' | '\u{000C}' | '\r' | ' ' | '\u{00A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// Recognise a value that is *entirely* `{{ key }}` or `{{ key? }}`.
///
/// Hand-rolled rather than regex-matched because this crate has no `regex` dependency in its
/// runtime graph, and adding one for a pattern this small would be a poor trade — see the module
/// note in `10-headless-service.md` §7 on why `modality.rs` is deferred for the same reason. The
/// shape is the source's `/^\{\{\s*([A-Za-z0-9_]+)(\?)?\s*\}\}$/`, including its two refusals: an
/// empty key, and whitespace *between* the key and the `?`.
fn parse_placeholder(s: &str) -> Option<(&str, bool)> {
    let inner = s.strip_prefix("{{")?.strip_suffix("}}")?;
    let inner = inner.trim_start_matches(is_js_whitespace);

    let key_len =
        inner.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_')).unwrap_or(inner.len());
    if key_len == 0 {
        return None;
    }
    let (key, after_key) = inner.split_at(key_len);

    let after_question = after_key.strip_prefix('?');
    let optional = after_question.is_some();
    let tail = after_question.unwrap_or(after_key);

    // The `?` must be *adjacent* to the key: `{{ model ? }}` is not a placeholder, and the source's
    // regex refuses it too, because `\s*` cannot span the `?`.
    if tail.trim_end_matches(is_js_whitespace).is_empty() {
        Some((key, optional))
    } else {
        None
    }
}

/// Resolve a manifest's request template against the values for this call.
///
/// Absent and present-but-null are the same input here — the source tests `value === undefined ||
/// value === null` — because a caller that passes `null` means "I have no value" exactly as an
/// omitted key does. Both take the `{{x?}}` path when the manifest allowed it.
pub fn render_template(
    template: &Map<String, Value>,
    values: &Map<String, Value>,
) -> Result<Map<String, Value>, TemplateError> {
    let mut out = Map::new();

    for (field, tpl) in template {
        // A non-string template value is a JSON literal — a number, a bool, an object, an array —
        // and is copied through untouched. Only strings can carry a placeholder.
        let Value::String(text) = tpl else {
            out.insert(field.clone(), tpl.clone());
            continue;
        };

        let Some((key, optional)) = parse_placeholder(text) else {
            // Not a placeholder at all: a literal string, including the unsupported
            // `"Bearer {{token}}"` shape, which the grammar passes through on purpose.
            out.insert(field.clone(), tpl.clone());
            continue;
        };

        match values.get(key) {
            None | Some(Value::Null) => {
                if optional {
                    continue; // omit the field entirely — the §2.6 frozen rule
                }
                return Err(TemplateError::MissingRequired {
                    key: key.to_string(),
                    field: field.clone(),
                });
            }
            Some(value) => {
                out.insert(field.clone(), value.clone());
            }
        }
    }

    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn obj(v: Value) -> Map<String, Value> {
        match v {
            Value::Object(m) => m,
            other => panic!("expected an object, got {other}"),
        }
    }

    /// The two placeholder spellings side by side, which is the whole contract: one omits, one
    /// fails. They are rendered from *separate* templates on purpose — in one template the required
    /// field would abort the call before the optional one could be observed, so a combined case
    /// could not tell the two behaviours apart.
    #[test]
    fn optional_omits_while_required_fails() {
        let empty = obj(json!({}));

        let optional = obj(json!({ "a": "{{x?}}" }));
        assert_eq!(render_template(&optional, &empty).unwrap(), obj(json!({})));

        let required = obj(json!({ "b": "{{x}}" }));
        assert_eq!(
            render_template(&required, &empty).unwrap_err(),
            TemplateError::MissingRequired { key: "x".to_string(), field: "b".to_string() }
        );

        // And in one template carrying both, the required field still decides the outcome — the
        // optional one omits, the required one fails, and the failure is what the caller sees.
        let both = obj(json!({ "a": "{{x?}}", "b": "{{x}}" }));
        assert_eq!(
            render_template(&both, &empty).unwrap_err(),
            TemplateError::MissingRequired { key: "x".to_string(), field: "b".to_string() }
        );
    }

    /// A present value is substituted, and its *type* is preserved — a number stays a number
    /// rather than becoming the string `"1024"`.
    #[test]
    fn substitutes_values_and_preserves_their_json_type() {
        let tpl = obj(json!({ "model": "{{model}}", "max_tokens": "{{maxTokens}}" }));
        let values = obj(json!({ "model": "gpt-4o", "maxTokens": 1024 }));

        assert_eq!(
            render_template(&tpl, &values).unwrap(),
            obj(json!({ "model": "gpt-4o", "max_tokens": 1024 }))
        );
    }

    /// An explicit `null` is absent, not a value — the source's `value === null` half. Without it,
    /// `null` would be sent upstream for a field the manifest marked optional.
    #[test]
    fn an_explicit_null_is_treated_as_absent() {
        let tpl = obj(json!({ "a": "{{x?}}", "b": "{{y?}}" }));
        let values = obj(json!({ "x": null, "y": "kept" }));

        assert_eq!(render_template(&tpl, &values).unwrap(), obj(json!({ "b": "kept" })));
    }

    /// Non-string template values pass through untouched, and an object or array value survives
    /// intact rather than being stringified.
    #[test]
    fn literals_pass_through_unchanged() {
        let tpl = obj(json!({
            "n": 1, "b": true, "nul": null, "arr": [1, 2], "obj": { "k": "v" }, "s": "plain",
        }));

        assert_eq!(render_template(&tpl, &obj(json!({}))).unwrap(), tpl);
    }

    /// **Mixed text is not a placeholder.** `"Bearer {{token}}"` is a literal by design, and this
    /// test is the one that would fail if someone "improved" the parser to interpolate — which
    /// would be a grammar change, not a port.
    #[test]
    fn mixed_text_is_a_literal_not_a_placeholder() {
        let tpl = obj(json!({ "auth": "Bearer {{token}}" }));
        let values = obj(json!({ "token": "sk-secret" }));

        assert_eq!(render_template(&tpl, &values).unwrap(), tpl);
    }

    /// Whitespace inside the braces is allowed, in every combination the source's `\s*` allows.
    #[test]
    fn surrounding_whitespace_is_accepted() {
        let values = obj(json!({ "model": "m" }));
        for spelling in ["{{model}}", "{{ model }}", "{{\tmodel\t}}", "{{ model}}", "{{model }}"] {
            let tpl = obj(json!({ "f": spelling }));
            assert_eq!(
                render_template(&tpl, &values).unwrap(),
                obj(json!({ "f": "m" })),
                "spelling {spelling:?} should resolve"
            );
        }
    }

    /// The `?` must be adjacent to the key. `{{ model ? }}` is a *literal*, so the field is sent as
    /// that text — which is why this is asserted on the rendered output rather than on a parse
    /// helper: the consequence is what matters.
    #[test]
    fn a_detached_question_mark_is_not_optional_syntax() {
        let tpl = obj(json!({ "f": "{{ model ? }}" }));
        assert_eq!(render_template(&tpl, &obj(json!({}))).unwrap(), tpl);
    }

    /// `{{?}}` and `{{}}` have no key, so they are literals — the source's `[A-Za-z0-9_]+` is
    /// one-or-more. An empty key would otherwise resolve against a `""` entry in the values map.
    #[test]
    fn an_empty_key_is_a_literal() {
        let tpl = obj(json!({ "a": "{{}}", "b": "{{?}}", "c": "{{ }}" }));
        let values = obj(json!({ "": "should not be used" }));
        assert_eq!(render_template(&tpl, &values).unwrap(), tpl);
    }

    /// An unclosed placeholder is a literal, not a parse error — the source's regex simply does
    /// not match, and the string is forwarded as written.
    #[test]
    fn an_unclosed_placeholder_is_a_literal() {
        let tpl = obj(json!({ "a": "{{model", "b": "model}}", "c": "{{mo}}del}}" }));
        assert_eq!(render_template(&tpl, &obj(json!({}))).unwrap(), tpl);
    }

    /// **The `\s` divergence, pinned.** JavaScript's `\s` includes U+FEFF and excludes U+0085;
    /// Rust's `char::is_whitespace` is the other way round on both. If this module had used
    /// `is_whitespace`, the first case would become a literal and the provider would be sent the
    /// text `{{ model }}` instead of the value — a silent wrong request.
    #[test]
    fn the_whitespace_set_is_javascripts_not_rusts() {
        let values = obj(json!({ "model": "m" }));

        // U+FEFF is whitespace to JavaScript, so this resolves.
        let bom = obj(json!({ "f": "{{\u{FEFF}model\u{FEFF}}}" }));
        assert_eq!(render_template(&bom, &values).unwrap(), obj(json!({ "f": "m" })));

        // U+0085 is NOT whitespace to JavaScript, so this stays a literal.
        let nel = obj(json!({ "f": "{{\u{0085}model\u{0085}}}" }));
        assert_eq!(render_template(&nel, &values).unwrap(), nel);

        // The two controls the sets disagree about, asserted directly so the reason is local.
        assert!(is_js_whitespace('\u{FEFF}'));
        assert!(!is_js_whitespace('\u{0085}'));
    }

    /// A key with characters outside `[A-Za-z0-9_]` is not a key, so the whole string is a literal.
    #[test]
    fn a_key_outside_the_character_class_is_a_literal() {
        let tpl = obj(json!({ "a": "{{mo-del}}", "b": "{{mödel}}" }));
        let values = obj(json!({ "mo-del": 1, "mödel": 2 }));
        assert_eq!(render_template(&tpl, &values).unwrap(), tpl);
    }

    /// The error message spells the placeholder the way a manifest does — with doubled braces.
    #[test]
    fn the_error_message_uses_the_manifest_spelling() {
        let tpl = obj(json!({ "max_tokens": "{{maxTokens}}" }));
        let err = render_template(&tpl, &obj(json!({}))).unwrap_err();
        assert_eq!(
            err.to_string(),
            "template placeholder {{maxTokens}} is required but missing for field max_tokens"
        );
    }
}
