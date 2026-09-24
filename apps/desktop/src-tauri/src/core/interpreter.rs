//! The I/O half of the generic adapter — `ManifestInterpreter`, the port of the class in
//! `manifest-interpreter.ts` (`:218-491`). Increment 15 landed everything it calls that is a pure
//! function of its arguments (`core::manifest`); this is the class.
//!
//! # This is the critical path, and that was measured
//!
//! `adapter-runtime.ts:52-58` branches on `manifest.kind`: `"code"` runs in the QuickJS sandbox,
//! everything else here. Against the installed database on 2026-09-24: **3 of 3 manifests are
//! declarative, 0 of 3 are code**, and both builtin templates are declarative. Tier 2 — the
//! sandbox — is reachable but human-gated (`Onboarding.tsx:240-242`). So this file serves every
//! installed provider, and the sandbox serves none.
//!
//! # The one thing this port had to get right, and it is not the request
//!
//! The source's `generateText` is an `async function*` whose streaming loop ends in a `finally`
//! (`:421-437`). That `finally` runs on **every** exit — the end of the lines, `[DONE]`, `stopWhen`,
//! `finish_reason`, a mid-stream throw, and a consumer's `return()` — and it is what reports the
//! reassembled tool calls and the final usage block. Drop it on any one path and a tool-calling turn
//! silently reports no calls, or the ledger records zero tokens and the spend cap never bites.
//!
//! Rust has no `finally`, and `Drop` cannot do the job: the callbacks are `&'a mut dyn FnMut` and
//! the consumer may drop the stream at any moment. So the flush is a method ([`TextStream::flush`],
//! idempotent) called at every exit the loop itself reaches, and **before** a mid-stream error is
//! handed over — because the source's `finally` runs before the throw reaches the consumer, so a
//! flush that happened after the error item would report usage the source had already reported.
//!
//! The one exit the loop does not reach is a consumer that abandons the stream without an error.
//! The source's generator `return()`s and flushes; here nothing runs. See the divergences below —
//! it is the only one of these that changes an observable value, and the engine never takes it.
//!
//! # Divergences, each stated rather than discovered later
//!
//! - **A consumer that abandons a live stream gets no flush.** `execute_text` drains to the end or
//!   breaks on an error item, and an error item is flushed before it is produced, so no engine path
//!   reaches this. A future consumer that stops early would see the source's tool calls and usage
//!   and not this one's.
//! - **A broken line stream loses its message.** [`HttpError`] carries the host's text; the engine's
//!   `AttemptError::Transport` has no field for it, so it is dropped here. Nothing downstream reads
//!   it — `classify_attempt_error` classifies on the type, and `AttemptOutcome` has no message — but
//!   the source's thrown `Error` does carry it into a log.
//! - **A mid-stream error's body is not built at all.** The source throws
//!   `ManifestHttpError(200, JSON.stringify(err), "mid-stream")`; the body reaches the same
//!   unread message, so building it would be work with no reader. The status and kind are exact.
//! - **`Number(index)` is narrowed to an integer.** The source keys its reassembly `Map` by a
//!   JavaScript number, which may be fractional or `NaN`. [`PendingCalls`] is `BTreeMap<i64, _>`,
//!   and `collect_tool_call_deltas` already took this decision in increment 15, so the interpreter
//!   matches it rather than inventing a second rule. Every `index` selector on disk selects a JSON
//!   integer.
//! - **A fractional or negative token count reads as "not reported".** The source's
//!   `typeof pt === "number"` admits both; [`UsageTokens`]'s fields are `u64`, so the narrowing is
//!   the shared type's, made once rather than here.
//! - **`errorMap` is walked in key order, not the manifest's order.** See
//!   [`crate::core::manifest_view::StreamSpec::error_map`].
//! - **`messages` is copied once more than the source copies it.** The source inserts the array into
//!   the template values by reference; [`render_template`] takes a `Map<String, Value>` and so
//!   needs owned values. The request body has to own the conversation in any case — it is what gets
//!   serialised — so this is one deep copy per attempt where the source does none. Stated because
//!   `TextArgs`'s borrow exists precisely to avoid copies of this payload, and a reader deserves to
//!   know the renderer imposes one.
//! - **A JSON parse failure's message is serde's, not `JSON.parse`'s.** It reaches the same
//!   classified failure; only the text differs.
//!
//! # What is deliberately absent
//!
//! - **`tagModality`.** It needs `modality.ts`, whose `modelIdPattern` is a regular expression and
//!   whose port would put `regex` into `aiproviderd`'s runtime graph. Recorded as
//!   `10-headless-service.md` §10 decision 5 and deferred; the text and image paths do not call it.
//! - **`dispose`.** `adapter-instance.ts` declares it for the sandbox, which owns a QuickJS runtime
//!   to tear down. A stateless interpreter has nothing to dispose of, and a no-op method would be a
//!   member that exists to satisfy a shape.
//! - **The `manifest` getter.** `manifest-interpreter.ts:221-223` exposes the manifest it was built
//!   from; nothing in the Rust port reads it yet, and a public accessor no caller reads is the shape
//!   `AdapterFactory`'s note refuses for `baseUrl`.

use std::collections::BTreeMap;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use futures_util::future::BoxFuture;
use futures_util::stream::BoxStream;
use futures_util::{Stream, StreamExt};
use serde_json::{Map, Value};

use crate::core::adapter::{
    AdapterInstance, Cancel, ImageArgs, ImageReply, ModelEntry, PingResult, TextArgs, ToolCall,
};
use crate::core::engine::{AttemptError, FailureKind};
use crate::core::http_port::{HttpError, HttpMethod, HttpPort, HttpRequest, HttpResponse};
use crate::core::jsonpath::{select_all, select_one, JsonPathError};
use crate::core::manifest::{
    auth_headers, collect_tool_call_deltas, emit_tool_calls, join_url, js_string_coerce,
    read_cached_tokens, render_headers, retry_after_from, truncate_utf16, ManifestHttpError,
    PendingCalls,
};
use crate::core::manifest_view::{
    Capabilities, Condition, ManifestView, StreamSpec, TextEndpoint, ToolCallStream,
};
use crate::core::modality;
use crate::core::template::{is_js_whitespace, render_template};
use crate::core::usage::UsageTokens;

/// The dialect whose servers omit usage on a stream unless they are asked for it.
///
/// A string rather than a flag on the manifest because that is what the source tests
/// (`manifest-interpreter.ts:292`) and what the manifests on disk carry. A provider that rejects
/// `stream_options` opts out with `stream.requestUsage: false`.
const OPENAI_CHAT_V1: &str = "openai-chat-v1";

/// How much of a ping failure's message survives — `message.slice(0, 300)`
/// (`manifest-interpreter.ts:482`). The error path's own limit is
/// [`crate::core::manifest::MESSAGE_BODY_LIMIT`]; the two differ because the source's two do.
pub const PING_MESSAGE_LIMIT: usize = 300;

/// What an adapter needs from its host — the port of `AdapterContext`
/// (`manifest-interpreter.ts:51-55`).
///
/// `Arc<dyn HttpPort>` because one host serves every adapter: the runtime builds one port and hands
/// it to each interpreter it constructs, which is the sharing the TypeScript gets by passing the
/// same object.
pub struct AdapterContext {
    pub http: Arc<dyn HttpPort>,
    /// Extra template values injected by the host — `appUrl` and its siblings. Read *after* the
    /// built-in values, so a host variable of the same name wins, which is the source's
    /// `...this.ctx.vars` ordering.
    pub vars: Map<String, Value>,
}

/// Why an interpreter call did not produce an answer — the port of the source's
/// `ManifestHttpError | unknown` as `pingKey` sees it.
///
/// **Two arms, and the split is the source's `instanceof`.** [`Self::Http`] carries everything a
/// `ManifestHttpError` carries — the body included, because `ping_key`'s message and
/// `generate_image`'s `error_body` both need the text and [`AttemptError`] has nowhere for it.
/// [`Self::Failed`] is everything else: a transport failure, a body that is not JSON, a selector
/// that does not parse. The source folds all of those into one branch by failing the `instanceof`
/// test, and so does this.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InterpreterError {
    Http(ManifestHttpError),
    Failed(String),
}

impl std::fmt::Display for InterpreterError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            InterpreterError::Http(e) => write!(f, "{e}"),
            InterpreterError::Failed(m) => write!(f, "{m}"),
        }
    }
}

/// The projection the engine sees: status, kind and wait for an HTTP answer; a transport failure
/// for everything else. Reuses [`From<&ManifestHttpError> for AttemptError`] rather than restating
/// which fields travel.
impl From<&InterpreterError> for AttemptError {
    fn from(e: &InterpreterError) -> Self {
        match e {
            InterpreterError::Http(http) => http.into(),
            InterpreterError::Failed(_) => AttemptError::Transport,
        }
    }
}

impl From<JsonPathError> for InterpreterError {
    fn from(e: JsonPathError) -> Self {
        InterpreterError::Failed(e.to_string())
    }
}

/// A manifest that cannot be read as a declarative adapter.
///
/// Wraps serde's error rather than restating it: the only way to fail here is for the stored JSON
/// not to have the shape [`ManifestView`] names, and serde's message says which field and why.
#[derive(Debug, thiserror::Error)]
pub enum ManifestShapeError {
    #[error("manifest body is not a readable declarative manifest: {0}")]
    Unreadable(#[from] serde_json::Error),
}

/// The generic adapter: executes any declarative manifest against an [`HttpPort`].
///
/// **Key-blind and stateless with respect to credentials.** Every method takes the `secret_ref`
/// explicitly, so two concurrent attempts against one provider with different keys can never cross
/// secrets (invariant 2). This type emits header *names* carrying the `{{secret}}` sentinel and
/// nothing else — it cannot hold a key, because nothing here can produce one.
pub struct ManifestInterpreter {
    view: ManifestView,
    ctx: AdapterContext,
    modality_rules: Option<modality::ModalityRules>,
}

impl ManifestInterpreter {
    /// Read a stored manifest into an interpreter.
    ///
    /// The clone is serde's: `from_value` consumes, and the caller keeps its `Value`. A manifest is
    /// a couple of kilobytes, and this happens once per adapter construction rather than per
    /// request.
    pub fn new(manifest: &Value, ctx: AdapterContext) -> Result<Self, ManifestShapeError> {
        let view = serde_json::from_value(manifest.clone())?;
        // Modality rules are not part of ManifestView because they are read-model-only: the
        // grammar validates them, but the interpreter's read model ignores unknown fields, and
        // `ModalityRules` is a separate shape with its own parsing.
        let modality_rules = modality::rules_from_manifest(manifest).ok().flatten();
        Ok(Self { view, ctx, modality_rules })
    }

    /// What the manifest says the provider can do — a declaration, not a measurement.
    pub fn capabilities(&self) -> crate::core::manifest_view::Capabilities {
        self.view.capabilities
    }

    /// The models the provider's catalogue lists — the port of `listModels` (`:233-262`).
    ///
    /// A provider with no `listModels` endpoint answers `[]` rather than failing: the source
    /// returns early (`:235`), and "this provider does not publish a catalogue" is a state a
    /// manifest may legitimately declare.
    pub async fn list_models(
        &self,
        secret_ref: &str,
        cancel: &Cancel,
    ) -> Result<Vec<ModelEntry>, InterpreterError> {
        let Some(ep) = self.view.endpoints.list_models.as_ref() else {
            return Ok(Vec::new());
        };

        let res = self
            .send(
                HttpRequest {
                    url: join_url(&self.view.provider.base_url, &ep.path),
                    method: HttpMethod::Get,
                    headers: auth_headers(&self.view.provider.auth.headers),
                    body: None,
                    secret_ref: Some(secret_ref.to_string()),
                    stream: false,
                },
                cancel,
            )
            .await?;

        if res.status >= 400 {
            return Err(InterpreterError::Http(ManifestHttpError::new(
                res.status,
                res.body,
                FailureKind::Response,
                retry_after_from(&res.headers),
            )));
        }

        let json = parse_body(&res.body)?;
        // `map.raw` is v1.1; a manifest written before the amendment simply has no raw objects.
        let raws = match &ep.map.raw {
            Some(selector) => select_all(&json, selector)?,
            None => Vec::new(),
        };
        let items = select_all(&json, &ep.map.models)?;

        let mut models = Vec::new();
        for (i, item) in items.iter().enumerate() {
            // `typeof item === "string" ? item : String(item?.id ?? "")`. A non-object item has no
            // `id`, so it coerces to the empty string and is skipped — which is what makes the
            // `continue` below the source's `if (!id) continue;`.
            let id = match item {
                Value::String(s) => s.clone(),
                other => js_string_coerce(other.get("id")),
            };
            if id.is_empty() {
                continue;
            }
            // Index-aligned, because both selectors walk the same collection. A misaligned raw list
            // falls back to the id item itself, preserving pre-amendment behaviour.
            let raw = if raws.len() == items.len() { raws[i].clone() } else { (*item).clone() };
            models.push(ModelEntry { native_id: id, raw });
        }
        Ok(models)
    }

