//! Gateway integration tests — one file so the HTTP surface is exercised as a whole
//! rather than per dialect (declared as `gateway::tests` via #[path]).

use super::*;
use futures_util::StreamExt as _;

/// One outbound bridge request as the worker saw it: kind, body, headers.
///
/// Factored out of `SynthBridge::sent` — inline, it is a tuple nested two generics deep and no
/// reader parses it at the field (clippy::type_complexity).
type SentRequest = (String, Value, HashMap<String, String>);

/// Synthetic bridge = the §3.5 entry-gate spike: answers chat with deltas + Done,
/// models/image with JSON, records cancels.
///
/// It used to hold a back-pointer to the core, installed by a manual `attach()` after
/// construction. Both are gone: the way back now arrives with every dispatch, so this bridge
/// holds no reference to the core at all. That is what breaks the core↔bridge cycle — see
/// `ReplyHandle`.
struct SynthBridge {
    cancels: AtomicUsize,
    slow: AtomicUsize, // dispatch count to delay (for disconnect tests)
    /// Make the synthetic model answer with tool calls instead of a plain finish.
    tool_calls: AtomicBool,
    /// Prepend an empty delta — the bridge's between-turns liveness probe.
    empty_delta: AtomicBool,
    /// Answer nothing at all: stand in for a worker webview whose JS the OS suspended
    /// after the request was already admitted.
    silent: AtomicBool,
    /// When non-zero, answer every dispatched request with `BridgeMsg::Error { status }`.
    /// Lets a test drive the worker's own status decision into the edge — which is exactly
    /// where that decision used to be discarded.
    fail_status: AtomicUsize,
    /// Cooldown carried by that failure, in ms — standing in for the provider's own
    /// `Retry-After`. Zero means the worker reported none.
    fail_retry_after: AtomicUsize,
    /// Everything handed to the worker, verbatim. Phase 6 needs to see what actually leaves
    /// for the provider — asserting on the *ingress* body would prove nothing, because every
    /// dialect is translated twice and either hop can drop the injected block.
    sent: Mutex<Vec<SentRequest>>,
    /// The app key each dispatch carried, in dispatch order — kept beside `sent` rather than
    /// inside it so the existing `(kind, body, headers)` readers did not have to change.
    app_keys: Mutex<Vec<Option<String>>>,
}

impl SynthBridge {
    fn new() -> Self {
        Self {
            cancels: AtomicUsize::new(0),
            slow: AtomicUsize::new(0),
            tool_calls: AtomicBool::new(false),
            empty_delta: AtomicBool::new(false),
            silent: AtomicBool::new(false),
            fail_status: AtomicUsize::new(0),
            fail_retry_after: AtomicUsize::new(0),
            sent: Mutex::new(Vec::new()),
            app_keys: Mutex::new(Vec::new()),
        }
    }

    /// `(kind, body, headers)` of the nth dispatch.
    fn sent(&self, n: usize) -> Option<(String, Value, HashMap<String, String>)> {
        self.sent.lock().unwrap().get(n).cloned()
    }

    /// The app key carried by the nth dispatch. Outer `None` means there was no such dispatch;
    /// inner `None` means the master key authenticated, which is not a per-app key.
    fn app_key(&self, n: usize) -> Option<Option<String>> {
        self.app_keys.lock().unwrap().get(n).cloned()
    }
    /// How many requests have been handed to the worker — i.e. actually routed, which is the
    /// number §3.5 caps at 8. Counting admissions instead would prove nothing.
    fn dispatched(&self) -> usize {
        self.sent.lock().unwrap().len()
    }
    fn go_silent(&self, on: bool) {
        self.silent.store(on, Ordering::Relaxed);
    }
    fn answer_with_tool_calls(&self, on: bool) {
        self.tool_calls.store(on, Ordering::Relaxed);
    }
    fn answer_with_empty_delta(&self, on: bool) {
        self.empty_delta.store(on, Ordering::Relaxed);
    }
    /// Make the worker answer with `BridgeMsg::Error` carrying this status.
    fn fail_with(&self, status: u16) {
        self.fail_status.store(status as usize, Ordering::Relaxed);
    }
    /// Same, but the failure also carries the provider's own cooldown — the value that has
    /// to reach the client as `Retry-After` instead of the middleware's 1s floor.
    fn fail_with_cooldown(&self, status: u16, retry_after_ms: u64) {
        self.fail_status.store(status as usize, Ordering::Relaxed);
        self.fail_retry_after.store(retry_after_ms as usize, Ordering::Relaxed);
    }
}

impl Bridge for SynthBridge {
    fn dispatch(&self, req: BridgeRequest, replies: ReplyHandle) {
        if self.silent.load(Ordering::Relaxed) {
            return; // never replies — the request must fail, not hang
        }
        self.sent.lock().unwrap().push((
            req.kind.to_string(),
            req.body.clone(),
            req.headers.clone(),
        ));
        // Recorded before the reply thread is spawned: that closure moves `req.request_id`, so
        // reading the field after it would not compile.
        self.app_keys.lock().unwrap().push(req.app_key_id.clone());
        // `replies` is moved into the thread. This used to be a `Mutex<Option<Arc<GatewayCore>>>`
        // field filled in by an `attach()` call after construction — a strong reference back to
        // the core that owned this bridge. The handle arriving as a parameter is both less state
        // and one fewer step to forget.
        let slow = self.slow.load(Ordering::Relaxed);
        let with_tools = self.tool_calls.load(Ordering::Relaxed);
        let with_empty = self.empty_delta.load(Ordering::Relaxed);
        let fail = self.fail_status.load(Ordering::Relaxed);
        let fail_retry_after = self.fail_retry_after.load(Ordering::Relaxed);
        std::thread::spawn(move || {
            if slow > 0 {
                std::thread::sleep(Duration::from_millis(slow as u64 * 20));
            }
            if fail > 0 {
                // The worker decided this status. Everything downstream must respect it.
                replies.reply(
                    req.request_id,
                    BridgeMsg::Error {
                        status: fail as u16,
                        message: "upstream refused the request".into(),
                        retry_after_ms: (fail_retry_after > 0).then_some(fail_retry_after as u64),
                    },
                );
                return;
            }
            match req.kind {
                "chat" => {
                    if with_empty {
                        replies.reply(req.request_id, BridgeMsg::Delta(String::new()));
                    }
                    replies.reply(req.request_id, BridgeMsg::Delta("Hel".into()));
                    replies.reply(req.request_id, BridgeMsg::Delta("lo".into()));
                    if with_tools {
                        // Pass-through: the client declared these, so the gateway hands
                        // them straight back and never executes them itself.
                        replies.reply(
                                req.request_id,
                                BridgeMsg::ToolCalls(json!([{
                                    "id": "call_1",
                                    "type": "function",
                                    "function": { "name": "write_file", "arguments": "{\"path\":\"a.txt\"}" }
                                }])),
                            );
                    }
                    replies.reply(req.request_id, BridgeMsg::Done);
                }
                "responses" => {
                    // Same synthetic text output as chat; responses_h wraps it into Responses API frames.
                    replies.reply(req.request_id, BridgeMsg::Delta("Hel".into()));
                    replies.reply(req.request_id, BridgeMsg::Delta("lo".into()));
                    replies.reply(req.request_id, BridgeMsg::Done);
                }
                "models" => {
                    replies.reply(req.request_id, BridgeMsg::Result(json!({
                            "object": "list",
                            "data": [{ "id": "openrouter/gpt-4o", "object": "model" }, { "id": "opencode/gpt-4o", "object": "model" }]
                        })));
                    replies.reply(req.request_id, BridgeMsg::Done);
                }
                "image" => {
                    replies.reply(
                        req.request_id,
                        BridgeMsg::Result(
                            json!({ "data": [{ "url": "https://img.example/x.png" }] }),
                        ),
                    );
                    replies.reply(req.request_id, BridgeMsg::Done);
                }
                _ => {}
            }
        });
    }
    fn cancel(&self, _id: u64) {
        self.cancels.fetch_add(1, Ordering::Relaxed);
    }
}

struct TestServer {
    client: reqwest::Client,
    base: String,
    core: Arc<GatewayCore>,
    bridge: Arc<SynthBridge>,
    _handle: ServerHandle,
}

/// A real store on a temp dir, because `GatewayState` now carries one for the context-graph
/// audit path. Returns the dir so the caller keeps it alive until the test ends.
///
/// Gated with its callers: the five tests that build a `GatewayState` are app-only, so without the
/// feature this helper has none and would be dead code.
#[cfg(feature = "app")]
fn gateway_test_store(tag: &str) -> (Arc<crate::core::store::Store>, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("aip-gw-{}-{}", tag, std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    (Arc::new(crate::core::store::Store::open(&dir).unwrap()), dir)
}

/// Key provider backed by a mutable slot — simulates rotate/revoke without the keychain.
fn test_core(key: Arc<Mutex<Option<String>>>) -> (Arc<GatewayCore>, Arc<SynthBridge>) {
    let bridge = Arc::new(SynthBridge::new());
    let core =
        Arc::new(GatewayCore::new(bridge.clone(), Arc::new(move || key.lock().unwrap().clone())));
    (core, bridge)
}

async fn start(key: Arc<Mutex<Option<String>>>) -> TestServer {
    let (core, bridge) = test_core(key);
    core.set_running(true);
    let handle = spawn(core.clone(), 0).await.expect("bind ephemeral");
    TestServer {
        client: reqwest::Client::new(),
        base: format!("http://{}", handle.addr),
        core,
        bridge,
        _handle: handle,
    }
}

fn chat_body(stream: bool) -> Value {
    json!({ "model": "gpt-4o", "messages": [{ "role": "user", "content": "hi" }], "stream": stream })
}

#[tokio::test(flavor = "multi_thread")]
async fn criterion8_stream_with_master_key() {
    let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let s = start(key).await;
    let res = s
        .client
        .post(format!("{}/v1/chat/completions", s.base))
        .header("authorization", "Bearer sk-aip-test")
        .json(&chat_body(true))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    assert_eq!(res.headers()["content-type"], "text/event-stream");
    let mut stream = res.bytes_stream();
    let mut acc = String::new();
    while let Some(chunk) = stream.next().await {
        acc.push_str(&String::from_utf8_lossy(&chunk.unwrap()));
        if acc.contains("finish_reason") && acc.contains("\"stop\"") {
            break;
        }
    }
    assert!(acc.contains("Hel"));
    assert!(acc.contains("lo"));
    assert!(acc.contains("finish_reason") && acc.contains("stop"), "stream must terminate: {acc}");
}

#[tokio::test(flavor = "multi_thread")]
async fn criterion8_wrong_key_401() {
    let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let s = start(key).await;
    let res = s
        .client
        .post(format!("{}/v1/chat/completions", s.base))
        .header("authorization", "Bearer sk-aip-WRONG")
        .json(&chat_body(false))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 401);
    let body: Value = res.json().await.unwrap();
    assert_eq!(body["error"]["code"], "invalid_api_key");
}

#[tokio::test(flavor = "multi_thread")]
async fn criterion8_rotation_kills_old_key_instantly() {
    let key = Arc::new(Mutex::new(Some("sk-aip-old".to_string())));
    let s = start(key.clone()).await;
    // old key works
    let res = s
        .client
        .post(format!("{}/v1/chat/completions", s.base))
        .header("authorization", "Bearer sk-aip-old")
        .json(&chat_body(false))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    // rotate (overwrite keychain slot) — and drop the cached key, exactly as
    // `GatewayCore::rotate_master_key` does. The two steps are one operation in production
    // precisely so this cannot be half-done.
    *key.lock().unwrap() = Some("sk-aip-new".to_string());
    s.core.invalidate_master_key();
    // old key now 401, new key 200 — no restart
    let res_old = s
        .client
        .post(format!("{}/v1/chat/completions", s.base))
        .header("authorization", "Bearer sk-aip-old")
        .json(&chat_body(false))
        .send()
        .await
        .unwrap();
    assert_eq!(res_old.status(), 401);
    // invariant 15: the failed attempt put this IP in a short backoff — wait it out
    tokio::time::sleep(Duration::from_millis(600)).await;
    let res_new = s
        .client
        .post(format!("{}/v1/chat/completions", s.base))
        .header("authorization", "Bearer sk-aip-new")
        .json(&chat_body(false))
        .send()
        .await
        .unwrap();
    assert_eq!(res_new.status(), 200);
}

#[tokio::test(flavor = "multi_thread")]
async fn non_stream_returns_openai_shape() {
    let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let s = start(key).await;
    let res = s
        .client
        .post(format!("{}/v1/chat/completions", s.base))
        .header("authorization", "Bearer sk-aip-test")
        .json(&chat_body(false))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let body: Value = res.json().await.unwrap();
    assert_eq!(body["object"], "chat.completion");
    assert_eq!(body["choices"][0]["message"]["content"], "Hello");
}

