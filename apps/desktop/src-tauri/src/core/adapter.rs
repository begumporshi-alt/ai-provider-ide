//! The adapter seam — what the execution engine needs from a provider adapter, and nothing beyond
//! that.
//!
//! **The seam is whole for the two members the engine calls.** `adapter-instance.ts` declares seven
//! members; `execution-engine.ts` calls exactly two of them — `generateImage` (`:174`) and
//! `generateText` (`:91`) — and both are below. The other five (`capabilities`, `tagModality`,
//! `listModels`, `pingKey`, `dispose`) are called by the planner, the key probe and the runtime,
//! none of which is ported, so they are absent rather than overlooked.
//!
//! **`generate_text` waited on one decision, and it was not difficulty.** Its `TextArgs` carries
//! `messages`, `tools`, `toolChoice` and `responseFormat` as `unknown`, plus an `onUsage` callback
//! that is load-bearing — dropping the caller's callback is how every gateway response came to
//! report `usage: null` (`execution-engine.ts:93-96`). On this side those `unknown`s become
//! `serde_json::Value` and the callbacks become `&mut dyn FnMut`, and `onUsage` would have
//! introduced a **second** usage shape beside the `BridgeMsg::Usage` the crate already has
//! (`gateway.rs:366`) — the two-spellings-of-one-state defect this repo keeps finding (D19, D21).
//! The callback therefore carries `core::usage::UsageTokens`, the crate's single three-field home
//! for token counts, landed in increment 8 and recorded as D23. **That was the whole of the
//! blocker.** What remains open is the loop over this seam — `engine::execute_text` — and with it
//! how a streaming loop owns the mutable state it must keep alive across its yields.
//!
//! What is here is the Rust port of `adapter-instance.ts` (31 lines) together with the shapes the
//! engine passes across it. It is its own module for the same reason the TypeScript keeps it in its
//! own file: an adapter implementation depends on *this* and not on the engine, so the dependency
//! points one way and the engine can be tested against a double.
//!
//! **What the seam is for.** `manifest-interpreter.ts` (declarative) and `code-adapter.ts` (the
//! Tier-2 sandbox) both implement it, and the engine cannot tell them apart. That is what keeps
//! the sandbox decision open: a subprocess-backed adapter is simply another implementor, so
//! "in-process or out-of-process" is not a question this trait has to answer.
//!
//! **Two traits, not one.** `AdapterInstance` is one provider's adapter; `AdapterFactory` resolves
//! a provider id to it. The TypeScript splits them too (`AdapterFactory` is a private interface
//! inside `execution-engine.ts`), and the split is what lets the engine be handed a factory that
//! returns doubles.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use futures_util::future::BoxFuture;
use futures_util::stream::BoxStream;
use serde_json::Value;

use crate::core::engine::AttemptError;
pub use crate::core::manifest_view::Capabilities;
use crate::core::usage::UsageTokens;

/// An abort flag — the port of `AbortSignal`.
///
/// The engine only ever asks two questions of an `AbortSignal`: *is it aborted*, and *does the
/// adapter see it*. A flag answers both, so a flag is the honest shape rather than a stand-in.
/// `Arc<AtomicBool>` rather than a `CancellationToken` because `tokio-util` is not a dependency
/// and this port may not add one.
#[derive(Debug, Clone, Default)]
pub struct Cancel(Arc<AtomicBool>);

impl Cancel {
    pub fn new() -> Self {
        Self::default()
    }

    /// Raise the flag. Idempotent — the TypeScript's `abort()` is too.
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// What an image attempt is asked to produce.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageArgs {
    /// The **native** model id, resolved by the planner — not the id the caller typed.
    pub model: String,
    pub prompt: String,
    pub size: Option<String>,
}

/// The outcome of an image attempt.
///
/// **`ok: false` is a refusal, not a failed call.** The provider answered and said no, and the
/// status is what the engine classifies. `Err` from [`AdapterInstance::generate_image`] means the
/// call itself did not complete. The TypeScript draws the same line and it is load-bearing:
/// `manifest-interpreter.ts:461` **returns** `{ok: false, status}` for a `>= 400` rather than
/// throwing, so a refusal keeps its status while a throw does not.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageReply {
    pub ok: bool,
    pub status: u16,
    pub base64: Option<String>,
    pub url: Option<String>,
    /// The provider's own words, when it refused. Kept for the ledger and for the operator; the
    /// engine itself never reads it.
    pub error_body: Option<String>,
}

/// A real tool call returned by a provider — the port of `ports.ts`'s `ToolCall` (`ports.ts:50-57`).
///
/// **Distinct from the in-band pseudo-tokens some models emit as plain text.** Those arrive as
/// ordinary chunks and are the caller's problem; this shape carries the provider's own `tool_calls`
/// field, which the chunk protocol cannot express because a chunk is a string.
///
/// `arguments` is the raw JSON string exactly as the provider built it — parsing it is the caller's
/// job, because only the caller knows the schema of its own tools. `raw` keeps the provider's own
/// object for dialects that carry fields this shape does not model.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolCall {
    pub id: Option<String>,
    pub name: Option<String>,
    /// JSON text; may be empty when the model calls a tool that takes no arguments.
    pub arguments: Option<String>,
    pub raw: Option<Value>,
}