    /// A cheap validity check — one catalogue call, per spec req. 8 (`:473-484`).
    ///
    /// **The status on success is `200` regardless of what the provider answered**, which is the
    /// source's own literal (`:478`): the call succeeded, and a ping is a yes-or-no question. The
    /// real status is [`Self::list_models`]'s business.
    pub async fn ping_key(&self, secret_ref: &str, cancel: &Cancel) -> PingResult {
        if self.view.endpoints.list_models.is_none() {
            return PingResult {
                ok: false,
                status: 0,
                rate_limited: false,
                message: Some("provider has no listModels endpoint".to_string()),
            };
        }

        match self.list_models(secret_ref, cancel).await {
            Ok(_) => PingResult { ok: true, status: 200, rate_limited: false, message: None },
            Err(e) => {
                // The source's `e instanceof ManifestHttpError ? e.status : 0` — an unreadable
                // answer has no status, and `0` is the crate's own sentinel for that
                // (`AttemptError::status_or_zero`).
                let status = match &e {
                    InterpreterError::Http(http) => http.status,
                    InterpreterError::Failed(_) => 0,
                };
                let message = match &e {
                    InterpreterError::Http(http) => format!("HTTP {}: {}", http.status, http.body),
                    InterpreterError::Failed(m) => m.clone(),
                };
                PingResult {
                    ok: false,
                    status,
                    rate_limited: status == 429,
                    message: Some(truncate_utf16(&message, PING_MESSAGE_LIMIT)),
                }
            }
        }
    }

    /// One request through the port, with a host failure folded into [`InterpreterError::Failed`].
    ///
    /// **`'a` on both arguments, because the port's own signature demands it.** A streaming
    /// response hands back a stream that is still reading from the port, so the response borrows
    /// the port *and* the cancel flag for as long as the caller holds it — the two cannot be
    /// independent. The caller unifies them to the shorter, which is what it wants anyway.
    async fn send<'a>(
        &'a self,
        req: HttpRequest,
        cancel: &'a Cancel,
    ) -> Result<HttpResponse<'a>, InterpreterError> {
        self.ctx
            .http
            .request(req, cancel)
            .await
            .map_err(|e| InterpreterError::Failed(e.to_string()))
    }

    /// The image path — the port of `generateImage` (`:440-471`).
    async fn run_image(
        &self,
        secret_ref: &str,
        args: ImageArgs,
        cancel: &Cancel,
    ) -> Result<ImageReply, AttemptError> {
        // `throw new Error("manifest has no generateImage endpoint")` — a non-`ManifestHttpError`,
        // so the engine classifies it as a transport failure, which `AttemptError::Transport` is.
        let Some(ep) = self.view.endpoints.generate_image.as_ref() else {
            return Err(AttemptError::Transport);
        };

        let body = render_template(&ep.request_template, &image_values(&args, &self.ctx.vars))
            .map_err(|_| AttemptError::Transport)?;

        let res = self
            .ctx
            .http
            .request(
                HttpRequest {
                    url: join_url(&self.view.provider.base_url, &ep.path),
                    method: HttpMethod::Post,
                    headers: json_headers(&self.view, &ep.headers, &self.ctx.vars),
                    body: Some(serialize(&body)),
                    secret_ref: Some(secret_ref.to_string()),
                    stream: false,
                },
                cancel,
            )
            .await
            .map_err(attempt_error_from)?;

        // **A `>= 400` is a refusal, not a failed call** — returned, not thrown, so the status
        // survives to the engine's classification. `adapter.rs`'s `ImageReply` note is about exactly
        // this line.
        if res.status >= 400 {
            return Ok(ImageReply {
                ok: false,
                status: res.status,
                base64: None,
                url: None,
                error_body: Some(res.body),
            });
        }

        let json = serde_json::from_str::<Value>(&res.body).map_err(|_| AttemptError::Transport)?;
        Ok(ImageReply {
            ok: true,
            status: res.status,
            base64: select_string(&json, ep.response_map.image_b64.as_deref())?,
            url: select_string(&json, ep.response_map.image_url.as_deref())?,
            error_body: None,
        })
    }

    /// The text path — the port of `generateText` (`:264-438`).
    ///
    /// The returned future is the **response phase**: a provider that refuses produces `Err` here,
    /// before a byte reaches the caller. Everything after is the stream.
    fn run_text<'a>(
        &'a self,
        secret_ref: &'a str,
        args: TextArgs<'a>,
        cancel: &'a Cancel,
    ) -> BoxFuture<'a, Result<BoxStream<'a, Result<String, AttemptError>>, AttemptError>> {
        Box::pin(async move {
            let TextArgs {
                model,
                messages,
                stream,
                max_tokens,
                temperature,
                tools,
                tool_choice,
                response_format,
                on_tool_call,
                on_usage,
            } = args;

            let Some(ep) = self.view.endpoints.generate_text.as_ref() else {
                return Err(AttemptError::Transport);
            };
            let spec = ep.stream.as_ref();
            // `args.stream && ep.stream` — the reference's own guard (`manifest-interpreter.ts:306`),
            // and it decides only how the *response* is **read**. It does not decide what is *asked
            // for*: `values.stream` below is the caller's flag, exactly as the reference's `stream:
            // args.stream` (`:273`) is, so a manifest that declares no `stream` block still sends
            // `"stream": true` upstream, and a server that honours it answers with SSE — which
            // `unary_text` then parses as JSON, fails, and reports as `AttemptError::Transport`,
            // which the engine classifies as `NETWORK`. Measured 2026-09-24; this is the third route
            // to the misleading 502 of D45 and D46, and the second with no allowlist involved. Latent
            // on the installed database — all **3** manifest rows declare the block — so it fires for
            // a hand-written or imported manifest. Recorded as **D47**.
            let streaming = stream && spec.is_some();
            let wants_usage = wants_usage(&self.view, ep);

            let mut values = Map::new();
            values.insert("model".to_string(), Value::String(model));
            values.insert("messages".to_string(), Value::Array(messages.to_vec()));
            values.insert("stream".to_string(), Value::Bool(stream));
            // `args.maxTokens ?? this.m.limits?.maxOutputTokens` — nullish, so a caller-supplied
            // zero survives and only an absent value falls through to the manifest's ceiling.
            if let Some(limit) =
                max_tokens.or_else(|| self.view.limits.and_then(|l| l.max_output_tokens))
            {
                values.insert("maxTokens".to_string(), Value::from(limit));
            }
            if let Some(t) = temperature {
                values.insert("temperature".to_string(), Value::from(t));
            }
            if let Some(v) = tools {
                values.insert("tools".to_string(), v.clone());
            }
            if let Some(v) = tool_choice {
                values.insert("toolChoice".to_string(), v.clone());
            }
            if let Some(v) = response_format {
                values.insert("responseFormat".to_string(), v.clone());
            }
            for (k, v) in &self.ctx.vars {
                values.insert(k.clone(), v.clone());
            }

            let mut body = render_template(&ep.request_template, &values)
                .map_err(|_| AttemptError::Transport)?;

            // **`args.stream`, not `streaming`.** The source tests the caller's request, so a
            // manifest with no stream block still gets the field when the caller asked to stream.
            // Faithful rather than tidy: the two differ only for a manifest the grammar would have
            // rejected anyway, and a port that "fixed" it would be changing a request body.
            if stream && wants_usage {
                body.insert(
                    "stream_options".to_string(),
                    serde_json::json!({ "include_usage": true }),
                );
            }

            let res = self
                .ctx
                .http
                .request(
                    HttpRequest {
                        url: join_url(&self.view.provider.base_url, &ep.path),
                        method: HttpMethod::Post,
                        headers: json_headers(&self.view, &ep.headers, &self.ctx.vars),
                        body: Some(serialize(&body)),
                        secret_ref: Some(secret_ref.to_string()),
                        stream: streaming,
                    },
                    cancel,
                )
                .await
                .map_err(attempt_error_from)?;

            if res.status >= 400 {
                let err = ManifestHttpError::new(
                    res.status,
                    res.body,
                    FailureKind::Response,
                    retry_after_from(&res.headers),
                );
                return Err((&err).into());
            }

            if !streaming {
                return unary_text(ep, &res.body, on_tool_call, on_usage);
            }
            let Some(spec) = spec else {
                // Unreachable: `streaming` implies a spec. Written as a match rather than an
                // `expect` so a future change to that implication fails as a transport error
                // instead of a panic in a request path.
                return Err(AttemptError::Transport);
            };
            let Some(lines) = res.lines else {
                return Err(AttemptError::Transport);
            };

            Ok(Box::pin(TextStream {
                lines,
                plan: StreamPlan::new(spec, ep, on_tool_call.is_some(), wants_usage),
                cancel,
                on_tool_call,
                on_usage,
                pending: PendingCalls::new(),
                last_usage: None,
                end_after_emit: false,
                finished: false,
                flushed: false,
            }))
        })
    }
}

impl AdapterInstance for ManifestInterpreter {
    fn generate_image<'a>(
        &'a self,
        secret_ref: &'a str,
        args: ImageArgs,
        cancel: &'a Cancel,
    ) -> BoxFuture<'a, Result<ImageReply, AttemptError>> {
        // `Box::pin` of the `async fn`'s own future — no wrapper `async` block, which would add a
        // layer of state machine to await one call.
        Box::pin(self.run_image(secret_ref, args, cancel))
    }

    fn generate_text<'a>(
        &'a self,
        secret_ref: &'a str,
        args: TextArgs<'a>,
        cancel: &'a Cancel,
    ) -> BoxFuture<'a, Result<BoxStream<'a, Result<String, AttemptError>>, AttemptError>> {
        self.run_text(secret_ref, args, cancel)
    }

    fn capabilities(&self) -> Capabilities {
        self.capabilities()
    }

    fn tag_modality(&self, entry: &ModelEntry) -> &'static str {
        let input = modality::ModalityInput { native_id: &entry.native_id, raw: Some(&entry.raw) };
        // A stored manifest has already passed the grammar, so an error here is the unreachable
        // third variant (`ModalityError::Unreadable`) and "text" is the safe fallback.
        modality::tag_modality(self.modality_rules.as_ref(), &input)
            .map(|m| m.as_str())
            .unwrap_or("text")
    }

    fn list_models<'a>(
        &'a self,
        secret_ref: &'a str,
        cancel: &'a Cancel,
    ) -> BoxFuture<'a, Result<Vec<ModelEntry>, AttemptError>> {
        Box::pin(async move { self.list_models(secret_ref, cancel).await.map_err(|e| (&e).into()) })
    }

    fn ping_key<'a>(
        &'a self,
        secret_ref: &'a str,
        cancel: &'a Cancel,
    ) -> BoxFuture<'a, PingResult> {
        Box::pin(self.ping_key(secret_ref, cancel))
    }
}

/* --------------------------------------------------------------- text: values */

