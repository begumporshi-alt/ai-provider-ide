//! The I/O-free half of the generic adapter — the port of the parts of `manifest-interpreter.ts`
//! (492 lines) that never touch a socket.
//!
//! That file holds one class and eleven helpers. The class is the HTTP half — `listModels`,
//! `generateText` (a streaming loop), `generateImage`, `pingKey` — and it is **not** here: it needs
//! the `HttpPort` seam and an async streaming shape that a later increment owns. What is here is
//! everything the class calls that is a pure function of its arguments: the header layer, the
//! streaming tool-call reassembly, the cached-token reader, the URL join, the `Retry-After` parser,
//! and the error the class throws.
//!
//! **That list was one entry short when this module landed, and the correction is recorded rather
//! than quietly applied.** Increment 15's scope note claimed every pure function the class calls was
//! here, and [`parse_retry_after`] / [`retry_after_from`] were not — they were skipped, and nothing
//! noticed because nothing called them. The omission surfaced on 2026-09-24 when the interpreter
//! became their first consumer and had no way to build an `AttemptError::Http` with a wait attached.
//! A module that claims completeness it does not have is worse than one that lists what it holds,
//! which is why the claim is now the enumeration above rather than a summary.
//!
//! **What is still absent from the parser, and why that is a decision.** [`parse_retry_after`]
//! implements the delta-seconds form of RFC 9110 and **not** the HTTP-date form. The source's second
//! branch is `Date.parse(v)`, which accepts a superset of RFC 9110 — ISO 8601 among others — and this
//! crate has no date parser in its runtime graph (the same constraint that defers `modality.rs`).
//! Hand-rolling one would be a guess at which of `Date.parse`'s grammars a provider meant, and the
//! branch is unreachable in practice: a `Retry-After` from an AI provider is a number of seconds.
//! The failure direction is what makes this safe rather than merely convenient — an unreadable value
//! returns `None`, and `None` makes the caller fall back to its own cooldown floor
//! (`engine.rs:1168`), where a wrong date would set a cooldown nobody chose.
//!
//! The split is the one `engine.rs` and `compress.rs` took before it — pure core first, the I/O
//! shell after — and for the same reason: the decisions that are easy to get wrong are pinned while
//! the part needing a socket is still absent, so a mistake in them cannot hide behind a transport
//! failure.
//!
//! # Three states this module deliberately does not define, because the crate already has them
//!
//! The rule is one spelling of one state, and the interpreter is exactly where three states that
//! already have homes would have grown second ones:
//!
//! | the state | already lives at | what a second copy would cost |
//! |---|---|---|
//! | the `{{secret}}` sentinel | [`crate::core::egress::SENTINEL`] | a header the egress gateway does not recognise as carrying a secret, so the request leaves unauthenticated |
//! | `"response" \| "mid-stream"` | [`crate::core::engine::FailureKind`] | a third spelling beside the engine's two, which `classify_attempt_error` branches on |
//! | a real tool call | [`crate::core::adapter::ToolCall`] | two `ToolCall` shapes, one of which the engine's callback cannot accept |
//!
//! The TypeScript has no such problem — it has one class in one file. Rust splits the same state
//! across a seam, and a seam is only worth having if both sides agree on the vocabulary.
//!
//! # What is absent, and why each absence is a decision rather than an oversight
//!
//! - **The manifest grammar.** `AdapterManifest` is not ported. Everything here works on
//!   `serde_json::Value` and the two small structs below, so the grammar can land later without
//!   changing a signature here — which is why [`auth_headers`] takes a slice of [`AuthHeader`]
//!   rather than a manifest.
//! - **`modality.ts`.** Deferred, and the blocker is a dependency rather than effort: a modality
//!   rule's `modelIdPattern` is a regular expression, and this crate has **no `regex` in its runtime
//!   graph**. `Cargo.lock` listing `regex 1.13.1` is precisely the trap — it arrives only through
//!   `tauri-build`'s **build** graph, and `cargo tree -e normal -i regex --no-default-features`
//!   prints *nothing to print*. So adding it would be a genuinely new runtime dependency of
//!   `aiproviderd`, which this port's own rule (`adapter.rs:51-52`) forbids. The decision is
//!   recorded in `10-headless-service.md` §7 rather than taken quietly here.
//!
//! # Divergences, each stated rather than discovered later
//!
//! **Tool-call flush order.** The pending buffer is keyed by the provider's `index` and the source
//! uses a JavaScript `Map`, which iterates in **insertion** order; [`PendingCalls`] is a `BTreeMap`
//! and iterates in **index** order. The two agree whenever indices arrive in sequence, which is the
//! normal case and the only one any dialect here produces — and where they disagree, index order is
//! the more defensible reading, since the index *is* the call's position. `flush_order_is_by_index`
//! pins it.
//!
//! **The error message body is truncated by UTF-16 code units, and Rust cannot do it exactly.**
//! The source is `body.slice(0, 400)`, which counts code units and may cut a surrogate pair in half
//! to produce a lone surrogate — a value a Rust `String` cannot hold. [`truncate_for_message`] takes
//! whole characters and stops *before* exceeding 400 units, so for a body whose 400-unit boundary
//! falls inside an astral character the result is one unit shorter than the source's. That is the
//! closest a Rust string can get, and the difference is confined to the error text.
//!
//! **JavaScript's object guard accepts arrays.** `typeof [] === "object"` and `[]` is truthy, so an
//! array element inside a `tool_calls` list passes the source's `if (!item || typeof item !==
//! "object") continue;` guard and is then read for fields it does not have. Both functions below
//! reproduce that rather than "fixing" it — the resulting empty call is the source's behaviour, and
//! a silent divergence in a tool-call list is worse than a faithful oddity.

