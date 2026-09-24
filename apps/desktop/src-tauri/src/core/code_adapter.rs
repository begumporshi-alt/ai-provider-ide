//! The `kind: "code"` adapter — the port of `code-adapter.ts`.
//!
//! [`crate::core::js_host`] is the guest's engine and knows nothing about manifests, models or the
//! router's seam. This module is the other half: it owns the facts that come from the manifest —
//! where the guest may reach ([`sandbox::HttpTarget`]), what the provider is declared to do, how
//! its catalogue entries are tagged — and implements [`AdapterInstance`] on top of one
//! [`JsSandbox`]. The split is the TypeScript's: `CodeAdapterInstance` holds `manifest` and
//! `opts.http`, and delegates the guest to `callOp`.
//!
//! **`generate_text` streams, and its response phase is therefore almost empty.** The reference's
//! `generateText` is an `AsyncGenerator` (`code-adapter.ts:497`), so its body does not start until
//! the consumer pulls — `ensure()` and the compile included. This port matches that: the future
//! resolves as soon as the command is on the actor's channel, and the only thing that can fail in
//! the response phase is a sandbox that is no longer there. Everything else — a guest that does
//! not implement `generateText`, one that throws, one that overruns a budget — is discovered
//! *after* the consumer has pulled at least once, and so arrives as a **stream item** rather than
//! as `Err`.
//!
//! **Arriving as an item does not by itself make it mid-stream, and the difference is load-bearing.**
//! The engine does not read the class off the error; it reads it off the phase, through
//! `attempt_disposition(emitted, aborted)` (`engine.rs:448`). A failure that arrives before any
//! chunk has been emitted is `AttemptDisposition::Next` — the loop tries the next candidate, which
//! is what a request that never produced a byte deserves. Only once a chunk is in the consumer's
//! hands is it `Rethrow`, and only that path reports `TextFailure::MidStream`, because re-running
//! the attempt would show the consumer its text twice. The declarative interpreter reaches the same
//! split by a different road (`interpreter.rs` throws before its yield loop or inside it), and
//! `the_same_status_is_a_refusal_or_a_break_depending_on_which_phase_threw` is the engine test that
//! pins the two together.
//!
//! **The chunks reach the caller as the guest emits them, not when the operation settles.** The
//! actor forwards each round's `emit` lines down a channel before it does anything else, and the
//! operation's terminal outcome travels the same channel as [`Chunk::End`] so that the stream can
//! end on a value instead of on an ambiguous closed channel.
//!
//! **A code provider reports neither usage nor tool calls, and that is the reference's behaviour,
//! not an omission here.** The guest is handed `messages`, `tools` and friends as JSON and the only
//! channel back is `emit(string)`; `code-adapter.ts` never calls `args.onUsage` or
//! `args.onToolCall`. So the two callbacks on [`TextArgs`] are dropped, and every code-provider
//! request reports zero tokens — with the consequence the usage module exists to prevent: the
//! spend cap cannot bite for such a provider. Recorded rather than improved on, because a usage
//! protocol the guest does not speak would be a divergence in the one direction the reference is
//! silent.
//!
//! **`dispose` needs no flag.** The reference keeps a `disposed` boolean and throws
//! `"adapter disposed"` from `ensure()`. Here a disposed sandbox is a closed channel: the actor has
//! left its receive loop, so the next send fails and `JsSandbox::call` reports
//! `SandboxReason::Host` — the same reason the reference reports. A flag would be a second spelling
//! of a state the channel already carries.

use std::sync::Arc;

use futures_util::future::BoxFuture;
use futures_util::stream::{self, BoxStream};
use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::core::adapter::{
    AdapterInstance, Cancel, Capabilities, ImageArgs, ImageReply, ModelEntry, PingResult, TextArgs,
};
use crate::core::engine::AttemptError;
use crate::core::http_port::HttpPort;
use crate::core::interpreter::{AdapterContext, PING_MESSAGE_LIMIT};
use crate::core::js_host::{Chunk, JsSandbox, Operation, OperationOutcome, SandboxLimits};
use crate::core::manifest::truncate_utf16;
use crate::core::manifest::AuthHeader;
use crate::core::manifest_view::{Limits, Provider};
use crate::core::modality::{self, ModalityRules};
use crate::core::sandbox;

