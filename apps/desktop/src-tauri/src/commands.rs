//! Tauri command surface.
//!
//! Trust note (diff-review 2026-09-15): Tauri 2 capability files ACL plugin/core commands,
//! NOT app-defined commands — every command below is callable from the webview. The webview
//! is therefore treated as UNTRUSTED here: no raw secret reads, no allowlist mutation, no
//! raw SQL, vault accounts restricted to `key:*`, and egress pairs secret_ref to its own
//! provider host (see egress.rs).

use std::sync::Arc;

use tauri::ipc::Channel;
use tauri::State;

use crate::egress::{self, EgressRequest, EgressState, StreamEvent};
use crate::store::{self, Store};
use crate::vault;
use crate::crash_report;

#[derive(Debug, serde::Serialize)]
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

/// `CommandError` is serialized to the webview (Tauri requires `Serialize`). It also implements
/// `Display` so non-command callers — e.g. `gateway_cmds`, which needs a `String` error — can
/// reuse `persist::*` helpers through the ordinary `?`/`map_err` idiom instead of reaching into
/// the tuple field. One error type, two surfaces.
impl std::fmt::Display for CommandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<CommandError> for String {
    fn from(e: CommandError) -> Self {
        e.0
    }
}

/// All webview-facing vault accounts must be provider keys (`key:<keyId>`); the gateway
/// `masterkey` account is host-only (invariant 10).
fn check_account(account: &str) -> Result<(), CommandError> {
    if account.starts_with("key:") {
        Ok(())
    } else {
        Err(CommandError("vault account namespace not permitted".into()))
    }
}

// ---------- vault:* ----------

/// Store a provider key. TS never reads the secret back except via the Rust-side one-shot
/// reveal flow (invariant 14) — there is intentionally NO `vault_get` command. The egress
/// gateway reads it internally.
#[tauri::command]
pub fn vault_put(account: String, secret: String) -> Result<(), CommandError> {
    check_account(&account)?;
    vault::put(&account, &secret).map_err(Into::into)
}

#[tauri::command]
pub fn vault_delete(account: String) -> Result<(), CommandError> {
    check_account(&account)?;
    vault::delete(&account).map_err(Into::into)
}

#[tauri::command]
pub fn vault_has(account: String) -> Result<bool, CommandError> {
    check_account(&account)?;
    let found = vault::get(&account).map(|v| v.is_some())?;
    Ok(found)
}

// ---------- egress:* ----------

#[tauri::command]
pub async fn egress_request(
    state: State<'_, Arc<EgressState>>,
    req: EgressRequest,
) -> Result<egress::EgressResponse, CommandError> {
    egress::request(&state, req).await.map_err(Into::into)
}

#[tauri::command]
pub async fn egress_stream(
    state: State<'_, Arc<EgressState>>,
    req: EgressRequest,
    on_event: Channel<StreamEvent>,
) -> Result<(), CommandError> {
    egress::stream(&state, req, on_event)
        .await
        .map_err(Into::into)
}

/// Invariant-3 carve-out: fetch a provider-returned URL (an imageUrl) as base64, scoped to
/// that response, never an allowlist entry. No secret involved.
#[tauri::command]
pub async fn egress_fetch_image(
    state: State<'_, Arc<EgressState>>,
    req: egress::ImageFetchRequest,
) -> Result<egress::ImageFetchResponse, CommandError> {
    egress::fetch_image(&state, req).await.map_err(Into::into)
}

// NOTE: no egress_allow_host / egress_deny_host commands. The allowlist is mutated only by
// provider CRUD host-side (persist.rs) — a compromised webview cannot open new destinations.

// ---------- store:* ----------
// Narrow surface only: the webview gets structured queries, never raw SQL (invariant 12).

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

/// Return the app data directory from the store's DB path (parent of the .db file).
fn app_data_dir(store: &store::Store) -> std::path::PathBuf {
    std::path::PathBuf::from(&store.path)
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_default()
}

// ── crash reporting (L0 — local only, no external telemetry) ─────────────────

#[tauri::command]
pub fn crash_count(store: State<'_, Arc<store::Store>>) -> Result<usize, CommandError> {
    Ok(crash_report::crash_count(&app_data_dir(&store)))
}

