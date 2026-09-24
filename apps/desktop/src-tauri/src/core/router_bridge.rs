//! The driver: a Rust-native [`Bridge`] that answers gateway requests in this process.
//!
//! This is the port of `apps/desktop/src/gateway-bridge.ts` (421 lines), and it is the last piece
//! of Phase 5c. Everything it *decides* is already in [`crate::core::bridge_policy`]; what is left
//! here is the I/O that carries those decisions out — the tool loop, the spawned task, and the
//! writes to [`ReplyHandle`].
//!
//! # What this module does not own
//!
//! **The operator's settings and toggles are asked for, never held.** The reference reads
//! `get_tools_enabled` over an `invoke` on every request; a Rust bridge could instead keep its own
//! `AtomicBool`, and that copy would be the second spelling of state the core already holds — the
//! operator flips the switch, the core updates, and the bridge keeps serving the old answer with
//! nothing to report it. [`BridgeHost`] is the seam that prevents it: the bridge asks the host, and
//! the host is whatever the wiring points at the one owner.
//!
//! **The ledger sink is not here either.** [`CallOptions`] carries the *attribution* — `source` and
//! `app_key_id` — and the sink itself is installed on [`SharedRouterState`] by the launch. A bridge
//! that owned a sink would be a second place a ledger row can be written from.
//!
//! # One thing this driver needs that does not exist yet
//!
//! `RouterBridge` compiles and is tested here (26 tests, against a real `ModelRouter` and a real
//! `RouterStore` — the only double is the adapter), but **nothing installs it yet**. Three paths
//! the headless binary must walk were Tauri-shaped or Tauri-gated (drift register **D39**); this
//! is where each stands now.
//!
//! 1. **Hydration — closed in 25b.** `RouterStore::hydrate` is no longer test-only:
//!    `RouterStore::from_store` reads the four tables, and the readers that feed it
//!    (`providers_rows`, `api_keys_rows`, `models_cache_rows`, `aliases_rows`) are un-gated
//!    `&Store` functions, with the `#[tauri::command]` wrappers left behind as one-line delegates.
//! 2. **Streaming egress — closed in 25a.** `egress::stream` takes an `mpsc` sink rather than a
//!    `tauri::ipc::Channel`, so `egress.rs` carries no `cfg(feature = "app")` at all, and
//!    `core::egress_port::EgressPort` is the production `HttpPort` implementor. `generate_text`
//!    always streams (`router.rs:717`), so without it there is no text path at all.
//! 3. **The ledger row — still open, and 25d.** `persist::ledger_insert` already takes a plain
//!    `&Connection` and is nonetheless `#[cfg(feature = "app")]`. This one is durability rather
//!    than reachability: a router with no sink attached keeps the ledger in memory and raises no
//!    error, so the bridge can serve without it.
//!
//! So this module is deliberately written against seams — `Arc<RouterStore>`,
//! `Arc<dyn AdapterFactory>`, `Arc<dyn BridgeHost>` — which is what lets it be tested now with the
//! doubles the crate already has, and what fixes the interface the remaining gap must satisfy. See
//! the module's own test section for what "tested" means here: every path below runs against a real
//! `ModelRouter`, not a mock of it. What still stands between this and a launch is 25c (the
//! manifest activation path) and 25e (the install itself) — including a source for
//! [`BridgeHost::settings`], which 25b supplied as `RouterSettings::from_store`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tokio::runtime::Handle;

use crate::core::adapter::{AdapterFactory, Cancel, ToolCall};
use crate::core::assistant_stream::{parse_assistant_stream, Segment, ToolSegment};
use crate::core::bridge_policy::{
    decide_tool_ownership, decide_turn, gateway_status, gateway_status_for_attempts,
    push_tool_call, retry_after_hint, tool_choice_for, BridgeKind, ProseGate, ToolOwnership,
    TurnOutcome, MAX_TOOL_ITERATIONS,
};
use crate::core::engine::TextFailure;
use crate::core::gateway::{
    gateway_tool_refusal, Beat, Bridge, BridgeMsg, BridgeRequest, ReplyHandle,
};
use crate::core::gateway_normalizer::{detect_client, normalize_gateway_request, NormalizeOptions};
use crate::core::router::{
    CallOptions, ImageRequest, ModelRouter, RouterError, RouterSettings, RouterStore,
};
use crate::core::tool_registry::{agent_tools, registry_to_openai};
use crate::core::tool_wire::to_wire_tool_calls;
use crate::core::tools::{tool_run, ToolRunRequest};

/// The ledger source every row this bridge writes is attributed to. The reference passes the same
/// literal (`gateway-bridge.ts:309`), and it is what makes a gateway request distinguishable from
/// a UI one in the ledger rather than merely countable.
const LEDGER_SOURCE: &str = "gateway";

/// What the bridge must ask its host, rather than keep a second copy of.
///
/// Four questions, all of them facts the core already owns. This is a trait rather than a struct of
/// `Arc`s because the answers have four different shapes and only the host knows how to read them
/// — and because the *wiring* is then free to point at the core's own accessors without the bridge
/// ever naming `GatewayCore`.
///
/// **It cannot be `GatewayCore` itself.** The core owns the bridge (`Arc<dyn Bridge>`), so a bridge
/// holding the core would close the reference cycle [`ReplyHandle`] exists to avoid — the same
/// constraint `Beat`'s note records one layer out. The host must be a narrow handle over the values,
/// not the whole core.
pub trait BridgeHost: Send + Sync {
    /// The router settings to serve this request with, read per request rather than captured, so a
    /// cap the operator changes reaches the next request instead of the next launch.
    fn settings(&self) -> RouterSettings;

    /// Whether the operator has turned gateway-supplied tools on.
    fn tools_enabled(&self) -> bool;

    /// Whether gateway-side tools may mutate the workspace (audit H1b). Separate from
    /// [`BridgeHost::tools_enabled`] and off by default — see `MUTATING_TOOLS`.
    fn tools_mutation_enabled(&self) -> bool;

    /// The workspace root tool calls execute against, or `None` when it has not been set yet.
    ///
    /// `None` is not "the current directory": a `run_command` against an unset root is refused by
    /// the host (`tools::tools_check_root`), which is the honest answer for a gateway that has
    /// never been told where it may write.
    fn workspace_root(&self) -> Option<String>;
}

/// A Rust-native bridge: one `ModelRouter` per request over one shared state.
///
/// **The router is built per request and the state is not.** `ModelRouter` needs `&mut self` to
/// serve (`router.rs:646`), so two requests cannot share one — but they *must* share the breaker,
/// the cursors, the ledger and the limiter, or each request would cool a private copy of a key and
/// start on key zero. [`SharedRouterState`](crate::core::router::SharedRouterState) is the split
/// that makes both true at once, and `with_shared` is how it is handed over. Cloning it copies no
/// state: three of its four fields are `Arc`s and the fourth is documented as sharing one budget
/// across its clones.
pub struct RouterBridge {
    store: Arc<RouterStore>,
    adapters: Arc<dyn AdapterFactory>,
    shared: crate::core::router::SharedRouterState,
    host: Arc<dyn BridgeHost>,
    /// Where a spawned request runs. Held rather than discovered, because [`Bridge::dispatch`] is
    /// synchronous and may be called from a thread that is not inside a runtime.
    handle: Handle,
    /// In-flight requests, so [`Bridge::cancel`] has something to raise a flag on. Removed by the
    /// task that owns the entry, on every exit it can reach.
    active: Arc<Mutex<HashMap<u64, Cancel>>>,
}

impl RouterBridge {
    pub fn new(
        store: Arc<RouterStore>,
        adapters: Arc<dyn AdapterFactory>,
        shared: crate::core::router::SharedRouterState,
        host: Arc<dyn BridgeHost>,
        handle: Handle,
    ) -> Self {
        Self { store, adapters, shared, host, handle, active: Arc::new(Mutex::new(HashMap::new())) }
    }