use std::collections::BTreeMap;
use std::fmt;

use serde::Deserialize;
use serde_json::{Map, Value};

use crate::core::adapter::ToolCall;
use crate::core::egress::SENTINEL;
use crate::core::engine::{AttemptError, FailureKind};
use crate::core::template::is_js_whitespace;

/// How much of a provider's error body reaches the message — `body.slice(0, 400)` in the source.
pub const MESSAGE_BODY_LIMIT: usize = 400;

/// One auth header a manifest declares, as [`auth_headers`] needs it — `provider.auth.headers`
/// without the manifest around it.
///
/// `Deserialize` because this is also the shape the interpreter's manifest view reads them into:
/// one spelling of one header, rather than a view-local twin that would have to be kept in step.
/// The grammar's only rule about the pair is that `name` is non-empty (`manifest.ts:35`), and a
/// missing `prefix` is absent rather than empty — a distinction [`auth_headers`] acts on.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthHeader {
    pub name: String,
    /// e.g. `"Bearer"`. A falsy prefix is treated as absent, matching the source's `h.prefix ? …`.
    pub prefix: Option<String>,
}

/// A tool call still being reassembled from a stream — the port of the source's `PendingCall`.
///
/// `args` accumulates rather than being replaced, because `arguments` arrives as fragments, one per
/// chunk. A provider that sends the whole thing in one chunk is the same code path with one
/// fragment.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PendingCall {
    pub id: Option<String>,
    pub name: Option<String>,
    pub args: String,
}

/// The reassembly buffer, keyed by the provider's own `index`. A `BTreeMap` rather than the
/// source's `Map` — see the module note on flush order.
pub type PendingCalls = BTreeMap<i64, PendingCall>;

/// The provider's error body, read back as a message — the port of `ManifestHttpError`.
///
/// **The `body` is kept here and dropped on the way to the engine.** [`AttemptError::Http`] carries
/// only what classification needs, because that is all `execute_text` asks of a failure; two
/// callers here need the text itself — `pingKey`'s message and `generateImage`'s `errorBody` — so
/// the adapter-side type is the full one and the engine-side type is its projection. The `From`
/// impl below is that projection, written down in one place instead of at each call site.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManifestHttpError {
    pub status: u16,
    pub body: String,
    pub kind: FailureKind,
    /// What the provider asked us to wait, when it said so at all.
    pub retry_after_ms: Option<u64>,
}

impl ManifestHttpError {
    /// `kind` and `retry_after_ms` are both required rather than defaulted. The source's `kind`
    /// parameter has a `"response"` default and **no call site ever omits it** — all three pass it
    /// explicitly — so a Rust default would be a parameter no caller uses, which is a shape
    /// pretending to be a policy.
    pub fn new(
        status: u16,
        body: impl Into<String>,
        kind: FailureKind,
        retry_after_ms: Option<u64>,
    ) -> Self {
        Self { status, body: body.into(), kind, retry_after_ms }
    }
}

/// The source's `(response)` / `(mid-stream)` — lowercase, and only ever used in the message.
fn kind_label(kind: FailureKind) -> &'static str {
    match kind {
        FailureKind::Response => "response",
        FailureKind::MidStream => "mid-stream",
    }
}

/// The first `limit` UTF-16 code units of `body`, whole characters only.
///
/// Stops *before* a character that would cross the limit rather than splitting it — see the module
/// note. A body shorter than the limit is returned unchanged, so the common case allocates once.
///
/// **A parameter rather than a constant because the interpreter truncates at two different
/// lengths**, and they are the source's two: `ManifestHttpError`'s message keeps 400 units
/// (`:214`) and `pingKey`'s keeps 300 (`:482`). One function with the count passed in is one
/// spelling of the rule; two copies of the loop would be two chances to get the unit counting
/// wrong in a way only an astral character notices.
pub fn truncate_utf16(body: &str, limit: usize) -> String {
    let mut units = 0usize;
    let mut out = String::new();
    for ch in body.chars() {
        let width = ch.len_utf16();
        if units + width > limit {
            break;
        }
        units += width;
        out.push(ch);
    }
    out
}

/// The first [`MESSAGE_BODY_LIMIT`] UTF-16 code units of `body` — what reaches an error message.
pub fn truncate_for_message(body: &str) -> String {
    truncate_utf16(body, MESSAGE_BODY_LIMIT)
}

impl fmt::Display for ManifestHttpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "provider HTTP {} ({}): {}",
            self.status,
            kind_label(self.kind),
            truncate_for_message(&self.body)
        )
    }
}

impl std::error::Error for ManifestHttpError {}

/// The projection the engine sees: status, kind and wait, without the body.
///
/// A non-`ManifestHttpError` failure has no counterpart here on purpose — the source's
/// `instanceof` folds every other error into the same branch as a transport failure, which is
/// [`AttemptError::Transport`], and the caller decides that by not calling this.
impl From<&ManifestHttpError> for AttemptError {
    fn from(e: &ManifestHttpError) -> Self {
        AttemptError::Http { status: e.status, kind: e.kind, retry_after_ms: e.retry_after_ms }
    }
}

/// `baseUrl` with its trailing slashes removed, joined to `path` with exactly one separator.
///
/// An empty `path` yields a trailing `/`, which is what the source produces and what a
/// `GET https://host/` request needs.
pub fn join_url(base_url: &str, path: &str) -> String {
    let base = base_url.trim_end_matches('/');
    if path.starts_with('/') {
        format!("{base}{path}")
    } else {
        format!("{base}/{path}")
    }
}

