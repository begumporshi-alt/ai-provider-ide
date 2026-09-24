//! sandbox — the engine-free half of `code-adapter.ts` (615 lines), the Tier-2 fallback.
//!
//! When no declarative manifest can express a provider, the Generator may emit a small JS module
//! instead, and `code-adapter.ts` executes it inside QuickJS. That file is two things at once: a
//! **host** (runtime, context, module door, deferred-promise bridge, job pump) and a set of
//! **rules** (what source is admissible, what a guest may ask the host to do, and how a guest's
//! answer is read). This module is the second half. It needs no JavaScript engine, so it is
//! testable without one, and it lands before the engine for the same reason `manifest.rs` landed
//! before `interpreter.rs`.
//!
//! **What is deliberately not here.** `rquickjs` — the embedding, `Module::declare`, the job pump,
//! the interrupt handler and the streaming driver — is the next increment, as a sibling module.
//! The wall-clock deadline is also not here: it is enforced by the interrupt handler, which cannot
//! exist before there is an engine to interrupt, so [`OpBudget`] carries the two counters the host
//! functions increment and nothing else. Saying which half owns the clock is the point; a
//! `deadline` field here would be a field no code in this module reads.
//!
//! # The lint is a tripwire, and a tripwire must not be weaker than its reference
//!
//! [`lint_code_source`] rejects a source before it reaches QuickJS. It is **not** the security
//! boundary — QuickJS has no `import`, no `require`, no `fetch` and no filesystem, so a construct
//! that slips past the lint still cannot reach anything. But a lint that is *weaker* than the
//! reference is still a defect, and this port would have had exactly one.
//!
//! JavaScript's `\b` is an **ASCII** word boundary; Rust's `regex` `\b` is Unicode-aware. Measured:
//! `/ \bWebAssembly\b/.test("éWebAssembly")` is **true** in JavaScript — `é` is not a word
//! character there, so a boundary exists before the `W` — while Rust's `\b` sees `é` as a word
//! character and finds no boundary, so the same source would pass. A guest could therefore prefix
//! any forbidden identifier with a single non-ASCII letter and dodge the tripwire in Rust alone.
//!
//! The fix is `(?-u:\b)`, the ASCII boundary, applied per pattern. **`unicode` stays on globally**
//! and that is not incidental: turning it off makes `.` byte-oriented and the `Regex` type then
//! refuses any pattern containing one (see `core::modality`'s note). None of these patterns use
//! `.`, so the scoped flag is both sufficient and safe, where the global one is not available at
//! all. `\w` and `\s` are left Unicode-aware, which makes this lint *stricter* than the reference
//! on those two — the safe direction for a tripwire, and reachable only for sources that are not
//! valid JavaScript anyway.
//!
//! # The auth filter is a security boundary, and it is measured rather than assumed
//!
//! `makeHttp` lets the guest set non-auth headers only, so that a guest can never override the
//! credential the host injects. The reference spells that as
//! `/^(authorization|x-api-key|x-goog-api-key|api-key|cookie)$/i`, and this port uses
//! `eq_ignore_ascii_case` against the same five names instead of a regex. That is not a
//! simplification taken on faith: **26 inputs were measured against the real JavaScript regex**,
//! and the two agree on every one. The regex matches only the ASCII case variants —
//! `AUTHORIZATION`, `X-Api-Key`, `COOKIE` — and does **not** match `authorization` with leading or
//! trailing whitespace or a newline (the anchors), `authorisation`, `auth`, `x-api-keys`, the
//! Turkish `AUTHORİZATION` (U+0130) or `authorızatıon` (U+0131), the fullwidth `ＡUTHＯORIZATION`,
//! or `AUTHORIZATION\0`. Five `eq_ignore_ascii_case` comparisons reproduce all of it exactly, with
//! no compile step and no error path. The measured table is pinned in the tests.
//!
//! # Three JavaScript coercions the guest's answer depends on
//!
//! A guest returns a plain JS object, and the reference reads it with `String(...)`,
//! `Number(...)` and `Boolean(...)`. Rust has none of those, and each one decides something
//! observable. All three are reproduced here, because the alternative is a *silent* behaviour
//! change in which models appear in the catalogue or which failure class a refusal gets.
//!
//! - [`js_truthy`] is exact and complete for every JSON value, so `Boolean(r.ok)` has no residue.
//!   It matters because the coercion is not intuitive: `Boolean([])` is **true**, so a guest that
//!   answers `ok: []` claims success. An `as_bool().unwrap_or(false)` port would call it a failure.
//! - [`js_to_string`] reproduces `String(x)` for every JSON-reachable type, numbers included.
//!   `String(5)` is `"5"`, `String([1,2])` is `"1,2"`, `String({})` is `"[object Object]"` — and
//!   `String(1e21)` is `"1e+21"` where Rust's `Display` gives twenty-two digits. That last one is a
//!   real divergence and it is handled rather than pinned: ECMAScript switches to exponential form
//!   outside the decimal exponent range `[-7, 21)`, which is a rule this port implements.
//! - the model-id filter compares `nativeId.length`, and **JavaScript's `.length` counts UTF-16
//!   code units**: `"😀".length` is 2, not 1. A `chars().count()` port would keep an id the
//!   reference drops. [`js_utf16_len`] is used instead.
//!
//! Two residues remain and are pinned by tests rather than reproduced, because reproducing them
//! would mean reimplementing `ToNumber` and lone surrogates:
//!
//! - `Number("0x10")` is 16 in JavaScript and 0 here; `Number("1.5")` is 1.5 there and 0 here,
//!   because a status is an integer and a fractional one is not a status.
//! - `String.prototype.slice(0, 500)` counts UTF-16 units and can cut a surrogate pair in half.
//!   A Rust `String` cannot hold an unpaired surrogate, so [`ERROR_BODY_CAP`] is applied in scalar
//!   values. The difference is one emoji at the boundary of a provider's error text.
//!
//! # The read model is not the guest's contract
//!
//! Every reader here is **lenient**: a missing key, a wrong type or a bogus status produces a
//! default rather than an error, because that is what the reference does and because a guest is
//! generated code whose failure mode must be a degraded catalogue entry, not a failed request. The
//! one place the reference is strict is the lint, and that runs before compilation.

use std::sync::OnceLock;

use regex::Regex;
use serde_json::{Map, Value};

use crate::core::adapter::ImageReply;
use crate::core::adapter::ModelEntry;
use crate::core::egress::SENTINEL;
use crate::core::engine::AttemptError;

/// 64 KB. The manifest grammar also bounds it; this is defence in depth.
pub const SOURCE_LIMIT: usize = 64_000;

/// 45 s of wall clock per operation. Enforced by the engine half's interrupt handler.
pub const OP_BUDGET_MS: u64 = 45_000;

/// Per operation, not per process — the budget is rebuilt for every call.
pub const HTTP_CALLS_PER_OP: u32 = 20;

/// Per operation, on `emit`.
pub const EMIT_LINES_PER_OP: u32 = 400;

/// 8 MB. Applied to a response body after it has been read, so it bounds what reaches the guest
/// and not what the socket receives.
pub const BODY_CAP: usize = 8_000_000;