#[tokio::test(flavor = "multi_thread")]
async fn anthropic_messages_non_stream() {
    let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let s = start(key).await;
    let res = s
        .client
        .post(format!("{}/v1/messages", s.base))
        .header("x-api-key", "sk-aip-test") // Anthropic-style auth header
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&json!({ "model": "mock-fast", "max_tokens": 64,
                "messages": [{ "role": "user", "content": "hi" }] }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let body: Value = res.json().await.unwrap();
    assert_eq!(body["type"], "message");
    assert_eq!(body["role"], "assistant");
    assert_eq!(body["content"][0]["type"], "text");
    assert_eq!(body["content"][0]["text"], "Hello");
    assert_eq!(body["stop_reason"], "end_turn");
}

#[tokio::test(flavor = "multi_thread")]
async fn anthropic_messages_stream_framing() {
    let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let s = start(key).await;
    let res = s
        .client
        .post(format!("{}/v1/messages", s.base))
        .header("x-api-key", "sk-aip-test")
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&json!({ "model": "mock-fast", "max_tokens": 64, "stream": true,
                "messages": [{ "role": "user", "content": [{ "type": "text", "text": "hi" }] }] }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let mut acc = String::new();
    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        acc.push_str(&String::from_utf8_lossy(&chunk.unwrap()));
        if acc.contains("message_stop") {
            break;
        }
    }
    for stage in [
        "message_start",
        "content_block_start",
        "content_block_delta",
        "content_block_stop",
        "message_delta",
        "message_stop",
    ] {
        assert!(
            acc.contains(stage),
            "missing {stage} in:
{acc}"
        );
    }
    // synth bridge streams "Hel" + "lo" as separate deltas
    assert!(acc.contains("Hel"), "delta text missing");
}

/// count_tokens returns 200 with input_tokens before any bridge is consulted — no upstream.
#[tokio::test(flavor = "multi_thread")]
async fn count_tokens_returns_estimate() {
    let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let s = start(key).await;
    let res = s
        .client
        .post(format!("{}/v1/messages/count_tokens", s.base))
        .header("x-api-key", "sk-aip-test")
        .header("content-type", "application/json")
        .json(&json!({
            "model": "any",
            "messages": [{ "role": "user", "content": "hello world" }]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let body: Value = res.json().await.unwrap();
    assert_eq!(body["input_tokens"], 2, "11 chars / 4 = 2");
}

/// No auth header → 401, same as any other gateway route (invariant 10: auth before work).
#[tokio::test(flavor = "multi_thread")]
async fn count_tokens_unauthenticated_is_401() {
    let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let s = start(key).await;
    let res = s
        .client
        .post(format!("{}/v1/messages/count_tokens", s.base))
        .header("content-type", "application/json")
        .json(&json!({ "model": "any", "messages": [] }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 401);
    let body: Value = res.json().await.unwrap();
    assert_eq!(body["error"]["type"], "authentication_error");
}

/// Malformed JSON body → 400 invalid_request_error.
#[tokio::test(flavor = "multi_thread")]
async fn count_tokens_invalid_json_is_400() {
    let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let s = start(key).await;
    let res = s
        .client
        .post(format!("{}/v1/messages/count_tokens", s.base))
        .header("x-api-key", "sk-aip-test")
        .header("content-type", "application/json")
        .body("not json")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 400);
    let body: Value = res.json().await.unwrap();
    assert_eq!(body["error"]["type"], "invalid_request_error");
}

/// Gateway mode holds text back until the model settles, so it probes liveness between
/// turns with an empty chunk. That probe must reach the client as nothing — an empty
/// content delta is not information, and streaming a blank frame per turn is noise that
/// some clients render as a spurious empty message.
#[tokio::test(flavor = "multi_thread")]
async fn empty_delta_is_not_a_wire_event() {
    let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let s = start(key).await;
    s.bridge.answer_with_empty_delta(true);
    let res = s
        .client
        .post(format!("{}/v1/chat/completions", s.base))
        .header("authorization", "Bearer sk-aip-test")
        .header("content-type", "application/json")
        .json(&chat_body(true))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let mut acc = String::new();
    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        acc.push_str(&String::from_utf8_lossy(&chunk.unwrap()));
        if acc.contains("[DONE]") {
            break;
        }
    }
    assert!(
        !acc.contains(r#""content":"""#),
        "empty delta reached the wire:
{acc}"
    );
    // The probe is dropped, not the message: real text still arrives.
    assert!(
        acc.contains("Hel") && acc.contains("lo"),
        "real deltas missing:
{acc}"
    );
}

/// OpenAI ends every SSE stream with `data: [DONE]` and opens the message with a delta
/// carrying `role: "assistant"`. Third-party clients — WorkBuddy's custom-provider
/// adapter among them — read for that sentinel instead of waiting on EOF, and expect the
/// role on the first frame. Without both, the client either hangs or loses the speaker.
#[tokio::test(flavor = "multi_thread")]
async fn stream_ends_with_done_and_opens_with_role() {
    let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let s = start(key).await;
    let res = s
        .client
        .post(format!("{}/v1/chat/completions", s.base))
        .header("authorization", "Bearer sk-aip-test")
        .header("content-type", "application/json")
        .json(&chat_body(true))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let mut acc = String::new();
    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        acc.push_str(&String::from_utf8_lossy(&chunk.unwrap()));
        if acc.contains("[DONE]") {
            break;
        }
    }
    assert!(
        acc.contains("data: [DONE]"),
        "stream never terminated with [DONE]:
{acc}"
    );
    // The sentinel is last: nothing is emitted after it.
    let tail = acc.split("data: [DONE]").nth(1).unwrap_or("");
    assert!(
        !tail.contains("chat.completion.chunk"),
        "frames emitted after [DONE]:
{acc}"
    );
    // First content frame opens the message with the assistant role.
    let first = acc.find(r#""delta""#).expect("no delta frame");
    assert!(
        acc[first..].contains(r#""role":"assistant""#),
        "first delta has no role:
{acc}"
    );
}

/// Every OpenAI response — streamed or not — carries the model that served it. Clients read
/// it back to check they got what they asked for, and some reject a body without it.
#[tokio::test(flavor = "multi_thread")]
async fn responses_echo_the_served_model() {
    let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let s = start(key).await;

    let res = s
        .client
        .post(format!("{}/v1/chat/completions", s.base))
        .header("authorization", "Bearer sk-aip-test")
        .header("content-type", "application/json")
        .json(&chat_body(false))
        .send()
        .await
        .unwrap();
    let body: Value = res.json().await.unwrap();
    assert_eq!(
        body["model"], "gpt-4o",
        "non-stream body has no model:
{body}"
    );

    let res = s
        .client
        .post(format!("{}/v1/chat/completions", s.base))
        .header("authorization", "Bearer sk-aip-test")
        .header("content-type", "application/json")
        .json(&chat_body(true))
        .send()
        .await
        .unwrap();
    let mut acc = String::new();
    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        acc.push_str(&String::from_utf8_lossy(&chunk.unwrap()));
        if acc.contains("[DONE]") {
            break;
        }
    }
    assert!(
        acc.contains(r#""model":"gpt-4o""#),
        "stream frames carry no model:
{acc}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn anthropic_system_and_bad_request() {
    let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let s = start(key).await;
    // system as a top-level string must become a system turn (accepted, 200)
    let res = s
        .client
        .post(format!("{}/v1/messages", s.base))
        .header("x-api-key", "sk-aip-test")
        .header("content-type", "application/json")
        .json(&json!({ "model": "mock-fast", "max_tokens": 8, "system": "be terse",
                "messages": [{ "role": "user", "content": "hi" }] }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    // missing messages -> anthropic-shaped 400
    let res = s
        .client
        .post(format!("{}/v1/messages", s.base))
        .header("x-api-key", "sk-aip-test")
        .header("content-type", "application/json")
        .json(&json!({ "max_tokens": 8 }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 400);
    let body: Value = res.json().await.unwrap();
    assert_eq!(body["type"], "error");
    assert_eq!(body["error"]["type"], "invalid_request_error");
}

#[tokio::test(flavor = "multi_thread")]
async fn responses_api_non_stream() {
    let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let s = start(key).await;
    let res = s
        .client
        .post(format!("{}/v1/responses", s.base))
        .header("authorization", "Bearer sk-aip-test")
        .header("content-type", "application/json")
        .json(&json!({ "model": "mock-fast", "input": "hi", "instructions": "be nice" }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let body: Value = res.json().await.unwrap();
    assert_eq!(body["object"], "response");
    assert_eq!(body["status"], "completed");
    assert_eq!(body["output"][0]["content"][0]["text"], "Hello");
}

#[tokio::test(flavor = "multi_thread")]
async fn responses_api_stream_events() {
    let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let s = start(key).await;
    let res = s
            .client
            .post(format!("{}/v1/responses", s.base))
            .header("authorization", "Bearer sk-aip-test")
            .header("content-type", "application/json")
            .json(&json!({ "model": "mock-fast", "input": [{ "role": "user", "content": "hi" }], "stream": true }))
            .send()
            .await
            .unwrap();
    assert_eq!(res.status(), 200);
    let mut acc = String::new();
    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        acc.push_str(&String::from_utf8_lossy(&chunk.unwrap()));
        if acc.contains("response.completed") {
            break;
        }
    }
    for ev in [
        "response.created",
        "response.output_text.delta",
        "response.output_text.done",
        "response.completed",
    ] {
        assert!(acc.contains(ev), "missing {ev}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn gemini_generate_content() {
    let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let s = start(key).await;
    let res = s
        .client
        .post(format!("{}/v1beta/models/mock-fast:generateContent", s.base))
        .header("x-goog-api-key", "sk-aip-test")
        .header("content-type", "application/json")
        .json(&json!({ "contents": [{ "role": "user", "parts": [{ "text": "hi" }] }] }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let body: Value = res.json().await.unwrap();
    assert_eq!(body["candidates"][0]["content"]["parts"][0]["text"], "Hello");
    assert_eq!(body["candidates"][0]["finishReason"], "STOP");
}

#[tokio::test(flavor = "multi_thread")]
async fn gemini_stream_requires_alt_sse() {
    let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let s = start(key).await;
    let res = s
        .client
        .post(format!("{}/v1beta/models/mock-fast:streamGenerateContent", s.base))
        .header("x-goog-api-key", "sk-aip-test")
        .header("content-type", "application/json")
        .json(&json!({ "contents": [{ "parts": [{ "text": "hi" }] }] }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 400);
    let res = s
        .client
        .post(format!("{}/v1beta/models/mock-fast:streamGenerateContent?alt=sse", s.base))
        .header("x-goog-api-key", "sk-aip-test")
        .header("content-type", "application/json")
        .json(&json!({ "contents": [{ "parts": [{ "text": "hi" }] }] }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let mut acc = String::new();
    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        acc.push_str(&String::from_utf8_lossy(&chunk.unwrap()));
        if acc.contains("finishReason") {
            break;
        }
    }
    assert!(acc.contains("Hel"), "no delta: {acc}");
    assert!(acc.contains("STOP"));
}

#[tokio::test(flavor = "multi_thread")]
async fn gemini_bad_key_401() {
    let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let s = start(key).await;
    let res = s
        .client
        .post(format!("{}/v1beta/models/m:generateContent", s.base))
        .header("x-goog-api-key", "sk-wrong")
        .header("content-type", "application/json")
        .json(&json!({ "contents": [] }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 401);
}

// ---------- Gemini: a tool turn still reports finishReason "STOP" (2026-09-22) ----------
//
// Every other dialect distinguishes the tool-call turn in its finish reason: Anthropic sends
// `tool_use` vs `end_turn` (`gateway_anthropic.rs:700`), OpenAI sends `tool_calls` vs `stop`
// (`gateway_handlers.rs:231`). **Gemini does not.** Its `FinishReason` enum has no tool-call
// member, and a function call is signalled by the presence of `functionCall` parts instead —
// so `finishReason` stays `STOP`.
//
// This test exists because `gateway_gemini.rs` read
// `let finish_reason = if has_tool_calls { "STOP" } else { "STOP" };` — a dead branch that
// implied a distinction the protocol does not make. The branch is gone.
//
// It is a *value* pin, not a structural one: both arms produced `STOP`, so this test would have
// passed against the dead branch too. What it actually prevents is the tempting repair — a
// future "fix" that invents a second literal (say `FUNCTION_CALL`) because the guard looks like
// it should do something. That repair would pass the entire rest of the suite and be wrong on
// the wire; before this test, **no Gemini test reached the tool-call path at all** (the only
// `finishReason` assertion used a plain "hi" prompt with no tools).
#[tokio::test(flavor = "multi_thread")]
async fn gemini_tool_turn_still_reports_stop() {
    let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let s = start(key).await;
    s.bridge.answer_with_tool_calls(true);
    let res = s
        .client
        .post(format!("{}/v1beta/models/mock-fast:generateContent", s.base))
        .header("x-goog-api-key", "sk-aip-test")
        .header("content-type", "application/json")
        .json(&json!({
            "contents": [{ "role": "user", "parts": [{ "text": "write a file" }] }],
            "tools": [{ "functionDeclarations": [{ "name": "write_file", "description": "w" }] }]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let body: Value = res.json().await.unwrap();
    let parts = body["candidates"][0]["content"]["parts"]
        .as_array()
        .unwrap_or_else(|| panic!("no parts array: {body}"));
    // Prove the tool path was actually taken. Without this the test could pass while asserting
    // nothing — a text reply also carries a `parts` array.
    assert_eq!(
        parts[0]["functionCall"]["name"], "write_file",
        "tool path not reached, so this test pins nothing: {body}"
    );
    assert!(
        parts.iter().all(|p| p.get("functionCall").is_some()),
        "a tool turn must carry functionCall parts, not text: {body}"
    );
    assert_eq!(
        body["candidates"][0]["finishReason"], "STOP",
        "Gemini has no distinct tool-call finish reason — see the comment above"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn tools_param_forwarded_to_upstream() {
    // tools/tool_choice/response_format are now forwarded to upstream providers
    // this test verifies the gateway accepts them and routes them to the bridge
    let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let s = start(key).await;
    let res = s
            .client
            .post(format!("{}/v1/chat/completions", s.base))
            .header("authorization", "Bearer sk-aip-test")
            .json(&json!({ "model": "gpt-4o", "messages": [], "tools": [{"type": "function", "function": {"name": "test"}}], "tool_choice": "auto" }))
            .send()
            .await
            .unwrap();
    assert_eq!(res.status(), 200);
}

#[tokio::test(flavor = "multi_thread")]
async fn merged_models_qualified_ids() {
    let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let s = start(key).await;
    let res = s
        .client
        .get(format!("{}/v1/models", s.base))
        .header("authorization", "Bearer sk-aip-test")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let body: Value = res.json().await.unwrap();
    assert_eq!(body["data"][0]["id"], "openrouter/gpt-4o");
}

#[tokio::test(flavor = "multi_thread")]
async fn image_generation_routes() {
    let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let s = start(key).await;
    let res = s
        .client
        .post(format!("{}/v1/images/generations", s.base))
        .header("authorization", "Bearer sk-aip-test")
        .json(&json!({ "model": "dall-e-3", "prompt": "cat" }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let body: Value = res.json().await.unwrap();
    assert_eq!(body["data"][0]["url"], "https://img.example/x.png");
}

#[tokio::test(flavor = "multi_thread")]
async fn core_down_answers_503_with_retry_after() {
    let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let s = start(key).await;
    s.core.set_running(false);
    let res = s
        .client
        .post(format!("{}/v1/chat/completions", s.base))
        .header("authorization", "Bearer sk-aip-test")
        .json(&chat_body(true))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 503);
    assert_eq!(res.headers()["retry-after"], "1");
}

#[tokio::test(flavor = "multi_thread")]
async fn client_disconnect_midstream_cancels_bridge() {
    let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let s = start(key).await;
    // Bridge answers slowly; we drop the response stream after the first chunk.
    s.bridge.slow.store(100, Ordering::Relaxed); // delay replies ~2s
    let res = s
        .client
        .post(format!("{}/v1/chat/completions", s.base))
        .header("authorization", "Bearer sk-aip-test")
        .json(&chat_body(true))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    // Drop the stream immediately (client disconnect).
    drop(res);
    // Slot drop -> cancel must be observed.
    for _ in 0..50 {
        if s.bridge.cancels.load(Ordering::Relaxed) > 0 {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("cancel was never propagated to the bridge");
}

#[test]
fn constant_time_eq_basics() {
    assert!(constant_time_eq("abc", "abc"));
    assert!(!constant_time_eq("abc", "abd"));
    assert!(!constant_time_eq("abc", "abcd"));
}
// ========== Phase 3: End-to-End Tool Call Verification ==========

/// Phase 3 Test 1: Verify non-streaming request with tools returns valid response
#[tokio::test(flavor = "multi_thread")]
async fn phase3_non_stream_tool_calls_in_response() {
    let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let s = start(key).await;
    let res = s
            .client
            .post(format!("{}/v1/chat/completions", s.base))
            .header("authorization", "Bearer sk-aip-test")
            .json(&json!({
                "model": "gpt-4o",
                "messages": [{"role": "user", "content": "run command"}],
                "tools": [{"type": "function", "function": {"name": "bash", "parameters": {"type": "object", "properties": {"command": {"type": "string"}}}}}],
                "stream": false
            }))
            .send()
            .await
            .unwrap();
    assert_eq!(res.status(), 200);
    let body: Value = res.json().await.unwrap();
    // The synth bridge returns "Hello" without tool calls, so finish_reason should be "stop"
    assert_eq!(body["choices"][0]["finish_reason"], "stop");
}

/// Phase 3 Test 3: Verify tool schema is forwarded to bridge
#[tokio::test(flavor = "multi_thread")]
async fn phase3_tools_schema_forwarded() {
    let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let s = start(key).await;
    let res = s
        .client
        .post(format!("{}/v1/chat/completions", s.base))
        .header("authorization", "Bearer sk-aip-test")
        .json(&json!({
            "model": "gpt-4o",
            "messages": [{"role": "user", "content": "list files"}],
            "tools": [{
                "type": "function",
                "function": {
                    "name": "list_files",
                    "description": "List files in directory",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "path": {"type": "string", "description": "Directory path"}
                        },
                        "required": ["path"]
                    }
                }
            }]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
}

/// Phase 3 Test 4: Verify headers are forwarded for client detection
#[tokio::test(flavor = "multi_thread")]
async fn phase3_headers_forwarded() {
    let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let s = start(key).await;
    let res = s
        .client
        .post(format!("{}/v1/chat/completions", s.base))
        .header("authorization", "Bearer sk-aip-test")
        .header("user-agent", "Claude-Code/1.0")
        .header("x-client-name", "claude-code")
        .json(&chat_body(false))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
}

// ---------- audit R4: per-app keys + monthly spend cap ----------

/// Stand-in for the vault-backed provider: `(id, secret)` pairs.
fn ak(pairs: &[(&str, &str)]) -> Arc<Mutex<Vec<AppKey>>> {
    Arc::new(Mutex::new(
        pairs.iter().map(|(id, s)| AppKey { id: (*id).into(), secret: (*s).into() }).collect(),
    ))
}

/// `start()` plus the two R4 providers. Both are `Option` so each test opts into exactly
/// the behaviour it exercises; `None` reproduces the pre-R4 (master-only, uncapped) path.
fn core_with(
    key: Arc<Mutex<Option<String>>>,
    app_keys: Option<Arc<Mutex<Vec<AppKey>>>>,
    spend: Option<Arc<Mutex<(i64, i64)>>>,
) -> (Arc<GatewayCore>, Arc<SynthBridge>) {
    let bridge = Arc::new(SynthBridge::new());
    let mut core = GatewayCore::new(bridge.clone(), Arc::new(move || key.lock().unwrap().clone()));
    if let Some(ak) = app_keys {
        core = core.with_app_keys(Arc::new(move || ak.lock().unwrap().clone()));
    }
    if let Some(sp) = spend {
        // The tuple is the *global* pair. The per-app half stays `None` here so these cases keep
        // testing exactly what they always did; the per-app cases use `start_with_spend`.
        core = core.with_spend(Arc::new(move |_app: Option<&str>| {
            let (spent, cap) = *sp.lock().unwrap();
            SpendLimits {
                total_micros: spent,
                total_cap_micros: cap,
                app_micros: None,
                app_cap_micros: None,
            }
        }));
    }
    let core = Arc::new(core);
    (core, bridge)
}

async fn start_with(
    app_keys: Option<Arc<Mutex<Vec<AppKey>>>>,
    spend: Option<Arc<Mutex<(i64, i64)>>>,
) -> TestServer {
    let master = Arc::new(Mutex::new(Some("sk-aip-master".to_string())));
    let (core, bridge) = core_with(master, app_keys, spend);
    core.set_running(true);
    let handle = spawn(core.clone(), 0).await.expect("bind ephemeral");
    TestServer {
        client: reqwest::Client::new(),
        base: format!("http://{}", handle.addr),
        core,
        bridge,
        _handle: handle,
    }
}

/// `start()` with a spend provider the test writes by hand.
///
/// `start_with`'s tuple is a *fixed* global pair, which cannot express the per-app cases: those
/// need the answer to depend on **who is asking**, and that dependency is the entire change. A
/// closure is the only shape that lets one request from `ak-1` be refused while the same moment's
/// request from `ak-2` is served.
async fn start_with_spend(
    app_keys: Option<Arc<Mutex<Vec<AppKey>>>>,
    spend: SpendProvider,
) -> TestServer {
    let master = Arc::new(Mutex::new(Some("sk-aip-master".to_string())));
    let bridge = Arc::new(SynthBridge::new());
    let mut core =
        GatewayCore::new(bridge.clone(), Arc::new(move || master.lock().unwrap().clone()));
    if let Some(ak) = app_keys {
        core = core.with_app_keys(Arc::new(move || ak.lock().unwrap().clone()));
    }
    core = core.with_spend(spend);
    let core = Arc::new(core);
    core.set_running(true);
    let handle = spawn(core.clone(), 0).await.expect("bind ephemeral");
    TestServer {
        client: reqwest::Client::new(),
        base: format!("http://{}", handle.addr),
        core,
        bridge,
        _handle: handle,
    }
}

/// A spend provider that answers from `limits_for` **and records every caller it is asked about**.
///
/// Recording the argument is the only way to prove the gate passes the identity that actually
/// authenticated. A gate that passed, say, the first configured key would satisfy every
/// status-code assertion below while billing the wrong app — the failure would be invisible
/// until the wrong app hit its budget.
fn recording_spend(
    calls: Arc<Mutex<Vec<Option<String>>>>,
    limits_for: impl Fn(Option<&str>) -> SpendLimits + Send + Sync + 'static,
) -> SpendProvider {
    Arc::new(move |app: Option<&str>| {
        calls.lock().unwrap().push(app.map(str::to_string));
        limits_for(app)
    })
}

async fn post_chat(s: &TestServer, bearer: &str) -> reqwest::Response {
    s.client
        .post(format!("{}/v1/chat/completions", s.base))
        .header("authorization", format!("Bearer {bearer}"))
        .json(&chat_body(false))
        .send()
        .await
        .unwrap()
}

/// R4(a): a per-app key authenticates even though it is not the master key — this is what
/// lets an app be onboarded without handing out the master credential.
#[tokio::test(flavor = "multi_thread")]
async fn r4_app_key_authenticates() {
    let s = start_with(Some(ak(&[("ak-1", "sk-aip-app1")])), None).await;
    let res = post_chat(&s, "sk-aip-app1").await;
    assert_eq!(res.status(), 200, "per-app key must be accepted");
}

/// Per-app attribution: the key that authenticated has to reach the bridge, because the ledger
/// row — the thing a per-app budget sums — is written on the webview side of it.
///
/// Asserted at the bridge rather than on `check_gateway_key`'s return value, because that is only
/// half the wiring. A `None` on `BridgeRequest` leaves the column present and every row `NULL`,
/// which reads as "no app ever spent anything" rather than "attribution was never connected".
#[tokio::test(flavor = "multi_thread")]
async fn the_authenticating_app_key_reaches_the_bridge() {
    let s = start_with(Some(ak(&[("ak-1", "sk-aip-app1")])), None).await;
    assert_eq!(post_chat(&s, "sk-aip-app1").await.status(), 200);
    assert_eq!(
        s.bridge.app_key(0),
        Some(Some("ak-1".to_string())),
        "the per-app key that paid must travel with the request"
    );
}

/// The identity is the key that *matched*, not the first key in the list. Both are active here,
/// so a lookup that ignored the presented secret would answer `ak-1` and still satisfy a test
/// that only asserted `Some(_)`.
#[tokio::test(flavor = "multi_thread")]
async fn attribution_names_the_key_that_matched_not_the_first_one() {
    let s = start_with(Some(ak(&[("ak-1", "sk-aip-app1"), ("ak-2", "sk-aip-app2")])), None).await;
    assert_eq!(post_chat(&s, "sk-aip-app2").await.status(), 200);
    assert_eq!(s.bridge.app_key(0), Some(Some("ak-2".to_string())));
}

/// The master key is not a per-app key, so it has no `gateway_keys.id` to attribute spend to.
/// `None` is the honest answer; inventing an id here would bill a phantom app.
#[tokio::test(flavor = "multi_thread")]
async fn a_master_key_request_carries_no_app_key() {
    let s = start_with(Some(ak(&[("ak-1", "sk-aip-app1")])), None).await;
    assert_eq!(post_chat(&s, "sk-aip-master").await.status(), 200);
    assert_eq!(
        s.bridge.app_key(0),
        Some(None),
        "the master key authenticates without naming an app"
    );
}

/// A refused request must not be attributed at all — otherwise a typo'd credential would be
/// billed to whichever app happens to be listed first.
#[tokio::test(flavor = "multi_thread")]
async fn a_rejected_key_is_never_dispatched() {
    let s = start_with(Some(ak(&[("ak-1", "sk-aip-app1")])), None).await;
    assert_eq!(post_chat(&s, "not-a-key").await.status(), 401);
    assert_eq!(s.bridge.app_key(0), None, "nothing was dispatched, so nothing is attributable");
}

/// R4(a): revocation is immediate. The provider is re-read per request, so dropping a key
/// from the active list kills it on the NEXT request — no restart, no master rotation.
#[tokio::test(flavor = "multi_thread")]
async fn r4_revoked_app_key_rejected_immediately() {
    let keys = ak(&[("ak-1", "sk-aip-app1")]);
    let s = start_with(Some(keys.clone()), None).await;
    assert_eq!(post_chat(&s, "sk-aip-app1").await.status(), 200);
    keys.lock().unwrap().clear(); // == revoke
    assert_eq!(post_chat(&s, "sk-aip-app1").await.status(), 401);
    // The master key is untouched — revoking one consumer must not break the owner.
    assert_eq!(post_chat(&s, "sk-aip-master").await.status(), 200);
}

/// R4(a): an unrecognised key is still rejected when app keys are configured, and the
/// failure is recorded (so the brute-force backoff still applies).
#[tokio::test(flavor = "multi_thread")]
async fn r4_unknown_key_still_rejected() {
    let s = start_with(Some(ak(&[("ak-1", "sk-aip-app1")])), None).await;
    let res = post_chat(&s, "sk-aip-nope").await;
    assert_eq!(res.status(), 401);
    let body: Value = res.json().await.unwrap();
    assert_eq!(body["error"]["code"], "invalid_api_key");
}

// ---------- §4a: app-key principal (deferred from Phase 1) ----------
//
// The design blocked this on "a cached id→secret map" because otherwise resolving a presented
// key back to its id costs one keychain read per key *per request*. These tests pin the cache
// and, more importantly, that the cache does not break revocation.

/// A core with a real store and a provider shaped like the vault-backed one: it filters by
/// the active id set and counts every call.
///
/// The store is load-bearing, not incidental — it is the only thing that can say authorita-
/// tively whether the memo is still valid, and with no store nothing is cached at all.
fn key_core(
    tag: &str,
    keys: &[(&str, &str)],
) -> (Arc<GatewayCore>, Arc<AtomicUsize>, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("aip-appkey-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let store = Arc::new(crate::core::store::Store::open(&dir).unwrap());
    let reads = Arc::new(AtomicUsize::new(0));
    let (r, s2) = (reads.clone(), store.clone());
    let all: Vec<AppKey> =
        keys.iter().map(|(id, sec)| AppKey { id: (*id).into(), secret: (*sec).into() }).collect();
    let bridge = Arc::new(SynthBridge::new());
    let core = GatewayCore::new(bridge.clone(), Arc::new(|| Some("sk-aip-master".into())))
        .with_app_keys(Arc::new(move || {
            r.fetch_add(1, Ordering::SeqCst);
            let active = crate::core::persist::active_gateway_key_ids(&s2).unwrap_or_default();
            all.iter().filter(|k| active.contains(&k.id)).cloned().collect()
        }))
        .with_store(store);
    let core = Arc::new(core);
    (core, reads, dir)
}

/// The property the design was waiting for: N requests do not mean N keychain passes.
#[test]
fn the_app_key_map_is_read_once_not_once_per_request() {
    let (core, reads, dir) = key_core("memo", &[("ak-1", "sk-aip-app1")]);
    crate::core::persist::gateway_key_insert(core.store().unwrap(), "ak-1", "cursor").unwrap();
    assert_eq!(core.app_keys().len(), 1);
    assert_eq!(core.app_keys().len(), 1);
    assert_eq!(core.app_keys().len(), 1);
    assert_eq!(reads.load(Ordering::SeqCst), 1, "three requests, one keychain pass");
    let _ = std::fs::remove_dir_all(&dir);
}

/// The property that made a bare TTL cache wrong. Revocation takes effect on the very next
/// request today; a memo served purely on a timer would keep a revoked key authenticating for
/// the rest of its TTL, which is a security regression dressed as an optimisation.
#[test]
fn revoking_a_key_invalidates_the_memo_on_the_next_request() {
    let (core, reads, dir) = key_core("revoke", &[("ak-1", "sk-aip-app1")]);
    let store = core.store().unwrap();
    crate::core::persist::gateway_key_insert(store, "ak-1", "cursor").unwrap();
    assert_eq!(core.app_keys().len(), 1);
    assert_eq!(reads.load(Ordering::SeqCst), 1);

    crate::core::persist::gateway_key_revoke(store, "ak-1").unwrap();
    assert!(core.app_keys().is_empty(), "a revoked key must authenticate nobody");
    assert_eq!(reads.load(Ordering::SeqCst), 2, "the memo was not served");
    let _ = std::fs::remove_dir_all(&dir);
}

/// The mirror of the above: a newly created key works on the next request, which is the
/// contract `gateway_app_key_create` documents ("no provider refresh needed").
#[test]
fn creating_a_key_invalidates_the_memo_on_the_next_request() {
    let (core, _reads, dir) = key_core("create", &[("ak-1", "s1"), ("ak-2", "s2")]);
    let store = core.store().unwrap();
    crate::core::persist::gateway_key_insert(store, "ak-1", "one").unwrap();
    assert_eq!(core.app_keys().len(), 1);
    crate::core::persist::gateway_key_insert(store, "ak-2", "two").unwrap();
    assert_eq!(core.app_keys().len(), 2, "a new key authenticates on the very next request");
    let _ = std::fs::remove_dir_all(&dir);
}

/// The TTL is the backstop for the one case SQLite cannot see: a secret removed from the
/// keychain out from under an active row. An expired memo must not be served.
#[test]
fn the_memo_stops_being_served_once_its_ttl_expires() {
    let (core, reads, dir) = key_core("ttl", &[("ak-1", "sk-aip-app1")]);
    crate::core::persist::gateway_key_insert(core.store().unwrap(), "ak-1", "cursor").unwrap();
    core.set_app_key_cache_ttl(Duration::ZERO);
    assert_eq!(core.app_keys().len(), 1);
    assert_eq!(core.app_keys().len(), 1);
    assert_eq!(reads.load(Ordering::SeqCst), 2, "an expired memo is re-read, not served");
    let _ = std::fs::remove_dir_all(&dir);
}

/// No store means no authoritative id set, so nothing is memoised. This is what keeps
/// `r4_revoked_app_key_rejected_immediately` honest: that harness mutates the provider's vec
/// directly, and a cache would have masked the change.
#[test]
fn without_a_store_nothing_is_cached() {
    let reads = Arc::new(AtomicUsize::new(0));
    let r = reads.clone();
    let keys = ak(&[("ak-1", "sk-aip-app1")]);
    let bridge = Arc::new(SynthBridge::new());
    let core = GatewayCore::new(bridge.clone(), Arc::new(|| Some("sk-aip-master".into())))
        .with_app_keys(Arc::new(move || {
            r.fetch_add(1, Ordering::SeqCst);
            keys.lock().unwrap().clone()
        }));
    let core = Arc::new(core);
    assert_eq!(core.app_keys().len(), 1);
    assert_eq!(core.app_keys().len(), 1);
    assert_eq!(reads.load(Ordering::SeqCst), 2, "never cache what cannot be validated");
}

#[test]
fn a_presented_key_resolves_to_its_id_and_a_strange_one_to_nothing() {
    let (core, _reads, dir) = key_core("resolve", &[("ak-1", "s1"), ("ak-2", "s2")]);
    let store = core.store().unwrap();
    crate::core::persist::gateway_key_insert(store, "ak-1", "one").unwrap();
    crate::core::persist::gateway_key_insert(store, "ak-2", "two").unwrap();
    // Deliberately not the first entry: resolution must not depend on position.
    assert_eq!(core.app_key_for("s2").as_deref(), Some("ak-2"));
    assert_eq!(core.app_key_for("s1").as_deref(), Some("ak-1"));
    assert_eq!(core.app_key_for("nope"), None);
    assert_eq!(core.app_key_for(""), None, "no credential presented means no key identity");
    let _ = std::fs::remove_dir_all(&dir);
}

/// Pins the no-early-break rule observably. Two candidates sharing a secret cannot both win:
/// a `find` (first match, then stop) answers `ak-1`, a scan that runs to completion answers
/// `ak-2`. That makes this the one assertion that can see the difference — the property it
/// exists for is timing, and timing is not assertable.
#[test]
fn resolving_a_key_scans_every_candidate_rather_than_stopping_at_the_first() {
    let (core, _reads, dir) = key_core("scan", &[("ak-1", "shared"), ("ak-2", "shared")]);
    let store = core.store().unwrap();
    crate::core::persist::gateway_key_insert(store, "ak-1", "one").unwrap();
    crate::core::persist::gateway_key_insert(store, "ak-2", "two").unwrap();
    assert_eq!(core.app_key_for("shared").as_deref(), Some("ak-2"), "the scan runs to the end");
    let _ = std::fs::remove_dir_all(&dir);
}

/// The master key is the caller most operators actually hand out, so it needs a name of its
/// own. Resolving it to `None` would leave the busiest caller unnameable — no policy row could
/// reach it, and absence inherits, so it would be allowed whatever the operator had decided
/// for everyone else.
#[test]
fn the_master_key_resolves_to_its_own_principal() {
    let (core, _reads, dir) = key_core("master-principal", &[("ak-1", "sk-aip-app1")]);
    crate::core::persist::gateway_key_insert(core.store().unwrap(), "ak-1", "an ide").unwrap();
    let mk = super::principal::master_principal();

    assert_eq!(core.key_principal_for("sk-aip-master").as_deref(), Some(mk.as_str()));
    // An app key still resolves to its own id — the master key does not shadow it.
    assert_eq!(core.key_principal_for("sk-aip-app1").as_deref(), Some("key:ak-1"));
    // A secret we do not recognise names nobody, and an absent key is not a lookup at all.
    assert_eq!(core.key_principal_for("sk-aip-nope"), None);
    assert_eq!(core.key_principal_for(""), None);
    let _ = std::fs::remove_dir_all(&dir);
}

/// R4(a): the backoff window opened by a bad credential must not throttle a caller that
/// authenticates correctly — otherwise one misconfigured app DoSes the rest for 500ms+
/// per failure. It must still throttle a *second* bad attempt inside the window.
#[tokio::test(flavor = "multi_thread")]
async fn r4_valid_key_not_throttled_by_another_callers_failures() {
    let s = start_with(None, None).await;
    assert_eq!(post_chat(&s, "wrong").await.status(), 401);
    assert_eq!(post_chat(&s, "wrong").await.status(), 429, "repeat failures are throttled");
    // The load-bearing assertion: inside an open backoff window a *correct* key still
    // gets through (and, by clearing the counter, closes the window).
    assert_eq!(post_chat(&s, "sk-aip-master").await.status(), 200);
    assert_eq!(post_chat(&s, "wrong").await.status(), 401, "success resets the counter");
}

/// H2, re-scoped: how far the merged backoff bucket actually reaches.
///
/// Two *separate* clients, both presenting bad keys — the second inherits the first's window,
/// so its very first failure answers 429 rather than 401. That is the whole of the merging.
/// A caller with a valid key is never throttled (see
/// `r4_valid_key_not_throttled_by_another_callers_failures`): `auth_allowed` is consulted only
/// after the key has already failed to match, so the window cannot touch a good credential.
/// The audit's claim that "one misconfigured consumer locks out all other consumers" is
/// therefore false, and this test is the evidence.
#[tokio::test(flavor = "multi_thread")]
async fn a_second_failing_caller_inherits_the_first_callers_window() {
    let s = start_with(None, None).await;
    let other = reqwest::Client::new();
    let post = |c: &reqwest::Client, bearer: &str| {
        c.post(format!("{}/v1/chat/completions", s.base))
            .header("authorization", format!("Bearer {bearer}"))
            .json(&chat_body(false))
            .send()
    };
    assert_eq!(post(&s.client, "wrong").await.unwrap().status(), 401);
    assert_eq!(post(&s.client, "wrong").await.unwrap().status(), 429, "window opens");
    // Different client, different connection, same bucket: its first failure is throttled too.
    assert_eq!(
        post(&other, "wrong").await.unwrap().status(),
        429,
        "a second caller shares the bucket — this is H2 in full"
    );
    // ...but a good key still gets through from either client, which is why H2 is not a lockout.
    assert_eq!(post(&other, "sk-aip-master").await.unwrap().status(), 200);
}

/// Invariant 11, pinned: the listener binds loopback only.
///
/// This is *what makes* a single backoff bucket defensible — every peer really is 127.0.0.1, so
/// `peer_ip()` returning LOCALHOST is correct today rather than a bug. It becomes a bug the
/// moment the bind widens, at which point one bucket would merge genuinely distinct clients.
/// Fail here rather than let that change land silently.
#[tokio::test(flavor = "multi_thread")]
async fn the_listener_binds_loopback_only() {
    let master = Arc::new(Mutex::new(Some("sk-aip-master".to_string())));
    let (core, _bridge) = core_with(master, None, None);
    core.set_running(true);
    let handle = spawn(core.clone(), 0).await.expect("bind ephemeral");
    assert!(
        handle.addr.ip().is_loopback(),
        "peer_ip() assumes every peer is loopback, but the server bound {}",
        handle.addr
    );
}

/// R4(b): at or over the cap the gateway refuses with 402 instead of spending more.
#[tokio::test(flavor = "multi_thread")]
async fn r4_spend_cap_blocks_at_threshold() {
    let s = start_with(None, Some(Arc::new(Mutex::new((50, 50))))).await;
    let res = post_chat(&s, "sk-aip-master").await;
    assert_eq!(res.status(), 402);
    let body: Value = res.json().await.unwrap();
    assert_eq!(body["error"]["type"], "insufficient_quota");
    assert_eq!(body["error"]["code"], "spend_cap_exceeded");
}

/// R4(b): strictly under the cap the request proceeds — the gate must not be off-by-one.
#[tokio::test(flavor = "multi_thread")]
async fn r4_spend_cap_allows_under_threshold() {
    let s = start_with(None, Some(Arc::new(Mutex::new((49, 50))))).await;
    assert_eq!(post_chat(&s, "sk-aip-master").await.status(), 200);
}

/// R4(b): cap 0 means disabled, not "zero budget" — otherwise enabling the feature with a
/// cleared field would brick the gateway.
#[tokio::test(flavor = "multi_thread")]
async fn r4_spend_cap_zero_disables() {
    let s = start_with(None, Some(Arc::new(Mutex::new((999_999, 0))))).await;
    assert_eq!(post_chat(&s, "sk-aip-master").await.status(), 200);
}

/// R4(b): the cap is checked after auth, so an unauthenticated caller gets 401 — never a
/// 402 that would disclose the configured budget and current spend.
#[tokio::test(flavor = "multi_thread")]
async fn r4_spend_cap_not_disclosed_to_unauthenticated() {
    let s = start_with(None, Some(Arc::new(Mutex::new((500, 50))))).await;
    let res = post_chat(&s, "wrong-key").await;
    assert_eq!(res.status(), 401, "spend state must not leak pre-auth");
}

// ---------- 0017: per-app budgets ----------
//
// The global cap bounds what the owner pays. These four cover the narrower instrument: one app's
// slice. They are deliberately cross-checked, because the interesting failure is not "a cap was
// ignored" — it is "the wrong cap was applied to the wrong caller", which every single-sided
// assertion passes.

/// The property the feature exists for: one app reaching its budget must not stop any other app,
/// and must not stop the owner. A gate that refused everything once any app was capped would
/// satisfy a test that only checked the refusal.
#[tokio::test(flavor = "multi_thread")]
async fn a_per_app_cap_refuses_only_the_app_that_reached_it() {
    let s = start_with_spend(
        Some(ak(&[("ak-1", "sk-aip-app1"), ("ak-2", "sk-aip-app2")])),
        Arc::new(|app: Option<&str>| SpendLimits {
            total_micros: 0,
            total_cap_micros: 0, // no global cap in play
            app_micros: Some(50),
            app_cap_micros: if app == Some("ak-1") { Some(50) } else { None },
        }),
    )
    .await;

    let refused = post_chat(&s, "sk-aip-app1").await;
    assert_eq!(refused.status(), 402, "the app at its budget is refused");
    let body: Value = refused.json().await.unwrap();
    assert_eq!(body["error"]["type"], "insufficient_quota");
    assert_eq!(
        body["error"]["code"], "app_budget_exceeded",
        "a per-app refusal must name itself, not the global cap"
    );

    assert_eq!(
        post_chat(&s, "sk-aip-app2").await.status(),
        200,
        "one app's budget must not close another's"
    );
    assert_eq!(
        post_chat(&s, "sk-aip-master").await.status(),
        200,
        "nor the owner's — the master key has no app budget to exhaust"
    );
}

/// The two limits are independent, and this is the case that proves it: the global cap is spent
/// while this app is far under its own. A gate that computed a single binding limit (say, the
/// smaller of the two) would let this request through, because the app's own numbers look fine.
#[tokio::test(flavor = "multi_thread")]
async fn the_global_cap_refuses_an_app_that_is_under_its_own_cap() {
    let s = start_with_spend(
        Some(ak(&[("ak-1", "sk-aip-app1")])),
        Arc::new(|_app: Option<&str>| SpendLimits {
            total_micros: 900,
            total_cap_micros: 900, // the owner's budget is gone
            app_micros: Some(1),
            app_cap_micros: Some(1_000_000), // this app has barely spent anything
        }),
    )
    .await;

    let res = post_chat(&s, "sk-aip-app1").await;
    assert_eq!(res.status(), 402);
    let body: Value = res.json().await.unwrap();
    assert_eq!(
        body["error"]["code"], "spend_cap_exceeded",
        "the refusal must name the limit that actually bound, or the operator raises the wrong one"
    );
}

/// An app that was never given a budget is governed by the global cap alone.
///
/// This pins the **property**, not one mechanism. Measured while falsifying it: `spend_gate` has
/// two independent guards here — the `Some/Some` destructure and a `cap > 0` test — and removing
/// either *alone* leaves this test passing. Collapsing the pair to `app_cap_micros.unwrap_or(0)`
/// **and** dropping the `cap > 0` test together is what refuses every uncapped app: a total outage
/// from a plausible tidy-up, and one that a test asserting only the capped case would never see.
/// That pairing is the probe; a single-site probe cannot demonstrate teeth here, and pretending
/// otherwise would be recording a mechanism that does not exist.
#[tokio::test(flavor = "multi_thread")]
async fn an_app_with_no_cap_is_governed_only_by_the_global_cap() {
    let s = start_with_spend(
        Some(ak(&[("ak-1", "sk-aip-app1")])),
        Arc::new(|_app: Option<&str>| SpendLimits {
            total_micros: 10,
            total_cap_micros: 1_000, // global cap is fine
            app_micros: Some(999_999),
            app_cap_micros: None, // never budgeted
        }),
    )
    .await;

    assert_eq!(
        post_chat(&s, "sk-aip-app1").await.status(),
        200,
        "no per-app cap means no per-app refusal"
    );
}

/// The gate must be asked about the caller that **authenticated**, not about whatever key happens
/// to be first. Asserted on the recorded argument rather than on a status code: a gate handed the
/// wrong id still answers 200 here, so only the argument can tell the two apart.
#[tokio::test(flavor = "multi_thread")]
async fn the_gate_is_asked_about_the_caller_that_authenticated() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let s = start_with_spend(
        Some(ak(&[("ak-1", "sk-aip-app1"), ("ak-2", "sk-aip-app2")])),
        recording_spend(calls.clone(), |_app| SpendLimits::default()),
    )
    .await;

    assert_eq!(post_chat(&s, "sk-aip-app2").await.status(), 200);
    assert_eq!(
        calls.lock().unwrap().as_slice(),
        &[Some("ak-2".to_string())],
        "the second key authenticated, so the second key's budget is the one to check"
    );

    calls.lock().unwrap().clear();
    assert_eq!(post_chat(&s, "sk-aip-master").await.status(), 200);
    assert_eq!(
        calls.lock().unwrap().as_slice(),
        &[None],
        "the master key names no app, so there is no per-app budget to consult"
    );
}

// ---------- the request gate (25f) ----------

/// **The R1 liveness suite is gone, and this is what replaced it.**
///
/// Three tests used to sit here — `r1_hidden_loosens_the_heartbeat_bound`,
/// `r1_entering_background_stamps_the_heartbeat` and `r1_leaving_background_restores_the_tight_bound`.
/// All three measured the webview worker's heartbeat against two bounds, and 25f deleted the webview.
///
/// What is left is one gate — whether the operator asked the gateway to serve — and **two** refusals
/// that answer it. They are not the same refusal, and the difference was measured rather than
/// assumed:
///
/// - `check_gateway_key` (`gateway.rs:1389`) refuses a stopped gateway first, before any handler
///   reaches `try_slot`. That is what a client actually experiences.
/// - `try_slot` (`gateway.rs:1280`) refuses again. In production that one is reachable only through
///   a race — the auth gate reads `running`, the operator presses Stop, the slot gate reads it
///   again — which is narrow but real: the alternative to refusing there is dispatching into a
///   gateway the operator just stopped.
///
/// **A probe is why there are two tests rather than one.** Inserting `sleep(5s)` before `try_slot`'s
/// refusal left the end-to-end test below green in 0.02 s, because the auth gate answered first. A
/// timing assertion taken only through the request path therefore pins the auth gate and says
/// nothing at all about the slot gate.
#[tokio::test(flavor = "multi_thread")]
async fn a_stopped_gateway_is_refused_without_waiting_for_a_bridge() {
    let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let s = start(key).await;
    s.core.set_running(false);

    let started = std::time::Instant::now();
    let res = post_chat(&s, "sk-aip-test").await;
    let elapsed = started.elapsed();

    assert_eq!(res.status(), 503);
    assert_eq!(
        res.headers().get("retry-after").and_then(|v| v.to_str().ok()),
        Some("1"),
        "a stopped gateway is retryable, and the hint says so"
    );
    // The deleted path waited out `CORE_RECOVERY_GRACE` (5s) before answering. One second is a
    // generous ceiling for a local refusal and still an order of magnitude below it.
    assert!(elapsed < Duration::from_secs(1), "refused in {elapsed:?}, not waited out");
}

/// The slot gate's own refusal, driven directly — the half the request path cannot see.
///
/// Without this, `try_slot`'s stopped-branch would be asserted only indirectly, by a test the auth
/// gate answers first. This calls `try_slot` with nothing in front of it, so the refusal under test
/// is unambiguous. (It is callable from here because `gateway_tests.rs` is included as a child
/// module of `gateway` via `#[path]`.)
///
/// Falsified before it was trusted: `sleep(5s)` inserted before the refusal reddens this test, and
/// leaves the end-to-end test above green — which is the measurement the note above records.
#[tokio::test(flavor = "multi_thread")]
async fn the_slot_gate_refuses_a_stopped_core_without_waiting() {
    let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let s = start(key).await;
    s.core.set_running(false);

    let started = std::time::Instant::now();
    let refused = try_slot(&s.core).await;
    let elapsed = started.elapsed();

    let resp = refused.err().expect("a stopped core is refused by the slot gate");
    assert_eq!(resp.status(), 503);
    assert!(elapsed < Duration::from_secs(1), "refused in {elapsed:?}, not waited out");
}

/// R4(b): no provider attached == uncapped. Guards the builder contract that every
/// pre-R4 test relies on.
#[test]
fn r4_uncapped_without_provider() {
    let core = GatewayCore::new(Arc::new(SynthBridge::new()), Arc::new(|| Some("k".to_string())));
    assert!(spend_gate(&core, None).is_none());
    // And still uncapped when the caller names an app: with no provider there is nothing to ask,
    // so a per-app request must not be refused by a gate that has no numbers.
    assert!(spend_gate(&core, Some("ak-1")).is_none());
}

/// Phase 5: JSON 404 for unknown /v1/* routes
#[tokio::test(flavor = "multi_thread")]
async fn catch_all_unknown_route_returns_json_404() {
    let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let s = start(key).await;
    let res = s
        .client
        .post(format!("{}/v1/unknown/path", s.base))
        .header("authorization", "Bearer sk-aip-test")
        .header("content-type", "application/json")
        .body(r#"{"model":"gpt-4"}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 404);
    let body: Value = res.json().await.unwrap();
    assert_eq!(body["error"]["type"], "not_found");
    assert_eq!(body["error"]["code"], "unknown_route");
}

// ---------- tool calls: pass-through (2026-09-18) ----------
//
// These lock in the rule that ended double execution: when the client declares the tools,
// the gateway hands the calls back and ends the request. It does NOT also run them, and
// it does not wait for anything — the request must terminate.

#[tokio::test(flavor = "multi_thread")]
async fn pass_through_stream_emits_tool_calls_then_ends() {
    let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let s = start(key).await;
    s.bridge.answer_with_tool_calls(true);
    let res = s
        .client
        .post(format!("{}/v1/chat/completions", s.base))
        .header("authorization", "Bearer sk-aip-test")
        .json(&chat_body(true))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let mut stream = res.bytes_stream();
    let mut acc = String::new();
    // Drain to EOF: if the handler waited on a bridge that went off to execute tools,
    // this would never return.
    while let Some(chunk) = stream.next().await {
        acc.push_str(&String::from_utf8_lossy(&chunk.unwrap()));
    }
    assert!(acc.contains("\"tool_calls\""), "client must receive the calls: {acc}");
    assert!(acc.contains("finish_reason"), "{acc}");
    assert!(acc.contains("write_file"), "call payload must survive: {acc}");
    // A pass-through turn ends on the tool calls, never on a normal stop finish.
    assert!(!acc.contains("\"finish_reason\":\"stop\""), "must not also emit a stop finish: {acc}");
}

#[tokio::test(flavor = "multi_thread")]
async fn pass_through_non_stream_returns_tool_calls() {
    let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let s = start(key).await;
    s.bridge.answer_with_tool_calls(true);
    let res = s
        .client
        .post(format!("{}/v1/chat/completions", s.base))
        .header("authorization", "Bearer sk-aip-test")
        .json(&chat_body(false))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let body: Value = res.json().await.unwrap();
    assert_eq!(body["choices"][0]["finish_reason"], "tool_calls");
    assert_eq!(body["choices"][0]["message"]["tool_calls"][0]["function"]["name"], "write_file");
    assert_eq!(body["choices"][0]["message"]["role"], "assistant");
}

// ---------- Anthropic streaming: a tool turn must still terminate (2026-09-22) ----------
//
// Claude Code reads `stop_reason: "tool_use"` on `message_delta` to decide whether to run
// tools, and waits for `message_stop` before it considers the turn over. The stream used to
// skip both whenever tool calls were present, so the very turn that needed a round-trip was
// the one that never announced it — the agent loop stopped after a single step.

#[tokio::test(flavor = "multi_thread")]
async fn anthropic_stream_tool_turn_stops_with_tool_use() {
    let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let s = start(key).await;
    s.bridge.answer_with_tool_calls(true);
    let res = s
        .client
        .post(format!("{}/v1/messages", s.base))
        .header("x-api-key", "sk-aip-test")
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&json!({ "model": "mock-fast", "max_tokens": 64, "stream": true,
                "tools": [{ "name": "Bash", "description": "Run it",
                            "input_schema": { "type": "object", "properties": {} } }],
                "messages": [{ "role": "user", "content": "hi" }] }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    assert_eq!(res.headers()["content-type"], "text/event-stream");
    let mut stream = res.bytes_stream();
    let mut acc = String::new();
    while let Some(chunk) = stream.next().await {
        acc.push_str(&String::from_utf8_lossy(&chunk.unwrap()));
    }
    // Parse the SSE payloads instead of substring-matching them: `serde_json` emits object
    // keys in sorted order, so a raw-string assertion binds the test to key ordering
    // rather than to what the events mean.
    let events: Vec<Value> = acc
        .lines()
        .filter_map(|l| l.strip_prefix("data: "))
        .filter_map(|d| serde_json::from_str::<Value>(d).ok())
        .collect();
    assert!(
        events.iter().any(|e| e["content_block"]["type"] == "tool_use"),
        "the call must reach the client: {acc}"
    );
    // The text block opened at index 0 must be closed, or the client's parser waits for a
    // stop that never arrives.
    assert!(
        events.iter().any(|e| e["type"] == "content_block_stop" && e["index"] == 0),
        "the text block must be closed: {acc}"
    );
    assert!(
        events.iter().any(|e| e["delta"]["stop_reason"] == "tool_use"),
        "the client needs this to know a round-trip is required: {acc}"
    );
    assert!(
        events.iter().any(|e| e["type"] == "message_stop"),
        "the turn must be terminated: {acc}"
    );
}

/// Asserts on the body handed to the worker, not on the ingress body: every dialect is
/// translated twice, and a block can be dropped at either hop.
#[tokio::test(flavor = "multi_thread")]
async fn anthropic_tool_transcript_reaches_the_worker_intact() {
    let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let s = start(key).await;
    let res = s
            .client
            .post(format!("{}/v1/messages", s.base))
            .header("x-api-key", "sk-aip-test")
            .header("content-type", "application/json")
            .json(&json!({
                "model": "mock-fast", "max_tokens": 64,
                "tools": [{ "name": "Bash", "description": "Run it",
                            "input_schema": { "type": "object", "properties": { "command": { "type": "string" } } } }],
                "messages": [
                    { "role": "user", "content": [{ "type": "text", "text": "fix the test" }] },
                    { "role": "assistant", "content": [
                        { "type": "text", "text": "Let me look" },
                        { "type": "tool_use", "id": "toolu_1", "name": "Bash", "input": { "command": "ls" } } ] },
                    { "role": "user", "content": [
                        { "type": "tool_result", "tool_use_id": "toolu_1", "content": "3 files" } ] }
                ] }))
            .send()
            .await
            .unwrap();
    assert_eq!(res.status(), 200);
    let sent = s.bridge.sent(0).expect("a dispatch");
    let msgs = sent.1["messages"].as_array().expect("messages").clone();
    assert_eq!(msgs.len(), 3, "one message per turn: {msgs:?}");
    assert_eq!(msgs[1]["role"], "assistant");
    assert_eq!(msgs[1]["tool_calls"][0]["id"], "toolu_1");
    assert_eq!(msgs[1]["tool_calls"][0]["function"]["name"], "Bash");
    assert_eq!(msgs[2]["role"], "tool");
    assert_eq!(msgs[2]["tool_call_id"], "toolu_1");
    assert_eq!(msgs[2]["content"], "3 files", "the result must reach the model: {msgs:?}");
    // The empty user turn this used to emit is what made providers reject the body outright.
    assert!(
        !msgs.iter().any(|m| m["role"] == "user" && m["content"] == ""),
        "no empty user turn: {msgs:?}"
    );
}

/// The Responses counterpart of the Anthropic case: what reaches the worker, not the ingress
/// body. Also pins the tool shape, which is the half of this dialect that is only visible
/// after translation.
#[tokio::test(flavor = "multi_thread")]
async fn responses_tool_transcript_reaches_the_worker_intact() {
    let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let s = start(key).await;
    let res = s
            .client
            .post(format!("{}/v1/responses", s.base))
            .header("authorization", "Bearer sk-aip-test")
            .header("content-type", "application/json")
            .json(&json!({
                "model": "mock-fast",
                "tools": [{ "type": "function", "name": "Bash", "description": "Run it",
                            "parameters": { "type": "object", "properties": { "command": { "type": "string" } } } }],
                "input": [
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "fix it" }] },
                    { "type": "function_call", "call_id": "call_1", "name": "Bash", "arguments": "{\"command\":\"ls\"}" },
                    { "type": "function_call_output", "call_id": "call_1", "output": "3 files" }
                ] }))
            .send()
            .await
            .unwrap();
    assert_eq!(res.status(), 200);
    let sent = s.bridge.sent(0).expect("a dispatch");
    let msgs = sent.1["messages"].as_array().expect("messages").clone();
    assert_eq!(msgs.len(), 3, "one message per item-turn: {msgs:?}");
    assert_eq!(msgs[1]["role"], "assistant");
    assert_eq!(msgs[1]["tool_calls"][0]["id"], "call_1");
    assert_eq!(msgs[1]["tool_calls"][0]["function"]["name"], "Bash");
    assert_eq!(msgs[2]["role"], "tool");
    assert_eq!(msgs[2]["tool_call_id"], "call_1");
    assert_eq!(msgs[2]["content"], "3 files", "the result must reach the model: {msgs:?}");
    // The FLAT Responses tool shape must not reach a chat-completions provider.
    assert_eq!(sent.1["tools"][0]["function"]["name"], "Bash", "{:?}", sent.1["tools"]);
    assert!(
        sent.1["tools"][0].get("name").is_none(),
        "flat shape must not survive: {:?}",
        sent.1["tools"]
    );
}

/// The bridge's only backpressure signal. Without it, a request whose client has gone
/// keeps streaming — and in a tool loop, keeps buying tokens — forever.
#[test]
fn reply_reports_when_nobody_is_listening() {
    let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let (core, _bridge) = test_core(key);
    assert!(
        !core.reply(999_999, BridgeMsg::Delta("x".into())),
        "delivering to an unknown request must report failure"
    );
    assert!(!core.reply(999_999, BridgeMsg::Done));
}

/// A write-capable sandbox must not silently default to the whole home directory or to
/// the process working directory (which is `/` for a Finder-launched app).
#[test]
fn default_workspace_root_is_a_dedicated_folder() {
    let root = default_workspace_root().expect("HOME should be set");
    let home = std::path::PathBuf::from(std::env::var("HOME").unwrap());
    assert!(root.starts_with(&home), "{root:?} must live under home");
    assert_ne!(root, home, "must not hand the model the whole home directory");
    assert!(root.is_dir(), "workspace folder must exist");
}

#[test]
fn a_fresh_core_uses_the_safe_workspace_default() {
    let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let (core, _bridge) = test_core(key);
    let root = core.workspace_root().expect("default workspace root");
    assert_eq!(root, default_workspace_root().unwrap());
}

/// Tools are on by default. Off is opt-in because stripping `tools` / `tool_choice` /
/// `response_format` breaks every coding agent that connects.
#[test]
fn tools_are_enabled_by_default() {
    let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let (core, _bridge) = test_core(key);
    assert!(core.is_tools_enabled(), "gateway tools must default to on");
    // And the toggle still works both ways.
    core.set_tools_enabled(false);
    assert!(!core.is_tools_enabled());
    core.set_tools_enabled(true);
    assert!(core.is_tools_enabled());
}

// --- audit H1b: gateway-side mutation is opt-in ---
//
// The Assistant has a per-call Allow/Deny modal; the gateway has no UI at all, so a model
// driven by untrusted content can write files and run code there with nobody watching.
// Read-only tools stay on; mutation defaults off and is enforced host-side.

#[test]
fn mutation_is_disabled_by_default() {
    let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let (core, _bridge) = test_core(key);
    assert!(
        !core.is_tools_mutation_enabled(),
        "gateway mutation must default to off — there is no confirmation on that path"
    );
}

#[test]
fn mutating_tools_are_refused_while_read_only_still_works() {
    let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let (core, _bridge) = test_core(key);
    for tool in ["write_file", "run_command"] {
        assert!(core.gateway_tool_refusal(tool).is_some(), "{tool} must be refused by default");
    }
    for tool in ["read_file", "list_dir"] {
        assert!(
            core.gateway_tool_refusal(tool).is_none(),
            "{tool} is read-only and must stay available"
        );
    }
}

#[test]
fn enabling_mutation_lifts_the_refusal() {
    let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let (core, _bridge) = test_core(key);
    core.set_tools_mutation_enabled(true);
    assert!(core.is_tools_mutation_enabled());
    for tool in ["write_file", "run_command", "read_file", "list_dir"] {
        assert!(
            core.gateway_tool_refusal(tool).is_none(),
            "{tool} must be allowed once mutation is enabled"
        );
    }
    core.set_tools_mutation_enabled(false);
    assert!(core.gateway_tool_refusal("run_command").is_some());
}

#[test]
fn the_refusal_message_tells_the_model_what_to_do() {
    let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let (core, _bridge) = test_core(key);
    let reason = core.gateway_tool_refusal("run_command").unwrap();
    assert!(reason.contains("run_command"), "name the tool: {reason}");
    // A model told only "forbidden" retries the call. It needs the way out.
    assert!(reason.contains("Gateway settings"), "say how to enable it: {reason}");
    assert!(reason.contains("Assistant"), "offer the confirmed path: {reason}");
}

#[cfg(feature = "app")]
/// A bound socket and a gateway that is meant to be serving are different states — but the
/// difference that matters is *operator intent*, and after 25f that is the only input there is.
///
/// This test used to assert the opposite for the lapsed case, because a lapsed beat was the only
/// signal available and tearing the listener down was how Start recovered from it. Two later changes
/// removed the middle case entirely: the watchdog stopped pre-warming, and 25f deleted the webview
/// whose heartbeat "lapsed" described. What is left is the state that genuinely needs rebuilding —
/// a listener that outlived the operator's intent, because nothing else will ever tear it down.
#[test]
fn a_bound_listener_is_stale_only_when_serving_was_never_asked_for() {
    use crate::tauri::gateway_cmds::GatewayState;
    let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let (core, _bridge) = test_core(key);
    let (store, _dir) = gateway_test_store("stale-listener");
    let state = GatewayState { core: core.clone(), server: Mutex::new(None), store };

    // Nothing bound: not stale, just stopped.
    assert!(!state.has_stale_server());

    let (tx, _rx) = tokio::sync::oneshot::channel::<()>();
    *state.server.lock().unwrap() =
        Some(ServerHandle { shutdown: tx, addr: "127.0.0.1:0".parse().unwrap() });
    core.set_running(true);
    assert!(!state.has_stale_server(), "a listener the operator asked for is not stale");

    // A listener that outlived the operator's intent is the case that needs rebuilding.
    core.set_running(false);
    assert!(state.has_stale_server(), "bound but not running is stale");
}

/// A bridge that stops answering must fail the request, not hold the socket open.
///
/// This was written for an OS-suspended webview: the beat was fresh when the request was admitted,
/// so nothing looked stale — the reply simply never arrived. 25f deleted the webview and the
/// `FIRST_MSG_TIMEOUT` bound survived it, because the property it pins is not about a webview: a
/// bridge that accepts a dispatch and never writes to its `ReplyHandle` would otherwise hold the
/// socket open with nothing logged, which presents as a mysterious hang rather than an error. The
/// suspected cause is now a bug in the router loop, and the client-visible message says what was
/// observed rather than guessing at which.
#[tokio::test(flavor = "multi_thread")]
async fn a_silent_worker_fails_the_request_instead_of_hanging() {
    let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let s = start(key).await;
    s.core.set_first_msg_timeout(Duration::from_millis(300));
    s.bridge.go_silent(true);

    let started = std::time::Instant::now();
    let res = s
        .client
        .post(format!("{}/v1/chat/completions", s.base))
        .header("authorization", "Bearer sk-aip-test")
        .json(&chat_body(false))
        .send()
        .await
        .expect("a silent worker must still be answered, not hang");
    let elapsed = started.elapsed();

    assert_eq!(res.status(), 503, "no answer is unavailable, not an empty success");
    assert_eq!(
        res.headers().get("retry-after").and_then(|v| v.to_str().ok()),
        Some("1"),
        "the client is told it is worth retrying"
    );
    assert!(elapsed < Duration::from_secs(5), "answered in {elapsed:?}");
}

/// A running server whose master-key lookup and key wait the test supplies, so a stalled
/// keychain can be reproduced and the number of lookups counted.
async fn start_with_key_lookup(lookup: KeyProvider, wait: Duration) -> TestServer {
    let bridge = Arc::new(SynthBridge::new());
    let core = Arc::new(GatewayCore::new_with_key_wait(bridge.clone(), lookup, wait));
    core.set_running(true);
    let handle = spawn(core.clone(), 0).await.expect("bind ephemeral");
    TestServer {
        client: reqwest::Client::new(),
        base: format!("http://{}", handle.addr),
        core,
        bridge,
        _handle: handle,
    }
}

/// A keychain that never answers must not take the HTTP surface with it.
///
/// This is what a reinstall produces: it invalidates the item's ACL, so the next read waits on
/// a SecurityAgent prompt. The read used to happen inline on every request with no bound, so
/// one stalled keychain wedged everything — the listener kept accepting connections and never
/// answered one, `/v1/models` included, with nothing logged because the failure was a hang
/// rather than an error.
#[tokio::test(flavor = "multi_thread")]
async fn a_stalled_keychain_answers_503_instead_of_hanging() {
    let calls = Arc::new(AtomicUsize::new(0));
    let seen = calls.clone();
    let s = start_with_key_lookup(
        Arc::new(move || {
            seen.fetch_add(1, Ordering::SeqCst);
            std::thread::sleep(Duration::from_secs(30));
            Some("sk-aip-test".to_string())
        }),
        Duration::from_millis(200),
    )
    .await;

    let started = std::time::Instant::now();
    let res = tokio::time::timeout(
        Duration::from_secs(10),
        s.client
            .get(format!("{}/v1/models", s.base))
            .header("authorization", "Bearer sk-aip-test")
            .send(),
    )
    .await
    .expect("the gateway must answer while the keychain is stalled — it hung instead")
    .expect("request failed");
    let elapsed = started.elapsed();

    assert_eq!(res.status(), 503, "an unreadable key is unavailable, not invalid");
    let body: Value = res.json().await.unwrap();
    assert_eq!(body["error"]["type"], "service_unavailable");
    assert!(elapsed < Duration::from_secs(5), "answered in {elapsed:?}");
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "a stalled keychain must not be re-read once per request"
    );
}

/// The keychain is consulted once, not once per request. Reading it per request was what made
/// rotation instant, and that is now the cache's generation stamp instead.
#[tokio::test(flavor = "multi_thread")]
async fn the_master_key_is_read_once_not_once_per_request() {
    let calls = Arc::new(AtomicUsize::new(0));
    let seen = calls.clone();
    let s = start_with_key_lookup(
        Arc::new(move || {
            seen.fetch_add(1, Ordering::SeqCst);
            Some("sk-aip-test".to_string())
        }),
        Duration::from_millis(500),
    )
    .await;

    for _ in 0..3 {
        let res = s
            .client
            .get(format!("{}/v1/models", s.base))
            .header("authorization", "Bearer sk-aip-test")
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
    }
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "three requests must not mean three keychain reads"
    );
}

/// Concurrent callers share one in-flight read. Without this, a stalled keychain would park
/// one thread per request instead of one in total — and nothing can cancel a blocking
/// `SecKeychainFindGenericPassword`.
#[tokio::test(flavor = "multi_thread")]
async fn concurrent_requests_share_a_single_keychain_read() {
    let calls = Arc::new(AtomicUsize::new(0));
    let seen = calls.clone();
    let s = start_with_key_lookup(
        Arc::new(move || {
            seen.fetch_add(1, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(400));
            Some("sk-aip-test".to_string())
        }),
        Duration::from_secs(5),
    )
    .await;

    let requests = (0..8).map(|_| {
        s.client
            .get(format!("{}/v1/models", s.base))
            .header("authorization", "Bearer sk-aip-test")
            .send()
    });
    for r in futures_util::future::join_all(requests).await {
        assert_eq!(r.unwrap().status(), 200);
    }
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "eight concurrent requests must share one keychain read"
    );
}

/// `Unavailable` and `Absent` must not collapse into each other.
///
/// The first means "the keychain did not answer"; the second means "no key has been
/// configured". Both used to be `None`, and the request path reported both as 401 — telling a
/// correctly-configured client that its credential was wrong.
#[test]
fn an_unanswered_keychain_is_not_reported_as_a_missing_key() {
    let absent = MasterKeyCache::new(Arc::new(|| None), Duration::from_millis(500));
    assert_eq!(absent.get(), MasterKeyLookup::Absent);

    let stalled = MasterKeyCache::new(
        Arc::new(|| {
            std::thread::sleep(Duration::from_secs(30));
            Some("sk-aip-test".to_string())
        }),
        Duration::from_millis(150),
    );
    assert_eq!(stalled.get(), MasterKeyLookup::Unavailable);
}

/// A rotation that lands while the first load is still in flight must yield the NEW key.
///
/// Reading the generation once, up front, made this request answer `Unavailable` instead:
/// the load it was waiting on finished stamped with the generation it started under, so the
/// waiter concluded its answer was not in hand and gave up — one spurious 503 per rotation
/// that happened to overlap a cold load.
#[test]
fn rotation_during_a_cold_load_yields_the_new_key() {
    let slot = Arc::new(Mutex::new("sk-aip-old".to_string()));
    let entered = Arc::new(AtomicBool::new(false));
    let cache = {
        let slot = slot.clone();
        let entered = entered.clone();
        Arc::new(MasterKeyCache::new(
            Arc::new(move || {
                entered.store(true, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(200));
                Some(slot.lock().unwrap().clone())
            }),
            Duration::from_secs(5),
        ))
    };

    // Hold the load open on another thread, rotate while it is inside the lookup, then let
    // it finish. The caller that was already waiting is the one under test.
    let waiting = {
        let cache = cache.clone();
        std::thread::spawn(move || cache.get())
    };
    while !entered.load(Ordering::SeqCst) {
        std::thread::sleep(Duration::from_millis(5));
    }
    *slot.lock().unwrap() = "sk-aip-new".to_string();
    cache.invalidate();

    assert_eq!(
        waiting.join().unwrap(),
        MasterKeyLookup::Ready("sk-aip-new".to_string()),
        "the waiter must fetch the key the rotation installed, not give up"
    );
}

// -------------------------------------------------------------------------------------------
// The worker's status decision must survive the edge
// -------------------------------------------------------------------------------------------
//
// The webview's `gatewayStatus()` already applies a deliberate whitelist: it passes through
// client-attributable upstream codes (400/404/413/422/429), maps a missing route to 404, and
// maps everything else to 502. The Rust edge then re-decided with a second, narrower list and
// discarded most of that — so a schema error the worker had correctly labelled 400 reached the
// client as 502, and the client retried a request that could never succeed. These specs pin the
// worker's decision to the wire, per dialect.

#[test]
fn worker_status_preserves_every_error_status_the_worker_may_send() {
    for code in [400u16, 401, 403, 404, 413, 422, 429, 500, 502, 503] {
        assert_eq!(
            worker_status(code).as_u16(),
            code,
            "the worker decided {code}; the edge must not overrule it"
        );
    }
}

#[test]
fn worker_status_refuses_a_value_that_is_not_an_error_status() {
    // A success or redirect status carrying an error body would be worse than a 502 — the
    // client would read the error as a payload and report success.
    for code in [0u16, 99, 200, 204, 301, 600, 65535] {
        assert_eq!(
            worker_status(code),
            StatusCode::BAD_GATEWAY,
            "{code} is not an error status and must degrade to 502"
        );
    }
}

#[test]
fn anthropic_error_kind_tracks_the_status() {
    // Anthropic clients branch on error.type, so a 400 answered as `api_error` reads as
    // "try again" and invites a retry that cannot succeed.
    assert_eq!(anthropic_error_kind(StatusCode::BAD_REQUEST), "invalid_request_error");
    assert_eq!(anthropic_error_kind(StatusCode::UNAUTHORIZED), "authentication_error");
    assert_eq!(anthropic_error_kind(StatusCode::TOO_MANY_REQUESTS), "rate_limit_error");
    assert_eq!(anthropic_error_kind(StatusCode::SERVICE_UNAVAILABLE), "overloaded_error");
    assert_eq!(anthropic_error_kind(StatusCode::BAD_GATEWAY), "api_error");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_worker_400_reaches_an_openai_client_as_400() {
    let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let s = start(key).await;
    s.bridge.fail_with(400);
    let res = s
        .client
        .post(format!("{}/v1/chat/completions", s.base))
        .header("authorization", "Bearer sk-aip-test")
        .json(&chat_body(false))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 400, "a client-attributable error must not become a gateway error");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_worker_400_reaches_an_anthropic_client_as_400() {
    let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let s = start(key).await;
    s.bridge.fail_with(400);
    let res = s
        .client
        .post(format!("{}/v1/messages", s.base))
        .header("x-api-key", "sk-aip-test")
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&json!({ "model": "mock-fast", "max_tokens": 64,
                "messages": [{ "role": "user", "content": "hi" }] }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 400);
    let body: Value = res.json().await.unwrap();
    assert_eq!(
        body["error"]["type"], "invalid_request_error",
        "the Anthropic error type must describe the failure, not just say `api_error`"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_worker_400_reaches_a_responses_client_as_400() {
    let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let s = start(key).await;
    s.bridge.fail_with(400);
    let res = s
        .client
        .post(format!("{}/v1/responses", s.base))
        .header("authorization", "Bearer sk-aip-test")
        .header("content-type", "application/json")
        .json(&json!({ "model": "mock-fast", "input": "hi" }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 400);
    let body: Value = res.json().await.unwrap();
    assert_eq!(body["error"]["type"], "invalid_request_error");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_worker_429_reaches_a_gemini_client_as_429_not_503() {
    // The old code collapsed 429 into a 503 labelled "gateway unavailable or at capacity",
    // telling a rate-limited client that the gateway itself was broken.
    let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let s = start(key).await;
    s.bridge.fail_with(429);
    let res = s
        .client
        .post(format!("{}/v1beta/models/mock-fast:generateContent", s.base))
        .header("x-goog-api-key", "sk-aip-test")
        .header("content-type", "application/json")
        .json(&json!({ "contents": [{ "role": "user", "parts": [{ "text": "hi" }] }] }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 429, "a rate limit is not a gateway outage");
    let body: Value = res.json().await.unwrap();
    assert_eq!(body["error"]["code"], 429);
    assert_eq!(body["error"]["status"], "RESOURCE_EXHAUSTED");
}

/// Live 2026-09-22: capacity and spend refusals set `Retry-After`, the upstream 429 path did
/// not. A client honouring the header therefore retried a provider rate limit immediately.
/// Enforced by one middleware over every dialect, so no dialect can drift from the others.
#[tokio::test(flavor = "multi_thread")]
async fn an_upstream_429_carries_retry_after() {
    let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let s = start(key).await;
    s.bridge.fail_with(429);
    let res = s
        .client
        .post(format!("{}/v1/chat/completions", s.base))
        .header("authorization", "Bearer sk-aip-test")
        .json(&chat_body(false))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 429);
    assert_eq!(
        res.headers()["retry-after"],
        "1",
        "a rate limit with no retry hint reads as \"retry now\""
    );
}

/// The provider's own cooldown must reach the client, not the middleware's 1s floor. Stage 1
/// taught the health tracker to honour it internally; stage 2 carries it to the wire. 71s is
/// deliberately not round, so a hardcoded `1` cannot pass.
#[tokio::test(flavor = "multi_thread")]
async fn an_upstream_429_reports_the_providers_own_cooldown() {
    let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let s = start(key).await;
    s.bridge.fail_with_cooldown(429, 71_000);
    let res = s
        .client
        .post(format!("{}/v1/chat/completions", s.base))
        .header("authorization", "Bearer sk-aip-test")
        .json(&chat_body(false))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 429);
    assert_eq!(
        res.headers()["retry-after"],
        "71",
        "the client must be told the provider's window, not the 1s floor"
    );
}

/// The cooldown belongs to the failure, not to one dialect. Anthropic is the dialect ZCode
/// speaks, and its 429 burst is what motivated this change in the first place.
#[tokio::test(flavor = "multi_thread")]
async fn an_upstream_429_reports_the_cooldown_to_an_anthropic_client() {
    let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let s = start(key).await;
    s.bridge.fail_with_cooldown(429, 30_000);
    let res = s
        .client
        .post(format!("{}/v1/messages", s.base))
        .header("x-api-key", "sk-aip-test")
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&json!({ "model": "mock-fast", "max_tokens": 64,
                "messages": [{ "role": "user", "content": "hi" }] }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 429);
    assert_eq!(
        res.headers()["retry-after"],
        "30",
        "the Anthropic ingress must carry the cooldown too"
    );
}

/// Gemini builds its own error envelope rather than going through `openai_error`; the header
/// has to survive that difference.
#[tokio::test(flavor = "multi_thread")]
async fn an_upstream_429_reports_the_cooldown_to_a_gemini_client() {
    let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let s = start(key).await;
    s.bridge.fail_with_cooldown(429, 45_000);
    let res = s
        .client
        .post(format!("{}/v1beta/models/mock-fast:generateContent", s.base))
        .header("x-goog-api-key", "sk-aip-test")
        .header("content-type", "application/json")
        .json(&json!({ "contents": [{ "role": "user", "parts": [{ "text": "hi" }] }] }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 429);
    assert_eq!(res.headers()["retry-after"], "45");
}

/// A cooldown under a second must still read as 1, never 0 — a client that sees
/// `Retry-After: 0` treats it as "retry now", which is the defect this change removes.
#[tokio::test(flavor = "multi_thread")]
async fn a_sub_second_cooldown_never_reports_zero() {
    let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let s = start(key).await;
    s.bridge.fail_with_cooldown(429, 400);
    let res = s
        .client
        .post(format!("{}/v1/chat/completions", s.base))
        .header("authorization", "Bearer sk-aip-test")
        .json(&chat_body(false))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 429);
    assert_eq!(res.headers()["retry-after"], "1", "a sub-second cooldown floors at 1s");
}

/// axum's default 405 has an empty body — the one refusal a JSON-parsing client cannot read.
#[tokio::test(flavor = "multi_thread")]
async fn a_wrong_method_answers_a_json_405() {
    let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let s = start(key).await;
    let res = s
        .client
        .get(format!("{}/v1/chat/completions", s.base))
        .header("authorization", "Bearer sk-aip-test")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 405);
    let body: Value = res.json().await.unwrap();
    assert_eq!(body["error"]["code"], "unsupported_method");
}

/// Answering 404 to a caller that presented no credential made the route table an oracle:
/// 404-vs-401 told an anonymous caller a real route from a typo (invariant 10).
#[tokio::test(flavor = "multi_thread")]
async fn an_unknown_route_without_a_key_is_401_not_404() {
    let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let s = start(key).await;
    let res = s
        .client
        .post(format!("{}/v1/unknown/path", s.base))
        .header("content-type", "application/json")
        .body(r#"{"model":"gpt-4"}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(
        res.status(),
        401,
        "a 404 for an unauthenticated caller is a route-existence oracle"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_worker_400_reaches_an_image_client_as_400() {
    // The image handler carried its own narrower whitelist — `404` else `502` — so a schema
    // error became a gateway error here too. It was a third list, and it was missed.
    let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let s = start(key).await;
    s.bridge.fail_with(400);
    let res = s
        .client
        .post(format!("{}/v1/images/generations", s.base))
        .header("authorization", "Bearer sk-aip-test")
        .json(&json!({ "model": "mock-image", "prompt": "a cat" }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 400, "a client-attributable error must not become a gateway error");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_streamed_openai_failure_carries_the_status_in_the_payload() {
    // The OpenAI streaming arm discarded the status entirely and emitted a fixed
    // `upstream_error` with a null code, so a client could not tell a bad request from an
    // outage — the same defect as the other dialects, in the dialect that started it all.
    let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let s = start(key).await;
    s.bridge.fail_with(400);
    let res = s
        .client
        .post(format!("{}/v1/chat/completions", s.base))
        .header("authorization", "Bearer sk-aip-test")
        .json(&chat_body(true))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200, "the SSE response is committed before the worker answers");
    let mut acc = String::new();
    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        acc.push_str(&String::from_utf8_lossy(&chunk.unwrap()));
        if acc.contains("\"error\"") {
            break;
        }
    }
    assert!(acc.contains("\"status\":400"), "the payload must carry the real status: {acc}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stopped_gateway_answers_a_gemini_client_in_gemini_shape() {
    // `try_slot` fails before any dispatch (stopped / unavailable / at capacity), and the
    // shared helper that frames that failure writes an OpenAI-shaped body. Gemini clients read
    // `error.code` as an integer and `error.status` as the enum; both are wrong in that
    // envelope, so the failure cannot be classified by a strict SDK.
    let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let s = start(key).await;
    s.core.set_running(false);
    let res = s
        .client
        .post(format!("{}/v1beta/models/mock-fast:generateContent", s.base))
        .header("x-goog-api-key", "sk-aip-test")
        .header("content-type", "application/json")
        .json(&json!({ "contents": [{ "role": "user", "parts": [{ "text": "hi" }] }] }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 503);
    let body: Value = res.json().await.unwrap();
    assert_eq!(body["error"]["code"], 503, "a Gemini client reads error.code as an integer");
    assert_eq!(body["error"]["status"], "UNAVAILABLE");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_refused_anthropic_request_gets_an_anthropic_error_envelope() {
    // Same shared gate, same defect: an Anthropic client reads a top-level `type: "error"` and
    // branches on `error.type`. The OpenAI envelope has neither.
    let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let s = start(key).await;
    s.core.set_running(false);
    let res = s
        .client
        .post(format!("{}/v1/messages", s.base))
        .header("x-api-key", "sk-aip-test")
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&json!({ "model": "mock-fast", "max_tokens": 64,
                "messages": [{ "role": "user", "content": "hi" }] }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 503);
    let body: Value = res.json().await.unwrap();
    assert_eq!(body["type"], "error", "an Anthropic client reads the top-level `type`");
    assert_eq!(body["error"]["type"], "overloaded_error");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_refused_gateway_still_reports_its_status_to_an_openai_client() {
    // The OpenAI paths must keep the envelope they had — the gate refactor is about *shape*,
    // and the status it carries must not drift.
    let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let s = start(key).await;
    s.core.set_running(false);
    let res = s
        .client
        .post(format!("{}/v1/chat/completions", s.base))
        .header("authorization", "Bearer sk-aip-test")
        .json(&chat_body(false))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 503);
    let body: Value = res.json().await.unwrap();
    assert_eq!(body["error"]["type"], "service_unavailable");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_capacity_refusal_is_framed_for_anthropic_as_a_rate_limit() {
    // `try_slot` failing is a *different* site from the auth gate, and it used to hardcode
    // `overloaded_error` / "at capacity" for every refusal. Closing the slot pool reaches it
    // without dispatching anything.
    let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let s = start(key).await;
    s.core.permits.close();
    let res = s
        .client
        .post(format!("{}/v1/messages", s.base))
        .header("x-api-key", "sk-aip-test")
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&json!({ "model": "mock-fast", "max_tokens": 64,
                "messages": [{ "role": "user", "content": "hi" }] }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 429, "an exhausted slot pool is a capacity refusal");
    let body: Value = res.json().await.unwrap();
    assert_eq!(
        body["error"]["type"], "rate_limit_error",
        "429 must not be reported as an overload — the two have different retry semantics"
    );
}

/// §3.5 says "max concurrent routed requests (default 8) with a bounded queue (default 32)".
/// Nothing asserted either number: the pool was one flat semaphore of 40 that dispatched as
/// soon as it admitted, so 40 upstream calls could go out together. That is also the likely
/// reason a live capacity probe rate-limits the provider before it ever reaches this gate.
#[tokio::test(flavor = "multi_thread")]
async fn no_more_than_eight_requests_are_dispatched_at_once() {
    let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let s = start(key).await;
    s.bridge.slow.store(50, Ordering::Relaxed); // ~1s per reply
    let mut inflight = Vec::new();
    for _ in 0..20 {
        let c = s.client.clone();
        let base = s.base.clone();
        inflight.push(tokio::spawn(async move {
            c.post(format!("{base}/v1/chat/completions"))
                .header("authorization", "Bearer sk-aip-test")
                .json(&chat_body(false))
                .send()
                .await
                .unwrap()
                .status()
        }));
    }
    // While the first batch is still being answered, the worker must have been handed eight
    // requests and no more — the rest are admitted and waiting, not routed.
    tokio::time::sleep(Duration::from_millis(250)).await;
    let seen = s.bridge.dispatched();
    assert!(
        seen <= MAX_CONCURRENT,
        "dispatch must be capped at {MAX_CONCURRENT}, but the worker was handed {seen}"
    );
    assert_eq!(seen, MAX_CONCURRENT, "the cap should be saturated, not idle");

    for h in inflight {
        assert_eq!(h.await.unwrap(), 200, "a queued request still completes");
    }
    assert_eq!(s.bridge.dispatched(), 20, "queueing delays requests, it drops none");
}

/// The other number: 8 dispatched + 32 waiting = 40 admitted. The 41st is refused outright.
#[tokio::test(flavor = "multi_thread")]
async fn admission_refuses_the_forty_first_request() {
    let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let s = start(key).await;
    let mut held = Vec::new();
    for _ in 0..(MAX_CONCURRENT + MAX_QUEUED) {
        held.push(s.core.permits.clone().try_acquire_owned().expect("a fresh pool admits 40"));
    }
    assert!(s.core.permits.clone().try_acquire_owned().is_err(), "the pool must be full at 8 + 32");
    let res = s
        .client
        .post(format!("{}/v1/chat/completions", s.base))
        .header("authorization", "Bearer sk-aip-test")
        .json(&chat_body(false))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 429, "over the admission ceiling is a capacity refusal");
    assert_eq!(res.headers()["retry-after"], "1");
    drop(held);
}

// A streamed response is committed as 200 before the worker answers, so once the worker fails
// the HTTP status can no longer carry the outcome — the event payload is the only channel left.
// Every streaming arm used to hardcode a failure it had not been told: Anthropic always said
// `overloaded_error`, Gemini always said `code: 502 / INTERNAL`. Both told the client to treat a
// bad request as a transient outage.

#[tokio::test(flavor = "multi_thread")]
async fn a_streamed_anthropic_failure_describes_itself_in_the_event() {
    let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let s = start(key).await;
    s.bridge.fail_with(400);
    let res = s
        .client
        .post(format!("{}/v1/messages", s.base))
        .header("x-api-key", "sk-aip-test")
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&json!({ "model": "mock-fast", "max_tokens": 64, "stream": true,
                "messages": [{ "role": "user", "content": "hi" }] }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200, "the SSE response is committed before the worker answers");
    let mut acc = String::new();
    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        acc.push_str(&String::from_utf8_lossy(&chunk.unwrap()));
        if acc.contains("event: error") {
            break;
        }
    }
    assert!(acc.contains("event: error"), "expected an error event: {acc}");
    assert!(acc.contains("invalid_request_error"), "the event must name the real failure: {acc}");
    assert!(
        !acc.contains("overloaded_error"),
        "a 400 is not an overload — that tells the client to retry: {acc}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_streamed_gemini_failure_carries_the_real_code() {
    let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let s = start(key).await;
    s.bridge.fail_with(429);
    let res = s
        .client
        .post(format!("{}/v1beta/models/mock-fast:streamGenerateContent?alt=sse", s.base))
        .header("x-goog-api-key", "sk-aip-test")
        .header("content-type", "application/json")
        .json(&json!({ "contents": [{ "parts": [{ "text": "hi" }] }] }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let mut acc = String::new();
    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        acc.push_str(&String::from_utf8_lossy(&chunk.unwrap()));
        if acc.contains("RESOURCE_EXHAUSTED") {
            break;
        }
    }
    assert!(acc.contains("\"code\":429"), "the payload must carry the real code: {acc}");
    assert!(
        acc.contains("RESOURCE_EXHAUSTED"),
        "the payload must carry the real status label: {acc}"
    );
    assert!(!acc.contains("INTERNAL"), "a rate limit is not an internal error: {acc}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_streamed_responses_failure_carries_a_code() {
    let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let s = start(key).await;
    s.bridge.fail_with(400);
    let res = s
        .client
        .post(format!("{}/v1/responses", s.base))
        .header("authorization", "Bearer sk-aip-test")
        .header("content-type", "application/json")
        .json(&json!({ "model": "mock-fast", "input": "hi", "stream": true }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let mut acc = String::new();
    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        acc.push_str(&String::from_utf8_lossy(&chunk.unwrap()));
        if acc.contains("response.failed") {
            break;
        }
    }
    assert!(acc.contains("response.failed"), "expected a failure event: {acc}");
    assert!(
        acc.contains("invalid_request_error"),
        "a message alone leaves the client guessing whether to retry: {acc}"
    );
}

#[cfg(feature = "app")]
/// These three drive `gateway_cmds::run_gateway_tool` — the extracted command body — rather
/// than its helper. That is the coverage the isolated helper tests could not give: they
/// proved `record_gateway_tool_call` works, not that the command ever calls it. Deleting the
/// call site now fails a test.
fn tool_test_state(
    tag: &str,
) -> (Arc<crate::tauri::gateway_cmds::GatewayState>, std::path::PathBuf) {
    let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let (core, _bridge) = test_core(key);
    let (store, _sdir) = gateway_test_store(tag);
    let ws = std::env::temp_dir().join(format!("aip-ws-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&ws);
    std::fs::create_dir_all(&ws).unwrap();
    core.set_workspace_root(ws.clone());
    (
        Arc::new(crate::tauri::gateway_cmds::GatewayState {
            core,
            server: Mutex::new(None),
            store,
        }),
        ws,
    )
}

#[cfg(feature = "app")]
#[test]
fn a_refused_gateway_tool_call_is_gated_logged_and_recorded() {
    let (state, _ws) = tool_test_state("refused");
    let store = state.store.clone();
    let lines = Arc::new(Mutex::new(Vec::<String>::new()));
    let sink = {
        let lines = lines.clone();
        move |line: &str| lines.lock().unwrap().push(line.to_string())
    };
    let res = crate::tauri::gateway_cmds::run_gateway_tool(
        &state,
        &sink,
        42,
        "write_file".into(),
        json!({ "path": "a.txt", "content": "hunter2" }),
    )
    .unwrap();

    assert!(!res.ok, "mutation is off by default on the gateway");
    let captured = lines.lock().unwrap().clone();
    assert!(
        captured.iter().any(|l| l.contains("req=42") && l.contains("REFUSED")),
        "the refusal is logged with its request id: {captured:?}"
    );
    assert!(
        captured.iter().all(|l| !l.contains("hunter2")),
        "the body is never logged: {captured:?}"
    );

    let node = (0..200)
        .find_map(|_| {
            std::thread::sleep(std::time::Duration::from_millis(10));
            crate::core::context::graph(&store, 200)
                .ok()?
                .nodes
                .into_iter()
                .find(|n| n.id.starts_with("gateway:42:"))
        })
        .expect("the refused call is recorded");
    assert_eq!(node.source, "gateway");
    let meta = node.meta_json.unwrap_or_default();
    assert!(meta.contains("\"refused\":true"), "{meta}");
    assert!(meta.contains("path=a.txt"), "the digest, not the body: {meta}");
    assert!(!meta.contains("hunter2"), "the body is never stored: {meta}");
}

#[cfg(feature = "app")]
#[test]
fn a_successful_gateway_tool_call_runs_logs_the_outcome_and_records() {
    let (state, ws) = tool_test_state("success");
    let store = state.store.clone();
    std::fs::write(ws.join("a.txt"), "hello").unwrap();
    let lines = Arc::new(Mutex::new(Vec::<String>::new()));
    let sink = {
        let lines = lines.clone();
        move |line: &str| lines.lock().unwrap().push(line.to_string())
    };
    let res = crate::tauri::gateway_cmds::run_gateway_tool(
        &state,
        &sink,
        43,
        "read_file".into(),
        json!({ "path": "a.txt" }),
    )
    .unwrap();

    assert!(res.ok, "read_file is not a mutating tool");
    assert_eq!(res.output.trim(), "hello", "the tool actually ran");
    let captured = lines.lock().unwrap().clone();
    let line = captured
        .iter()
        .find(|l| l.contains("req=43"))
        .unwrap_or_else(|| panic!("one line per call: {captured:?}"));
    assert!(line.contains("ok=true"), "{line}");
    assert!(line.contains("out=5B"), "the size, not the contents: {line}");
    assert!(!line.contains("hello"), "the result body is never logged: {line}");

    let node = (0..200)
        .find_map(|_| {
            std::thread::sleep(std::time::Duration::from_millis(10));
            crate::core::context::graph(&store, 200)
                .ok()?
                .nodes
                .into_iter()
                .find(|n| n.id.starts_with("gateway:43:"))
        })
        .expect("the successful call is recorded");
    let meta = node.meta_json.unwrap_or_default();
    assert!(meta.contains("\"ok\":true"), "{meta}");
    assert!(meta.contains("\"out_bytes\":5"), "{meta}");
    assert!(meta.contains("\"refused\":false"), "{meta}");
}

#[cfg(feature = "app")]
#[test]
fn a_bad_workspace_root_is_refused_before_anything_stores_it() {
    let (state, _ws) = tool_test_state("wsroot");
    assert!(
        crate::tauri::gateway_cmds::set_gateway_workspace_root(&state, "/").is_err(),
        "the filesystem root is refused"
    );
    let home = std::env::var("HOME").unwrap_or_default();
    assert!(
        crate::tauri::gateway_cmds::set_gateway_workspace_root(&state, &home).is_err(),
        "the home directory is refused"
    );
    // A refused root must not replace the good one already set.
    assert!(state.core.workspace_root().is_some());

    let good = std::env::temp_dir().join(format!("aip-ws-good-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&good);
    std::fs::create_dir_all(&good).unwrap();
    assert!(crate::tauri::gateway_cmds::set_gateway_workspace_root(
        &state,
        &good.to_string_lossy()
    )
    .is_ok());
    assert!(state.core.workspace_root().is_some());
}

// ---------- Phase 6: injection across all four ingress dialects ----------
//
// Every dialect is translated twice — native request -> canonical chat -> whatever the provider
// speaks — and the injected block is added to the canonical body in between. A test that asserts
// on the *ingress* body would prove nothing: either translation can silently drop it. So these
// assert on what was actually handed to the bridge, and on what was not.

const MEMORY_TEXT: &str = "this project uses Postgres for the database";
const QUESTION: &str = "what database does this project use";

/// One temp dir per test. A monotonic counter, not a timestamp: these run in parallel and two
/// that opened in the same millisecond shared a database and locked each other out.
fn phase6_dir() -> std::path::PathBuf {
    static SEQ: AtomicUsize = AtomicUsize::new(0);
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("aip-phase6-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

/// A server with a real store, one memory scoped to the default workspace's project, and the
/// memory layer switched on. Returns the temp dir so the caller can clean it up.
async fn start_with_memory() -> (TestServer, std::path::PathBuf) {
    let dir = phase6_dir();
    let store = Arc::new(crate::core::store::Store::open(&dir).unwrap());
    let project = crate::core::gateway::context_scope::project_key_from_root(
        &crate::core::gateway::default_workspace_root().unwrap().to_string_lossy(),
    )
    .unwrap();
    let m = crate::core::memory::capture(
        &store,
        &crate::core::memory::MemoryInput {
            layer: "L1".into(),
            text: MEMORY_TEXT.into(),
            session_id: None,
            subject: None,
            pinned: false,
        },
    )
    .unwrap();
    // Scoped on purpose: an unscoped memory is invisible to every scope, which would make the
    // whole suite pass on "no candidates" instead of proving injection.
    assert!(crate::core::memory::assign_scope(
        &store,
        &m.id,
        crate::core::memory::ScopeAssignment::Project { project, agent: None },
    )
    .unwrap());

    let master = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
    let bridge = Arc::new(SynthBridge::new());
    let core = GatewayCore::new(bridge.clone(), Arc::new(move || master.lock().unwrap().clone()))
        .with_store(store.clone());
    let core = Arc::new(core);
    core.set_memory_enabled(true);
    core.set_running(true);
    let handle = spawn(core.clone(), 0).await.expect("bind ephemeral");
    (
        TestServer {
            client: reqwest::Client::new(),
            base: format!("http://{}", handle.addr),
            core,
            bridge,
            _handle: handle,
        },
        dir,
    )
}

/// The block the gateway prepends, as the bridge saw it. Panics with the whole body, because
/// "the system message did not contain the text" is useless without seeing what it did contain.
fn injected_system_text(sent: &(String, Value, HashMap<String, String>)) -> String {
    let ms = sent.1.get("messages").and_then(Value::as_array).cloned().unwrap_or_default();
    let first = ms.first().cloned().unwrap_or_else(|| json!({}));
    assert_eq!(first["role"], "system", "the block must be prepended: {ms:?}");
    first["content"].as_str().unwrap_or("").to_string()
}

fn assert_no_aip_headers(sent: &(String, Value, HashMap<String, String>)) {
    let leaked: Vec<&String> =
        sent.2.keys().filter(|k| k.to_ascii_lowercase().starts_with("aip-")).collect();
    assert!(leaked.is_empty(), "AIP headers reached the provider: {leaked:?}");
}

/// Every dialect's contract, in one helper, so a fifth dialect cannot be added without
/// agreeing to the same three assertions. `kind` differs by design — the Responses API is
/// dispatched as `responses` and re-framed at the edge, not folded into `chat`.
fn assert_injected_and_clean(
    sent: &(String, Value, HashMap<String, String>),
    dialect: &str,
    kind: &str,
) {
    assert_eq!(sent.0, kind, "{dialect}: unexpected dispatch kind");
    let block = injected_system_text(sent);
    assert!(
        block.contains(MEMORY_TEXT),
        "{dialect}: the recalled memory did not reach the provider — block was: {block}"
    );
    assert_no_aip_headers(sent);
}

#[tokio::test(flavor = "multi_thread")]
async fn phase6_openai_chat_injects_and_leaks_no_aip_headers() {
    let (s, dir) = start_with_memory().await;
    let res = s
            .client
            .post(format!("{}/v1/chat/completions", s.base))
            .header("authorization", "Bearer sk-aip-test")
            .header("aip-agent", "cursor")
            // Deliberately no `aip-project`: that header overrides the resolved project, and the
            // memory here is bound to the workspace-root hash. Sending a literal project name is
            // *supposed* to suppress injection — it is a different project — so including it here
            // would test the wrong thing. The egress test below sends one on purpose.
            .json(&json!({ "model": "mock-fast", "messages": [ { "role": "user", "content": QUESTION } ] }))
            .send()
            .await
            .unwrap();
    assert_eq!(res.status(), 200);
    let sent = s.bridge.sent(0).expect("a dispatch");
    assert_injected_and_clean(&sent, "openai chat", "chat");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test(flavor = "multi_thread")]
async fn phase6_anthropic_messages_injects_and_leaks_no_aip_headers() {
    let (s, dir) = start_with_memory().await;
    let res = s
        .client
        .post(format!("{}/v1/messages", s.base))
        .header("x-api-key", "sk-aip-test")
        .header("anthropic-version", "2023-06-01")
        .header("aip-agent", "claude-code")
        .json(&json!({ "model": "mock-fast", "max_tokens": 64,
                "messages": [ { "role": "user", "content": QUESTION } ] }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let sent = s.bridge.sent(0).expect("a dispatch");
    assert_injected_and_clean(&sent, "anthropic messages", "chat");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test(flavor = "multi_thread")]
async fn phase6_openai_responses_injects_and_leaks_no_aip_headers() {
    let (s, dir) = start_with_memory().await;
    let res = s
        .client
        .post(format!("{}/v1/responses", s.base))
        .header("authorization", "Bearer sk-aip-test")
        .header("aip-agent", "codex")
        .json(&json!({ "model": "mock-fast", "input": QUESTION }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let sent = s.bridge.sent(0).expect("a dispatch");
    assert_injected_and_clean(&sent, "openai responses", "responses");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test(flavor = "multi_thread")]
async fn phase6_gemini_generate_content_injects_and_leaks_no_aip_headers() {
    let (s, dir) = start_with_memory().await;
    let res = s
        .client
        .post(format!("{}/v1beta/models/mock-fast:generateContent", s.base))
        .header("x-goog-api-key", "sk-aip-test")
        .header("aip-agent", "gemini-cli")
        .json(&json!({ "contents": [ { "role": "user", "parts": [ { "text": QUESTION } ] } ] }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let sent = s.bridge.sent(0).expect("a dispatch");
    assert_injected_and_clean(&sent, "gemini", "chat");
    let _ = std::fs::remove_dir_all(&dir);
}

/// The egress allowlist, asserted rather than reviewed. A client can send any header it likes;
/// `AIP-*` is the gateway's own control surface and must never leave — it carries project and
/// agent identity that a provider has no business seeing.
#[tokio::test(flavor = "multi_thread")]
async fn phase6_no_aip_header_of_any_kind_reaches_the_provider() {
    let (s, dir) = start_with_memory().await;
    let res = s
            .client
            .post(format!("{}/v1/chat/completions", s.base))
            .header("authorization", "Bearer sk-aip-test")
            .header("aip-memory", "on")
            .header("aip-memory-budget", "400")
            .header("aip-agent", "cursor")
            .header("aip-project", "ai-provider-router")
            .header("aip-session", "s-1")
            .header("aip-internal", "1")
            .header("aip-open-files", "src/main.rs")
            .header("x-client-name", "cursor")
            .json(&json!({ "model": "mock-fast", "messages": [ { "role": "user", "content": QUESTION } ] }))
            .send()
            .await
            .unwrap();
    assert_eq!(res.status(), 200);
    let sent = s.bridge.sent(0).expect("a dispatch");
    assert_no_aip_headers(&sent);
    // And the allowlist is not simply empty: a legitimate client header still goes through,
    // otherwise this test would pass against a bridge that forwards nothing at all.
    assert!(!sent.2.is_empty(), "the forwarding allowlist must not be empty");
    let _ = std::fs::remove_dir_all(&dir);
}

// ---------- the bridge's way back (Phase 2: the headless service needs one) ----------

/// The smallest bridge that can answer.
///
/// It holds no reference to the core — it has no field for one — and the only thing it knows
/// how to do is reply through the handle it was handed. That is deliberately the shape the
/// headless Rust router core will take, so this is as much a statement of the contract `Bridge`
/// offers as it is a test fixture.
#[derive(Default)]
struct MinimalBridge {
    /// Request ids, in dispatch order, so a test can talk about the request the bridge saw
    /// rather than about an id it guessed.
    ids: Mutex<Vec<u64>>,
    /// The handle from the most recent dispatch. Kept because a real bridge moves it into the
    /// task that makes the upstream call, and so still holds it after the request is answered.
    last: Mutex<Option<ReplyHandle>>,
}

impl MinimalBridge {
    fn new() -> Self {
        Self::default()
    }
    fn only_id(&self) -> u64 {
        let ids = self.ids.lock().unwrap();
        assert_eq!(ids.len(), 1, "expected exactly one dispatch, saw {}", ids.len());
        ids[0]
    }
}

impl Bridge for MinimalBridge {
    fn dispatch(&self, req: BridgeRequest, replies: ReplyHandle) {
        self.ids.lock().unwrap().push(req.request_id);
        *self.last.lock().unwrap() = Some(replies.clone());
        replies.reply(req.request_id, BridgeMsg::Delta("Hel".into()));
        replies.reply(req.request_id, BridgeMsg::Delta("lo".into()));
        replies.reply(req.request_id, BridgeMsg::Done);
    }
    fn cancel(&self, _id: u64) {}
}

fn bare_request(id: u64) -> BridgeRequest {
    BridgeRequest {
        request_id: id,
        kind: "chat",
        body: json!({}),
        headers: HashMap::new(),
        app_key_id: None,
    }
}

/// The seam, stated as a test rather than as a comment: a bridge that was never handed the core
/// can still answer a request.
///
/// This used to be impossible. `SynthBridge` reached the reply path through a
/// `Mutex<Option<Arc<GatewayCore>>>` filled in by a hand-written `attach()` after construction,
/// so "can a bridge answer?" and "did somebody remember to attach it?" were the same question —
/// and answering it wrong failed silently, as a generic 503 after `FIRST_MSG_TIMEOUT` rather
/// than as a complaint about the wiring.
#[tokio::test(flavor = "multi_thread")]
async fn a_bridge_answers_through_the_handle_it_was_handed_and_nothing_else() {
    let bridge = Arc::new(MinimalBridge::new());
    let core = Arc::new(GatewayCore::new(bridge.clone(), Arc::new(|| Some("sk-aip-test".into()))));
    core.set_running(true);
    let handle = spawn(core.clone(), 0).await.expect("bind ephemeral");
    let res = reqwest::Client::new()
        .post(format!("http://{}/v1/chat/completions", handle.addr))
        .header("authorization", "Bearer sk-aip-test")
        .json(&chat_body(false))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200, "a bridge with no core reference must still be answerable");
    let body: Value = res.json().await.unwrap();
    assert_eq!(body["choices"][0]["message"]["content"], "Hello");
}

/// The reason the handle has the shape it does.
///
/// The core owns the bridge (`Arc<dyn Bridge>`) and the bridge owns the handle, so a handle
/// that held the core would close a cycle: neither would ever drop. In a long-lived service
/// that is not a small leak — it is the entire core, store and semaphores and injection log
/// included, kept alive forever by a bridge nothing can reach.
///
/// Asserted with a `Weak`, because that is the only way to state "it really was dropped" rather
/// than "we believe nothing holds it". No server is started: a spawned listener holds the core
/// too, and the assertion would then be measuring task teardown timing instead of the reference
/// graph.
#[test]
fn the_bridge_holds_no_reference_that_keeps_the_core_alive() {
    let bridge = Arc::new(MinimalBridge::new());
    let core = Arc::new(GatewayCore::new(bridge.clone(), Arc::new(|| Some("sk-aip-test".into()))));
    core.dispatch(bare_request(7));
    let held = bridge.last.lock().unwrap().clone().expect("the bridge was handed a handle");
    let id = bridge.only_id();
    assert_eq!(id, 7);

    let weak = Arc::downgrade(&core);
    drop(core);
    assert!(weak.upgrade().is_none(), "the bridge's reply handle must not keep the core alive");
    assert!(
        !held.reply(id, BridgeMsg::Done),
        "and a reply after the core is gone is a plain false, not a panic"
    );
}

/// One authority, one map.
///
/// The bridge replies through the handle it was handed; the core answers through
/// `GatewayCore::reply`. Those are two doors, and if they opened onto two maps then a terminal
/// reply from the bridge would leave the core's registration behind — the core would go on
/// offering to serve a request that is already finished, and the entry would never be freed.
///
/// Asserted through the *other* door: once the bridge has finished with the id, the core is
/// asked for it and must find nothing.
#[test]
fn the_bridge_and_the_core_answer_into_the_same_place() {
    let bridge = Arc::new(MinimalBridge::new());
    let core = Arc::new(GatewayCore::new(bridge.clone(), Arc::new(|| Some("sk-aip-test".into()))));
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    core.replies.register(7, tx);
    core.dispatch(bare_request(7));

    let mut seen = Vec::new();
    while let Ok(msg) = rx.try_recv() {
        seen.push(format!("{msg:?}"));
    }
    assert_eq!(seen.len(), 3, "both deltas and the terminator must arrive: {seen:?}");
    assert!(seen[2].contains("Done"), "and the terminator must be last: {seen:?}");

    assert!(
        !core.reply(7, BridgeMsg::Done),
        "a terminal reply through the bridge's handle must retire the registration the core made"
    );
}
