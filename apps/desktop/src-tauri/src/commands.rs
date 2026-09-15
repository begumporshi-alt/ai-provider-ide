//! Tauri command surface. Namespaced so capability files can scope them precisely
//! (invariant 12): vault:*, egress:*, store:*.

use std::sync::Arc;

use tauri::ipc::Channel;
use tauri::State;

use crate::egress::{self, EgressRequest, EgressState, StreamEvent};
use crate::store::{self, Store};
use crate::vault;

#[derive(serde::Serialize)]
pub struct CommandError(pub String);

impl From<egress::EgressError> for CommandError {
    fn from(e: egress::EgressError) -> Self {
        CommandError(e.to_string())
    }
}
impl From<vault::VaultError> for CommandError {
    fn from(e: vault::VaultError) -> Self {
        CommandError(e.to_string())
    }
}
impl From<crate::store::StoreError> for CommandError {
    fn from(e: crate::store::StoreError) -> Self {
        CommandError(e.to_string())
    }
}
impl From<rusqlite::Error> for CommandError {
    fn from(e: rusqlite::Error) -> Self {
        CommandError(e.to_string())
    }
}

// ---------- vault:* ----------

/// Store a provider key. TS never reads the secret back except via the Rust-side one-shot
/// reveal flow (invariant 14) — there is intentionally NO `vault_get` command. The egress
/// gateway reads it internally.
#[tauri::command]
pub fn vault_put(account: String, secret: String) -> Result<(), CommandError> {
    vault::put(&account, &secret).map_err(Into::into)
}

#[tauri::command]
pub fn vault_delete(account: String) -> Result<(), CommandError> {
    vault::delete(&account).map_err(Into::into)
}

#[tauri::command]
pub fn vault_has(account: String) -> Result<bool, CommandError> {
    let found = vault::get(&account).map(|v| v.is_some())?;
    Ok(found)
}

// ---------- egress:* ----------

#[tauri::command]
pub async fn egress_request(
    state: State<'_, Arc<EgressState>>,
    req: EgressRequest,
) -> Result<egress::EgressResponse, CommandError> {
    let client = state.client.clone();
    let allow = &state.allow;
    // Run on a blocking-free async path; reqwest handles the runtime.
    egress::request(&client, allow, req).await.map_err(Into::into)
}

#[tauri::command]
pub async fn egress_stream(
    state: State<'_, Arc<EgressState>>,
    req: EgressRequest,
    on_event: Channel<StreamEvent>,
) -> Result<(), CommandError> {
    let client = state.client.clone();
    let allow = &state.allow;
    egress::stream(&client, allow, req, on_event)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub fn egress_allow_host(state: State<'_, Arc<EgressState>>, host: String) -> Result<(), CommandError> {
    state.allow.allow(&host);
    Ok(())
}

#[tauri::command]
pub fn egress_deny_host(state: State<'_, Arc<EgressState>>, host: String) -> Result<(), CommandError> {
    state.allow.deny(&host);
    Ok(())
}

// ---------- store:* ----------
// Narrow surface only: the webview gets structured queries, never raw SQL (invariant 12).
// v1 ships store_info + key-value settings; richer queries come with the screens that need
// them (Phase 2a) so the surface never exceeds what the UI actually calls.

#[tauri::command]
pub fn store_info(store: State<'_, Arc<Store>>) -> Result<store::StoreInfo, CommandError> {
    store.info().map_err(Into::into)
}

#[tauri::command]
pub fn settings_set(store: State<'_, Arc<Store>>, key: String, value_json: String) -> Result<(), CommandError> {
    let conn = store.conn.lock().unwrap();
    conn.execute(
        "INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",
        rusqlite::params![key, value_json],
    )?;
    Ok(())
}

#[tauri::command]
pub fn settings_get(store: State<'_, Arc<Store>>, key: String) -> Result<Option<String>, CommandError> {
    let conn = store.conn.lock().unwrap();
    let mut stmt = conn.prepare("SELECT value_json FROM settings WHERE key = ?")?;
    let mut rows = stmt.query_map([key], |r| r.get::<_, String>(0))?;
    match rows.next() {
        Some(v) => Ok(Some(v?)),
        None => Ok(None),
    }
}

pub fn handlers() -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        vault_put,
        vault_delete,
        vault_has,
        egress_request,
        egress_stream,
        egress_allow_host,
        egress_deny_host,
        store_info,
        settings_set,
        settings_get
    ]
}