/// What a text attempt is asked to produce — the port of `TextArgs` (`manifest-interpreter.ts:70-91`).
///
/// **The four `unknown`s become `Value`, and they stay opaque on purpose.** `messages`, `tools`,
/// `tool_choice` and `response_format` are forwarded verbatim; the router never interprets them,
/// which is what lets one shape serve every dialect's request template.
///
/// **They are borrowed, not owned, and the loop is why.** Increment 9 landed them as owned
/// (`Vec<Value>`, `Option<Value>`) because that is what the TypeScript's `unknown[]` looks like
/// written down. The engine's loop is their first consumer, and it builds one `TextArgs` per
/// attempt — so owned payloads mean a deep copy of the whole conversation *per attempt*, which is
/// once per request in the common case, where the TypeScript passes one array by reference and
/// copies nothing. `messages` grows with the conversation and `tools` with the client's toolset, so
/// they are the wrong things to copy for a shape's convenience. The borrow is also the faithful
/// reading: the TypeScript's own parameter is `messages: unknown[]`, a reference.
///
/// **The two callbacks sit on this struct because the TypeScript puts them there**, and that is the
/// whole reason for the `'a`. A `&mut dyn FnMut` cannot be a field of a struct without a lifetime,
/// so `TextArgs` is parameterised rather than the callbacks being moved out into a sibling
/// argument. The faithful shape was worth the lifetime: one struct carrying the same ten fields as
/// its source is checkable against that source, where two structs require the reader to re-derive
/// why the split is where it is. The cost is stated rather than hidden — **`TextArgs` has no
/// derives**, because `dyn FnMut` is neither `Debug`, `Clone` nor `Eq`.
///
/// **One lifetime is enough, and the first consumer nearly proved otherwise.** The obvious reading
/// of "the callbacks are re-borrowed per attempt, the payloads are held for the request" is that
/// the two need separate lifetimes. It is wrong, and it was measured: splitting them changes
/// nothing, and a single `'a` compiles the engine's loop once the *call site* is right. What
/// actually fails is handing this struct a `&mut dyn FnMut` taken straight off a field of the
/// caller's own argument struct — see `execute_text`'s `forward_tool` for the shape that works and
/// the reasoning. A shape diagnosis was made here, falsified against a 60-line reproduction, and
/// replaced by the call-site one; the seam did not need changing.
pub struct TextArgs<'a> {
    pub model: String,
    pub messages: &'a [Value],
    pub stream: bool,
    pub max_tokens: Option<u64>,
    pub temperature: Option<f64>,
    pub tools: Option<&'a Value>,
    pub tool_choice: Option<&'a Value>,
    pub response_format: Option<&'a Value>,
    /// Reports REAL tool calls. They cannot ride along in the chunk stream — the chunk protocol is
    /// strings only — and they cannot be derived from the text, which is empty on a tool-call turn.
    pub on_tool_call: Option<&'a mut (dyn FnMut(ToolCall) + Send)>,
    /// Called once with whatever usage the upstream reported, if it reported anything at all.
    pub on_usage: Option<&'a mut (dyn FnMut(UsageTokens) + Send)>,
    /// Called once with the finish reason, translated into the **OpenAI vocabulary** by the
    /// manifest's `responseFinishMap` (Anthropic's `max_tokens` → `length`). `None` when the dialect
    /// declares no `responseFinish` selector or the provider emitted no reason.
    ///
    /// **Why OpenAI's vocabulary and not the dialect's own word:** both consumers speak it — the
    /// app's truncation warning tests `reason == "length"`, and the gateway writes the value onto an
    /// OpenAI-shaped `finish_reason`. See `dialect_shaping::translate_finish_reason`.
    pub on_finish: Option<&'a mut (dyn FnMut(Option<String>) + Send)>,
    /// The model's **reasoning**, as it streams — its own channel, never mixed into the chunk
    /// stream, because reasoning is the model's notes and a consumer that rendered it as prose
    /// would be quoting the notes as the answer.
    ///
    /// Detected by the payload's **own field names** (`delta.thinking` for Anthropic,
    /// `delta.reasoning_content` for the OpenAI-compatible gateways, `delta.reasoning` for the
    /// third spelling), not by a manifest selector: a provider wired up before this existed has no
    /// selector to add, and the TypeScript side made the same call for the same reason. `None` (the
    /// default) means the caller does not want reasoning and the adapter discards it — a reasoning
    /// stream still produces zero chunks, so a caller that ignores this channel sees exactly what
    /// it saw before.
    ///
    /// **Reasoning is not delivered output.** Firing this must not mark the attempt served, end
    /// failover, or change any disposition — the `NO_OUTPUT` classification for a stream that
    /// reasoned and never answered depends on that staying true.
    pub on_reasoning: Option<&'a mut (dyn FnMut(&str) + Send)>,
    /// Mark the last system message block with `cache_control: {"type":"ephemeral"}` on egress.
    /// Off by default; a provider without prefix caching will ignore or reject the field, so
    /// this is opt-in per operator. See `TextRequest::prompt_cache_enabled` for the read-side
    /// note.
    pub prompt_cache_enabled: bool,
    /// Filled by the adapter with what the stream actually carried, whether or not the manifest
    /// could read any of it. The engine reads it only when the stream delivered nothing — the arm
    /// that files `PARSE_ERROR` with no status and an empty chain, and the reason 154 rows in the
    /// live ledger said nothing about whether the provider sent nothing at all or sent a shape the
    /// manifest's delta selector does not match.
    pub observation: Option<&'a mut StreamObservation>,
}

/// What one upstream stream carried, counted at the source.
///
/// Deliberately counts, not a buffer: how many `data:` events arrived, what **kind** of delta each
/// one carried, and truncated samples. The kinds are the minimum that separates three findings with
/// different owners — "the provider streamed nothing", "it streamed a shape this manifest cannot
/// read", and "it streamed reasoning and the model never wrote an answer" — and samples are the most
/// a ledger row can afford, since the payload is provider output and a full body would put user
/// content in the database at whatever length the provider chose.
///
/// The classification is the Rust mirror of `stream-shape.ts` (which was built from the same
/// captured `agentrouter.org` envelopes), and the two must agree about a given wire shape: the same
/// request classifies through whichever engine serves it, and two records of one request that
/// contradict each other is a defect class this codebase has fixed twice.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct StreamObservation {
    pub events: u32,
    pub first: Option<String>,
    /// Deltas that carried the **answer** (`delta.text` / `delta.content`).
    pub text: u32,
    /// Payloads classified as reasoning, **including** a `content_block_start` that only announces
    /// a thinking block — an announcement makes the reasoning real before its deltas arrive.
    pub reasoning: u32,
    /// Reasoning deltas that carried reasoning *text*. The `NO_OUTPUT` classification keys on this,
    /// not on `reasoning`: the TypeScript classifies from accumulated reasoning *content*, which an
    /// announcement contributes none of, so a stream that announced thinking and carried nothing is
    /// `PARSE_ERROR` on both engines.
    pub reasoning_carried: u32,
    /// Deltas that carried tool-call fragments (`partial_json` / `tool_calls`).
    pub tool: u32,
    /// Anthropic's lifecycle events, which legitimately carry no delta.
    pub lifecycle: u32,
    /// Parsed but unrecognised, or not JSON at all.
    pub other: u32,
    /// The first payload that actually **carried a delta** — the representative sample. Positional
    /// sampling quoted `message_start`, an event every Anthropic stream opens with, which is how a
    /// row could stand for 8198 events while distinguishing none of them.
    pub first_delta: Option<String>,
    /// The reasoning field the stream used (`delta.thinking` vs `delta.reasoning_content` — an
    /// Anthropic reasoning model vs an OpenAI-compatible one), named so an operator can judge the
    /// finding. Set from carried deltas only: an announcement would name a key that is still null.
    pub reasoning_field: Option<String>,
    /// The raw finish reason seen on the stream (`delta.stop_reason` / `finish_reason`) — the
    /// evidence that turns "the model reasoned" into "the model spent its output budget reasoning".
    pub finish: Option<String>,
}

