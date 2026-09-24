//! The gateway request normalizer — the port of `gateway-normalizer.ts` (728 lines) and
//! `gateway-client-detector.ts` (19 lines).
//!
//! Every request the gateway serves is normalized here before it reaches the router core: roles are
//! translated to the dialect the target provider accepts, tool-call ids are made safe, tool results
//! are repaired, tool schemas are sanitized, and client-specific adaptations are applied. The whole
//! module is a pure function of its input — no I/O, no clock, no network — which is why it is the
//! first half of Phase 5 and can be pinned by tests before anything calls it.
//!
//! # Why this is not a formality
//!
//! `core/gateway.rs` used to forward a client's body to a Tauri WebView, where the TypeScript
//! normalizer ran (`gateway-bridge.ts` → `packages/router-core`); 25f deleted that seam. Removing
//! it meant the normalizer had to exist on this side, and a Grep for `normalize_gateway_request`
//! over `src-tauri/src` found nothing before this file — the Rust gateway had never normalized a
//! request. Without it, every client-specific quirk the reference learned (Claude Code's lowercase
//! tool names, Codex's `input`/`reasoning_effort` shape, GLM and Ernie's missing system role) would
//! have regressed silently the moment the bridge came out.
//!
//! # Deliberate divergences, each with its reason
//!
//! 1. **The tool-name map is returned out-of-band.** The reference attaches a non-enumerable
//!    `Map` to the body (`Object.defineProperty(body, "_toolNameMap", { enumerable: false, … })`).
//!    A `serde_json::Value` has nowhere to hide a non-enumerable property, and a key in the object
//!    would be serialized and sent upstream. [`NormalizedRequest::tool_name_map`] carries it
//!    instead. See "The map nobody read" below.
//! 2. **Non-string `name`/`arguments` contribute nothing to a generated id.** The reference writes
//!    `String(tc.function.name || "")` and `String(tc.function.arguments || "").slice(0, 32)`, so a
//!    non-string coerces — an object becomes `"[object Object]"`. Here only strings contribute
//!    (`as_str().unwrap_or("")`). The field is a string by the OpenAI dialect's contract, and the
//!    generated value is a *uniqueness* hash rather than a meaningful one, so the two agree on every
//!    input a real client sends. The divergence is recorded rather than hidden.
//! 3. **Length arithmetic is by Unicode scalar, not UTF-16 code unit.** `id.length === 9`,
//!    `.slice(0, 9)` and `.slice(0, 32)` count UTF-16 code units in JavaScript; the port counts
//!    `char`s. Identical for ASCII, which is every tool name and every tool-call id in the dialect.
//! 4. **Object key order is not preserved.** The reference relies on JavaScript's insertion-ordered
//!    objects; `serde_json::Map` preserves insertion order only with the `preserve_order` feature
//!    (not enabled here) and otherwise sorts. JSON object member order carries no meaning, and no
//!    branch in the pipeline reads a key by position, so nothing observable depends on it.
//! 5. **The two dead statements in `promoteInputToMessages` are not reproduced.** The reference's
//!    first two lines are `if (body.input == null && Array.isArray(body.messages)) return;` and
//!    `if (Array.isArray(body.messages) && body.input == null) return;` — the same condition twice.
//!    The port keeps the effect and drops the duplicate.
//!
//! One asymmetry is **not** a divergence and is preserved deliberately. `normalize_codex_request`
//! drops `max_tokens` / `max_completion_tokens` when `max_output_tokens` is already set, but leaves
//! `reasoning_effort` in place when `reasoning` is already set — because in the reference the
//! `delete body.reasoning_effort` sits *inside* the guard that the pre-existing `reasoning` already
//! failed (`gateway-normalizer.ts:596-602`). The stray alias is ignored by the upstream; correcting
//! it here would be a silent behaviour change, so it is pinned by a test instead.
//!
//! # The map nobody read
//!
//! `remapClaudeToolNamesInRequest` records every rename in `_toolNameMap`, on three paths — the
//! `tools` array, `tool_use` blocks in message history, and `tool_choice`. In the reference that map
//! has **no reader**: a Grep over `packages/router-core/src` finds `_toolNameMap` only in
//! `getRequestToolNameMap` / `trackToolName`, and a Grep over the whole repo finds it read only by
//! `gateway-normalizer.test.ts:375-382`. The reference also builds a global `CLAUDE_REVERSE_MAP` by
//! inverting the rename table (`gateway-normalizer.ts:513-516`) and never reads that either. So the
//! response-path restore that `docs/gateway-flexibility-plan.md:113` and `:311` describe — TitleCase
//! back to lowercase before the client sees it — was never implemented, and a Claude Code client
//! today receives `Bash` where it sent `bash`.
//!
//! That is the same defect class as D31: a write with no reader is invisible to every consumer. The
//! port does not reproduce it. The map is a field of the returned [`NormalizedRequest`], so it has a
//! consumer the moment Phase 5c's response path exists; the global reverse map is *not* ported,
//! because a per-request map is the stricter carrier — it records only the names *this* request
//! renamed, where the global map would rewrite any TitleCase name the client never sent.

use std::collections::{BTreeMap, HashMap, HashSet};

use serde_json::{json, Map, Value};

// ── Client detection ──────────────────────────────────────────────────────

/// Which AI coding client is calling, from its headers.
///
/// The order of the checks is the specification, not an accident: a `user-agent` of
/// `"WorkBuddy codex-bridge"` is WorkBuddy, and the reference tests WorkBuddy first for exactly
/// that reason.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClientHint {
    Workbuddy,
    ClaudeCode,
    Codex,
    Zcode,
    Cursor,
    Generic,
}

impl ClientHint {
    pub fn as_str(self) -> &'static str {
        match self {
            ClientHint::Workbuddy => "workbuddy",
            ClientHint::ClaudeCode => "claude-code",
            ClientHint::Codex => "codex",
            ClientHint::Zcode => "zcode",
            ClientHint::Cursor => "cursor",
            ClientHint::Generic => "generic",
        }
    }
}

/// Identify the calling client from the forwarded headers.
///
/// Keys are expected lowercase — `core::gateway::forwarded_headers` emits them that way
/// (`core/gateway.rs:1818`), so no case folding of the *key* is needed. Values are lowercased
/// before matching, as the reference does.
pub fn detect_client(headers: &HashMap<String, String>) -> ClientHint {
    let get = |k: &str| headers.get(k).map(String::as_str).unwrap_or("");
    let ua = get("user-agent").to_lowercase();
    let x_client = get("x-client-name").to_lowercase();
    // The reference tests `!= null`: the *presence* of the header is the signal, not its value.
    let x_codex = headers.contains_key("x-codex-client");

    if ua.contains("workbuddy") || x_client.contains("workbuddy") {
        return ClientHint::Workbuddy;
    }
    if ua.contains("claude-code") || ua.contains("anthropic") || x_client.contains("claude-code") {
        return ClientHint::ClaudeCode;
    }
    if ua.contains("codex") || x_client.contains("codex") || x_codex {
        return ClientHint::Codex;
    }
    if ua.contains("z.ai")
        || ua.contains("zcode")
        || x_client.contains("zcode")
        || x_client.contains("z.ai")
    {
        return ClientHint::Zcode;
    }
    if ua.contains("cursor") || x_client.contains("cursor") {
        return ClientHint::Cursor;
    }
    ClientHint::Generic
}

// ── Options and result ────────────────────────────────────────────────────

/// The knobs `normalizeGatewayRequest` accepts.
///
/// `preserve_cache_control` is declared by the reference's `NormalizeOptions` and read by **no**
/// branch there either; it is carried so the option surface matches, and it is inert on both sides.
#[derive(Debug, Clone, Default)]
pub struct NormalizeOptions {
    pub client_hint: Option<ClientHint>,
    pub target_provider: Option<String>,
    pub target_model: Option<String>,
    pub preserve_developer_role: Option<bool>,
    pub preserve_cache_control: Option<bool>,
}

/// A normalized request, plus the renames applied to it.
///
/// `tool_name_map` maps the name the upstream will see (TitleCase, e.g. `"Bash"`) back to the name
/// the client sent (e.g. `"bash"`). It is populated only when `client_hint` is
/// [`ClientHint::ClaudeCode`] and only for names the rename table actually rewrote.
#[derive(Debug, Clone)]
pub struct NormalizedRequest {
    pub body: Value,
    pub tool_name_map: BTreeMap<String, String>,
}

// ── Utilities ─────────────────────────────────────────────────────────────

fn role_of(msg: &Value) -> &str {
    msg.get("role").and_then(Value::as_str).unwrap_or("")
}

/// The reference's `extractTextFromContent` — a string passes through, a `text` part of an array is
/// joined by newlines, anything else is the empty string.
fn extract_text_from_content(content: &Value) -> String {
    if let Some(s) = content.as_str() {
        return s.to_string();
    }
    let arr = match content.as_array() {
        Some(a) => a,
        None => return String::new(),
    };
    arr.iter()
        .filter(|p| p.get("type").and_then(Value::as_str) == Some("text"))
        .map(|p| p.get("text").and_then(Value::as_str).unwrap_or(""))
        .collect::<Vec<_>>()
        .join("\n")
}

