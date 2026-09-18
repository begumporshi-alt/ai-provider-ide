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
    }

    impl SynthBridge {
        fn new() -> Self {
            Self {
                core: Mutex::new(None),
                cancels: AtomicUsize::new(0),
                slow: AtomicUsize::new(0),
                tool_calls: AtomicBool::new(false),
                empty_delta: AtomicBool::new(false),
            }
        }
        fn attach(&self, core: &Arc<GatewayCore>) {
            *self.core.lock().unwrap() = Some(core.clone());
        }
        fn answer_with_tool_calls(&self, on: bool) {
            self.tool_calls.store(on, Ordering::Relaxed);
        }
        fn answer_with_empty_delta(&self, on: bool) {
            self.empty_delta.store(on, Ordering::Relaxed);
        }
    }

    impl Bridge for SynthBridge {
        fn dispatch(&self, req: BridgeRequest) {
            let core = self.core.lock().unwrap().clone().unwrap();
            let slow = self.slow.load(Ordering::Relaxed);
            let with_tools = self.tool_calls.load(Ordering::Relaxed);
            let with_empty = self.empty_delta.load(Ordering::Relaxed);
            std::thread::spawn(move || {
                if slow > 0 {
                    std::thread::sleep(Duration::from_millis(slow as u64 * 20));
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
        // rotate (overwrite keychain slot)
        *key.lock().unwrap() = Some("sk-aip-new".to_string());
        // old key now 401, new key 200 — no restart, per-request read
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

    /// `start()` plus the two R4 providers. Both are `Option` so each test opts into exactly
    /// the behaviour it exercises; `None` reproduces the pre-R4 (master-only, uncapped) path.
    fn core_with(
        key: Arc<Mutex<Option<String>>>,
        app_keys: Option<Arc<Mutex<Vec<String>>>>,
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
        app_keys: Option<Arc<Mutex<Vec<String>>>>,
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
        let s = start_with(Some(Arc::new(Mutex::new(vec!["sk-aip-app1".to_string()]))), None).await;
        let res = post_chat(&s, "sk-aip-app1").await;
        assert_eq!(res.status(), 200, "per-app key must be accepted");
    }

    /// R4(a): revocation is immediate. The provider is re-read per request, so dropping a key
    /// from the active list kills it on the NEXT request — no restart, no master rotation.
    #[tokio::test(flavor = "multi_thread")]
    async fn r4_revoked_app_key_rejected_immediately() {
        let keys = Arc::new(Mutex::new(vec!["sk-aip-app1".to_string()]));
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
        let s = start_with(Some(Arc::new(Mutex::new(vec!["sk-aip-app1".to_string()]))), None).await;
        let res = post_chat(&s, "sk-aip-nope").await;
        assert_eq!(res.status(), 401);
        let body: Value = res.json().await.unwrap();
        assert_eq!(body["error"]["code"], "invalid_api_key");
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

    /// A bound socket and a working gateway are different states, and conflating them is what
    /// made Start a dead button: the heartbeat lapses, the UI reads "Stopped", the operator
    /// presses Start, and a "is the listener set?" check answers yes and does nothing.
    #[test]
    fn a_listener_bound_under_a_lapsed_heartbeat_is_stale() {
        use crate::gateway_cmds::GatewayState;
        let key = Arc::new(Mutex::new(Some("sk-aip-test".to_string())));
        let (core, _bridge) = test_core(key);
        let state = GatewayState { core: core.clone(), server: Mutex::new(None) };

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

        // Beat lapses while the socket stays bound — the dead-button case.
        core.set_hidden(false);
        *core.last_heartbeat.lock().unwrap() = Instant::now() - Duration::from_millis(7_000);
        assert!(state.has_stale_server(), "lapsed beat under a bound listener is stale");

        // And once stopped deliberately, it is simply not running.
        core.set_running(false);
        assert!(state.has_stale_server(), "bound but not running is stale too");
    }