    /// Everything one request needs, cloned out of `self` so the task can outlive the dispatch.
    ///
    /// `active` is deliberately **not** here: the registry entry is inserted by `dispatch` and
    /// removed by the task it spawns, and neither of those is the request's own work. A `Job` that
    /// carried it would be a third place that could remove an entry.
    fn job(&self) -> Job {
        Job {
            store: self.store.clone(),
            adapters: self.adapters.clone(),
            shared: self.shared.clone(),
            host: self.host.clone(),
        }
    }
}

/// The owned half of a request: what a spawned task holds instead of `&RouterBridge`.
struct Job {
    store: Arc<RouterStore>,
    adapters: Arc<dyn AdapterFactory>,
    shared: crate::core::router::SharedRouterState,
    host: Arc<dyn BridgeHost>,
}

impl Job {
    /// A router for exactly this request: the shared state, and this request's settings snapshot.
    fn router(&self) -> ModelRouter<'_> {
        ModelRouter::new(&self.store, self.adapters.as_ref())
            .with_shared(self.shared.clone())
            .with_settings(self.host.settings())
    }
}

impl Bridge for RouterBridge {
    /// Spawn the request and return. `dispatch` is synchronous by contract, and the loop it starts
    /// is not — so the spawn is the whole of this method's work.
    ///
    /// The task is `spawn`ed rather than awaited because the core's HTTP handler is waiting on the
    /// [`ReplyHandle`] channel, not on this call: returning here is what lets the handler keep
    /// polling for messages and lets two requests be in flight at once.
    fn dispatch(&self, req: BridgeRequest, replies: ReplyHandle) {
        let job = self.job();
        let cancel = Cancel::new();
        self.active.lock().unwrap().insert(req.request_id, cancel.clone());
        let active = self.active.clone();
        self.handle.spawn(async move {
            let id = req.request_id;
            job.serve(req, replies, cancel).await;
            active.lock().unwrap().remove(&id);
        });
    }

    fn cancel(&self, request_id: u64) {
        // Removed rather than merely raised: a request can only be cancelled once, and leaving the
        // entry would grow the map for the life of the process on every cancelled request.
        if let Some(cancel) = self.active.lock().unwrap().remove(&request_id) {
            cancel.cancel();
        }
    }

    /// Always ready, because this bridge runs in this process.
    ///
    /// The opposite of [`crate::core::gateway::webview_ready`], and deliberately so: a webview can
    /// be suspended by the OS, so its readiness is a question about a heartbeat. Nothing suspends a
    /// task in this process, so the question does not arise — which is exactly why `Bridge::ready`
    /// has no default body and each implementation has to say which kind it is (D35).
    fn ready(&self, _beat: Beat) -> bool {
        true
    }
}

impl Job {
    /// Route one request to the loop that answers it, and answer a failure the same way wherever it
    /// came from.
    async fn serve(&self, req: BridgeRequest, replies: ReplyHandle, cancel: Cancel) {
        let id = req.request_id;
        let Some(kind) = BridgeKind::parse(req.kind) else {
            // A silent fallback to `chat` would run a tool loop over a body shaped for something
            // else. The reference answers this branch the same way.
            let _ = replies.reply(
                id,
                BridgeMsg::Error {
                    status: 400,
                    message: format!("unknown bridge kind {}", req.kind),
                    retry_after_ms: None,
                },
            );
            return;
        };

        let outcome = match kind {
            BridgeKind::Chat | BridgeKind::Responses => {
                self.serve_text(&req, &replies, &cancel).await
            }
            BridgeKind::Models => self.serve_models(&req, &replies).await,
            BridgeKind::Image => self.serve_image(&req, &replies, &cancel).await,
        };

        if let Err(err) = outcome {
            // A cancelled request is not a failure to report. The reference returns from the
            // generator and the client sees an empty stream, which is the honest answer: nobody is
            // listening to a status code they asked us to stop producing.
            if cancel.is_cancelled() {
                return;
            }
            let _ = replies.reply(
                id,
                BridgeMsg::Error {
                    status: failure_status(&err),
                    message: err.message(),
                    retry_after_ms: failure_retry_hint(&err),
                },
            );
        }
    }

    /// The tool loop. The port of the reference's `chat`/`responses` branch.
    async fn serve_text(
        &self,
        req: &BridgeRequest,
        replies: &ReplyHandle,
        cancel: &Cancel,
    ) -> Result<(), RouterError> {
        let id = req.request_id;
        let hint = detect_client(&req.headers);
        let normalized = normalize_gateway_request(
            &req.body,
            &NormalizeOptions { client_hint: Some(hint), ..NormalizeOptions::default() },
        );
        let body = &normalized.body;

        let model = body.get("model").and_then(Value::as_str).unwrap_or("").to_string();
        let mut messages: Vec<Value> =
            body.get("messages").and_then(Value::as_array).cloned().unwrap_or_default();
        let max_tokens = body.get("max_tokens").and_then(Value::as_u64);
        let temperature = body.get("temperature").and_then(Value::as_f64);
        let response_format = body.get("response_format").cloned();

        // `length > 0`, so `[]` behaves as absent rather than as "the client wants no tools".
        let client_tools = body
            .get("tools")
            .and_then(Value::as_array)
            .filter(|t| !t.is_empty())
            .map(|_| body.get("tools").cloned().unwrap_or(Value::Null));
        let ownership = decide_tool_ownership(
            client_tools.as_ref().map_or(0, |t| t.as_array().map_or(0, Vec::len)),
            self.host.tools_enabled(),
        );
        let tools = match ownership {
            ToolOwnership::Gateway => registry_to_openai(agent_tools()),
            _ => client_tools,
        };
        let tool_choice = tool_choice_for(ownership, body.get("tool_choice").cloned());

        let opts = CallOptions {
            source: Some(LEDGER_SOURCE.to_string()),
            app_key_id: req.app_key_id.clone(),
        };
        let mut gate = ProseGate::new(ownership);

        for _turn in 1..=MAX_TOOL_ITERATIONS {
            if cancel.is_cancelled() {
                return Ok(());
            }
            // A turn that ends up calling tools has nothing to show the client, so whatever it
            // said goes no further: starting a new turn *discards* the previous preamble.
            gate.discard();

            let mut collected: Vec<ToolCall> = Vec::new();
            let mut mercury: Vec<ToolCall> = Vec::new();
            let mut turn_text = String::new();

            let result = {
                let mut on_chunk = |chunk: &str| {
                    // One parse, both halves. The reference parses the chunk twice — once to build
                    // `visible` and once inside `emitProse` — and the second parse is pure waste.
                    let mut visible = String::new();
                    for segment in parse_assistant_stream(chunk) {
                        match segment {
                            Segment::Text(t) => visible.push_str(&t.text),
                            Segment::Tool(t) => {
                                if t.complete {
                                    mercury.push(mercury_call(&t));
                                }
                            }
                        }
                    }
                    if visible.is_empty() {
                        return;
                    }
                    turn_text.push_str(&visible);
                    if let Some(text) = gate.offer(&visible) {
                        // Emitting is also the liveness check. `reply` answers `false` when nobody
                        // is listening any more, and aborting here is what stops us paying for
                        // tokens no one will read.
                        if !replies.reply(id, BridgeMsg::Delta(text)) {
                            cancel.cancel();
                        }
                    }
                };
                let mut on_tool_call = |call: ToolCall| push_tool_call(&mut collected, call);
                let mut on_usage = |usage: crate::core::usage::UsageTokens| {
                    let _ = replies.reply(
                        id,
                        BridgeMsg::Usage {
                            prompt_tokens: usage.prompt_tokens,
                            completion_tokens: usage.completion_tokens,
                        },
                    );
                };

                let text_req = crate::core::router::TextRequest {
                    model: model.clone(),
                    // Cloned per turn: `TextRequest` owns its messages and `generate_text` consumes
                    // them, where the reference hands the same array to every turn and mutates it in
                    // place. The divergence costs a deep copy of the conversation per turn and buys
                    // a `generate_text` that cannot mutate its caller's history.
                    messages: messages.clone(),
                    max_tokens,
                    temperature,
                    tools: tools.clone(),
                    tool_choice: tool_choice.clone(),
                    response_format: response_format.clone(),
                    on_tool_call: Some(&mut on_tool_call),
                    on_usage: Some(&mut on_usage),
                    max_attempts: None,
                };
                self.router().generate_text(text_req, &opts, cancel, &mut on_chunk).await
            };

            if cancel.is_cancelled() {
                return Ok(());
            }

            match result {
                Ok(_) => {}
                // Cancellation is not a failure to report — the client asked us to stop, so there
                // is nobody left to read a status code.
                Err(RouterError::Text(failure))
                    if matches!(failure.as_ref(), TextFailure::Cancelled { .. }) =>
                {
                    return Ok(())
                }
                Err(err) => return Err(err),
            }

            match decide_turn(mercury.len(), collected.len(), ownership) {
                // No calls at all: the model answered and the turn is over. This is the only text
                // the client sees in gateway mode, so it is released before the request finishes.
                TurnOutcome::Finish => {
                    if let Some(text) = gate.release() {
                        let _ = replies.reply(id, BridgeMsg::Delta(text));
                    }
                    let _ = replies.reply(id, BridgeMsg::Done);
                    return Ok(());
                }
                // Pass-through: the client declared these and will run them. Handing them over and
                // ending is the whole contract — running them here would write the same file twice.
                TurnOutcome::PassThrough => {
                    let wire = to_wire_tool_calls(&collected);
                    let calls = Value::Array(wire.wire.iter().map(|c| c.to_json()).collect());
                    let _ = replies.reply(id, BridgeMsg::ToolCalls(calls));
                    let _ = replies.reply(id, BridgeMsg::Done);
                    return Ok(());
                }
                // Ours whoever declared the real tools: an inline marker is not part of any client
                // tool contract, so it always runs here and never reaches the client.
                TurnOutcome::SandboxMercury => {
                    self.sandbox_turn(&mut messages, &turn_text, &mercury, cancel).await;
                }
                TurnOutcome::SandboxCollected => {
                    self.sandbox_turn(&mut messages, &turn_text, &collected, cancel).await;
                }
            }
        }

        // The ceiling was reached. The last turn is released rather than dropped: a client that
        // receives nothing at all cannot tell "gave up" from "broke".
        if let Some(text) = gate.release() {
            let _ = replies.reply(id, BridgeMsg::Delta(text));
        }
        let _ = replies.reply(id, BridgeMsg::Done);
        Ok(())
    }

