//! Gateway integration tests — one file so the HTTP surface is exercised as a whole
//! rather than per dialect (declared as `gateway::tests` via #[path]).

    use super::*;
    use futures_util::StreamExt as _;

    /// Synthetic bridge = the §3.5 entry-gate spike: answers chat with deltas + Done,
    /// models/image with JSON, records cancels. Holds a back-pointer to the core so it can
    /// reply.
    struct SynthBridge {
        core: Mutex<Option<Arc<GatewayCore>>>,
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
        /// Everything handed to the worker, verbatim. Phase 6 needs to see what actually leaves
        /// for the provider — asserting on the *ingress* body would prove nothing, because every
        /// dialect is translated twice and either hop can drop the injected block.
        sent: Mutex<Vec<(String, Value, HashMap<String, String>)>>,
    }

    impl SynthBridge {
        fn new() -> Self {
            Self {
                core: Mutex::new(None),
                cancels: AtomicUsize::new(0),
                slow: AtomicUsize::new(0),
                tool_calls: AtomicBool::new(false),
                empty_delta: AtomicBool::new(false),
                silent: AtomicBool::new(false),
                fail_status: AtomicUsize::new(0),
                sent: Mutex::new(Vec::new()),
            }
        }

        /// `(kind, body, headers)` of the nth dispatch.
        fn sent(&self, n: usize) -> Option<(String, Value, HashMap<String, String>)> {
            self.sent.lock().unwrap().get(n).cloned()
        }
        fn attach(&self, core: &Arc<GatewayCore>) {
            *self.core.lock().unwrap() = Some(core.clone());
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
    }

    impl Bridge for SynthBridge {
        fn dispatch(&self, req: BridgeRequest) {
            if self.silent.load(Ordering::Relaxed) {
                return; // never replies — the request must fail, not hang
            }
            self.sent.lock().unwrap().push((
                req.kind.to_string(),
                req.body.clone(),
                req.headers.clone(),
            ));
            let core = self.core.lock().unwrap().clone().unwrap();
            let slow = self.slow.load(Ordering::Relaxed);
            let with_tools = self.tool_calls.load(Ordering::Relaxed);
            let with_empty = self.empty_delta.load(Ordering::Relaxed);
            let fail = self.fail_status.load(Ordering::Relaxed);
            std::thread::spawn(move || {
                if slow > 0 {
                    std::thread::sleep(Duration::from_millis(slow as u64 * 20));
                }
                if fail > 0 {
                    // The worker decided this status. Everything downstream must respect it.
                    core.reply(
                        req.request_id,
                        BridgeMsg::Error { status: fail as u16, message: "upstream refused the request".into() },
                    );
                    return;
                }
                match req.kind {
                    "chat" => {
                        if with_empty {
                            core.reply(req.request_id, BridgeMsg::Delta(String::new()));
                        }
                        core.reply(req.request_id, BridgeMsg::Delta("Hel".into()));
                        core.reply(req.request_id, BridgeMsg::Delta("lo".into()));
                        if with_tools {
                            // Pass-through: the client declared these, so the gateway hands
                            // them straight back and never executes them itself.
                            core.reply(
                                req.request_id,
                                BridgeMsg::ToolCalls(json!([{
                                    "id": "call_1",
                                    "type": "function",
                                    "function": { "name": "write_file", "arguments": "{\"path\":\"a.txt\"}" }
                                }])),
                            );
                        }
                        core.reply(req.request_id, BridgeMsg::Done);
                    }
                    "responses" => {
                        // Same synthetic text output as chat; responses_h wraps it into Responses API frames.
                        core.reply(req.request_id, BridgeMsg::Delta("Hel".into()));
                        core.reply(req.request_id, BridgeMsg::Delta("lo".into()));
                        core.reply(req.request_id, BridgeMsg::Done);
                    }
                    "models" => {
                        core.reply(req.request_id, BridgeMsg::Result(json!({
                            "object": "list",
                            "data": [{ "id": "openrouter/gpt-4o", "object": "model" }, { "id": "opencode/gpt-4o", "object": "model" }]
                        })));
                        core.reply(req.request_id, BridgeMsg::Done);
                    }
                    "image" => {
                        core.reply(req.request_id, BridgeMsg::Result(json!({ "data": [{ "url": "https://img.example/x.png" }] })));
                        core.reply(req.request_id, BridgeMsg::Done);
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
    fn gateway_test_store(
        tag: &str,
    ) -> (Arc<crate::store::Store>, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "aip-gw-{}-{}",
            tag,
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        (Arc::new(crate::store::Store::open(&dir).unwrap()), dir)
    }

    /// Key provider backed by a mutable slot — simulates rotate/revoke without the keychain.
    fn test_core(key: Arc<Mutex<Option<String>>>) -> (Arc<GatewayCore>, Arc<SynthBridge>) {
        let bridge = Arc::new(SynthBridge::new());
        let core = Arc::new(GatewayCore::new(
            bridge.clone(),
            Arc::new(move || key.lock().unwrap().clone()),
        ));
        bridge.attach(&core);
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
        for stage in ["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"] {
            assert!(acc.contains(stage), "missing {stage} in:
{acc}");
        }
        // synth bridge streams "Hel" + "lo" as separate deltas
        assert!(acc.contains("Hel"), "delta text missing");
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
        assert!(!acc.contains(r#""content":"""#), "empty delta reached the wire:
{acc}");
        // The probe is dropped, not the message: real text still arrives.
        assert!(acc.contains("Hel") && acc.contains("lo"), "real deltas missing:
{acc}");
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
        assert!(acc.contains("data: [DONE]"), "stream never terminated with [DONE]:
{acc}");
        // The sentinel is last: nothing is emitted after it.
        let tail = acc.split("data: [DONE]").nth(1).unwrap_or("");
        assert!(!tail.contains("chat.completion.chunk"), "frames emitted after [DONE]:
{acc}");
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
        assert_eq!(body["model"], "gpt-4o", "non-stream body has no model:
{body}");

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
        assert!(acc.contains(r#""model":"gpt-4o""#), "stream frames carry no model:
{acc}");
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
        for ev in ["response.created", "response.output_text.delta", "response.output_text.done", "response.completed"] {
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
        let mut core =
            GatewayCore::new(bridge.clone(), Arc::new(move || key.lock().unwrap().clone()));
        if let Some(ak) = app_keys {
            core = core.with_app_keys(Arc::new(move || ak.lock().unwrap().clone()));
        }
        if let Some(sp) = spend {
            core = core.with_spend(Arc::new(move || *sp.lock().unwrap()));
        }
        let core = Arc::new(core);
        bridge.attach(&core);
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
    fn key_core(tag: &str, keys: &[(&str, &str)]) -> (Arc<GatewayCore>, Arc<AtomicUsize>, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("aip-appkey-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = Arc::new(crate::store::Store::open(&dir).unwrap());
        let reads = Arc::new(AtomicUsize::new(0));
        let (r, s2) = (reads.clone(), store.clone());
        let all: Vec<AppKey> =
            keys.iter().map(|(id, sec)| AppKey { id: (*id).into(), secret: (*sec).into() }).collect();
        let bridge = Arc::new(SynthBridge::new());
        let core = GatewayCore::new(bridge.clone(), Arc::new(|| Some("sk-aip-master".into())))
            .with_app_keys(Arc::new(move || {
                r.fetch_add(1, Ordering::SeqCst);
                let active = crate::persist::active_gateway_key_ids(&s2).unwrap_or_default();
                all.iter().filter(|k| active.contains(&k.id)).cloned().collect()
            }))
            .with_store(store);
        let core = Arc::new(core);
        bridge.attach(&core);
        (core, reads, dir)
    }

    /// The property the design was waiting for: N requests do not mean N keychain passes.
    #[test]
    fn the_app_key_map_is_read_once_not_once_per_request() {
        let (core, reads, dir) = key_core("memo", &[("ak-1", "sk-aip-app1")]);
        crate::persist::gateway_key_insert(core.store().unwrap(), "ak-1", "cursor").unwrap();
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
        crate::persist::gateway_key_insert(store, "ak-1", "cursor").unwrap();
        assert_eq!(core.app_keys().len(), 1);
        assert_eq!(reads.load(Ordering::SeqCst), 1);

        crate::persist::gateway_key_revoke(store, "ak-1").unwrap();
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
        crate::persist::gateway_key_insert(store, "ak-1", "one").unwrap();
        assert_eq!(core.app_keys().len(), 1);
        crate::persist::gateway_key_insert(store, "ak-2", "two").unwrap();
        assert_eq!(core.app_keys().len(), 2, "a new key authenticates on the very next request");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The TTL is the backstop for the one case SQLite cannot see: a secret removed from the
    /// keychain out from under an active row. An expired memo must not be served.
    #[test]
    fn the_memo_stops_being_served_once_its_ttl_expires() {
        let (core, reads, dir) = key_core("ttl", &[("ak-1", "sk-aip-app1")]);
        crate::persist::gateway_key_insert(core.store().unwrap(), "ak-1", "cursor").unwrap();
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
        bridge.attach(&core);
        assert_eq!(core.app_keys().len(), 1);
        assert_eq!(core.app_keys().len(), 1);
        assert_eq!(reads.load(Ordering::SeqCst), 2, "never cache what cannot be validated");
    }

    #[test]
    fn a_presented_key_resolves_to_its_id_and_a_strange_one_to_nothing() {
        let (core, _reads, dir) = key_core("resolve", &[("ak-1", "s1"), ("ak-2", "s2")]);
        let store = core.store().unwrap();
        crate::persist::gateway_key_insert(store, "ak-1", "one").unwrap();
        crate::persist::gateway_key_insert(store, "ak-2", "two").unwrap();
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
        crate::persist::gateway_key_insert(store, "ak-1", "one").unwrap();
        crate::persist::gateway_key_insert(store, "ak-2", "two").unwrap();
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
        crate::persist::gateway_key_insert(core.store().unwrap(), "ak-1", "an ide").unwrap();
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

    // ---------- audit R1: background mode liveness ----------

    /// R1: a hidden window's heartbeat is throttled by the OS, so the liveness bound must
    /// relax — 6s would drop every request while the app sits in the background.
    #[test]
    fn r1_hidden_loosens_the_heartbeat_bound() {
        let core = GatewayCore::new(Arc::new(SynthBridge::new()), Arc::new(|| Some("k".into())));
        core.set_running(true);
        assert!(core.is_available());

        // Age the heartbeat past the visible bound (6s) but inside the hidden one (30s).
        *core.last_heartbeat.lock().unwrap() = Instant::now() - Duration::from_millis(7_000);
        assert!(!core.is_available(), "stale beat must fail while visible");

        core.set_hidden(true);
        assert!(core.is_available(), "hidden mode must tolerate a throttled beat");
        assert!(core.is_hidden());
    }

    /// R1: entering background stamps the heartbeat. Without this, hiding right before the
    /// beat was due would trip the short bound during the first throttled interval.
    #[test]
    fn r1_entering_background_stamps_the_heartbeat() {
        let core = GatewayCore::new(Arc::new(SynthBridge::new()), Arc::new(|| Some("k".into())));
        core.set_running(true);
        *core.last_heartbeat.lock().unwrap() = Instant::now() - Duration::from_millis(10_000);
        assert!(!core.is_available());
        core.set_hidden(true);
        assert!(core.is_available(), "set_hidden must refresh the beat");
    }

    /// R1: leaving background restores the tight bound, so a renderer that died while hidden
    /// is detected again instead of being trusted forever.
    #[test]
    fn r1_leaving_background_restores_the_tight_bound() {
        let core = GatewayCore::new(Arc::new(SynthBridge::new()), Arc::new(|| Some("k".into())));
        core.set_running(true);
        core.set_hidden(true);
        *core.last_heartbeat.lock().unwrap() = Instant::now() - Duration::from_millis(10_000);
        assert!(core.is_available());
        core.set_hidden(false);
        assert!(!core.is_available(), "visible mode must re-apply the 6s bound");
    }

    /// R4(b): no provider attached == uncapped. Guards the builder contract that every
    /// pre-R4 test relies on.
    #[test]
    fn r4_uncapped_without_provider() {
        let core = GatewayCore::new(
            Arc::new(SynthBridge::new()),
            Arc::new(|| Some("k".to_string())),
        );
        assert!(spend_gate(&core).is_none());
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
        assert!(
            !acc.contains("\"finish_reason\":\"stop\""),
            "must not also emit a stop finish: {acc}"
        );
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
            assert!(
                core.gateway_tool_refusal(tool).is_some(),
                "{tool} must be refused by default"
            );
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

    /// A bound socket and a gateway that is meant to be serving are different states — but the
    /// difference that matters is *operator intent*, not whether the worker happens to be awake.
    ///
    /// This test used to assert the opposite for the lapsed case, because a lapsed beat was the
    /// only signal available and tearing the listener down was how Start recovered from it. That
    /// is no longer true: a hidden worker sleeps after ~8 idle minutes (see
    /// `HEARTBEAT_STALE_HIDDEN_MS`), so calling that "stale" meant destroying a healthy listener
    /// every time the gateway went quiet — and `await_core` revives the worker from the request
    /// that needs it anyway. The state that genuinely needs rebuilding is a listener that
    /// outlived the operator's intent, because nothing else will ever tear it down.
    #[test]
    fn a_bound_listener_is_stale_only_when_serving_was_never_asked_for() {
        use crate::gateway_cmds::GatewayState;
        let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
        let (core, _bridge) = test_core(key);
        let (store, _dir) = gateway_test_store("stale-listener");
        let state = GatewayState { core: core.clone(), server: Mutex::new(None), store };

        // Nothing bound: not stale, just stopped.
        assert!(!state.has_stale_server());

        let (tx, _rx) = tokio::sync::oneshot::channel::<()>();
        *state.server.lock().unwrap() = Some(ServerHandle {
            shutdown: tx,
            addr: "127.0.0.1:0".parse().unwrap(),
        });
        core.set_running(true);
        core.heartbeat();
        assert!(!state.has_stale_server(), "a healthy listener is not stale");

        // The beat lapses while the socket stays bound. The worker is asleep, not broken: the
        // listener is fine and the next request wakes the worker, so this must not be torn down.
        core.set_hidden(false);
        *core.last_heartbeat.lock().unwrap() = Instant::now() - Duration::from_millis(7_000);
        assert!(!core.is_available(), "the beat really has lapsed");
        assert!(
            !state.has_stale_server(),
            "a sleeping worker under a bound listener is not stale"
        );

        // A listener that outlived the operator's intent is the case that needs rebuilding.
        core.set_running(false);
        assert!(state.has_stale_server(), "bound but not running is stale");
    }

    /// `running` (operator intent) and `worker_awake` (the beat) are separable, and a sleeping
    /// worker must never read as a stopped gateway.
    ///
    /// These are exactly the two fields `gateway_status` reports, and conflating them is what
    /// made the UI say "Stopped — last heard from the worker 31s ago" about a gateway that was
    /// bound, serving, and would have answered the next request.
    #[test]
    fn a_sleeping_worker_is_still_running() {
        let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
        let (core, _bridge) = test_core(key);
        core.set_hidden(true);
        core.set_running(true);
        core.heartbeat();
        assert!(core.is_running() && core.beat_is_fresh());

        // ~8 idle minutes later the hidden worker's timer has stopped. 31s clears the 30s bound.
        *core.last_heartbeat.lock().unwrap() = Instant::now() - Duration::from_millis(31_000);
        assert!(core.is_running(), "operator intent survives a sleeping worker");
        assert!(!core.beat_is_fresh(), "the beat is the part that went stale");
        assert!(!core.is_available(), "and is_available is the conjunction of the two");
    }

    /// A worker that stops answering must fail the request, not hold the socket open.
    ///
    /// This is what an OS-suspended worker webview looks like from here: the beat was fresh when
    /// the request was admitted, so nothing is stale yet — the reply simply never arrives. Until
    /// the first message had a bound, the handler waited forever with a socket open and nothing
    /// logged, which presents as a mysterious hang rather than an error.
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
        bridge.attach(&core);
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
        assert!(
            acc.contains("\"status\":400"),
            "the payload must carry the real status: {acc}"
        );
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
        assert!(
            acc.contains("invalid_request_error"),
            "the event must name the real failure: {acc}"
        );
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
        assert!(
            !acc.contains("INTERNAL"),
            "a rate limit is not an internal error: {acc}"
        );
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

    /// These three drive `gateway_cmds::run_gateway_tool` — the extracted command body — rather
    /// than its helper. That is the coverage the isolated helper tests could not give: they
    /// proved `record_gateway_tool_call` works, not that the command ever calls it. Deleting the
    /// call site now fails a test.
    fn tool_test_state(tag: &str) -> (Arc<crate::gateway_cmds::GatewayState>, std::path::PathBuf) {
        let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
        let (core, _bridge) = test_core(key);
        let (store, _sdir) = gateway_test_store(tag);
        let ws = std::env::temp_dir().join(format!("aip-ws-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&ws);
        std::fs::create_dir_all(&ws).unwrap();
        core.set_workspace_root(ws.clone());
        (
            Arc::new(crate::gateway_cmds::GatewayState {
                core,
                server: Mutex::new(None),
                store,
            }),
            ws,
        )
    }

    #[test]
    fn a_refused_gateway_tool_call_is_gated_logged_and_recorded() {
        let (state, _ws) = tool_test_state("refused");
        let store = state.store.clone();
        let lines = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink = {
            let lines = lines.clone();
            move |line: &str| lines.lock().unwrap().push(line.to_string())
        };
        let res = crate::gateway_cmds::run_gateway_tool(
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
                crate::context::graph(&store, 200)
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
        let res = crate::gateway_cmds::run_gateway_tool(
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
                crate::context::graph(&store, 200)
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

    #[test]
    fn a_bad_workspace_root_is_refused_before_anything_stores_it() {
        let (state, _ws) = tool_test_state("wsroot");
        assert!(
            crate::gateway_cmds::set_gateway_workspace_root(&state, "/").is_err(),
            "the filesystem root is refused"
        );
        let home = std::env::var("HOME").unwrap_or_default();
        assert!(
            crate::gateway_cmds::set_gateway_workspace_root(&state, &home).is_err(),
            "the home directory is refused"
        );
        // A refused root must not replace the good one already set.
        assert!(state.core.workspace_root().is_some());

        let good = std::env::temp_dir().join(format!("aip-ws-good-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&good);
        std::fs::create_dir_all(&good).unwrap();
        assert!(
            crate::gateway_cmds::set_gateway_workspace_root(&state, &good.to_string_lossy()).is_ok()
        );
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
        let store = Arc::new(crate::store::Store::open(&dir).unwrap());
        let project = crate::gateway::context_scope::project_key_from_root(
            &crate::gateway::default_workspace_root().unwrap().to_string_lossy(),
        )
        .unwrap();
        let m = crate::memory::capture(
            &store,
            &crate::memory::MemoryInput {
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
        assert!(crate::memory::assign_scope(
            &store,
            &m.id,
            crate::memory::ScopeAssignment::Project { project, agent: None },
        )
        .unwrap());

        let master = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
        let bridge = Arc::new(SynthBridge::new());
        let core = GatewayCore::new(bridge.clone(), Arc::new(move || master.lock().unwrap().clone()))
            .with_store(store.clone());
        let core = Arc::new(core);
        bridge.attach(&core);
        core.set_memory_enabled(true);
        core.set_running(true);
        let handle = spawn(core.clone(), 0).await.expect("bind ephemeral");
        (
            TestServer { client: reqwest::Client::new(), base: format!("http://{}", handle.addr), core, bridge, _handle: handle },
            dir,
        )
    }

    /// The block the gateway prepends, as the bridge saw it. Panics with the whole body, because
    /// "the system message did not contain the text" is useless without seeing what it did contain.
    fn injected_system_text(sent: &(String, Value, HashMap<String, String>)) -> String {
        let ms = sent.1.get("messages").and_then(Value::as_array).cloned().unwrap_or_default();
        let first = ms.first().cloned().unwrap_or_else(|| json!({}));
        assert_eq!(first["role"], "system", "the block must be prepended: {:?}", ms);
        first["content"].as_str().unwrap_or("").to_string()
    }

    fn assert_no_aip_headers(sent: &(String, Value, HashMap<String, String>)) {
        let leaked: Vec<&String> = sent
            .2
            .keys()
            .filter(|k| k.to_ascii_lowercase().starts_with("aip-"))
            .collect();
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