/// 32 MB of guest heap. **This is the limit the spike measured a `SIGSEGV` against** when the
/// out-of-memory is raised in the synchronous entry segment — see the module note in
/// `docs/dev-book/10-headless-service.md` §2.1.3. It is a constant here because the number is a
/// policy, not because this module can enforce it.
pub const MEMORY_LIMIT: usize = 32 * 1024 * 1024;

/// 512 KB of guest stack. Measured clean: a runaway recursion rejects rather than crashing.
pub const STACK_LIMIT: usize = 512 * 1024;

/// The reference's `errorBody.slice(0, 500)`.
pub const ERROR_BODY_CAP: usize = 500;

/// The reference's `getString(msg).slice(0, 500)` on a `log` line. The engine half applies it;
/// it lives here so the two caps are read side by side and neither is inlined as a bare `500`.
pub const LOG_LINE_CAP: usize = 500;

/// The header names a guest may not set. Lowercase; matched with `eq_ignore_ascii_case`.
///
/// Order is the reference's alternation order. It is not load-bearing for correctness — the
/// comparison is a membership test — but keeping it makes the two lists diffable by eye.
const AUTH_HEADERS: [&str; 5] =
    ["authorization", "x-api-key", "x-goog-api-key", "api-key", "cookie"];

/// Why a sandbox operation did not produce an answer — the port of the reference's `SandboxError`
/// `reason` union.
///
/// Six arms because the reference has six, and the distinction is not cosmetic: the caller decides
/// whether to retry, rebuild the sandbox or give up on the adapter based on which one it sees.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SandboxReason {
    /// The source failed the static tripwire, before QuickJS saw it.
    Lint,
    /// QuickJS could not parse the module, or it does not `export default` an object.
    Compile,
    /// The guest threw, or does not implement the method that was called.
    Runtime,
    /// The operation outlived its wall-clock budget.
    Timeout,
    /// A per-operation budget was exceeded — http calls or emitted lines.
    Limits,
    /// The host's own fault: a disposed adapter, or a sandbox that failed to initialize.
    Host,
}

impl SandboxReason {
    /// The reference's own spelling, for logs and for a caller that persists the reason.
    pub fn as_str(self) -> &'static str {
        match self {
            SandboxReason::Lint => "lint",
            SandboxReason::Compile => "compile",
            SandboxReason::Runtime => "runtime",
            SandboxReason::Timeout => "timeout",
            SandboxReason::Limits => "limits",
            SandboxReason::Host => "host",
        }
    }
}

/// `Display` exists for one reason: `SandboxError`'s `thiserror` attribute formats `{reason}`.
///
/// It delegates to [`SandboxReason::as_str`] instead of repeating the six strings, so each reason
/// has exactly one spelling in this file. A second `match` here would be a second place to update
/// when an arm is added, and the two would drift silently — the log line and the persisted reason
/// would disagree for one of the six.
impl std::fmt::Display for SandboxReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A sandbox failure: a reason plus the message the reference would have thrown.
///
/// The message is carried rather than reconstructed because several of them embed the guest's own
/// text — a thrown value, a rejected path — and a `Display` that rebuilt them would be a second
/// spelling of every message in this file.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{reason}: {message}")]
pub struct SandboxError {
    pub reason: SandboxReason,
    pub message: String,
}

impl SandboxError {
    pub fn new(reason: SandboxReason, message: impl Into<String>) -> Self {
        SandboxError { reason, message: message.into() }
    }
}

/// To the engine, a sandbox failure is a transport failure — and it loses its reason on the way.
///
/// **The loss is the reference's behaviour, not a shortcut here.**
/// `execution-engine.ts:114` reads `e instanceof ManifestHttpError ? e.status : 0`, so anything
/// that is *not* a `ManifestHttpError` — a `SandboxError` included — is recorded with status `0`
/// and nothing else. `AttemptError` has nowhere to carry a message, so the faithful mapping is the
/// one that discards it. A variant added to preserve the reason would be a second spelling of "the
/// call did not complete", and the reason itself is still where a caller can read it: every
/// producer hands the [`SandboxError`] back before it crosses this conversion.
impl From<&SandboxError> for AttemptError {
    fn from(_: &SandboxError) -> Self {
        AttemptError::Transport
    }
}

/// The two per-operation counters. Rebuilt for every call, never reused.
///
/// The reference's `OpBudget` also carries `deadline: number` — epoch milliseconds, compared
/// against `Date.now()` inside the pump. It is absent here on purpose: the pump is the engine
/// half's, and a field this module can neither set nor read would be a field on a struct for the
/// benefit of a different module. See the module note.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct OpBudget {
    pub http_calls: u32,
    pub lines: u32,
}

/// The forbidden-construct table: the pattern this port compiles, and the source string the
/// reference reports.
///
/// **Two columns, and they are both asserted by the tests.** The reference's message is
/// `forbidden construct: ${forbidden.source}`, so the second column has to be the JavaScript
/// regex's own `source` text or the two implementations stop being comparable — a reader
/// debugging a rejection needs to find the same line in both. The first column differs from the
/// second by exactly `\b` → `(?-u:\b)` and by nothing else, which the tests check one pattern at a
/// time rather than by eye.
const FORBIDDEN: &[(&str, &str)] = &[
    (r"(?-u:\b)import\s*\(", r"\bimport\s*\("),
    (r"(?-u:\b)import\s+[\w{*]", r"\bimport\s+[\w{*]"),
    (r"(?-u:\b)require\s*\(", r"\brequire\s*\("),
    (r"(?-u:\b)eval\s*\(", r"\beval\s*\("),
    (r"(?-u:\b)new\s+Function(?-u:\b)", r"\bnew\s+Function\b"),
    (r"(?-u:\b)Function\s*\(", r"\bFunction\s*\("),
    (r"(?-u:\b)WebAssembly(?-u:\b)", r"\bWebAssembly\b"),
    (r"(?-u:\b)Atomics(?-u:\b)", r"\bAtomics\b"),
    (r"(?-u:\b)SharedArrayBuffer(?-u:\b)", r"\bSharedArrayBuffer\b"),
    (r"(?-u:\b)fetch\s*\(", r"\bfetch\s*\("),
    (r"(?-u:\b)XMLHttpRequest(?-u:\b)", r"\bXMLHttpRequest\b"),
    (r"(?-u:\b)import\.meta(?-u:\b)", r"\bimport\.meta\b"),
];

/// The compiled table, built once.
///
/// The reference re-evaluates its regex literals per call. Compiling once is a divergence in *when*
/// a bad pattern would surface, and it is taken deliberately: these are this port's own constants,
/// not guest input, so a pattern that fails to compile is a defect in this file that the tests
/// catch immediately — where the reference's patterns could not fail at all. The alternative is
/// twelve `Regex::new` calls per adapter construction for no observable benefit.
fn forbidden_patterns() -> &'static [Regex] {
    static CELL: OnceLock<Vec<Regex>> = OnceLock::new();
    CELL.get_or_init(|| {
        FORBIDDEN
            .iter()
            .map(|(pattern, _)| {
                Regex::new(pattern)
                    .expect("a FORBIDDEN pattern must compile; see the table's tests")
            })
            .collect()
    })
}