    /// Run `calls` in the sandbox and leave the model a turn it can accept.
    ///
    /// Two messages, in this order: the assistant turn that requested the calls, then one result
    /// per call. Providers reject a `tool` message that does not answer a preceding `tool_calls`
    /// turn, which is why this is one function rather than two call sites.
    ///
    /// **One decision builds both halves.** The ids the assistant turn declares and the ids the
    /// results name come from the same `to_wire_tool_calls` call, so they cannot drift — the
    /// reference's `sandboxTurn` makes the same argument for the same reason.
    async fn sandbox_turn(
        &self,
        messages: &mut Vec<Value>,
        turn_text: &str,
        calls: &[ToolCall],
        cancel: &Cancel,
    ) {
        let wire = to_wire_tool_calls(calls);
        messages.push(json!({
            "role": "assistant",
            "content": turn_text,
            "tool_calls": wire.wire.iter().map(|c| c.to_json()).collect::<Vec<Value>>(),
        }));

        let root = self.host.workspace_root();
        for (index, call) in calls.iter().enumerate() {
            if cancel.is_cancelled() {
                return;
            }
            let name = call.name.clone().unwrap_or_default();
            let result_text = match gateway_tool_refusal(&name, self.host.tools_mutation_enabled())
            {
                // The refusal is the tool's *result*, not a bridge failure: the model reads it and
                // can choose another way. Sending an error would end the request instead.
                Some(reason) => reason,
                None => self.run_tool(&name, call.arguments.as_deref(), root.as_deref()).await,
            };
            messages.push(json!({
                "role": "tool",
                "content": result_text,
                "tool_call_id": wire.ids[index],
            }));
        }
    }

    /// One tool call, off the async executor.
    ///
    /// `tool_run` is synchronous and spawns subprocesses (`run_command`), so calling it directly
    /// would block whichever worker thread is driving this request — and with `MAX_TOOL_ITERATIONS`
    /// turns of several calls each, that is a stall other requests pay for. `spawn_blocking` moves
    /// it to the blocking pool, which is what that pool is for.
    async fn run_tool(&self, name: &str, arguments: Option<&str>, root: Option<&str>) -> String {
        // The reference's own parsing, including its fallback: a body that is not JSON is passed
        // through as the raw string rather than discarded, so the tool can report what it got.
        let args = match arguments {
            Some(raw) if !raw.is_empty() => {
                serde_json::from_str(raw).unwrap_or_else(|_| Value::String(raw.to_string()))
            }
            _ => json!({}),
        };
        let request = ToolRunRequest {
            name: name.to_string(),
            arguments: args,
            root: root.unwrap_or_default().to_string(),
        };
        match tokio::task::spawn_blocking(move || tool_run(request)).await {
            Ok(result) if result.ok => result.output,
            Ok(result) => result.error.unwrap_or_else(|| "tool execution failed".to_string()),
            Err(join) => format!("Tool execution error: {join}"),
        }
    }

    /// The `models` branch: one call, one result, no loop.
    async fn serve_models(
        &self,
        req: &BridgeRequest,
        replies: &ReplyHandle,
    ) -> Result<(), RouterError> {
        let rows = self.router().list_models(None);
        let data: Vec<Value> = rows
            .iter()
            .map(|m| json!({ "id": m.id, "object": "model", "owned_by": m.provider_id }))
            .collect();
        let _ = replies.reply(
            req.request_id,
            BridgeMsg::Result(json!({
                "object": "list",
                "data": data,
            })),
        );
        let _ = replies.reply(req.request_id, BridgeMsg::Done);
        Ok(())
    }

    /// The `image` branch: one call, one result, no loop.
    async fn serve_image(
        &self,
        req: &BridgeRequest,
        replies: &ReplyHandle,
        cancel: &Cancel,
    ) -> Result<(), RouterError> {
        let image = ImageRequest {
            model: req.body.get("model").and_then(Value::as_str).unwrap_or("").to_string(),
            prompt: req.body.get("prompt").and_then(Value::as_str).unwrap_or("").to_string(),
        };
        let opts = CallOptions {
            source: Some(LEDGER_SOURCE.to_string()),
            app_key_id: req.app_key_id.clone(),
        };
        let result = self.router().generate_image(&image, &opts, cancel).await?;
        // `url` wins when the provider gave one; otherwise the inline bytes. The reference writes
        // the same choice as a conditional spread, and `base64` is `""` rather than absent so a
        // client that reads `b64_json` unconditionally gets an empty image instead of `undefined`.
        let entry = match result.url {
            Some(url) => json!({ "url": url }),
            None => json!({ "b64_json": result.base64.unwrap_or_default() }),
        };
        let _ = replies.reply(
            req.request_id,
            BridgeMsg::Result(json!({
                "created": unix_seconds(),
                "data": [entry],
            })),
        );
        let _ = replies.reply(req.request_id, BridgeMsg::Done);
        Ok(())
    }
}

/// The `{id, name, arguments}` a Mercury inline marker becomes.
///
/// **No id is invented here.** `to_wire_tool_calls` synthesises one for a call the provider did not
/// identify, and that is the single place the rule lives — the reference generates a random id at
/// this site (`crypto.randomUUID().slice(0, 8)`), which would be a second answer to "what is this
/// call called" sitting next to the one `tool_wire` already gives.
fn mercury_call(segment: &ToolSegment) -> ToolCall {
    ToolCall {
        id: None,
        name: segment.name.clone(),
        // `JSON.stringify(params)` over a `Record<string, string>`, which is what the segment's
        // `BTreeMap<String, String>` is.
        arguments: serde_json::to_string(&segment.params).ok(),
        raw: Some(Value::String(segment.raw.clone())),
    }
}

