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
    store,
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

#[tokio::main]
async fn main() {
    let version = env!("CARGO_PKG_VERSION");
    let args: Vec<String> = std::env::args().skip(1).collect();
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
    let egress_state = Arc::new(EgressState::new(allow, store.clone()));
    persist::recompute_allow(&egress_state, &store);
    let egress_port = Arc::new(EgressPort::new(egress_state));
    let runtime = AdapterRuntime::new(egress_port);

    // Activate every manifest that has an active row (25c). Skip, don't abort.
    let activation = match activation::activate(&runtime, &store) {
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
        eprintln!(
            "aiproviderd: skipped provider {} v{}: {}",
            skipped.provider_id, skipped.version, skipped.reason
        );
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
}