/// The header NAMES a manifest authenticates with, each carrying the [`SENTINEL`] the egress
/// gateway replaces.
///
/// **The interpreter never sees a credential.** It emits the sentinel and the host substitutes the
/// real secret per header, which is what makes two concurrent attempts with different keys unable
/// to cross secrets (invariant 2). A later duplicate name overwrites an earlier one, matching
/// `Object.fromEntries`.
pub fn auth_headers(headers: &[AuthHeader]) -> BTreeMap<String, String> {
    headers
        .iter()
        .map(|h| {
            // `h.prefix ?` is a *falsy* test, so an empty prefix is no prefix — the header is the
            // bare sentinel rather than a sentinel preceded by a space.
            let value = match h.prefix.as_deref().filter(|p| !p.is_empty()) {
                Some(prefix) => format!("{prefix} {SENTINEL}"),
                None => SENTINEL.to_string(),
            };
            (h.name.clone(), value)
        })
        .collect()
}

/// Recognise a header value that is *entirely* `{{ key }}` — §2.6's per-endpoint headers.
///
/// **A different grammar from `template.rs`, and the difference is load-bearing.** This one has no
/// `?`: `{{x?}}` is *not* a placeholder in a header and is passed through as the literal text
/// `{{x?}}`, where the request template would have omitted the field. The source spells them as two
/// regexes for the same reason, so they stay two functions here.
fn parse_header_placeholder(s: &str) -> Option<&str> {
    let inner = s.strip_prefix("{{")?.strip_suffix("}}")?;
    let inner = inner.trim_start_matches(is_js_whitespace).trim_end_matches(is_js_whitespace);
    if inner.is_empty() || !inner.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return None;
    }
    Some(inner)
}

/// `String(vars[key] ?? "")` for the value types a host variable can hold — and, since the
/// interpreter reads a model id the same way (`manifest-interpreter.ts:253`), for the value types a
/// catalogue entry can hold.
///
/// Absent and `null` both become the empty string — the source's `??` — so a header never renders
/// as the text `null`. Numbers and booleans take their JavaScript spellings, which is what a host
/// variable interpolated into a header would produce there.
pub(crate) fn js_string_coerce(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Bool(true)) => "true".to_string(),
        Some(Value::Bool(false)) => "false".to_string(),
        // A container would stringify as `[object Object]` in JavaScript and as JSON here. No host
        // variable is a container — they are `appUrl` and its siblings — so the two runtimes are
        // not given a case to disagree on rather than being made to agree on an absurd one.
        Some(other) => other.to_string(),
    }
}

/// Resolve `{{placeholder}}` inside a manifest's static header values.
///
/// **A missing variable renders as the empty string, not as a failure and not as an omission.**
/// That is the source's `?? ""`, and it is the opposite of the request template's rule — worth
/// stating because the two functions sit four lines apart in the file they came from.
pub fn render_headers(
    headers: &BTreeMap<String, String>,
    vars: &Map<String, Value>,
) -> BTreeMap<String, String> {
    headers
        .iter()
        .map(|(name, value)| {
            let rendered = match parse_header_placeholder(value) {
                Some(key) => js_string_coerce(vars.get(key)),
                None => value.clone(),
            };
            (name.clone(), rendered)
        })
        .collect()
}

/// Read a header case-insensitively.
///
/// `HttpPort` returns a plain map, so unlike a real `Headers` the lookup is case-sensitive — and
/// providers are not consistent about how they capitalise `Retry-After`. The direct hit is tried
/// first so the common spelling costs nothing.
pub fn header_value<'a>(headers: &'a BTreeMap<String, String>, name: &str) -> Option<&'a str> {
    if let Some(found) = headers.get(name) {
        return Some(found.as_str());
    }
    let want = name.to_lowercase();
    headers.iter().find(|(k, _)| k.to_lowercase() == want).map(|(_, v)| v.as_str())
}

/// A `Retry-After` header value as a delay in milliseconds — the port of `parseRetryAfter`
/// (`manifest-interpreter.ts:191-199`).
///
/// RFC 9110 allows either a delay in seconds or an HTTP-date. **Only the seconds form is
/// implemented**; see the module note for why the date branch is a recorded absence rather than a
/// half-done one. Anything unreadable is `None` so the caller falls back to its own floor —
/// guessing here would produce a cooldown that is either uselessly short or absurdly long.
///
/// **The source's `now` parameter is gone, not defaulted.** It exists only to measure an HTTP-date
/// against, and with that branch unported it would be an argument no caller reads — the shape
/// `ManifestHttpError::new` refuses for its own `kind` parameter.
///
/// **`Number(v)` is JavaScript's coercion, and this is narrower than it.** A hex or binary literal
/// (`"0x1f"`) is a number to JavaScript and not to `f64::from_str`, so such a value falls through to
/// the unported date branch and returns `None` where the source would have returned a wait. It is
/// not a header any provider sends, and the direction of the difference is the safe one.
pub fn parse_retry_after(raw: Option<&str>) -> Option<u64> {
    // `raw?.trim()` — an absent header and a whitespace-only one are both "said nothing".
    let value = raw?.trim_matches(is_js_whitespace);
    if value.is_empty() {
        return None;
    }
    // `Number.isFinite(secs) && secs >= 0` — `f64` parses `"inf"` and `"NaN"`, so the finiteness
    // test is load-bearing rather than decorative.
    let secs: f64 = value.parse().ok()?;
    if !secs.is_finite() || secs < 0.0 {
        return None;
    }
    // `Math.round(secs * 1000)`. A wait beyond `u64::MAX` milliseconds saturates rather than
    // wrapping, which keeps an absurd value absurd instead of turning it into a short one.
    let ms = (secs * 1000.0).round();
    if ms >= u64::MAX as f64 {
        return Some(u64::MAX);
    }
    Some(ms as u64)
}

