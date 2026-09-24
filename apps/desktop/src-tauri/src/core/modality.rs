//! modality — the single place a manifest rule decides a model's modality (v1.1; the `rawMatch`
//! matcher was added by the 2026-09-16 amendment).
//!
//! The TypeScript is one 45-line module that both adapter tiers call, so that a declarative
//! manifest and a sandboxed code adapter tag models identically. In Rust there is only one tier
//! so far, and this module therefore has **no in-crate consumer yet** — the same state
//! `core::compress` was in when increment 14a landed it. It is written now because the decision it
//! was blocked on is now taken (see below), not because something needs it today.
//!
//! # The rules, in the source's order
//!
//! A rule matches when **either** matcher hits (`modality.ts:20-32`):
//!
//! - `modelIdPattern` — a JavaScript regular expression, tested against the native model id;
//! - `rawMatch` — `selectOne(raw, path)` compared to `contains`, by equality when the selection is
//!   a scalar and by membership when it is an array.
//!
//! Modality is **single-valued** and defaults to `text`, so only the `image` rule can ever promote
//! a model and a `text`-keyed rule has nothing to do. That is why this module models `image` and
//! not `text` — see [`ModalityRules`].
//!
//! # §10 decision 5 — the regex engine: what it costs, and the divergence that cannot be configured away
//!
//! The plan asked whether the adapter layer gets a regex engine or whether `modelIdPattern` waits,
//! and it framed the cost as "a genuinely new **runtime** dependency of `aiproviderd`". **That
//! framing is wrong twice over, and both corrections are measurements rather than readings:**
//!
//! - **The engine was already here.** `regex-automata 0.4.18` and `regex-syntax 0.8.11` arrive via
//!   `tracing-subscriber`'s `env-filter` feature, and the `regex` facade itself is already in the
//!   graph because `tauri-utils` depends on it. The direct dependency therefore adds **zero**
//!   crates: `cargo tree --edges normal` resolves 307 crates with it and 307 without it, and the
//!   set difference is empty.
//! - **The features are not ours to choose.** Cargo unifies features per crate across the whole
//!   graph, and `tauri-utils` takes `regex` with defaults on, so the resolved set is the full
//!   default one — `perf`, `perf-literal`, `aho-corasick`, `unicode` and all of it. `Cargo.toml`
//!   accordingly declares a plain `regex = "1"`: it states the requirement instead of pretending
//!   to withhold it, which also means a future `tauri-utils` change cannot quietly move it.
//!
//! **`unicode` cannot be turned off, and that is the finding that shapes this module.** Turning it
//! off does make `\d`/`\w`/`\s` ASCII, matching JavaScript — but it also makes `.` byte-oriented,
//! and the `Regex` type then refuses the pattern outright:
//!
//! ```text
//! RegexBuilder::new("^dall-e-.*$").unicode(false).build()
//!     -> error: pattern can match invalid UTF-8
//! ```
//!
//! That rejects the single most ordinary pattern a manifest can carry, so the trade is refused: a
//! class divergence on input that cannot occur is better than a hard failure on input that does.
//! The remaining divergence is therefore **pinned rather than assumed**, in the direction it
//! actually goes.
//!
//! What it amounts to, measured. For **ASCII** input `\d`, `\w`, `\s`, `\b`, `^`, `$` and case
//! sensitivity all agree with JavaScript, and the one reachable exception is `.`, which excludes
//! only `\n` here where JavaScript's excludes `\r` and the two Unicode line separators as well. For
//! **non-ASCII** input `\d` and `\w` part company — `\d` matches an Arabic-Indic numeral and `\w`
//! matches `é`, and JavaScript's match neither — with `\b` following them. A model id is ASCII in
//! practice, and **0 of 3 installed manifests declare a rule at all**, so this is recorded as a
//! bounded divergence rather than papered over with a pattern rewriter, which would trade a known
//! difference for an unknown defect.
//!
//! # A pattern that will not compile is an error, not a non-match
//!
//! `new RegExp(pattern)` throws, and **nothing catches it**: `manifest-interpreter.ts:230` and
//! `code-adapter.ts:134` both return `tagModalityFrom(...)` directly, and the two consumers —
//! `model-catalog.ts:54` and `contract-suite.ts:103` — do not wrap it. So an unparseable pattern
//! takes down catalogue building in the reference, loudly. This module returns a [`ModalityError`]
//! for the same reason, because the alternative — treating it as "no match" — silently demotes
//! every model of that provider to `text`.
//!
//! **The source's own test is named the opposite of what it asserts.** `modality.test.ts:19-20` is
//! called *"does not throw on an invalid regex — an unparseable rule simply never matches"* and
//! then asserts `.toThrow()`. The assertion is right (`new RegExp("[")` throws) and the **name** is
//! wrong, so a porter who reads the name and not the body implements the silent behaviour. That is
//! recorded in the drift register rather than quietly fixed in the TypeScript, because the
//! TypeScript is the reference the port is measured against.
//!
//! The same error path covers the syntax gap: Rust's `regex` has no backreferences and no
//! lookaround, so a pattern the JavaScript accepts can be rejected here. Loudly, and recorded.

