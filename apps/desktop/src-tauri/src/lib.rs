mod commands;
mod egress;
mod store;
mod vault;

use std::sync::Arc;

use tauri::Manager;

/// Hydrate the host allowlist from registered provider base URLs (invariant 3, §4).
fn initial_allowlist(store: &store::Store) -> egress::AllowList {
    let allow = egress::AllowList::default();
    let conn = store.conn.lock().unwrap();
    if let Ok(mut stmt) = conn.prepare("SELECT base_url FROM providers WHERE status != 'draft'") {
        if let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(0)) {
            for row in rows.flatten() {
                if let Ok(u) = reqwest::Url::parse(&row) {
                    if let Some(h) = u.host_str() {
                        allow.allow(h);
                    }
                }
            }
        }
    }
    allow
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // L0 services: OS keychain (via keyring), egress gateway, sql-store.
            let data_dir = app.path().app_data_dir()?;
            let store = store::Store::open(&data_dir).map_err(|e| format!("store init failed: {e}"))?;
            let allow = initial_allowlist(&store);
            app.manage(Arc::new(store));
            app.manage(Arc::new(egress::EgressState {
                client: egress::client(),
                allow,
            }));
            Ok(())
        })
        .invoke_handler(commands::handlers())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
