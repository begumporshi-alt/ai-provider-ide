//! The deliberately tiny JSONPath subset the manifests use — the port of `jsonpath.ts` (77 lines).
//!
//! `$` root, `.field` child, `[0]` array index, `[*]` wildcard. **No recursive descent (`..`), no
//! filters, no expressions, no functions.** The omission is the point: nothing here is
//! *evaluated*, so a manifest cannot smuggle code through a selector. `select_all` walks a tree;
//! it never runs anything.
//!
//! **A selector that names nothing is not an error.** `$.data[9].id` and `$.nope.deep` both yield
//! no match, because a provider is free to omit `usage` or answer a short list — the caller decides
//! whether an absence is meaningful. Only *syntax* is an error, and those are the five variants of
//! [`JsonPathError`].
//!
//! # The one place Rust and JavaScript disagree, and it is measured rather than assumed
//!
//! `serde_json`'s `Map` is a `BTreeMap` — this crate does not enable `preserve_order` — so
//! `Value::Object` iterates in **sorted key order**, where a JavaScript object iterates in
//! **insertion order**. `children` below is built on that iteration, so `[*]` applied to an
//! *object* returns its values in a different order on the two sides. Applied to an **array** — the
//! only case the grammar's own selectors use — the two agree exactly, because both walk indices.
//!
//! **The divergence is latent, not live**, and that was measured rather than argued. The two active
//! manifests in the installed database carry seven distinct selectors between them:
//!
//! ```text
//! $.choices[0].delta.content      $.choices[0].delta.tool_calls
//! $.choices[0].message.content    $.choices[0].message.tool_calls
//! $.data[*]                       $.data[*].id
//! $.usage
//! ```
//!
//! Both `[*]` uses are on `$.data`, an array in the OpenAI-shaped model list. So no installed
//! manifest can reach the differing order today. It is recorded rather than fixed because the fix
//! is not local — it would mean enabling `preserve_order`, which swaps the map implementation for
//! the whole crate and changes key order in every serialised body the gateway writes. If a
//! manifest ever needs `[*]` over an object, that is the decision to make, and this comment is
//! where the measurement lives. `object_wildcard_order_is_sorted_not_insertion` pins the current
//! behaviour so the divergence cannot change silently.

use serde_json::Value;

/// One step of a parsed path — the port of `jsonpath.ts`'s `string | number | "*"`.
///
/// A separate variant per kind rather than an enum-of-untagged, because the TypeScript's own
/// `typeof step === "number"` dispatch is what makes `[0]` an index and `.0` a *key*. The
/// distinction is observable: `$.0` reads the object key `"0"`, `$[0]` reads array element zero,
/// and only one of them matches a given node.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    /// `.name`, or a quoted bracket selector `["name"]` / `['name']`.
    Field(String),
    /// `[0]` — an array index.
    Index(usize),
    /// `[*]` — every child of an array or an object.
    Wildcard,
}

/// Why a selector could not be parsed. Syntax only; a well-formed path that matches nothing is
/// `Ok` with an empty result.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum JsonPathError {
    #[error("jsonpath must start with $: {0}")]
    MustStartWithRoot(String),
    #[error("empty step in {0}")]
    EmptyStep(String),
    #[error("unclosed [ in {0}")]
    UnclosedBracket(String),
    #[error("unexpected char {ch} in {path}")]
    UnexpectedChar { ch: char, path: String },
    #[error("unsupported bracket selector {selector} in {path}")]
    UnsupportedSelector { selector: String, path: String },
}

/// Parse a selector into steps. `$` alone is the empty path, which selects the root.
///
/// **Byte indexing is safe here** because every byte the scanner stops on is ASCII (`.`, `[`, `]`)
/// or the end of the string, so each slice boundary lands on a `char` boundary even when a field
/// name contains multi-byte characters. A non-ASCII byte therefore falls through to
/// [`JsonPathError::UnexpectedChar`] with the whole character, which is what the TypeScript reports
/// too — it indexes by UTF-16 code unit, and for the leading character of a non-ASCII name that is
/// the same character.
pub fn parse_path(path: &str) -> Result<Vec<Step>, JsonPathError> {
    let bytes = path.as_bytes();
    if bytes.first() != Some(&b'$') {
        return Err(JsonPathError::MustStartWithRoot(path.to_string()));
    }

    let mut steps = Vec::new();
    let mut i = 1;
    while i < bytes.len() {
        match bytes[i] {
            b'.' => {
                i += 1;
                let start = i;
                while i < bytes.len() && bytes[i] != b'.' && bytes[i] != b'[' {
                    i += 1;
                }
                if i == start {
                    return Err(JsonPathError::EmptyStep(path.to_string()));
                }
                steps.push(Step::Field(path[start..i].to_string()));
            }
            b'[' => {
                let Some(end) = path[i..].find(']').map(|offset| i + offset) else {
                    return Err(JsonPathError::UnclosedBracket(path.to_string()));
                };
                let inner = &path[i + 1..end];
                steps.push(if inner == "*" {
                    Step::Wildcard
                } else if !inner.is_empty() && inner.bytes().all(|b| b.is_ascii_digit()) {
                    // An index that does not fit `usize` cannot name a real element. The
                    // TypeScript's `Number` makes it a float, `node[1e20]` is `undefined`, and the
                    // result is no match — which `usize::MAX` reproduces, since no array reaches
                    // that length. Saturating is the faithful reading; erroring would not be.
                    Step::Index(inner.parse::<usize>().unwrap_or(usize::MAX))
                } else {
                    Step::Field(parse_quoted(inner, path)?)
                });
                i = end + 1;
            }
            _ => {
                return Err(JsonPathError::UnexpectedChar {
                    ch: path[i..].chars().next().unwrap_or('?'),
                    path: path.to_string(),
                });
            }
        }
    }
    Ok(steps)
}