/// The HTTP status to report for a failure that reached the bridge.
///
/// **Every arm is a different fact about who caused the failure**, which is why this is a function
/// with a name rather than a match inside the error handler:
///
/// - `NoRoute` carries no attempt, so the message heuristic is all there is (`gateway_status`).
/// - A spent budget carries the chain, and the **last** attempt decides — see
///   [`gateway_status_for_attempts`].
/// - A mid-stream break carries the attempts that failed *before* the one that started streaming.
/// - `SystemAiUnavailable` is `500`, and deliberately **not** `NoRoute`: the source throws a plain
///   `Error` whose text does not contain the phrase `gateway_status` maps to `404`, so folding the
///   two together would quietly change the status a client sees.
/// - `Ledger` is `502`: the request produced its answer and the *record* failed. From the client's
///   side that is a gateway failure, and it is not something a retry of the request would fix.
fn failure_status(err: &RouterError) -> u16 {
    match err {
        RouterError::NoRoute { .. } => gateway_status(None, &err.message()),
        RouterError::Text(failure) => match failure.as_ref() {
            TextFailure::AllAttemptsFailed { error, .. } => {
                gateway_status_for_attempts(&error.chain, &err.message())
            }
            TextFailure::MidStream { attempts, .. } => {
                gateway_status_for_attempts(attempts, &err.message())
            }
            // Unreachable in practice — `serve_text` returns `Ok` for this variant — but a status
            // has to be *something*, and `502` is the honest "we do not know".
            TextFailure::Cancelled { .. } => 502,
        },
        RouterError::Image(failure) => gateway_status_for_attempts(&failure.chain, &err.message()),
        RouterError::SystemAiUnavailable => 500,
        RouterError::Ledger(_) => 502,
    }
}

/// The `Retry-After` hint for a failure, or `None` to omit the header.
///
/// The **shortest** wait across the failed attempts, not the longest: the planner drops cooled keys
/// rather than deprioritising them, so the earliest a retry can be served is when the first of them
/// frees. [`retry_after_hint`] already owns that decision and the "unnamed wait is an absent field,
/// not a zero" rule beside it.
fn failure_retry_hint(err: &RouterError) -> Option<u64> {
    match err {
        RouterError::Text(failure) => match failure.as_ref() {
            TextFailure::AllAttemptsFailed { error, .. } => retry_after_hint(&error.chain),
            TextFailure::MidStream { attempts, .. } => retry_after_hint(attempts),
            TextFailure::Cancelled { .. } => None,
        },
        RouterError::Image(failure) => retry_after_hint(&failure.chain),
        _ => None,
    }
}