use regex::Regex;
use serde::Deserialize;
use serde_json::Value;

use crate::core::jsonpath::{select_one, JsonPathError};

/// The manifest key this module reads. Named rather than inlined because
/// [`rules_from_manifest`] is the only reader and a typo there would be a silent `None`.
const MODALITY_RULES_KEY: &str = "modalityRules";

/// Which of the two modalities a model serves.
///
/// **Single-valued by design** (`modality.ts:34-38`): a model that can both write text and emit
/// images is classified by whichever rule claims it, and only the image rule ever claims anything.
/// An enum rather than the source's string union so that a third modality is a compile error
/// rather than a string nobody validated; [`Modality::as_str`] gives back the source's spelling for
/// the places that persist it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Modality {
    Text,
    Image,
}

impl Modality {
    /// The spelling the TypeScript uses, and the one the model catalogue stores.
    pub fn as_str(self) -> &'static str {
        match self {
            Modality::Text => "text",
            Modality::Image => "image",
        }
    }
}

impl std::fmt::Display for Modality {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A model as the rule sees it — the port of `ModalityInput`.
///
/// `raw` is the provider's own model object, which is `undefined` for a manifest written before
/// the v1.1 amendment (`listModels.map.raw` absent) and for a catalogue that answered without it.
/// `Option` rather than an empty object because the two are different inputs: the source's
/// `selectOne(undefined, …)` and `selectOne({}, …)` both resolve to nothing, but only the first is
/// what an absent `raw` means, and a caller should not have to fabricate an object to say so.
#[derive(Debug, Clone, Copy)]
pub struct ModalityInput<'a> {
    pub native_id: &'a str,
    pub raw: Option<&'a Value>,
}