/// The blocks of a `kind: "code"` manifest this adapter reads.
///
/// **Not [`crate::core::manifest_view::ManifestView`], although one would parse.** A code manifest
/// satisfies that read model only by accident: it carries `endpoints: {}`
/// (`code-candidate.ts:254`) and every field there is optional, so the parse succeeds. Reusing it
/// would tie this adapter's shape to the declarative interpreter's and put three endpoint fields on
/// a type whose guest never sees them — the shape of the `baseUrl` gap `AdapterFactory` records,
/// where a value the sender holds is dropped one line later.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodeManifest {
    provider: Provider,
    capabilities: Capabilities,
    /// Forwarded to the guest as `args.limits` (`code-adapter.ts:530`). `None` becomes `null`
    /// rather than an absent key, because that is what `this.manifest.limits ?? null` produces.
    #[serde(default)]
    limits: Option<Limits>,
}

/// One provider's guest adapter.
pub struct CodeAdapterInstance {
    sandbox: JsSandbox,
    /// Built once, at spawn.
    ///
    /// The reference renders it per call — `makeHttp` reads `this.manifest.provider` every time
    /// (`code-adapter.ts`) — but nothing about it can change between calls: the manifest a sandbox
    /// was compiled from is fixed. Rendering it once also puts the trailing-slash and `{{secret}}`
    /// rules where a test can reach them without a live guest.
    target: sandbox::HttpTarget,
    egress: Arc<dyn HttpPort>,
    capabilities: Capabilities,
    modality_rules: Option<ModalityRules>,
    limits: Option<Limits>,
}

impl std::fmt::Debug for CodeAdapterInstance {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CodeAdapterInstance")
            .field("sandbox", &self.sandbox)
            .field("target", &self.target)
            .finish_non_exhaustive()
    }
}

impl CodeAdapterInstance {
    /// Lint the source, read the manifest, and start the guest.
    ///
    /// **The lint runs before the sandbox does**, as in the reference's constructor
    /// (`code-adapter.ts:121-127`): a source that trips the tripwire is rejected without a runtime
    /// ever being built, which is the only ordering in which `SandboxReason::Lint` can mean
    /// anything.
    ///
    /// [`AdapterContext::vars`] is not read. A code adapter has no template variables — the guest
    /// receives the request as JSON and does its own templating, so the field exists on this
    /// module's signature only because both adapters take the crate's one host-context shape.
    pub fn spawn(
        source: &str,
        manifest: &Value,
        ctx: AdapterContext,
        limits: SandboxLimits,
    ) -> Result<Self, sandbox::SandboxError> {
        let lint = sandbox::lint_code_source(source);
        if !lint.is_empty() {
            return Err(sandbox::SandboxError::new(
                sandbox::SandboxReason::Lint,
                format!("code adapter rejected by lint: {}", lint.join("; ")),
            ));
        }
        let view: CodeManifest = serde_json::from_value(manifest.clone()).map_err(|e| {
            sandbox::SandboxError::new(
                sandbox::SandboxReason::Host,
                format!("the manifest does not read as a code adapter: {e}"),
            )
        })?;
        let auth: Vec<sandbox::AuthHeader> =
            view.provider.auth.headers.iter().map(to_target_header).collect();
        let target = sandbox::HttpTarget::new(&view.provider.base_url, &auth);
        // Not part of `ManifestView`: the grammar validates the rules and the interpreter's read
        // model ignores unknown fields, so they have to be read from the raw manifest.
        let modality_rules = modality::rules_from_manifest(manifest).ok().flatten();
        let sandbox = JsSandbox::spawn(source, limits)?;
        Ok(CodeAdapterInstance {
            sandbox,
            target,
            egress: ctx.http,
            capabilities: view.capabilities,
            modality_rules,
            limits: view.limits,
        })
    }

    /// One operation through the sandbox.
    async fn call(
        &self,
        operation: Operation,
        args_json: &str,
        secret_ref: &str,
        cancel: &Cancel,
    ) -> Result<OperationOutcome, sandbox::SandboxError> {
        self.sandbox
            .call(operation, args_json, &self.target, secret_ref, self.egress.clone(), cancel)
            .await
    }