/// `provider.auth.headers`, `content-type`, then the endpoint's own static headers — in that order,
/// so an endpoint may override `content-type` and the source's spread does too.
fn json_headers(
    view: &ManifestView,
    endpoint: &BTreeMap<String, String>,
    vars: &Map<String, Value>,
) -> BTreeMap<String, String> {
    let mut headers = auth_headers(&view.provider.auth.headers);
    headers.insert("content-type".to_string(), "application/json".to_string());
    for (k, v) in render_headers(endpoint, vars) {
        headers.insert(k, v);
    }
    headers
}

/// The template values for an image call — `{ model, prompt, size, ...vars }`.
fn image_values(args: &ImageArgs, vars: &Map<String, Value>) -> Map<String, Value> {
    let mut values = Map::new();
    values.insert("model".to_string(), Value::String(args.model.clone()));
    values.insert("prompt".to_string(), Value::String(args.prompt.clone()));
    // Absent `size` leaves the key out, which is what `size: undefined` does: `{{size?}}` omits the
    // field and `{{size}}` fails. An empty string is a *value* and is inserted, as in the source.
    if let Some(size) = &args.size {
        values.insert("size".to_string(), Value::String(size.clone()));
    }
    for (k, v) in vars {
        values.insert(k.clone(), v.clone());
    }
    values
}

/// `JSON.stringify(body)` for a rendered template. Infallible for a `Map` of JSON values — the only
/// failure `serde_json` can report is a non-string map key, which `Map<String, Value>` cannot have.
fn serialize(body: &Map<String, Value>) -> String {
    serde_json::to_string(body).unwrap_or_else(|_| "{}".to_string())
}

fn parse_body(body: &str) -> Result<Value, InterpreterError> {
    serde_json::from_str(body).map_err(|e| InterpreterError::Failed(e.to_string()))
}

/// `ep.responseMap.imageB64 ? selectOne(json, …) : undefined`, kept as a string.
///
/// A selector that resolves to a non-string is *absent*, not coerced: the source's
/// `typeof b64 === "string" ? b64 : undefined` (`:468`).
fn select_string(json: &Value, path: Option<&str>) -> Result<Option<String>, AttemptError> {
    let Some(path) = path else { return Ok(None) };
    Ok(select_one(json, path)
        .map_err(|_| AttemptError::Transport)?
        .and_then(Value::as_str)
        .map(str::to_string))
}

/// Whether this call must ask the provider for a usage block on the stream.
///
/// `ep.stream?.requestUsage ?? (dialect === "openai-chat-v1" && Boolean(responseMap.usage))` — a
/// **nullish** default, so `requestUsage: false` wins over the dialect rule and only an absent flag
/// falls through. That is the point: providers already stored were generated before the flag
/// existed, and a manifest that rejects the field can opt out.
fn wants_usage(view: &ManifestView, ep: &TextEndpoint) -> bool {
    match ep.stream.as_ref().and_then(|s| s.request_usage) {
        Some(flag) => flag,
        None => view.dialect == OPENAI_CHAT_V1 && ep.response_map.usage.is_some(),
    }
}

/* ------------------------------------------------------------- text: unary */

/// The non-stream response, as a one-chunk stream.
///
/// **The callbacks fire when the consumer asks for the next item, not while the future resolves.**
/// The source's non-stream branch is a generator too: it `yield`s the text and only then calls
/// `emitToolCalls` and `onUsage` (`:309-329`), so both run on the *second* `next()` — the same
/// moment the streaming branch's flush runs, which is why one shape serves both. A consumer that
/// read usage without draining would go green against a future that fired early and fail against
/// every real adapter.
///
/// **No abort guard here, and that is the source's asymmetry.** The streaming branch's `finally`
/// checks `!signal?.aborted` before reporting; this branch has no such check (`:310-329`). Faithful
/// rather than uniform.
struct UnaryTextStream<'a> {
    chunk: Option<String>,
    /// `Some` when the manifest declares a non-stream `toolCalls` path — the selection, or `Null`
    /// when it resolved to nothing. `emit_tool_calls` treats `Null` as an empty list, which is what
    /// the source's `[undefined]` amounts to.
    tool_calls: Option<Value>,
    usage: Option<UsageTokens>,
    on_tool_call: Option<&'a mut (dyn FnMut(ToolCall) + Send)>,
    on_usage: Option<&'a mut (dyn FnMut(UsageTokens) + Send)>,
    done: bool,
}

impl Stream for UnaryTextStream<'_> {
    type Item = Result<String, AttemptError>;

    fn poll_next(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();
        if let Some(text) = this.chunk.take() {
            return Poll::Ready(Some(Ok(text)));
        }
        if this.done {
            return Poll::Ready(None);
        }
        this.done = true;

        // Tool calls before usage — the source's order (`:310` then `:312`). Nothing downstream
        // depends on it; the double in `adapter.rs` states the same order for the same reason.
        if let Some(raw) = this.tool_calls.as_ref() {
            if let Some(cb) = this.on_tool_call.as_deref_mut() {
                let sink: &mut dyn FnMut(ToolCall) = cb;
                emit_tool_calls(sink, raw);
            }
        }
        if let (Some(usage), Some(cb)) = (this.usage, this.on_usage.as_deref_mut()) {
            cb(usage);
        }
        Poll::Ready(None)
    }
}

/// **The interpreter's one mapping from a port failure to an attempt failure.**
///
/// A refusal by the egress policy is not a transport failure. Nothing left this process, so the
/// provider is not the party to blame and its key is not evidence — and reporting it as `NETWORK` is
/// what made D46's divergence arrive as a 502 naming the upstream, measured 2026-09-24 at **56 of
/// 56** requests with the upstream's own counter unmoved.
///
/// The reason travels with the error so the class can be `EGRESS_DENIED` *and* the specific host
/// stay recoverable: `engine::attempt_outcome` logs it where the attempt is recorded, which is the
/// last point at which it is still in hand.
///
/// **Every other port failure stays `Transport`.** Widening this to "any failure the egress raised"
/// would make a missing secret or a malformed URL look like our policy too, which is the same
/// misattribution pointing the other way.
fn attempt_error_from(e: HttpError) -> AttemptError {
    if e.is_denied() {
        AttemptError::Blocked { reason: e.message }
    } else {
        AttemptError::Transport
    }
}

/// Read a unary text response and hand back the one-chunk stream.
fn unary_text<'a>(
    ep: &TextEndpoint,
    body: &str,
    on_tool_call: Option<&'a mut (dyn FnMut(ToolCall) + Send)>,
    on_usage: Option<&'a mut (dyn FnMut(UsageTokens) + Send)>,
) -> Result<BoxStream<'a, Result<String, AttemptError>>, AttemptError> {
    let json: Value = serde_json::from_str(body).map_err(|_| AttemptError::Transport)?;

    // `if (typeof text === "string") yield text;` — a miss yields nothing, and an empty string *is*
    // yielded, because the guard is on the type and not on truthiness.
    let chunk = select_one(&json, &ep.response_map.text)
        .map_err(|_| AttemptError::Transport)?
        .and_then(Value::as_str)
        .map(str::to_string);

    // The selector runs whenever the manifest declares the path, even with no callback — it is an
    // argument, so it is evaluated before `emitToolCalls` can return early.
    let tool_calls = match &ep.response_map.tool_calls {
        Some(path) => Some(
            select_one(&json, path)
                .map_err(|_| AttemptError::Transport)?
                .cloned()
                .unwrap_or(Value::Null),
        ),
        None => None,
    };

    // The usage path is guarded by the callback *first*, which short-circuits the selector — the
    // source's `if (args.onUsage && ep.responseMap.usage)`.
    let usage = match (&ep.response_map.usage, on_usage.is_some()) {
        (Some(path), true) => match select_one(&json, path).map_err(|_| AttemptError::Transport)? {
            Some(Value::Object(map)) => read_usage(map),
            _ => None,
        },
        _ => None,
    };

    Ok(Box::pin(UnaryTextStream { chunk, tool_calls, usage, on_tool_call, on_usage, done: false }))
}

/// A usage block, or `None` when it carried nothing readable.
///
/// The three-part guard is the source's (`:321`): a provider that reports **only** cache fields
/// still has something to record, and dropping the whole callback for want of `prompt_tokens` would
/// lose the one number migration 0015 exists to capture.
fn read_usage(map: &Map<String, Value>) -> Option<UsageTokens> {
    let prompt = map.get("prompt_tokens").and_then(Value::as_u64);
    let completion = map.get("completion_tokens").and_then(Value::as_u64);
    let cached = read_cached_tokens(map);
    if prompt.is_none() && completion.is_none() && cached.is_none() {
        return None;
    }
    Some(UsageTokens::new(prompt.unwrap_or(0), completion.unwrap_or(0), cached))
}

/* ------------------------------------------------------------ text: stream */

/// The resolved per-request config for the SSE loop.
///
/// Resolved once rather than read off the manifest per chunk: the source re-reads
/// `ep.stream.chunkMap.delta` on every line, which re-parses the selector every time. The values
/// are identical either way; only the work differs.
struct StreamPlan {
    delta: String,
    chunk_tool_calls: Option<String>,
    tool_call_stream: Option<ToolCallStream>,
    /// The `errorMap` keys. The declared values are never read — see
    /// [`crate::core::manifest_view::StreamSpec::error_map`].
    error_paths: Vec<String>,
    stop_when: Option<Condition>,
    finish: Option<String>,
    usage_path: Option<String>,
    want_tool_calls: bool,
    wants_usage: bool,
}

impl StreamPlan {
    fn new(spec: &StreamSpec, ep: &TextEndpoint, has_tool_sink: bool, wants_usage: bool) -> Self {
        Self {
            delta: spec.chunk_map.delta.clone(),
            chunk_tool_calls: spec.chunk_map.tool_calls.clone(),
            tool_call_stream: spec.tool_call_stream.clone(),
            error_paths: spec.error_map.keys().cloned().collect(),
            stop_when: spec.stop_when.clone(),
            finish: spec.finish.clone(),
            usage_path: ep.response_map.usage.clone(),
            // `Boolean(args.onToolCall && (chunkMap.toolCalls || tcs))` — no sink, no work.
            want_tool_calls: has_tool_sink
                && (spec.chunk_map.tool_calls.is_some() || spec.tool_call_stream.is_some()),
            wants_usage,
        }
    }
}

/// The last-seen usage block, field by field.
///
/// A `Partial` in the source's sense (`:339`): a later chunk that omits a field must not erase what
/// an earlier one reported — Anthropic puts usage on `message_delta`, not on every chunk.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct PartialUsage {
    prompt_tokens: Option<u64>,
    completion_tokens: Option<u64>,
    cached_tokens: Option<u64>,
}

/// What one line did.
enum LineStep {
    /// Hand this text over; `end` says whether the stream finishes after it.
    ///
    /// The two are separate because the source's `yield` suspends: a chunk that also matches
    /// `stopWhen` is delivered *and then* ends the stream, on the consumer's next poll.
    Chunk {
        text: String,
        end: bool,
    },
    Continue,
    End,
    /// The stream broke. The source's body text has no reader on this side — see the module note.
    Fail,
}

/// The SSE loop, as a stream.
struct TextStream<'a> {
    lines: BoxStream<'a, Result<String, HttpError>>,
    plan: StreamPlan,
    cancel: &'a Cancel,
    on_tool_call: Option<&'a mut (dyn FnMut(ToolCall) + Send)>,
    on_usage: Option<&'a mut (dyn FnMut(UsageTokens) + Send)>,
    pending: PendingCalls,
    last_usage: Option<PartialUsage>,
    end_after_emit: bool,
    finished: bool,
    flushed: bool,
}