/// Why a rule could not be evaluated.
///
/// Three variants because there are three ways to fail, and the source throws for the first two
/// while the third is this port's own — a `modalityRules` block that does not read. The third is
/// unreachable for a manifest that came through the grammar, which is every stored manifest; it
/// exists so that a malformed one is reported rather than read as "declares no rules".
#[derive(Debug, thiserror::Error)]
pub enum ModalityError {
    /// `new RegExp(pattern)` threw — an unparseable pattern, or one using syntax this engine does
    /// not implement.
    #[error("model id pattern is not a usable regular expression: {0}")]
    Pattern(String),
    /// `selectOne` threw — a malformed JSONPath.
    #[error(transparent)]
    Selector(#[from] JsonPathError),
    /// `modalityRules` did not read as a rule set.
    #[error("modalityRules is not readable: {0}")]
    Rules(#[from] serde_json::Error),
}

/// The `image` half of `modalityRules`, and **only** that half.
///
/// The grammar types the field as `z.record(z.enum(["text", "image"]), MODALITY_RULE)`, so both
/// keys are legal and a manifest may carry either or both. [`tag_modality`] reads `image` and
/// nothing else, because modality defaults to `text` — so `text` is *not* modelled here, and it
/// stays an ignored unknown field, which is exactly what the source does with it
/// (`modality.test.ts:80-82` pins that a `text` rule is ignored even when it would match).
#[derive(Debug, Clone, Deserialize)]
pub struct ModalityRules {
    #[serde(default)]
    pub image: Option<ModalityRule>,
}

/// One rule: an id pattern, a metadata matcher, or both — in which case either may match.
///
/// **Both fields are `Option` and the grammar's `superRefine` requires at least one.** That
/// requirement is deliberately not re-checked: the grammar enforced it before the manifest was
/// stored, and a second gate is a second answer to "is this manifest usable". A rule with neither
/// field is therefore representable and simply never matches, which is what the source does with
/// it — both branches are skipped.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModalityRule {
    #[serde(default)]
    pub model_id_pattern: Option<String>,
    #[serde(default)]
    pub raw_match: Option<RawMatch>,
}

/// `selectOne(raw, path) === contains`, or membership when the selection is an array.
#[derive(Debug, Clone, Deserialize)]
pub struct RawMatch {
    /// A JSONPath. The grammar requires a `$`-prefixed `Selector`; a malformed one is reported as
    /// [`ModalityError::Selector`] rather than treated as a non-match.
    pub path: String,
    pub contains: String,
}

/// Read `modalityRules` off a stored manifest.
///
/// `None` when the manifest declares none, which is the common case — **0 of 3 installed
/// manifests declare one** (measured 2026-09-24), so on this install every model is `text`
/// regardless of what this module does. `Err` when the block is present but unreadable, which a
/// manifest that came through the grammar cannot be.
pub fn rules_from_manifest(manifest: &Value) -> Result<Option<ModalityRules>, ModalityError> {
    match manifest.get(MODALITY_RULES_KEY) {
        // `null` is the same input as absent: the source's `rules?.image` skips both.
        None | Some(Value::Null) => Ok(None),
        Some(block) => {
            serde_json::from_value(block.clone()).map(Some).map_err(ModalityError::Rules)
        }
    }
}

/// True when the rule's id pattern or metadata matcher picks this model.
///
/// **The pattern is compiled on every call, because that is where the source compiles it.**
/// `new RegExp(rule.modelIdPattern)` sits *inside* `matchesModalityRule` (`modality.ts:21`), and
/// `model-catalog.ts:54` calls this once per catalogue entry — so the reference recompiles one
/// pattern N times. The port keeps that. A cache would be a divergence in *when* an uncompilable
/// pattern surfaces (the first model rather than every model, and possibly never, if no model is
/// ever tagged), and the cost is unmeasurable today because no installed manifest declares a rule
/// at all. Faithful rather than tidy, and recorded.
pub fn matches_modality_rule(
    rule: &ModalityRule,
    entry: &ModalityInput<'_>,
) -> Result<bool, ModalityError> {
    if let Some(pattern) = rule.model_id_pattern.as_deref() {
        let compiled =
            Regex::new(pattern).map_err(|_| ModalityError::Pattern(pattern.to_string()))?;
        // `RegExp.test` is unanchored, and so is `is_match`: the pattern searches the id unless it
        // anchors itself. Pinned, because "anchored by default" is the natural Rust assumption.
        if compiled.is_match(entry.native_id) {
            return Ok(true);
        }
    }
    if let Some(raw_match) = rule.raw_match.as_ref() {
        if raw_match_hits(entry.raw, raw_match)? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Modality of a discovered model — `text` unless the `image` rule claims it.
///
/// The `image`-or-`text` decision is the whole of `tagModality`, and the reason a `text`-keyed rule
/// is ignored rather than consulted: with a single-valued modality defaulting to `text`, a `text`
/// rule has nothing it could change.
pub fn tag_modality(
    rules: Option<&ModalityRules>,
    entry: &ModalityInput<'_>,
) -> Result<Modality, ModalityError> {
    let Some(rule) = rules.and_then(|r| r.image.as_ref()) else {
        return Ok(Modality::Text);
    };
    if matches_modality_rule(rule, entry)? {
        Ok(Modality::Image)
    } else {
        Ok(Modality::Text)
    }
}

/// `Array.isArray(v) ? v.includes(contains) : v === contains`.
///
/// **The scalar branch is strict equality, so a number never matches a string.** `contains` is
/// always a string (the grammar says so) and `===` compares types first, so a raw value of `1`
/// does not match `contains: "1"`. Comparing `Value`s structurally gives the same answer without
/// the rule having to be written down — the same reasoning `manifest_view::Condition` records for
/// `stopWhen`.
fn raw_match_hits(raw: Option<&Value>, m: &RawMatch) -> Result<bool, ModalityError> {
    let Some(raw) = raw else {
        return Ok(false);
    };
    let Some(selected) = select_one(raw, &m.path)? else {
        return Ok(false);
    };
    let needle = Value::String(m.contains.clone());
    Ok(match selected {
        Value::Array(items) => items.iter().any(|item| item == &needle),
        other => other == &needle,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn entry<'a>(native_id: &'a str, raw: Option<&'a Value>) -> ModalityInput<'a> {
        ModalityInput { native_id, raw }
    }

    /// **A compile failure is a test failure, not an outcome.** `ModalityError` cannot be
    /// `PartialEq` — it carries a `serde_json::Error` — so the tests unwrap rather than compare
    /// `Result`s, and the unwrap message names the error. That also means a test that means to
    /// assert a *match* can never pass by silently erroring.
    fn hits(rule: &ModalityRule, e: &ModalityInput<'_>) -> bool {
        matches_modality_rule(rule, e).expect("the pattern should compile")
    }

    /// `tag_modality` under the same rule: an error is a test failure, not a modality.
    fn tag(rules: Option<&ModalityRules>, e: &ModalityInput<'_>) -> Modality {
        tag_modality(rules, e).expect("the pattern should compile")
    }

    fn id_rule(pattern: &str) -> ModalityRule {
        ModalityRule { model_id_pattern: Some(pattern.to_string()), raw_match: None }
    }

    fn raw_rule(path: &str, contains: &str) -> ModalityRule {
        ModalityRule {
            model_id_pattern: None,
            raw_match: Some(RawMatch { path: path.to_string(), contains: contains.to_string() }),
        }
    }

    fn image_rules(rule: ModalityRule) -> ModalityRules {
        ModalityRules { image: Some(rule) }
    }

    /// The `openrouter` shape the amendment exists for: the id says nothing, the metadata does.
    fn openrouter_raw(modalities: &[&str]) -> Value {
        json!({ "architecture": { "output_modalities": modalities } })
    }

    /* ------------------------------------------------------------ id pattern */

    #[test]
    fn matches_a_bare_id() {
        assert!(hits(&id_rule("^dall-e"), &entry("dall-e-3", None)));
    }

    /// The OpenRouter failure the amendment fixes: an anchored `^dall-e` can never match
    /// `openai/dall-e-3`, which is why `rawMatch` was added rather than the pattern loosened.
    #[test]
    fn an_anchored_pattern_does_not_match_a_namespaced_id() {
        assert!(!hits(&id_rule("^(dall-e|flux)"), &entry("openai/dall-e-3", None)));
    }

    /// `RegExp.test` searches, it does not have to match the whole id. Rust's `is_match` is the
    /// same, and this pins it because anchoring by default is the natural assumption.
    #[test]
    fn an_unanchored_pattern_searches_anywhere() {
        assert!(hits(&id_rule("dall"), &entry("openai/dall-e-3", None)));
    }

    /// `new RegExp("").test(x)` is true for every string, and an empty pattern is a legal value the
    /// grammar does not forbid. Pinned because "an empty pattern matches nothing" is the intuitive
    /// guess and the opposite of the truth.
    #[test]
    fn an_empty_pattern_matches_every_id() {
        assert!(hits(&id_rule(""), &entry("anything", None)));
    }

    /// **An unparseable pattern is an error, not a non-match.** The source throws here, and the
    /// test it carries is named as though it did not — see the module note.
    #[test]
    fn an_uncompilable_pattern_is_an_error_not_a_non_match() {
        assert!(matches!(
            matches_modality_rule(&id_rule("["), &entry("x", None)),
            Err(ModalityError::Pattern(_))
        ));
    }

    /// The syntax gap, made loud. Rust's `regex` has no lookaround, so a pattern the JavaScript
    /// accepts is rejected here rather than silently matching nothing.
    #[test]
    fn a_javascript_lookahead_is_rejected_rather_than_silently_ignored() {
        assert!(matches!(
            matches_modality_rule(&id_rule("^(?=dall)"), &entry("dall-e-3", None)),
            Err(ModalityError::Pattern(_))
        ));
    }

    /// The same for a backreference, which is the other thing JavaScript has and this engine does
    /// not.
    #[test]
    fn a_backreference_is_rejected_rather_than_silently_ignored() {
        assert!(matches!(
            matches_modality_rule(&id_rule("^(a)\\1$"), &entry("aa", None)),
            Err(ModalityError::Pattern(_))
        ));
    }

    /// **The classes are Unicode-aware here, where JavaScript's are ASCII** — a divergence this
    /// port accepts and pins rather than one it failed to notice. Turning `unicode` off would fix
    /// the classes and break `.` (see the module note), so the trade was refused; the *direction*
    /// of the remaining difference is asserted so a future engine change cannot move it quietly.
    ///
    /// The ASCII half is the half that matters, and it agrees with the reference exactly.
    #[test]
    fn the_classes_are_unicode_aware_where_javascripts_are_ascii() {
        let d = id_rule("^\\d+$");
        assert!(hits(&d, &entry("3", None)), "ASCII digits agree with JavaScript");
        assert!(
            hits(&d, &entry("\u{0663}", None)),
            "Arabic-Indic three IS \\d here and is NOT in JavaScript: the recorded divergence"
        );

        let w = id_rule("^\\w+$");
        assert!(!hits(&w, &entry("dall_e-3", None)), "- is not \\w in either engine");
        assert!(hits(&w, &entry("dall_e3", None)), "ASCII word characters agree");
        assert!(
            hits(&w, &entry("\u{e9}", None)),
            "e-acute IS \\w here and is NOT in JavaScript: the same divergence"
        );
    }

    /// The one divergence reachable with **ASCII** input, and worth naming for that reason: `.`
    /// excludes only `\n` here, where JavaScript's excludes `\r` and the two Unicode line
    /// separators as well. A model id carrying a `\r` is not a thing that happens, so this is
    /// pinned rather than worked around.
    #[test]
    fn a_dot_matches_a_carriage_return_where_javascripts_would_not() {
        let dot = id_rule("^a.b$");
        assert!(hits(&dot, &entry("a\rb", None)), "the divergence, and it is reachable");
        assert!(!hits(&dot, &entry("a\nb", None)), "the one line terminator both engines exclude");
    }

    /* ------------------------------------------------------- raw metadata */

    #[test]
    fn raw_match_matches_a_scalar_selection() {
        let raw = openrouter_raw(&["image"]);
        assert!(hits(
            &raw_rule("$.architecture.output_modalities[0]", "image"),
            &entry("a", Some(&raw))
        ));
    }

    #[test]
    fn raw_match_matches_the_primary_output_of_a_dual_modality_model() {
        let raw = openrouter_raw(&["image", "text"]);
        assert!(hits(
            &raw_rule("$.architecture.output_modalities[0]", "image"),
            &entry("g", Some(&raw))
        ));
    }

    /// The auto-router case: `openrouter/auto` declares `[text, image]` and is a **text** model for
    /// routing purposes, because only the primary output is read. This is why the selector indexes
    /// `[0]` rather than testing membership of the whole array.
    #[test]
    fn raw_match_rejects_a_dual_modality_model_whose_primary_output_is_text() {
        let raw = openrouter_raw(&["text", "image"]);
        assert!(!hits(
            &raw_rule("$.architecture.output_modalities[0]", "image"),
            &entry("openrouter/auto", Some(&raw))
        ));
    }

    #[test]
    fn raw_match_matches_array_membership() {
        let raw = openrouter_raw(&["text", "image"]);
        assert!(hits(
            &raw_rule("$.architecture.output_modalities", "image"),
            &entry("x", Some(&raw))
        ));
    }

    #[test]
    fn raw_match_does_not_match_when_the_array_lacks_it() {
        let raw = openrouter_raw(&["text"]);
        assert!(!hits(
            &raw_rule("$.architecture.output_modalities", "image"),
            &entry("x", Some(&raw))
        ));
    }

    /// Three shapes of "there is nothing to read": no `raw` at all (a pre-v1.1 manifest), a `raw`
    /// that is an object without the path, and a `raw` that is `null`. All three are a non-match
    /// rather than an error — `selectOne` resolves to nothing and the comparison is skipped.
    #[test]
    fn raw_match_is_false_when_the_metadata_is_missing_or_unresolvable() {
        let rule = raw_rule("$.architecture.output_modalities[0]", "image");
        assert!(!hits(&rule, &entry("x", None)));

        let bare = json!({ "id": "x" });
        assert!(!hits(&rule, &entry("x", Some(&bare))));

        let null = Value::Null;
        assert!(!hits(&rule, &entry("x", Some(&null))));
    }

    /// **A number never equals a string**, which is `===`'s first rule and the reason the scalar
    /// branch compares `Value`s structurally instead of coercing. `Number("")`-style coercion is
    /// the defect this crate's index already records twice.
    #[test]
    fn a_non_string_selection_never_equals_a_string_contains() {
        let rule = raw_rule("$.kind", "1");

        let number = json!({ "kind": 1 });
        assert!(!hits(&rule, &entry("x", Some(&number))));

        let string = json!({ "kind": "1" });
        assert!(hits(&rule, &entry("x", Some(&string))));
    }

    /// A malformed selector is reported rather than read as a non-match. Unreachable for a stored
    /// manifest — the grammar requires a `$`-prefixed `Selector` — so this pins the error path
    /// rather than a live behaviour.
    #[test]
    fn a_malformed_selector_is_an_error_not_a_non_match() {
        let raw = openrouter_raw(&["image"]);
        assert!(matches!(
            matches_modality_rule(
                &raw_rule("architecture.output_modalities", "image"),
                &entry("x", Some(&raw))
            ),
            Err(ModalityError::Selector(_))
        ));
    }

    /* --------------------------------------------------------- OR semantics */

    #[test]
    fn either_matcher_may_match() {
        let rule = ModalityRule {
            model_id_pattern: Some("^dall-e".to_string()),
            raw_match: Some(RawMatch { path: "$.kind".to_string(), contains: "image".to_string() }),
        };

        assert!(hits(&rule, &entry("dall-e-3", None)), "the id alone");

        let by_meta = json!({ "kind": "image" });
        assert!(hits(&rule, &entry("openai/gpt-image-1", Some(&by_meta))), "the metadata alone");

        let neither = json!({ "kind": "chat" });
        assert!(!hits(&rule, &entry("gpt-4o", Some(&neither))), "neither votes");
    }

    /// A rule with neither matcher is representable here — the grammar's `superRefine` would have
    /// refused it before storage — and it never matches, which is what the source does with it.
    #[test]
    fn a_rule_with_neither_matcher_never_matches() {
        let rule = ModalityRule { model_id_pattern: None, raw_match: None };
        assert!(!hits(&rule, &entry("dall-e-3", None)));
    }

    /* ------------------------------------------------------------ tagging */

    #[test]
    fn tag_modality_tags_an_image_primary_model_as_image() {
        let rules = image_rules(raw_rule("$.architecture.output_modalities[0]", "image"));
        let raw = openrouter_raw(&["image", "text"]);
        assert_eq!(tag(Some(&rules), &entry("g", Some(&raw))), Modality::Image);
    }

    #[test]
    fn tag_modality_tags_everything_else_text() {
        let rules = image_rules(raw_rule("$.architecture.output_modalities[0]", "image"));

        let text_primary = openrouter_raw(&["text"]);
        assert_eq!(tag(Some(&rules), &entry("gpt-4o", Some(&text_primary))), Modality::Text);
        assert_eq!(tag(Some(&rules), &entry("mystery", None)), Modality::Text);
    }

    #[test]
    fn with_no_rules_every_model_is_text() {
        assert_eq!(tag(None, &entry("dall-e-3", None)), Modality::Text);
    }

    /// **Only the `image` rule can promote a model.** A `text`-keyed rule is not modelled at all,
    /// so it is an ignored unknown field — which is the same observable behaviour as the source's
    /// explicit `rules.image` read, and the reason `ModalityRules` has one field.
    #[test]
    fn a_text_keyed_rule_is_ignored() {
        let parsed: ModalityRules =
            serde_json::from_value(json!({ "text": { "modelIdPattern": ".*" } })).unwrap();
        assert!(parsed.image.is_none(), "a text key must not populate the image rule");
        assert_eq!(tag(Some(&parsed), &entry("anything", None)), Modality::Text);
    }

    /// The error propagates out of `tag_modality` rather than being swallowed into `text`, which is
    /// the whole point of the source's throw and of this module's `Result`.
    #[test]
    fn an_uncompilable_pattern_propagates_out_of_tag_modality() {
        let rules = image_rules(id_rule("["));
        assert!(matches!(
            tag_modality(Some(&rules), &entry("x", None)),
            Err(ModalityError::Pattern(_))
        ));
    }

    #[test]
    fn as_str_is_the_typescript_spelling() {
        assert_eq!(Modality::Text.as_str(), "text");
        assert_eq!(Modality::Image.as_str(), "image");
        assert_eq!(Modality::Image.to_string(), "image");
    }

    /* --------------------------------------------------- reading the manifest */

    #[test]
    fn rules_from_manifest_reads_the_camel_case_key() {
        let manifest = json!({
            "dialect": "openai-chat-v1",
            "modalityRules": { "image": { "modelIdPattern": "^dall-e" } }
        });
        let rules = rules_from_manifest(&manifest).unwrap().expect("the block is present");
        let rule = rules.image.expect("the image rule is present");
        assert_eq!(rule.model_id_pattern.as_deref(), Some("^dall-e"));
        assert!(rule.raw_match.is_none());
    }

    #[test]
    fn rules_from_manifest_reads_a_raw_match() {
        let manifest = json!({
            "modalityRules": {
                "image": {
                    "rawMatch": { "path": "$.architecture.output_modalities[0]", "contains": "image" }
                }
            }
        });
        let rules = rules_from_manifest(&manifest).unwrap().unwrap();
        let rule = rules.image.unwrap();
        assert!(rule.model_id_pattern.is_none());
        let raw_match = rule.raw_match.unwrap();
        assert_eq!(raw_match.path, "$.architecture.output_modalities[0]");
        assert_eq!(raw_match.contains, "image");
    }

    /// **0 of 3 installed manifests declare a rule**, so this is the live path — and it must be
    /// `None` rather than an empty rule set, because "declares no rules" and "declares a rule that
    /// matches nothing" are different facts.
    #[test]
    fn rules_from_manifest_is_none_when_the_manifest_declares_none() {
        assert!(rules_from_manifest(&json!({ "dialect": "openai-chat-v1" })).unwrap().is_none());
        assert!(rules_from_manifest(&json!({ "modalityRules": null })).unwrap().is_none());
    }

    /// A present-but-unreadable block is reported, not read as "no rules". Unreachable through the
    /// grammar, which is why it is pinned here rather than left to a live case.
    #[test]
    fn an_unreadable_rules_block_is_an_error_not_an_absence() {
        let manifest = json!({ "modalityRules": { "image": "not a rule" } });
        assert!(matches!(rules_from_manifest(&manifest), Err(ModalityError::Rules(_))));
    }

    /// The builtin template's own rule, character for character
    /// (`builtin-templates.ts:66`), against the model ids it exists to catch. This is the only
    /// pattern any shipped manifest can carry today, so it is the one that has to work.
    #[test]
    fn the_builtin_template_rule_matches_the_models_it_exists_for() {
        let rules = image_rules(id_rule("^(dall-e|flux|sd|imagen|seedream|nano-banana)"));

        for id in ["dall-e-3", "flux-pro", "sd-xl", "imagen-3", "seedream-3", "nano-banana-pro"] {
            assert_eq!(
                tag(Some(&rules), &entry(id, None)),
                Modality::Image,
                "{id} is an image model in the template's rule"
            );
        }
        for id in ["gpt-4o", "claude-sonnet-4", "text-embedding-3-small"] {
            assert_eq!(
                tag(Some(&rules), &entry(id, None)),
                Modality::Text,
                "{id} must not be promoted"
            );
        }
    }
}