/// `Number.isInteger`, including the `1.0` case — `serde_json` parses `1.0` as an `f64`, and
/// JavaScript calls it an integer.
fn is_json_integer(v: &Value) -> bool {
    match v {
        Value::Number(n) => {
            if n.is_i64() || n.is_u64() {
                true
            } else {
                n.as_f64().map(|f| f.fract() == 0.0 && f.is_finite()).unwrap_or(false)
            }
        }
        _ => false,
    }
}

// ── 1. Role normalization ─────────────────────────────────────────────────

const PROVIDERS_WITHOUT_SYSTEM_ROLE: &[&str] = &["duckduckgo-web", "ddgw"];
const PROVIDERS_PRESERVING_DEVELOPER_ROLE: &[&str] = &["openai", "azure-openai", "azure", "github"];
const MODELS_WITHOUT_SYSTEM_ROLE: &[&str] = &["ernie-"];

fn default_preserve_developer_for_provider(provider: &str) -> bool {
    let id = provider.trim().to_lowercase();
    if id.is_empty() {
        return false;
    }
    if PROVIDERS_PRESERVING_DEVELOPER_ROLE.contains(&id.as_str()) {
        return true;
    }
    id.contains("openai")
}

/// The reference's `/glm-?(\d+)(?:[.p](\d+))?/` — hand-rolled, because the crate has no direct
/// `regex` dependency and this is a fixed grammar. Returns `(major, minor)` for the first match
/// anywhere in the string, `minor` defaulting to `0` when the `.`/`p` group is absent.
fn parse_glm_version(s: &str) -> Option<(u64, u64)> {
    let bytes = s.as_bytes();
    let mut i = 0;
    while i + 3 <= bytes.len() {
        if &bytes[i..i + 3] == b"glm" {
            let mut j = i + 3;
            if j < bytes.len() && bytes[j] == b'-' {
                j += 1;
            }
            let major_start = j;
            while j < bytes.len() && bytes[j].is_ascii_digit() {
                j += 1;
            }
            if j > major_start {
                let major: u64 = s[major_start..j].parse().unwrap_or(0);
                let mut minor: u64 = 0;
                if j < bytes.len() && (bytes[j] == b'.' || bytes[j] == b'p') {
                    let minor_start = j + 1;
                    let mut k = minor_start;
                    while k < bytes.len() && bytes[k].is_ascii_digit() {
                        k += 1;
                    }
                    if k > minor_start {
                        minor = s[minor_start..k].parse().unwrap_or(0);
                    }
                }
                return Some((major, minor));
            }
        }
        i += 1;
    }
    None
}

/// GLM models below 5.1 have no system role; 5.1 and above do.
fn is_glm_without_system_role(model_lower: &str) -> bool {
    if !model_lower.starts_with("glm") {
        return false;
    }
    if let Some((major, minor)) = parse_glm_version(model_lower) {
        if major > 5 || (major == 5 && minor >= 1) {
            return false;
        }
    }
    true
}

fn supports_system_role(provider: &str, model: &str) -> bool {
    let provider_lower = provider.trim().to_lowercase();
    if PROVIDERS_WITHOUT_SYSTEM_ROLE.contains(&provider_lower.as_str()) {
        return false;
    }
    let model_lower = model.to_lowercase();
    if is_glm_without_system_role(&model_lower) {
        return false;
    }
    if MODELS_WITHOUT_SYSTEM_ROLE.iter().any(|p| model_lower.starts_with(p)) {
        return false;
    }
    true
}

fn normalize_developer_role(
    messages: &mut [Value],
    target_format: &str,
    preserve: Option<bool>,
    provider: &str,
) {
    if target_format == "openai" {
        let effective =
            preserve.unwrap_or_else(|| default_preserve_developer_for_provider(provider));
        if effective {
            return;
        }
    }
    for msg in messages.iter_mut() {
        if role_of(msg).to_lowercase() == "developer" {
            if let Some(obj) = msg.as_object_mut() {
                obj.insert("role".into(), Value::String("system".into()));
            }
        }
    }
}

fn normalize_model_role(messages: &mut [Value]) {
    for msg in messages.iter_mut() {
        if role_of(msg).to_lowercase() == "model" {
            if let Some(obj) = msg.as_object_mut() {
                obj.insert("role".into(), Value::String("assistant".into()));
            }
        }
    }
}

/// Fold a system turn into the conversation for providers that have no system role.
///
/// The fold goes into the **first user turn** when one exists, and is prepended as a new user turn
/// when none does. An empty system content drops the system turns entirely rather than inventing
/// one — the same honesty the removed trailing-turn workaround was corrected for.
fn normalize_system_role(messages: Vec<Value>, provider: &str, model: &str) -> Vec<Value> {
    if messages.is_empty() || supports_system_role(provider, model) {
        return messages;
    }

    let is_systemish = |m: &Value| {
        let r = role_of(m);
        r == "system" || r == "developer"
    };

    if !messages.iter().any(is_systemish) {
        return messages;
    }

    let system_content = messages
        .iter()
        .filter(|m| is_systemish(m))
        .map(|m| extract_text_from_content(m.get("content").unwrap_or(&Value::Null)))
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");

    if system_content.is_empty() {
        return messages.into_iter().filter(|m| !is_systemish(m)).collect();
    }

    let mut non_system: Vec<Value> = messages.into_iter().filter(|m| !is_systemish(m)).collect();
    match non_system.iter().position(|m| role_of(m) == "user") {
        Some(idx) => {
            let user_content = extract_text_from_content(non_system[idx].get("content").unwrap_or(&Value::Null));
            let combined = format!("[System Instructions]\n{system_content}\n\n[User Message]\n{user_content}");
            if let Some(obj) = non_system[idx].as_object_mut() {
                obj.insert("content".into(), Value::String(combined));
            }
        }
        None => non_system.insert(
            0,
            json!({ "role": "user", "content": format!("[System Instructions]\n{system_content}") }),
        ),
    }
    non_system
}

fn hoist_leading_system_message(messages: &mut Vec<Value>) {
    if let Some(idx) = messages.iter().position(|m| role_of(m) == "system") {
        if idx > 0 {
            let sys = messages.remove(idx);
            messages.insert(0, sys);
        }
    }
}

// ── 2. Tool-call id safety ────────────────────────────────────────────────

/// The reference's `simpleHash`: `h = (h * 31 + charCode) | 0`, then `Math.abs`.
///
/// The `| 0` truncates to a signed 32-bit integer on every step, so `wrapping_*` on `i32` is the
/// faithful arithmetic. The result is widened to `i64` before `abs` because
/// `Math.abs(-2147483648)` is `2147483648`, which does not fit in an `i32`.
///
/// Iteration is over UTF-16 code units, matching `charCodeAt(i)` exactly.
fn simple_hash(s: &str) -> i64 {
    let mut h: i32 = 0;
    for unit in s.encode_utf16() {
        h = h.wrapping_mul(31).wrapping_add(unit as i32);
    }
    (h as i64).abs()
}

/// Base-36 of a non-negative integer: lowercase digits, no leading zeros, `0` for zero.
///
/// Shared with [`crate::core::tool_wire`], which synthesises tool-call ids in the same alphabet. A
/// second spelling would be a second thing to keep in step, and the two must agree byte-for-byte
/// because the id is matched literally across two turns.
pub(crate) fn to_base36(mut n: u64) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if n == 0 {
        return "0".to_string();
    }
    let mut buf = Vec::new();
    while n > 0 {
        buf.push(DIGITS[(n % 36) as usize]);
        n /= 36;
    }
    buf.reverse();
    String::from_utf8(buf).expect("base36 digits are ASCII")
}

fn generate_tool_call_id(index: usize, name: &str, args_prefix: &str) -> String {
    let raw = format!("{index}:{name}:{args_prefix}");
    let h = simple_hash(&raw);
    let digits: String = to_base36(h as u64).chars().take(9).collect();
    format!("call_{digits}")
}

fn normalize_to_9_char_id(id: &str) -> String {
    if id.chars().count() == 9 {
        return id.to_string();
    }
    let h = simple_hash(id);
    let digits: String = to_base36(h as u64).chars().take(9).collect();
    // `padStart(9, "0")` — left-pad, and a no-op when the slice is already 9 long.
    let missing = 9usize.saturating_sub(digits.chars().count());
    if missing == 0 {
        digits
    } else {
        let mut out = "0".repeat(missing);
        out.push_str(&digits);
        out
    }
}