/// Anthropic's lifecycle events. They legitimately carry no delta, so a stream of only these is
/// "the provider answered and had nothing to say" rather than a shape failure.
const LIFECYCLE_TYPES: [&str; 6] = [
    "message_start",
    "message_delta",
    "message_stop",
    "ping",
    "content_block_start",
    "content_block_stop",
];

/// The truncated sample of a payload, cut on a char boundary.
///
/// The cap is in **bytes** — what a `TEXT` column and a `String` both measure — but a byte-indexed
/// slice landing mid-UTF-8 would panic, so the cut walks back to a boundary first.
fn sample(payload: &str, cap: usize) -> String {
    if payload.len() <= cap {
        return payload.to_string();
    }
    let mut cut = cap;
    while !payload.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}…", &payload[..cut])
}

impl StreamObservation {
    /// The sample cap, in bytes. 240: enough to show a delta shape or an error envelope, small next
    /// to a row's other text columns.
    const SAMPLE_CHARS: usize = 240;

    /// Record one `data:` payload. Called for every event, before any selector runs — a payload the
    /// provider sent is evidence even when nothing downstream can read it.
    ///
    /// Classification keys on the payload's **own field names**, not on a manifest selector: the two
    /// dialects put reasoning in two different places (`delta.thinking` for Anthropic,
    /// `delta.reasoning_content` for the OpenAI-compatible gateways), and a provider wired up before
    /// this existed has no selector to add — measured on the live `agent-router` manifest, whose
    /// persisted `chunkMap` is `{delta}` alone.
    pub fn note(&mut self, payload: &str) {
        self.events += 1;
        if self.first.is_none() {
            self.first = Some(sample(payload, Self::SAMPLE_CHARS));
        }
        let Ok(json) = serde_json::from_str::<serde_json::Value>(payload) else {
            self.other += 1;
            return;
        };
        // The raw finish reason, wherever the dialect puts it on a stream chunk. Raw, deliberately:
        // this is evidence about the wire, not the OpenAI translation.
        if self.finish.is_none() {
            let finish = json
                .pointer("/delta/stop_reason")
                .or_else(|| json.pointer("/choices/0/finish_reason"))
                .or_else(|| json.get("stop_reason"))
                .and_then(|v| v.as_str());
            if let Some(f) = finish {
                self.finish = Some(f.to_string());
            }
        }
        // The delta object, wherever this dialect puts it: top level for Anthropic, `choices[0]`
        // for a raw OpenAI chunk.
        let delta = json.get("delta").filter(|d| d.is_object()).map(|d| (d, ""));
        let delta = delta.or_else(|| {
            let d = json.pointer("/choices/0/delta")?;
            d.as_object().map(|_| (d, "choices[0]."))
        });
        let Some((delta, path)) = delta else {
            // No delta object. A `content_block_start` announcing a thinking block still makes the
            // reasoning real before its deltas arrive — but it names no stream field and is not a
            // carried delta, exactly like the TypeScript tally.
            if json.pointer("/content_block/type").and_then(|t| t.as_str()) == Some("thinking") {
                self.reasoning += 1;
                return;
            }
            match json.get("type").and_then(|t| t.as_str()) {
                Some(t) if LIFECYCLE_TYPES.contains(&t) => self.lifecycle += 1,
                _ => self.other += 1,
            }
            return;
        };
        let dtype = delta.get("type").and_then(|t| t.as_str()).unwrap_or("");
        // Text first: `text` is Anthropic's field, `content` is OpenAI's, `text_delta` the declared
        // discriminator. Any of the three means this event carried the answer.
        if dtype == "text_delta" || delta.get("text").is_some_and(|v| v.is_string()) {
            self.text += 1;
            self.carried(payload);
        } else if delta.get("content").is_some_and(|v| v.is_string()) {
            self.text += 1;
            self.carried(payload);
        } else if dtype == "thinking_delta" || delta.get("thinking").is_some_and(|v| v.is_string())
        {
            self.reasoning += 1;
            self.reasoning_carried += 1;
            self.reasoning_field.get_or_insert_with(|| format!("{path}delta.thinking"));
            self.carried(payload);
        } else if delta.get("reasoning_content").is_some_and(|v| v.is_string())
            || dtype == "reasoning"
        {
            self.reasoning += 1;
            self.reasoning_carried += 1;
            self.reasoning_field.get_or_insert_with(|| format!("{path}delta.reasoning_content"));
            self.carried(payload);
        } else if dtype == "input_json_delta"
            || delta.get("partial_json").is_some_and(|v| v.is_string())
            || delta.get("tool_calls").is_some_and(|v| v.is_array())
        {
            self.tool += 1;
            self.carried(payload);
        } else {
            self.other += 1;
        }
    }

    /// A payload that carried the delta itself: worth sampling as the representative one.
    /// An announcement is not one — see the `content_block_start` arm.
    fn carried(&mut self, payload: &str) {
        if self.first_delta.is_none() {
            self.first_delta = Some(sample(payload, Self::SAMPLE_CHARS));
        }
    }