/// A quoted bracket selector: `"name"` or `'name'`.
///
/// **The line-terminator check is not decoration.** JavaScript's `.` does not match `\n`, `\r`,
/// `\u2028` or `\u2029`, so the source's `/^"(.*)"$/` *refuses* a quoted span containing one.
/// Testing only the first and last character would accept it, and that is the entire difference
/// between the two implementations — so the four characters are excluded explicitly rather than
/// left as a divergence to be discovered later.
fn parse_quoted(inner: &str, path: &str) -> Result<String, JsonPathError> {
    let bytes = inner.as_bytes();
    let is_quoted = bytes.len() >= 2
        && (bytes[0] == b'"' || bytes[0] == b'\'')
        && bytes[bytes.len() - 1] == bytes[0];
    let has_line_terminator = inner.contains(['\n', '\r', '\u{2028}', '\u{2029}']);

    if is_quoted && !has_line_terminator {
        return Ok(inner[1..inner.len() - 1].to_string());
    }
    Err(JsonPathError::UnsupportedSelector { selector: inner.to_string(), path: path.to_string() })
}

/// Every child of a node, in the order the two runtimes agree on for arrays and do not for objects
/// (see the module comment). A scalar has no children, which is why `$.usage[*]` on a number is an
/// empty result rather than an error.
fn children(v: &Value) -> Vec<&Value> {
    match v {
        Value::Array(items) => items.iter().collect(),
        Value::Object(map) => map.values().collect(),
        _ => Vec::new(),
    }
}

/// Walk one step and recurse. The accumulator is threaded rather than returned so that a wildcard
/// does not build a `Vec` per level — the TypeScript's `flatMap` reads the same way, and the
/// ordering is identical because both visit children in the same sequence.
fn walk<'a>(node: &'a Value, steps: &[Step], out: &mut Vec<&'a Value>) {
    match steps.split_first() {
        None => out.push(node),
        Some((Step::Wildcard, rest)) => {
            for child in children(node) {
                walk(child, rest, out);
            }
        }
        Some((Step::Index(index), rest)) => {
            // Array only: `$.usage[0]` where `usage` is an object selects nothing, matching
            // `if (!Array.isArray(node)) return []`.
            if let Value::Array(items) = node {
                if let Some(child) = items.get(*index) {
                    walk(child, rest, out);
                }
            }
        }
        Some((Step::Field(name), rest)) => {
            // Object only — and *not* an array, so `$.data.length` is an empty result rather than
            // a JavaScript array property leaking through.
            if let Value::Object(map) = node {
                if let Some(child) = map.get(name) {
                    walk(child, rest, out);
                }
            }
        }
    }
}

/// Every match, in document order.
///
/// `None` (absent) and `null` (present and null) are different inputs and stay different: the
/// first stops the walk, the second is a match. That is the source's `v === undefined` test, and
/// it matters because a provider that answers `"content": null` has answered.
pub fn select_all<'a>(json: &'a Value, path: &str) -> Result<Vec<&'a Value>, JsonPathError> {
    let steps = parse_path(path)?;
    let mut out = Vec::new();
    walk(json, &steps, &mut out);
    Ok(out)
}

