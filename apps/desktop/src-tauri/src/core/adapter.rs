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
        let response =
            AttemptError::Http { status: 429, kind: FailureKind::Response, retry_after_ms: None };
        let mid_stream =
            AttemptError::Http { status: 429, kind: FailureKind::MidStream, retry_after_ms: None };

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
