//! The live thinking-knob probe: does the **rendered request** carry the setting all the way to a
//! real provider, and does the provider honour it?
//!
//! **`#[ignore]`d on purpose, for the reason `web_live.rs` gives.** It needs the public internet and
//! a real credential, so on CI it would go red for reasons that are not the code. Run it by hand
//! when the thinking knobs or the agentrouter wiring change:
//!
//! ```text
//! cd apps/desktop/src-tauri
//! AIPROBE_KEY=<key> \
//!   AIPROBE_UA='claude-cli/2.0.18 (external, cli)' \
//!   cargo test --test reasoning_live -- --ignored --nocapture --test-threads=1
//! ```
//!
//! `AIPROBE_BASE_URL` (default `https://agentrouter.org/v1`) and `AIPROBE_MODEL` (default
//! `deepseek-v4-flash`) point it elsewhere. No key → a printed `SKIP`, not a failure — the
//! `web_live.rs` convention.
//!
//! **`AIPROBE_UA` is not optional for agentrouter.** Measured 2026-10-02: its client gate answers
//! 401 `unauthorized client detected` for both a bare `reqwest` user-agent and this app's own
//! (`AI-Provider-Router/1.2.0`); the value above is what the provider's earlier stored manifests
//! declared as a per-endpoint `user-agent`, which the app's egress prefers over its default. A
//! provider without a gate ignores the variable — its default is the app's own string, so a pass
//! here also proves the production header gets through.
//!
//! # What it asserts, and what it only prints
//!
//! The split is deliberate, and it is the one the other live checks keep:
//!
//! - **Asserted** — the facts this repo owns. The wire bodies for unset / off / high, and that the
//!   upstream answered each of them with text. A body that lost its `thinking` field means the knob
//!   does not reach the wire; a 4xx on `{type:"disabled"}` means the field we render is not the one
//!   this provider accepts.
//! - **Printed** — the upstream's own behaviour: `stop_reason`, token counts, elapsed time, and
//!   whether the answer carried a thinking block. Asserting on those would make this file a test of
//!   someone else's deployment, which is how a live suite earns a reputation for failing on
//!   Tuesdays. A human reads the difference.
//!
//! # Why the port, and not a fetch spy
//!
//! `RecordingPort` sits where the app's real egress sits: the interpreter hands it a rendered body
//! and it is the last code to touch that string before the network. A capture here is therefore
//! what was **sent**, not what something meant to send. No header value is ever printed — the key is
//! substituted for the `{{secret}}` sentinel at the same seam the real port does it (`egress.rs`).
//!
//! # Which manifest
//!
//! The **builtin** `anthropic_compat` template — what a provider gets when its manifest is
//! (re-)derived. A stored manifest belongs to the operator and a release does not rewrite it, so a
//! live miss on a stored manifest that declares no `{{thinking?}}` is the *template's* absence, not
//! the knob's: `render_template` renders the template's keys and drops everything else.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use ai_provider_router_lib::core::adapter::{AdapterInstance, Cancel, ReasoningEffort, TextArgs};
use ai_provider_router_lib::core::egress::SENTINEL;
use ai_provider_router_lib::core::http_port::{
    HttpError, HttpMethod, HttpPort, HttpRequest, HttpResponse,
};
use ai_provider_router_lib::core::interpreter::{AdapterContext, ManifestInterpreter};
use futures_util::future::BoxFuture;
use futures_util::StreamExt;
use serde_json::{json, Map, Value};

const DEFAULT_BASE_URL: &str = "https://agentrouter.org/v1";
const DEFAULT_MODEL: &str = "deepseek-v4-flash";

/// The user-agent the app's own egress sends when a manifest declares none — the same string, so a
/// probe that gets through proves the production header does too. Some gateways refuse clients they
/// do not recognise (`client_gate.rs` is this repo's record of that behaviour) and agentrouter is
/// one of them: measured 2026-10-02, it answers 401 `unauthorized client detected` for a bare
/// `reqwest` user-agent *and* for this app's own. `AIPROBE_UA` overrides it, which is how the
/// provider's stored manifests make it reachable — a per-endpoint `user-agent` beats this default.
fn default_user_agent() -> String {
    concat!("AI-Provider-Router/", env!("CARGO_PKG_VERSION")).to_string()
}

/// One request and the answer it got.
struct Capture {
    request: HttpRequest,
    status: u16,
    response: String,
    ms: u128,
}

/// A real HTTP port that remembers every request it sent and every body it got back.
#[derive(Clone)]
struct RecordingPort {
    client: reqwest::Client,
    key: String,
    captures: Arc<Mutex<Vec<Capture>>>,
}

