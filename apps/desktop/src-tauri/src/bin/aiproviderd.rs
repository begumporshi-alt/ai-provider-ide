//! `aiproviderd` — the gateway as a standalone service. No Tauri, no WebView, no window.
//!
//! Phase 5e of the headless plan (`docs/dev-book/10-headless-service.md`). The HTTP server
//! starts, binds, and **serves completions** through a Rust-native `RouterBridge` that runs
//! the tool loop against `ModelRouter` and `AdapterRuntime`, writing to `ReplyHandle`.
//!
//! The binary builds that bridge from the store's four tables (hydration, 25b), the egress port
//! (25a), the activated adapters (25c), and the store-backed ledger sink (25d). The placeholder
//! `HeadlessBridge` that used to live here — a bridge that discarded every dispatch and answered
//! 503 — was deleted in 25f along with `Bridge::ready`, the seam it existed to exercise: with no
//! webview left in the tree, there is no bridge whose readiness can change.

use std::path::PathBuf;
use std::sync::Arc;

use ai_provider_router_lib::core::{
    activation,
    adapter_runtime::AdapterRuntime,
    crash_report,
    egress::AllowList,
    egress::EgressState,
    egress_port::EgressPort,
    gateway,
    ledger::{StoreLedgerSink, UsageLedger},
    persist,
    router::{RouterSettings, RouterStore, SharedRouterState},
    router_bridge::{BridgeHost, RouterBridge},
    service, store,
};
use tokio::runtime::Handle;

/// The gateway's own port. Not `gateway::DEFAULT_PORT`, which is 8787 — the value the desktop
/// app was left with and which collides with AI Hub v2's port. The persisted setting always
/// wins; this is only the fallback when no setting row exists yet.
const SERVICE_DEFAULT_PORT: u16 = 8800;

/// Tauri's `appDataDir` for the same identifier, so the service and the app open the *same*
/// SQLite file. Duplicated rather than imported because resolving it needs no Tauri app:
/// `tauri.conf.json` identifier `dev.aiprovider.router`.
fn data_dir() -> Result<PathBuf, String> {
    if let Some(dir) = std::env::var_os("AIP_DATA_DIR") {
        return Ok(PathBuf::from(dir));
    }
    let identifier = "dev.aiprovider.router";
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME").ok_or("HOME is not set")?;
        Ok(PathBuf::from(home).join("Library/Application Support").join(identifier))
    }
    #[cfg(target_os = "windows")]
    {
        let appdata = std::env::var_os("APPDATA").ok_or("APPDATA is not set")?;
        Ok(PathBuf::from(appdata).join(identifier))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let base = match std::env::var_os("XDG_DATA_HOME") {
            Some(d) => PathBuf::from(d),
            None => PathBuf::from(std::env::var_os("HOME").ok_or("HOME is not set")?)
                .join(".local/share"),
        };
        Ok(base.join(identifier))
    }
}

/// The host the headless service presents to the bridge. Reads settings from the store and
/// returns the same defaults the desktop app builds with.
struct HeadlessHost {
    store: Arc<store::Store>,
}

impl BridgeHost for HeadlessHost {
    fn settings(&self) -> RouterSettings {
        RouterSettings::from_store(&self.store)
    }
    /// Read from the store, not hardcoded.
    ///
    /// **This used to return `true` unconditionally, and that had a latency cost nothing named.**
    /// Gateway-owned tools are what make `ProseGate` hold prose back (`hold = (ownership ==
    /// Gateway)`), so a service that always supplies tools buffers every streaming answer: the
    /// first content byte arrived at the *end* of the upstream's stream — measured 1,209 ms
    /// against an upstream that had started emitting immediately. The desktop app was never
    /// affected because it answers from `HostSettings`, a live toggle the UI flips; a service has
    /// no UI, so hardcoding `true` removed the operator's only lever.
    ///
    /// Read per request, like `settings`, so flipping the row reaches the next request rather than
    /// the next restart.
    fn tools_enabled(&self) -> bool {
        RouterSettings::from_store(&self.store).gateway_tools_enabled
    }
    fn tools_mutation_enabled(&self) -> bool {
        false
    }
    fn workspace_root(&self) -> Option<String> {
        None
    }
}

/// The current executable's path — what install copies into the stable binary slot.
fn self_path() -> Result<PathBuf, String> {
    std::env::current_exe()
        .map(|p| p.canonicalize().unwrap_or(p))
        .map_err(|e| format!("cannot resolve current executable: {e}"))
}