/// `Math.floor(Date.now() / 1000)` — the `created` field every OpenAI-shaped response carries.
fn unix_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::time::Duration;

    use futures_util::future::{self, BoxFuture};
    use futures_util::stream::{self, BoxStream};
    use futures_util::StreamExt;

    use crate::core::adapter::{
        AdapterInstance, Capabilities, ImageArgs, ImageReply, ModelEntry, PingResult, TextArgs,
    };
    use crate::core::engine::{
        AllAttemptsFailed, AttemptError, AttemptLabel, AttemptOutcome, ErrorClass, FailureKind,
    };
    use crate::core::persist::{ApiKeyRow, ModelRow, ProviderRow};
    use crate::core::planner::Candidate;
    use crate::core::router::{SharedRouterState, IMAGE, TEXT};
    use crate::core::usage::UsageTokens;

    use super::*;

    // ---------- fixtures ----------

    fn provider(id: &str, slug: &str) -> ProviderRow {
        ProviderRow {
            id: id.to_string(),
            slug: slug.to_string(),
            name: slug.to_string(),
            r#type: None,
            base_url: "https://example.invalid".to_string(),
            status: "enabled".to_string(),
            rotation_strategy: "priority".to_string(),
            created_at: 0,
            updated_at: 0,
        }
    }

    fn key(id: &str, provider_id: &str) -> ApiKeyRow {
        ApiKeyRow {
            id: id.to_string(),
            provider_id: provider_id.to_string(),
            label: id.to_string(),
            secret_ref: format!("key:{id}"),
            secret_hint: None,
            status: "active".to_string(),
            priority: 0,
            cooldown_until: None,
            added_at: 0,
            last_used_at: None,
            last_tested_at: None,
        }
    }

    fn model(provider_id: &str, native_id: &str, modality: &str) -> ModelRow {
        ModelRow {
            provider_id: provider_id.to_string(),
            native_id: native_id.to_string(),
            modality: modality.to_string(),
            context_window: None,
            fetched_at: 0,
            pricing_json: None,
            capabilities_json: None,
        }
    }

    /// One provider (`p1`/`p1`) with one enabled key and one text model — the smallest store a plan
    /// can be built from, so a test that needs an image model says so by adding one.
    fn store() -> RouterStore {
        RouterStore::hydrate(
            vec![provider("p1", "p1")],
            vec![key("k1", "p1")],
            vec![model("p1", "m1", TEXT)],
            vec![],
        )
    }

    /// The same store plus an image model, for the `image` branch.
    fn image_store() -> RouterStore {
        RouterStore::hydrate(
            vec![provider("p1", "p1")],
            vec![key("k1", "p1")],
            vec![model("p1", "m1", TEXT), model("p1", "img1", IMAGE)],
            vec![],
        )
    }

    /// The serving candidate a `TextFailure::MidStream` carries. Built from the same three rows the
    /// store holds, so a test that changes the store and not this cannot go green by accident.
    fn candidate() -> Candidate {
        Candidate {
            provider: provider("p1", "p1"),
            key: key("k1", "p1"),
            model: model("p1", "m1", TEXT),
        }
    }

    fn attempt(status: u16, retry_after_ms: Option<u64>) -> AttemptOutcome {
        AttemptOutcome {
            cls: if status == 429 { ErrorClass::RateLimited } else { ErrorClass::Network },
            status,
            retry_after_ms,
            label: Some(AttemptLabel { provider_slug: "p1".into(), key_label: "k1".into() }),
        }
    }

    /// A text request that spent its budget.
    fn spent(chain: Vec<AttemptOutcome>) -> RouterError {
        RouterError::Text(Box::new(TextFailure::AllAttemptsFailed {
            error: AllAttemptsFailed::new("m1", chain),
            usage: None,
        }))
    }

    /// An OpenAI-shaped tool as a client would declare it.
    fn client_tool(name: &str) -> Value {
        json!({
            "type": "function",
            "function": {
                "name": name,
                "description": "a tool the client runs itself",
                "parameters": { "type": "object", "properties": { "x": { "type": "integer" } } },
            },
        })
    }

    /// A tool call the provider reported through `on_tool_call`.
    fn call(id: &str, name: &str) -> ToolCall {
        ToolCall {
            id: Some(id.to_string()),
            name: Some(name.to_string()),
            arguments: Some(r#"{"x":1}"#.to_string()),
            raw: None,
        }
    }

    // ---------- the adapter double ----------

    /// One scripted model turn.
    ///
    /// **`then_error` is what makes a mid-stream break expressible.** The adapter yields its chunks
    /// and *then* yields an error item, which is the only way a break can arrive after the consumer
    /// already holds text — and the reason such a break can never be retried.
    struct ScriptedTurn {
        chunks: Vec<String>,
        /// `Some` makes the **response** phase fail, before any chunk is produced.
        refusal: Option<AttemptError>,
        /// `Some` makes the **stream** phase fail, after the chunks.
        then_error: Option<AttemptError>,
        tool_calls: Vec<ToolCall>,
        usage: Option<UsageTokens>,
    }

    impl ScriptedTurn {
        fn saying(chunks: &[&str]) -> Self {
            Self {
                chunks: chunks.iter().map(|c| (*c).to_string()).collect(),
                refusal: None,
                then_error: None,
                tool_calls: Vec::new(),
                usage: None,
            }
        }

        fn refusing(err: AttemptError) -> Self {
            Self {
                chunks: Vec::new(),
                refusal: Some(err),
                then_error: None,
                tool_calls: Vec::new(),
                usage: None,
            }
        }

        fn then_breaking(mut self, err: AttemptError) -> Self {
            self.then_error = Some(err);
            self
        }

        fn calling(mut self, calls: Vec<ToolCall>) -> Self {
            self.tool_calls = calls;
            self
        }

        fn reporting(mut self, usage: UsageTokens) -> Self {
            self.usage = Some(usage);
            self
        }
    }

    /// An adapter whose turns are scripted, one per `generate_text` call, plus a queue for images.
    ///
    /// **It fires the callbacks at exhaustion, not while the future resolves**, which is what a real
    /// adapter does (`manifest-interpreter.ts:424`, `:430`) and the axis `core::adapter`'s own double
    /// was burned by: a double that fired early would go green here and fail against every real
    /// adapter. The terminal item the `chain` appends is filtered out, so no phantom chunk reaches
    /// the router's own chunk counter — that counter is what decides between an ok row and
    /// `PARSE_ERROR`, and an empty chunk would move it.
    struct Scripted {
        turns: Mutex<VecDeque<ScriptedTurn>>,
        images: Mutex<VecDeque<Result<ImageReply, AttemptError>>>,
        /// Every `generate_text` call, in order. **The count is load-bearing**: it is how a test
        /// tells "the call was handed to the client" from "the bridge ran it and asked for another
        /// turn" — running a tool costs a second turn, and a second turn is not scripted.
        text_calls: Mutex<usize>,
        /// The `tools` array the adapter was handed, per call — so a test asserts what the bridge
        /// actually put on the wire rather than what it meant to.
        seen_tools: Mutex<Vec<Option<Value>>>,
        /// The `messages` array the adapter was handed, per call. The sandbox's own output is only
        /// visible from here: a tool result reaches the model, never the client.
        seen_messages: Mutex<Vec<Vec<Value>>>,
    }

    impl Scripted {
        fn text(turns: Vec<ScriptedTurn>) -> Arc<Self> {
            Arc::new(Self {
                turns: Mutex::new(turns.into()),
                images: Mutex::new(VecDeque::new()),
                text_calls: Mutex::new(0),
                seen_tools: Mutex::new(Vec::new()),
                seen_messages: Mutex::new(Vec::new()),
            })
        }

        fn images(replies: Vec<Result<ImageReply, AttemptError>>) -> Arc<Self> {
            Arc::new(Self {
                turns: Mutex::new(VecDeque::new()),
                images: Mutex::new(replies.into()),
                text_calls: Mutex::new(0),
                seen_tools: Mutex::new(Vec::new()),
                seen_messages: Mutex::new(Vec::new()),
            })
        }

        fn text_calls(&self) -> usize {
            *self.text_calls.lock().unwrap()
        }

        fn tools_seen(&self, nth: usize) -> Option<Value> {
            self.seen_tools.lock().unwrap().get(nth).cloned().flatten()
        }

        fn messages_seen(&self, nth: usize) -> Vec<Value> {
            self.seen_messages.lock().unwrap().get(nth).cloned().unwrap_or_default()
        }
    }

    impl AdapterInstance for Scripted {
        fn generate_image<'a>(
            &'a self,
            _secret_ref: &'a str,
            _args: ImageArgs,
            _cancel: &'a Cancel,
        ) -> BoxFuture<'a, Result<ImageReply, AttemptError>> {
            let next = self.images.lock().unwrap().pop_front();
            Box::pin(async move { next.unwrap_or(Err(AttemptError::Transport)) })
        }

        fn generate_text<'a>(
            &'a self,
            _secret_ref: &'a str,
            mut args: TextArgs<'a>,
            _cancel: &'a Cancel,
        ) -> BoxFuture<'a, Result<BoxStream<'a, Result<String, AttemptError>>, AttemptError>>
        {
            *self.text_calls.lock().unwrap() += 1;
            self.seen_tools.lock().unwrap().push(args.tools.cloned());
            self.seen_messages.lock().unwrap().push(args.messages.to_vec());

            // Taken here, fired at exhaustion. They cannot ride the chunk stream — it is strings
            // only — and they cannot be derived from the text, which is empty on a tool-call turn.
            let on_tool_call = args.on_tool_call.take();
            let on_usage = args.on_usage.take();
            let next = self.turns.lock().unwrap().pop_front();

            Box::pin(async move {
                // Nothing scripted: a transport failure, which is what a real adapter reports when
                // it cannot reach the provider. A test that under-scripts its turns sees the
                // request fail rather than silently finishing.
                let Some(turn) = next else { return Err(AttemptError::Transport) };
                let ScriptedTurn { chunks, refusal, then_error, tool_calls, usage } = turn;
                if let Some(err) = refusal {
                    return Err(err);
                }

                let mut on_tool_call = on_tool_call;
                let mut on_usage = on_usage;
                let body = stream::iter(chunks.into_iter().map(Ok::<String, AttemptError>));
                let tail = stream::once(async move {
                    if let Some(cb) = on_tool_call.as_deref_mut() {
                        for call in tool_calls {
                            cb(call);
                        }
                    }
                    if let (Some(cb), Some(u)) = (on_usage.as_deref_mut(), usage) {
                        cb(u);
                    }
                    match then_error {
                        Some(err) => Err(err),
                        None => Ok(String::new()),
                    }
                });

                let out: BoxStream<'a, Result<String, AttemptError>> = Box::pin(
                    body.chain(tail).filter(|c| future::ready(!matches!(c, Ok(s) if s.is_empty()))),
                );
                Ok(out)
            })
        }

        fn capabilities(&self) -> Capabilities {
            Capabilities { text: true, image: true }
        }

        fn tag_modality(&self, _entry: &ModelEntry) -> &'static str {
            TEXT
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

    /// One adapter for every provider. The routing decisions under test are about *who declared the
    /// tools*, not about which provider served.
    struct Factory(Arc<Scripted>);

    impl AdapterFactory for Factory {
        fn for_provider<'a>(
            &'a self,
            _provider_id: &'a str,
        ) -> BoxFuture<'a, Result<Arc<dyn AdapterInstance>, String>> {
            let adapter = Arc::clone(&self.0);
            Box::pin(async move { Ok(adapter as Arc<dyn AdapterInstance>) })
        }
    }

    /// The four answers [`BridgeHost`] owes, as fields a test can set.
    struct Host {
        tools_enabled: bool,
        mutation_enabled: bool,
        root: Option<String>,
    }

    impl Host {
        fn off() -> Self {
            Self { tools_enabled: false, mutation_enabled: false, root: None }
        }

        fn gateway_tools() -> Self {
            Self { tools_enabled: true, ..Self::off() }
        }
    }

    impl BridgeHost for Host {
        fn settings(&self) -> RouterSettings {
            RouterSettings::default()
        }

        fn tools_enabled(&self) -> bool {
            self.tools_enabled
        }

        fn tools_mutation_enabled(&self) -> bool {
            self.mutation_enabled
        }

        fn workspace_root(&self) -> Option<String> {
            self.root.clone()
        }
    }

    // ---------- driving the bridge ----------

    fn bridge(store: RouterStore, adapter: Arc<Scripted>, host: Host) -> RouterBridge {
        RouterBridge::new(
            Arc::new(store),
            Arc::new(Factory(adapter)),
            SharedRouterState::new(),
            Arc::new(host),
            Handle::current(),
        )
    }

    fn bridge_with(adapter: Arc<Scripted>, host: Host) -> RouterBridge {
        bridge(store(), adapter, host)
    }

    /// Dispatch one request and drain everything the bridge writes back.
    ///
    /// **It fails on silence rather than hanging.** A bridge that never answers is exactly the D35
    /// failure — a request that waits out its timeout and returns a generic `503` — and a test that
    /// blocked on `recv()` would report that as a stuck suite rather than as a broken bridge.
    async fn drain(bridge: &RouterBridge, req: BridgeRequest) -> Vec<BridgeMsg> {
        let id = req.request_id;
        let replies = ReplyHandle::default();
        let mut rx = replies.test_channel(id);
        bridge.dispatch(req, replies);

        let mut out = Vec::new();
        loop {
            match tokio::time::timeout(Duration::from_secs(5), rx.recv()).await {
                Ok(Some(msg)) => {
                    let terminal = matches!(msg, BridgeMsg::Done | BridgeMsg::Error { .. });
                    out.push(msg);
                    if terminal {
                        return out;
                    }
                }
                Ok(None) => panic!("request {id} ended with neither Done nor Error"),
                Err(_) => panic!("request {id} was never answered"),
            }
        }
    }

    fn request(kind: &'static str, body: Value) -> BridgeRequest {
        BridgeRequest { request_id: 1, kind, body, headers: HashMap::new(), app_key_id: None }
    }

    /// A minimal OpenAI chat body, as a client would send one.
    fn chat(model: &str) -> BridgeRequest {
        request(
            "chat",
            json!({
                "model": model,
                "messages": [{ "role": "user", "content": "hi" }],
                "stream": true,
            }),
        )
    }

    /// Every `Delta`'s text, concatenated — what a streaming client would have rendered.
    fn delta_text(msgs: &[BridgeMsg]) -> String {
        msgs.iter()
            .filter_map(|m| match m {
                BridgeMsg::Delta(t) => Some(t.as_str()),
                _ => None,
            })
            .collect()
    }

    fn delta_count(msgs: &[BridgeMsg]) -> usize {
        msgs.iter().filter(|m| matches!(m, BridgeMsg::Delta(_))).count()
    }

    fn result_of(msgs: &[BridgeMsg]) -> &Value {
        msgs.iter()
            .find_map(|m| match m {
                BridgeMsg::Result(v) => Some(v),
                _ => None,
            })
            .expect("a Result was written")
    }

    fn error_of(msgs: &[BridgeMsg]) -> (u16, String, Option<u64>) {
        msgs.iter()
            .find_map(|m| match m {
                BridgeMsg::Error { status, message, retry_after_ms } => {
                    Some((*status, message.clone(), *retry_after_ms))
                }
                _ => None,
            })
            .expect("an Error was written")
    }

    fn tool_calls_of(msgs: &[BridgeMsg]) -> Vec<Value> {
        msgs.iter()
            .find_map(|m| match m {
                BridgeMsg::ToolCalls(v) => Some(v.as_array().cloned().unwrap_or_default()),
                _ => None,
            })
            .expect("the client's calls came back")
    }

    /// The `function.name` of every entry in an OpenAI `tools` array.
    fn tool_names(tools: &Value) -> Vec<String> {
        tools
            .as_array()
            .map(|entries| {
                entries
                    .iter()
                    .filter_map(|t| {
                        t.pointer("/function/name").and_then(Value::as_str).map(str::to_string)
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    // ---------- the failure policy ----------
    //
    // Pure, so these are plain tests: `failure_status` and `failure_retry_hint` are the two
    // decisions the driver makes *about* a failure, and every arm of each is a different fact about
    // who caused it.

    #[test]
    fn no_route_is_a_404_and_this_variant_can_only_ever_say_that() {
        // `RouterError::message()` always spells "no route for model …", so the 502 half of
        // `gateway_status`'s message heuristic is unreachable *from this variant*. The assertion is
        // still worth making: it pins which of the two the client actually sees.
        let err = RouterError::NoRoute {
            model: "ghost".into(),
            modality: TEXT.into(),
            reason: "no carrier".into(),
        };
        assert_eq!(failure_status(&err), 404);
        assert!(err.message().contains("no route"), "the phrase is why it is a 404");
    }

    #[test]
    fn a_spent_budget_reports_the_last_attempts_status() {
        // The last attempt is the one that stopped the request; the first usually failed for the
        // least interesting reason.
        assert_eq!(failure_status(&spent(vec![attempt(500, None), attempt(429, None)])), 429);
        assert_eq!(failure_status(&spent(vec![attempt(429, None), attempt(400, None)])), 400);
    }

    #[test]
    fn a_status_about_our_own_key_is_not_passed_through() {
        // A 401 means *our* stored key was rejected, so echoing it sends the client hunting for a
        // credential problem it does not have. Status 0 never reached a provider at all.
        assert_eq!(failure_status(&spent(vec![attempt(401, None)])), 502);
        assert_eq!(failure_status(&spent(vec![attempt(0, None)])), 502);
        assert_eq!(failure_status(&spent(vec![])), 502, "an empty plan is not the client's fault");
    }

    #[test]
    fn a_mid_stream_break_reports_the_attempts_that_preceded_it() {
        // `MidStream` carries the attempts that failed *before* the one that started streaming, and
        // the status comes from the last of those — not from the 200 the stream opened with.
        let err = RouterError::Text(Box::new(TextFailure::MidStream {
            error: AttemptError::Http {
                status: 200,
                kind: FailureKind::MidStream,
                retry_after_ms: None,
            },
            served: candidate(),
            attempts: vec![attempt(429, None)],
            usage: None,
        }));
        assert_eq!(failure_status(&err), 429);
    }

    #[test]
    fn a_cancelled_text_request_has_a_status_but_no_hint() {
        // Unreachable in practice — `serve_text` returns `Ok` for this variant — but a status has
        // to be *something*, and 502 is the honest "we do not know".
        let err =
            RouterError::Text(Box::new(TextFailure::Cancelled { attempts: vec![], usage: None }));
        assert_eq!(failure_status(&err), 502);
        assert_eq!(failure_retry_hint(&err), None);
    }

    #[test]
    fn an_image_failure_reports_its_chain_too() {
        let err = RouterError::Image(AllAttemptsFailed::new("img1", vec![attempt(422, None)]));
        assert_eq!(failure_status(&err), 422);
    }

    #[test]
    fn a_generator_failure_is_a_500_and_deliberately_not_a_404() {
        // The source throws a plain `Error` whose text does *not* contain the phrase
        // `gateway_status` maps to 404. Folding the two together would quietly change the status a
        // client sees, which is why this is an assertion rather than a comment.
        assert_eq!(failure_status(&RouterError::SystemAiUnavailable), 500);
        assert!(
            !RouterError::SystemAiUnavailable.message().to_lowercase().contains("no route"),
            "if this ever says \"no route\", the 500 above is the wrong answer"
        );
    }

    #[test]
    fn a_failed_ledger_write_is_a_502_because_the_request_itself_succeeded() {
        // The answer was produced and the *record* failed. From the client's side that is a gateway
        // failure, and it is not something a retry of the request would fix.
        let err = RouterError::Ledger("disk full".into());
        assert_eq!(failure_status(&err), 502);
        assert_eq!(failure_retry_hint(&err), None);
    }

    #[test]
    fn the_retry_hint_is_the_shortest_named_wait_and_absent_when_none_was_named() {
        assert_eq!(
            failure_retry_hint(&spent(vec![
                attempt(429, Some(58_000)),
                attempt(429, Some(42_000))
            ])),
            Some(42_000)
        );
        assert_eq!(
            failure_retry_hint(&spent(vec![attempt(429, None)])),
            None,
            "an unnamed wait is an absent field, not a zero that reads as \"retry now\""
        );
        assert_eq!(
            failure_retry_hint(&RouterError::NoRoute {
                model: "x".into(),
                modality: TEXT.into(),
                reason: "r".into(),
            }),
            None
        );
        assert_eq!(failure_retry_hint(&RouterError::SystemAiUnavailable), None);
    }

    // ---------- readiness ----------

    #[tokio::test(flavor = "multi_thread")]
    async fn the_rust_bridge_is_ready_for_any_beat_because_nothing_suspends_it() {
        let bridge = bridge_with(Scripted::text(vec![]), Host::off());
        // The opposite of `webview_ready`: a stale, hidden beat is exactly what a suspended webview
        // reports, and this bridge does not run in one.
        assert!(bridge.ready(Beat { age: Duration::ZERO, hidden: false }));
        assert!(bridge.ready(Beat { age: Duration::from_secs(600), hidden: false }));
        assert!(bridge.ready(Beat { age: Duration::from_secs(600), hidden: true }));
    }

    // ---------- the route kinds ----------

    #[tokio::test(flavor = "multi_thread")]
    async fn an_unknown_kind_is_answered_400_rather_than_run_as_chat() {
        // A silent fallback to `chat` would run a tool loop over a body shaped for something else.
        let adapter = Scripted::text(vec![ScriptedTurn::saying(&["never read"])]);
        let bridge = bridge_with(adapter.clone(), Host::off());

        let msgs = drain(&bridge, request("image_edit", json!({ "model": "m1" }))).await;

        let (status, message, hint) = error_of(&msgs);
        assert_eq!(status, 400);
        assert!(message.contains("image_edit"), "the message names the kind: {message}");
        assert_eq!(hint, None);
        assert_eq!(adapter.text_calls(), 0, "an unrecognised kind must not reach the model");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_models_request_answers_the_catalogue_and_ends() {
        let adapter = Scripted::text(vec![]);
        let bridge = bridge_with(adapter.clone(), Host::off());

        let msgs = drain(&bridge, request("models", json!({}))).await;

        let body = result_of(&msgs);
        assert_eq!(body.get("object").and_then(Value::as_str), Some("list"));
        let data = body.get("data").and_then(Value::as_array).expect("a data array");
        assert_eq!(data.len(), 1);
        assert_eq!(
            data[0].get("id").and_then(Value::as_str),
            Some("p1/m1"),
            "the slug-qualified id, not the bare native one"
        );
        assert_eq!(data[0].get("owned_by").and_then(Value::as_str), Some("p1"));
        assert!(matches!(msgs.last(), Some(BridgeMsg::Done)));
        assert_eq!(adapter.text_calls(), 0, "`models` is a catalogue read, not a model call");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_model_that_resolves_to_nothing_is_answered_404() {
        let adapter = Scripted::text(vec![]);
        let bridge = bridge_with(adapter.clone(), Host::off());

        let msgs = drain(&bridge, chat("ghost")).await;

        let (status, message, hint) = error_of(&msgs);
        assert_eq!(status, 404);
        assert!(message.contains("no route for model \"ghost\""), "got {message}");
        assert_eq!(hint, None);
        assert_eq!(adapter.text_calls(), 0, "a plan with no candidate reaches no adapter");
    }

    // ---------- the held-prose gate, both halves ----------

    #[tokio::test(flavor = "multi_thread")]
    async fn gateway_mode_holds_the_prose_and_releases_it_once_at_the_end() {
        // The gate's whole job: two chunks in, **one** delta out. A bridge that streamed as it
        // arrived would emit two, and the client would render a preamble the model went on to
        // discard.
        let adapter = Scripted::text(vec![ScriptedTurn::saying(&["hel", "lo"])]);
        let bridge = bridge_with(adapter.clone(), Host::gateway_tools());

        let msgs = drain(&bridge, chat("m1")).await;

        assert_eq!(delta_text(&msgs), "hello");
        assert_eq!(delta_count(&msgs), 1, "the held text is handed over once, not per chunk");
        assert!(matches!(msgs.last(), Some(BridgeMsg::Done)));
        assert_eq!(adapter.text_calls(), 1);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn passing_mode_streams_the_prose_as_it_arrives() {
        // The other half of the same decision: a client that declared its own tools has no
        // follow-up turn, so there is nothing to wait for.
        let adapter = Scripted::text(vec![ScriptedTurn::saying(&["hel", "lo"])]);
        let bridge = bridge_with(adapter.clone(), Host::gateway_tools());

        let mut req = chat("m1");
        req.body["tools"] = json!([client_tool("client_side_thing")]);
        let msgs = drain(&bridge, req).await;

        assert_eq!(delta_text(&msgs), "hello");
        assert_eq!(delta_count(&msgs), 2, "nothing is held, so nothing is batched");
        assert_eq!(adapter.text_calls(), 1);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_gateway_supplies_its_registry_only_when_the_client_brought_none() {
        // `decide_tool_ownership` is already pinned as a function. This pins that its answer reaches
        // the wire, which is the part a unit test on the policy cannot see.
        let gateway = Scripted::text(vec![ScriptedTurn::saying(&["ok"])]);
        drain(&bridge_with(gateway.clone(), Host::gateway_tools()), chat("m1")).await;
        let supplied = gateway.tools_seen(0).expect("the gateway supplied tools");
        assert!(
            tool_names(&supplied).iter().any(|n| n == "write_file"),
            "the registry is what goes on the wire: {:?}",
            tool_names(&supplied)
        );

        let client = Scripted::text(vec![ScriptedTurn::saying(&["ok"])]);
        let mut req = chat("m1");
        req.body["tools"] = json!([client_tool("client_side_thing")]);
        drain(&bridge_with(client.clone(), Host::gateway_tools()), req).await;
        let forwarded = client.tools_seen(0).expect("the client's tools were forwarded");
        assert_eq!(
            tool_names(&forwarded),
            vec!["client_side_thing"],
            "the toggle cannot override a client that declared its own tools"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn tools_off_and_none_declared_supplies_nothing() {
        let adapter = Scripted::text(vec![ScriptedTurn::saying(&["ok"])]);
        drain(&bridge_with(adapter.clone(), Host::off()), chat("m1")).await;
        assert_eq!(adapter.tools_seen(0), None, "nothing is invented");
    }

    // ---------- the two modes of the tool loop ----------

    #[tokio::test(flavor = "multi_thread")]
    async fn a_pass_through_turn_hands_the_clients_calls_back_and_runs_nothing() {
        // **One text call, and `Done` rather than an `Error`, is the proof.** Running the call would
        // need a second turn, and a second turn is not scripted — so the adapter would answer a
        // transport failure and the request would end in an error instead of finishing.
        let adapter = Scripted::text(vec![
            ScriptedTurn::saying(&["on it"]).calling(vec![call("c1", "client_side_thing")])
        ]);
        let bridge = bridge_with(adapter.clone(), Host::gateway_tools());

        let mut req = chat("m1");
        req.body["tools"] = json!([client_tool("client_side_thing")]);
        let msgs = drain(&bridge, req).await;

        let calls = tool_calls_of(&msgs);
        assert_eq!(calls.len(), 1);
        assert_eq!(
            calls[0].pointer("/function/name").and_then(Value::as_str),
            Some("client_side_thing")
        );
        assert_eq!(
            calls[0].pointer("/function/arguments").and_then(Value::as_str),
            Some(r#"{"x":1}"#),
            "the provider's own argument text is forwarded, not re-serialised"
        );
        assert_eq!(calls[0].get("id").and_then(Value::as_str), Some("c1"));
        assert!(matches!(msgs.last(), Some(BridgeMsg::Done)));
        assert_eq!(delta_text(&msgs), "on it", "pass-through emits prose as it arrives");
        assert_eq!(adapter.text_calls(), 1, "the call was handed over, not executed");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_id_less_call_is_given_one_before_it_reaches_the_client() {
        // `to_wire_tool_calls` owns id synthesis, and the driver must not invent a second answer.
        // A client cannot answer a call it cannot name.
        let adapter = Scripted::text(vec![ScriptedTurn::saying(&[]).calling(vec![ToolCall {
            id: None,
            name: Some("client_side_thing".into()),
            arguments: Some("{}".into()),
            raw: None,
        }])]);
        let bridge = bridge_with(adapter.clone(), Host::gateway_tools());

        let mut req = chat("m1");
        req.body["tools"] = json!([client_tool("client_side_thing")]);
        let msgs = drain(&bridge, req).await;

        let calls = tool_calls_of(&msgs);
        assert!(
            calls[0].get("id").and_then(Value::as_str).is_some_and(|s| !s.is_empty()),
            "got {:?}",
            calls[0].get("id")
        );
        assert_eq!(adapter.text_calls(), 1);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn calls_nobody_asked_for_are_forwarded_rather_than_run() {
        // `ToolOwnership::None` with calls present yields pass-through, which is the reference's
        // behaviour: a client that declared no tools should not receive calls, but running tools
        // nobody asked for is the worse failure.
        let adapter = Scripted::text(vec![
            ScriptedTurn::saying(&[]).calling(vec![call("c1", "client_side_thing")])
        ]);
        let bridge = bridge_with(adapter.clone(), Host::off());

        let msgs = drain(&bridge, chat("m1")).await;

        assert_eq!(tool_calls_of(&msgs).len(), 1);
        assert!(matches!(msgs.last(), Some(BridgeMsg::Done)));
        assert_eq!(adapter.text_calls(), 1, "forwarded, not run");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_mercury_marker_runs_in_the_sandbox_and_never_reaches_the_client() {
        // An inline marker is not part of any client tool contract, so it runs here whoever declared
        // the real tools — and its syntax must not be rendered as prose.
        let marker = "<tool_call><function=client_side_thing>\
                      <parameter=x>1</parameter></function></tool_call>";
        let adapter =
            Scripted::text(vec![ScriptedTurn::saying(&[marker]), ScriptedTurn::saying(&["done"])]);
        let bridge = bridge_with(adapter.clone(), Host::gateway_tools());

        let msgs = drain(&bridge, chat("m1")).await;

        assert_eq!(delta_text(&msgs), "done", "the marker is not prose");
        assert!(!delta_text(&msgs).contains("tool_call"), "and neither is its syntax");
        assert!(matches!(msgs.last(), Some(BridgeMsg::Done)));
        assert_eq!(adapter.text_calls(), 2, "the sandbox fed a result back and asked again");

        // The second turn is the only place the sandbox's work is visible: an assistant turn that
        // declares the call, then one `tool` message answering it. A provider rejects a `tool`
        // message that does not answer a preceding `tool_calls` turn, so both halves matter.
        let second = adapter.messages_seen(1);
        let assistant = second
            .iter()
            .find(|m| m.get("tool_calls").is_some())
            .expect("the assistant turn that requested the call");
        assert_eq!(
            assistant.get("content").and_then(Value::as_str),
            Some(""),
            "the marker turn produced no prose, so there is none to report"
        );
        let result = second
            .iter()
            .find(|m| m.get("role").and_then(Value::as_str) == Some("tool"))
            .expect("the result the sandbox fed back");
        let answered = result.get("tool_call_id").and_then(Value::as_str).unwrap_or_default();
        assert!(!answered.is_empty(), "the result names the call it answers");
        assert_eq!(
            assistant
                .get("tool_calls")
                .and_then(Value::as_array)
                .and_then(|c| c[0].get("id"))
                .and_then(Value::as_str),
            Some(answered),
            "the id declared and the id answered are the same one"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_iteration_ceiling_ends_the_request_rather_than_hanging() {
        // Every turn asks for another tool call, so the loop can only stop at the ceiling. The last
        // turn's text is *released* rather than dropped: a client that receives nothing at all
        // cannot tell "gave up" from "broke".
        let turns: Vec<ScriptedTurn> = (0..MAX_TOOL_ITERATIONS)
            .map(|n| {
                ScriptedTurn::saying(&[&format!("turn {n}")])
                    .calling(vec![call(&format!("c{n}"), "client_side_thing")])
            })
            .collect();
        let adapter = Scripted::text(turns);
        // Gateway ownership, so the collected calls are run here and the loop goes round again.
        let bridge = bridge_with(adapter.clone(), Host::gateway_tools());

        let msgs = drain(&bridge, chat("m1")).await;

        assert_eq!(adapter.text_calls(), MAX_TOOL_ITERATIONS);
        assert!(matches!(msgs.last(), Some(BridgeMsg::Done)));
        assert!(
            delta_text(&msgs).contains("turn 7"),
            "the last turn is released, not dropped: {:?}",
            delta_text(&msgs)
        );
        assert!(
            !msgs.iter().any(|m| matches!(m, BridgeMsg::ToolCalls(_))),
            "gateway-owned calls never go back to the client"
        );
    }

    // ---------- usage ----------

    #[tokio::test(flavor = "multi_thread")]
    async fn the_upstreams_usage_is_forwarded_with_both_counts() {
        let adapter =
            Scripted::text(vec![ScriptedTurn::saying(&["hi"]).reporting(UsageTokens::new(
                11,
                7,
                Some(3),
            ))]);
        let bridge = bridge_with(adapter, Host::gateway_tools());

        let msgs = drain(&bridge, chat("m1")).await;

        let usage = msgs
            .iter()
            .find_map(|m| match m {
                BridgeMsg::Usage { prompt_tokens, completion_tokens } => {
                    Some((*prompt_tokens, *completion_tokens))
                }
                _ => None,
            })
            .expect("the upstream reported usage");
        // `cached_tokens` is deliberately not asserted: `BridgeMsg::Usage` carries two counts, so
        // the third cannot cross this channel at all — a gap `core::usage`'s own note records.
        assert_eq!(usage, (11, 7));
        assert!(matches!(msgs.last(), Some(BridgeMsg::Done)));
    }

    // ---------- failures, end to end ----------

    #[tokio::test(flavor = "multi_thread")]
    async fn a_spent_budget_reaches_the_client_as_the_upstreams_own_status_and_hint() {
        let adapter = Scripted::text(vec![ScriptedTurn::refusing(AttemptError::Http {
            status: 429,
            kind: FailureKind::Response,
            retry_after_ms: Some(30_000),
        })]);
        let bridge = bridge_with(adapter, Host::gateway_tools());

        let msgs = drain(&bridge, chat("m1")).await;

        let (status, message, hint) = error_of(&msgs);
        assert_eq!(
            status, 429,
            "the client's own request caused it, so its status is the client's"
        );
        assert_eq!(hint, Some(30_000));
        assert!(
            message.starts_with("all attempts failed for m1"),
            "the source's own sentence, built from the chain: {message}"
        );
        assert_eq!(delta_count(&msgs), 0);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_break_after_the_first_byte_is_a_502_and_the_held_prose_is_dropped() {
        // The failure arrived after the consumer already held text, so it can neither be retried nor
        // attributed to the client. `200` is a real value on this path: the *request* succeeded and
        // the *stream* broke.
        let adapter = Scripted::text(vec![ScriptedTurn::saying(&["partial"]).then_breaking(
            AttemptError::Http { status: 200, kind: FailureKind::MidStream, retry_after_ms: None },
        )]);
        let bridge = bridge_with(adapter, Host::gateway_tools());

        let msgs = drain(&bridge, chat("m1")).await;

        let (status, message, hint) = error_of(&msgs);
        assert_eq!(status, 502);
        assert_eq!(hint, None);
        assert!(message.starts_with("mid-stream failure"), "got {message}");
        assert_eq!(
            delta_count(&msgs),
            0,
            "a turn that failed is not an answer, so the held preamble goes nowhere"
        );
    }

    // ---------- the image branch ----------

    #[tokio::test(flavor = "multi_thread")]
    async fn an_image_request_prefers_the_url_and_falls_back_to_the_inline_bytes() {
        let adapter = Scripted::images(vec![
            Ok(ImageReply {
                ok: true,
                status: 200,
                base64: Some("QUJD".into()),
                url: Some("https://img.invalid/a.png".into()),
                error_body: None,
            }),
            Ok(ImageReply {
                ok: true,
                status: 200,
                base64: Some("QUJD".into()),
                url: None,
                error_body: None,
            }),
        ]);
        let bridge = bridge(image_store(), adapter, Host::off());
        let ask = || request("image", json!({ "model": "img1", "prompt": "a cat" }));

        let msgs = drain(&bridge, ask()).await;
        let body = result_of(&msgs);
        assert!(
            body.get("created").and_then(Value::as_u64).is_some(),
            "an OpenAI body carries one"
        );
        let data = body.get("data").and_then(Value::as_array).expect("a data array");
        assert_eq!(data[0].get("url").and_then(Value::as_str), Some("https://img.invalid/a.png"));
        assert!(
            data[0].get("b64_json").is_none(),
            "the url wins, and the bytes are not sent alongside it"
        );
        assert!(matches!(msgs.last(), Some(BridgeMsg::Done)));

        let msgs = drain(&bridge, ask()).await;
        let data =
            result_of(&msgs).get("data").and_then(Value::as_array).expect("a data array").clone();
        assert_eq!(
            data[0].get("b64_json").and_then(Value::as_str),
            Some("QUJD"),
            "with no url, the inline bytes are the answer"
        );
        assert!(data[0].get("url").is_none());
    }
}