/// The first match, or `None`. Borrowed rather than cloned: the caller reads a leaf out of a
/// response body it still owns, and the source returns the same object references.
pub fn select_one<'a>(json: &'a Value, path: &str) -> Result<Option<&'a Value>, JsonPathError> {
    Ok(select_all(json, path)?.into_iter().next())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The same document `jsonpath.test.ts` builds, so the ported cases are comparable line for
    /// line with the ones they came from.
    fn doc() -> Value {
        json!({
            "data": [
                { "id": "a", "nested": { "x": 1 } },
                { "id": "b", "nested": { "x": 2 } },
            ],
            "usage": { "prompt_tokens": 3 },
            "odd.key": { "v": 9 },
        })
    }

    #[test]
    fn selects_child_paths() {
        assert_eq!(select_one(&doc(), "$.usage.prompt_tokens").unwrap(), Some(&json!(3)));
    }

    #[test]
    fn selects_wildcard_collections() {
        let d = doc();
        assert_eq!(select_all(&d, "$.data[*].id").unwrap(), vec![&json!("a"), &json!("b")]);
        assert_eq!(select_all(&d, "$.data[*]").unwrap().len(), 2);
    }

    #[test]
    fn selects_array_indices() {
        assert_eq!(select_one(&doc(), "$.data[1].nested.x").unwrap(), Some(&json!(2)));
    }

    #[test]
    fn supports_quoted_bracket_keys() {
        assert_eq!(select_one(&doc(), "$[\"odd.key\"].v").unwrap(), Some(&json!(9)));
        assert_eq!(select_one(&doc(), "$['odd.key'].v").unwrap(), Some(&json!(9)));
    }

    /// A selector that names nothing is `Ok`, not an error — the two cases the source calls out.
    #[test]
    fn returns_none_for_missing_paths_not_an_error() {
        let d = doc();
        assert_eq!(select_one(&d, "$.data[9].id").unwrap(), None);
        assert_eq!(select_one(&d, "$.nope.deep").unwrap(), None);
    }

    /// `$..id` and `$.data[?(@.id)]` are the two unsupported syntaxes the source rejects, and they
    /// are rejected by *different* variants — which is worth pinning, because the reason differs:
    /// one is an empty step, the other an unquoted bracket selector.
    #[test]
    fn rejects_unsupported_syntax() {
        let d = doc();
        assert_eq!(
            select_all(&d, "$..id").unwrap_err(),
            JsonPathError::EmptyStep("$..id".to_string())
        );
        assert_eq!(
            select_all(&d, "$.data[?(@.id)]").unwrap_err(),
            JsonPathError::UnsupportedSelector {
                selector: "?(@.id)".to_string(),
                path: "$.data[?(@.id)]".to_string(),
            }
        );
    }

    #[test]
    fn rejects_a_path_that_does_not_start_at_the_root() {
        assert_eq!(
            parse_path("data.id").unwrap_err(),
            JsonPathError::MustStartWithRoot("data.id".to_string())
        );
    }

    #[test]
    fn rejects_an_unclosed_bracket() {
        assert_eq!(
            parse_path("$.data[0").unwrap_err(),
            JsonPathError::UnclosedBracket("$.data[0".to_string())
        );
    }

    /// The root path is the empty step list and selects the whole document.
    #[test]
    fn a_bare_root_selects_the_whole_document() {
        assert_eq!(parse_path("$").unwrap(), vec![]);
        let d = doc();
        assert_eq!(select_all(&d, "$").unwrap(), vec![&d]);
    }

    /// **The divergence this module documents, pinned.** `[*]` over an *object* is sorted here and
    /// insertion-ordered in JavaScript. The assertion is written against sorted order on purpose:
    /// if `preserve_order` is ever enabled, this test fails and the module comment must change with
    /// it. It is a test of a known difference, not of a desired behaviour.
    #[test]
    fn object_wildcard_order_is_sorted_not_insertion() {
        let d = json!({ "z": 1, "m": 2, "a": 3 });
        assert_eq!(select_all(&d, "$[*]").unwrap(), vec![&json!(3), &json!(2), &json!(1)]);
    }

    /// `[*]` over an **array** — the only shape the installed manifests use — is index order, and
    /// the two runtimes agree. This is the half that is live.
    #[test]
    fn array_wildcard_order_is_index_order() {
        let d = json!({ "data": ["z", "m", "a"] });
        assert_eq!(
            select_all(&d, "$.data[*]").unwrap(),
            vec![&json!("z"), &json!("m"), &json!("a")]
        );
    }

    /// Absent and present-but-null are different inputs. The source tests `v === undefined`, so a
    /// `null` leaf is a match — and that distinction is load-bearing for a provider that answers
    /// `"content": null` rather than omitting the field.
    #[test]
    fn null_is_a_match_and_absence_is_not() {
        let d = json!({ "content": null });
        assert_eq!(select_one(&d, "$.content").unwrap(), Some(&Value::Null));
        assert_eq!(select_one(&d, "$.missing").unwrap(), None);
    }

    /// A step that is the wrong *kind* for the node selects nothing: an index into an object, and
    /// a field on an array. Both are the source's explicit type guards, not incidental behaviour.
    #[test]
    fn a_step_of_the_wrong_kind_selects_nothing() {
        let d = json!({ "obj": { "0": "zero" }, "arr": ["first"] });
        assert_eq!(select_one(&d, "$.obj[0]").unwrap(), None);
        assert_eq!(select_one(&d, "$.arr.length").unwrap(), None);
    }

    /// The quoted-selector rule excludes line terminators, because JavaScript's `.` does. Without
    /// the exclusion this would parse; the source throws.
    #[test]
    fn a_quoted_selector_containing_a_line_terminator_is_rejected() {
        assert!(matches!(
            parse_path("$[\"a\nb\"]").unwrap_err(),
            JsonPathError::UnsupportedSelector { .. }
        ));
    }

    /// An index too large for `usize` saturates rather than erroring, because the source's `Number`
    /// accepts it and the lookup simply misses. The observable result is "no match", which is what
    /// is asserted — the saturating value itself is an implementation detail.
    #[test]
    fn an_index_beyond_usize_selects_nothing_rather_than_failing() {
        let d = json!({ "data": ["a"] });
        assert_eq!(select_one(&d, "$.data[99999999999999999999999]").unwrap(), None);
    }
}