fn cmd_install() {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    let data_dir = data_dir().unwrap_or_else(|e| {
        eprintln!("aiproviderd install: cannot resolve the data directory: {e}");
        std::process::exit(1);
    });

    let mut paths = service::paths(&home, &data_dir);
    paths.environment.insert("AIP_DATA_DIR".to_string(), data_dir.display().to_string());

    let exe = match self_path() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("aiproviderd install: {e}");
            std::process::exit(1);
        }
    };

    let domain = match service::read_uid().map(service::domain) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("aiproviderd install: cannot resolve the launchd domain: {e}");
            std::process::exit(1);
        }
    };

    match service::install(&paths, &exe, &domain, &service::run_launchctl) {
        Ok(()) => {
            println!(
                "aiproviderd: installed. The gateway will start at login and restart on failure."
            );
            println!("Check status with: aiproviderd status");
        }
        Err(e) => {
            eprintln!("aiproviderd install failed: {e}");
            std::process::exit(1);
        }
    }
}

fn cmd_uninstall() {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    let data_dir = data_dir().unwrap_or_else(|e| {
        eprintln!("aiproviderd uninstall: cannot resolve the data directory: {e}");
        std::process::exit(1);
    });

    let paths = service::paths(&home, &data_dir);
    let domain = match service::read_uid().map(service::domain) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("aiproviderd uninstall: cannot resolve the launchd domain: {e}");
            std::process::exit(1);
        }
    };

    match service::uninstall(&paths, &domain, &service::run_launchctl) {
        Ok(()) => {
            println!("aiproviderd: uninstalled. The agent plist and binary copy have been removed.")
        }
        Err(e) => {
            eprintln!("aiproviderd uninstall failed: {e}");
            std::process::exit(1);
        }
    }
}

fn cmd_status() {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    let data_dir = data_dir().unwrap_or_else(|e| {
        eprintln!("aiproviderd status: cannot resolve the data directory: {e}");
        std::process::exit(1);
    });

    let paths = service::paths(&home, &data_dir);
    let domain = match service::read_uid().map(service::domain) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("aiproviderd status: cannot resolve the launchd domain: {e}");
            std::process::exit(1);
        }
    };

    match service::status(&paths, &domain, &service::run_launchctl) {
        Ok(s) => {
            println!("plist present : {}", s.plist_present);
            println!("loaded        : {}", s.loaded);
            match s.pid {
                Some(pid) => println!("pid           : {pid}"),
                None => println!("pid           : (not running)"),
            }
        }
        Err(e) => {
            eprintln!("aiproviderd status: {e}");
            std::process::exit(1);
        }
    }
}

/// Copy the current binary to /usr/local/bin/aiproviderd so it is on PATH without a full
/// path. Requires write access to /usr/local/bin (Homebrew installs it user-writable on
/// Intel Macs; on Apple Silicon it lives at /opt/homebrew/bin and is user-writable).
fn cmd_self_install() {
    let exe = match self_path() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("aiproviderd self-install: {e}");
            std::process::exit(1);
        }
    };

    // Pick the user-writable bin dir.
    let candidates = [
        PathBuf::from("/opt/homebrew/bin"), // Apple Silicon + Homebrew
        PathBuf::from("/usr/local/bin"),    // Intel + Homebrew, or manual install
    ];

    let target_dir = candidates.iter().find(|d| d.exists()).cloned().unwrap_or_else(|| {
        eprintln!(
            "aiproviderd self-install: neither /opt/homebrew/bin nor /usr/local/bin exists. \
                 Install one of them first, or add the binary's directory to PATH manually."
        );
        std::process::exit(1);
    });

    let target = target_dir.join("aiproviderd");

    match std::fs::copy(&exe, &target) {
        Ok(_) => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755));
            }
            println!("aiproviderd: installed to {}", target.display());
            println!(
                "You can now run: aiproviderd install, aiproviderd status, aiproviderd uninstall"
            );
        }
        Err(e) => {
            eprintln!(
                "aiproviderd self-install failed to copy to {}:\n  {}\n\n\
                 Try:  sudo cp {} {} && sudo chmod +x {}",
                target.display(),
                e,
                exe.display(),
                target.display(),
                target.display()
            );
            std::process::exit(1);
        }
    }
}