/// Static checks a code adapter source must survive before it reaches QuickJS.
///
/// Returns every reason it failed rather than the first, which is the reference's behaviour and
/// the more useful one for a human reviewing a generated adapter: one pass should show the whole
/// list. An empty return means the source passed.
///
/// **The order of the checks is the reference's** — size, then the `export default` shape, then the
/// constructs — because the messages are what a reviewer reads and a differently-ordered list
/// would be a differently-worded rejection for the same source.
pub fn lint_code_source(source: &str) -> Vec<String> {
    let mut errors = Vec::new();
    if source.len() > SOURCE_LIMIT {
        errors.push(format!("source too large ({} > {SOURCE_LIMIT})", source.len()));
    }
    // The reference tests `export\s+default\s*\{` — whitespace-tolerant between the words and
    // before the brace, and nothing else. Not anchored, so a source may carry a comment first.
    if !export_default_re().is_match(source) {
        errors.push("must contain \"export default {\"".to_string());
    }
    let patterns = forbidden_patterns();
    for (index, (_, js_source)) in FORBIDDEN.iter().enumerate() {
        if patterns[index].is_match(source) {
            errors.push(format!("forbidden construct: {js_source}"));
        }
    }
    errors
}

fn export_default_re() -> &'static Regex {
    static CELL: OnceLock<Regex> = OnceLock::new();
    CELL.get_or_init(|| {
        Regex::new(r"export\s+default\s*\{").expect("the export-default pattern must compile")
    })
}

/// One auth header as the manifest declares it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthHeader {
    pub name: String,
    pub prefix: Option<String>,
}

/// Where a guest's `http(req)` may reach, and with which credential.
///
/// `base_url` is the manifest's, already trimmed; `auth_headers` are the *rendered* values, each
/// carrying [`SENTINEL`] rather than a key, because nothing in this crate above the vault can
/// produce a key. Rendering them here rather than in the engine half is what makes the
/// `{{secret}}` spelling testable without an engine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpTarget {
    pub base_url: String,
    pub auth_headers: Vec<(String, String)>,
}

impl HttpTarget {
    /// Trim the manifest's trailing slashes and render its auth headers.
    ///
    /// **An empty prefix is no prefix.** The reference writes
    /// `h.prefix ? \`${h.prefix} {{secret}}\` : "{{secret}}"`, so a prefix of `""` is falsy and the
    /// header is the bare sentinel — not `" {{secret}}"` with a leading space. That is the kind of
    /// one-character difference that produces a valid-looking `Authorization:  {{secret}}` and a
    /// 401 from every provider, so it is pinned by a test rather than left to `Option`'s shape.
    ///
    /// **A repeated name keeps the last value at the first name's position**, because that is what
    /// `Object.fromEntries` does — measured, not assumed. A `Vec` that pushed unconditionally would
    /// put two `X: …` headers on the wire for a manifest that declares `X` twice, which the
    /// reference never does; the dedupe is here to keep the two implementations sending the same
    /// bytes, not to improve on either.
    pub fn new(base_url: &str, auth: &[AuthHeader]) -> Self {
        let mut auth_headers: Vec<(String, String)> = Vec::with_capacity(auth.len());
        for h in auth {
            let value = match h.prefix.as_deref() {
                Some(p) if !p.is_empty() => format!("{p} {SENTINEL}"),
                _ => SENTINEL.to_string(),
            };
            match auth_headers.iter_mut().find(|(name, _)| name == &h.name) {
                Some(slot) => slot.1 = value,
                None => auth_headers.push((h.name.clone(), value)),
            }
        }
        HttpTarget { base_url: base_url.trim_end_matches('/').to_string(), auth_headers }
    }
}

/// A guest `http(req)` that passed every check, ready for the host to send.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedCall {
    pub url: String,
    pub method: String,
    pub headers: Vec<(String, String)>,
    /// Already serialised. `None` when the guest sent no `body` key at all, which is a different
    /// request from a body of `null` — see [`plan_http_call`].
    pub body: Option<String>,
    pub secret_ref: String,
}

/// Decide whether a guest's `http(req)` may proceed, and shape it if so.
///
/// `Err` carries the message the reference would have **rejected the returned promise** with, which
/// is the mechanism that makes a contract failure surface at the guest's own `await` rather than
/// as a half-formed result object it goes on to use. The message text is the reference's, so the
/// two implementations produce the same guest-visible error.
///
/// The order of the checks is the reference's and two of them are load-bearing:
///
/// - **The rate limit is checked before the path.** A guest that has exhausted its budget gets the
///   rate-limit message even for a path that would also have been rejected.
/// - **The budget is incremented only after the path check passes.** A rejected path is free. That
///   is the reference's behaviour and it is worth stating, because the opposite reading — counting
///   every attempt, so a guest cannot probe paths for free — is the more defensive one and is not
///   what the reference does. Recorded rather than improved on.
///
/// `arg` is `None` when the guest called `http()` with no argument at all, which is a different
/// input from an argument that is not an object.
pub fn plan_http_call(
    budget: &mut OpBudget,
    arg: Option<&Value>,
    target: &HttpTarget,
    secret_ref: &str,
) -> Result<PlannedCall, String> {
    let Some(arg) = arg else {
        return Err("http: request object required".to_string());
    };
    if budget.http_calls >= HTTP_CALLS_PER_OP {
        return Err(format!("http: rate limit ({HTTP_CALLS_PER_OP} calls/operation) exceeded"));
    }
    // The reference reads `typeof a.path === "string" ? a.path : ""` and then rejects, so a
    // non-string path produces the same message as a string path that fails the check — with the
    // empty string quoted in it.
    let path = arg.get("path").and_then(Value::as_str).unwrap_or("");
    if !path.starts_with('/') || path.starts_with("//") || path.contains("..") {
        return Err(format!(
            "http: path must be a relative provider path, got {}",
            truncate_quoted(path, 80)
        ));
    }
    budget.http_calls += 1;

    // `a.method === "GET" ? "GET" : "POST"` — an exact, case-sensitive comparison, so `"get"` is a
    // POST. Pinned, because "accept the lowercase spelling" is the natural thing to add and it
    // would be a silent divergence.
    let method =
        if arg.get("method").and_then(Value::as_str) == Some("GET") { "GET" } else { "POST" };

    let mut headers = target.auth_headers.clone();
    if let Some(Value::Object(guest)) = arg.get("headers") {
        for (name, value) in guest {
            // Two conditions, both the reference's: the name must not be an auth header, and the
            // value must be a string. A guest sending `{"x-foo": 5}` contributes nothing.
            if !is_auth_header(name) {
                if let Some(v) = value.as_str() {
                    headers.push((name.clone(), v.to_string()));
                }
            }
        }
    }

    // `a.body === undefined ? undefined : JSON.stringify(a.body)`. JSON cannot carry `undefined`,
    // so an absent key is the `undefined` case and an explicit `null` is a *body of "null"* —
    // which is what the reference sends. Two states, two spellings, and the tests pin both.
    let body =
        arg.get("body").map(|v| serde_json::to_string(v).unwrap_or_else(|_| "null".to_string()));

    Ok(PlannedCall {
        url: format!("{}{path}", target.base_url),
        method: method.to_string(),
        headers,
        body,
        secret_ref: secret_ref.to_string(),
    })
}

