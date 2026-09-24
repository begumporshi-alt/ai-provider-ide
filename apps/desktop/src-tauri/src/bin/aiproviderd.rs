//! `aiproviderd` — the gateway as a standalone service. No Tauri, no WebView, no window.
//!
//! Phase 1 of the headless plan (`docs/dev-book/10-headless-service.md`). What this proves is
//! narrow and worth stating exactly: **the HTTP server starts and binds without a Tauri app.**
//! It does not serve completions, and it is not supposed to yet.
//!
//! The router core is still TypeScript running in a hidden webview, reached through the
//! `Bridge` trait. With no webview there is nothing to bridge to, so this binary installs
//! `HeadlessBridge`, which discards every dispatch and reports itself **not ready** — so every
//! completion route answers **503 core unavailable**, by design. Auth, capacity, spend and
//! `/health` still work because none of them touch the bridge.
//!
//! That 503 used to arrive for the wrong reason. `is_available()` was
//! `is_running() && beat_is_fresh()`, and no heartbeat ever arrives here, so the request was
//! refused by a liveness gate no bridge could open. The gate is now `Bridge::ready` (D35), so
//! this binary's answer is its own statement rather than a question the core asked of a webview
//! that is not there. `HeadlessBridge::ready` says `false` because it genuinely cannot serve.
//!
//! Phase 5c replaces `HeadlessBridge` with `RouterBridge`, which answers `true`.

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

    /// **Never ready**, and that is the honest answer rather than a placeholder: this bridge
    /// discards every dispatch, so it cannot answer anything. Saying `true` would not make the
    /// service work — it would only move the failure, from an immediate `503 core unavailable` to
    /// a request that sits in the bridge until `FIRST_MSG_TIMEOUT` expires. The module note below
    /// is unchanged by this: completions answer 503, and now they say so for the right reason.
    ///
    /// Note what this is *not*: a heartbeat. Before `Bridge::ready` existed the core asked
    /// `beat_is_fresh()`, which no heartbeat could satisfy here, so the 503 came from a liveness
    /// gate that was never going to open. The gate is now the bridge's own statement (D35).
    fn ready(&self, _beat: gateway::Beat) -> bool {
        false
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

#[cfg(test)]
mod tests {
    use super::*;
    use ai_provider_router_lib::core::gateway::Bridge;

    /// The service's bridge reports itself unable to serve, and that answer is what turns every
    /// completion into a fast `503 core unavailable` rather than a request parked inside the bridge
    /// until `FIRST_MSG_TIMEOUT` expires.
    ///
    /// The fresh beat is the point: `webview_ready` would answer `true` for it, so this asserts
    /// that the headless bridge is *not* answering as a webview bridge would. Regressing this to
    /// `true` would not make the service work — it would only move the failure thirty seconds later.
    #[test]
    fn the_headless_bridge_reports_itself_unable_to_serve() {
        let beat = gateway::Beat { age: std::time::Duration::ZERO, hidden: false };
        assert!(beat.is_fresh(), "the beat itself is fresh");
        assert!(
            !HeadlessBridge.ready(beat),
            "a bridge that discards every dispatch is not ready, however fresh the beat"
        );
    }
}