/// Mint (or rotate) the master key directly into the secrets file. No UI, no auth — this is the
/// bootstrap command for a fresh install or a vault migration.
fn cmd_mint() {
    let data_dir = match data_dir() {
        Ok(d) => d,
        Err(e) => {
            eprintln!("aiproviderd mint: cannot resolve the data directory: {e}");
            std::process::exit(1);
        }
    };
    ai_provider_router_lib::core::vault::set_data_dir(&data_dir);

    // Check if a key already exists; if so, replace it (rotate).
    let had_existing =
        ai_provider_router_lib::core::vault::get("masterkey").ok().flatten().is_some();

    let full_key = ai_provider_router_lib::core::gateway::generate_random_key();

    if let Err(e) = ai_provider_router_lib::core::vault::put("masterkey", &full_key) {
        eprintln!("aiproviderd mint: failed to write the key: {e}");
        std::process::exit(1);
    }

    if had_existing {
        println!("aiproviderd: rotated the master key.");
    } else {
        println!("aiproviderd: minted a new master key.");
    }
    println!();
    println!("Master key : {full_key}");
    println!("Store path  : {}", data_dir.display());
    println!("Note: the previous key is no longer valid.");
    println!("If you're using aiproviderd as a headless gateway, restart it with:");
    println!("  aiproviderd install && aiproviderd status");
}