/// The delay a response asks us to wait, in ms, or `None` when it asks for nothing.
///
/// The lookup is case-insensitive because providers disagree about how they capitalise the header —
/// see [`header_value`], which exists for exactly this.
pub fn retry_after_from(headers: &BTreeMap<String, String>) -> Option<u64> {
    parse_retry_after(header_value(headers, "retry-after"))
}

/// Read a usage block's cached-prompt-token count, in whichever dialect reports it.
///
/// OpenAI nests it at `prompt_tokens_details.cached_tokens`; Anthropic puts
/// `cache_read_input_tokens` at the top level. **`None` and `Some(0)` are different findings** —
/// "this provider does not report caching" against "it reported zero cached tokens" — and only the
/// second is evidence that caching is unavailable to us. That distinction is why
/// `ledger.cached_tokens` is nullable with no default (migration 0015), and it is the reason this
/// returns an `Option` rather than defaulting to zero.
///
/// A negative or fractional count is not a token count, so `as_u64` rejects it and the result is
/// `None` — "not reported" — rather than a coerced value. The source would carry such a number
/// through, but no provider is known to send one and a bogus ledger figure is worse than an absent
/// one.
pub fn read_cached_tokens(usage: &Map<String, Value>) -> Option<u64> {
    if let Some(Value::Object(details)) = usage.get("prompt_tokens_details") {
        if let Some(cached) = details.get("cached_tokens").and_then(Value::as_u64) {
            return Some(cached);
        }
    }
    usage.get("cache_read_input_tokens").and_then(Value::as_u64)
}

/// Read a field off a value the way JavaScript would — an object, **or an array, where every key is
/// absent**. The array arm exists because `typeof [] === "object"` and `[]` is truthy, so the
/// source's guard lets an array through and then reads nothing from it. See the module note.
fn field<'a>(node: &'a Value, key: &str) -> Option<&'a Value> {
    node.as_object().and_then(|m| m.get(key))
}

/// True when JavaScript's `typeof node === "object"` and `node` is truthy — which an array is.
fn is_js_object(node: &Value) -> bool {
    node.is_object() || node.is_array()
}

/// Accumulate one chunk's `tool_calls` array into the buffer, keyed by the delta index.
///
/// `arguments` **appends**; `id` and `name` are replaced, and only by a non-empty string — the
/// source's `&& o.id`, which a later chunk carrying `""` must not overwrite a real id with.
pub fn collect_tool_call_deltas(acc: &mut PendingCalls, raw: &Value) {
    let mut absorb = |item: &Value| {
        if !is_js_object(item) {
            return;
        }
        let index = field(item, "index").and_then(Value::as_i64).unwrap_or(0);
        let pending = acc.entry(index).or_default();

        if let Some(id) = field(item, "id").and_then(Value::as_str).filter(|s| !s.is_empty()) {
            pending.id = Some(id.to_string());
        }
        if let Some(function) = field(item, "function").filter(|v| is_js_object(v)) {
            if let Some(name) =
                field(function, "name").and_then(Value::as_str).filter(|s| !s.is_empty())
            {
                pending.name = Some(name.to_string());
            }
            if let Some(fragment) = field(function, "arguments").and_then(Value::as_str) {
                pending.args.push_str(fragment);
            }
        }
    };

    match raw {
        Value::Array(items) => items.iter().for_each(&mut absorb),
        other => absorb(other),
    }
}

/// Block types that are tool calls. Anthropic's `content` mixes these with `text` blocks, so the
/// array has to be filtered; OpenAI's entries carry no `type` at all and pass through.
const TOOL_BLOCK_TYPES: [&str; 2] = ["tool_use", "function"];