impl RecordingPort {
    fn new(key: String, user_agent: String) -> Self {
        Self {
            // No timeout of its own: the point of a live probe is to see what the provider does, and
            // a client-side cut-off would turn "slow" into a result this file cannot read.
            client: reqwest::Client::builder()
                .user_agent(user_agent)
                .build()
                .expect("the TLS stack initialises"),
            key,
            captures: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// The bodies this port sent, oldest first.
    fn sent(&self) -> Vec<Value> {
        self.captures
            .lock()
            .unwrap()
            .iter()
            .map(|c| {
                serde_json::from_str(c.request.body.as_deref().expect("a POST carries a body"))
                    .expect("the interpreter renders JSON")
            })
            .collect()
    }

    /// The raw response bodies, oldest first.
    fn received(&self) -> Vec<Value> {
        self.captures
            .lock()
            .unwrap()
            .iter()
            .map(|c| serde_json::from_str(&c.response).unwrap_or(Value::Null))
            .collect()
    }
}

impl HttpPort for RecordingPort {
    fn request<'a>(
        &'a self,
        req: HttpRequest,
        _cancel: &'a Cancel,
    ) -> BoxFuture<'a, Result<HttpResponse<'a>, HttpError>> {
        Box::pin(async move {
            let mut builder = match req.method {
                HttpMethod::Get => self.client.get(&req.url),
                HttpMethod::Post => self.client.post(&req.url),
            };
            // The manifest's declared headers, with the sentinel replaced by the real key — the
            // substitution the app's own egress performs. Header values never reach a print.
            let mut has_content_type = false;
            for (name, value) in &req.headers {
                if name.eq_ignore_ascii_case("content-type") {
                    has_content_type = true;
                }
                builder = builder.header(name, value.replace(SENTINEL, &self.key));
            }
            if req.body.is_some() && !has_content_type {
                builder = builder.header("content-type", "application/json");
            }
            if let Some(body) = &req.body {
                builder = builder.body(body.clone());
            }

            let started = Instant::now();
            let response = builder
                .send()
                .await
                .map_err(|e| HttpError::new(format!("transport: {e}")))?;
            let status = response.status().as_u16();
            let body = response
                .text()
                .await
                .map_err(|e| HttpError::new(format!("body: {e}")))?;
            self.captures.lock().unwrap().push(Capture {
                request: req,
                status,
                response: body.clone(),
                ms: started.elapsed().as_millis(),
            });

            // A unary call: `lines` is present exactly for a successful streaming request, and every
            // call this file makes is `stream: false`.
            Ok(HttpResponse { status, headers: BTreeMap::new(), body, lines: None })
        })
    }
}

/// One unary `generateText` through the real interpreter, with what went out and what came back.
struct Outcome {
    sent: Value,
    received: Value,
    status: u16,
    ms: u128,
    /// Everything the manifest's `responseMap` could read. Empty when the model wrote no answer at
    /// all — the failure the thinking knob exists to work around.
    text: String,
}

async fn call(
    port: &Arc<RecordingPort>,
    base_url: &str,
    model: &str,
    prompt: &str,
    reasoning: Option<ReasoningEffort>,
) -> Outcome {
    let manifest = ai_provider_router_lib::core::builtin_templates::anthropic_compat(base_url);
    let interp = ManifestInterpreter::new(
        &manifest,
        AdapterContext { http: port.clone(), vars: Map::new() },
    )
    .expect("the builtin reads as a manifest");

    let messages = vec![json!({ "role": "user", "content": prompt })];
    let cancel = Cancel::new();
    let args = TextArgs {
        model: model.to_string(),
        messages: &messages,
        stream: false,
        max_tokens: None, // the manifest's own `limits.maxOutputTokens`
        temperature: None,
        reasoning,
        tools: None,
        tool_choice: None,
        response_format: None,
        on_tool_call: None,
        on_usage: None,
        on_finish: None,
        on_reasoning: None,
        prompt_cache_enabled: false,
        observation: None,
    };
    let stream = interp
        .generate_text("key:probe", args, &cancel)
        .await
        .expect("the response phase — a 4xx surfaces here with the provider's own words");
    let text: String = stream.filter_map(|r| async move { r.ok() }).collect().await;

    let index = port.captures.lock().unwrap().len().checked_sub(1).expect("the call sent a request");
    let sent = port.sent()[index].clone();
    let received = port.received()[index].clone();
    let (status, ms) = {
        let captures = port.captures.lock().unwrap();
        (captures[index].status, captures[index].ms)
    };
    Outcome { sent, received, status, ms, text }
}

/// The probe's env, or a printed `SKIP` — a missing credential is never a failure.
struct Probe {
    key: String,
    base_url: String,
    model: String,
    user_agent: String,
}

fn probe() -> Option<Probe> {
    let Ok(key) = std::env::var("AIPROBE_KEY") else {
        println!("SKIP — AIPROBE_KEY is unset; set it to a real key to run this probe");
        return None;
    };
    if key.trim().is_empty() {
        println!("SKIP — AIPROBE_KEY is empty");
        return None;
    }
    Some(Probe {
        key,
        base_url: std::env::var("AIPROBE_BASE_URL").unwrap_or_else(|_| DEFAULT_BASE_URL.to_string()),
        model: std::env::var("AIPROBE_MODEL").unwrap_or_else(|_| DEFAULT_MODEL.to_string()),
        user_agent: std::env::var("AIPROBE_UA").unwrap_or_else(|_| default_user_agent()),
    })
}

/// Does the setting reach the wire, and does the provider answer the request it renders?
#[tokio::test]
#[ignore = "needs the public internet and AIPROBE_KEY; run by hand with --ignored --nocapture"]
async fn the_thinking_knob_reaches_the_provider() {
    let Some(p) = probe() else { return };
    println!("probing {} with {}", p.base_url, p.model);
    println!("user-agent: {}", p.user_agent);

    let port = Arc::new(RecordingPort::new(p.key.clone(), p.user_agent.clone()));
    let question = "Reply with exactly: ok";

    let unset = call(&port, &p.base_url, &p.model, question, None).await;
    let off = call(&port, &p.base_url, &p.model, question, Some(ReasoningEffort::Off)).await;
    let high = call(&port, &p.base_url, &p.model, question, Some(ReasoningEffort::High)).await;

    for (label, o) in [("unset", &unset), ("off", &off), ("high", &high)] {
        println!("\n--- {label} ---");
        println!("sent: {}", serde_json::to_string_pretty(&o.sent).unwrap());
        println!(
            "HTTP {} in {}ms · stop_reason={} · usage={}",
            o.status,
            o.ms,
            o.received.get("stop_reason").unwrap_or(&Value::Null),
            o.received.get("usage").unwrap_or(&Value::Null),
        );
        println!("text: {:?}", &o.text[..o.text.len().min(120)]);
    }
    println!("\n--- raw answers ---");
    for (label, o) in [("unset", &unset), ("off", &off), ("high", &high)] {
        println!("{label}: {}", o.received);
    }

    // The three bodies are what this repo owns. `render_template` renders the template's own keys:
    // `{{thinking?}}` is declared by the builtin the provider is derived from, so a missing field
    // here is the knob failing to reach the wire — not a provider decision.
    assert!(unset.sent.get("thinking").is_none(), "unset must send no field: {}", unset.sent);
    assert_eq!(
        off.sent.get("thinking"),
        Some(&json!({ "type": "disabled" })),
        "off must send the dialect's own disable: {sent}",
        sent = off.sent
    );
    let thinking = high.sent.get("thinking").expect("high must send the thinking field");
    assert_eq!(thinking["type"], "enabled", "high enables thinking: {thinking}");
    let budget = thinking["budget_tokens"].as_u64().expect("the budget is a number");
    assert!(
        (1024..=8192).contains(&budget),
        "the budget must be inside Anthropic's own floor/ceiling, got {budget}"
    );

    // The upstream's verdict on each. A 4xx would have surfaced as an error from `call` above, so
    // reaching here means every request was accepted; these lines pin that it also answered.
    for (label, o) in [("unset", &unset), ("off", &off), ("high", &high)] {
        assert_eq!(o.status, 200, "{label}: HTTP {}", o.status);
        assert!(!o.text.trim().is_empty(), "{label}: the provider accepted the request but wrote no text");
    }
}

/// The escape hatch, on the prompt that broke: the same hard question, asked with the provider's own
/// default and then with thinking off. Nothing is asserted about the upstream's behaviour — this
/// prints the two outcomes side by side so a human can see whether `off` is still worth having.
#[tokio::test]
#[ignore = "needs the public internet and AIPROBE_KEY; run by hand with --ignored --nocapture"]
async fn thinking_off_is_the_escape_hatch_for_a_hard_question() {
    let Some(p) = probe() else { return };

    let port = Arc::new(RecordingPort::new(p.key.clone(), p.user_agent.clone()));
    // The shape of the prompt that produced the 46-second `PARSE_ERROR`: many constraints at once, so
    // a reasoning model works through them before writing anything.
    let hard = "Design a rate limiter for a multi-tenant API. Cover: the storage structure, the \
                algorithm, how a tenant's burst is amortised, how clock skew across nodes is handled, \
                what happens when the store is unreachable, and the migration path from the current \
                in-process counter. Be concrete about data structures and give the trade-offs at each \
                decision.";

    let default = call(&port, &p.base_url, &p.model, hard, None).await;
    let off = call(&port, &p.base_url, &p.model, hard, Some(ReasoningEffort::Off)).await;

    for (label, o) in [("provider default", &default), ("thinking off", &off)] {
        println!("\n--- {label} ---");
        println!(
            "HTTP {} in {}ms · stop_reason={} · usage={}",
            o.status,
            o.ms,
            o.received.get("stop_reason").unwrap_or(&Value::Null),
            o.received.get("usage").unwrap_or(&Value::Null),
        );
        println!("thinking in the answer: {}", answer_has_thinking(o));
        println!("text: {:?}", &o.text[..o.text.len().min(200)]);
    }
}

/// Whether the raw answer carried a `thinking` content block. Read off the response rather than the
/// chunks because the manifest's `responseMap` extracts only text and usage, so a thinking block
/// leaves no trace in `Outcome::text` — which is exactly why this is printed and not asserted.
fn answer_has_thinking(o: &Outcome) -> bool {
    o.received
        .get("content")
        .and_then(|c| c.as_array())
        .map(|blocks| blocks.iter().any(|b| b.get("type").and_then(|t| t.as_str()) == Some("thinking")))
        .unwrap_or(false)
}