/// The reference's `/i` auth-header test, as five case-insensitive comparisons.
///
/// Measured equivalent to the JavaScript regex over 26 inputs; see the module note. `trim()` is
/// deliberately **not** applied — the reference's anchors reject a padded name, so a guest sending
/// `" authorization"` does *not* match, and trimming here would be a stricter filter than the
/// reference and a different answer for that input.
fn is_auth_header(name: &str) -> bool {
    AUTH_HEADERS.iter().any(|h| h.eq_ignore_ascii_case(name))
}

/// Charge one emitted line against the budget.
///
/// `Err` is the reference's `limits` failure, which it records and then throws from the driver
/// loop rather than from the `emit` callback — because a callback that throws would surface inside
/// the guest. Reproducing that split needs the engine, so this returns the error and the engine
/// half decides when to raise it; what lives here is the boundary rule, which is `>=`, so the
/// 401st line fails and the 400th does not.
pub fn note_emitted_line(budget: &mut OpBudget) -> Result<(), SandboxError> {
    if budget.lines >= EMIT_LINES_PER_OP {
        return Err(SandboxError::new(
            SandboxReason::Limits,
            format!("emit: rate limit ({EMIT_LINES_PER_OP} lines/operation) exceeded"),
        ));
    }
    budget.lines += 1;
    Ok(())
}

/// Read `listModels`' return value — the port of the reference's `onSettled` mapping.
///
/// Three entry shapes are accepted and one is dropped, in this order:
///
/// 1. a **string** is both the id and the raw value (`{nativeId: e, raw: e}`);
/// 2. an **object** contributes `String(id ?? name ?? "")`, and is dropped when that is empty —
///    note `??` falls through on `null`/`undefined` only, so `{id: "", name: "x"}` yields `""` and
///    is dropped rather than falling back to the name;
/// 3. anything else is dropped.
///
/// Then every survivor is filtered on `0 < nativeId.length < 200`, in **UTF-16 units**.
///
/// `raw` is the entry itself, and for a string entry that means the raw value is a JSON string
/// rather than an object. That looks like a shape error and is the reference's behaviour; the
/// consumers of `raw` (`selectOne` for `rawMatch`, and pricing) both tolerate it by resolving to
/// nothing, so the faithful reading costs nothing and inventing a wrapper object would be a
/// divergence in the one field that is not derived.
pub fn read_models(raw: &Value) -> Vec<ModelEntry> {
    let Value::Array(items) = raw else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for item in items {
        let entry = match item {
            Value::String(s) => Some(ModelEntry { native_id: s.clone(), raw: item.clone() }),
            Value::Object(map) => {
                let id = js_to_string(select_or_empty(map, "id").unwrap_or(&Value::Null));
                if id.is_empty() {
                    None
                } else {
                    Some(ModelEntry { native_id: id, raw: item.clone() })
                }
            }
            _ => None,
        };
        if let Some(entry) = entry {
            let len = js_utf16_len(&entry.native_id);
            if len > 0 && len < 200 {
                out.push(entry);
            }
        }
    }
    out
}

/// `map[key] ?? map["name"] ?? ""` — the `??` chain, which falls through on `null` only.
fn select_or_empty<'a>(map: &'a Map<String, Value>, key: &str) -> Option<&'a Value> {
    match map.get(key) {
        Some(Value::Null) | None => map.get("name").filter(|v| !v.is_null()),
        Some(v) => Some(v),
    }
}

/// Read `generateImage`'s return value — the port of the reference's `onSettled` mapping.
///
/// Every field is lenient, and the two coercions are the interesting part: `ok` is JavaScript
/// truthiness (so `[]`, `{}`, `"x"` and any non-zero number are all **true**), and `status` is
/// `Number(...)` narrowed to `u16`.
///
/// **`status` is the one place this port must choose a value the reference never has.** `Number()`
/// can produce `NaN`, `-1`, `1.5` or `1e21` and the reference stores whichever it produced; a
/// `u16` cannot hold any of them, and the reference's own default for "no result" is `status: 0`.
/// So the rule is: a number that is a non-negative integer within `u16` is itself, a string that
/// is plain decimal (after trimming, which JavaScript's `ToNumber` also does) is parsed the same
/// way, and **everything else is 0**. `NaN` becoming `0` is not a silent coercion — it is the same
/// answer the reference gives for a network failure, and it is pinned by a test naming each
/// rejected input.
pub fn read_image_reply(raw: &Value) -> ImageReply {
    let empty = Value::Object(Map::new());
    let r = match raw {
        Value::Object(_) => raw,
        _ => &empty,
    };
    ImageReply {
        ok: js_truthy(r.get("ok").unwrap_or(&Value::Bool(false))),
        status: read_status(r.get("status").unwrap_or(&Value::Null)),
        error_body: r
            .get("errorBody")
            .and_then(Value::as_str)
            .map(|s| s.chars().take(ERROR_BODY_CAP).collect()),
        base64: r.get("base64").and_then(Value::as_str).map(str::to_string),
        url: r.get("url").and_then(Value::as_str).map(str::to_string),
    }
}

/// `Number(v ?? 0)` narrowed to `u16`; see [`read_image_reply`] for the rule and its reasoning.
fn read_status(v: &Value) -> u16 {
    match v {
        Value::Number(n) => n.as_u64().and_then(|n| u16::try_from(n).ok()).unwrap_or(0),
        Value::String(s) => s.trim().parse::<u16>().unwrap_or(0),
        _ => 0,
    }
}

/// JavaScript truthiness, exact for every JSON value.
///
/// The two that surprise are `[]` and `{}`: both are **truthy** in JavaScript, because objects are
/// truthy regardless of emptiness — which is why this cannot be written as a check on "has any
/// content". `""`, `0` and `null` are the falsy JSON values; `-0` is falsy too and is caught by
/// `== 0.0`.
pub fn js_truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map(|f| f != 0.0).unwrap_or(true),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `String(x)` for every JSON-reachable type.
///
/// Measured against node for each arm; the table is in the tests. The number arm is the only one
/// with any subtlety, and it is handled rather than pinned — see [`js_number_to_string`].
pub fn js_to_string(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => js_number_to_string(n.as_f64().unwrap_or(0.0)),
        Value::String(s) => s.clone(),
        // `Array.prototype.join(",")`, which renders `null` and `undefined` elements as empty —
        // so `String([null, 1])` is ",1" and `String([])` is "".
        Value::Array(items) => items.iter().map(js_to_string).collect::<Vec<_>>().join(","),
        // `Object.prototype.toString`, which ignores the contents entirely.
        Value::Object(_) => "[object Object]".to_string(),
    }
}