    /// The catalogue, before the seam's error type is applied.
    ///
    /// Both [`Self::list_models`] and the ping route through here so that "what a ping asks" and
    /// "what a catalogue call asks" cannot drift: the reference's `pingKey` calls `this.listModels`
    /// (`code-adapter.ts:606`), not the guest's method directly.
    async fn models(
        &self,
        secret_ref: &str,
        cancel: &Cancel,
    ) -> Result<Vec<ModelEntry>, sandbox::SandboxError> {
        // `listModels` takes no arguments at all, so `args_json` is unused rather than
        // deliberately empty — `Operation::takes_args_json` is what decides.
        let outcome = self.call(Operation::ListModels, "", secret_ref, cancel).await?;
        Ok(sandbox::read_models(&outcome.value))
    }

    async fn run_ping_key(&self, secret_ref: &str, cancel: &Cancel) -> PingResult {
        match self.models(secret_ref, cancel).await {
            Ok(models) => {
                let ok = !models.is_empty();
                PingResult {
                    ok,
                    status: if ok { 200 } else { 0 },
                    rate_limited: false,
                    // The reference's own words for a catalogue that came back empty
                    // (`code-adapter.ts:609`) — a *successful* call that listed nothing, which is
                    // why `ok` is false while the failure fields stay clean.
                    message: if ok { None } else { Some("empty model list".to_string()) },
                }
            }
            Err(e) => {
                // `/429/.test(msg)` — a **substring** test on the message, not a status
                // comparison. The two adapters therefore disagree about what "rate limited"
                // means: the interpreter's `ping_key` tests `status == 429`, this one tests the
                // text, so any message that happens to contain `429` — a body, a retry hint —
                // marks the key rate-limited. That is the reference's rule and it is kept, but it
                // is a weaker signal and the two are worth reading side by side.
                let rate_limited = e.message.contains("429");
                PingResult {
                    ok: false,
                    status: if rate_limited { 429 } else { 0 },
                    rate_limited,
                    message: Some(truncate_utf16(&e.message, PING_MESSAGE_LIMIT)),
                }
            }
        }
    }
}

impl AdapterInstance for CodeAdapterInstance {
    fn capabilities(&self) -> Capabilities {
        self.capabilities
    }

    fn tag_modality(&self, entry: &ModelEntry) -> &'static str {
        let input = modality::ModalityInput { native_id: &entry.native_id, raw: Some(&entry.raw) };
        // A stored manifest has already passed the grammar, so an error here is the unreachable
        // third variant and "text" is the safe fallback — the same reading the interpreter makes.
        modality::tag_modality(self.modality_rules.as_ref(), &input)
            .map(|m| m.as_str())
            .unwrap_or("text")
    }

    fn list_models<'a>(
        &'a self,
        secret_ref: &'a str,
        cancel: &'a Cancel,
    ) -> BoxFuture<'a, Result<Vec<ModelEntry>, AttemptError>> {
        Box::pin(async move {
            self.models(secret_ref, cancel).await.map_err(|e| AttemptError::from(&e))
        })
    }

    fn generate_image<'a>(
        &'a self,
        secret_ref: &'a str,
        args: ImageArgs,
        cancel: &'a Cancel,
    ) -> BoxFuture<'a, Result<ImageReply, AttemptError>> {
        Box::pin(async move {
            let args_json = image_args_json(&args);
            let outcome = self
                .call(Operation::GenerateImage, &args_json, secret_ref, cancel)
                .await
                // Written out rather than `.into()`: `AttemptError` has three `From` impls, so
                // the inference at a `?` inside an `async` block cannot pick one.
                .map_err(|e| AttemptError::from(&e))?;
            // `ImageReply`, not an error: a guest that returns `{ok: false, status: 400}` has
            // *answered*, and the engine classifies the status. Only a guest that threw becomes
            // `Err` — the same split `ImageReply`'s doc calls out for the declarative adapter.
            Ok(sandbox::read_image_reply(&outcome.value))
        })
    }

    fn generate_text<'a>(
        &'a self,
        secret_ref: &'a str,
        args: TextArgs<'a>,
        cancel: &'a Cancel,
    ) -> BoxFuture<'a, Result<BoxStream<'a, Result<String, AttemptError>>, AttemptError>> {
        Box::pin(async move {
            let args_json = text_args_json(&args, self.limits.as_ref());
            // Nothing is awaited before this: the actor has the operation and the chunks start
            // arriving on their own. See the module note for why the response phase is empty.
            let chunks = self
                .sandbox
                .stream(
                    Operation::GenerateText,
                    &args_json,
                    &self.target,
                    secret_ref,
                    self.egress.clone(),
                    cancel,
                )
                .map_err(|e| AttemptError::from(&e))?;
            Ok(Box::pin(stream::unfold(chunks, |mut chunks| async move {
                match chunks.recv().await {
                    Some(Chunk::Line(text)) => Some((Ok(text), chunks)),
                    // A failure is an **item**, then the stream ends. It cannot be the `Err` of
                    // the response phase, because by now the consumer holds text.
                    Some(Chunk::End(Err(e))) => Some((Err(AttemptError::from(&e)), chunks)),
                    Some(Chunk::End(Ok(()))) | None => None,
                }
            })) as BoxStream<'a, Result<String, AttemptError>>)
        })
    }

    fn ping_key<'a>(
        &'a self,
        secret_ref: &'a str,
        cancel: &'a Cancel,
    ) -> BoxFuture<'a, PingResult> {
        Box::pin(self.run_ping_key(secret_ref, cancel))
    }

    fn dispose(&self) {
        self.sandbox.dispose();
    }
}

