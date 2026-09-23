//! `aiproviderd` — the gateway as a standalone service. No Tauri, no WebView, no window.
//!
//! Phase 1 of the headless plan (`docs/dev-book/10-headless-service.md`). What this proves is
//! narrow and worth stating exactly: **the HTTP server starts and binds without a Tauri app.**
//! It does not serve completions, and it is not supposed to yet.
//!
//! The router core is still TypeScript running in a hidden webview, reached through the
//! `Bridge` trait. With no webview there is nothing to bridge to, so this binary installs
//! `HeadlessBridge`, which discards every dispatch. `GatewayCore::is_available()` is
//! `is_running() && beat_is_fresh()`, and no heartbeat ever arrives — so every completion
//! route answers **503 core unavailable**, by design. Auth, capacity, spend and `/health`
//! still work because none of them touch the bridge.
//!
//! Phase 2 ports the router core to Rust and replaces `HeadlessBridge` with it.

use std::path::PathBuf;
use std::sync::Arc;

use ai_provider_router_lib::core::{crash_report, gateway, store};

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

/// The bridge with nothing on the other end. See the module note: this is what makes every
/// completion 503 until Phase 2 lands a real router core behind it.
struct HeadlessBridge;

impl gateway::Bridge for HeadlessBridge {
    /// Discards the request *and* the reply handle. Every completion route therefore answers
    /// 503 by design — see the module note — and the handle being dropped rather than stored is
    /// the seam working, not a gap in it.
    fn dispatch(&self, _req: gateway::BridgeRequest, _replies: gateway::ReplyHandle) {}
    fn cancel(&self, _id: u64) {}
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

    // Same wiring as the desktop app builds in `gateway_cmds::manage`, minus the bridge: the
    // key, per-app-key and spend providers are all store-backed and Tauri-free already.
    let core = gateway::GatewayCore::new(Arc::new(HeadlessBridge), gateway::vault_key_provider())
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
    println!("GET /health is live; completion routes answer 503 until the router core is ported.");

    // Blocks forever. There is no `tokio::signal` feature enabled, and a service has no stdin
    // to close; termination is the supervisor's job (launchd / systemd / Ctrl-C).
    std::future::pending::<()>().await;
}