#[tauri::command]
pub fn crash_list(store: State<'_, Arc<store::Store>>) -> Result<Vec<String>, CommandError> {
    Ok(crash_report::list_crash_reports(&app_data_dir(&store)))
}

#[tauri::command]
pub fn crash_read(
    store: State<'_, Arc<store::Store>>,
    id: String,
) -> Result<Option<crash_report::CrashReport>, CommandError> {
    Ok(crash_report::read_crash_report(&app_data_dir(&store), &id))
}

#[tauri::command]
pub fn crash_clear(
    store: State<'_, Arc<store::Store>>,
    id: String,
) -> Result<bool, CommandError> {
    Ok(crash_report::clear_crash_report(&app_data_dir(&store), &id))
}

#[tauri::command]
pub fn crash_clear_all(store: State<'_, Arc<store::Store>>) -> Result<usize, CommandError> {
    Ok(crash_report::clear_all_crash_reports(&app_data_dir(&store)))
}

pub fn handlers() -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        vault_put,
        vault_delete,
        vault_has,
        egress_request,
        egress_stream,
        egress_fetch_image,
        store_info,
        settings_set,
        settings_get,
        crate::persist::providers_list,
        crate::persist::provider_upsert,
        crate::persist::provider_delete,
        crate::persist::api_keys_list,
        crate::persist::api_key_upsert,
        crate::persist::api_key_delete,
        crate::persist::manifests_active,
        crate::persist::manifest_upsert_active,
        crate::persist::models_cache_replace,
        crate::persist::models_cache_list,
        crate::persist::aliases_replace,
        crate::persist::aliases_list,
        crate::persist::ledger_append,
        crate::persist::ledger_recent,
        crate::persist::ledger_rollup_run,
        crate::gateway_cmds::gateway_status,
        crate::gateway_cmds::get_tools_enabled,
        crate::gateway_cmds::set_tools_enabled,
        crate::gateway_cmds::gateway_enable,
        crate::gateway_cmds::gateway_disable,
        crate::gateway_cmds::gateway_key_generate,
        crate::gateway_cmds::gateway_key_copy,
        crate::gateway_cmds::gateway_key_revoke,
        // Audit R4: per-app gateway keys + monthly spend cap.
        crate::gateway_cmds::gateway_app_key_create,
        crate::gateway_cmds::gateway_app_keys,
        crate::gateway_cmds::gateway_app_key_revoke,
        crate::gateway_cmds::gateway_app_key_delete,
        crate::gateway_cmds::gateway_spend_status,
        crate::gateway_cmds::gateway_spend_cap_set,
        crate::gateway_cmds::gateway_heartbeat,
        crate::gateway_cmds::gateway_worker_error,
        crate::gateway_cmds::gateway_chunk,
        crate::gateway_cmds::gateway_result,
        crate::gateway_cmds::gateway_done,
        crate::gateway_cmds::gateway_error,
        crate::gateway_cmds::gateway_tool_calls,
        crate::gateway_cmds::gateway_usage,
        crate::gateway_cmds::gateway_set_workspace_root,
        crate::gateway_cmds::gateway_get_workspace_root,
        crate::gateway_cmds::gateway_tool_run,
        crate::workbuddy::workbuddy_sync,
        crate::workbuddy::workbuddy_status,
        crate::workbuddy::workbuddy_set_models,
        crate::persist::onboarding_save,
        crate::persist::onboarding_latest_active,
        crate::persist::generator_audit_record,
        crate::persist::drift_event_record,
        crate::persist::drift_event_resolve,
        crate::persist::manifests_history,
        crate::persist::manifest_stage,
        crate::persist::manifest_activate,
        crate::persist::config_export,
        crate::persist::config_import,
        crate::persist::diagnostics_bundle,
        crate::tools::tools_policy,
        crate::tools::tool_run,
        // Crash reporting (local-only, no external telemetry)
        crate::commands::crash_count,
        crate::commands::crash_list,
        crate::commands::crash_read,
        crate::commands::crash_clear,
        crate::commands::crash_clear_all,
    ]
}