    /// The ledger wording for a stream that yielded nothing — the Rust mirror of
    /// `describeSilentStream` (`stream-shape.ts`), word for word where the words are the contract.
    ///
    /// Three findings, which a reader acts on differently:
    ///  - nothing at all → the provider sent no events
    ///  - every delta reasoning → the provider behaved correctly and the model never emitted text,
    ///    so there is no manifest to fix and the selector is not at fault
    ///  - otherwise → a shape the manifest does not select, with a representative delta quoted
    pub fn describe(&self) -> Option<String> {
        if self.events == 0 {
            return Some("stream carried no SSE events at all".to_string());
        }
        let quoted = self.first_delta.as_deref().or(self.first.as_deref());
        let Some(quoted) = quoted else {
            return Some(format!(
                "stream carried {} SSE event(s) with no readable payload",
                self.events
            ));
        };
        let head = format!(
            "stream carried {} SSE event(s), none matched the manifest's delta selector",
            self.events
        );
        if self.text == 0 && self.tool == 0 && self.reasoning > 0 {
            // The measured case (2026-10-02, `agentrouter.org` / `deepseek-v4-flash`): extended
            // thinking is on by default, `max_tokens` covers thinking **and** answer, and the
            // thinking consumed the whole 8192-token budget. Probed: the same prompt answers at
            // 64000, and answers in 9 s with thinking disabled. The advice is the actionable half;
            // the finding above it is what a reader must be able to trust first. `finish` is the
            // raw dialect word or the OpenAI translation — either means the output cap.
            let advice = match self.finish.as_deref() {
                Some("max_tokens") | Some("length") => {
                    "; the model spent its entire output budget reasoning and stopped at the limit \
                     before answering a word — raise this provider's max output tokens, or turn \
                     thinking off for it"
                }
                _ => "; the model stopped before answering",
            };
            let field = self.reasoning_field.as_deref().unwrap_or("reasoning");
            return Some(format!(
                "{head}; every delta was model reasoning ({field}) and no text was sent, so the \
                 selector is not at fault{advice}; first delta: {quoted}"
            ));
        }
        Some(format!("{head}; first: {quoted}"))
    }
}

/// One model as the catalogue reported it — the port of `ModelEntry`
/// (`manifest-interpreter.ts:65-68`).
///
/// Moved here from `interpreter.rs` because it is a seam type: both `AdapterInstance`
/// implementors (declarative and sandbox) return it, and `sandbox.rs` parses it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelEntry {
    pub native_id: String,
    pub raw: Value,
}

/// A ping's verdict — the port of `pingKey`'s return (`manifest-interpreter.ts:474`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PingResult {
    pub ok: bool,
    pub status: u16,
    pub rate_limited: bool,
    /// The provider's own words, when it refused. `None` on success, matching the source's
    /// `undefined`.
    pub message: Option<String>,
}

/// One provider's adapter.
///
/// **Neither method has a default body, and that is the point.** A default would let an implementor
/// ignore a new member silently, which forfeits the one guard a trait has: adding a method here is a
/// compile error at every implementor, forcing a decision about what that implementor *means* by the
/// new member. It is the same defence as the exhaustive struct literal in `core::usage` — a
/// field-shaped one for a struct, a method-shaped one for a trait. This is not hypothetical: adding
/// `generate_text` broke the image double in `engine.rs` at compile time and produced a written
/// answer to "what does an image-only adapter do when asked for text", rather than a runtime
/// surprise in whichever test happened to reach it first.
pub trait AdapterInstance: Send + Sync {
    /// Generate an image. See [`ImageReply`] for the refusal/throw split.
    fn generate_image<'a>(
        &'a self,
        secret_ref: &'a str,
        args: ImageArgs,
        cancel: &'a Cancel,
    ) -> BoxFuture<'a, Result<ImageReply, AttemptError>>;

    /// Generate text, as a stream of chunks.
    ///
    /// **Two phases, and the split is the whole design.** Awaiting the returned future is the
    /// *response* phase: a provider that refuses the request produces `Err` here, before a single
    /// byte reaches the caller. Polling the stream is the *mid-stream* phase: a stream that breaks
    /// after yielding produces `Err` as an **item**, because by then the consumer already holds text
    /// and cannot be handed a clean failure — re-running the attempt would show it the text twice.
    /// Those two are exactly `engine::FailureKind::Response` and `engine::FailureKind::MidStream`,
    /// and the engine's classification of a caught error turns on which one it saw. The TypeScript
    /// draws the same line by *where* the throw happens: `manifest-interpreter.ts:304` before the
    /// yield loop, `:360` inside it.
    ///
    /// **Pull, not push.** The engine drives this stream, so the engine decides when to stop asking
    /// for more — which is what makes cancellation a check the engine owns rather than a flag every
    /// adapter must remember to honour. The TypeScript is a pull generator for the same reason
    /// (`adapter-instance.ts:21`, `AsyncGenerator<string>`).
    ///
    /// The `'a` on `TextArgs` unifies with the others: an adapter may call `on_usage` as the stream
    /// ends (`manifest-interpreter.ts:430`), so the callbacks must outlive the returned stream.
    fn generate_text<'a>(
        &'a self,
        secret_ref: &'a str,
        args: TextArgs<'a>,
        cancel: &'a Cancel,
    ) -> BoxFuture<'a, Result<BoxStream<'a, Result<String, AttemptError>>, AttemptError>>;

    /// What the manifest says the provider can do — a declaration, not a measurement.
    fn capabilities(&self) -> Capabilities;

    /// Classify a model entry as text or image, using the provider's modality rules.
    fn tag_modality(&self, entry: &ModelEntry) -> &'static str;

    /// The models the provider's catalogue lists. A provider with no endpoint answers `[]`.
    fn list_models<'a>(
        &'a self,
        secret_ref: &'a str,
        cancel: &'a Cancel,
    ) -> BoxFuture<'a, Result<Vec<ModelEntry>, AttemptError>>;

    /// A cheap validity check — one catalogue call.
    fn ping_key<'a>(&'a self, secret_ref: &'a str, cancel: &'a Cancel)
        -> BoxFuture<'a, PingResult>;

    /// Optional teardown. The default is a no-op, because not every adapter holds resources
    /// (the declarative interpreter does not), and a trait that forces every implementor to write
    /// an empty body forfeits the same guard the comment above defends. `dispose` is the one
    /// exception: a missing teardown is safe, while a missing `generate_image` is not.
    fn dispose(&self) {}
}