/// Report a *non-stream* tool-call array — already complete, so nothing is reassembled.
///
/// **The one asymmetry with [`collect_tool_call_deltas`], kept because it is the source's.** Here an
/// empty-string `id` or `name` is *kept* (`typeof o.id === "string"`), where the streaming path
/// *drops* it (`&& o.id`). The two are separate functions in the source for the same reason, and
/// `an_empty_id_survives_here_but_not_in_the_deltas` pins the difference so it cannot be "tidied"
/// away by someone reading only one of them.
pub fn emit_tool_calls(sink: &mut dyn FnMut(ToolCall), raw: &Value) {
    let mut emit = |item: &Value| {
        if !is_js_object(item) {
            return;
        }
        // A dialect may hand back a mixed array; only the tool blocks are calls.
        if let Some(block_type) = field(item, "type").and_then(Value::as_str) {
            if !TOOL_BLOCK_TYPES.contains(&block_type) {
                return;
            }
        }

        // OpenAI nests under `function`; Anthropic is flat with `input` already an object.
        let function = match field(item, "function") {
            Some(node) if is_js_object(node) => node,
            _ => item,
        };

        // `??` is nullish, not falsy: an `arguments` of `""` is a *value* and stops the fallback,
        // where `null` and absence both continue to `input`.
        let args_raw = match field(function, "arguments") {
            Some(node) if !node.is_null() => Some(node),
            _ => field(function, "input").filter(|node| !node.is_null()),
        };

        let arguments = match args_raw {
            None => None,
            Some(Value::String(text)) => Some(text.clone()),
            Some(other) => Some(other.to_string()),
        };

        sink(ToolCall {
            id: field(item, "id").and_then(Value::as_str).map(str::to_string),
            name: field(function, "name").and_then(Value::as_str).map(str::to_string),
            arguments,
            raw: Some(item.clone()),
        });
    };

    match raw {
        Value::Array(items) => items.iter().for_each(&mut emit),
        other => emit(other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn obj(value: Value) -> Map<String, Value> {
        match value {
            Value::Object(m) => m,
            other => panic!("expected an object, got {other}"),
        }
    }

    fn auth(name: &str, prefix: Option<&str>) -> AuthHeader {
        AuthHeader { name: name.to_string(), prefix: prefix.map(str::to_string) }
    }

    // ---------- join_url ----------

    #[test]
    fn joins_with_exactly_one_separator() {
        assert_eq!(join_url("https://api.test/v1", "/models"), "https://api.test/v1/models");
        assert_eq!(join_url("https://api.test/v1/", "/models"), "https://api.test/v1/models");
        assert_eq!(join_url("https://api.test/v1", "models"), "https://api.test/v1/models");
        assert_eq!(join_url("https://api.test/v1///", "models"), "https://api.test/v1/models");
    }

    /// An empty path still produces a separator, because the source appends `/` before checking the
    /// path — `GET https://host/` is the request that results, not `GET https://host`.
    #[test]
    fn an_empty_path_still_produces_a_trailing_slash() {
        assert_eq!(join_url("https://api.test", ""), "https://api.test/");
    }

    // ---------- auth_headers ----------

    #[test]
    fn auth_headers_carry_the_sentinel_and_never_a_secret() {
        let headers =
            auth_headers(&[auth("Authorization", Some("Bearer")), auth("x-api-key", None)]);

        assert_eq!(headers["Authorization"], "Bearer {{secret}}");
        assert_eq!(headers["x-api-key"], "{{secret}}");
        // The sentinel is the egress gateway's constant, not a literal repeated here.
        assert!(headers["Authorization"].contains(SENTINEL));
    }

    /// `h.prefix ?` is a falsy test, so `""` is no prefix — the header is the bare sentinel rather
    /// than a sentinel with a leading space, which would be a different header value entirely.
    #[test]
    fn an_empty_prefix_is_treated_as_no_prefix() {
        assert_eq!(auth_headers(&[auth("Authorization", Some(""))])["Authorization"], "{{secret}}");
    }

    /// A later duplicate name overwrites an earlier one, matching `Object.fromEntries`.
    #[test]
    fn a_duplicate_header_name_keeps_the_last() {
        let headers = auth_headers(&[
            auth("Authorization", Some("First")),
            auth("Authorization", Some("Second")),
        ]);
        assert_eq!(headers.len(), 1);
        assert_eq!(headers["Authorization"], "Second {{secret}}");
    }

    // ---------- render_headers ----------

    #[test]
    fn renders_a_placeholder_from_the_host_vars() {
        let headers = BTreeMap::from([("x-app".to_string(), "{{appUrl}}".to_string())]);
        let vars = obj(json!({ "appUrl": "https://aiprovider.router" }));

        assert_eq!(render_headers(&headers, &vars)["x-app"], "https://aiprovider.router");
    }

    /// A missing variable renders as the empty string — the source's `?? ""`. This is the opposite
    /// of the request template's rule, where a missing required placeholder fails the call.
    #[test]
    fn a_missing_variable_renders_empty_rather_than_failing() {
        let headers = BTreeMap::from([
            ("a".to_string(), "{{missing}}".to_string()),
            ("b".to_string(), "{{alsoMissing}}".to_string()),
        ]);
        let rendered = render_headers(&headers, &obj(json!({})));

        assert_eq!(rendered["a"], "");
        assert_eq!(rendered["b"], "");
    }

    /// An explicit `null` variable is absent too, so a header never renders as the text `null`.
    #[test]
    fn a_null_variable_renders_empty_not_null() {
        let headers = BTreeMap::from([("a".to_string(), "{{appUrl}}".to_string())]);
        let vars = obj(json!({ "appUrl": null }));
        assert_eq!(render_headers(&headers, &vars)["a"], "");
    }

    /// **The header grammar has no `?`.** `{{x?}}` is not a placeholder here — it is passed through
    /// as that literal text — where in a request template it would omit the field. Two grammars,
    /// deliberately not merged.
    #[test]
    fn the_optional_marker_is_not_recognised_in_a_header() {
        let headers = BTreeMap::from([("a".to_string(), "{{appUrl?}}".to_string())]);
        let vars = obj(json!({ "appUrl": "https://x.test", "appUrl?": "ignored" }));

        assert_eq!(render_headers(&headers, &vars)["a"], "{{appUrl?}}");
    }

    /// Mixed text is not a placeholder here either, so a static header keeps its literal value.
    #[test]
    fn mixed_text_is_left_alone() {
        let headers = BTreeMap::from([("a".to_string(), "prefix {{appUrl}} suffix".to_string())]);
        let vars = obj(json!({ "appUrl": "https://x.test" }));
        assert_eq!(render_headers(&headers, &vars)["a"], "prefix {{appUrl}} suffix");
    }

    /// Scalars take their JavaScript spellings, so a numeric host variable does not render as JSON
    /// quoted text.
    #[test]
    fn scalar_variables_use_javascript_spellings() {
        let headers = BTreeMap::from([
            ("n".to_string(), "{{count}}".to_string()),
            ("t".to_string(), "{{yes}}".to_string()),
            ("f".to_string(), "{{no}}".to_string()),
        ]);
        let vars = obj(json!({ "count": 42, "yes": true, "no": false }));
        let rendered = render_headers(&headers, &vars);

        assert_eq!(rendered["n"], "42");
        assert_eq!(rendered["t"], "true");
        assert_eq!(rendered["f"], "false");
    }

    // ---------- header_value ----------

    #[test]
    fn header_lookup_is_case_insensitive() {
        let headers = BTreeMap::from([("Retry-After".to_string(), "30".to_string())]);

        assert_eq!(header_value(&headers, "Retry-After"), Some("30"));
        assert_eq!(header_value(&headers, "retry-after"), Some("30"));
        assert_eq!(header_value(&headers, "RETRY-AFTER"), Some("30"));
        assert_eq!(header_value(&headers, "Retry-After"), Some("30"));
        assert_eq!(header_value(&headers, "x-absent"), None);
    }

    #[test]
    fn header_lookup_on_an_empty_map_is_none() {
        assert_eq!(header_value(&BTreeMap::new(), "retry-after"), None);
    }

    // ---------- parse_retry_after / retry_after_from ----------

    #[test]
    fn a_delta_seconds_header_becomes_milliseconds() {
        assert_eq!(parse_retry_after(Some("30")), Some(30_000));
        assert_eq!(parse_retry_after(Some("0")), Some(0));
        assert_eq!(parse_retry_after(Some("1.5")), Some(1_500), "RFC 9110 allows a decimal");
    }

    /// The source's `raw?.trim()` and `if (!v)`: an absent header, an empty one and a
    /// whitespace-only one are the same input — "the provider said nothing".
    #[test]
    fn an_absent_or_blank_header_names_no_wait() {
        assert_eq!(parse_retry_after(None), None);
        assert_eq!(parse_retry_after(Some("")), None);
        assert_eq!(parse_retry_after(Some("   ")), None);
        assert_eq!(parse_retry_after(Some("\t\n")), None);
    }

    /// **The unported branch, pinned as a value rather than left in prose.** An HTTP-date is
    /// well-formed per RFC 9110 and the source would measure it against `now`; here it is `None`, so
    /// the caller falls back to its own cooldown floor. If someone ports the date branch, this test
    /// is the one that has to change — which is the point of writing it down.
    #[test]
    fn an_http_date_names_no_wait_because_that_branch_is_not_ported() {
        assert_eq!(parse_retry_after(Some("Sun, 06 Nov 1994 08:49:37 GMT")), None);
        assert_eq!(parse_retry_after(Some("2026-09-24T10:00:00Z")), None);
    }

    /// A negative wait is not a wait. `Number("-1")` is finite and negative, so the source's
    /// `secs >= 0` test rejects it and so does this — a negative cooldown would read as "retry now".
    #[test]
    fn a_negative_delay_is_not_a_wait() {
        assert_eq!(parse_retry_after(Some("-1")), None);
        assert_eq!(parse_retry_after(Some("-0.5")), None);
    }

    /// Unreadable text names no wait, and so does a non-finite number — `f64` parses both `"inf"`
    /// and `"NaN"`, so the finiteness test is doing real work.
    #[test]
    fn unreadable_or_non_finite_values_name_no_wait() {
        assert_eq!(parse_retry_after(Some("soon")), None);
        assert_eq!(parse_retry_after(Some("30s")), None);
        assert_eq!(parse_retry_after(Some("inf")), None);
        assert_eq!(parse_retry_after(Some("NaN")), None);
        // The one narrowing the doc comment records: JavaScript reads this as 31.
        assert_eq!(parse_retry_after(Some("0x1f")), None);
    }

    #[test]
    fn the_lookup_finds_the_header_whatever_its_capitalisation() {
        for spelling in ["Retry-After", "retry-after", "RETRY-AFTER"] {
            let headers = BTreeMap::from([(spelling.to_string(), "45".to_string())]);
            assert_eq!(retry_after_from(&headers), Some(45_000), "spelling {spelling}");
        }
        assert_eq!(retry_after_from(&BTreeMap::new()), None);
    }

    // ---------- read_cached_tokens ----------

    /// The two dialects, and the `None`-vs-`Some(0)` distinction the ledger's nullable column
    /// exists for.
    #[test]
    fn reads_cached_tokens_from_both_dialects() {
        let openai =
            obj(json!({ "prompt_tokens": 10, "prompt_tokens_details": { "cached_tokens": 7 } }));
        assert_eq!(read_cached_tokens(&openai), Some(7));

        let anthropic = obj(json!({ "cache_read_input_tokens": 9 }));
        assert_eq!(read_cached_tokens(&anthropic), Some(9));
    }

    #[test]
    fn a_reported_zero_is_not_the_same_as_absent() {
        let reported_zero = obj(json!({ "prompt_tokens_details": { "cached_tokens": 0 } }));
        assert_eq!(read_cached_tokens(&reported_zero), Some(0));

        let nothing = obj(json!({ "prompt_tokens": 10 }));
        assert_eq!(read_cached_tokens(&nothing), None);
    }

    /// OpenAI's shape wins when both are present, because the source returns from the nested check
    /// first. Asserting the precedence rather than only the two individual reads.
    #[test]
    fn the_nested_openai_shape_takes_precedence() {
        let both = obj(
            json!({ "prompt_tokens_details": { "cached_tokens": 3 }, "cache_read_input_tokens": 9 }),
        );
        assert_eq!(read_cached_tokens(&both), Some(3));
    }

    /// A `prompt_tokens_details` that is present but carries no usable count falls through to the
    /// top-level dialect rather than stopping — the source's nested `if` does not return.
    #[test]
    fn an_unusable_nested_block_falls_through_to_the_top_level() {
        let malformed = obj(
            json!({ "prompt_tokens_details": { "cached_tokens": "many" }, "cache_read_input_tokens": 9 }),
        );
        assert_eq!(read_cached_tokens(&malformed), Some(9));
    }

    #[test]
    fn a_negative_or_fractional_count_is_not_reported() {
        let negative = obj(json!({ "cache_read_input_tokens": -1 }));
        assert_eq!(read_cached_tokens(&negative), None);

        let fractional = obj(json!({ "cache_read_input_tokens": 1.5 }));
        assert_eq!(read_cached_tokens(&fractional), None);
    }

    // ---------- collect_tool_call_deltas ----------

    /// The fragments of one call arrive across chunks and must be concatenated, not replaced.
    #[test]
    fn arguments_are_concatenated_across_chunks() {
        let mut pending = PendingCalls::new();
        collect_tool_call_deltas(
            &mut pending,
            &json!({ "index": 0, "id": "call_1", "function": { "name": "lookup", "arguments": "{\"ci" } }),
        );
        collect_tool_call_deltas(
            &mut pending,
            &json!({ "index": 0, "function": { "arguments": "ty\":\"Dhaka\"}" } }),
        );

        let call = &pending[&0];
        assert_eq!(call.id.as_deref(), Some("call_1"));
        assert_eq!(call.name.as_deref(), Some("lookup"));
        assert_eq!(call.args, "{\"city\":\"Dhaka\"}");
    }

    /// Two calls in one stream are kept apart by their index.
    #[test]
    fn separate_indices_are_separate_calls() {
        let mut pending = PendingCalls::new();
        collect_tool_call_deltas(
            &mut pending,
            &json!([
                { "index": 0, "function": { "name": "a", "arguments": "{}" } },
                { "index": 1, "function": { "name": "b", "arguments": "{}" } },
            ]),
        );

        assert_eq!(pending.len(), 2);
        assert_eq!(pending[&0].name.as_deref(), Some("a"));
        assert_eq!(pending[&1].name.as_deref(), Some("b"));
    }

    /// An empty `id` must not overwrite a real one — the source's `&& o.id`. A later chunk that
    /// carries `"id": ""` is the normal shape of a continuation.
    #[test]
    fn an_empty_id_does_not_overwrite_a_real_one() {
        let mut pending = PendingCalls::new();
        collect_tool_call_deltas(&mut pending, &json!({ "index": 0, "id": "call_1" }));
        collect_tool_call_deltas(&mut pending, &json!({ "index": 0, "id": "" }));

        assert_eq!(pending[&0].id.as_deref(), Some("call_1"));
    }

    /// A missing index defaults to `0` rather than creating an unnamed entry — the source's
    /// `typeof o.index === "number" ? o.index : 0`.
    #[test]
    fn a_missing_index_defaults_to_zero() {
        let mut pending = PendingCalls::new();
        collect_tool_call_deltas(&mut pending, &json!({ "function": { "name": "solo" } }));

        assert_eq!(pending.len(), 1);
        assert_eq!(pending[&0].name.as_deref(), Some("solo"));
    }

    /// A non-object element is skipped without creating an entry — but an *array* is not skipped,
    /// because JavaScript's guard lets it through. See the module note.
    #[test]
    fn scalars_are_skipped_while_arrays_pass_the_guard() {
        let mut pending = PendingCalls::new();
        collect_tool_call_deltas(&mut pending, &json!([1, "two", null, true]));
        assert!(pending.is_empty(), "scalars must not create entries");

        collect_tool_call_deltas(&mut pending, &json!([["nested"]]));
        assert_eq!(pending.len(), 1, "an array passes the source's object guard");
        assert_eq!(pending[&0], PendingCall::default());
    }

    /// The flush order is by index, not by arrival — the divergence the module note records. The
    /// source's `Map` would yield `1` then `0`; this yields `0` then `1`.
    #[test]
    fn flush_order_is_by_index() {
        let mut pending = PendingCalls::new();
        collect_tool_call_deltas(
            &mut pending,
            &json!({ "index": 1, "function": { "name": "second" } }),
        );
        collect_tool_call_deltas(
            &mut pending,
            &json!({ "index": 0, "function": { "name": "first" } }),
        );

        let order: Vec<&str> = pending.values().filter_map(|c| c.name.as_deref()).collect();
        assert_eq!(order, ["first", "second"]);
    }

    // ---------- emit_tool_calls ----------

    fn collected(raw: &Value) -> Vec<ToolCall> {
        let mut out = Vec::new();
        emit_tool_calls(&mut |call| out.push(call), raw);
        out
    }

    #[test]
    fn reads_openai_shaped_calls() {
        let calls = collected(&json!([
            { "id": "call_1", "type": "function", "function": { "name": "lookup", "arguments": "{\"a\":1}" } },
        ]));

        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].id.as_deref(), Some("call_1"));
        assert_eq!(calls[0].name.as_deref(), Some("lookup"));
        assert_eq!(calls[0].arguments.as_deref(), Some("{\"a\":1}"));
        assert_eq!(
            calls[0].raw,
            Some(
                json!({ "id": "call_1", "type": "function", "function": { "name": "lookup", "arguments": "{\"a\":1}" } })
            )
        );
    }

    /// Anthropic is flat with `input` already an object, so the arguments are serialised back to
    /// JSON text — the shape carries a string because only the caller knows its own tool schema.
    #[test]
    fn reads_anthropic_shaped_calls_and_serialises_an_object_input() {
        let calls = collected(
            &json!([{ "id": "toolu_1", "type": "tool_use", "name": "lookup", "input": { "city": "Dhaka" } }]),
        );

        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name.as_deref(), Some("lookup"));
        assert_eq!(calls[0].arguments.as_deref(), Some("{\"city\":\"Dhaka\"}"));
    }

    /// A mixed `content` array — Anthropic's normal shape — yields only the tool blocks.
    #[test]
    fn a_text_block_in_a_mixed_array_is_not_a_call() {
        let calls = collected(&json!([
            { "type": "text", "text": "thinking out loud" },
            { "type": "tool_use", "name": "lookup", "input": {} },
        ]));

        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name.as_deref(), Some("lookup"));
    }

    /// An OpenAI entry carries no `type`, so the block-type filter must not reject it. This is the
    /// case that would break if the filter were written as a requirement rather than an exclusion.
    #[test]
    fn an_entry_without_a_type_passes_the_block_filter() {
        let calls = collected(&json!([{ "function": { "name": "lookup", "arguments": "{}" } }]));
        assert_eq!(calls.len(), 1);
    }

    /// `??` is nullish, so an `arguments` of `""` is a value and stops the fallback to `input`.
    /// A test with `arguments: null` would not catch the difference.
    #[test]
    fn an_empty_arguments_string_does_not_fall_back_to_input() {
        let calls = collected(
            &json!([{ "function": { "name": "n", "arguments": "", "input": { "a": 1 } } }]),
        );
        assert_eq!(calls[0].arguments.as_deref(), Some(""));
    }

    /// With `arguments` absent, `input` is used and serialised.
    #[test]
    fn a_missing_arguments_falls_back_to_input() {
        let calls = collected(&json!([{ "name": "n", "input": { "a": 1 } }]));
        assert_eq!(calls[0].arguments.as_deref(), Some("{\"a\":1}"));
    }

    /// Neither present leaves the arguments absent rather than `""` — the shape distinguishes them.
    #[test]
    fn neither_arguments_nor_input_leaves_the_arguments_absent() {
        let calls = collected(&json!([{ "name": "n" }]));
        assert_eq!(calls[0].arguments, None);
    }

    /// **The asymmetry with the streaming path, pinned.** An empty-string `id` survives here and is
    /// dropped by `collect_tool_call_deltas`, because the source spells one `typeof o.id ===
    /// "string"` and the other `&& o.id`.
    #[test]
    fn an_empty_id_survives_here_but_not_in_the_deltas() {
        let calls =
            collected(&json!([{ "id": "", "function": { "name": "", "arguments": "{}" } }]));
        assert_eq!(calls[0].id.as_deref(), Some(""));
        assert_eq!(calls[0].name.as_deref(), Some(""));

        let mut pending = PendingCalls::new();
        collect_tool_call_deltas(&mut pending, &json!({ "id": "", "function": { "name": "" } }));
        assert_eq!(pending[&0].id, None);
        assert_eq!(pending[&0].name, None);
    }

    /// A single object — not wrapped in an array — is treated as a one-element list, which is the
    /// source's `Array.isArray(raw) ? raw : [raw]`.
    #[test]
    fn a_bare_object_is_a_one_element_list() {
        assert_eq!(collected(&json!({ "name": "solo", "input": {} })).len(), 1);
        assert_eq!(collected(&Value::Null).len(), 0);
    }

    // ---------- ManifestHttpError ----------

    #[test]
    fn the_message_names_the_status_the_kind_and_the_body() {
        let e = ManifestHttpError::new(429, "slow down", FailureKind::Response, Some(30_000));
        assert_eq!(e.to_string(), "provider HTTP 429 (response): slow down");
    }

    /// The mid-stream kind is spelled with a hyphen, and the status is `200` there because the
    /// *request* succeeded and the *stream* broke.
    #[test]
    fn a_mid_stream_message_reads_mid_stream() {
        let e =
            ManifestHttpError::new(200, "{\"error\":\"bad chunk\"}", FailureKind::MidStream, None);
        assert_eq!(e.to_string(), "provider HTTP 200 (mid-stream): {\"error\":\"bad chunk\"}");
    }

    #[test]
    fn the_body_is_truncated_for_the_message() {
        let long = "x".repeat(MESSAGE_BODY_LIMIT + 500);
        let e = ManifestHttpError::new(500, long, FailureKind::Response, None);

        let message = e.to_string();
        assert!(message.ends_with(&"x".repeat(100)), "the tail must be gone");
        assert_eq!(message.len(), "provider HTTP 500 (response): ".len() + MESSAGE_BODY_LIMIT);
        // The full body is still held — only the message is truncated.
        assert_eq!(e.body.len(), MESSAGE_BODY_LIMIT + 500);
    }

    /// Truncation counts UTF-16 code units, so a body of astral characters is cut at half the
    /// *character* count — which is what `slice(0, 400)` does.
    #[test]
    fn truncation_counts_utf16_units_not_characters() {
        let astral = "😀".repeat(300); // 600 UTF-16 units, 300 characters
        let cut = truncate_for_message(&astral);

        assert_eq!(cut.chars().count(), 200, "400 units is 200 astral characters");
        assert_eq!(cut.encode_utf16().count(), MESSAGE_BODY_LIMIT);
    }

    /// A character that would straddle the limit is dropped whole rather than split — the closest a
    /// Rust string can get to a lone surrogate. This is the divergence the module note records.
    #[test]
    fn a_straddling_character_is_dropped_rather_than_split() {
        // 399 single-unit characters, then an astral pair whose high half lands on unit 400.
        let body = format!("{}😀{}", "a".repeat(399), "b".repeat(10));
        let cut = truncate_for_message(&body);

        assert_eq!(cut.encode_utf16().count(), 399);
        assert_eq!(cut, "a".repeat(399));
    }

    /// The projection the engine consumes keeps the three fields classification needs and drops the
    /// body — which is the whole reason the two types are different.
    #[test]
    fn the_engine_projection_drops_the_body_and_keeps_the_rest() {
        let e = ManifestHttpError::new(429, "slow down", FailureKind::MidStream, Some(1_000));
        let projected: AttemptError = (&e).into();

        assert_eq!(
            projected,
            AttemptError::Http {
                status: 429,
                kind: FailureKind::MidStream,
                retry_after_ms: Some(1_000)
            }
        );
    }
}