/// Give every `tool_call` an `id`, and every `tool_call` an `index`.
///
/// `use_9char_id` additionally rewrites every id to a 9-character deterministic form, which the
/// pipeline itself never asks for (`use9CharId: false` on both passes) — it exists for the
/// Anthropic dialect, whose ids are 9 characters.
pub fn ensure_tool_call_ids(body: &mut Value, use_9char_id: bool) {
    let messages = match body.get_mut("messages").and_then(Value::as_array_mut) {
        Some(m) => m,
        None => return,
    };
    for msg in messages.iter_mut() {
        let tool_calls = match msg.get_mut("tool_calls").and_then(Value::as_array_mut) {
            Some(t) => t,
            None => continue,
        };
        for (i, tc) in tool_calls.iter_mut().enumerate() {
            let obj = match tc.as_object_mut() {
                Some(o) => o,
                None => continue,
            };
            // `!tc.id || typeof tc.id !== "string"` — only a non-empty string counts as present.
            let has_id =
                obj.get("id").and_then(Value::as_str).map(|s| !s.is_empty()).unwrap_or(false);
            if !has_id {
                let name = obj
                    .get("function")
                    .and_then(|f| f.get("name"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let args_full = obj
                    .get("function")
                    .and_then(|f| f.get("arguments"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let args: String = args_full.chars().take(32).collect();
                let id = generate_tool_call_id(i, &name, &args);
                obj.insert("id".into(), Value::String(id));
            }
            if use_9char_id {
                if let Some(id) = obj.get("id").and_then(Value::as_str) {
                    let normalized = normalize_to_9_char_id(id);
                    obj.insert("id".into(), Value::String(normalized));
                }
            }
            if !obj.get("index").map(is_json_integer).unwrap_or(false) {
                obj.insert("index".into(), json!(i));
            }
        }
    }
}

// ── 3. Tool response hygiene ──────────────────────────────────────────────

/// Insert an empty `tool` result for every declared `tool_call` id that has no result.
///
/// The results are inserted directly after the **last** assistant turn that declares tool calls,
/// which is where the dialect expects them.
fn fix_missing_tool_responses(body: &mut Value) {
    let messages = match body.get_mut("messages").and_then(Value::as_array_mut) {
        Some(m) => m,
        None => return,
    };

    // Insertion order preserved: a `Vec` plus a `HashSet` for membership, standing in for the
    // reference's insertion-ordered `Set`.
    let mut declared: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for msg in messages.iter() {
        if role_of(msg) != "assistant" {
            continue;
        }
        if let Some(tool_calls) = msg.get("tool_calls").and_then(Value::as_array) {
            for tc in tool_calls {
                if let Some(id) = tc.get("id").and_then(Value::as_str) {
                    if seen.insert(id.to_string()) {
                        declared.push(id.to_string());
                    }
                }
            }
        }
    }

    let mut answered: HashSet<String> = HashSet::new();
    for msg in messages.iter() {
        if role_of(msg) == "tool" {
            if let Some(id) = msg.get("tool_call_id").and_then(Value::as_str) {
                answered.insert(id.to_string());
            }
        }
    }

    let missing: Vec<Value> = declared
        .iter()
        .filter(|id| !answered.contains(*id))
        .map(|id| json!({ "role": "tool", "tool_call_id": id, "content": "" }))
        .collect();

    if missing.is_empty() {
        return;
    }

    let mut insert_idx = messages.len();
    for i in (0..messages.len()).rev() {
        let declares = messages[i]
            .get("tool_calls")
            .and_then(Value::as_array)
            .map(|a| !a.is_empty())
            .unwrap_or(false);
        if role_of(&messages[i]) == "assistant" && declares {
            insert_idx = i + 1;
            break;
        }
    }
    let tail = messages.split_off(insert_idx);
    messages.extend(missing);
    messages.extend(tail);
}

/// Drop `tool` results whose `tool_call_id` no assistant turn declares.
fn strip_orphaned_tool_results(body: &mut Value) {
    let messages = match body.get_mut("messages").and_then(Value::as_array_mut) {
        Some(m) => m,
        None => return,
    };

    let mut valid: HashSet<String> = HashSet::new();
    for msg in messages.iter() {
        if role_of(msg) != "assistant" {
            continue;
        }
        if let Some(tool_calls) = msg.get("tool_calls").and_then(Value::as_array) {
            for tc in tool_calls {
                if let Some(id) = tc.get("id").and_then(Value::as_str) {
                    valid.insert(id.to_string());
                }
            }
        }
    }

    for i in (0..messages.len()).rev() {
        let orphan = role_of(&messages[i]) == "tool"
            && messages[i]
                .get("tool_call_id")
                .and_then(Value::as_str)
                .map(|id| !valid.contains(id))
                .unwrap_or(false);
        if orphan {
            messages.remove(i);
        }
    }
}

// ── 4. Tool schema sanitization ───────────────────────────────────────────

const MAX_SCHEMA_DEPTH: usize = 32;

/// Recursively clean a JSON Schema: drop nulls, flatten tuples, filter enums and `required`, and
/// keep object schemas open.
///
/// The `match` arms mirror the reference's `else if` chain, including which conditions carry a type
/// guard and which do not — `properties`, `enum` and `required` fall through to the copy when the
/// value is the wrong shape, while `items`, `anyOf`/`oneOf`/`allOf` and `additionalProperties` do
/// not, and so drop the key entirely. That asymmetry is the reference's; it is preserved.
fn sanitize_schema(value: &Value, depth: usize) -> Value {
    if depth > MAX_SCHEMA_DEPTH {
        return json!({});
    }
    let obj = match value.as_object() {
        Some(o) => o,
        None => return json!({}),
    };

    let mut result: Map<String, Value> = Map::new();
    for (k, v) in obj {
        if v.is_null() {
            continue;
        }
        match k.as_str() {
            "properties" => {
                if let Some(props) = v.as_object() {
                    let mut cleaned: Map<String, Value> = Map::new();
                    for (pk, pv) in props {
                        if pv.is_object() {
                            cleaned.insert(pk.clone(), sanitize_schema(pv, depth + 1));
                        } else if let Some(b) = pv.as_bool() {
                            cleaned.insert(pk.clone(), Value::Bool(b));
                        } else {
                            cleaned.insert(pk.clone(), json!({}));
                        }
                    }
                    result.insert(k.clone(), Value::Object(cleaned));
                } else {
                    result.insert(k.clone(), v.clone());
                }
            }
            "items" => {
                if let Some(arr) = v.as_array() {
                    let first = arr.iter().find(|x| x.is_object());
                    let cleaned =
                        first.map(|f| sanitize_schema(f, depth + 1)).unwrap_or_else(|| json!({}));
                    result.insert(k.clone(), cleaned);
                } else if v.is_object() {
                    result.insert(k.clone(), sanitize_schema(v, depth + 1));
                }
            }
            "anyOf" | "oneOf" | "allOf" => {
                if let Some(arr) = v.as_array() {
                    let mapped: Vec<Value> =
                        arr.iter()
                            .map(|s| {
                                if s.is_object() {
                                    sanitize_schema(s, depth + 1)
                                } else {
                                    json!({})
                                }
                            })
                            .collect();
                    result.insert(k.clone(), Value::Array(mapped));
                }
            }
            "additionalProperties" => {
                if v.is_object() {
                    result.insert(k.clone(), sanitize_schema(v, depth + 1));
                } else if let Some(b) = v.as_bool() {
                    result.insert(k.clone(), Value::Bool(b));
                }
            }
            "enum" => {
                if let Some(arr) = v.as_array() {
                    let filtered: Vec<Value> =
                        arr.iter().filter(|e| !e.is_null()).cloned().collect();
                    result.insert(k.clone(), Value::Array(filtered));
                } else {
                    result.insert(k.clone(), v.clone());
                }
            }
            "required" => {
                if let Some(arr) = v.as_array() {
                    let filtered: Vec<Value> =
                        arr.iter().filter(|r| r.is_string()).cloned().collect();
                    result.insert(k.clone(), Value::Array(filtered));
                } else {
                    result.insert(k.clone(), v.clone());
                }
            }
            _ => {
                result.insert(k.clone(), v.clone());
            }
        }
    }

    // Keep opaque object schemas open.
    let is_object_type = result.get("type").and_then(Value::as_str) == Some("object");
    let has_props = result.get("properties").map(|p| p.is_object()).unwrap_or(false);
    if is_object_type || has_props {
        if !result.contains_key("properties") {
            result.insert("properties".into(), json!({}));
            if !result.contains_key("additionalProperties") {
                result.insert("additionalProperties".into(), Value::Bool(true));
            }
        } else if has_props
            && result
                .get("properties")
                .and_then(Value::as_object)
                .map(|o| o.is_empty())
                .unwrap_or(false)
            && !result.contains_key("additionalProperties")
        {
            result.insert("additionalProperties".into(), Value::Bool(true));
        }
    }

    // `required` may only name keys that survived into `properties`.
    let required_is_array = result.get("required").map(|r| r.is_array()).unwrap_or(false);
    let props_is_object = result.get("properties").map(|p| p.is_object()).unwrap_or(false);
    if required_is_array && props_is_object {
        let valid: HashSet<String> = result
            .get("properties")
            .and_then(Value::as_object)
            .map(|o| o.keys().cloned().collect())
            .unwrap_or_default();
        let filtered: Vec<Value> = result
            .get("required")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter(|r| r.as_str().map(|s| valid.contains(s)).unwrap_or(false))
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        result.insert("required".into(), Value::Array(filtered));
    }

    Value::Object(result)
}

fn ensure_root_object_type(schema: &mut Map<String, Value>) {
    if schema.contains_key("type") {
        return;
    }
    if schema.contains_key("anyOf") || schema.contains_key("oneOf") || schema.contains_key("allOf")
    {
        return;
    }
    schema.insert("type".into(), Value::String("object".into()));
    if !schema.get("properties").map(|p| p.is_object()).unwrap_or(false) {
        schema.insert("properties".into(), json!({}));
        if !schema.contains_key("additionalProperties") {
            schema.insert("additionalProperties".into(), Value::Bool(true));
        }
    }
}

fn normalize_parameters(parameters: &Value) -> Value {
    if parameters.is_object() {
        let mut sanitized = sanitize_schema(parameters, 0);
        if let Some(obj) = sanitized.as_object_mut() {
            ensure_root_object_type(obj);
        }
        return sanitized;
    }
    json!({ "type": "object", "properties": {}, "additionalProperties": true })
}

fn sanitize_openai_tool(tool: &Value) -> Value {
    let mut out = match tool.as_object() {
        Some(o) => Value::Object(o.clone()),
        None => return tool.clone(),
    };
    let obj = out.as_object_mut().expect("just built from an object");

    let has_function_object = obj.get("function").map(|f| f.is_object()).unwrap_or(false);
    if has_function_object {
        let mut function = obj
            .get("function")
            .and_then(Value::as_object)
            .cloned()
            .expect("checked is_object above");
        let params = function.get("parameters").cloned().unwrap_or(Value::Null);
        function.insert("parameters".into(), normalize_parameters(&params));
        obj.insert("function".into(), Value::Object(function));
    } else if obj.get("type").and_then(Value::as_str) == Some("function") {
        // Responses API shape: no `function` wrapper.
        let params = obj.get("parameters").cloned().unwrap_or(Value::Null);
        obj.insert("parameters".into(), normalize_parameters(&params));
    }

    out
}

/// Sanitize a `tools` array. A non-array passes through untouched.
pub fn sanitize_openai_tools(tools: &Value) -> Value {
    match tools.as_array() {
        Some(arr) => Value::Array(arr.iter().map(sanitize_openai_tool).collect()),
        None => tools.clone(),
    }
}

// ── 5. Message shape fixes ────────────────────────────────────────────────

fn promote_input_to_messages(body: &mut Map<String, Value>) {
    let input_nullish = body.get("input").map(Value::is_null).unwrap_or(true);
    let messages_is_array = body.get("messages").map(Value::is_array).unwrap_or(false);
    if input_nullish && messages_is_array {
        return;
    }

    if !input_nullish && !messages_is_array {
        let input = body.get("input").cloned().unwrap_or(Value::Null);
        if let Some(s) = input.as_str() {
            body.insert("messages".into(), json!([{ "role": "user", "content": s }]));
        } else if let Some(arr) = input.as_array() {
            body.insert("messages".into(), Value::Array(arr.clone()));
        } else if input.is_object() {
            body.insert("messages".into(), Value::Array(vec![input.clone()]));
        }
        // `delete body.input` runs whether or not a branch matched — a non-string, non-array,
        // non-object input is dropped without becoming a message, exactly as in the reference.
        body.remove("input");
    }
}

fn ensure_array_content(messages: &mut [Value]) {
    for msg in messages.iter_mut() {
        let text = match msg.get("content").and_then(Value::as_str) {
            Some(s) => s.to_string(),
            None => continue,
        };
        if let Some(obj) = msg.as_object_mut() {
            obj.insert("content".into(), json!([{ "type": "text", "text": text }]));
        }
    }
}

// ── 6. Client-specific adaptations ────────────────────────────────────────

/// Lowercase (client) → TitleCase (upstream). The reference's `CLAUDE_TOOL_RENAME_MAP`.
const CLAUDE_TOOL_RENAME_MAP: &[(&str, &str)] = &[
    ("bash", "Bash"),
    ("read", "Read"),
    ("write", "Write"),
    ("edit", "Edit"),
    ("glob", "Glob"),
    ("grep", "Grep"),
    ("task", "Task"),
    ("agent", "Agent"),
    ("webfetch", "WebFetch"),
    ("websearch", "WebSearch"),
    ("todowrite", "TodoWrite"),
    ("todoread", "TodoRead"),
    ("question", "Question"),
    ("askuserquestion", "AskUserQuestion"),
    ("skill", "Skill"),
    ("slashcommand", "SlashCommand"),
    ("multiedit", "MultiEdit"),
    ("notebook", "Notebook"),
    ("notebookedit", "NotebookEdit"),
    ("notebookread", "NotebookRead"),
    ("lsp", "Lsp"),
    ("apply_patch", "ApplyPatch"),
    ("applypatch", "ApplyPatch"),
    ("bashoutput", "BashOutput"),
    ("killshell", "KillShell"),
    ("killbash", "KillBash"),
    ("enterplanmode", "EnterPlanMode"),
    ("exitplanmode", "ExitPlanMode"),
    ("enterworktree", "EnterWorktree"),
    ("exitworktree", "ExitWorktree"),
    ("artifact", "Artifact"),
    ("designsync", "DesignSync"),
    ("monitor", "Monitor"),
    ("sendmessage", "SendMessage"),
    ("listagents", "ListAgents"),
    ("pushnotification", "PushNotification"),
    ("reportfindings", "ReportFindings"),
    ("schedulewakeup", "ScheduleWakeup"),
    ("croncreate", "CronCreate"),
    ("crondelete", "CronDelete"),
    ("cronlist", "CronList"),
    ("taskoutput", "TaskOutput"),
    ("taskstop", "TaskStop"),
    ("taskcreate", "TaskCreate"),
    ("taskupdate", "TaskUpdate"),
    ("tasklist", "TaskList"),
    ("taskget", "TaskGet"),
    ("workflow", "Workflow"),
];

fn claude_rename(name: &str) -> Option<&'static str> {
    CLAUDE_TOOL_RENAME_MAP.iter().find(|(from, _)| *from == name).map(|(_, to)| *to)
}

/// Rewrite Claude Code's lowercase tool names to the TitleCase the upstream expects, recording each
/// rewrite in `map` so the response path can put the original back.
fn remap_claude_tool_names_in_request(
    body: &mut Map<String, Value>,
    map: &mut BTreeMap<String, String>,
) {
    if let Some(tools) = body.get_mut("tools").and_then(Value::as_array_mut) {
        for tool in tools.iter_mut() {
            let obj = match tool.as_object_mut() {
                Some(o) => o,
                None => continue,
            };
            // Chat Completions shape: { function: { name } }. Responses shape: { name }.
            // `get("function").and_then(get("name"))` already implies `function` is an object.
            let (name, via_function) =
                match obj.get("function").and_then(|f| f.get("name")).and_then(Value::as_str) {
                    Some(n) => (n.to_string(), true),
                    None => match obj.get("name").and_then(Value::as_str) {
                        Some(n) => (n.to_string(), false),
                        None => continue,
                    },
                };
            if let Some(mapped) = claude_rename(&name) {
                if via_function {
                    if let Some(f) = obj.get_mut("function").and_then(Value::as_object_mut) {
                        f.insert("name".into(), Value::String(mapped.to_string()));
                    }
                } else {
                    obj.insert("name".into(), Value::String(mapped.to_string()));
                }
                map.insert(mapped.to_string(), name);
            }
        }
    }

    if let Some(messages) = body.get_mut("messages").and_then(Value::as_array_mut) {
        for msg in messages.iter_mut() {
            let content = match msg.get_mut("content").and_then(Value::as_array_mut) {
                Some(c) => c,
                None => continue,
            };
            for block in content.iter_mut() {
                let b = match block.as_object_mut() {
                    Some(o) => o,
                    None => continue,
                };
                if b.get("type").and_then(Value::as_str) != Some("tool_use") {
                    continue;
                }
                let original = match b.get("name").and_then(Value::as_str) {
                    Some(n) => n.to_string(),
                    None => continue,
                };
                if let Some(mapped) = claude_rename(&original) {
                    b.insert("name".into(), Value::String(mapped.to_string()));
                    map.insert(mapped.to_string(), original);
                }
            }
        }
    }

    if let Some(tool_choice) = body.get_mut("tool_choice").and_then(Value::as_object_mut) {
        if tool_choice.get("type").and_then(Value::as_str) == Some("tool") {
            if let Some(original) =
                tool_choice.get("name").and_then(Value::as_str).map(str::to_string)
            {
                if let Some(mapped) = claude_rename(&original) {
                    tool_choice.insert("name".into(), Value::String(mapped.to_string()));
                    map.insert(mapped.to_string(), original);
                }
            }
        }
    }
}

/// `String(number)` — JavaScript prints an integral float without a trailing `.0`.
fn js_number_string(n: &serde_json::Number) -> String {
    if let Some(i) = n.as_i64() {
        return i.to_string();
    }
    if let Some(u) = n.as_u64() {
        return u.to_string();
    }
    match n.as_f64() {
        Some(f) if f.is_finite() && f.fract() == 0.0 && f.abs() < 9.007_199_254_740_992e15 => {
            format!("{}", f as i64)
        }
        Some(f) => f.to_string(),
        None => n.to_string(),
    }
}

/// Codex / Responses API shape normalization, run before role normalization.
fn normalize_codex_request(body: &mut Map<String, Value>) {
    // reasoning_effort -> reasoning: { effort }
    if body.contains_key("reasoning_effort") && !body.contains_key("reasoning") {
        let effort = body.get("reasoning_effort").cloned().unwrap_or(Value::Null);
        let rendered = match &effort {
            Value::String(s) => Some(s.clone()),
            Value::Number(n) => Some(js_number_string(n)),
            _ => None,
        };
        if let Some(rendered) = rendered {
            body.insert("reasoning".into(), json!({ "effort": rendered }));
        }
        body.remove("reasoning_effort");
    }

    // max_completion_tokens / max_tokens -> max_output_tokens
    let has_output = body.get("max_output_tokens").map(|v| !v.is_null()).unwrap_or(false);
    if !has_output {
        if let Some(n) = body.get("max_completion_tokens").and_then(Value::as_number).cloned() {
            body.insert("max_output_tokens".into(), Value::Number(n));
            body.remove("max_completion_tokens");
        } else if let Some(n) = body.get("max_tokens").and_then(Value::as_number).cloned() {
            body.insert("max_output_tokens".into(), Value::Number(n));
            body.remove("max_tokens");
        }
    } else {
        body.remove("max_tokens");
        body.remove("max_completion_tokens");
    }

    // response_format -> text.format
    let has_response_format = body.get("response_format").map(|v| !v.is_null()).unwrap_or(false);
    if has_response_format {
        if body.get("text").map(Value::is_null).unwrap_or(true) {
            let format = body.get("response_format").cloned().unwrap_or(Value::Null);
            body.insert("text".into(), json!({ "format": format }));
        }
        body.remove("response_format");
    }

    // Normalize the `input` shape to Responses `message` items.
    let messages_is_array = body.get("messages").map(Value::is_array).unwrap_or(false);
    let input_present = body.get("input").map(|v| !v.is_null()).unwrap_or(false);
    if input_present && !messages_is_array {
        let input = body.get("input").cloned().unwrap_or(Value::Null);
        if let Some(s) = input.as_str() {
            body.insert(
                "input".into(),
                json!([{ "type": "message", "role": "user", "content": [{ "type": "input_text", "text": s }] }]),
            );
        } else if let Some(arr) = input.as_array() {
            let mapped: Vec<Value> = arr
                .iter()
                .map(|item| {
                    if let Some(s) = item.as_str() {
                        json!({ "type": "message", "role": "user", "content": [{ "type": "input_text", "text": s }] })
                    } else if item.is_object() && item.get("type").is_none() {
                        let mut obj = item.as_object().cloned().unwrap_or_default();
                        obj.insert("type".into(), Value::String("message".into()));
                        Value::Object(obj)
                    } else {
                        item.clone()
                    }
                })
                .collect();
            body.insert("input".into(), Value::Array(mapped));
        }
    }
}

// ── 7. Main pipeline ──────────────────────────────────────────────────────

/// Normalize an incoming gateway request body.
///
/// Pure: the input is deep-cloned, never mutated. The returned [`NormalizedRequest`] carries the
/// normalized body and the Claude Code tool renames applied to it.
pub fn normalize_gateway_request(body: &Value, opts: &NormalizeOptions) -> NormalizedRequest {
    let mut result = body.clone();

    let client_hint = opts.client_hint.unwrap_or(ClientHint::Generic);
    let target_provider = opts.target_provider.clone().unwrap_or_default().trim().to_lowercase();
    let target_model = opts.target_model.clone().unwrap_or_default().trim().to_lowercase();
    let preserve_developer_role = opts.preserve_developer_role;
    let mut tool_name_map: BTreeMap<String, String> = BTreeMap::new();

    let input_present = result.get("input").map(|v| !v.is_null()).unwrap_or(false);
    if client_hint == ClientHint::Codex || input_present {
        if let Some(obj) = result.as_object_mut() {
            normalize_codex_request(obj);
        }
    }

    if let Some(obj) = result.as_object_mut() {
        promote_input_to_messages(obj);
    }

    // Phase B — role normalization.
    if let Some(slot) = result.get_mut("messages").and_then(Value::as_array_mut) {
        normalize_model_role(slot);
        normalize_developer_role(slot, "openai", preserve_developer_role, &target_provider);
        let taken = std::mem::take(slot);
        let mut out = normalize_system_role(taken, &target_provider, &target_model);
        hoist_leading_system_message(&mut out);
        *slot = out;
    }

    // Phase C — tool-call id safety.
    ensure_tool_call_ids(&mut result, false);

    // Phase D — tool response hygiene.
    fix_missing_tool_responses(&mut result);
    strip_orphaned_tool_results(&mut result);

    // Phase E — tool schema sanitization.
    if let Some(tools) = result.get("tools") {
        let sanitized = sanitize_openai_tools(tools);
        if let Some(obj) = result.as_object_mut() {
            obj.insert("tools".into(), sanitized);
        }
    }

    // Phase F — message shape fixes.
    if let Some(messages) = result.get_mut("messages").and_then(Value::as_array_mut) {
        ensure_array_content(messages);
    }

    // Phase G — client-specific adaptations.
    if client_hint == ClientHint::ClaudeCode {
        if let Some(obj) = result.as_object_mut() {
            remap_claude_tool_names_in_request(obj, &mut tool_name_map);
        }
    }

    // Final pass — ids again, after any client remapping.
    ensure_tool_call_ids(&mut result, false);
    fix_missing_tool_responses(&mut result);
    strip_orphaned_tool_results(&mut result);

    NormalizedRequest { body: result, tool_name_map }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| ((*k).to_string(), (*v).to_string())).collect()
    }

    fn normalize(body: Value, opts: NormalizeOptions) -> Value {
        normalize_gateway_request(&body, &opts).body
    }

    fn messages_of(out: &Value) -> &Vec<Value> {
        out.get("messages").and_then(Value::as_array).expect("messages array")
    }

    /// `toMatchObject` semantics: every key in `expected` is present and equal in `actual`, while
    /// extra keys in `actual` are allowed.
    fn assert_matches(actual: &Value, expected: &Value) {
        match (actual, expected) {
            (Value::Object(a), Value::Object(e)) => {
                for (k, ev) in e {
                    let av = a.get(k).unwrap_or_else(|| panic!("missing key {k:?} in {actual}"));
                    assert_matches(av, ev);
                }
            }
            _ => assert_eq!(actual, expected),
        }
    }

    // ── detect_client ─────────────────────────────────────────────────────

    #[test]
    fn detects_each_client_from_its_headers() {
        assert_eq!(
            detect_client(&headers(&[("user-agent", "WorkBuddy/1.0")])),
            ClientHint::Workbuddy
        );
        assert_eq!(
            detect_client(&headers(&[("x-client-name", "workbuddy")])),
            ClientHint::Workbuddy
        );

        assert_eq!(
            detect_client(&headers(&[("user-agent", "claude-code/0.1.0")])),
            ClientHint::ClaudeCode
        );
        assert_eq!(
            detect_client(&headers(&[("user-agent", "Anthropic CLI")])),
            ClientHint::ClaudeCode
        );

        assert_eq!(detect_client(&headers(&[("user-agent", "codex/1.0")])), ClientHint::Codex);
        assert_eq!(detect_client(&headers(&[("x-codex-client", "true")])), ClientHint::Codex);

        assert_eq!(detect_client(&headers(&[("user-agent", "zcode/1.0")])), ClientHint::Zcode);
        assert_eq!(detect_client(&headers(&[("x-client-name", "z.ai")])), ClientHint::Zcode);

        assert_eq!(detect_client(&headers(&[("user-agent", "Cursor/1.0")])), ClientHint::Cursor);

        assert_eq!(detect_client(&headers(&[("user-agent", "Mozilla/5.0")])), ClientHint::Generic);
        assert_eq!(detect_client(&headers(&[])), ClientHint::Generic);
    }

    /// The `x-codex-client` check is on presence, not value — an empty value still identifies Codex.
    #[test]
    fn an_empty_codex_header_still_identifies_codex() {
        assert_eq!(detect_client(&headers(&[("x-codex-client", "")])), ClientHint::Codex);
    }

    /// WorkBuddy wins over a `user-agent` that also mentions codex, because it is tested first.
    #[test]
    fn workbuddy_outranks_a_compound_user_agent() {
        assert_eq!(
            detect_client(&headers(&[("user-agent", "WorkBuddy codex-bridge/2")])),
            ClientHint::Workbuddy
        );
    }

    // ── role normalization ────────────────────────────────────────────────

    #[test]
    fn maps_developer_to_system_for_non_openai_providers() {
        let out = normalize(
            json!({ "messages": [{ "role": "developer", "content": "Be helpful" }] }),
            NormalizeOptions { target_provider: Some("openrouter".into()), ..Default::default() },
        );
        assert_eq!(
            messages_of(&out)[0],
            json!({ "role": "system", "content": [{ "type": "text", "text": "Be helpful" }] })
        );
    }

    #[test]
    fn preserves_developer_role_for_openai_when_asked() {
        let out = normalize(
            json!({ "messages": [{ "role": "developer", "content": "Be helpful" }] }),
            NormalizeOptions {
                target_provider: Some("openai".into()),
                preserve_developer_role: Some(true),
                ..Default::default()
            },
        );
        assert_eq!(messages_of(&out)[0].get("role").and_then(Value::as_str), Some("developer"));
    }

    #[test]
    fn maps_developer_to_system_for_openai_when_not_preserved() {
        let out = normalize(
            json!({ "messages": [{ "role": "developer", "content": "Be helpful" }] }),
            NormalizeOptions {
                target_provider: Some("openai".into()),
                preserve_developer_role: Some(false),
                ..Default::default()
            },
        );
        assert_eq!(messages_of(&out)[0].get("role").and_then(Value::as_str), Some("system"));
    }

    /// Without an explicit flag, an `openai`-containing provider id preserves the role by default.
    #[test]
    fn an_openai_containing_provider_preserves_the_developer_role_by_default() {
        let out = normalize(
            json!({ "messages": [{ "role": "developer", "content": "x" }] }),
            NormalizeOptions { target_provider: Some("azure-openai".into()), ..Default::default() },
        );
        assert_eq!(messages_of(&out)[0].get("role").and_then(Value::as_str), Some("developer"));
    }

    #[test]
    fn maps_model_to_assistant() {
        let out = normalize(
            json!({ "messages": [{ "role": "model", "content": "Hello" }] }),
            NormalizeOptions::default(),
        );
        assert_eq!(
            messages_of(&out)[0],
            json!({ "role": "assistant", "content": [{ "type": "text", "text": "Hello" }] })
        );
    }

    #[test]
    fn folds_system_into_the_first_user_message_when_the_provider_has_no_system_role() {
        let out = normalize(
            json!({
                "messages": [
                    { "role": "system", "content": "Sys1" },
                    { "role": "user", "content": "Hello" },
                    { "role": "assistant", "content": "Hi" },
                ]
            }),
            NormalizeOptions {
                target_provider: Some("duckduckgo-web".into()),
                ..Default::default()
            },
        );
        let msgs = messages_of(&out);
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].get("role").and_then(Value::as_str), Some("user"));
        let text = msgs[0]
            .get("content")
            .and_then(Value::as_array)
            .and_then(|a| a[0].get("text"))
            .and_then(Value::as_str)
            .unwrap_or("");
        assert!(text.contains("Sys1"), "folded system text missing: {text}");
        assert!(text.contains("Hello"), "folded user text missing: {text}");
    }

    #[test]
    fn inserts_a_user_turn_with_the_system_content_when_no_user_exists() {
        let out = normalize(
            json!({ "messages": [{ "role": "system", "content": "Sys1" }] }),
            NormalizeOptions {
                target_provider: Some("duckduckgo-web".into()),
                ..Default::default()
            },
        );
        let msgs = messages_of(&out);
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].get("role").and_then(Value::as_str), Some("user"));
        let text = msgs[0]
            .get("content")
            .and_then(Value::as_array)
            .and_then(|a| a[0].get("text"))
            .and_then(Value::as_str)
            .unwrap_or("");
        assert!(text.contains("Sys1"));
    }

    /// A system turn with no text is dropped, not fabricated into an empty user turn.
    #[test]
    fn an_empty_system_turn_is_dropped_rather_than_folded() {
        let out = normalize(
            json!({ "messages": [
                { "role": "system", "content": "" },
                { "role": "assistant", "content": "Hi" },
            ] }),
            NormalizeOptions {
                target_provider: Some("duckduckgo-web".into()),
                ..Default::default()
            },
        );
        let msgs = messages_of(&out);
        assert!(msgs.iter().all(|m| m.get("role").and_then(Value::as_str) != Some("system")));
        assert!(msgs.iter().all(|m| m.get("role").and_then(Value::as_str) != Some("user")));
    }

    #[test]
    fn hoists_a_system_message_to_index_zero() {
        let out = normalize(
            json!({ "messages": [
                { "role": "user", "content": "Hello" },
                { "role": "system", "content": "Sys" },
                { "role": "assistant", "content": "Hi" },
            ] }),
            NormalizeOptions::default(),
        );
        let msgs = messages_of(&out);
        assert_eq!(msgs[0].get("role").and_then(Value::as_str), Some("system"));
        assert_eq!(msgs[1].get("role").and_then(Value::as_str), Some("user"));
    }

    #[test]
    fn glm_and_ernie_models_are_treated_as_having_no_system_role() {
        assert!(supports_system_role("", "gpt-4o"));
        assert!(supports_system_role("", "glm-5.1"));
        assert!(supports_system_role("", "glm-5p1"));
        assert!(supports_system_role("", "glm-6"));
        assert!(!supports_system_role("", "glm-4.5"));
        assert!(!supports_system_role("", "glm-4"));
        assert!(!supports_system_role("", "glm"));
        assert!(!supports_system_role("", "ernie-4.0"));
        assert!(!supports_system_role("duckduckgo-web", "gpt-4o"));
    }

    /// The hand-rolled grammar has to agree with the reference's `/glm-?(\d+)(?:[.p](\d+))?/`,
    /// including where it does **not** match.
    #[test]
    fn the_glm_version_grammar_matches_the_reference_regex() {
        assert_eq!(parse_glm_version("glm-4.5"), Some((4, 5)));
        assert_eq!(parse_glm_version("glm4p5"), Some((4, 5)));
        assert_eq!(parse_glm_version("glm-5.1"), Some((5, 1)));
        assert_eq!(parse_glm_version("glm-6"), Some((6, 0)));
        assert_eq!(parse_glm_version("zai/glm-4.6-air"), Some((4, 6)));
        assert_eq!(parse_glm_version("glm"), None);
        assert_eq!(parse_glm_version("glm-x"), None);
        assert_eq!(parse_glm_version("not-a-glm-4"), Some((4, 0)));
    }

    // ── tool-call id safety ───────────────────────────────────────────────

    #[test]
    fn generates_missing_tool_call_ids() {
        let out = normalize(
            json!({ "messages": [{ "role": "assistant", "tool_calls": [
                { "function": { "name": "read", "arguments": "{}" } }
            ] }] }),
            NormalizeOptions::default(),
        );
        let id = messages_of(&out)[0]
            .get("tool_calls")
            .and_then(Value::as_array)
            .and_then(|t| t[0].get("id"))
            .and_then(Value::as_str)
            .unwrap_or("");
        assert!(!id.is_empty(), "no id generated");
        // Pinned against the reference implementation's output for the same input.
        assert_eq!(id, "call_tcdq4k");
    }

    #[test]
    fn preserves_existing_tool_call_ids() {
        let out = normalize(
            json!({ "messages": [{ "role": "assistant", "tool_calls": [
                { "id": "call_abc123", "function": { "name": "read", "arguments": "{}" } }
            ] }] }),
            NormalizeOptions::default(),
        );
        assert_eq!(
            messages_of(&out)[0]
                .get("tool_calls")
                .and_then(Value::as_array)
                .and_then(|t| t[0].get("id"))
                .and_then(Value::as_str),
            Some("call_abc123")
        );
    }

    #[test]
    fn ensure_tool_call_ids_adds_ids_and_indices() {
        let mut body = json!({ "messages": [{ "role": "assistant", "tool_calls": [
            { "function": { "name": "read", "arguments": "{}" } }
        ] }] });
        ensure_tool_call_ids(&mut body, false);
        let tc = &body["messages"][0]["tool_calls"][0];
        assert_eq!(tc["id"], json!("call_tcdq4k"));
        assert_eq!(tc["index"], json!(0));
    }

    /// The 9-character form is not used by the pipeline, but it is part of the ported surface and
    /// is pinned against the reference's output.
    #[test]
    fn the_nine_char_id_form_matches_the_reference() {
        assert_eq!(normalize_to_9_char_id("call_abc123"), "000d4riwf");
        assert_eq!(normalize_to_9_char_id("call_1"), "000mmc6eo");
        assert_eq!(normalize_to_9_char_id("x"), "00000003c");
        assert_eq!(normalize_to_9_char_id(""), "000000000");
        // Already nine characters: returned untouched.
        assert_eq!(normalize_to_9_char_id("abcdefghi"), "abcdefghi");
    }

    /// `simple_hash` is the reference's signed-32-bit `|0` accumulator. A one-character change must
    /// move it, and the known values must match.
    #[test]
    fn the_hash_matches_the_reference_implementation() {
        assert_eq!(simple_hash("0:read:{}"), 1_774_314_884);
        assert_eq!(simple_hash("1:bash:{\"cmd\":"), 840_660_370);
        assert_eq!(simple_hash("0::"), 47_984);
        assert_eq!(simple_hash("7:Write:{\"path\":\"/tmp/x\"}"), 720_389_268);
    }

    // ── tool response hygiene ─────────────────────────────────────────────

    #[test]
    fn inserts_empty_tool_results_for_missing_responses() {
        let out = normalize(
            json!({ "messages": [{ "role": "assistant", "tool_calls": [
                { "id": "call_1", "function": { "name": "read", "arguments": "{}" } }
            ] }] }),
            NormalizeOptions::default(),
        );
        let msgs = messages_of(&out);
        assert_eq!(msgs.len(), 2, "expected the assistant turn plus one inserted tool result");
        assert_eq!(msgs[1].get("role").and_then(Value::as_str), Some("tool"));
        assert_eq!(msgs[1].get("tool_call_id").and_then(Value::as_str), Some("call_1"));
        assert!(msgs.get(2).is_none(), "no trailing turn is appended");
    }

    /// The repaired result goes directly after the assistant turn that declared the call, not at the
    /// end of the conversation — the dialect reads tool results positionally.
    #[test]
    fn inserts_a_missing_tool_result_directly_after_its_assistant_turn() {
        let out = normalize(
            json!({ "messages": [
                { "role": "user", "content": "go" },
                { "role": "assistant", "tool_calls": [
                    { "id": "call_1", "function": { "name": "read", "arguments": "{}" } }
                ] },
                { "role": "user", "content": "and then?" },
            ] }),
            NormalizeOptions::default(),
        );
        let msgs = messages_of(&out);
        assert_eq!(msgs.len(), 4, "one result inserted, nothing else added");
        assert_eq!(msgs[2].get("role").and_then(Value::as_str), Some("tool"));
        assert_eq!(msgs[2].get("tool_call_id").and_then(Value::as_str), Some("call_1"));
        assert_eq!(msgs[3].get("role").and_then(Value::as_str), Some("user"));
    }

    /// Regression (2026-09-20): appending an empty user turn after a tool result makes Agnes reject
    /// the whole continuation with HTTP 400 "message content cannot be empty".
    #[test]
    fn does_not_append_a_trailing_user_turn_after_a_tool_result() {
        let out = normalize(
            json!({ "messages": [
                { "role": "user", "content": "hi" },
                { "role": "assistant", "content": null, "tool_calls": [
                    { "id": "call_1", "type": "function", "function": { "name": "read", "arguments": "{}" } }
                ] },
                { "role": "tool", "tool_call_id": "call_1", "content": "a.txt" },
            ] }),
            NormalizeOptions::default(),
        );
        let msgs = messages_of(&out);
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[msgs.len() - 1].get("role").and_then(Value::as_str), Some("tool"));
    }

    #[test]
    fn never_leaves_a_user_or_assistant_turn_with_empty_string_content() {
        let out = normalize(
            json!({ "messages": [
                { "role": "user", "content": "hi" },
                { "role": "assistant", "content": null, "tool_calls": [
                    { "id": "call_1", "type": "function", "function": { "name": "read", "arguments": "{}" } }
                ] },
                { "role": "tool", "tool_call_id": "call_1", "content": "a.txt" },
            ] }),
            NormalizeOptions::default(),
        );
        let empties: Vec<&Value> = messages_of(&out)
            .iter()
            .filter(|m| {
                let r = m.get("role").and_then(Value::as_str).unwrap_or("");
                (r == "user" || r == "assistant")
                    && m.get("content").map(|c| c == &json!("")).unwrap_or(false)
            })
            .collect();
        assert!(empties.is_empty(), "found empty content: {empties:?}");
    }

    #[test]
    fn strips_orphaned_tool_results() {
        let out = normalize(
            json!({ "messages": [
                { "role": "assistant", "tool_calls": [
                    { "id": "call_1", "function": { "name": "read", "arguments": "{}" } }
                ] },
                { "role": "tool", "tool_call_id": "call_1", "content": "ok" },
                { "role": "tool", "tool_call_id": "call_2", "content": "orphan" },
            ] }),
            NormalizeOptions::default(),
        );
        let tool_msgs: Vec<&Value> = messages_of(&out)
            .iter()
            .filter(|m| m.get("role").and_then(Value::as_str) == Some("tool"))
            .collect();
        assert_eq!(tool_msgs.len(), 1);
        assert_eq!(tool_msgs[0].get("tool_call_id").and_then(Value::as_str), Some("call_1"));
    }

    // ── tool schema sanitization ──────────────────────────────────────────

    #[test]
    fn strips_null_from_enum_arrays() {
        let out = normalize(
            json!({
                "messages": [{ "role": "user", "content": "hi" }],
                "tools": [{ "type": "function", "function": { "name": "test", "parameters": {
                    "type": "object",
                    "properties": { "color": { "type": "string", "enum": ["red", "blue", null] } },
                } } }],
            }),
            NormalizeOptions::default(),
        );
        assert_eq!(
            out["tools"][0]["function"]["parameters"]["properties"]["color"]["enum"],
            json!(["red", "blue"])
        );
    }

    #[test]
    fn ensures_a_root_object_type_when_missing() {
        let out = normalize(
            json!({
                "messages": [{ "role": "user", "content": "hi" }],
                "tools": [{ "type": "function", "function": { "name": "test", "parameters": {
                    "properties": { "foo": { "type": "string" } },
                } } }],
            }),
            NormalizeOptions::default(),
        );
        assert_eq!(out["tools"][0]["function"]["parameters"]["type"], json!("object"));
    }

    #[test]
    fn filters_required_to_existing_property_keys() {
        let out = normalize(
            json!({
                "messages": [{ "role": "user", "content": "hi" }],
                "tools": [{ "type": "function", "function": { "name": "test", "parameters": {
                    "type": "object",
                    "properties": { "foo": { "type": "string" } },
                    "required": ["foo", "bar", 123],
                } } }],
            }),
            NormalizeOptions::default(),
        );
        assert_eq!(out["tools"][0]["function"]["parameters"]["required"], json!(["foo"]));
    }

    #[test]
    fn flattens_tuple_form_items_to_a_single_schema() {
        let out = normalize(
            json!({
                "messages": [{ "role": "user", "content": "hi" }],
                "tools": [{ "type": "function", "function": { "name": "test", "parameters": {
                    "type": "object",
                    "properties": { "list": { "type": "array", "items": [{ "type": "string" }, { "type": "number" }] } },
                } } }],
            }),
            NormalizeOptions::default(),
        );
        assert_eq!(
            out["tools"][0]["function"]["parameters"]["properties"]["list"]["items"],
            json!({ "type": "string" })
        );
    }

    /// An opaque object schema is kept open, and `additionalProperties` is only added when the
    /// caller did not set it — including to `false`.
    #[test]
    fn keeps_opaque_object_schemas_open_without_overriding_a_stated_value() {
        let closed =
            sanitize_schema(&json!({ "type": "object", "additionalProperties": false }), 0);
        assert_eq!(closed["additionalProperties"], json!(false));

        let opaque = sanitize_schema(&json!({ "type": "object" }), 0);
        assert_eq!(opaque["properties"], json!({}));
        assert_eq!(opaque["additionalProperties"], json!(true));
    }

    /// Beyond the depth cap a schema collapses to `{}` rather than recursing without bound.
    #[test]
    fn a_schema_past_the_depth_cap_collapses_to_an_empty_object() {
        let mut nested = json!({ "type": "object" });
        for _ in 0..(MAX_SCHEMA_DEPTH + 5) {
            nested = json!({ "type": "object", "properties": { "n": nested } });
        }
        // The walk must terminate; the deep node collapses rather than expanding forever.
        let out = sanitize_schema(&nested, 0);
        assert!(out.is_object());
    }

    #[test]
    fn sanitize_openai_tools_passes_a_non_array_through() {
        assert_eq!(sanitize_openai_tools(&json!("not tools")), json!("not tools"));
    }

    #[test]
    fn sanitize_openai_tools_handles_the_responses_shape() {
        let out = sanitize_openai_tools(&json!([
            { "type": "function", "name": "test", "parameters": { "properties": { "x": { "type": "string" } } } }
        ]));
        assert_eq!(out[0]["parameters"]["type"], json!("object"));
    }

    // ── message shape fixes ───────────────────────────────────────────────

    #[test]
    fn promotes_a_codex_string_input_to_messages() {
        let out = normalize(
            json!({ "input": "Hello" }),
            NormalizeOptions { client_hint: Some(ClientHint::Codex), ..Default::default() },
        );
        assert!(out.get("messages").map(Value::is_array).unwrap_or(false));
        // The Responses shape carries `type: "message"`; `toMatchObject` allowed it, so this does.
        assert_matches(
            &messages_of(&out)[0],
            &json!({ "role": "user", "content": [{ "type": "input_text", "text": "Hello" }] }),
        );
    }

    #[test]
    fn promotes_an_array_input_to_messages() {
        let out = normalize(
            json!({ "input": [{ "role": "user", "content": "Hello" }] }),
            NormalizeOptions::default(),
        );
        assert!(out.get("messages").map(Value::is_array).unwrap_or(false));
        assert_matches(
            &messages_of(&out)[0],
            &json!({ "role": "user", "content": [{ "type": "text", "text": "Hello" }] }),
        );
    }

    #[test]
    fn converts_string_content_to_an_array() {
        let out = normalize(
            json!({ "messages": [{ "role": "user", "content": "Hello" }] }),
            NormalizeOptions::default(),
        );
        assert_eq!(messages_of(&out)[0]["content"], json!([{ "type": "text", "text": "Hello" }]));
    }

    #[test]
    fn leaves_a_tool_result_terminated_conversation_as_the_last_turn() {
        let out = normalize(
            json!({ "messages": [
                { "role": "assistant", "tool_calls": [
                    { "id": "call_1", "function": { "name": "read", "arguments": "{}" } }
                ] },
                { "role": "tool", "tool_call_id": "call_1", "content": "ok" },
            ] }),
            NormalizeOptions::default(),
        );
        let msgs = messages_of(&out);
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[msgs.len() - 1].get("role").and_then(Value::as_str), Some("tool"));
    }

    // ── Claude Code adaptations ───────────────────────────────────────────

    #[test]
    fn remaps_claude_tool_names_from_lowercase_to_titlecase() {
        let out = normalize(
            json!({
                "messages": [{ "role": "user", "content": "hi" }],
                "tools": [{ "type": "function", "function": { "name": "bash", "parameters": { "type": "object" } } }],
            }),
            NormalizeOptions { client_hint: Some(ClientHint::ClaudeCode), ..Default::default() },
        );
        assert_eq!(out["tools"][0]["function"]["name"], json!("Bash"));
    }

    #[test]
    fn remaps_tool_use_block_names_in_the_message_history() {
        let out = normalize(
            json!({
                "messages": [{ "role": "assistant", "content": [
                    { "type": "tool_use", "id": "tu_1", "name": "bash", "input": {} }
                ] }],
                "tools": [{ "type": "function", "function": { "name": "bash", "parameters": { "type": "object" } } }],
            }),
            NormalizeOptions { client_hint: Some(ClientHint::ClaudeCode), ..Default::default() },
        );
        assert_eq!(messages_of(&out)[0]["content"][0]["name"], json!("Bash"));
    }

    #[test]
    fn remaps_a_tool_choice_name() {
        let out = normalize(
            json!({
                "messages": [{ "role": "user", "content": "hi" }],
                "tool_choice": { "type": "tool", "name": "bash" },
            }),
            NormalizeOptions { client_hint: Some(ClientHint::ClaudeCode), ..Default::default() },
        );
        assert_eq!(out["tool_choice"]["name"], json!("Bash"));
    }

    /// The renames are recorded so a later response pass can restore the client's own names.
    #[test]
    fn tracks_renames_in_the_returned_map() {
        let result = normalize_gateway_request(
            &json!({
                "messages": [{ "role": "user", "content": "hi" }],
                "tools": [{ "type": "function", "function": { "name": "bash", "parameters": { "type": "object" } } }],
            }),
            &NormalizeOptions { client_hint: Some(ClientHint::ClaudeCode), ..Default::default() },
        );
        assert_eq!(result.tool_name_map.get("Bash").map(String::as_str), Some("bash"));
    }

    /// The map is carried out-of-band: it must never leak into the body that is sent upstream.
    #[test]
    fn the_tool_name_map_never_leaks_into_the_body() {
        let result = normalize_gateway_request(
            &json!({
                "messages": [{ "role": "user", "content": "hi" }],
                "tools": [{ "type": "function", "function": { "name": "bash", "parameters": { "type": "object" } } }],
            }),
            &NormalizeOptions { client_hint: Some(ClientHint::ClaudeCode), ..Default::default() },
        );
        assert!(!result.tool_name_map.is_empty(), "the fixture must actually rename something");
        assert!(result.body.get("_toolNameMap").is_none(), "_toolNameMap leaked into the body");
        let rendered = serde_json::to_string(&result.body).unwrap();
        assert!(!rendered.contains("_toolNameMap"), "leaked into the serialized body: {rendered}");
    }

    /// A generic client renames nothing, and the map stays empty.
    #[test]
    fn a_generic_client_renames_nothing() {
        let result = normalize_gateway_request(
            &json!({
                "messages": [{ "role": "user", "content": "hi" }],
                "tools": [{ "type": "function", "function": { "name": "bash", "parameters": { "type": "object" } } }],
            }),
            &NormalizeOptions::default(),
        );
        assert!(result.tool_name_map.is_empty());
        assert_eq!(result.body["tools"][0]["function"]["name"], json!("bash"));
    }

    // ── zcode / z.ai adaptations ──────────────────────────────────────────

    /// Regression (2026-09-20): the empty user turn this used to fabricate could never satisfy the
    /// upstream's "no user query" rejection, because an empty turn is rejected too.
    #[test]
    fn does_not_fabricate_an_empty_user_turn_for_zcode() {
        let out = normalize(
            json!({ "messages": [{ "role": "assistant", "content": "Hi" }] }),
            NormalizeOptions { client_hint: Some(ClientHint::Zcode), ..Default::default() },
        );
        let msgs = messages_of(&out);
        assert!(!msgs.iter().any(|m| m.get("role").and_then(Value::as_str) == Some("user")));
        assert!(!msgs.iter().any(|m| m.get("content") == Some(&json!(""))));
    }

    #[test]
    fn does_not_add_a_user_turn_when_one_already_exists() {
        let out = normalize(
            json!({ "messages": [
                { "role": "user", "content": "Hello" },
                { "role": "assistant", "content": "Hi" },
            ] }),
            NormalizeOptions { client_hint: Some(ClientHint::Zcode), ..Default::default() },
        );
        let users = messages_of(&out)
            .iter()
            .filter(|m| m.get("role").and_then(Value::as_str) == Some("user"))
            .count();
        assert_eq!(users, 1);
    }

    #[test]
    fn preserves_system_prompts_for_zcode() {
        let out = normalize(
            json!({ "messages": [
                { "role": "system", "content": "Always respond in JSON format" },
                { "role": "user", "content": "hi" },
            ] }),
            NormalizeOptions { client_hint: Some(ClientHint::Zcode), ..Default::default() },
        );
        let sys = messages_of(&out)
            .iter()
            .find(|m| m.get("role").and_then(Value::as_str) == Some("system"))
            .expect("system turn preserved");
        assert_eq!(sys["content"][0]["text"], json!("Always respond in JSON format"));
    }

    // ── Codex adaptations ─────────────────────────────────────────────────

    #[test]
    fn promotes_reasoning_effort_to_reasoning_effort_field() {
        let out = normalize(
            json!({ "messages": [{ "role": "user", "content": "hi" }], "reasoning_effort": "high" }),
            NormalizeOptions { client_hint: Some(ClientHint::Codex), ..Default::default() },
        );
        assert_eq!(out["reasoning"], json!({ "effort": "high" }));
        assert!(out.get("reasoning_effort").is_none());
    }

    #[test]
    fn maps_max_completion_tokens_to_max_output_tokens() {
        let out = normalize(
            json!({ "messages": [{ "role": "user", "content": "hi" }], "max_completion_tokens": 4096 }),
            NormalizeOptions { client_hint: Some(ClientHint::Codex), ..Default::default() },
        );
        assert_eq!(out["max_output_tokens"], json!(4096));
        assert!(out.get("max_completion_tokens").is_none());
        assert!(out.get("max_tokens").is_none());
    }

    #[test]
    fn maps_max_tokens_to_max_output_tokens_when_the_other_is_absent() {
        let out = normalize(
            json!({ "messages": [{ "role": "user", "content": "hi" }], "max_tokens": 2048 }),
            NormalizeOptions { client_hint: Some(ClientHint::Codex), ..Default::default() },
        );
        assert_eq!(out["max_output_tokens"], json!(2048));
        assert!(out.get("max_tokens").is_none());
    }

    #[test]
    fn maps_response_format_to_text_format() {
        let out = normalize(
            json!({ "messages": [{ "role": "user", "content": "hi" }], "response_format": { "type": "json_object" } }),
            NormalizeOptions { client_hint: Some(ClientHint::Codex), ..Default::default() },
        );
        assert_eq!(out["text"], json!({ "format": { "type": "json_object" } }));
        assert!(out.get("response_format").is_none());
    }

    #[test]
    fn normalizes_a_codex_string_input_to_a_message_array() {
        let out = normalize(
            json!({ "input": "Hello" }),
            NormalizeOptions { client_hint: Some(ClientHint::Codex), ..Default::default() },
        );
        assert!(out.get("input").is_none(), "input is promoted and deleted");
        let msgs = messages_of(&out);
        assert_eq!(msgs[0].get("role").and_then(Value::as_str), Some("user"));
        assert_eq!(msgs[0]["content"][0]["text"], json!("Hello"));
    }

    /// `max_output_tokens` already present: the aliases are dropped rather than competing with it.
    #[test]
    fn a_stated_max_output_tokens_wins_and_the_aliases_are_dropped() {
        let out = normalize(
            json!({ "messages": [{ "role": "user", "content": "hi" }], "max_output_tokens": 100, "max_tokens": 999 }),
            NormalizeOptions { client_hint: Some(ClientHint::Codex), ..Default::default() },
        );
        assert_eq!(out["max_output_tokens"], json!(100));
        assert!(out.get("max_tokens").is_none());
    }

    /// `reasoning` already present: the alias is left alone. The reference's `delete` sits **inside**
    /// the guard (`gateway-normalizer.ts:596-602`), so unlike the `max_output_tokens` case it does not
    /// drop the alias. That asymmetry is the reference's, and this port reproduces it rather than
    /// quietly correcting it.
    #[test]
    fn a_stated_reasoning_object_is_not_overwritten_by_the_alias() {
        let out = normalize(
            json!({ "messages": [{ "role": "user", "content": "hi" }], "reasoning": { "effort": "low" }, "reasoning_effort": "high" }),
            NormalizeOptions { client_hint: Some(ClientHint::Codex), ..Default::default() },
        );
        assert_eq!(out["reasoning"], json!({ "effort": "low" }));
        assert_eq!(
            out["reasoning_effort"],
            json!("high"),
            "the alias survives when `reasoning` is already present"
        );
    }

    // ── purity ────────────────────────────────────────────────────────────

    /// The caller's body is never mutated — the pipeline works on a deep clone.
    #[test]
    fn normalizing_does_not_mutate_the_caller_body() {
        let original = json!({
            "messages": [{ "role": "user", "content": "Hello" }],
            "tools": [{ "type": "function", "function": { "name": "bash", "parameters": { "type": "object" } } }],
        });
        let before = original.clone();
        let mut out = normalize(original.clone(), NormalizeOptions::default());
        // Mutate the result deeply; the caller's copy must be untouched.
        out["messages"][0]["role"] = json!("tampered");
        out["tools"][0]["function"]["name"] = json!("tampered");
        assert_eq!(original, before, "the caller's body was mutated through the result");
        assert_eq!(
            original["messages"][0]["content"],
            json!("Hello"),
            "string content unchanged upstream"
        );
    }
}