#[tokio::main]
async fn main() {
    let version = env!("CARGO_PKG_VERSION");
    let args: Vec<String> = std::env::args().skip(1).collect();

    // Subcommands that must run before the tokio runtime / store setup.
    let sub = args.first().map(String::as_str);
    if let Some(cmd) = sub {
        match cmd {
            "install" => {
                cmd_install();
                return;
            }
            "uninstall" => {
                cmd_uninstall();
                return;
            }
            "status" => {
                cmd_status();
                return;
            }
            "self-install" => {
                cmd_self_install();
                return;
            }
            "mint" => {
                cmd_mint();
                return;
            }
            _ => {}
        }
    }

    if args.iter().any(|a| a == "--version" || a == "-V") {
        println!("aiproviderd {version}");
        return;
    }

    let _ = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .with_env_filter(std::env::var("GW_LOG").unwrap_or_else(|_| "info".to_string()))
        .try_init();

    let dir = match data_dir() {
        Ok(d) => d,
        Err(e) => {
            eprintln!("aiproviderd: cannot resolve the data directory: {e}");
            std::process::exit(1);
        }
    };
    crash_report::install_panic_hook(dir.clone());
    // Point the file-backed vault at this dir so secrets land next to the SQLite DB.
    ai_provider_router_lib::core::vault::set_data_dir(&dir);

    let store = match store::Store::open(&dir) {
        Ok(s) => Arc::new(s),
        Err(e) => {
            eprintln!("aiproviderd: cannot open the store at {}: {e}", dir.display());
            std::process::exit(1);
        }
    };

    let port = gateway::persisted_gateway_port(&store).unwrap_or(SERVICE_DEFAULT_PORT);

    // Build the egress (25a), the adapter runtime (25c), and the router store (25b).
    //
    // **The allowlist must be populated here, and nothing did it.** `AllowList::default()` is an
    // empty set — `egress.rs`'s own tests assert that it denies `https://attacker.example/v1` — and
    // `check_url` refuses every non-local host not in it. The app fills it from provider CRUD
    // (`persist::recompute_allow`, called on create/update/delete); a service has no CRUD path, so
    // without this line every outbound provider call is `HostDenied`, which the attempt layer
    // reports as `NETWORK`. The visible symptom is a `502` whose message blames the upstream
    // (`all attempts failed … :NETWORK`) when the refusal is local policy.
    //
    // Found by the first end-to-end run against a real provider, and invisible to every test: each
    // constructor below did have a production caller (D40), and `AllowList::default()` being empty
    // is intended behaviour rather than a defect. See D45.
    let allow = Arc::new(AllowList::default());
    // `allow.clone()` rather than `allow`: the `Arc` is shared with the egress state, so the local
    // handle sees what `recompute_allow` writes below and can be handed to activation as the same
    // list the request path will consult. A second `AllowList` here would be the defect D46 is.
    let egress_state = Arc::new(EgressState::new(allow.clone(), store.clone()));
    persist::recompute_allow(&egress_state.allow, &store);
    let egress_port = Arc::new(EgressPort::new(egress_state));
    let runtime = AdapterRuntime::new(egress_port);

    // Activate every manifest that has an active row (25c). Skip, don't abort — and since 25h a
    // manifest whose host the allowlist refuses is one of the skips (D46), so a provider that could
    // never be dialled is named once here rather than reported as an upstream failure per request.
    let activation = match activation::activate(&runtime, &store, &allow) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("aiproviderd: activation failed: {e}");
            std::process::exit(1);
        }
    };
    if !activation.registered.is_empty() {
        println!("aiproviderd: activated {} provider(s)", activation.registered.len());
    }
    for skipped in &activation.skipped {
        // A versionless skip is a provider with no manifest row at all — a builtin profile that
        // failed, or a provider left half-written by `addProvider`. There is no "v?" to print.
        match skipped.version {
            Some(v) => eprintln!(
                "aiproviderd: skipped provider {} v{v}: {}",
                skipped.provider_id, skipped.reason
            ),
            None => eprintln!(
                "aiproviderd: skipped provider {}: {}",
                skipped.provider_id, skipped.reason
            ),
        }
    }

    let router_store = match RouterStore::from_store(&store) {
        Ok(s) => Arc::new(s),
        Err(e) => {
            eprintln!("aiproviderd: router store hydration failed: {e}");
            std::process::exit(1);
        }
    };

    let ledger = UsageLedger::new().with_sink(Box::new(StoreLedgerSink::new(store.clone())));
    let shared = SharedRouterState::new().with_ledger(ledger);
    let host = Arc::new(HeadlessHost { store: store.clone() });
    let bridge = Arc::new(RouterBridge::new(
        router_store,
        Arc::new(runtime),
        shared,
        host,
        Handle::current(),
    ));

    // Same wiring as the desktop app builds in `gateway_cmds::manage`: the key, per-app-key
    // and spend providers are all store-backed and Tauri-free already.
    let core = gateway::GatewayCore::new(bridge, gateway::vault_key_provider())
        .with_store(store.clone())
        // The allowlist, so admin provider CRUD can keep it in step with `providers.base_url`.
        // Without this a provider created over HTTP gets a row and no grant — D46 by the CRUD path.
        .with_allowlist(allow.clone())
        .with_app_keys(gateway::vault_app_key_provider(store.clone()))
        .with_spend(gateway::vault_spend_provider(store));

    // The app sets this from the Start button; a service is always on, so it is set at boot.
    core.set_running(true);

    let handle = match gateway::spawn(Arc::new(core), port).await {
        Ok(h) => h,
        Err(e) => {
            eprintln!("aiproviderd: {e}");
            std::process::exit(1);
        }
    };

    println!("aiproviderd {version} listening on {}", handle.addr);
    println!("GET /health is live; completion routes are served by the Rust router core.");

    // Blocks forever. There is no `tokio::signal` feature enabled, and a service has no stdin
    // to close; termination is the supervisor's job (launchd / systemd / Ctrl-C).
    std::future::pending::<()>().await;
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    fn tmp_store() -> (store::Store, std::path::PathBuf) {
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("aip-aiproviderd-{n}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let s = store::Store::open(&dir).unwrap();
        (s, dir)
    }

    #[test]
    fn headless_host_returns_defaults_on_an_empty_store() {
        let (store, _dir) = tmp_store();
        let host = HeadlessHost { store: Arc::new(store) };
        assert_eq!(host.settings(), RouterSettings::default());
        assert!(host.tools_enabled());
        assert!(!host.tools_mutation_enabled());
        assert_eq!(host.workspace_root(), None);
    }

    #[test]
    fn headless_host_reads_the_gateway_tools_toggle_from_the_store() {
        let (store, _dir) = tmp_store();
        {
            let conn = store.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO settings (key, value_json) VALUES ('router', '{\"gatewayToolsEnabled\":false}')",
                [],
            )
            .unwrap();
        }
        let host = HeadlessHost { store: Arc::new(store) };
        // The host's answer is what decides `ToolOwnership`, and ownership is what decides whether
        // `ProseGate` holds prose back. If this read regressed to `true`, streaming would silently
        // go back to buffering the whole answer with every test still green.
        assert!(
            !host.tools_enabled(),
            "a stored false must reach the host, or incremental streaming is unreachable"
        );
        assert!(!host.settings().gateway_tools_enabled);
    }

    #[test]
    fn headless_host_reads_settings_from_the_store() {
        let (store, _dir) = tmp_store();
        {
            let conn = store.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO settings (key, value_json) VALUES ('router', '{\"failoverEnabled\":true,\"systemAi\":{\"providerId\":\"openai\",\"model\":\"gpt-4\"},\"perProviderConcurrency\":8}')",
                [],
            )
            .unwrap();
        }
        let host = HeadlessHost { store: Arc::new(store) };
        let s = host.settings();
        assert!(s.failover_enabled);
        assert_eq!(
            s.system_ai,
            Some(ai_provider_router_lib::core::router::SystemAiPick {
                provider_id: "openai".to_string(),
                model: "gpt-4".to_string(),
            })
        );
        // perProviderConcurrency is copied through un-clamped, so the raw Value is preserved.
        assert_eq!(s.per_provider_concurrency, serde_json::json!(8));
    }

    /* ==================== the end-to-end run, against a stub upstream ==================== */

    /// The stub upstream: a real HTTP server on a loopback port.
    ///
    /// **It counts what it served, and the tests assert on that count.** Without it, a gateway that
    /// refused the request *before* egress — an empty allowlist (D45), or a manifest whose host is
    /// not its provider's own (D46) — answers 502, and every other assertion here would read that
    /// refusal as a streaming result. `scripts/measure-gateway-latency.mjs` refuses to print its
    /// numbers in exactly that state; this is the same guard, as an assertion.
    struct Stub {
        served: Arc<AtomicUsize>,
        addr: std::net::SocketAddr,
        _task: tokio::task::JoinHandle<()>,
    }

    /// Six content deltas, then `[DONE]` — the shape the measurement harness's stub emits, so the
    /// two agree on what "relayed" means.
    const STUB_CHUNKS: [&str; 6] = ["Hel", "lo", " ", "wor", "ld", "!"];

    impl Stub {
        async fn start() -> Stub {
            use axum::extract::State;
            use axum::response::IntoResponse;
            use axum::routing::post;

            let served = Arc::new(AtomicUsize::new(0));

            async fn chat(
                State(counter): State<Arc<AtomicUsize>>,
                axum::Json(body): axum::Json<serde_json::Value>,
            ) -> axum::response::Response {
                counter.fetch_add(1, Ordering::SeqCst);
                if body.get("stream").and_then(serde_json::Value::as_bool) == Some(true) {
                    let mut sse = String::new();
                    for c in STUB_CHUNKS {
                        sse.push_str(&format!(
                            "data: {{\"choices\":[{{\"delta\":{{\"content\":\"{c}\"}}}}]}}\n\n"
                        ));
                    }
                    sse.push_str("data: [DONE]\n\n");
                    return ([(axum::http::header::CONTENT_TYPE, "text/event-stream")], sse)
                        .into_response();
                }
                axum::Json(serde_json::json!({
                    "choices": [{ "message": { "role": "assistant", "content": "pong" } }],
                    "usage": { "prompt_tokens": 7, "completion_tokens": 1, "total_tokens": 8 }
                }))
                .into_response()
            }

            let app = axum::Router::new()
                .route("/v1/chat/completions", post(chat))
                .with_state(served.clone());
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let task = tokio::spawn(async move {
                let _ = axum::serve(listener, app).await;
            });
            Stub { served, addr, _task: task }
        }

        fn base_url(&self) -> String {
            format!("http://{}/v1", self.addr)
        }

        fn served(&self) -> usize {
            self.served.load(Ordering::SeqCst)
        }
    }

    /// The declarative manifest the router reaches the stub through.
    ///
    /// **The `stream` block is load-bearing, and leaving it out is a trap that cost a debugging
    /// round.** `run_text` sets `streaming = args.stream && ep.stream.is_some()`, but it renders
    /// `values.stream` from `args.stream` — the *caller's* flag. So a manifest that declares no
    /// `stream` block still sends `"stream": true` upstream, the provider answers with SSE, and the
    /// interpreter then parses that SSE text with `responseMap.text` as if it were JSON. The failure
    /// surfaces as `AttemptError::Transport`, i.e. `NETWORK` at the gateway, with the discarded
    /// reason being a `serde_json` error on the body — nothing about it says "your manifest has no
    /// stream block". This fixture therefore carries the block, as the installed OpenRouter
    /// template does.
    fn manifest_json(base_url: &str) -> String {
        serde_json::json!({
            "manifestVersion": 1,
            "kind": "declarative",
            "dialect": "openai-chat-v1",
            "provider": {
                "baseUrl": base_url,
                "auth": { "headers": [{ "name": "Authorization", "prefix": "Bearer" }] }
            },
            "endpoints": {
                "generateText": {
                    "method": "POST",
                    "path": "/chat/completions",
                    "requestTemplate": {
                        "model": "{{model}}",
                        "messages": "{{messages}}",
                        "stream": "{{stream}}"
                    },
                    "responseMap": { "text": "$.choices[0].message.content" },
                    "stream": {
                        "protocol": "sse",
                        "chunkMap": { "delta": "$.choices[0].delta.content" },
                        "finish": "$.choices[0].finish_reason"
                    }
                }
            },
            "capabilities": { "text": true, "image": false }
        })
        .to_string()
    }

    /// Every row the four hydrated tables need, all pointing at the stub.
    ///
    /// `providers.base_url` and the manifest's `provider.baseUrl` are written from the **same**
    /// argument, which is the point: D46 is what happens when they disagree, and the second test
    /// below creates that state deliberately rather than by accident.
    fn seed(store: &store::Store, base_url: &str, tools_enabled: bool) {
        let conn = store.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO providers (id, slug, name, base_url, status, rotation_strategy, created_at, updated_at)
             VALUES ('p1','stub','Stub',?1,'enabled','priority',1,1)",
            rusqlite::params![base_url],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO api_keys (id, provider_id, label, secret_ref, status, priority, added_at)
             VALUES ('k1','p1','k1','key:k1','active',0,1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO models_cache (id, provider_id, native_id, modality, fetched_at)
             VALUES ('p1:m1','p1','m1','text',1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO manifests (id, provider_id, version, origin, body_json, created_at, is_active)
             VALUES ('p1-v1','p1',1,'ai-generated',?1,1,1)",
            rusqlite::params![manifest_json(base_url)],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO settings (key, value_json) VALUES ('router', ?1)",
            rusqlite::params![format!("{{\"gatewayToolsEnabled\":{tools_enabled}}}")],
        )
        .unwrap();
    }

    /// The whole service, in-process, with two substitutions — and both are seams production
    /// already exposes rather than branches that exist only for tests.
    ///
    /// - `EgressState::with_secret_provider` keeps the request path off the OS keychain. Its own
    ///   note makes the argument; `gateway::KeyProvider` made it first.
    /// - the master key is injected the same way, for the same reason.
    ///
    /// Everything else is the real thing: the real store on a real file, the real allowlist derived
    /// by `recompute_allow`, the real activation reading `manifests.body_json`, the real router
    /// hydrating four tables, the real egress, the real `RouterBridge`, the real ledger sink, the
    /// real `HeadlessHost`, and the real axum surface on an ephemeral port.
    struct Harness {
        base: String,
        store: Arc<store::Store>,
        /// The egress and its allowlist, kept so a test can build a **second** runtime over the same
        /// policy — which is how the D46 test observes a launch rather than a re-activation.
        ///
        /// The boot `AdapterRuntime` is deliberately *not* a field: the bridge owns it from the
        /// moment `boot` returns, and nothing here reaches for it.
        egress: Arc<EgressState>,
        allow: Arc<AllowList>,
        stub: Stub,
        _handle: gateway::ServerHandle,
        _dir: PathBuf,
    }

    /// Take this process out of any ambient HTTP proxy, once, before the first client is built.
    ///
    /// **Not test hygiene — the trap the measurement harness hit, reproduced here.** `reqwest` reads
    /// `http_proxy` / `https_proxy` / `all_proxy` from the environment when a client is *built*, and
    /// there is no per-request override, so on a machine that has a proxy set and no `NO_PROXY`
    /// every **loopback** provider call is handed to the proxy and fails. The attempt layer
    /// classifies that as `NETWORK`, so the gateway answers a 502 whose message blames the provider
    /// for the local environment — which is exactly how the first end-to-end run against a stub
    /// died, with `all attempts failed for m1 [stub/k1:NETWORK]` and a stub that had served nothing.
    /// `scripts/measure-gateway-latency.mjs` deletes the same six variables before it spawns the
    /// service; this is the in-process equivalent.
    ///
    /// `Once` rather than a bare loop because both tests below call it and `cargo test` runs them on
    /// separate threads: the removal has to happen before the first `ClientBuilder::build()`, and
    /// `call_once` blocks the second caller until the first has finished.
    fn leave_ambient_proxies() {
        static ONCE: std::sync::Once = std::sync::Once::new();
        ONCE.call_once(|| {
            for k in
                ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "all_proxy"]
            {
                std::env::remove_var(k);
            }
        });
    }

    async fn boot(tools_enabled: bool) -> Harness {
        leave_ambient_proxies();
        let stub = Stub::start().await;
        let (store, dir) = tmp_store();
        seed(&store, &stub.base_url(), tools_enabled);
        let store = Arc::new(store);

        let allow = Arc::new(AllowList::default());
        let egress_state = Arc::new(EgressState::with_secret_provider(
            allow.clone(),
            store.clone(),
            Arc::new(|_: &str| Ok(Some("sk-stub".to_string()))),
        ));
        persist::recompute_allow(&egress_state.allow, &store);

        let runtime =
            Arc::new(AdapterRuntime::new(Arc::new(EgressPort::new(egress_state.clone()))));

        // The same `AllowList` the request path will consult, so this activation is judged by the
        // policy that will actually be enforced (25h).
        let act =
            activation::activate(&runtime, &store, &allow).expect("a readable store activates");
        assert_eq!(
            act.registered,
            vec!["p1".to_string()],
            "the stub provider must activate, or nothing below is measuring a route: {:?}",
            act.skipped
        );

        let router_store = Arc::new(RouterStore::from_store(&store).expect("hydration"));
        let ledger = UsageLedger::new().with_sink(Box::new(StoreLedgerSink::new(store.clone())));
        let shared = SharedRouterState::new().with_ledger(ledger);
        let host = Arc::new(HeadlessHost { store: store.clone() });
        let bridge = Arc::new(RouterBridge::new(
            router_store,
            runtime.clone(),
            shared,
            host,
            Handle::current(),
        ));

        let core = gateway::GatewayCore::new(bridge, Arc::new(|| Some("test-gw-key".to_string())))
            .with_store(store.clone())
            .with_app_keys(Arc::new(Vec::<gateway::AppKey>::new))
            .with_spend(gateway::vault_spend_provider(store.clone()));
        core.set_running(true);
        let handle = gateway::spawn(Arc::new(core), 0).await.expect("bind an ephemeral port");

        Harness {
            base: format!("http://{}", handle.addr),
            store,
            egress: egress_state,
            allow,
            stub,
            _handle: handle,
            _dir: dir,
        }
    }

    /// The client-visible content deltas of an SSE body, in order.
    ///
    /// Parsed rather than counted by substring: `"content":"` also appears in a *request* echo, and
    /// the assertion this feeds is about frames.
    fn sse_contents(body: &str) -> Vec<String> {
        body.lines()
            .filter_map(|l| l.strip_prefix("data: "))
            .filter(|d| *d != "[DONE]")
            .filter_map(|d| serde_json::from_str::<serde_json::Value>(d).ok())
            .filter_map(|v| {
                v.pointer("/choices/0/delta/content")
                    .and_then(serde_json::Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
            })
            .collect()
    }

    /// One completion through the gateway.
    ///
    /// `stream` is a parameter rather than a constant because the two shapes report a failure
    /// differently, and both are worth pinning: a streaming client has already been sent `200` and
    /// its headers by the time the router gives up, so the refusal arrives as an **SSE frame**,
    /// while a non-streaming client gets the status the gateway actually decided.
    async fn chat(base: &str, stream: bool) -> (reqwest::StatusCode, String) {
        let res = reqwest::Client::new()
            .post(format!("{base}/v1/chat/completions"))
            .header("authorization", "Bearer test-gw-key")
            .json(&serde_json::json!({
                "model": "m1",
                "messages": [{ "role": "user", "content": "hi" }],
                "stream": stream
            }))
            .send()
            .await
            .expect("the gateway must answer");
        let status = res.status();
        (status, res.text().await.unwrap_or_default())
    }

    /// **The measurement from `scripts/measure-gateway-latency.mjs`, as an assertion.**
    ///
    /// The script measured time-to-first-token, which is the user-visible symptom. This asserts the
    /// *structural* fact that timing was evidence for — and it is the version that can run in CI,
    /// because a buffered answer and a relayed one differ in how many frames the client sees, and
    /// that count does not depend on the clock.
    ///
    /// Measured 2026-09-24, the same request through this harness:
    ///
    /// | `gatewayToolsEnabled` | content frames | text |
    /// |---|---|---|
    /// | `true` (the default) | 1 | `Hello world!` |
    /// | `false` | 6 | `Hello world!` |
    ///
    /// The text is asserted equal across both cases on purpose: the setting may change *when* the
    /// client sees the answer, never *what* it is. And the second request runs against the **same
    /// running gateway** as the first — no restart, no re-activation — which is what pins
    /// `HeadlessHost::tools_enabled`'s "read per request, so flipping the row reaches the next
    /// request rather than the next restart" as a claim about behaviour rather than a doc comment.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_gateway_relays_upstream_deltas_only_when_gateway_tools_are_off() {
        let h = boot(true).await;
        let before = h.stub.served();

        let (status, body) = chat(&h.base, true).await;
        assert_eq!(status, 200, "body: {body}");
        assert!(
            h.stub.served() > before,
            "the stub served nothing — the gateway refused before egress (D45/D46), and every \
             assertion below would be measuring a refusal rather than a route"
        );

        let held = sse_contents(&body);
        assert_eq!(
            held.len(),
            1,
            "tools on ⇒ `ToolOwnership::Gateway` ⇒ `ProseGate` holds every delta and releases \
             once: {body}"
        );
        assert_eq!(held.concat(), "Hello world!");

        {
            let conn = h.store.conn.lock().unwrap();
            conn.execute(
                "UPDATE settings SET value_json = '{\"gatewayToolsEnabled\":false}' WHERE key = 'router'",
                [],
            )
            .unwrap();
        }

        let (status, body) = chat(&h.base, true).await;
        assert_eq!(status, 200, "body: {body}");
        let relayed = sse_contents(&body);
        assert_eq!(
            relayed.len(),
            STUB_CHUNKS.len(),
            "tools off ⇒ `ToolOwnership::None` ⇒ no hold, so each of the {} upstream deltas must \
             reach the client as its own frame; got {} frame(s): {body}",
            STUB_CHUNKS.len(),
            relayed.len()
        );
        assert_eq!(relayed.concat(), held.concat(), "the setting must not change the text");

        // The ledger, through the store-backed sink (25d) — the other half of what a real request
        // does, and the half a bridge-level test cannot see.
        let rows: i64 = h
            .store
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM ledger", [], |r| r.get(0))
            .unwrap();
        assert!(rows >= 2, "the store-backed sink must have recorded both requests, got {rows}");
    }

    /// **D46, closed at the boot path.** The egress allowlist derives from `providers.base_url`; the
    /// adapter dials the host in the active manifest's `provider.baseUrl`. Repoint one and not the
    /// other and the two disagree — which used to mean every request became a local `HostDenied`
    /// that the attempt layer reported as `NETWORK`: a 502 blaming the upstream for our own policy.
    ///
    /// **Observed through a *fresh* runtime, and that is not incidental.** A *re*-activation would
    /// keep the previous adapter serving, because `register` builds before it swaps (D32) and a skip
    /// never reaches `register` at all — so the request would still succeed and the test would prove
    /// nothing about a launch. A launch builds an empty runtime, and that is the state asserted here.
    ///
    /// **What this does not cover, stated rather than implied:** the running gateway still holds the
    /// adapter boot registered, and a provider edited at runtime does not re-activate — so a
    /// mismatch created *after* launch still reaches `check_url` and is still reported as `NETWORK`.
    /// Closing that needs the refusal to carry its own class, which would add a token to the
    /// cross-language `ErrorClass` contract; recorded in the register rather than taken here.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_manifest_host_outside_the_allowlist_is_skipped_at_activation_not_502d_per_request() {
        let h = boot(false).await;
        let before = h.stub.served();

        // Repoint the manifest's host only. The provider row still names the stub, so the allowlist
        // no longer contains the host this manifest dials — D46's divergence, created deliberately.
        {
            let conn = h.store.conn.lock().unwrap();
            conn.execute(
                "UPDATE manifests SET body_json = replace(body_json, ?1, 'https://not-allowlisted.example/v1')
                 WHERE id = 'p1-v1'",
                rusqlite::params![h.stub.base_url()],
            )
            .unwrap();
        }

        let fresh = AdapterRuntime::new(Arc::new(EgressPort::new(h.egress.clone())));
        let act = activation::activate(&fresh, &h.store, &h.allow).expect("activation");

        assert!(act.registered.is_empty(), "a provider that cannot be dialled must not register");
        assert_eq!(act.skipped.len(), 1);
        let reason = &act.skipped[0].reason;
        assert!(
            reason.contains("not-allowlisted.example"),
            "the skip must name the host it refused: {reason}"
        );
        assert!(
            reason.contains("allowlist"),
            "the skip must name the local policy, not the provider's health: {reason}"
        );
        assert!(fresh.registered().is_empty(), "nothing serves this provider");
        assert_eq!(
            h.stub.served(),
            before,
            "the divergence must be settled without dialling anything — the assertion that separates \
             a local refusal from a network failure"
        );
    }
}