/// `JSON.stringify({ model, prompt, size })` — the reference's own argument object
/// (`code-adapter.ts:479`).
///
/// **An absent `size` leaves the key out**, which is what `size: undefined` does, rather than
/// sending `"size": null`. The guest reads `JSON.parse(argsJson).size` and both spellings are
/// falsy there, but they are not the same bytes and `Object.hasOwnProperty` can tell them apart.
fn image_args_json(args: &ImageArgs) -> String {
    let mut map = Map::new();
    map.insert("model".to_string(), Value::String(args.model.clone()));
    map.insert("prompt".to_string(), Value::String(args.prompt.clone()));
    if let Some(size) = &args.size {
        map.insert("size".to_string(), Value::String(size.clone()));
    }
    serialize(&map)
}

/// `generateText`'s argument object — the reference's exact key set (`code-adapter.ts:525-533`).
///
/// **Two groups, and the difference is `JSON.stringify`'s.** `maxTokens` and `temperature` are
/// passed straight through, so `undefined` omits the key; `tools`, `toolChoice`, `responseFormat`
/// and `limits` are `?? null`, so they are present-with-`null` when absent. Four keys therefore
/// always appear and two do not, which is only reproducible by writing the two groups differently.
///
/// The callbacks are **not** forwarded: the guest has no way to call back into the host other than
/// `emit`, so `onUsage` and `onToolCall` are dropped. See the module note for why that is recorded
/// rather than fixed.
fn text_args_json(args: &TextArgs<'_>, limits: Option<&Limits>) -> String {
    let mut map = Map::new();
    map.insert("model".to_string(), Value::String(args.model.clone()));
    map.insert("messages".to_string(), Value::Array(args.messages.to_vec()));
    map.insert("stream".to_string(), Value::Bool(args.stream));
    if let Some(max_tokens) = args.max_tokens {
        map.insert("maxTokens".to_string(), json!(max_tokens));
    }
    if let Some(temperature) = args.temperature {
        map.insert("temperature".to_string(), json!(temperature));
    }
    map.insert("tools".to_string(), args.tools.cloned().unwrap_or(Value::Null));
    map.insert("toolChoice".to_string(), args.tool_choice.cloned().unwrap_or(Value::Null));
    map.insert("responseFormat".to_string(), args.response_format.cloned().unwrap_or(Value::Null));
    map.insert("limits".to_string(), limits_json(limits));
    serialize(&map)
}

/// `this.manifest.limits ?? null`, and `undefined` inside it omits the key the same way.
fn limits_json(limits: Option<&Limits>) -> Value {
    match limits.and_then(|l| l.max_output_tokens) {
        Some(max_output_tokens) => json!({ "maxOutputTokens": max_output_tokens }),
        None => match limits {
            Some(_) => json!({}),
            None => Value::Null,
        },
    }
}

/// Infallible for a `Map<String, Value>`: the one error `serde_json` can report is a non-string key.
fn serialize(map: &Map<String, Value>) -> String {
    serde_json::to_string(map).unwrap_or_else(|_| "{}".to_string())
}