/// Resolve a provider id to the adapter that serves it.
///
/// Async because the TypeScript's is — resolving may read a manifest, build a sandbox, or start a
/// subprocess. `Err` is a resolution failure, which the engine classifies as a transport failure:
/// the TypeScript's `forProvider` rejection lands in the same `catch` as a thrown `generateImage`.
///
/// **The TypeScript also returns a `baseUrl`, and the engine discards it** (`execution-engine.ts`
/// destructures only `{ adapter }`, at both call sites). So this returns only the adapter. Adding
/// the base URL here would put a field on the seam that no caller reads — the shape of the
/// `BridgeMsg::Usage` gap, where a value the sender holds is dropped one line later.
pub trait AdapterFactory: Send + Sync {
    fn for_provider<'a>(
        &'a self,
        provider_id: &'a str,
    ) -> BoxFuture<'a, Result<Arc<dyn AdapterInstance>, String>>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fresh_cancel_is_not_cancelled() {
        assert!(!Cancel::new().is_cancelled());
    }

    // ---------- StreamObservation ----------

    #[test]
    fn the_observation_counts_every_event_and_keeps_only_the_first() {
        let mut o = StreamObservation::default();
        o.note("{\"a\":1}");
        o.note("{\"b\":2}");
        o.note("{\"c\":3}");
        assert_eq!(o.events, 3);
        assert_eq!(
            o.first.as_deref(),
            Some("{\"a\":1}"),
            "the sample is the first event, not the last"
        );
    }

    #[test]
    fn the_sample_is_capped_at_240_bytes_without_cutting_mid_utf_8() {
        // 120 two-byte characters = 240 bytes exactly, then one more character overflows the cap —
        // and a byte-indexed slice at 240 would land mid-character and panic.
        let payload = "é".repeat(121);
        let mut o = StreamObservation::default();
        o.note(&payload);
        let first = o.first.expect("a sample was kept");
        assert!(first.len() <= 243, "capped (240 bytes + the 3-byte ellipsis): {}", first.len());
        assert!(first.ends_with('…'), "the truncation is named, not silent");
        // 120 whole characters survived the byte cap, never a torn one.
        assert_eq!(first.trim_end_matches('…').chars().count(), 120);
    }

    #[test]
    fn describe_names_each_state_the_ledger_needs_to_tell_apart() {
        // Nothing at all: the provider streamed no events — a provider-side finding.
        assert_eq!(
            StreamObservation::default().describe().as_deref(),
            Some("stream carried no SSE events at all")
        );
        // Events that matched nothing: a manifest-side finding, with the evidence to check it.
        let mut o = StreamObservation::default();
        o.note("{\"choices\":[]}");
        o.note("{\"choices\":[]}");
        let d = o.describe().expect("described");
        assert!(d.contains("2 SSE event"), "{d}");
        assert!(d.contains("none matched the manifest's delta selector"), "{d}");
        assert!(d.contains("{\"choices\":[]}"), "the sample is in the wording: {d}");
    }

    // ---------- the stream-shape mirrors (`stream-shape.test.ts`) ----------
    //
    // The envelopes below were captured from `agentrouter.org` (`deepseek-v4-flash`) on 2026-10-02
    // while diagnosing an "the agent is not replying" report, the same fixtures the TypeScript side
    // pins. The two engines must agree about a given wire shape: whichever one serves a request
    // writes its row, and two records of one request that contradict each other is the defect class
    // this classification exists to end.

    /// Every `data:` payload of one stream, through one observation.
    fn observed(payloads: &[serde_json::Value]) -> StreamObservation {
        let mut o = StreamObservation::default();
        for p in payloads {
            o.note(&p.to_string());
        }
        o
    }

    fn at(t: &str) -> serde_json::Value {
        serde_json::json!({
            "content_block": null, "delta": null, "error": null, "index": 0, "message": null,
            "type": t,
        })
    }

    fn thinking_delta(text: &str) -> serde_json::Value {
        serde_json::json!({
            "content_block": null, "delta": {"thinking": text, "type": "thinking_delta"},
            "error": null, "index": 0, "message": null, "type": "content_block_delta",
        })
    }

    #[test]
    fn a_reasoning_only_anthropic_stream_is_not_reported_as_a_manifest_defect() {
        let o = observed(&[
            at("message_start"),
            serde_json::json!({
                "content_block": {"signature": "", "thinking": "", "type": "thinking"},
                "delta": null, "error": null, "index": 0, "message": null, "type": "content_block_start",
            }),
            at("ping"),
            thinking_delta("Confirmed"),
            thinking_delta(" the plan"),
            serde_json::json!({
                "content_block": null, "delta": {"signature": "abc", "type": "signature_delta"},
                "error": null, "index": 0, "message": null, "type": "content_block_delta",
            }),
            at("content_block_stop"),
            serde_json::json!({
                "content_block": null, "delta": {"stop_reason": "max_tokens", "stop_sequence": null},
                "error": null, "index": 0, "message": null,
                "type": "message_delta",
                "usage": {"input_tokens": 2310, "output_tokens": 8192},
            }),
            at("message_stop"),
        ]);
        assert_eq!(
            o.reasoning, 3,
            "the announcement and the two thinking deltas; the signature delta is other"
        );
        assert_eq!(o.reasoning_carried, 2, "only the thinking deltas carried reasoning text");
        assert_eq!(o.text, 0);
        assert_eq!(
            o.first_delta.as_deref(),
            Some(thinking_delta("Confirmed").to_string().as_str())
        );
        assert_eq!(o.finish.as_deref(), Some("max_tokens"));

        let d = o.describe().expect("described");
        assert!(d.contains("every delta was model reasoning"), "{d}");
        assert!(d.contains("delta.thinking"), "{d}");
        assert!(d.contains("no text was sent"), "{d}");
        assert!(d.contains("the selector is not at fault"), "{d}");
        // `stop_reason: max_tokens` reaches the wording as the actionable half: what to change.
        assert!(d.contains("output budget"), "{d}");
        assert!(d.contains("max output tokens"), "{d}");
        // And the quoted sample is a delta, never `message_start` — the lifecycle opener every
        // Anthropic stream shares, which is what the old positional sample quoted.
        assert!(d.contains("thinking_delta"), "{d}");
        assert!(!d.contains("message_start"), "{d}");
    }

    #[test]
    fn without_a_finish_reason_the_finding_still_stands_with_weaker_advice() {
        let mut o =
            observed(&[at("message_start"), thinking_delta("a thought"), at("message_stop")]);
        // Strip the finish the message_delta carried, simulating a provider that never named one.
        o.finish = None;
        let d = o.describe().expect("described");
        assert!(d.contains("every delta was model reasoning"), "{d}");
        assert!(d.contains("stopped before answering"), "{d}");
        assert!(!d.contains("output budget"), "{d}");
    }

    #[test]
    fn an_openai_reasoning_content_stream_names_that_field_not_the_anthropic_one() {
        let o = observed(&[
            serde_json::json!({"choices": [{"delta": {"reasoning_content": "thinking..."}}]}),
            serde_json::json!({"choices": [{"delta": {"reasoning_content": "more"}}]}),
        ]);
        assert_eq!(o.reasoning, 2);
        assert_eq!(o.reasoning_carried, 2);
        assert_eq!(o.reasoning_field.as_deref(), Some("choices[0].delta.reasoning_content"));
        let d = o.describe().expect("described");
        assert!(d.contains("2 SSE event"), "{d}");
        assert!(d.contains("every delta was model reasoning"), "{d}");
        assert!(d.contains("choices[0].delta.reasoning_content"), "{d}");
    }

    #[test]
    fn a_thinking_announcement_counts_as_reasoning_but_carries_no_delta() {
        // The announcement makes the reasoning real before its deltas arrive, but it names no
        // stream field (the key is still null) and is not a carried delta — so a stream of only an
        // announcement is `PARSE_ERROR`, the same call the TypeScript makes from accumulated
        // *content*, which an announcement contributes none of.
        let o = observed(&[serde_json::json!({
            "content_block": {"signature": "", "thinking": "", "type": "thinking"},
            "delta": null, "error": null, "index": 0, "message": null, "type": "content_block_start",
        })]);
        assert_eq!(o.reasoning, 1);
        assert_eq!(o.reasoning_carried, 0);
        assert!(o.reasoning_field.is_none());
        assert!(o.first_delta.is_none());
    }

    #[test]
    fn text_is_recognised_from_either_dialect_s_field_and_ends_the_reasoning_arm() {
        let o = observed(&[
            thinking_delta("first, think"),
            serde_json::json!({
                "content_block": null, "delta": {"text": "then answer", "type": "text_delta"},
                "error": null, "index": 0, "message": null, "type": "content_block_delta",
            }),
            serde_json::json!({"choices": [{"delta": {"content": " openai"}}]}),
        ]);
        assert_eq!(o.text, 2);
        assert_eq!(o.reasoning, 1);
        // A stream that answered is not described as reasoning-only — the output itself is the
        // answer to "what did the provider send", which is why describe() is only asked on a
        // drained stream at all. The tally is what keeps the classification honest.
        let d = o.describe().expect("described");
        assert!(!d.contains("model reasoning"), "{d}");
    }

    #[test]
    fn lifecycle_events_are_counted_and_never_sampled_as_deltas() {
        let o = observed(&[
            at("message_start"),
            at("ping"),
            at("content_block_stop"),
            at("message_stop"),
        ]);
        assert_eq!(o.lifecycle, 4);
        assert_eq!(o.text, 0);
        assert_eq!(o.reasoning, 0);
        assert!(o.first_delta.is_none(), "no delta ever arrived");
        assert!(o.first.is_some(), "the first event is still the sample");
    }

    #[test]
    fn tool_call_framing_is_recognised_so_a_tool_turn_is_never_filed_empty() {
        let o = observed(&[
            serde_json::json!({
                "content_block": null, "delta": {"partial_json": "{\"pa", "type": "input_json_delta"},
                "error": null, "index": 1, "message": null, "type": "content_block_delta",
            }),
            serde_json::json!({"choices": [{"delta": {"tool_calls": [{"id": "c1"}]}}]}),
        ]);
        assert_eq!(o.tool, 2);
    }

    #[test]
    fn a_non_json_payload_is_other_evidence_not_a_second_failure() {
        let mut o = StreamObservation::default();
        o.note("<html>502</html>");
        assert_eq!(o.other, 1);
        let d = o.describe().expect("described");
        assert!(d.contains("<html>502</html>"), "{d}");
        assert!(!d.contains("model reasoning"), "{d}");
    }

    #[test]
    fn the_finish_reason_is_taken_from_wherever_the_dialect_puts_it() {
        // Anthropic nests it under `delta` on `message_delta`; OpenAI puts `finish_reason` on the
        // choice. Either one means the output cap, which is the only fact the advice needs.
        let anthropic = observed(&[serde_json::json!({
            "content_block": null, "delta": {"stop_reason": "max_tokens", "stop_sequence": null},
            "error": null, "index": 0, "message": null, "type": "message_delta",
        })]);
        assert_eq!(anthropic.finish.as_deref(), Some("max_tokens"));
        let openai = observed(&[serde_json::json!({
            "choices": [{"delta": {}, "finish_reason": "length"}],
        })]);
        assert_eq!(openai.finish.as_deref(), Some("length"));
    }

    #[test]
    fn cancelling_is_visible_through_every_clone() {
        // The whole point of the `Arc`: the engine holds one clone and the adapter another, and a
        // cancel raised on either must be seen by both. A `Clone` that copied the flag would pass
        // a single-clone test and fail here.
        let engine_side = Cancel::new();
        let adapter_side = engine_side.clone();
        assert!(!adapter_side.is_cancelled());

        engine_side.cancel();
        assert!(adapter_side.is_cancelled(), "a clone must observe the same flag");
    }

    #[test]
    fn cancelling_twice_is_the_same_as_cancelling_once() {
        let c = Cancel::new();
        c.cancel();
        c.cancel();
        assert!(c.is_cancelled());
    }

    // ---------- the text half ----------

    use std::sync::Mutex;

    use futures_util::StreamExt;

    use crate::core::engine::{classify_attempt_error, ErrorClass, FailureKind};

    /// An adapter whose text behaviour is scripted.
    ///
    /// **It fires the callbacks when the stream is exhausted, because it is handed `stream: true`.**
    /// The source does the same in its stream branch — both callbacks fire in the loop's `finally`
    /// (`manifest-interpreter.ts:424`, `:430`), after the last chunk — while the non-stream branch
    /// fires `on_usage` before returning (`:312-329`). The first draft of this double fired during
    /// the *future* and was therefore the non-stream branch's behaviour behind a `stream: true`
    /// field, which is worse than merely unfaithful: a consumer that read usage without draining
    /// would have gone green here and failed against every real adapter. `execute_text` is that
    /// consumer and it is the next thing to be written, so the double is strict about the *moment*
    /// and not only about the values. The order is the source's too — tool calls (`:424`) before
    /// usage (`:430`) — though nothing downstream depends on it.
    ///
    /// **What it deliberately does not model: the abort check.** The source guards both flushes with
    /// `!signal?.aborted`, so a cancelled stream reports neither. The engine stops on cancellation
    /// before it can read usage, so a double that stayed silent there would be asserting a branch no
    /// engine path reaches.
    ///
    /// The seam itself owes only the *ability* for a callback to outlive the returned stream, and
    /// that is enforced by the single `'a` in the signature: a test cannot check a lifetime, but the
    /// compiler cannot be talked out of one.
    struct TextDouble {
        /// `Some` makes the *response* phase fail, before any chunk is produced.
        refusal: Option<AttemptError>,
        chunks: Vec<Result<String, AttemptError>>,
        usage: Option<UsageTokens>,
        tool_call: Option<ToolCall>,
        /// Every model id the adapter was handed, in call order.
        seen: Mutex<Vec<String>>,
    }

    impl TextDouble {
        fn serving(chunks: &[&str]) -> Self {
            Self {
                refusal: None,
                chunks: chunks.iter().map(|c| Ok((*c).to_string())).collect(),
                usage: None,
                tool_call: None,
                seen: Mutex::new(Vec::new()),
            }
        }
    }

    impl AdapterInstance for TextDouble {
        fn generate_image<'a>(
            &'a self,
            _secret_ref: &'a str,
            _args: ImageArgs,
            _cancel: &'a Cancel,
        ) -> BoxFuture<'a, Result<ImageReply, AttemptError>> {
            // A text double. The image half has its own double in `engine.rs`.
            Box::pin(async { Err(AttemptError::Transport) })
        }

        fn generate_text<'a>(
            &'a self,
            _secret_ref: &'a str,
            mut args: TextArgs<'a>,
            _cancel: &'a Cancel,
        ) -> BoxFuture<'a, Result<BoxStream<'a, Result<String, AttemptError>>, AttemptError>>
        {
            Box::pin(async move {
                self.seen.lock().unwrap().push(args.model.clone());

                if let Some(e) = self.refusal.clone() {
                    return Err(e);
                }

                // The callbacks are *taken* here and *fired* at exhaustion, which is the source's
                // stream branch (`manifest-interpreter.ts:424`, `:430`). Firing them here instead
                // would make this the non-stream branch while `stream` says otherwise.
                let usage = self.usage;
                let tool_call = self.tool_call.clone();
                let mut on_usage = args.on_usage.take();
                let mut on_tool_call = args.on_tool_call.take();

                let mut inner = futures_util::stream::iter(self.chunks.clone());
                let mut flushed = false;
                let stream: BoxStream<'a, Result<String, AttemptError>> =
                    Box::pin(futures_util::stream::poll_fn(move |cx| {
                        match inner.poll_next_unpin(cx) {
                            std::task::Poll::Ready(Some(item)) => {
                                std::task::Poll::Ready(Some(item))
                            }
                            std::task::Poll::Ready(None) => {
                                if !flushed {
                                    flushed = true;
                                    if let (Some(cb), Some(tc)) =
                                        (on_tool_call.as_deref_mut(), tool_call.clone())
                                    {
                                        cb(tc);
                                    }
                                    if let (Some(cb), Some(u)) = (on_usage.as_deref_mut(), usage) {
                                        cb(u);
                                    }
                                }
                                std::task::Poll::Ready(None)
                            }
                            std::task::Poll::Pending => std::task::Poll::Pending,
                        }
                    }));
                Ok(stream)
            })
        }

        fn capabilities(&self) -> Capabilities {
            Capabilities { text: true, image: false }
        }

        fn tag_modality(&self, _entry: &ModelEntry) -> &'static str {
            "text"
        }

        fn list_models<'a>(
            &'a self,
            _secret_ref: &'a str,
            _cancel: &'a Cancel,
        ) -> BoxFuture<'a, Result<Vec<ModelEntry>, AttemptError>> {
            Box::pin(async { Ok(Vec::new()) })
        }

        fn ping_key<'a>(
            &'a self,
            _secret_ref: &'a str,
            _cancel: &'a Cancel,
        ) -> BoxFuture<'a, PingResult> {
            Box::pin(async {
                PingResult { ok: false, status: 0, rate_limited: false, message: None }
            })
        }
    }

    fn text_args<'a>(model: &str) -> TextArgs<'a> {
        TextArgs {
            model: model.to_string(),
            messages: &[],
            stream: true,
            max_tokens: None,
            temperature: None,
            tools: None,
            tool_choice: None,
            response_format: None,
            on_tool_call: None,
            on_usage: None,
            on_finish: None,
            on_reasoning: None,
            prompt_cache_enabled: false,
            observation: None,
        }
    }

    async fn drain(
        mut s: BoxStream<'_, Result<String, AttemptError>>,
    ) -> Vec<Result<String, AttemptError>> {
        let mut out = Vec::new();
        while let Some(item) = s.next().await {
            out.push(item);
        }
        out
    }

    #[tokio::test]
    async fn a_text_stream_yields_the_chunks_the_adapter_produced() {
        let adapter = TextDouble::serving(&["Hello", " world"]);
        let cancel = Cancel::new();

        let stream = adapter.generate_text("sk-ref", text_args("gpt-4o"), &cancel).await.unwrap();
        let items = drain(stream).await;

        assert_eq!(items, vec![Ok("Hello".to_string()), Ok(" world".to_string())]);
        assert_eq!(adapter.seen.lock().unwrap().as_slice(), ["gpt-4o".to_string()]);
    }

    #[tokio::test]
    async fn a_response_phase_refusal_is_an_error_and_not_an_empty_stream() {
        // The distinction the seam exists to keep: a refused request must not arrive looking like a
        // stream that simply produced nothing. The TypeScript throws before its yield loop (`:304`),
        // and a port that swallowed that into an empty stream would classify it as success.
        let adapter = TextDouble {
            refusal: Some(AttemptError::Http {
                status: 429,
                kind: FailureKind::Response,
                retry_after_ms: Some(30_000),
                body: None,
            }),
            ..TextDouble::serving(&[])
        };
        let cancel = Cancel::new();

        // **`unwrap_err()` is unavailable here, and the reason is the seam's own shape.** It
        // requires the *Ok* type to be `Debug`, and a `BoxStream` is not — so every consumer of
        // `generate_text`, `execute_text` included, must `match` rather than reach for the
        // ergonomic helper. The match is also the stronger assertion: it names the phase rather
        // than trusting that whatever came back was the error arm.
        let err = match adapter.generate_text("sk-ref", text_args("gpt-4o"), &cancel).await {
            Ok(_) => panic!("a refused request must not answer with a stream"),
            Err(e) => e,
        };

        assert_eq!(err.status_or_zero(), 429);
        assert_eq!(err.retry_after_ms(), Some(30_000));
        assert_eq!(classify_attempt_error(&err), ErrorClass::RateLimited);
    }

    #[tokio::test]
    async fn a_mid_stream_failure_arrives_as_an_item_not_as_a_future_error() {
        // Once a byte has reached the consumer the attempt cannot be re-run, so the break has to
        // travel as an *item*: the consumer already holds text and a clean `Err` from the future
        // would invite exactly the retry that duplicates it. `:360` is the only producer.
        let adapter = TextDouble {
            chunks: vec![
                Ok("partial".to_string()),
                Err(AttemptError::Http {
                    status: 200,
                    kind: FailureKind::MidStream,
                    retry_after_ms: None,
                    body: None,
                }),
            ],
            ..TextDouble::serving(&[])
        };
        let cancel = Cancel::new();

        let stream = adapter.generate_text("sk-ref", text_args("gpt-4o"), &cancel).await;
        assert!(stream.is_ok(), "the response phase succeeded; the break came later");

        let items = drain(stream.unwrap()).await;
        assert_eq!(items.len(), 2);
        assert_eq!(items[0], Ok("partial".to_string()));
        assert_eq!(classify_attempt_error(items[1].as_ref().unwrap_err()), ErrorClass::ParseError);
    }

    #[tokio::test]
    async fn the_two_phases_stay_separable_when_the_status_is_identical() {
        // Both carry 429. Only the phase separates them, and the engine's classification turns
        // entirely on that — `RateLimited` cools a key, `ParseError` does not. A seam that collapsed
        // the two kinds into one would make the distinction unrecoverable downstream.
        let response = AttemptError::Http {
            status: 429,
            kind: FailureKind::Response,
            retry_after_ms: None,
            body: None,
        };
        let mid_stream = AttemptError::Http {
            status: 429,
            kind: FailureKind::MidStream,
            retry_after_ms: None,
            body: None,
        };

        assert_eq!(classify_attempt_error(&response), ErrorClass::RateLimited);
        assert_eq!(classify_attempt_error(&mid_stream), ErrorClass::ParseError);
        assert_ne!(classify_attempt_error(&response), classify_attempt_error(&mid_stream));
    }

    #[tokio::test]
    async fn an_adapter_with_no_callbacks_reports_nothing_and_is_not_a_crash() {
        let adapter = TextDouble::serving(&["only"]);
        let cancel = Cancel::new();

        let stream = adapter.generate_text("sk-ref", text_args("m"), &cancel).await.unwrap();
        assert_eq!(drain(stream).await, vec![Ok("only".to_string())]);
    }

    #[tokio::test]
    async fn the_usage_callback_carries_an_absent_cache_block_as_absent() {
        // The end of the chain increment 8 started: the callback's payload is `UsageTokens`, so the
        // absence/zero distinction survives all the way to the engine rather than being flattened
        // by an intermediate shape.
        let adapter =
            TextDouble { usage: Some(UsageTokens::new(120, 34, None)), ..TextDouble::serving(&[]) };
        let cancel = Cancel::new();

        let mut seen: Option<UsageTokens> = None;
        let mut report = |u: UsageTokens| seen = Some(u);
        let mut args = text_args("m");
        args.on_usage = Some(&mut report);

        let stream = adapter.generate_text("sk-ref", args, &cancel).await.unwrap();
        // Drain before reading: the callback fires at exhaustion, so a test that read `seen` here
        // would be asserting the *future* delivered it — which this double is written not to do.
        assert!(drain(stream).await.is_empty());

        let seen = seen.expect("the adapter reported usage");
        assert_eq!(seen.counts(), (120, 34));
        assert_eq!(seen.cached_tokens, None, "an unreported cache block must not arrive as 0");
    }

    #[tokio::test]
    async fn a_tool_call_reaches_its_callback_with_its_arguments_intact() {
        // `arguments` is the provider's own JSON *string*; the seam must not parse it, because only
        // the caller knows the schema of its own tools (`ports.ts:47-48`).
        let call = ToolCall {
            id: Some("call_1".into()),
            name: Some("get_weather".into()),
            arguments: Some("{\"city\":\"Dhaka\"}".into()),
            raw: None,
        };
        let adapter = TextDouble { tool_call: Some(call.clone()), ..TextDouble::serving(&[]) };
        let cancel = Cancel::new();

        let mut seen: Option<ToolCall> = None;
        let mut report = |c: ToolCall| seen = Some(c);
        let mut args = text_args("m");
        args.on_tool_call = Some(&mut report);

        let stream = adapter.generate_text("sk-ref", args, &cancel).await.unwrap();
        assert!(drain(stream).await.is_empty());

        assert_eq!(seen, Some(call));
    }

    #[tokio::test]
    async fn the_callbacks_fire_when_the_stream_ends_and_not_when_the_future_resolves() {
        // The claim the double's doc comment makes, tested rather than left in prose. It is
        // load-bearing because it is the one ordering `execute_text` must respect: usage is not
        // readable until the stream has been drained. A double that fired during the future would
        // make that consumer green here and wrong against every real adapter.
        let adapter = TextDouble {
            usage: Some(UsageTokens::new(7, 9, Some(3))),
            tool_call: Some(ToolCall {
                id: Some("call_1".into()),
                name: Some("t".into()),
                arguments: Some("{}".into()),
                raw: None,
            }),
            ..TextDouble::serving(&["a", "b"])
        };
        let cancel = Cancel::new();

        let log: Mutex<Vec<&'static str>> = Mutex::new(Vec::new());
        let mut on_tool = |_: ToolCall| log.lock().unwrap().push("tool_call");
        let mut on_use = |_: UsageTokens| log.lock().unwrap().push("usage");
        let mut args = text_args("m");
        args.on_tool_call = Some(&mut on_tool);
        args.on_usage = Some(&mut on_use);

        let stream = adapter.generate_text("sk-ref", args, &cancel).await.unwrap();
        assert!(log.lock().unwrap().is_empty(), "the future must not have fired a callback");

        let items = drain(stream).await;
        assert_eq!(items.len(), 2, "the chunks are unaffected by when the callbacks fire");
        assert_eq!(
            log.lock().unwrap().as_slice(),
            ["tool_call", "usage"],
            "both fire exactly once, at exhaustion, in the source's order"
        );
    }
}
