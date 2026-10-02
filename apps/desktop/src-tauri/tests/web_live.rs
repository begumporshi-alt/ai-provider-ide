//! The live web checks, as a command rather than a paragraph.
//!
//! **`#[ignore]`d on purpose, for the same reason `launchd_live.rs` is.** These tests need the
//! public internet: a search backend answering, a real page serving. On CI they would go red
//! for reasons that have nothing to do with the code — a rate limit, a captive portal — and a
//! suite that fails randomly teaches people to ignore it. So they are gated behind `--ignored`
//! and run by hand when the web layer changes:
//!
//! ```text
//! cd apps/desktop/src-tauri
//! cargo test --test web_live -- --ignored --nocapture --test-threads=1
//! ```
//!
//! **One thread on purpose.** The two search tests hit the same engine; running them
//! concurrently from one IP triggers its anomaly detection (observed live: HTTP 202 with a
//! challenge page), and a test suite that fails on its own traffic is noise. A rate-limited
//! run prints `SKIP` — a green run with a SKIP line is NOT a verification of search, read the
//! output (the `launchd_live.rs` convention).
//!
//! What they cover, and why the coverage is worth having despite the offline suite:
//!
//! 1. `web_search_serves_real_results` — the offline suite pins the PARSERS against fixtures;
//!    this proves the live pages still match the fixtures. A markup change on a backend is
//!    exactly the failure a fixture cannot see.
//! 2. `web_fetch_text_reads_a_real_page` — the guard, the fetch, and the HTML reduction against
//!    a real server whose content is stable (`example.com`).
//! 3. `tool_run_serves_web_search_end_to_end` — the FULL tool path, `tool_run` with the
//!    arguments object shape the callers send, which is the one entry point both the Assistant
//!    (via the `tool_run` Tauri command) and the gateway bridge execute. A live pass here is
//!    the tool working for the agent, not just for a library caller.
//!
//! What this file does NOT cover, stated rather than implied: it does not boot the desktop app
//! or the gateway HTTP wire. Those layers are thin by design and are pinned offline
//! (`router_bridge` asserts the registry reaches the wire; the Tauri commands are pass-through
//! wrappers), but a full UI round-trip is a human-level check in the running app.

use ai_provider_router_lib::core::tools::{tool_run, ToolRunRequest};

#[test]
#[ignore = "needs the public internet; run by hand with --ignored --nocapture"]
fn web_search_serves_real_results() {
    let search = ai_provider_router_lib::core::web::web_search("rust programming language");
    let Ok((backend, hits)) = search else {
        let e = search.unwrap_err();
        if e.contains("bot check") || e.contains("rate limit") {
            println!("SKIP — the engine is rate-limiting this client right now; not a verification");
            return;
        }
        panic!("live search: {e}");
    };
    println!("served by {backend}, {} hits", hits.len());
    assert!(!hits.is_empty(), "a live search must return results");
    for hit in hits.iter().take(3) {
        println!("  - {} → {}", hit.title, hit.url);
        assert!(
            hit.url.starts_with("http://") || hit.url.starts_with("https://"),
            "every hit must be a real URL: {}",
            hit.url
        );
    }
}

#[test]
#[ignore = "needs the public internet; run by hand with --ignored --nocapture"]
fn web_fetch_text_reads_a_real_page() {
    let text = ai_provider_router_lib::core::web::web_fetch_text("https://example.com")
        .expect("example.com is the most stable page on the web");
    println!("{}", &text[..text.len().min(300)]);
    assert!(text.contains("Example Domain"), "the page's own heading must survive the reduction");
    assert!(text.contains("URL:"), "the citation header must be present");
}

#[test]
#[ignore = "needs the public internet; run by hand with --ignored --nocapture --test-threads=1"]
fn tool_run_serves_web_search_end_to_end() {
    // The callers send the arguments as a JSON object (Assistant host) or a JSON string
    // (gateway wire) — this sends the string form, the harder of the two.
    let root = std::env::temp_dir().join(format!("aip-web-live-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let req = ToolRunRequest {
        name: "web_search".into(),
        // The gateway wire sends `arguments` as a JSON *string*; `arguments_object` parses it
        // back. This exercises that harder path, not the plain object.
        arguments: serde_json::Value::String(
            serde_json::json!({ "query": "example domain" }).to_string(),
        ),
        root: root.to_string_lossy().into_owned(),
    };
    let res = tool_run(req);
    let err_text = res.error.clone().unwrap_or_default();
    if !res.ok && (err_text.contains("bot check") || err_text.contains("rate limit")) {
        println!("SKIP — the engine is rate-limiting this client right now; not a verification");
        return;
    }
    assert!(res.ok, "tool_run(web_search) must succeed: {err_text:?}");
    let out = res.output;
    println!("{}", &out[..out.len().min(500)]);
    assert!(out.contains("Results for"), "{out}");
    assert!(out.contains("via "), "the serving backend must be named: {out}");
}