/// `manifest::AuthHeader` → `sandbox::AuthHeader`.
///
/// **Two types with identical fields, and the duplication is real.** `manifest::auth_headers`
/// renders the same `{{secret}}` rule into a `BTreeMap` for the declarative interpreter;
/// `HttpTarget::new` renders it into a `Vec` for the sandbox so the manifest's order survives. They
/// also disagree on a duplicate name: the map leaves the last value at a sorted position, the `Vec`
/// leaves it at the first name's position. Collapsing them would mean a `Vec` every caller sorts or
/// a map that cannot express order, so the conversion is written once here instead.
fn to_target_header(h: &AuthHeader) -> sandbox::AuthHeader {
    sandbox::AuthHeader { name: h.name.clone(), prefix: h.prefix.clone() }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::collections::BTreeMap;
    use std::sync::Mutex;

    use futures_util::StreamExt;
    use serde_json::json;

    use crate::core::http_port::{HttpError, HttpMethod, HttpRequest, HttpResponse};

    /// A code manifest, as `code-candidate.ts:246-256` builds one.
    fn manifest() -> Value {
        json!({
            "manifestVersion": 1,
            "kind": "code",
            "dialect": "custom-code-v1",
            "provider": {
                "baseUrl": "https://api.example.com/v1/",
                "auth": { "headers": [{ "name": "Authorization", "prefix": "Bearer" }] },
            },
            "endpoints": {},
            "code": { "source": "…", "entry": "adapter" },
            "capabilities": { "text": true, "image": true },
        })
    }

    /// What the egress recorded: one `(url, headers)` per call it served.
    type Seen = Arc<Mutex<Vec<(String, BTreeMap<String, String>)>>>;

    /// An egress that answers every call with one body and records what it was asked for.
    struct Scripted {
        body: String,
        seen: Seen,
    }

    impl Scripted {
        fn new(body: &str) -> (Arc<Scripted>, Seen) {
            let seen: Seen = Arc::new(Mutex::new(Vec::new()));
            let port = Arc::new(Scripted { body: body.to_string(), seen: seen.clone() });
            (port, seen)
        }
    }

    impl HttpPort for Scripted {
        fn request<'a>(
            &'a self,
            req: HttpRequest,
            _cancel: &'a Cancel,
        ) -> BoxFuture<'a, Result<HttpResponse<'a>, HttpError>> {
            Box::pin(async move {
                self.seen.lock().unwrap().push((req.url.clone(), req.headers.clone()));
                let _ = req.method == HttpMethod::Get;
                Ok(HttpResponse {
                    status: 200,
                    headers: BTreeMap::new(),
                    body: self.body.clone(),
                    lines: None,
                })
            })
        }
    }

    fn spawn(source: &str, manifest: &Value, port: Arc<dyn HttpPort>) -> CodeAdapterInstance {
        CodeAdapterInstance::spawn(
            source,
            manifest,
            AdapterContext { http: port, vars: Map::new() },
            SandboxLimits::default(),
        )
        .expect("the guest should compile")
    }

    fn no_egress() -> Arc<dyn HttpPort> {
        Scripted::new("{}").0
    }

    /// The manifest's `baseUrl` is trimmed and its auth header carries the sentinel, not a key.
    ///
    /// The prefix survives as `Bearer {{secret}}` — the one rendering `HttpTarget::new` exists to
    /// pin, and the reason an empty prefix must not produce a leading space.
    #[test]
    fn the_target_carries_the_manifest_base_url_and_sentinel() {
        let adapter = spawn(
            "export default { async listModels() { return []; } };",
            &manifest(),
            no_egress(),
        );
        assert_eq!(adapter.target.base_url, "https://api.example.com/v1");
        assert_eq!(
            adapter.target.auth_headers,
            vec![("Authorization".to_string(), "Bearer {{secret}}".to_string())]
        );
    }

    /// A source that trips the lint never reaches QuickJS — `SandboxReason::Lint`, with the
    /// reference's message.
    #[test]
    fn a_source_the_lint_rejects_never_builds_a_sandbox() {
        let error = CodeAdapterInstance::spawn(
            "const x = require('fs');",
            &manifest(),
            AdapterContext { http: no_egress(), vars: Map::new() },
            SandboxLimits::default(),
        )
        .expect_err("the lint should reject an unguarded require");
        assert_eq!(error.reason, sandbox::SandboxReason::Lint);
        assert!(error.message.starts_with("code adapter rejected by lint: "));
    }

    #[tokio::test]
    async fn list_models_reads_the_guest_array() {
        let (port, seen) = Scripted::new(
            r#"{"data":[{"id":"gpt-4o"},"bare-model",{"name":"named"},{"id":""},7]}"#,
        );
        let adapter = spawn(
            r#"
            export default {
              async listModels(http) {
                const r = await http({ path: "/models", method: "GET" });
                return JSON.parse(r.text).data;
              },
            };
            "#,
            &manifest(),
            port,
        );
        let models = adapter
            .list_models("key-1", &Cancel::new())
            .await
            .expect("the catalogue should be read");
        // `{"id":""}` and `7` are dropped: the first has an empty id, the second is not a string
        // or an object. `{"name":"named"}` survives on its name.
        let ids: Vec<&str> = models.iter().map(|m| m.native_id.as_str()).collect();
        assert_eq!(ids, vec!["gpt-4o", "bare-model", "named"]);
        // The call went to the manifest's base URL — trailing slash trimmed, path joined — with
        // the sentinel as its auth header. **The name keeps the manifest's own capitalisation**:
        // only *response* headers are lower-cased by the host (`http_port.rs:113`), so a lookup
        // written in lowercase here finds nothing and the assertion would be a false pass.
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].0, "https://api.example.com/v1/models");
        assert_eq!(seen[0].1.get("Authorization").map(String::as_str), Some("Bearer {{secret}}"));
    }

    #[tokio::test]
    async fn generate_image_reads_the_guest_reply() {
        let adapter = spawn(
            r#"
            export default {
              async generateImage(http, argsJson) {
                const args = JSON.parse(argsJson);
                return {
                  ok: true,
                  status: 200,
                  base64: args.model + "/" + args.prompt,
                  errorBody: "x".repeat(900),
                };
              },
            };
            "#,
            &manifest(),
            no_egress(),
        );
        let reply = adapter
            .generate_image(
                "key-1",
                ImageArgs {
                    model: "dall-e".to_string(),
                    prompt: "a cat".to_string(),
                    size: Some("1024x1024".to_string()),
                },
                &Cancel::new(),
            )
            .await
            .expect("the image call should answer");
        assert_eq!(reply.base64.as_deref(), Some("dall-e/a cat"));
        // The reference's `slice(0, 500)`, applied by `read_image_reply`.
        assert_eq!(reply.error_body.as_ref().map(|b| b.len()), Some(500));
        assert!(reply.ok);
        assert_eq!(reply.status, 200);
    }

    /// `generateText` yields the emitted lines, in order — buffered, per the module note.
    #[tokio::test]
    async fn generate_text_yields_the_emitted_lines() {
        let adapter = spawn(
            r#"
            export default {
              async generateText(http, emit, argsJson) {
                const args = JSON.parse(argsJson);
                emit("He");
                emit("llo " + args.model);
                return { ignored: true };
              },
            };
            "#,
            &manifest(),
            no_egress(),
        );
        let cancel = Cancel::new();
        let stream = adapter
            .generate_text(
                "key-1",
                TextArgs {
                    model: "gpt-4o".to_string(),
                    messages: &[],
                    stream: true,
                    max_tokens: None,
                    temperature: None,
                    tools: None,
                    tool_choice: None,
                    response_format: None,
                    on_tool_call: None,
                    on_usage: None,
                },
                &cancel,
            )
            .await
            .expect("the text call should answer");
        let chunks: Vec<String> = stream.map(|c| c.expect("no chunk should fail")).collect().await;
        assert_eq!(chunks, vec!["He".to_string(), "llo gpt-4o".to_string()]);
    }

    /// A successful catalogue call that listed nothing: `ok: false`, `status: 0`, and the
    /// reference's own message. Not a failure — a ping that worked and found nothing.
    #[tokio::test]
    async fn ping_key_reports_an_empty_catalogue() {
        let adapter = spawn(
            "export default { async listModels() { return []; } };",
            &manifest(),
            no_egress(),
        );
        let ping = adapter.ping_key("key-1", &Cancel::new()).await;
        assert_eq!(
            ping,
            PingResult {
                ok: false,
                status: 0,
                rate_limited: false,
                message: Some("empty model list".to_string()),
            }
        );
    }

    #[tokio::test]
    async fn ping_key_reports_a_populated_catalogue() {
        let adapter = spawn(
            "export default { async listModels() { return ['a']; } };",
            &manifest(),
            no_egress(),
        );
        let ping = adapter.ping_key("key-1", &Cancel::new()).await;
        assert_eq!(ping, PingResult { ok: true, status: 200, rate_limited: false, message: None });
    }

    /// The reference's `/429/.test(msg)`: a **substring** of the rejection message, so a guest that
    /// throws `429` anywhere in its text is reported rate-limited rather than merely failed.
    #[tokio::test]
    async fn ping_key_reads_429_out_of_the_message() {
        let adapter = spawn(
            r#"export default { async listModels() { throw new Error("upstream said 429"); } };"#,
            &manifest(),
            no_egress(),
        );
        let ping = adapter.ping_key("key-1", &Cancel::new()).await;
        assert!(!ping.ok);
        assert_eq!(ping.status, 429);
        assert!(ping.rate_limited);
        assert!(ping.message.as_deref().unwrap_or("").contains("429"));
    }

    #[tokio::test]
    async fn capabilities_and_modality_come_from_the_manifest() {
        let mut manifest = manifest();
        manifest["modalityRules"] = json!({ "image": { "modelIdPattern": "-image" } });
        let adapter = spawn(
            "export default { async listModels() { return ['a-image', 'b']; } };",
            &manifest,
            no_egress(),
        );
        assert_eq!(adapter.capabilities(), Capabilities { text: true, image: true });
        let image = ModelEntry { native_id: "a-image".to_string(), raw: json!({}) };
        let text = ModelEntry { native_id: "b".to_string(), raw: json!({}) };
        assert_eq!(adapter.tag_modality(&image), "image");
        assert_eq!(adapter.tag_modality(&text), "text");
    }

    /// After `dispose`, the channel is closed: the next call reports `Host`, which is the reason
    /// the reference reports for a disposed adapter. No flag is involved.
    #[tokio::test]
    async fn a_disposed_adapter_reports_host() {
        let adapter = spawn(
            "export default { async listModels() { return ['a']; } };",
            &manifest(),
            no_egress(),
        );
        adapter.dispose();
        let error = adapter
            .list_models("key-1", &Cancel::new())
            .await
            .expect_err("a disposed adapter has no actor to answer");
        assert_eq!(error, AttemptError::Transport);
    }

    /// An absent `size` leaves the key **out**, rather than sending `"size": null`.
    #[test]
    fn image_args_omit_an_absent_size_rather_than_nulling_it() {
        let args = ImageArgs { model: "m".to_string(), prompt: "p".to_string(), size: None };
        let json: Value = serde_json::from_str(&image_args_json(&args)).expect("valid JSON");
        assert!(json.get("size").is_none(), "{json}");
        assert_eq!(json, json!({ "model": "m", "prompt": "p" }));
    }

    /// The reference's two groups, in one object: `maxTokens`/`temperature` are omitted when
    /// absent, while the four `?? null` keys are always present.
    #[test]
    fn text_args_keep_the_references_two_groups() {
        let args = TextArgs {
            model: "m".to_string(),
            messages: &[],
            stream: true,
            max_tokens: None,
            temperature: None,
            tools: None,
            tool_choice: None,
            response_format: None,
            on_tool_call: None,
            on_usage: None,
        };
        let json: Value = serde_json::from_str(&text_args_json(&args, None)).expect("valid JSON");
        assert!(json.get("maxTokens").is_none(), "{json}");
        assert!(json.get("temperature").is_none(), "{json}");
        assert_eq!(
            json,
            json!({
                "model": "m", "messages": [], "stream": true,
                "tools": null, "toolChoice": null, "responseFormat": null, "limits": null,
            })
        );
    }

    /// `limits` follows `this.manifest.limits ?? null`, and `undefined` inside it omits the key the
    /// same way — so a block with no cap is `{}`, not `{"maxOutputTokens": null}`.
    #[test]
    fn limits_json_follows_the_reference_nullish_rule() {
        assert_eq!(limits_json(None), Value::Null);
        assert_eq!(limits_json(Some(&Limits { max_output_tokens: None })), json!({}));
        assert_eq!(
            limits_json(Some(&Limits { max_output_tokens: Some(4096) })),
            json!({ "maxOutputTokens": 4096 })
        );
    }

    // ---- Streaming through the seam (increment 20b) -------------------------------------------

    /// An egress that parks until the test releases it.
    ///
    /// **The only vantage point from which streaming and buffering differ**, because they differ
    /// only in *when*: an egress that answers immediately delivers the same chunks in the same
    /// order whether the adapter streams or buffers, and so cannot test this at all.
    struct Gated {
        entered: tokio::sync::mpsc::UnboundedSender<()>,
        release: Arc<tokio::sync::Notify>,
    }

    impl HttpPort for Gated {
        fn request<'a>(
            &'a self,
            _req: HttpRequest,
            _cancel: &'a Cancel,
        ) -> BoxFuture<'a, Result<HttpResponse<'a>, HttpError>> {
            Box::pin(async move {
                let _ = self.entered.send(());
                self.release.notified().await;
                Ok(HttpResponse {
                    status: 200,
                    headers: BTreeMap::new(),
                    body: r#"{"chunks":["ignored"]}"#.to_string(),
                    lines: None,
                })
            })
        }
    }

    fn gated() -> (Arc<Gated>, tokio::sync::mpsc::UnboundedReceiver<()>) {
        let (entered, entered_rx) = tokio::sync::mpsc::unbounded_channel();
        let port = Arc::new(Gated { entered, release: Arc::new(tokio::sync::Notify::new()) });
        (port, entered_rx)
    }

    /// `TextArgs` with every optional field absent — the shape each streaming test needs.
    fn args<'a>(model: &str) -> TextArgs<'a> {
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

    /// **The property this increment exists for, at the seam.** The guest emits and *then* awaits,
    /// so the first chunk reaches the consumer while the guest's request is still open.
    ///
    /// The response phase is asserted to have answered *before* the request was released, which is
    /// the half of "the response phase is almost empty" that a reader would otherwise take on
    /// trust.
    #[tokio::test]
    async fn a_chunk_arrives_before_the_request_that_follows_it_is_answered() {
        let (egress, mut entered) = gated();
        let adapter = spawn(
            r#"
            export default {
              async generateText(http, emit, argsJson) {
                emit("first");
                await http({ path: "/chat", method: "POST", body: {} });
                emit("second");
              },
            };
            "#,
            &manifest(),
            egress.clone(),
        );
        let cancel = Cancel::new();
        let mut stream = adapter
            .generate_text("key-1", args("gpt-4o"), &cancel)
            .await
            .expect("the response phase must answer without waiting for the guest");

        entered.recv().await.expect("the guest's request should be in flight");
        assert_eq!(
            stream.next().await,
            Some(Ok("first".to_string())),
            "the first chunk must be in hand while the request it precedes is still open"
        );

        egress.release.notify_one();
        assert_eq!(stream.next().await, Some(Ok("second".to_string())));
        assert!(stream.next().await.is_none(), "End(Ok) ends the stream");
    }

    /// A failure *after* the first chunk is an **item**, not the response phase's `Err`: the
    /// consumer already holds text, so the attempt cannot be re-run behind its back.
    #[tokio::test]
    async fn a_failure_after_the_first_chunk_is_an_item_not_a_response_phase_error() {
        let adapter = spawn(
            r#"export default { async generateText(http, emit) { emit("a"); throw new Error("boom"); } };"#,
            &manifest(),
            no_egress(),
        );
        let cancel = Cancel::new();
        let mut stream = adapter
            .generate_text("key-1", args("gpt-4o"), &cancel)
            .await
            .expect("the response phase cannot fail for a guest that throws only later");
        assert_eq!(stream.next().await, Some(Ok("a".to_string())));
        assert!(
            stream.next().await.expect("the failure must arrive as an item").is_err(),
            "the guest's throw must be delivered to the consumer, not swallowed"
        );
        assert!(stream.next().await.is_none(), "the failure is terminal");
    }

    /// A guest with no `generateText` is discovered by *pulling*, not by awaiting — and because no
    /// chunk preceded it, the engine reads it as a retryable refusal (`Next`) rather than as a
    /// mid-stream break. Pinning both halves here is what keeps the module note above from being a
    /// claim about the code rather than a description of it.
    #[tokio::test]
    async fn a_guest_without_generate_text_fails_by_pulling_not_by_awaiting() {
        let adapter = spawn(
            "export default { async listModels() { return []; } };",
            &manifest(),
            no_egress(),
        );
        let cancel = Cancel::new();
        let mut stream = adapter
            .generate_text("key-1", args("gpt-4o"), &cancel)
            .await
            .expect("the response phase must not fail for a method the guest never implemented");
        assert!(
            stream.next().await.expect("the failure must arrive as an item").is_err(),
            "the missing method is a failure the consumer pulls, not one the future returns"
        );
        assert!(stream.next().await.is_none());
    }
}
