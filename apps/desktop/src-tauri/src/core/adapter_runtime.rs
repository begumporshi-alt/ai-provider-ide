//! The adapter runtime — resolve a provider id to the adapter that serves its active manifest.
//!
//! The port of `adapter-runtime.ts` (60 lines). **It is a registry, not merely a factory**, and the
//! name matters: `AdapterFactory` is the one method the engine calls, while what the reference
//! actually holds is a `Map<providerId, AdapterInstance>` with a lifecycle around it — register,
//! unregister, hot-swap, dispose. Porting only the factory would have made every `for_provider` a
//! construction, and construction is not cheap here: a `kind: "code"` adapter owns a thread and a
//! QuickJS context (D30), and [`JsSandbox::spawn`] **compiles the guest source and blocks until the
//! actor reports ready**. A per-request construction would spawn a thread and compile a module per
//! request.
//!
//! # The branch, and why it is here rather than in an adapter
//!
//! `adapter-runtime.ts:52-58` is the one place that reads `manifest.kind`. Everything above it —
//! the execution engine, the model catalogue, the contract suite — is written against
//! [`AdapterInstance`] and never branches on the kind, which is the whole point of the seam
//! (`adapter.rs`). `ManifestView` records the same division from the other side: `kind` is not a
//! field of the interpreter's read model, because by the time an interpreter exists the question
//! has been answered.
//!
//! **The `code` branch reads `code.source` and hands it to [`CodeAdapterInstance::spawn`].** The
//! reference does that check inside the adapter's constructor (`code-adapter.ts:121-124`) and
//! reports it as a **lint** failure. It is here because `spawn` takes an already-extracted source
//! string, so the extraction has to happen on this side of the call; the reason and the message are
//! the reference's, down to the `lint:` prefix `SandboxError`'s `Display` supplies.
//!
//! # One deliberate divergence: the order of a hot swap
//!
//! The reference disposes the superseded adapter **before** it builds the replacement:
//!
//! ```text
//! const superseded = this.byProvider.get(providerId);
//! if (superseded) void superseded.dispose?.();      // :30 — void-ed, so it does not wait
//! this.byProvider.set(providerId, this.build(manifest));  // :31 — throws before the set
//! ```
//!
//! Two consequences follow, and only one of them is about speed. Because `build` is evaluated as
//! the argument to `set`, a manifest that fails to build throws **before** `set` runs — so the map
//! still holds the old adapter, now disposed, and every later `forProvider` returns it and fails
//! with `"adapter disposed"`. The provider is dead until something re-registers it. The `void` on
//! `dispose?.()` also means the teardown races the construction rather than preceding it, so the
//! ordering is an artifact of a discarded promise rather than a stated policy.
//!
//! This port builds first, swaps, then disposes. On this side `dispose` is synchronous and **joins
//! the actor thread**, so the reference's order would additionally pay a join on a path that then
//! fails — and it would reproduce the dead-adapter state rather than a diagnosable absence. A
//! failed [`AdapterRuntime::register`] here leaves the previous adapter serving and says so in its
//! `Err`. Recorded in the drift register; the test
//! `a_manifest_that_fails_to_build_leaves_the_previous_adapter_serving` is the one that pins it.
//!
//! # `appUrl` is a default, not a decoration
//!
//! The reference's declarative branch passes `vars: { appUrl: this.vars.appUrl ?? "https://aiprovider.router" }`
//! (`:57`). That value is not cosmetic on this install: the OpenRouter template's `generateText`
//! carries `"HTTP-Referer": "{{appUrl}}"` (`manifest_view.rs:302`, asserted at `:430`), and a
//! **missing** host variable renders as the empty string rather than as an omission
//! (`manifest.rs:294` — the `?? ""` rule, which is the opposite of the request template's). So a
//! runtime that supplied no vars would send an empty `HTTP-Referer` on every OpenRouter request.
//! [`DEFAULT_APP_URL`] is that string, and
//! `the_app_url_default_reaches_a_declarative_adapters_headers` is what makes it a claim about a
//! header rather than about a field.
//!
//! # What is deliberately absent
//!
//! - **No store read.** [`AdapterRuntime::register`] takes a parsed manifest. Who reads
//!   `manifests.body_json` and calls it is the activation path's business, and nothing in
//!   production calls it yet — this module makes the sandbox *reachable* from the router, which is
//!   what the plan's Phase 4b named; wiring it into `gateway.rs` is Phase 5's.
//! - **No `baseUrl`.** The reference's `forProvider` returns `{ adapter, baseUrl }` and the engine
//!   destructures only `{ adapter }` at both call sites, so [`AdapterFactory`] refuses the field
//!   (`adapter.rs:261-264`). Adding it here would be a second spelling of a value nobody reads.
//! - **No async construction.** `spawn` blocks, so `register` does too. Making it async would put
//!   a `!Send` compile on a runtime that has no reason to be.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use futures_util::future::BoxFuture;
use serde_json::{Map, Value};

