mod commands;
mod crash_report;
mod egress;
mod gateway;
mod gateway_cmds;
mod persist;
mod store;
mod tools;
mod vault;
mod workbuddy;

use std::sync::{Arc, RwLock};

use tauri::Manager;

/// Seed the egress allowlist from registered provider base URLs. Only statuses that can
/// actually serve (pending/enabled/repairing) are allowed (invariant 9: no stale grants).
fn initial_allow_hosts(store: &store::Store) -> std::collections::HashSet<String> {
    let conn = store.conn.lock().unwrap();
    let mut hosts = std::collections::HashSet::new();
    if let Ok(mut stmt) = conn.prepare("SELECT base_url FROM providers WHERE status IN ('pending','enabled','repairing')") {
        if let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(0)) {
            for row in rows.flatten() {
                if let Ok(u) = reqwest::Url::parse(&row) {
                    if let Some(h) = u.host_str() {
                        hosts.insert(h.to_lowercase());
                    }
                }
            }
        }
    }
    hosts
}

/// §4 startup hygiene: probe every key's secret_ref against the keychain; on a miss mark the
/// key 'invalid' so the Providers screen can run the re-enter-key flow (audit H7). The raw
/// secret is never read out — only existence is checked, host-side.
fn probe_key_refs(store: &store::Store) {
    let refs: Vec<(String, String)> = {
        let conn = store.conn.lock().unwrap();
        let Ok(mut stmt) = conn.prepare("SELECT id, secret_ref FROM api_keys WHERE status != 'invalid'") else {
            return;
        };
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .map(|rows| rows.flatten().collect())
            .unwrap_or_default()
    };
    let mut missing = Vec::new();
    for (id, account) in refs {
        if let Ok(None) = vault::get(&account) {
            missing.push(id);
        }
    }
    if !missing.is_empty() {
        let conn = store.conn.lock().unwrap();
        for id in missing {
            let _ = conn.execute(
                "UPDATE api_keys SET status = 'invalid' WHERE id = ?1",
                rusqlite::params![id],
            );
        }
    }
}

/// The port the gateway should come back up on, or `None` when it was left off.
///
/// The gateway is a local endpoint other processes point at — WorkBuddy's custom-provider entry
/// among them — so "was serving" is a setting, not a session detail. A gateway that needs a click
/// after every relaunch silently breaks every client configured against it.
fn persisted_gateway_port(store: &store::Store) -> Option<u16> {
    let conn = store.conn.lock().unwrap();
    let value: String = conn
        .query_row("SELECT value_json FROM settings WHERE key = 'gateway'", [], |r| r.get(0))
        .ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&value).ok()?;
    if parsed.get("enabled")?.as_bool()? != true {
        return None;
    }
    Some(parsed.get("port")?.as_u64()? as u16)
}

/// R1 background mode: closing the window hides the app instead of quitting, so the gateway
/// keeps serving. The tray is the way back — and the only way out that doesn't require
/// Activity Monitor — so if it cannot be built we deliberately leave close-to-quit in place.
/// Stranding a running process with no UI is worse than the problem this solves.
fn build_tray(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder};
    use tauri::tray::TrayIconBuilder;

    let show = MenuItemBuilder::with_id("show", "Open AI-Provider Router").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
    let menu = MenuBuilder::new(app).item(&show).separator().item(&quit).build()?;

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("AI-Provider Router")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_window(app),
            "quit" => app.exit(0),
            _ => {}
        });
    // Reuse the bundled app icon; a tray with no icon is invisible on most platforms.
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

fn show_window(app: &tauri::AppHandle) {
    use tauri::Manager as _;
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
    // Deliberately does NOT clear the core's hidden flag: that flag describes the *bridge
    // host* window, which is the permanently-hidden gateway worker. Restoring the UI has no
    // bearing on whether the worker renderer is throttled.
}

/// R1: read the persisted preference. Default ON — background mode is the whole point of
/// shipping this, and a user who wants close-to-quit can turn it off in the Gateway screen.
fn hide_on_close(app: &tauri::AppHandle) -> bool {
    use tauri::Manager as _;
    let Some(store) = app.try_state::<std::sync::Arc<store::Store>>() else {
        return true;
    };
    let raw: Option<String> = store
        .conn
        .lock()
        .ok()
        .and_then(|conn| {
            conn.query_row("SELECT value_json FROM settings WHERE key='background'", [], |r| r.get(0))
                .ok()
        });
    match raw.as_deref().and_then(|v| serde_json::from_str::<serde_json::Value>(v).ok()) {
        Some(v) => v.get("hideOnClose").and_then(|b| b.as_bool()).unwrap_or(true),
        None => true,
    }
}


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize tracing (stderr JSON on debug, plain text on release)
    let _ = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .with_env_filter(
            std::env::var("GW_LOG").unwrap_or_else(|_| "info".to_string()),
        )
        .try_init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // L0 services: OS keychain (via keyring), egress gateway, sql-store.
            let data_dir = app.path().app_data_dir()?;
            // Install the panic hook now that we know the real app data dir.
            // This captures panics that happen after setup completes (the common case).
            // Panics during setup itself will print to stderr but won't produce a report —
            // that's an acceptable tradeoff since such panics are rare and obvious.
            crash_report::install_panic_hook(data_dir.clone());
            let store = Arc::new(
                store::Store::open(&data_dir).map_err(|e| format!("store init failed: {e}"))?,
            );
            probe_key_refs(&store);
            let allow = Arc::new(egress::AllowList(RwLock::new(initial_allow_hosts(&store))));
            let egress_state = Arc::new(egress::EgressState::new(allow, store.clone()));
            gateway_cmds::run_rollup(&store);
            // Read before `store` is handed to `app.manage` — after that it is gone.
            let restore_port = persisted_gateway_port(&store);
            app.manage(store);
            app.manage(egress_state);
            gateway_cmds::manage(app)?;
            // R1: tray is best-effort. On failure we log and fall through with close-to-quit
            // intact, so the app can never end up running with no way to reach it.
            if let Err(e) = build_tray(app.handle()) {
                tracing::warn!("tray icon unavailable — close will quit: {e}");
            }
            // Bring the gateway back if it was serving when the app last quit. Best-effort: a
            // failure here must never stop the UI from opening, so it is logged and dropped.
            if let Some(port) = restore_port {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    match crate::gateway_cmds::gateway_enable(handle, Some(port)).await {
                        Ok(bound) => tracing::info!("gateway restored on port {bound}"),
                        Err(e) => tracing::warn!("gateway auto-restore failed: {e}"),
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(commands::handlers())
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            // R1: closing the UI window must not end the process. The gateway's renderer is a
            // separate hidden window, so it keeps serving regardless.
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::CloseRequested { api, .. },
                ..
            } => {
                if label == "main" && hide_on_close(app) {
                    use tauri::Manager as _;
                    api.prevent_close();
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.hide();
                        tracing::info!("window hidden — gateway still serving in background");
                    }
                }
            }
            // R1: macOS Dock icon click / Finder reopen — the discoverable way back.
            // `RunEvent::Reopen` is macOS-only in Tauri, so it is gated for cross-platform builds.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => show_window(app),
            _ => {}
        });
}