impl TextStream<'_> {
    /// Report the reassembled tool calls and the final usage — the source's `finally` (`:421-437`).
    ///
    /// **Idempotent, and guarded by cancellation.** `flushed` is what makes it safe to call from
    /// every exit; `cancel.is_cancelled()` is the source's `!signal?.aborted`, which is what makes
    /// an abandoned stream report nothing rather than report half a tool call.
    ///
    /// **It also ends the stream, and that is not decoration.** `flush` sets `finished`, so every
    /// caller terminates — which is why the `Fail` arm and the transport-break arm hand over their
    /// `Err` *item* and then answer `None` rather than continuing to read lines. The source gets the
    /// same result from `throw` unwinding its generator. Two of the call sites therefore carry two
    /// properties each: the report-before-the-failure ordering, and the termination. Measured while
    /// falsifying the `Fail` arm's flush — removing it left the ordering test red *and* pushed
    /// `a_mid_stream_error_arrives_as_an_item_with_the_sources_status_and_kind`'s item count from 2
    /// to 3, an unnamed dependency that test now has a sibling for.
    fn flush(&mut self) {
        if self.flushed {
            return;
        }
        self.flushed = true;
        self.finished = true;
        if self.cancel.is_cancelled() {
            return;
        }

        if let Some(cb) = self.on_tool_call.as_deref_mut() {
            // Index order, not arrival order — `PendingCalls` is a `BTreeMap`; see `manifest.rs`.
            for call in self.pending.values() {
                cb(ToolCall {
                    id: call.id.clone(),
                    name: call.name.clone(),
                    arguments: Some(call.args.clone()),
                    // The flush carries no `raw`: the source builds a fresh object here (`:426`).
                    raw: None,
                });
            }
        }
        if let Some(usage) = self.last_usage {
            if let Some(cb) = self.on_usage.as_deref_mut() {
                cb(UsageTokens::new(
                    usage.prompt_tokens.unwrap_or(0),
                    usage.completion_tokens.unwrap_or(0),
                    usage.cached_tokens,
                ));
            }
        }
    }

    /// Process one line. Mirrors the source's loop body (`:345-419`) in its exact order.
    fn handle_line(&mut self, line: &str) -> LineStep {
        // `:346` — checked before anything else, so a cancelled stream stops without parsing.
        if self.cancel.is_cancelled() {
            return LineStep::End;
        }

        // `line.trim()` — JavaScript's `\s`, not Rust's `is_whitespace`; see `template.rs`.
        let trimmed = line.trim_matches(is_js_whitespace);
        let Some(after_prefix) = trimmed.strip_prefix("data:") else {
            return LineStep::Continue;
        };
        let payload = after_prefix.trim_matches(is_js_whitespace);
        if payload == "[DONE]" {
            return LineStep::End;
        }
        let Ok(json) = serde_json::from_str::<Value>(payload) else {
            return LineStep::Continue;
        };

        // ---- errorMap: keys only, and the test is JavaScript truthiness, not presence.
        for path in &self.plan.error_paths {
            match select_one(&json, path) {
                Err(_) => return LineStep::Fail,
                // `if (err)` — a selected `0`, `""`, `false` or `null` is not an error.
                Ok(Some(err)) if js_truthy(err) => return LineStep::Fail,
                _ => {}
            }
        }

        // ---- tool calls, reassembled across chunks.
        if self.plan.want_tool_calls {
            if let Some(tcs) = self.plan.tool_call_stream.as_ref() {
                match absorb_multi_event(tcs, &json, &mut self.pending) {
                    Ok(()) => {}
                    Err(_) => return LineStep::Fail,
                }
            } else if let Some(path) = self.plan.chunk_tool_calls.as_ref() {
                match select_one(&json, path) {
                    Ok(raw) => {
                        collect_tool_call_deltas(&mut self.pending, raw.unwrap_or(&Value::Null))
                    }
                    Err(_) => return LineStep::Fail,
                }
            }
        }

        // ---- the text delta.
        let delta = match select_one(&json, &self.plan.delta) {
            Ok(found) => found
                .and_then(Value::as_str)
                // `&& delta` — truthiness again, so an empty delta is not yielded.
                .filter(|s| !s.is_empty())
                .map(str::to_string),
            Err(_) => return LineStep::Fail,
        };

        // ---- usage, whenever any chunk carries it.
        if let Some(path) = self.plan.usage_path.as_ref() {
            let selected = match select_one(&json, path) {
                Ok(v) => v,
                Err(_) => return LineStep::Fail,
            };
            if let Some(Value::Object(map)) = selected {
                let prompt = map.get("prompt_tokens").and_then(Value::as_u64);
                let completion = map.get("completion_tokens").and_then(Value::as_u64);
                let cached = read_cached_tokens(map);
                if prompt.is_some() || completion.is_some() || cached.is_some() {
                    let previous = self.last_usage.unwrap_or_default();
                    self.last_usage = Some(PartialUsage {
                        prompt_tokens: prompt.or(previous.prompt_tokens),
                        completion_tokens: completion.or(previous.completion_tokens),
                        cached_tokens: cached.or(previous.cached_tokens),
                    });
                }
            }
        }

        // ---- stopWhen, then finish. The order is the source's, and it decides which rule wins
        // when a chunk satisfies both.
        let stop = match self.plan.stop_when.as_ref() {
            Some(condition) => match condition_matches(&json, condition) {
                Ok(matched) => matched,
                Err(_) => return LineStep::Fail,
            },
            None => false,
        };

        let finish = match self.plan.finish.as_ref() {
            Some(path) => match select_one(&json, path) {
                Ok(found) => found.and_then(Value::as_str).map(str::to_string),
                Err(_) => return LineStep::Fail,
            },
            None => None,
        };
        // `typeof finish === "string" && finish !== "null"` — a provider that literally sends the
        // text `null` has not finished.
        let finished = finish.as_deref().is_some_and(|f| f != "null");
        // **`wantsUsage` keeps the loop alive past `finish_reason`.** OpenAI-shaped servers put
        // usage on a chunk *after* the one carrying `finish_reason`; returning there is how every
        // streamed request came to report zero tokens and the spend cap stayed at 0 forever.
        let end = stop || (finished && !self.plan.wants_usage);

        match delta {
            Some(text) => LineStep::Chunk { text, end },
            None if end => LineStep::End,
            None => LineStep::Continue,
        }
    }
}

impl Stream for TextStream<'_> {
    type Item = Result<String, AttemptError>;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();
        if this.finished {
            return Poll::Ready(None);
        }
        // A chunk that also ended the stream is delivered first — the source's `yield` suspends
        // before the `return` that follows it.
        if this.end_after_emit {
            this.end_after_emit = false;
            this.flush();
            return Poll::Ready(None);
        }

        loop {
            match this.lines.poll_next_unpin(cx) {
                Poll::Pending => return Poll::Pending,
                // The stream ended on its own. The source's `for await` falls out of the loop and
                // the `finally` runs.
                Poll::Ready(None) => {
                    this.flush();
                    return Poll::Ready(None);
                }
                // A transport break in the line stream. The source throws from inside the
                // generator, so the flush runs *before* the consumer sees the failure — which is
                // why the flush is here and not after the item is produced.
                Poll::Ready(Some(Err(_))) => {
                    this.flush();
                    return Poll::Ready(Some(Err(AttemptError::Transport)));
                }
                Poll::Ready(Some(Ok(line))) => match this.handle_line(&line) {
                    LineStep::Chunk { text, end } => {
                        this.end_after_emit = end;
                        return Poll::Ready(Some(Ok(text)));
                    }
                    LineStep::Continue => continue,
                    LineStep::End => {
                        this.flush();
                        return Poll::Ready(None);
                    }
                    LineStep::Fail => {
                        this.flush();
                        // `new ManifestHttpError(200, …, "mid-stream")` — the *request* succeeded
                        // and the *stream* broke, so the status is 200 and the kind is what the
                        // engine classifies on.
                        return Poll::Ready(Some(Err(AttemptError::Http {
                            status: 200,
                            kind: FailureKind::MidStream,
                            retry_after_ms: None,
                        })));
                    }
                },
            }
        }
    }
}

/// `selectOne(json, condition.path) === condition.equals`.
///
/// Strict equality, which structural comparison preserves: a number never equals a string, and an
/// absent selector is `undefined` — never equal to a `null` that is explicitly *there*, because
/// `select_one` tells those apart.
fn condition_matches(json: &Value, condition: &Condition) -> Result<bool, JsonPathError> {
    Ok(select_one(json, &condition.path)? == Some(&condition.equals))
}

/// JavaScript truthiness, for the `if (err)` test on an `errorMap` hit.
fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        // `NaN` and `0` are falsy; JSON has no `NaN`, so zero is the only numeric case.
        Value::Number(n) => n.as_f64().map(|f| f != 0.0).unwrap_or(false),
        Value::String(s) => !s.is_empty(),
        // An empty array and an empty object are both **truthy** in JavaScript.
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// The bucket a tool call's fragments accumulate in.
///
/// `Number(selectOne(json, path) ?? 0)`. The source's `Map` key is a JavaScript number; this is an
/// `i64`, and `manifest.rs`'s `collect_tool_call_deltas` made the same narrowing — see the module
/// note. A selector that yields a numeric *string* would be `Number("2") === 2` there and `0` here.
fn index_of(path: &Option<String>, json: &Value) -> Result<i64, JsonPathError> {
    let Some(path) = path else {
        return Ok(0);
    };
    Ok(select_one(json, path)?.and_then(Value::as_i64).unwrap_or(0))
}