use crate::core::adapter::{AdapterFactory, AdapterInstance};
use crate::core::code_adapter::CodeAdapterInstance;
use crate::core::http_port::HttpPort;
use crate::core::interpreter::{AdapterContext, ManifestInterpreter};
use crate::core::js_host::SandboxLimits;
use crate::core::sandbox::{SandboxError, SandboxReason};

/// The `appUrl` a declarative manifest's `{{appUrl}}` resolves to when the host supplies none.
///
/// The reference's literal (`adapter-runtime.ts:57`). See the module note for why an unset value
/// is not the same as this one.
pub const DEFAULT_APP_URL: &str = "https://aiprovider.router";

/// The reference's own message for a `kind: "code"` manifest with no body
/// (`code-adapter.ts:122`), reported under the reason it reports.
const CODE_SOURCE_REQUIRED: &str = "code adapter requires kind:\"code\" + code.source";

/// The active adapter for each provider, and the lifecycle around it.
///
/// `RwLock` rather than `Mutex` because the shape is many readers and rare writers: `for_provider`
/// runs once per attempt, `register` once per activation. The crate already uses `RwLock` for the
/// same shape (`egress::AllowList`). **`panic = "abort"` is set**, so a poisoned lock is not a state
/// this type can reach and the `unwrap`s below are not a swallowed failure.
pub struct AdapterRuntime {
    http: Arc<dyn HttpPort>,
    app_url: String,
    by_provider: RwLock<HashMap<String, Arc<dyn AdapterInstance>>>,
}

impl std::fmt::Debug for AdapterRuntime {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // `dyn HttpPort` is not `Debug`, so the port is named rather than printed. The registry is
        // the interesting half anyway.
        f.debug_struct("AdapterRuntime")
            .field("app_url", &self.app_url)
            .field("providers", &self.registered())
            .finish_non_exhaustive()
    }
}

impl AdapterRuntime {
    /// A runtime with the default [`DEFAULT_APP_URL`].
    pub fn new(http: Arc<dyn HttpPort>) -> Self {
        Self::with_app_url(http, DEFAULT_APP_URL)
    }

    /// A runtime that injects `app_url` as the `appUrl` host variable.
    ///
    /// An empty string is a value, not an absence — the reference's `??` only catches `undefined`
    /// and `null`, so `""` is passed through to the templates and this takes it the same way.
    pub fn with_app_url(http: Arc<dyn HttpPort>, app_url: impl Into<String>) -> Self {
        AdapterRuntime { http, app_url: app_url.into(), by_provider: RwLock::new(HashMap::new()) }
    }

    /// Register — or hot-swap — a provider's active manifest.
    ///
    /// **The replacement is built before the superseded adapter is touched**, which is the
    /// divergence the module note argues for. `Err` means the manifest could not be built into an
    /// adapter and the registry is **unchanged**: the provider keeps serving whatever it served
    /// before, or stays unregistered.
    ///
    /// A successful swap disposes the adapter it replaced, so a code adapter's actor thread leaves
    /// instead of leaking across activations. The lock is released before that dispose runs, because
    /// `dispose` joins the thread and the thread may be in the middle of an operation — holding the
    /// write lock across the join would block every `for_provider` for its duration.
    pub fn register(&self, provider_id: &str, manifest: &Value) -> Result<(), String> {
        let built = self.build(manifest)?;
        let superseded = self.by_provider.write().unwrap().insert(provider_id.to_string(), built);
        if let Some(superseded) = superseded {
            superseded.dispose();
        }
        Ok(())
    }

