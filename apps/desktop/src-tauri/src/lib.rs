mod commands;
mod crash_report;
mod egress;
mod gateway;
mod gateway_cmds;
mod persist;
mod store;
mod tools;
mod vault;

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
            app.manage(store);
            app.manage(egress_state);
            gateway_cmds::manage(app)?;
            Ok(())
        })
        .invoke_handler(commands::handlers())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