/// Absorb a start or delta event from a multi-event tool-call stream.
///
/// Anthropic's framing: `content_block_start` declares the call, then one `content_block_delta` per
/// argument fragment. The `else if` is the source's — a chunk is one or the other, never both.
fn absorb_multi_event(
    tcs: &ToolCallStream,
    json: &Value,
    pending: &mut PendingCalls,
) -> Result<(), JsonPathError> {
    if condition_matches(json, &tcs.start.when)? {
        let index = index_of(&tcs.start.index, json)?;
        // `typeof id === "string" && id` — an empty string must not overwrite a real id, and a
        // number must not be coerced into one.
        let id = match tcs.start.id.as_ref() {
            Some(path) => select_one(json, path)?
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string),
            None => None,
        };
        let name = match tcs.start.name.as_ref() {
            Some(path) => select_one(json, path)?
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string),
            None => None,
        };
        let entry = pending.entry(index).or_default();
        if let Some(id) = id {
            entry.id = Some(id);
        }
        if let Some(name) = name {
            entry.name = Some(name);
        }
    } else if condition_matches(json, &tcs.delta.when)? {
        let index = index_of(&tcs.delta.index, json)?;
        let fragment = select_one(json, &tcs.delta.partial)?.and_then(Value::as_str);
        let entry = pending.entry(index).or_default();
        // `if (typeof partial === "string") cur.args += partial;` — appends, never replaces.
        if let Some(fragment) = fragment {
            entry.args.push_str(fragment);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::Mutex;

    use serde_json::json;

    use super::*;

    /* ------------------------------------------------------------- the double */

    /// One scripted answer.
    struct Scripted {
        status: u16,
        headers: BTreeMap<String, String>,
        body: String,
        lines: Option<Vec<Result<String, HttpError>>>,
    }

    impl Scripted {
        /// A unary answer.
        fn text(status: u16, body: &str) -> Self {
            Self { status, headers: BTreeMap::new(), body: body.to_string(), lines: None }
        }

        fn text_with(status: u16, body: &str, headers: &[(&str, &str)]) -> Self {
            Self {
                status,
                headers: headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
                body: body.to_string(),
                lines: None,
            }
        }

        /// A streaming answer that succeeded: lines, no body.
        fn sse(lines: &[&str]) -> Self {
            Self {
                status: 200,
                headers: BTreeMap::new(),
                body: String::new(),
                lines: Some(lines.iter().map(|l| Ok((*l).to_string())).collect()),
            }
        }

        /// A streaming answer that broke partway.
        fn sse_then_break(lines: &[&str], message: &str) -> Self {
            let mut scripted: Vec<Result<String, HttpError>> =
                lines.iter().map(|l| Ok((*l).to_string())).collect();
            scripted.push(Err(HttpError::new(message)));
            Self {
                status: 200,
                headers: BTreeMap::new(),
                body: String::new(),
                lines: Some(scripted),
            }
        }

        /// A **streaming request** the provider refused: status and body, no lines — the case the
        /// `http_port` contract exists for.
        fn stream_refused(status: u16, body: &str, headers: &[(&str, &str)]) -> Self {
            Self {
                status,
                headers: headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
                body: body.to_string(),
                lines: None,
            }
        }
    }

    struct FakeHttp {
        script: Mutex<VecDeque<Scripted>>,
        seen: Mutex<Vec<HttpRequest>>,
    }

    impl FakeHttp {
        fn new(script: Vec<Scripted>) -> Arc<Self> {
            Arc::new(Self { script: Mutex::new(script.into()), seen: Mutex::new(Vec::new()) })
        }

        fn requests(&self) -> Vec<HttpRequest> {
            self.seen.lock().unwrap().clone()
        }

        fn only_request(&self) -> HttpRequest {
            let seen = self.requests();
            assert_eq!(seen.len(), 1, "expected exactly one request");
            seen.into_iter().next().unwrap()
        }
    }

    impl HttpPort for FakeHttp {
        fn request<'a>(
            &'a self,
            req: HttpRequest,
            _cancel: &'a Cancel,
        ) -> BoxFuture<'a, Result<HttpResponse<'a>, HttpError>> {
            Box::pin(async move {
                self.seen.lock().unwrap().push(req);
                let next = self.script.lock().unwrap().pop_front().expect("the script ran out");
                Ok(HttpResponse {
                    status: next.status,
                    headers: next.headers,
                    body: next.body,
                    lines: next.lines.map(lines_of),
                })
            })
        }
    }

    fn lines_of(
        items: Vec<Result<String, HttpError>>,
    ) -> BoxStream<'static, Result<String, HttpError>> {
        Box::pin(futures_util::stream::iter(items))
    }

    /* ------------------------------------------------------------ the fixtures */

    /// The `openai-compat` shape, trimmed to what these tests read.
    fn openai_manifest() -> Value {
        json!({
            "manifestVersion": 1,
            "kind": "declarative",
            "dialect": "openai-chat-v1",
            "provider": {
                "baseUrl": "https://api.test/v1",
                "auth": { "headers": [{ "name": "Authorization", "prefix": "Bearer" }] }
            },
            "endpoints": {
                "listModels": {
                    "method": "GET", "path": "/models",
                    "map": { "models": "$.data[*].id", "raw": "$.data[*]" }
                },
                "generateText": {
                    "method": "POST", "path": "/chat/completions",
                    "requestTemplate": {
                        "model": "{{model}}",
                        "messages": "{{messages}}",
                        "stream": "{{stream}}",
                        "max_tokens": "{{maxTokens?}}"
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
                    "method": "POST", "path": "/images",
                    "requestTemplate": {
                        "model": "{{model}}", "prompt": "{{prompt}}", "size": "{{size?}}"
                    },
                    "responseMap": { "imageB64": "$.data[0].b64_json", "imageUrl": "$.data[0].url" }
                }
            },
            "capabilities": { "text": true, "image": true }
        })
    }

    /// The `anthropic-compat` shape: `x-api-key`, a required `maxTokens`, `stopWhen`, and the
    /// multi-event tool-call framing.
    fn anthropic_manifest() -> Value {
        json!({
            "manifestVersion": 1,
            "kind": "declarative",
            "dialect": "anthropic-messages-v1",
            "provider": {
                "baseUrl": "https://api.test",
                "auth": { "headers": [{ "name": "x-api-key" }] }
            },
            "endpoints": {
                "generateText": {
                    "method": "POST", "path": "/messages",
                    "requestTemplate": {
                        "model": "{{model}}",
                        "messages": "{{messages}}",
                        "stream": "{{stream}}",
                        "max_tokens": "{{maxTokens}}"
                    },
                    "responseMap": { "text": "$.content[0].text", "usage": "$.usage" },
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
            "limits": { "maxOutputTokens": 8192 }
        })
    }

    fn interpreter(manifest: &Value, http: Arc<FakeHttp>) -> ManifestInterpreter {
        ManifestInterpreter::new(manifest, AdapterContext { http, vars: Map::new() })
            .expect("the fixture reads as a manifest")
    }

    fn text_args(model: &str) -> TextArgs<'_> {
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

    /// A `data:` line carrying one OpenAI-shaped delta.
    fn delta_line(text: &str) -> String {
        format!("data: {{\"choices\":[{{\"delta\":{{\"content\":\"{text}\"}}}}]}}")
    }

    /* --------------------------------------------------------------- requests */

    #[tokio::test]
    async fn the_url_the_auth_header_and_the_secret_ref_reach_the_port() {
        let http = FakeHttp::new(vec![Scripted::text(
            200,
            r#"{"choices":[{"message":{"content":"hi"}}]}"#,
        )]);
        let interp = interpreter(&openai_manifest(), http.clone());

        let mut args = text_args("gpt-4o");
        args.stream = false;
        let out = drain(interp.generate_text("key:k1", args, &Cancel::new()).await.unwrap()).await;
        assert_eq!(out, vec![Ok("hi".to_string())]);

        let req = http.only_request();
        assert_eq!(req.url, "https://api.test/v1/chat/completions");
        assert_eq!(req.method, HttpMethod::Post);
        // **The sentinel, never a secret.** The interpreter cannot see a key; the egress replaces
        // this on the way out (invariant 2).
        assert_eq!(req.headers["Authorization"], "Bearer {{secret}}");
        assert_eq!(req.headers["content-type"], "application/json");
        assert_eq!(req.secret_ref.as_deref(), Some("key:k1"));
        assert!(!req.stream, "a unary call must not ask the port to stream");
    }

    /// The rendered body carries the caller's model, the conversation, and `stream: false` — and
    /// omits `max_tokens` entirely, because the manifest spelled it `{{maxTokens?}}` and the caller
    /// supplied none. The §2.6 frozen rule, seen end to end.
    #[tokio::test]
    async fn an_optional_template_field_the_caller_omitted_is_absent_from_the_body() {
        let http = FakeHttp::new(vec![Scripted::text(
            200,
            r#"{"choices":[{"message":{"content":"x"}}]}"#,
        )]);
        let interp = interpreter(&openai_manifest(), http.clone());

        let messages = vec![json!({ "role": "user", "content": "hey" })];
        let mut args = text_args("gpt-4o");
        args.stream = false;
        args.messages = &messages;
        let _ = drain(interp.generate_text("key:k1", args, &Cancel::new()).await.unwrap()).await;

        let body: Value =
            serde_json::from_str(http.only_request().body.as_deref().unwrap()).expect("valid json");
        assert_eq!(body["model"], json!("gpt-4o"));
        assert_eq!(body["stream"], json!(false));
        assert_eq!(body["messages"], json!([{ "role": "user", "content": "hey" }]));
        assert!(body.get("max_tokens").is_none(), "{{maxTokens?}} with no value omits the field");
    }

    /// **The dialect default, and the reason it exists.** An `openai-chat-v1` manifest with no
    /// `requestUsage` flag still asks for usage, because providers already stored were generated
    /// before the flag existed — and without the field every streamed request reports zero tokens,
    /// which silently zeroes cost and defeats the spend cap.
    ///
    /// The fixture carries `requestUsage: true`, which satisfies the *first* branch of the nullish
    /// chain and would leave this rule unexercised — measured: with the dialect default deleted the
    /// test still passed. So the key is removed here, and the removal is asserted, because a fixture
    /// that quietly stopped carrying the flag would otherwise turn this into a test of nothing.
    #[tokio::test]
    async fn a_streamed_openai_request_asks_for_usage_by_dialect_default() {
        let mut manifest = openai_manifest();
        let stream = manifest["endpoints"]["generateText"]["stream"].as_object_mut().unwrap();
        assert!(
            stream.remove("requestUsage").is_some(),
            "the fixture must have carried the flag for removing it to reach the dialect branch"
        );
        let http = FakeHttp::new(vec![Scripted::sse(&["data: [DONE]"])]);
        let interp = interpreter(&manifest, http.clone());

        let _ =
            drain(interp.generate_text("key:k1", text_args("m"), &Cancel::new()).await.unwrap())
                .await;

        let req = http.only_request();
        assert!(req.stream);
        let body: Value = serde_json::from_str(req.body.as_deref().unwrap()).unwrap();
        assert_eq!(body["stream_options"], json!({ "include_usage": true }));
    }

    /// The dialect rule is a conjunction, and the other conjunct needs pinning too: `openai-chat-v1`
    /// asks for usage only when the manifest has a `usage` selector to read it from. Without one the
    /// field would ask a provider for a block the response map could not find anyway.
    #[tokio::test]
    async fn the_dialect_default_needs_a_usage_selector_to_apply() {
        let mut manifest = openai_manifest();
        let endpoint = manifest["endpoints"]["generateText"].as_object_mut().unwrap();
        endpoint["stream"].as_object_mut().unwrap().remove("requestUsage");
        endpoint["responseMap"].as_object_mut().unwrap().remove("usage");
        let http = FakeHttp::new(vec![Scripted::sse(&["data: [DONE]"])]);
        let interp = interpreter(&manifest, http.clone());

        let _ =
            drain(interp.generate_text("key:k1", text_args("m"), &Cancel::new()).await.unwrap())
                .await;

        let body: Value =
            serde_json::from_str(http.only_request().body.as_deref().unwrap()).unwrap();
        assert!(
            body.get("stream_options").is_none(),
            "no usage selector, so there is nothing for the field to populate"
        );
    }

    /// `requestUsage: false` is the opt-out, and `??` is nullish — so an explicit `false` beats the
    /// dialect rule while an *absent* flag does not.
    #[tokio::test]
    async fn request_usage_false_opts_out_of_the_field() {
        let mut manifest = openai_manifest();
        manifest["endpoints"]["generateText"]["stream"]["requestUsage"] = json!(false);
        let http = FakeHttp::new(vec![Scripted::sse(&["data: [DONE]"])]);
        let interp = interpreter(&manifest, http.clone());

        let _ =
            drain(interp.generate_text("key:k1", text_args("m"), &Cancel::new()).await.unwrap())
                .await;

        let body: Value =
            serde_json::from_str(http.only_request().body.as_deref().unwrap()).unwrap();
        assert!(body.get("stream_options").is_none(), "the flag turned it off");
    }

    /// A manifest that declares no stream block answers a `stream: true` request with a unary
    /// response — the source's `!args.stream || !ep.stream` branch.
    #[tokio::test]
    async fn a_stream_request_against_a_manifest_with_no_stream_block_is_answered_unary() {
        let mut manifest = openai_manifest();
        manifest["endpoints"]["generateText"].as_object_mut().unwrap().remove("stream");
        let http = FakeHttp::new(vec![Scripted::text(
            200,
            r#"{"choices":[{"message":{"content":"whole"}}]}"#,
        )]);
        let interp = interpreter(&manifest, http.clone());

        let out =
            drain(interp.generate_text("key:k1", text_args("m"), &Cancel::new()).await.unwrap())
                .await;

        assert_eq!(out, vec![Ok("whole".to_string())]);
        assert!(!http.only_request().stream, "no stream block, so no line stream");
    }

    /// The required spelling fails the call rather than sending `null`: Anthropic's `{{maxTokens}}`
    /// with neither a caller value nor a manifest ceiling.
    #[tokio::test]
    async fn a_required_placeholder_with_no_value_fails_the_call_before_it_is_sent() {
        let mut manifest = anthropic_manifest();
        manifest.as_object_mut().unwrap().remove("limits");
        let http = FakeHttp::new(vec![]);
        let interp = interpreter(&manifest, http.clone());

        let err = match interp.generate_text("key:k1", text_args("m"), &Cancel::new()).await {
            Ok(_) => panic!("a missing required field must not produce a stream"),
            Err(e) => e,
        };
        assert_eq!(err, AttemptError::Transport);
        assert!(http.requests().is_empty(), "nothing may reach the network");
    }

    /* ------------------------------------------------------------ list_models */

    #[tokio::test]
    async fn list_models_maps_items_and_index_aligns_the_raw_objects() {
        let http = FakeHttp::new(vec![Scripted::text(
            200,
            r#"{"data":[{"id":"a","owned_by":"x"},{"id":"b","owned_by":"y"}]}"#,
        )]);
        let interp = interpreter(&openai_manifest(), http.clone());

        let models = interp.list_models("key:k1", &Cancel::new()).await.unwrap();

        assert_eq!(models.len(), 2);
        assert_eq!(models[0].native_id, "a");
        assert_eq!(models[0].raw["owned_by"], json!("x"), "the raw object is the aligned one");
        assert_eq!(models[1].native_id, "b");
        assert_eq!(models[1].raw["owned_by"], json!("y"));

        let req = http.only_request();
        assert_eq!(req.url, "https://api.test/v1/models");
        assert_eq!(req.method, HttpMethod::Get);
        assert!(req.body.is_none());
    }

    /// **A misaligned `raw` list falls back to the id item**, which is the pre-amendment behaviour
    /// the source preserves (`:258`). A manifest whose two selectors walk different collections must
    /// not produce a wrong raw object silently paired with an id.
    #[tokio::test]
    async fn a_misaligned_raw_list_falls_back_to_the_id_item() {
        let mut manifest = openai_manifest();
        // Three ids, one raw — the lengths differ, so no alignment is possible.
        manifest["endpoints"]["listModels"]["map"]["raw"] = json!("$.other[*]");
        let http = FakeHttp::new(vec![Scripted::text(
            200,
            r#"{"data":[{"id":"a"},{"id":"b"},{"id":"c"}],"other":[{"z":1}]}"#,
        )]);
        let interp = interpreter(&manifest, http.clone());

        let models = interp.list_models("key:k1", &Cancel::new()).await.unwrap();

        assert_eq!(models.len(), 3);
        assert_eq!(models[0].raw, json!("a"), "the id item stands in when the lists disagree");
    }

    #[tokio::test]
    async fn an_entry_with_no_usable_id_is_skipped() {
        let http = FakeHttp::new(vec![Scripted::text(
            200,
            r#"{"data":[{"id":"keep"},{"id":""},{"name":"no-id"}]}"#,
        )]);
        let interp = interpreter(&openai_manifest(), http.clone());

        let models = interp.list_models("key:k1", &Cancel::new()).await.unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].native_id, "keep");
    }

    #[tokio::test]
    async fn a_provider_with_no_catalogue_answers_empty_rather_than_failing() {
        let mut manifest = openai_manifest();
        manifest["endpoints"].as_object_mut().unwrap().remove("listModels");
        let http = FakeHttp::new(vec![]);
        let interp = interpreter(&manifest, http.clone());

        assert!(interp.list_models("key:k1", &Cancel::new()).await.unwrap().is_empty());
        assert!(http.requests().is_empty(), "no endpoint means no request at all");
    }

    #[tokio::test]
    async fn a_catalogue_refusal_carries_the_status_the_body_and_the_wait() {
        let http =
            FakeHttp::new(vec![Scripted::text_with(429, "slow down", &[("retry-after", "30")])]);
        let interp = interpreter(&openai_manifest(), http.clone());

        let err = interp.list_models("key:k1", &Cancel::new()).await.unwrap_err();

        match err {
            InterpreterError::Http(e) => {
                assert_eq!(e.status, 429);
                assert_eq!(e.body, "slow down");
                assert_eq!(e.kind, FailureKind::Response);
                assert_eq!(e.retry_after_ms, Some(30_000), "the header reached the error");
            }
            other => panic!("expected an HTTP error, got {other}"),
        }
    }

    /* ---------------------------------------------------------------- ping_key */

    #[tokio::test]
    async fn ping_key_reports_a_rate_limit_as_a_rate_limit() {
        let http = FakeHttp::new(vec![Scripted::text(429, "too many")]);
        let interp = interpreter(&openai_manifest(), http.clone());

        let ping = interp.ping_key("key:k1", &Cancel::new()).await;

        assert!(!ping.ok);
        assert_eq!(ping.status, 429);
        assert!(ping.rate_limited);
        assert_eq!(ping.message.as_deref(), Some("HTTP 429: too many"));
    }

    /// **The success status is the source's literal `200`, not the provider's answer.** A `201`
    /// catalogue is still a healthy key, and the ping is a yes-or-no question — which is why the
    /// assertion uses a status the provider did *not* send.
    #[tokio::test]
    async fn a_successful_ping_answers_200_whatever_the_provider_said() {
        let http = FakeHttp::new(vec![Scripted::text(201, r#"{"data":[]}"#)]);
        let interp = interpreter(&openai_manifest(), http.clone());

        let ping = interp.ping_key("key:k1", &Cancel::new()).await;

        assert!(ping.ok);
        assert_eq!(ping.status, 200, "the source hardcodes 200 on success (`:478`)");
        assert!(!ping.rate_limited);
        assert_eq!(ping.message, None);
    }

    /// An unreadable answer has no status, and the crate's sentinel for that is `0`.
    #[tokio::test]
    async fn a_ping_that_could_not_read_the_answer_has_no_status() {
        let http = FakeHttp::new(vec![Scripted::text(200, "not json at all")]);
        let interp = interpreter(&openai_manifest(), http.clone());

        let ping = interp.ping_key("key:k1", &Cancel::new()).await;

        assert!(!ping.ok);
        assert_eq!(ping.status, 0);
        assert!(!ping.rate_limited);
        assert!(ping.message.is_some());
    }

    #[tokio::test]
    async fn a_ping_against_a_provider_with_no_catalogue_says_so_without_a_request() {
        let mut manifest = openai_manifest();
        manifest["endpoints"].as_object_mut().unwrap().remove("listModels");
        let http = FakeHttp::new(vec![]);
        let interp = interpreter(&manifest, http.clone());

        let ping = interp.ping_key("key:k1", &Cancel::new()).await;

        assert_eq!(ping.status, 0);
        assert_eq!(ping.message.as_deref(), Some("provider has no listModels endpoint"));
        assert!(http.requests().is_empty());
    }

    /// The ping message is cut at 300 UTF-16 units, which is a different limit from the error
    /// message's 400 — the source's two, not one.
    #[tokio::test]
    async fn a_long_ping_message_is_truncated_at_the_pings_own_limit() {
        let body = "e".repeat(1_000);
        let http = FakeHttp::new(vec![Scripted::text(500, &body)]);
        let interp = interpreter(&openai_manifest(), http.clone());

        let ping = interp.ping_key("key:k1", &Cancel::new()).await;
        let message = ping.message.expect("a message");
        assert_eq!(message.encode_utf16().count(), PING_MESSAGE_LIMIT);
        assert_eq!(PING_MESSAGE_LIMIT, 300);
    }

    /* ----------------------------------------------------------- generate_image */

    #[tokio::test]
    async fn an_image_refusal_is_returned_with_its_status_not_raised() {
        let http = FakeHttp::new(vec![Scripted::text(400, "bad prompt")]);
        let interp = interpreter(&openai_manifest(), http.clone());

        let reply = interp
            .generate_image(
                "key:k1",
                ImageArgs { model: "dall-e-3".into(), prompt: "a cat".into(), size: None },
                &Cancel::new(),
            )
            .await
            .expect("a refusal is not a failed call");

        assert!(!reply.ok);
        assert_eq!(reply.status, 400);
        assert_eq!(reply.error_body.as_deref(), Some("bad prompt"));
        assert_eq!(reply.base64, None);
        assert_eq!(reply.url, None);
    }

    #[tokio::test]
    async fn an_image_answer_yields_whichever_form_the_provider_sent() {
        let http = FakeHttp::new(vec![Scripted::text(
            200,
            r#"{"data":[{"b64_json":"QUJD","url":"https://cdn.test/a.png"}]}"#,
        )]);
        let interp = interpreter(&openai_manifest(), http.clone());

        let reply = interp
            .generate_image(
                "key:k1",
                ImageArgs { model: "m".into(), prompt: "p".into(), size: Some("1024x1024".into()) },
                &Cancel::new(),
            )
            .await
            .unwrap();

        assert!(reply.ok);
        assert_eq!(reply.status, 200);
        assert_eq!(reply.base64.as_deref(), Some("QUJD"));
        assert_eq!(reply.url.as_deref(), Some("https://cdn.test/a.png"));
        assert_eq!(reply.error_body, None);

        let body: Value =
            serde_json::from_str(http.only_request().body.as_deref().unwrap()).unwrap();
        assert_eq!(body["size"], json!("1024x1024"));
    }

    /// `size` absent leaves the field out; `size: ""` is a value and is sent. The difference is the
    /// `{{size?}}` rule, and a test that only covered the absent case would not see it.
    #[tokio::test]
    async fn an_absent_image_size_is_omitted_while_an_empty_one_is_sent() {
        let http = FakeHttp::new(vec![
            Scripted::text(200, r#"{"data":[{"url":"u"}]}"#),
            Scripted::text(200, r#"{"data":[{"url":"u"}]}"#),
        ]);
        let interp = interpreter(&openai_manifest(), http.clone());

        for size in [None, Some(String::new())] {
            interp
                .generate_image(
                    "key:k1",
                    ImageArgs { model: "m".into(), prompt: "p".into(), size },
                    &Cancel::new(),
                )
                .await
                .unwrap();
        }

        let seen = http.requests();
        let absent: Value = serde_json::from_str(seen[0].body.as_deref().unwrap()).unwrap();
        let empty: Value = serde_json::from_str(seen[1].body.as_deref().unwrap()).unwrap();
        assert!(absent.get("size").is_none());
        assert_eq!(empty["size"], json!(""));
    }

    #[tokio::test]
    async fn an_image_call_to_a_manifest_with_no_image_endpoint_is_a_transport_failure() {
        let mut manifest = openai_manifest();
        manifest["endpoints"].as_object_mut().unwrap().remove("generateImage");
        let http = FakeHttp::new(vec![]);
        let interp = interpreter(&manifest, http.clone());

        let err = interp
            .generate_image(
                "key:k1",
                ImageArgs { model: "m".into(), prompt: "p".into(), size: None },
                &Cancel::new(),
            )
            .await
            .unwrap_err();

        assert_eq!(err, AttemptError::Transport);
        assert!(http.requests().is_empty());
    }

    /* ------------------------------------------------------- text: non-stream */

    /// **The callbacks fire when the stream is exhausted, not while the future resolves.** The
    /// source's non-stream branch is a generator too (`:309-329`), so `emitToolCalls` and `onUsage`
    /// run on the *second* `next()`. Asserted by sampling the callback log as each item arrives:
    /// the first item must find it empty, and the end of the stream must find it full. A double
    /// that fired during the future would pass a value-only test and fail this one.
    #[tokio::test]
    async fn the_unary_callbacks_fire_at_exhaustion_and_not_before() {
        let http = FakeHttp::new(vec![Scripted::text(
            200,
            r#"{"choices":[{"message":{"content":"done","tool_calls":[
                {"id":"call_1","type":"function","function":{"name":"lookup","arguments":"{\"a\":1}"}}
            ]}}],"usage":{"prompt_tokens":10,"completion_tokens":4}}"#,
        )]);
        let interp = interpreter(&openai_manifest(), http.clone());

        let log: Arc<Mutex<Vec<&'static str>>> = Arc::new(Mutex::new(Vec::new()));
        let tool_log = log.clone();
        let usage_log = log.clone();
        let mut on_tool = move |_c: ToolCall| tool_log.lock().unwrap().push("tool");
        let mut on_usage = move |_u: UsageTokens| usage_log.lock().unwrap().push("usage");

        let mut args = text_args("m");
        args.stream = false;
        args.on_tool_call = Some(&mut on_tool);
        args.on_usage = Some(&mut on_usage);

        // Bound rather than inlined: the returned stream borrows the `Cancel` for its whole life.
        let cancel = Cancel::new();
        let mut stream = interp.generate_text("key:k1", args, &cancel).await.unwrap();
        let mut observed = Vec::new();
        while let Some(item) = stream.next().await {
            observed.push((item, log.lock().unwrap().len()));
        }

        assert_eq!(observed.len(), 1);
        assert_eq!(observed[0].0, Ok("done".to_string()));
        assert_eq!(observed[0].1, 0, "nothing may have fired before the chunk was handed over");
        assert_eq!(
            log.lock().unwrap().as_slice(),
            ["tool", "usage"],
            "both fire once, at exhaustion, tool calls before usage"
        );
    }

    /// A selector that misses yields nothing, and the callbacks still fire — the source's
    /// `if (typeof text === "string") yield text;` followed by an unconditional flush.
    #[tokio::test]
    async fn a_unary_response_with_no_text_yields_nothing_and_still_reports_usage() {
        let http = FakeHttp::new(vec![Scripted::text(200, r#"{"usage":{"prompt_tokens":3}}"#)]);
        let interp = interpreter(&openai_manifest(), http.clone());

        let seen: Arc<Mutex<Option<UsageTokens>>> = Arc::new(Mutex::new(None));
        let sink = seen.clone();
        let mut on_usage = move |u: UsageTokens| *sink.lock().unwrap() = Some(u);

        let mut args = text_args("m");
        args.stream = false;
        args.on_usage = Some(&mut on_usage);

        let out = drain(interp.generate_text("key:k1", args, &Cancel::new()).await.unwrap()).await;

        assert!(out.is_empty());
        let usage = seen.lock().unwrap().expect("the usage block was reported");
        assert_eq!(usage.counts(), (3, 0));
        assert_eq!(usage.cached_tokens, None, "an unreported cache block stays absent");
    }

    /// A `200` whose body is not JSON is still a failure — the source's `JSON.parse` throwing
    /// inside the branch the engine classifies as a transport fault.
    #[tokio::test]
    async fn an_unreadable_unary_body_is_a_transport_failure() {
        let http = FakeHttp::new(vec![Scripted::text(200, "<html>nope</html>")]);
        let interp = interpreter(&openai_manifest(), http.clone());

        let mut args = text_args("m");
        args.stream = false;
        let err = match interp.generate_text("key:k1", args, &Cancel::new()).await {
            Ok(_) => panic!("an unreadable body must not produce a stream"),
            Err(e) => e,
        };
        assert_eq!(err, AttemptError::Transport);
    }

    /* ---------------------------------------------------------- text: stream */

    #[tokio::test]
    async fn streamed_chunks_arrive_in_order() {
        let http = FakeHttp::new(vec![Scripted::sse(&[
            &delta_line("Hello"),
            &delta_line(" world"),
            "data: [DONE]",
        ])]);
        let interp = interpreter(&openai_manifest(), http.clone());

        let out =
            drain(interp.generate_text("key:k1", text_args("m"), &Cancel::new()).await.unwrap())
                .await;

        assert_eq!(out, vec![Ok("Hello".to_string()), Ok(" world".to_string())]);
    }

    /// Lines that are not `data:`, a `data:` line that is not JSON, and a delta that is an empty
    /// string are all skipped — three separate rules, each of which would otherwise be an empty
    /// chunk on the wire.
    #[tokio::test]
    async fn non_data_lines_unreadable_payloads_and_empty_deltas_are_all_skipped() {
        let http = FakeHttp::new(vec![Scripted::sse(&[
            ": comment",
            "",
            "event: ping",
            "data: not json",
            "data: {\"choices\":[{\"delta\":{\"content\":\"\"}}]}",
            &delta_line("real"),
            "data: [DONE]",
        ])]);
        let interp = interpreter(&openai_manifest(), http.clone());

        let out =
            drain(interp.generate_text("key:k1", text_args("m"), &Cancel::new()).await.unwrap())
                .await;

        assert_eq!(out, vec![Ok("real".to_string())]);
    }

    /// The stream ends at `[DONE]`, and a line after it is never read.
    #[tokio::test]
    async fn done_ends_the_stream_and_nothing_after_it_is_read() {
        let http = FakeHttp::new(vec![Scripted::sse(&[
            &delta_line("before"),
            "data: [DONE]",
            &delta_line("after"),
        ])]);
        let interp = interpreter(&openai_manifest(), http.clone());

        let out =
            drain(interp.generate_text("key:k1", text_args("m"), &Cancel::new()).await.unwrap())
                .await;

        assert_eq!(out, vec![Ok("before".to_string())]);
    }

    /// `stopWhen` ends the stream on a named event — Anthropic's `message_stop`.
    #[tokio::test]
    async fn stop_when_ends_the_stream() {
        let http = FakeHttp::new(vec![Scripted::sse(&[
            r#"data: {"type":"content_block_delta","delta":{"text":"hi"}}"#,
            r#"data: {"type":"message_stop"}"#,
            r#"data: {"type":"content_block_delta","delta":{"text":"never"}}"#,
        ])]);
        let interp = interpreter(&anthropic_manifest(), http.clone());

        let out =
            drain(interp.generate_text("key:k1", text_args("m"), &Cancel::new()).await.unwrap())
                .await;

        assert_eq!(out, vec![Ok("hi".to_string())]);
    }

    /// **`finish_reason` ends the stream only when usage was not requested.** With
    /// `requestUsage: false` the loop stops there; the chunks after it are never read.
    #[tokio::test]
    async fn finish_reason_ends_the_stream_when_usage_was_not_requested() {
        let mut manifest = openai_manifest();
        manifest["endpoints"]["generateText"]["stream"]["requestUsage"] = json!(false);
        let http = FakeHttp::new(vec![Scripted::sse(&[
            &delta_line("done"),
            r#"data: {"choices":[{"delta":{},"finish_reason":"stop"}]}"#,
            &delta_line("never"),
        ])]);
        let interp = interpreter(&manifest, http.clone());

        let out =
            drain(interp.generate_text("key:k1", text_args("m"), &Cancel::new()).await.unwrap())
                .await;

        assert_eq!(out, vec![Ok("done".to_string())]);
    }

    /// **The defect the `wants_usage` keep-alive exists for.** When usage *was* requested, a
    /// `finish_reason` chunk must not end the loop: OpenAI-shaped servers put the usage block on a
    /// chunk *after* it, and returning there is how every streamed request came to report zero
    /// tokens and the spend cap stayed at 0 forever.
    #[tokio::test]
    async fn finish_reason_does_not_end_the_stream_when_usage_was_requested() {
        let http = FakeHttp::new(vec![Scripted::sse(&[
            &delta_line("done"),
            r#"data: {"choices":[{"delta":{},"finish_reason":"stop"}]}"#,
            r#"data: {"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":34}}"#,
            "data: [DONE]",
        ])]);
        let interp = interpreter(&openai_manifest(), http.clone());

        let seen: Arc<Mutex<Option<UsageTokens>>> = Arc::new(Mutex::new(None));
        let sink = seen.clone();
        let mut on_usage = move |u: UsageTokens| *sink.lock().unwrap() = Some(u);
        let mut args = text_args("m");
        args.on_usage = Some(&mut on_usage);

        let out = drain(interp.generate_text("key:k1", args, &Cancel::new()).await.unwrap()).await;

        assert_eq!(out, vec![Ok("done".to_string())], "the trailing chunks carry no delta");
        let usage = seen.lock().unwrap().expect("the trailing usage chunk was read");
        assert_eq!(usage.counts(), (120, 34));
    }

    /// `finish_reason` of the literal string `"null"` is not a finish — the source's
    /// `finish !== "null"` test, which exists because some servers send the text.
    #[tokio::test]
    async fn a_finish_reason_of_the_text_null_does_not_end_the_stream() {
        let mut manifest = openai_manifest();
        manifest["endpoints"]["generateText"]["stream"]["requestUsage"] = json!(false);
        let http = FakeHttp::new(vec![Scripted::sse(&[
            r#"data: {"choices":[{"delta":{},"finish_reason":"null"}]}"#,
            &delta_line("still here"),
            "data: [DONE]",
        ])]);
        let interp = interpreter(&manifest, http.clone());

        let out =
            drain(interp.generate_text("key:k1", text_args("m"), &Cancel::new()).await.unwrap())
                .await;

        assert_eq!(out, vec![Ok("still here".to_string())]);
    }

    /// A mid-stream error travels as an **item**, not as a failure of the future — the two-phase
    /// split the seam exists to keep. Once a byte has reached the consumer the attempt cannot be
    /// re-run, so a clean `Err` from the future would invite exactly the retry that duplicates text.
    #[tokio::test]
    async fn a_mid_stream_error_arrives_as_an_item_with_the_sources_status_and_kind() {
        let http = FakeHttp::new(vec![Scripted::sse(&[
            &delta_line("partial"),
            r#"data: {"error":{"message":"upstream exploded"}}"#,
            &delta_line("never"),
        ])]);
        let interp = interpreter(&openai_manifest(), http.clone());

        let cancel = Cancel::new();
        let stream = interp.generate_text("key:k1", text_args("m"), &cancel).await;
        assert!(stream.is_ok(), "the response phase succeeded; the break came later");

        let out = drain(stream.unwrap()).await;
        assert_eq!(out.len(), 2);
        assert_eq!(out[0], Ok("partial".to_string()));
        assert_eq!(
            out[1],
            Err(AttemptError::Http {
                status: 200,
                kind: FailureKind::MidStream,
                retry_after_ms: None,
            }),
            "the request succeeded and the stream broke, so the status is 200"
        );
    }

    /// **The mid-stream failure also ends the stream, and that half was untested.** The source's
    /// `throw` unwinds the generator, so the `finally` runs *and* nothing after the failing line is
    /// ever read; [`TextStream::flush`] sets `finished`, which is what reproduces it here. Measured
    /// while falsifying the flush at the `Fail` arm: without it this test's item count is 3, not 2 —
    /// the `Err` item is handed over and the loop then happily reads the next line.
    #[tokio::test]
    async fn a_mid_stream_error_ends_the_stream_so_a_later_line_is_never_read() {
        let http = FakeHttp::new(vec![Scripted::sse(&[
            &delta_line("partial"),
            r#"data: {"error":{"message":"upstream exploded"}}"#,
            &delta_line("never"),
        ])]);
        let interp = interpreter(&openai_manifest(), http.clone());

        let cancel = Cancel::new();
        let stream = interp.generate_text("key:k1", text_args("m"), &cancel).await.unwrap();
        let out = drain(stream).await;

        assert_eq!(out.len(), 2, "the text, then the error — the third line is never reached");
        assert_eq!(out[0], Ok("partial".to_string()));
        assert!(out[1].is_err());
    }

    /// **The flush runs before the error is handed over.** The source's `finally` runs when the
    /// throw leaves the loop, so the consumer sees the error only after the tool calls and usage
    /// have been reported. Sampling the log as each item arrives is what proves the order: the
    /// chunk must find the log empty, and the error must find it full.
    #[tokio::test]
    async fn a_mid_stream_error_flushes_before_it_is_handed_over() {
        let http = FakeHttp::new(vec![Scripted::sse(&[
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"lookup","arguments":"{}"}}]}}]}"#,
            r#"data: {"error":{"message":"broke"}}"#,
        ])]);
        let interp = interpreter(&openai_manifest(), http.clone());

        let log: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = log.clone();
        let mut on_tool = move |c: ToolCall| {
            sink.lock().unwrap().push(format!("{:?}/{:?}", c.id, c.name));
        };
        let mut args = text_args("m");
        args.on_tool_call = Some(&mut on_tool);

        // Bound rather than inlined: the returned stream borrows the `Cancel` for its whole life.
        let cancel = Cancel::new();
        let mut stream = interp.generate_text("key:k1", args, &cancel).await.unwrap();
        let mut observed = Vec::new();
        while let Some(item) = stream.next().await {
            observed.push((item.is_err(), log.lock().unwrap().len()));
        }

        assert_eq!(observed.len(), 1, "only the error item is produced");
        assert!(observed[0].0);
        assert_eq!(observed[0].1, 1, "the tool call was flushed before the error arrived");
        assert_eq!(log.lock().unwrap().as_slice(), ["Some(\"call_1\")/Some(\"lookup\")"]);
    }

    /// **A broken line stream flushes first and then fails**, for the same reason: the host's
    /// message is dropped (`AttemptError::Transport` has no field for it) but the report is not.
    #[tokio::test]
    async fn a_broken_line_stream_flushes_before_the_failure() {
        let http = FakeHttp::new(vec![Scripted::sse_then_break(
            &[
                r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"t","arguments":"{}"}}]}}]}"#,
            ],
            "upstream went silent for 120s",
        )]);
        let interp = interpreter(&openai_manifest(), http.clone());

        let log: Arc<Mutex<Vec<&'static str>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = log.clone();
        let mut on_tool = move |_c: ToolCall| sink.lock().unwrap().push("flushed");
        let mut args = text_args("m");
        args.on_tool_call = Some(&mut on_tool);

        // Bound rather than inlined: the returned stream borrows the `Cancel` for its whole life.
        let cancel = Cancel::new();
        let mut stream = interp.generate_text("key:k1", args, &cancel).await.unwrap();
        let mut observed = Vec::new();
        while let Some(item) = stream.next().await {
            observed.push((item, log.lock().unwrap().len()));
        }

        assert_eq!(observed.len(), 1);
        assert_eq!(observed[0].0, Err(AttemptError::Transport));
        assert_eq!(observed[0].1, 1, "the flush preceded the failure");
    }

    /// Fragments of one OpenAI tool call arrive across chunks and are reassembled, then reported
    /// once the stream ends.
    #[tokio::test]
    async fn streamed_tool_call_fragments_are_reassembled_and_flushed_at_the_end() {
        let http = FakeHttp::new(vec![Scripted::sse(&[
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"lookup","arguments":"{\"ci"}}]}}]}"#,
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ty\":\"Dhaka\"}"}}]}}]}"#,
            "data: [DONE]",
        ])]);
        let interp = interpreter(&openai_manifest(), http.clone());

        let seen: Arc<Mutex<Vec<ToolCall>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let mut on_tool = move |c: ToolCall| sink.lock().unwrap().push(c);
        let mut args = text_args("m");
        args.on_tool_call = Some(&mut on_tool);

        drain(interp.generate_text("key:k1", args, &Cancel::new()).await.unwrap()).await;

        let calls = seen.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].id.as_deref(), Some("call_1"));
        assert_eq!(calls[0].name.as_deref(), Some("lookup"));
        assert_eq!(calls[0].arguments.as_deref(), Some("{\"city\":\"Dhaka\"}"));
    }

    /// **No tool-call sink, no reassembly work** — the source's
    /// `Boolean(args.onToolCall && …)`. A dialect that declares the framing still reports nothing
    /// when nobody is listening.
    #[tokio::test]
    async fn tool_call_framing_is_ignored_when_no_callback_is_attached() {
        let http = FakeHttp::new(vec![Scripted::sse(&[
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"t","arguments":"{}"}}]}}]}"#,
            "data: [DONE]",
        ])]);
        let interp = interpreter(&openai_manifest(), http.clone());

        let out =
            drain(interp.generate_text("key:k1", text_args("m"), &Cancel::new()).await.unwrap())
                .await;

        assert!(out.is_empty(), "a tool-call turn carries no text");
    }

    /// Anthropic's framing: a start event declares the call, then one delta event per fragment.
    #[tokio::test]
    async fn the_multi_event_tool_call_framing_reassembles_across_events() {
        let http = FakeHttp::new(vec![Scripted::sse(&[
            r#"data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"lookup"}}"#,
            r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"city\":"}}"#,
            r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\"Dhaka\"}"}}"#,
            r#"data: {"type":"message_stop"}"#,
        ])]);
        let interp = interpreter(&anthropic_manifest(), http.clone());

        let seen: Arc<Mutex<Vec<ToolCall>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let mut on_tool = move |c: ToolCall| sink.lock().unwrap().push(c);
        let mut args = text_args("m");
        args.on_tool_call = Some(&mut on_tool);

        drain(interp.generate_text("key:k1", args, &Cancel::new()).await.unwrap()).await;

        let calls = seen.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].id.as_deref(), Some("toolu_1"));
        assert_eq!(calls[0].name.as_deref(), Some("lookup"));
        assert_eq!(calls[0].arguments.as_deref(), Some("{\"city\":\"Dhaka\"}"));
    }

    /// A cancelled stream reports nothing: the source guards both flushes with
    /// `!signal?.aborted`, so a cancelled attempt never claims a tool call or a usage block.
    #[tokio::test]
    async fn a_cancelled_stream_yields_nothing_and_reports_nothing() {
        let http = FakeHttp::new(vec![Scripted::sse(&[&delta_line("never seen"), "data: [DONE]"])]);
        let interp = interpreter(&openai_manifest(), http.clone());

        let log: Arc<Mutex<Vec<&'static str>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = log.clone();
        let mut on_tool = move |_c: ToolCall| sink.lock().unwrap().push("flushed");
        let mut args = text_args("m");
        args.on_tool_call = Some(&mut on_tool);

        let cancel = Cancel::new();
        cancel.cancel();

        let out = drain(interp.generate_text("key:k1", args, &cancel).await.unwrap()).await;

        assert!(out.is_empty());
        assert!(log.lock().unwrap().is_empty(), "a cancelled stream must report nothing");
    }

    /// A **streaming** request the provider refuses fails in the response phase, with the body read
    /// from the port and the wait from the header — the one case where `body` and `lines` meet.
    #[tokio::test]
    async fn a_refused_streaming_request_fails_in_the_response_phase_with_its_wait() {
        let http = FakeHttp::new(vec![Scripted::stream_refused(
            429,
            "rate limited",
            &[("Retry-After", "30")],
        )]);
        let interp = interpreter(&openai_manifest(), http.clone());

        let err = match interp.generate_text("key:k1", text_args("m"), &Cancel::new()).await {
            Ok(_) => panic!("a refused request must not answer with a stream"),
            Err(e) => e,
        };

        assert_eq!(
            err,
            AttemptError::Http {
                status: 429,
                kind: FailureKind::Response,
                retry_after_ms: Some(30_000),
            }
        );
        assert!(http.only_request().stream, "it was asked for as a stream");
    }

    /// **The kind decides, not the message.** A port failure is a transport failure unless the port
    /// says it was a refusal — and the middle case below is the falsification: a transport-kind
    /// error whose message *reads* like a refusal must still classify as `Transport`, because
    /// sniffing the text is exactly what this mapping replaced.
    ///
    /// The last case is the divergence in one line: nothing was dialled, so the class is
    /// `EGRESS_DENIED` rather than `NETWORK`, and the egress's own words survive on the variant so
    /// the specific host stays recoverable at the one point it is still in hand.
    #[tokio::test]
    async fn a_port_failure_is_a_transport_failure_and_a_refusal_is_egress_denied() {
        async fn failure_from(err: HttpError) -> AttemptError {
            struct Port(HttpError);
            impl HttpPort for Port {
                fn request<'a>(
                    &'a self,
                    _req: HttpRequest,
                    _cancel: &'a Cancel,
                ) -> BoxFuture<'a, Result<HttpResponse<'a>, HttpError>> {
                    let e = self.0.clone();
                    Box::pin(async move { Err(e) })
                }
            }

            let interp = ManifestInterpreter::new(
                &openai_manifest(),
                AdapterContext { http: Arc::new(Port(err)), vars: Map::new() },
            )
            .unwrap();

            // Bound to a local rather than returned as the tail expression: the `Ok` arm's
            // `BoxStream` borrows `interp`, so as a tail expression the temporary outlives it.
            let err = match interp.generate_text("key:k1", text_args("m"), &Cancel::new()).await {
                Ok(_) => panic!("a dead port must not produce a stream"),
                Err(e) => e,
            };
            err
        }

        // A genuine host failure: no answer, and a message naming nothing in particular.
        assert_eq!(
            failure_from(HttpError::new("connection reset by peer")).await,
            AttemptError::Transport
        );

        // **The discriminating input.** This message is the exact string the previous spelling of
        // this test passed, but the kind is `Transport` — so under message-sniffing it would read as
        // a policy refusal, and under the kind it does not. If the mapping ever reverts to looking
        // at the text, this is the assertion that reddens.
        assert_eq!(
            failure_from(HttpError::new("host not allowlisted")).await,
            AttemptError::Transport
        );

        // The refusal — and the reason travels with it rather than being flattened into the class.
        assert_eq!(
            failure_from(HttpError::denied("host api.example.test is not allowlisted")).await,
            AttemptError::Blocked { reason: "host api.example.test is not allowlisted".into() }
        );
    }

    /* ------------------------------------------------------------ construction */

    #[test]
    fn a_manifest_that_is_not_readable_is_a_shape_error() {
        // Matched rather than `unwrap_err()`: the `Ok` side is a `ManifestInterpreter`, which is
        // deliberately not `Debug` (it holds a `dyn HttpPort`), so `unwrap_err` is unavailable.
        let err = match ManifestInterpreter::new(
            &json!({ "dialect": "d" }),
            AdapterContext { http: FakeHttp::new(vec![]), vars: Map::new() },
        ) {
            Ok(_) => panic!("a manifest with no endpoints must not be readable"),
            Err(e) => e,
        };
        assert!(err.to_string().contains("not a readable declarative manifest"));
    }

    #[test]
    fn the_capabilities_are_the_manifests_own_declaration() {
        let interp = interpreter(&openai_manifest(), FakeHttp::new(vec![]));
        assert_eq!(
            interp.capabilities(),
            crate::core::manifest_view::Capabilities { text: true, image: true }
        );

        let anthropic = interpreter(&anthropic_manifest(), FakeHttp::new(vec![]));
        assert_eq!(
            anthropic.capabilities(),
            crate::core::manifest_view::Capabilities { text: true, image: false }
        );
    }

    /// One unary call against `manifest`, returning the body the port actually saw. Used to hold
    /// everything but the host variables fixed across two calls.
    async fn sent_body(manifest: &Value, vars: Map<String, Value>, model: &str) -> Value {
        let http = FakeHttp::new(vec![Scripted::text(
            200,
            r#"{"choices":[{"message":{"content":"x"}}]}"#,
        )]);
        let interp =
            ManifestInterpreter::new(manifest, AdapterContext { http: http.clone(), vars })
                .unwrap();
        let mut args = text_args(model);
        args.stream = false;
        drain(interp.generate_text("key:k1", args, &Cancel::new()).await.unwrap()).await;
        serde_json::from_str(http.only_request().body.as_deref().unwrap()).unwrap()
    }

    /// The host variables are spread *after* the built-in values (`...this.ctx.vars` comes last in
    /// the object literal, `manifest-interpreter.ts:279`), so a host variable of the same name
    /// overwrites the built-in. The two calls below differ in exactly one thing: whether a host
    /// variable named `model` exists. `tag` is a template key no built-in defines, so it also
    /// shows the host variables reaching the template at all.
    #[tokio::test]
    async fn a_host_variable_of_the_same_name_wins_over_the_built_in_one() {
        let mut manifest = openai_manifest();
        manifest["endpoints"]["generateText"]["requestTemplate"]["tag"] = json!("{{model}}");

        // No host variable: the caller's model is what renders, under both keys.
        let plain = sent_body(&manifest, Map::new(), "from-the-caller").await;
        assert_eq!(plain["model"], json!("from-the-caller"));
        assert_eq!(plain["tag"], json!("from-the-caller"));

        // With one: the host's value displaces the built-in `model`, and `tag` — which no built-in
        // defines — picks up the same value.
        let mut vars = Map::new();
        vars.insert("model".to_string(), json!("from-the-host"));
        let hosted = sent_body(&manifest, vars, "from-the-caller").await;
        assert_eq!(
            hosted["model"],
            json!("from-the-host"),
            "the host variable is read last, so it overwrites the caller's model"
        );
        assert_eq!(hosted["tag"], json!("from-the-host"));
    }
}