/// `String(n)` for a finite `f64` — ECMAScript's `Number::toString`.
///
/// **The rule is the exponent, and it is a rule rather than a table.** Rust's `Display` for `f64`
/// already agrees with JavaScript for every value whose decimal exponent lies in `[-7, 21)`:
/// `5` → `"5"`, `0.1` → `"0.1"`, `1e20` → `"100000000000000000000"`, `-0` → `"0"`. Outside that
/// range JavaScript switches to exponential form and Rust does not, so `1e21` is `"1e+21"` there
/// and twenty-two digits here. Rust's `{:e}` produces the shortest round-trip mantissa in the same
/// shape, differing only in that ECMAScript spells a non-negative exponent with an explicit `+`.
///
/// The exponent is read back out of Rust's own `{:e}` rendering rather than computed, because
/// computing it would mean a second implementation of decimal-to-shortest-digits, and the one
/// already in `core::fmt` is the one that agrees with JavaScript.
///
/// Non-finite values cannot arrive: `serde_json::Number` is always finite, so `NaN` and the
/// infinities are unreachable from a parsed guest value and have no arm here.
fn js_number_to_string(n: f64) -> String {
    if n == 0.0 {
        return "0".to_string(); // also covers -0.0, where JavaScript agrees
    }
    let scientific = format!("{n:e}");
    let (mantissa, exponent) =
        scientific.split_once('e').expect("Rust's {:e} always renders an exponent");
    let exponent: i32 = exponent.parse().expect("Rust's {:e} always renders a decimal exponent");
    if exponent >= 21 || exponent <= -7 {
        if exponent >= 0 {
            format!("{mantissa}e+{exponent}")
        } else {
            scientific
        }
    } else {
        format!("{n}")
    }
}