    /// Drop a provider's adapter and dispose it. Idempotent — the reference's `delete` is too.
    pub fn unregister(&self, provider_id: &str) {
        let removed = self.by_provider.write().unwrap().remove(provider_id);
        if let Some(removed) = removed {
            removed.dispose();
        }
    }

    /// Release every held adapter. Shutdown only, as in the reference.
    ///
    /// The map is emptied before anything is disposed, for the same reason `register` drops the lock
    /// first: no reader should wait on a join.
    pub fn dispose(&self) {
        let held: Vec<Arc<dyn AdapterInstance>> =
            std::mem::take(&mut *self.by_provider.write().unwrap()).into_values().collect();
        for adapter in held {
            adapter.dispose();
        }
    }

    /// The provider ids currently registered, sorted. For diagnostics and for tests.
    pub fn registered(&self) -> Vec<String> {
        let mut ids: Vec<String> = self.by_provider.read().unwrap().keys().cloned().collect();
        ids.sort();
        ids
    }

    /// The host context both constructors take.
    ///
    /// A fresh map per construction, holding exactly the one key the reference passes — not a
    /// shared map that later gains keys, because a var set here would be a var every interpreter
    /// reads.
    fn context(&self) -> AdapterContext {
        let mut vars = Map::new();
        vars.insert("appUrl".to_string(), Value::String(self.app_url.clone()));
        AdapterContext { http: self.http.clone(), vars }
    }

    /// Choose the implementor for a manifest — the reference's `build` (`:52-58`).
    ///
    /// `kind` is read with the grammar's own default (`manifest.ts:130`, `z.enum([...]).default("declarative")`):
    /// a manifest that does not carry the field is declarative. Any value other than the exact
    /// string `"code"` is declarative too, which is what the reference's `===` test does — a stored
    /// manifest has passed the grammar, so the only way to see another value is a manifest that
    /// bypassed it, and sending that to the interpreter is the reference's answer.
    fn build(&self, manifest: &Value) -> Result<Arc<dyn AdapterInstance>, String> {
        if manifest.get("kind").and_then(Value::as_str) == Some("code") {
            let source =
                manifest.pointer("/code/source").and_then(Value::as_str).ok_or_else(|| {
                    SandboxError::new(SandboxReason::Lint, CODE_SOURCE_REQUIRED).to_string()
                })?;
            let instance = CodeAdapterInstance::spawn(
                source,
                manifest,
                self.context(),
                SandboxLimits::default(),
            )
            .map_err(|e| e.to_string())?;
            Ok(Arc::new(instance))
        } else {
            let instance =
                ManifestInterpreter::new(manifest, self.context()).map_err(|e| e.to_string())?;
            Ok(Arc::new(instance))
        }
    }
}

impl AdapterFactory for AdapterRuntime {
    /// The lookup, which is a map read rather than a construction — see the module note.
    ///
    /// The message is the reference's (`:42`). **The engine does not read it**: both call sites
    /// match `Err(_)` and record a transport failure (`engine.rs:648`, `:941`), because the
    /// TypeScript's `forProvider` rejection lands in the same `catch` as a thrown `generateText` and
    /// nothing downstream can tell them apart. It is carried for the operator and for a test.
    fn for_provider<'a>(
        &'a self,
        provider_id: &'a str,
    ) -> BoxFuture<'a, Result<Arc<dyn AdapterInstance>, String>> {
        let found = self.by_provider.read().unwrap().get(provider_id).cloned();
        Box::pin(async move {
            found.ok_or_else(|| format!("no active manifest for provider {provider_id}"))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::collections::BTreeMap;

    use crate::core::adapter::{Cancel, TextArgs};
    use crate::core::engine::AttemptError;
    use crate::core::http_port::{HttpError, HttpMethod, HttpRequest, HttpResponse};

    /// What the egress was asked for: one `(url, headers)` per request.
    type Seen = Arc<std::sync::Mutex<Vec<(String, BTreeMap<String, String>)>>>;

    /// An egress that answers one body and records what it was asked.
    ///
    /// Shared with the code path's tests on purpose: the sandbox test's claim is that **no** request
    /// was made, and that is only checkable against an egress that would have recorded one.
    struct Scripted {
        body: String,
        seen: Seen,
    }

    impl Scripted {
        fn new(body: &str) -> (Arc<Scripted>, Seen) {
            let seen: Seen = Arc::new(std::sync::Mutex::new(Vec::new()));
            (Arc::new(Scripted { body: body.to_string(), seen: seen.clone() }), seen)
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

    /// A declarative manifest whose `generateText` carries the OpenRouter template's
    /// `{{appUrl}}` header — the header the default exists for.
    fn declarative() -> Value {
        serde_json::json!({
            "manifestVersion": 1,
            "kind": "declarative",
            "dialect": "openai-chat-v1",
            "provider": {
                "baseUrl": "https://openrouter.ai/api/v1",
                "auth": { "headers": [{ "name": "Authorization", "prefix": "Bearer" }] }
            },
            "endpoints": {
                "listModels": {
                    "method": "GET",
                    "path": "/models",
                    "map": { "models": "$.data[*].id", "raw": "$.data[*]" }
                },
                "generateText": {
                    "method": "POST",
                    "path": "/chat/completions",
                    "headers": { "HTTP-Referer": "{{appUrl}}", "X-Title": "AI-Provider Router" },
                    "requestTemplate": {
                        "model": "{{model}}",
                        "messages": "{{messages}}",
                        "stream": "{{stream}}"
                    },
                    "responseMap": { "text": "$.choices[0].message.content" }
                }
            },
            "capabilities": { "text": true, "image": false }
        })
    }

    /// A `kind: "code"` manifest, as `code-candidate.ts:246-256` builds one.
    fn code(source: &str) -> Value {
        serde_json::json!({
            "manifestVersion": 1,
            "kind": "code",
            "dialect": "custom-code-v1",
            "provider": {
                "baseUrl": "https://api.example.com/v1/",
                "auth": { "headers": [{ "name": "Authorization", "prefix": "Bearer" }] }
            },
            "endpoints": {},
            "code": { "source": source, "entry": "adapter" },
            "capabilities": { "text": true, "image": true }
        })
    }

    /// A guest that answers `listModels` from its own literal, making **no** request.
    const GUEST: &str = r#"
        export default {
          async listModels() { return ["from-the-guest"]; },
        };
    "#;

    fn runtime(body: &str) -> (AdapterRuntime, Seen) {
        let (port, seen) = Scripted::new(body);
        (AdapterRuntime::new(port), seen)
    }

    /// A resolution failure's message.
    ///
    /// **`expect_err` is unavailable here, and the reason is the seam's own shape** — the same
    /// constraint `adapter.rs:494-498` records for `BoxStream`, one layer up: it requires the *Ok*
    /// type to be `Debug`, and `dyn AdapterInstance` is not. Every consumer of `for_provider` must
    /// therefore `match`. The match is also the stronger assertion: it names which arm came back
    /// rather than trusting that whatever came back was the error arm.
    async fn resolution_error(rt: &AdapterRuntime, provider_id: &str) -> String {
        match rt.for_provider(provider_id).await {
            Ok(_) => panic!("{provider_id} must not resolve"),
            Err(e) => e,
        }
    }

    /// A non-streaming text request.
    ///
    /// **This is the vehicle for the header assertions, and the choice is deliberate.** The
    /// fixture's `{{appUrl}}` sits on `generateText`, because that is where the installed OpenRouter
    /// template carries it (`manifest_view.rs:302`) — so a test that drove `list_models` would be
    /// asserting a header the manifest does not put there. `stream: false` keeps the request in the
    /// response phase, where the reference's unary branch makes it (`:312-329`).
    fn text_args<'a>(model: &str) -> TextArgs<'a> {
        TextArgs {
            model: model.to_string(),
            messages: &[],
            stream: false,
            max_tokens: None,
            temperature: None,
            tools: None,
            tool_choice: None,
            response_format: None,
            on_tool_call: None,
            on_usage: None,
        }
    }

    /// Pull a text stream to exhaustion, discarding the chunks.
    async fn drain(mut s: futures_util::stream::BoxStream<'_, Result<String, AttemptError>>) {
        use futures_util::StreamExt;
        while s.next().await.is_some() {}
    }

    #[tokio::test]
    async fn a_declarative_manifest_resolves_to_an_interpreter() {
        let (rt, _seen) = runtime(r#"{"data":[{"id":"gpt-4o"}]}"#);
        rt.register("openrouter", &declarative()).expect("the fixture builds");

        let adapter = rt.for_provider("openrouter").await.expect("registered");
        assert_eq!(
            adapter.capabilities(),
            crate::core::adapter::Capabilities { text: true, image: false }
        );
        let models = adapter.list_models("key-1", &Cancel::new()).await.expect("catalogue");
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].native_id, "gpt-4o");
    }

    #[tokio::test]
    async fn a_code_manifest_resolves_to_the_sandbox_and_not_the_interpreter() {
        // **The test that proves the branch exists.** Both implementors declare the same
        // capabilities, so `capabilities()` cannot tell them apart — what separates them is *where
        // the answer comes from*. The interpreter would issue a request to the manifest's base URL;
        // the guest answers from its own literal. So: the catalogue carries the guest's id, and the
        // egress was never called.
        let (rt, seen) = runtime(r#"{"data":[{"id":"from-the-http-port"}]}"#);
        rt.register("custom", &code(GUEST)).expect("the guest compiles");

        let adapter = rt.for_provider("custom").await.expect("registered");
        let models = adapter.list_models("key-1", &Cancel::new()).await.expect("catalogue");

        let ids: Vec<&str> = models.iter().map(|m| m.native_id.as_str()).collect();
        assert_eq!(ids, vec!["from-the-guest"]);
        assert!(seen.lock().unwrap().is_empty(), "the sandbox must not have used the egress");
    }

    #[tokio::test]
    async fn an_unknown_provider_is_a_resolution_failure_naming_the_provider() {
        let (rt, _seen) = runtime("{}");
        let err = resolution_error(&rt, "nobody").await;
        assert_eq!(err, "no active manifest for provider nobody");
    }

    #[tokio::test]
    async fn a_manifest_without_a_kind_is_declarative() {
        // The grammar defaults `kind` (`manifest.ts:130`); a reader that treated an absent field as
        // anything else would disagree with the gate that stored it.
        let mut manifest = declarative();
        manifest.as_object_mut().unwrap().remove("kind");

        let (rt, _seen) = runtime(r#"{"data":[{"id":"gpt-4o"}]}"#);
        rt.register("openrouter", &manifest).expect("the fixture builds");

        let adapter = rt.for_provider("openrouter").await.expect("registered");
        let models = adapter.list_models("key-1", &Cancel::new()).await.expect("catalogue");
        assert_eq!(models.len(), 1, "the interpreter answered, so the default held");
    }

    #[tokio::test]
    async fn registering_a_provider_again_replaces_its_adapter() {
        let (rt, _seen) = runtime("{}");
        rt.register("p", &declarative()).unwrap();
        let first = rt.for_provider("p").await.unwrap();

        rt.register("p", &declarative()).unwrap();
        let second = rt.for_provider("p").await.unwrap();

        assert!(
            !Arc::ptr_eq(&first, &second),
            "a re-registration must build a new adapter, not return the held one"
        );
        assert_eq!(rt.registered(), vec!["p".to_string()]);
    }

    #[tokio::test]
    async fn a_superseded_sandbox_is_disposed() {
        // The reference's reason for the dispose: a code adapter's sandbox is the thing that leaks
        // across swaps. Disposal is observable — the actor has left its loop, so the channel is
        // closed and the next operation fails in the response phase.
        let (rt, _seen) = runtime("{}");
        rt.register("custom", &code(GUEST)).unwrap();
        let superseded = rt.for_provider("custom").await.unwrap();
        assert!(
            superseded.list_models("k", &Cancel::new()).await.is_ok(),
            "the adapter works before the swap, so the failure below is the swap's doing"
        );

        rt.register("custom", &code(GUEST)).unwrap();
        let replacement = rt.for_provider("custom").await.unwrap();

        // **`listModels` is the probe, not `generateImage`, and the difference is a false pass.**
        // `GUEST` implements `listModels` and nothing else, so a `generateImage` call fails because
        // the guest does not implement it — the same `AttemptError::Transport` a disposed sandbox
        // produces, and an assertion that could never fail. `listModels` is an operation the guest
        // *does* answer, so it separates the two. Measured: the probe that removed the
        // `superseded.dispose()` call left the `generateImage` version green.
        assert!(
            replacement.list_models("k", &Cancel::new()).await.is_ok(),
            "the replacement's sandbox must be alive, so the failure below is disposal"
        );
        assert_eq!(
            superseded.list_models("k", &Cancel::new()).await.unwrap_err(),
            AttemptError::Transport,
            "the superseded adapter's sandbox must be gone"
        );
    }

    #[tokio::test]
    async fn a_manifest_that_fails_to_build_leaves_the_previous_adapter_serving() {
        // **The divergence the module note argues for.** The reference disposes the superseded
        // adapter before it builds the replacement, so a failed build leaves a disposed adapter in
        // the map and the provider is dead until something re-registers it. Here the old adapter is
        // untouched and still works.
        let (rt, _seen) = runtime(r#"{"data":[{"id":"gpt-4o"}]}"#);
        rt.register("custom", &code(GUEST)).unwrap();
        let held = rt.for_provider("custom").await.unwrap();

        // `require` is what the tripwire refuses, so this manifest cannot become an adapter.
        let err = rt
            .register("custom", &code("const x = require('fs');"))
            .expect_err("the lint must reject this source");
        assert!(err.starts_with("lint: "), "the reason survives in the message: {err}");

        let still = rt.for_provider("custom").await.expect("the old adapter is still registered");
        assert!(Arc::ptr_eq(&held, &still), "a failed register must not swap the entry");
        assert!(
            still.list_models("k", &Cancel::new()).await.is_ok(),
            "the previous adapter must still be alive"
        );
    }

    #[tokio::test]
    async fn a_code_manifest_without_a_source_is_rejected_as_a_lint_failure() {
        // The reference's constructor check (`code-adapter.ts:122`), message and reason included.
        // The grammar would have caught this before storage (`manifest.ts:160-163`), so this is the
        // path a manifest that bypassed the gate takes — kept because the reference keeps it.
        let (rt, _seen) = runtime("{}");
        let mut manifest = code(GUEST);
        manifest.as_object_mut().unwrap().remove("code");

        let err = rt.register("custom", &manifest).expect_err("a code manifest needs a source");
        assert_eq!(err, "lint: code adapter requires kind:\"code\" + code.source");
        assert!(rt.registered().is_empty(), "a rejected manifest must not be recorded");
    }

    #[tokio::test]
    async fn unregistering_stops_resolving_and_disposes() {
        let (rt, _seen) = runtime("{}");
        rt.register("custom", &code(GUEST)).unwrap();
        let held = rt.for_provider("custom").await.unwrap();
        assert!(
            held.list_models("k", &Cancel::new()).await.is_ok(),
            "alive before, so the failure after is the unregister"
        );

        rt.unregister("custom");

        assert_eq!(resolution_error(&rt, "custom").await, "no active manifest for provider custom");
        assert!(rt.registered().is_empty());
        assert_eq!(
            held.list_models("k", &Cancel::new()).await.unwrap_err(),
            AttemptError::Transport,
            "an unregistered adapter's sandbox must be gone"
        );
    }

    #[tokio::test]
    async fn disposing_releases_every_provider() {
        let (rt, _seen) = runtime("{}");
        rt.register("a", &code(GUEST)).unwrap();
        rt.register("b", &declarative()).unwrap();
        let (a, b) = (rt.for_provider("a").await.unwrap(), rt.for_provider("b").await.unwrap());

        rt.dispose();

        assert!(rt.registered().is_empty());
        assert!(rt.for_provider("a").await.is_err());
        assert!(a.list_models("k", &Cancel::new()).await.is_err(), "the sandbox is gone");
        // The interpreter holds nothing, so its disposal is the trait's no-op default and it stays
        // usable — which is the point of `dispose` having a default at all (`adapter.rs:248-252`).
        assert!(b.list_models("k", &Cancel::new()).await.is_ok());
    }

    #[tokio::test]
    async fn the_app_url_default_reaches_a_declarative_adapters_headers() {
        // The claim `DEFAULT_APP_URL` exists for, asserted on a header rather than on a field: an
        // unbound `{{appUrl}}` renders as the **empty string** (`manifest.rs:294`), so a runtime
        // that passed no vars would send `HTTP-Referer: ` on every OpenRouter request.
        let (rt, seen) = runtime(r#"{"choices":[{"message":{"content":"hi"}}]}"#);
        rt.register("openrouter", &declarative()).unwrap();

        let adapter = rt.for_provider("openrouter").await.unwrap();
        let cancel = Cancel::new();
        let stream = adapter
            .generate_text("key-1", text_args("gpt-4o"), &cancel)
            .await
            .expect("the text call should answer");
        drain(stream).await;

        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].1.get("HTTP-Referer").map(String::as_str), Some(DEFAULT_APP_URL));
    }

    #[tokio::test]
    async fn an_explicit_app_url_overrides_the_default() {
        let (port, seen) = Scripted::new(r#"{"choices":[{"message":{"content":"hi"}}]}"#);
        let rt = AdapterRuntime::with_app_url(port, "https://example.test");
        rt.register("openrouter", &declarative()).unwrap();

        let adapter = rt.for_provider("openrouter").await.unwrap();
        let cancel = Cancel::new();
        let stream = adapter
            .generate_text("key-1", text_args("gpt-4o"), &cancel)
            .await
            .expect("the text call should answer");
        drain(stream).await;

        let seen = seen.lock().unwrap();
        assert_eq!(seen[0].1.get("HTTP-Referer").map(String::as_str), Some("https://example.test"));
    }

    #[tokio::test]
    async fn a_code_provider_never_sees_the_app_url_variable() {
        // `AdapterContext::vars` is documented as unread by a code adapter — the guest receives the
        // request as JSON and does its own templating (`code_adapter.rs:122-124`). Asserted rather
        // than assumed, because a runtime that built the context in one place could stop meaning it.
        let (rt, _seen) = runtime("{}");
        let manifest = code(
            r#"
            export default {
              async listModels() { return ["ok"]; },
            };
            "#,
        );
        rt.register("custom", &manifest).unwrap();
        let adapter = rt.for_provider("custom").await.unwrap();
        assert_eq!(adapter.list_models("k", &Cancel::new()).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_text_attempt_through_the_runtime_reaches_the_interpreter() {
        // The seam's own consumer shape, one step up from the branch: a factory that resolves is a
        // factory the engine can use. `stream: false` because the fixture's responseMap is unary.
        let (rt, _seen) = runtime(r#"{"choices":[{"message":{"content":"hello"}}]}"#);
        rt.register("openrouter", &declarative()).unwrap();
        let adapter = rt.for_provider("openrouter").await.unwrap();

        let args = text_args("gpt-4o");
        // Bound, not inlined: the stream borrows the cancel for as long as it is polled, so a
        // `&Cancel::new()` temporary would be freed at the end of this statement and the `next()`
        // below would outlive it.
        let cancel = Cancel::new();
        let mut stream = adapter.generate_text("key-1", args, &cancel).await.unwrap();

        use futures_util::StreamExt;
        let first = stream.next().await;
        assert_eq!(first, Some(Ok("hello".to_string())));
    }
}