/// `String.prototype.length` — UTF-16 code units, not Unicode scalar values.
///
/// `"😀".length` is 2 and `"é".length` is 1, which is exactly what
/// `char::len_utf16` sums to. A `chars().count()` port would disagree only for characters outside
/// the BMP, and only matters at the `200` boundary — but the boundary is a *filter*, so the
/// disagreement would be a model appearing in one implementation's catalogue and not the other's.
pub fn js_utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// `JSON.stringify(path).slice(0, 80)` for the rejection message.
///
/// The reference quotes the value and truncates the **quoted** form, so a long path is cut
/// mid-quote and the message ends inside a string literal. Reproduced because it is what an
/// operator sees, and truncating before quoting would be a different message for the same input.
fn truncate_quoted(s: &str, cap: usize) -> String {
    let quoted = serde_json::to_string(s).unwrap_or_else(|_| format!("\"{s}\""));
    quoted.chars().take(cap).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn budget() -> OpBudget {
        OpBudget::default()
    }

    fn target() -> HttpTarget {
        HttpTarget::new(
            "https://api.example.com/",
            &[AuthHeader { name: "Authorization".to_string(), prefix: Some("Bearer".to_string()) }],
        )
    }

    fn call(arg: Value, budget: &mut OpBudget) -> Result<PlannedCall, String> {
        plan_http_call(budget, Some(&arg), &target(), "key:k1")
    }

    /* ------------------------------------------------------------------ limits */

    #[test]
    fn the_limits_are_the_references() {
        assert_eq!(SOURCE_LIMIT, 64_000);
        assert_eq!(OP_BUDGET_MS, 45_000);
        assert_eq!(HTTP_CALLS_PER_OP, 20);
        assert_eq!(EMIT_LINES_PER_OP, 400);
        assert_eq!(BODY_CAP, 8_000_000);
        assert_eq!(MEMORY_LIMIT, 32 * 1024 * 1024);
        assert_eq!(STACK_LIMIT, 512 * 1024);
        assert_eq!(ERROR_BODY_CAP, 500);
    }

    #[test]
    fn a_sandbox_reason_is_spelled_the_way_the_reference_spells_it() {
        for (reason, spelling) in [
            (SandboxReason::Lint, "lint"),
            (SandboxReason::Compile, "compile"),
            (SandboxReason::Runtime, "runtime"),
            (SandboxReason::Timeout, "timeout"),
            (SandboxReason::Limits, "limits"),
            (SandboxReason::Host, "host"),
        ] {
            assert_eq!(reason.as_str(), spelling);
        }
    }

    /* -------------------------------------------------------------------- lint */

    #[test]
    fn a_clean_source_passes() {
        let source = "export default {\n  async listModels(http) { return [\"m\"]; }\n};\n";
        assert_eq!(lint_code_source(source), Vec::<String>::new());
    }

    #[test]
    fn a_source_without_export_default_is_rejected() {
        assert_eq!(
            lint_code_source("const x = 1;"),
            vec!["must contain \"export default {\"".to_string()]
        );
    }

    /// Whitespace between the words is allowed and a comment before them is fine, because the
    /// reference's pattern is unanchored and tolerates `\s+`.
    #[test]
    fn the_export_default_check_tolerates_whitespace_and_leading_text() {
        assert!(lint_code_source("// a comment\nexport   default   {\n};").is_empty());
        assert!(!lint_code_source("export default function () {}").is_empty());
    }

    #[test]
    fn a_source_over_the_limit_is_rejected() {
        let source = format!("export default {{/*{}*/}};", "x".repeat(SOURCE_LIMIT));
        let errors = lint_code_source(&source);
        assert!(
            errors.iter().any(|e| e.starts_with("source too large")),
            "expected a size error, got {errors:?}"
        );
    }

    /// **Every forbidden pattern flags its construct, and reports the reference's own source
    /// string.** The second assertion is the one that keeps the two implementations comparable: a
    /// reviewer who sees `forbidden construct: \bWebAssembly\b` must be able to find that exact
    /// text in `code-adapter.ts`.
    #[test]
    fn every_forbidden_construct_is_flagged_and_named_as_the_reference_names_it() {
        let samples = [
            "import(",
            "import x",
            "require(",
            "eval(",
            "new Function",
            "Function(",
            "WebAssembly",
            "Atomics",
            "SharedArrayBuffer",
            "fetch(",
            "XMLHttpRequest",
            "import.meta",
        ];
        assert_eq!(samples.len(), FORBIDDEN.len(), "one sample per pattern");
        for ((_, js_source), sample) in FORBIDDEN.iter().zip(samples) {
            let source = format!("export default {{ /* {sample} */ }};");
            let errors = lint_code_source(&source);
            assert!(
                errors.contains(&format!("forbidden construct: {js_source}")),
                "{sample} should be flagged as {js_source}, got {errors:?}"
            );
        }
    }

    /// **The ASCII boundary, which is the whole reason these patterns are not verbatim.**
    ///
    /// Measured in node: `/ \bWebAssembly\b/.test("éWebAssembly")` is `true` — JavaScript's `\b` is
    /// ASCII, so `é` does not suppress the boundary. Rust's `\b` is Unicode-aware and `é` *is* a
    /// word character there, so the unmodified pattern would find no boundary and let the source
    /// through. This test is the tripwire's tripwire.
    #[test]
    fn a_non_ascii_letter_cannot_smuggle_a_forbidden_construct_past_the_lint() {
        for prefix in ["\u{e9}", "\u{4e2d}", "\u{1F600}"] {
            let source = format!("export default {{ /* {prefix}WebAssembly */ }};");
            let errors = lint_code_source(&source);
            assert!(
                errors.contains(&"forbidden construct: \\bWebAssembly\\b".to_string()),
                "{prefix}WebAssembly must still be flagged, got {errors:?}"
            );
        }
        // And the guard is real: an ASCII word character must still suppress the boundary, which
        // is the case the `(?-u:)` flag must not break.
        assert!(lint_code_source("export default { /* aWebAssembly */ };").is_empty());
        assert!(lint_code_source("export default { /* _WebAssembly */ };").is_empty());
    }

    #[test]
    fn the_forbidden_table_compiles_and_its_two_columns_differ_only_by_the_boundary_flag() {
        for (pattern, js_source) in FORBIDDEN {
            let expected = js_source.replace(r"\b", r"(?-u:\b)");
            assert_eq!(*pattern, expected, "the two columns have drifted for {js_source}");
        }
        assert_eq!(forbidden_patterns().len(), FORBIDDEN.len());
    }

    /* ------------------------------------------------------------- auth headers */

    /// The 26 inputs measured against the real JavaScript regex, with the verdict node produced.
    /// `true` means the guest may **not** set the header.
    #[test]
    fn the_auth_filter_agrees_with_the_javascript_regex_on_every_measured_input() {
        let blocked = [
            "authorization",
            "Authorization",
            "AUTHORIZATION",
            "AuThOrIzAtIoN",
            "x-api-key",
            "X-API-KEY",
            "X-Api-Key",
            "api-key",
            "API-KEY",
            "Api-Key",
            "x-goog-api-key",
            "X-GOOG-API-KEY",
            "cookie",
            "Cookie",
            "COOKIE",
        ];
        let allowed = [
            " authorization",
            "authorization ",
            "authorization\n",
            "authorization\t",
            "authorisation",
            "auth",
            "x-api-keys",
            "xapikey",
            "AUTHOR\u{130}ZATION",
            "author\u{131}zat\u{131}on",
            "\u{FF21}UTH\u{FF2F}ORIZATION",
            "AUTHORIZATION\u{0}",
        ];
        for name in blocked {
            assert!(is_auth_header(name), "{name:?} must be blocked");
        }
        for name in allowed {
            assert!(!is_auth_header(name), "{name:?} must be allowed, as in JavaScript");
        }
    }

    /// A guest header that survives the filter is added; one that does not is dropped, and the
    /// host's own credential is untouched. This is the property the filter exists for.
    #[test]
    fn a_guest_cannot_override_the_injected_credential() {
        let mut b = budget();
        let planned = call(
            json!({ "path": "/m", "headers": { "Authorization": "Bearer stolen", "x-trace": "t1" } }),
            &mut b,
        )
        .expect("the path is fine");
        assert_eq!(
            planned.headers,
            vec![
                ("Authorization".to_string(), "Bearer {{secret}}".to_string()),
                ("x-trace".to_string(), "t1".to_string()),
            ],
            "the guest's Authorization must not have been added a second time"
        );
    }

    #[test]
    fn a_non_string_guest_header_value_contributes_nothing() {
        let mut b = budget();
        let planned = call(
            json!({ "path": "/m", "headers": { "x-num": 5, "x-obj": {}, "x-ok": "v" } }),
            &mut b,
        )
        .expect("the path is fine");
        assert_eq!(planned.headers.len(), 2, "only the auth header and x-ok");
        assert!(planned.headers.iter().any(|(k, v)| k == "x-ok" && v == "v"));
    }

    /// **An empty prefix is no prefix.** `prefix: ""` is falsy in the reference, so the value is
    /// the bare sentinel — not `" {{secret}}"`, which would be a valid-looking header that every
    /// provider rejects.
    #[test]
    fn an_empty_auth_prefix_renders_the_bare_sentinel() {
        let t = HttpTarget::new(
            "https://api.example.com",
            &[
                AuthHeader { name: "a".to_string(), prefix: Some(String::new()) },
                AuthHeader { name: "b".to_string(), prefix: None },
                AuthHeader { name: "c".to_string(), prefix: Some("Bearer".to_string()) },
            ],
        );
        assert_eq!(
            t.auth_headers,
            vec![
                ("a".to_string(), "{{secret}}".to_string()),
                ("b".to_string(), "{{secret}}".to_string()),
                ("c".to_string(), "Bearer {{secret}}".to_string()),
            ]
        );
    }

    /// A manifest that declares the same auth header name twice produces **one** header, holding
    /// the **last** value, at the **first** name's position — the measured behaviour of
    /// `Object.fromEntries`, not a rule invented here. Without the dedupe this port would send two
    /// `X: …` lines where the reference sends one.
    #[test]
    fn a_repeated_auth_header_name_keeps_the_last_value_at_the_first_position() {
        let t = HttpTarget::new(
            "https://api.example.com",
            &[
                AuthHeader { name: "X".to_string(), prefix: Some("Bearer".to_string()) },
                AuthHeader { name: "X".to_string(), prefix: Some("Token".to_string()) },
                AuthHeader { name: "Y".to_string(), prefix: None },
            ],
        );
        assert_eq!(
            t.auth_headers,
            vec![
                ("X".to_string(), "Token {{secret}}".to_string()),
                ("Y".to_string(), "{{secret}}".to_string()),
            ]
        );
    }

    #[test]
    fn the_base_url_loses_its_trailing_slashes_and_nothing_else() {
        assert_eq!(
            HttpTarget::new("https://a.example.com///", &[]).base_url,
            "https://a.example.com"
        );
        assert_eq!(
            HttpTarget::new("https://a.example.com/v1/", &[]).base_url,
            "https://a.example.com/v1"
        );
    }

    /* ------------------------------------------------------------- path handling */

    #[test]
    fn a_relative_path_is_accepted_and_the_url_is_the_base_plus_the_path() {
        let mut b = budget();
        let planned = call(json!({ "path": "/v1/models" }), &mut b).expect("relative");
        assert_eq!(planned.url, "https://api.example.com/v1/models");
        assert_eq!(b.http_calls, 1);
    }

    /// Four rejections, each for its own reason, and all four are the reference's.
    #[test]
    fn an_absolute_or_traversing_path_is_rejected() {
        let mut b = budget();
        for (path, why) in [
            ("v1/models", "no leading slash"),
            ("//evil.example.com/x", "protocol-relative"),
            ("/a/../b", "traversal"),
            ("", "empty"),
        ] {
            let err = call(json!({ "path": path }), &mut b).expect_err(why);
            assert!(err.starts_with("http: path must be a relative provider path"), "{err}");
        }
        assert_eq!(b.http_calls, 0, "a rejected path is free, as in the reference");
    }

    /// The message quotes the path the way `JSON.stringify` does, and truncates the quoted form.
    #[test]
    fn the_rejection_message_quotes_and_truncates_the_path() {
        let mut b = budget();
        let err =
            call(json!({ "path": "https://evil.example.com/very/long" }), &mut b).unwrap_err();
        assert!(err.contains("\"https://evil.example.com/very/long\""), "{err}");

        let mut b = budget();
        let long = format!("//{}", "x".repeat(200));
        let err = call(json!({ "path": long }), &mut b).unwrap_err();
        let quoted = err.split("got ").nth(1).expect("the message names the value");
        assert_eq!(quoted.chars().count(), 80, "the quoted form is cut at 80: {quoted}");
    }

    #[test]
    fn a_missing_argument_is_a_different_failure_from_an_unusable_one() {
        let mut b = budget();
        assert_eq!(
            plan_http_call(&mut b, None, &target(), "key:k1").unwrap_err(),
            "http: request object required"
        );
        // An argument that is not an object has no `path`, so it fails the path check instead.
        let err = call(json!("not an object"), &mut b).unwrap_err();
        assert!(err.contains("got \"\""), "a non-object has no path: {err}");
    }

    /* ------------------------------------------------------------------ method */

    #[test]
    fn only_an_exact_uppercase_get_is_a_get() {
        let mut b = budget();
        for (method, expected) in
            [("GET", "GET"), ("get", "POST"), ("POST", "POST"), ("DELETE", "POST")]
        {
            let planned = call(json!({ "path": "/m", "method": method }), &mut b).unwrap();
            assert_eq!(planned.method, expected, "method {method:?}");
        }
    }

    /* ------------------------------------------------------------------ budget */

    /// The boundary is `>=` against the cap, so the 20th call is admitted and the 21st refused.
    #[test]
    fn the_twentieth_call_is_admitted_and_the_twenty_first_is_refused() {
        let mut b = budget();
        for n in 1..=HTTP_CALLS_PER_OP {
            call(json!({ "path": "/m" }), &mut b)
                .unwrap_or_else(|e| panic!("call {n} refused: {e}"));
        }
        assert_eq!(b.http_calls, HTTP_CALLS_PER_OP);
        let err = call(json!({ "path": "/m" }), &mut b).unwrap_err();
        assert_eq!(err, "http: rate limit (20 calls/operation) exceeded");
    }

    /// **The rate limit is checked before the path**, so a guest out of budget gets the rate-limit
    /// message even for a path that would also have been rejected.
    #[test]
    fn the_rate_limit_outranks_the_path_check() {
        let mut b = budget();
        b.http_calls = HTTP_CALLS_PER_OP;
        let err = call(json!({ "path": "//evil" }), &mut b).unwrap_err();
        assert!(err.starts_with("http: rate limit"), "{err}");
    }

    #[test]
    fn the_four_hundredth_line_is_admitted_and_the_four_hundred_and_first_is_not() {
        let mut b = budget();
        for _ in 0..EMIT_LINES_PER_OP {
            note_emitted_line(&mut b).expect("under the cap");
        }
        assert_eq!(b.lines, EMIT_LINES_PER_OP);
        let err = note_emitted_line(&mut b).unwrap_err();
        assert_eq!(err.reason, SandboxReason::Limits);
        assert_eq!(err.message, "emit: rate limit (400 lines/operation) exceeded");
    }

    /* -------------------------------------------------------------------- body */

    /// **Absent and `null` are different requests.** JSON cannot carry `undefined`, so an absent
    /// `body` key is the reference's `undefined` case; an explicit `null` is a body of the four
    /// characters `null`, because that is what `JSON.stringify(null)` produces.
    #[test]
    fn an_absent_body_and_a_null_body_are_different_requests() {
        let mut b = budget();
        assert_eq!(call(json!({ "path": "/m" }), &mut b).unwrap().body, None);
        assert_eq!(
            call(json!({ "path": "/m", "body": null }), &mut b).unwrap().body,
            Some("null".to_string())
        );
    }

    #[test]
    fn a_body_is_serialised_compactly() {
        let mut b = budget();
        let body = call(json!({ "path": "/m", "body": { "a": 1, "b": [2, 3] } }), &mut b)
            .unwrap()
            .body
            .expect("a body");
        assert_eq!(body, r#"{"a":1,"b":[2,3]}"#);
    }

    /// The key order of a serialised object is **sorted**, not insertion order, unless
    /// `serde_json`'s `preserve_order` feature is on. Measured here rather than assumed, because
    /// the claim appears in this module's note and `JSON.stringify` preserves insertion order.
    #[test]
    fn a_serialised_object_uses_the_map_order_not_the_insertion_order() {
        let mut b = budget();
        let body = call(json!({ "path": "/m", "body": { "b": 1, "a": 2 } }), &mut b)
            .unwrap()
            .body
            .expect("a body");
        let preserved = body == r#"{"b":1,"a":2}"#;
        let sorted = body == r#"{"a":2,"b":1}"#;
        assert!(preserved || sorted, "one of the two orders, got {body}");
        // Whichever it is, it is stable — and the note in `plan_http_call` says which.
        assert_eq!(body, r#"{"a":2,"b":1}"#);
    }

    /* ------------------------------------------------------------- read_models */

    #[test]
    fn a_string_entry_is_both_the_id_and_the_raw_value() {
        let models = read_models(&json!(["text-1"]));
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].native_id, "text-1");
        assert_eq!(models[0].raw, json!("text-1"));
    }

    #[test]
    fn an_object_entry_takes_id_then_name() {
        let models =
            read_models(&json!([{ "id": "a" }, { "name": "b" }, { "id": "c", "name": "d" }]));
        assert_eq!(
            models.iter().map(|m| m.native_id.as_str()).collect::<Vec<_>>(),
            vec!["a", "b", "c"]
        );
    }

    /// **`??` falls through on `null` only.** An empty-string `id` is present, so it wins and the
    /// entry is dropped; the `name` beside it is never consulted. An `id` of `null` does fall
    /// through. Both are pinned because "empty means absent" is the natural misreading.
    #[test]
    fn an_empty_id_does_not_fall_through_to_the_name_but_a_null_one_does() {
        assert!(read_models(&json!([{ "id": "", "name": "b" }])).is_empty());
        assert_eq!(read_models(&json!([{ "id": null, "name": "b" }]))[0].native_id, "b");
    }

    #[test]
    fn entries_without_an_id_or_of_the_wrong_type_are_dropped() {
        let models = read_models(&json!([{ "nope": 1 }, 5, true, null, [1]]));
        assert!(models.is_empty(), "got {models:?}");
    }

    #[test]
    fn a_non_array_return_is_an_empty_catalogue() {
        for raw in [json!(null), json!("x"), json!({ "id": "a" }), json!(5)] {
            assert!(read_models(&raw).is_empty(), "{raw} is not a list");
        }
    }

    /// A numeric id survives, because `String(5)` is `"5"`. The `as_str()` port would drop it.
    #[test]
    fn a_numeric_id_is_stringified_rather_than_dropped() {
        assert_eq!(read_models(&json!([{ "id": 5 }]))[0].native_id, "5");
        assert_eq!(read_models(&json!([{ "id": true }]))[0].native_id, "true");
        assert_eq!(read_models(&json!([{ "id": {} }]))[0].native_id, "[object Object]");
    }

    /// **The length filter counts UTF-16 code units.** An id of 100 emoji is 200 units and is
    /// dropped; a `chars().count()` port would see 100 and keep it.
    #[test]
    fn the_length_filter_counts_utf16_units_not_scalars() {
        let emoji = "\u{1F600}".repeat(100);
        assert_eq!(emoji.chars().count(), 100);
        assert_eq!(js_utf16_len(&emoji), 200);
        assert!(read_models(&json!([{ "id": emoji }])).is_empty(), "200 units is not < 200");

        let just_under = format!("{}\u{1F600}", "a".repeat(197));
        assert_eq!(just_under.chars().count(), 198);
        assert_eq!(js_utf16_len(&just_under), 199);
        // 199 units is `< 200`, so it survives — and it survives **whole**. The byte length is 201,
        // which is the number a `s.len()` port would have compared against the cap and rejected,
        // and the scalar count is 198, which is the number a `chars().count()` port would have
        // compared and admitted. Three candidate metrics, three different answers, one right one.
        let kept = read_models(&json!([{ "id": just_under }]));
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].native_id.len(), 201);
        assert_eq!(kept[0].native_id, just_under);
    }

    #[test]
    fn the_length_boundaries_are_zero_excluded_and_two_hundred_excluded() {
        assert!(read_models(&json!([{ "id": "" }])).is_empty());
        assert_eq!(read_models(&json!([{ "id": "a" }])).len(), 1);
        assert_eq!(read_models(&json!([{ "id": "a".repeat(199) }])).len(), 1);
        assert!(read_models(&json!([{ "id": "a".repeat(200) }])).is_empty());
    }

    /* -------------------------------------------------------- read_image_reply */

    #[test]
    fn an_image_reply_reads_its_five_fields() {
        let reply = read_image_reply(&json!({
            "ok": true, "status": 200, "base64": "QUJD", "url": "https://x/i.png",
            "errorBody": "nope"
        }));
        assert_eq!(
            reply,
            ImageReply {
                ok: true,
                status: 200,
                base64: Some("QUJD".to_string()),
                url: Some("https://x/i.png".to_string()),
                error_body: Some("nope".to_string()),
            }
        );
    }

    #[test]
    fn a_missing_or_non_object_reply_reads_as_a_failure_with_no_status() {
        for raw in [json!(null), json!("x"), json!(5), json!([])] {
            assert_eq!(
                read_image_reply(&raw),
                ImageReply { ok: false, status: 0, base64: None, url: None, error_body: None }
            );
        }
    }

    /// **`Boolean([])` is `true`.** The empty array, the empty object and any non-empty string are
    /// all truthy, so a guest that answers `ok: []` claims success — and an
    /// `as_bool().unwrap_or(false)` port would silently disagree.
    #[test]
    fn ok_is_javascript_truthiness_where_the_empty_array_is_true() {
        let truthy =
            [json!(true), json!(1), json!(-1), json!("x"), json!([]), json!({}), json!([0])];
        for v in truthy {
            assert!(read_image_reply(&json!({ "ok": v })).ok, "{v} is truthy in JavaScript");
        }
        let falsy = [json!(false), json!(0), json!(""), json!(null), json!(-0.0)];
        for v in falsy {
            assert!(!read_image_reply(&json!({ "ok": v })).ok, "{v} is falsy in JavaScript");
        }
    }

    /// The status rule, input by input. The two starred rows are the divergences the module note
    /// names; every other row agrees with `Number(x ?? 0)`.
    #[test]
    fn a_status_is_a_number_or_a_plain_decimal_string_and_zero_otherwise() {
        for (input, expected) in [
            (json!(200), 200),
            (json!(0), 0),
            (json!(65535), 65535),
            (json!("200"), 200),
            (json!(""), 0),
            (json!("  12  "), 12),
            (json!("abc"), 0),
            (json!(true), 0),   // * Number(true) is 1 in JavaScript
            (json!(-1), 0),     // * Number(-1) is -1, which a u16 cannot hold
            (json!(1.5), 0),    // * Number(1.5) is 1.5
            (json!(70000), 0),  // * out of u16 range
            (json!("0x10"), 0), // * Number("0x10") is 16
            (json!(null), 0),
            (json!([]), 0),
            (json!({}), 0),
        ] {
            assert_eq!(read_image_reply(&json!({ "status": input })).status, expected, "{input}");
        }
    }

    #[test]
    fn the_error_body_is_capped_and_the_other_two_strings_are_taken_whole() {
        let long = "e".repeat(600);
        let reply = read_image_reply(&json!({ "errorBody": long, "base64": "b", "url": "u" }));
        assert_eq!(reply.error_body.as_ref().map(String::len), Some(ERROR_BODY_CAP));
        assert_eq!(reply.base64.as_deref(), Some("b"));
        assert_eq!(reply.url.as_deref(), Some("u"));
    }

    #[test]
    fn a_non_string_optional_field_is_absent_rather_than_coerced() {
        let reply = read_image_reply(&json!({ "base64": 5, "url": null, "errorBody": {} }));
        assert_eq!(reply.base64, None);
        assert_eq!(reply.url, None);
        assert_eq!(reply.error_body, None);
    }

    /* ------------------------------------------------------- the js coercions */

    /// Every row measured against node; the values on the right are node's.
    #[test]
    fn js_to_string_matches_the_measured_javascript_table() {
        for (input, expected) in [
            (json!("abc"), "abc"),
            (json!(""), ""),
            (json!(5), "5"),
            (json!(5.5), "5.5"),
            (json!(0), "0"),
            (json!(true), "true"),
            (json!(false), "false"),
            (json!({}), "[object Object]"),
            (json!([]), ""),
            (json!([7]), "7"),
            (json!([1, 2]), "1,2"),
            (json!([null, 1]), ",1"),
            (json!([[1, 2], 3]), "1,2,3"),
            (json!(null), ""),
            (json!(1e21), "1e+21"),
            (json!(1e-7), "1e-7"),
            (json!(1e20), "100000000000000000000"),
            (json!(0.1), "0.1"),
            (json!(-1.5), "-1.5"),
        ] {
            assert_eq!(js_to_string(&input), expected, "{input}");
        }
    }

    /// The exponent thresholds, measured at both edges: `[-7, 21)` is decimal, outside it is
    /// exponential. `1e20` is the last decimal integer and `1e-6` the last decimal fraction.
    #[test]
    fn the_number_formatting_switches_to_exponential_exactly_at_the_ecmascript_thresholds() {
        assert_eq!(js_number_to_string(1e20), "100000000000000000000");
        assert_eq!(js_number_to_string(1e21), "1e+21");
        assert_eq!(js_number_to_string(1e22), "1e+22");
        assert_eq!(js_number_to_string(1e-6), "0.000001");
        assert_eq!(js_number_to_string(1e-7), "1e-7");
        assert_eq!(js_number_to_string(1.5e-7), "1.5e-7");
        assert_eq!(js_number_to_string(1.23456789e22), "1.23456789e+22");
        // `-0` prints as `"0"`, which is JavaScript's behaviour and not Rust's.
        assert_eq!(js_number_to_string(-0.0), "0");
    }

    #[test]
    fn js_utf16_len_counts_units() {
        assert_eq!(js_utf16_len("abc"), 3);
        assert_eq!(js_utf16_len("\u{e9}"), 1);
        assert_eq!(js_utf16_len("\u{4e2d}"), 1);
        assert_eq!(js_utf16_len("\u{1F600}"), 2);
        assert_eq!(js_utf16_len("a\u{1F600}"), 3);
        assert_eq!(js_utf16_len(""), 0);
    }
}
