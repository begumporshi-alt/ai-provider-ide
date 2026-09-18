//! Gateway command surface + production bridge (§3.3). The production Bridge emits Tauri
//! events into the webview (where the router core runs); the webview answers via the
//! gateway_* commands. Master-key reveal is clipboard-only from Rust (invariant 14): the
//! key never appears in webview-observable state.

use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter, Manager, State};

use crate::gateway::{self, Bridge, BridgeMsg, BridgeRequest, GatewayCore};
use crate::store::Store;

pub struct GatewayState {
    pub core: Arc<GatewayCore>,
    pub server: Mutex<Option<gateway::ServerHandle>>,
}

/// Production bridge: dispatch/cancel flow as events to the webview.
struct EventBridge {
    app: AppHandle,
}

impl Bridge for EventBridge {
    fn dispatch(&self, req: BridgeRequest) {
        let _ = self.app.emit("gateway-request", &req);
    }
    fn cancel(&self, request_id: u64) {
        let _ = self.app.emit("gateway-cancel", serde_json::json!({ "requestId": request_id }));
    }
}

pub fn build_core(app: &AppHandle) -> Arc<GatewayCore> {
    let core = GatewayCore::new(
        Arc::new(EventBridge { app: app.clone() }),
        gateway::vault_key_provider(),
    );
    // R4: per-app keys + monthly spend cap, both store-backed. `try_state` because setup order
    // is not guaranteed for every caller (a harness may build a core with no Store managed);
    // in that case the gateway degrades to master-key-only and uncapped rather than panicking.
    // The setters (`set_app_keys` / `set_spend`) take over at runtime when a key is created or
    // revoked, so the change applies on the next request without rebuilding this core.
    match app.try_state::<Arc<Store>>() {
        Some(store) => {
            let store = store.inner().clone();
            Arc::new(
                core.with_app_keys(gateway::vault_app_key_provider(store.clone()))
                    .with_spend(gateway::vault_spend_provider(store)),
            )
        }
        None => Arc::new(core),
    }
}

// ---------- commands ----------

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayStatus {
    pub running: bool,
    pub port: u16,
    pub has_key: bool,
    pub endpoint_url: String,
    /// R1: the window is hidden and the gateway is serving in the background. Lets the UI
    /// show real state instead of inferring it ("if you can read this, it isn't hidden").
    pub background: bool,
}

#[tauri::command]
pub fn gateway_status(state: State<'_, Arc<GatewayState>>) -> Result<GatewayStatus, String> {
    let port = state.core.port();
    Ok(GatewayStatus {
        running: state.core.is_available(),
        port,
        has_key: gateway::vault_key_provider()().is_some(),
        endpoint_url: format!("http://127.0.0.1:{port}/v1"),
        background: state.core.is_hidden(),
    })
}

#[tauri::command]
pub async fn gateway_enable(app: AppHandle, port: Option<u16>) -> Result<u16, String> {
    // AppHandle + inner().clone(): State<'_, _> in async commands hits the 'static
    // lifetime bound (classic Tauri E0700); cloning the Arc sidesteps it.
    let state = app.state::<Arc<GatewayState>>().inner().clone();
    if state.server.lock().unwrap().is_some() {
        // Already up: report the bound port (idempotent).
        return Ok(state.core.port());
    }
    let handle = gateway::spawn(state.core.clone(), port.unwrap_or(gateway::DEFAULT_PORT)).await?;
    state.core.set_running(true);
    let bound = handle.addr.port();
    *state.server.lock().unwrap() = Some(handle);
    Ok(bound)
}

#[tauri::command]
pub fn gateway_disable(state: State<'_, Arc<GatewayState>>) -> Result<(), String> {
    if let Some(handle) = state.server.lock().unwrap().take() {
        let _ = handle.shutdown.send(());
    }
    state.core.set_running(false);
    Ok(())
}

/// Generate (or rotate) the master key. The value goes straight to the clipboard — the
/// webview only learns "it happened" (invariants 10, 14).
#[tauri::command]
pub fn gateway_key_generate() -> Result<(), String> {
    let _key = gateway::generate_master_key()?;
    gateway::copy_master_key()
}

#[tauri::command]
pub fn gateway_key_copy() -> Result<(), String> {
    gateway::copy_master_key()
}

#[tauri::command]
pub fn gateway_key_revoke() -> Result<(), String> {
    gateway::revoke_master_key()
}

// ---------- audit R4: per-app gateway keys ----------

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppKeyCreated {
    pub id: String,
    pub label: String,
}

/// Create a per-app key: crypto-random secret -> keychain -> clipboard (shown once).
/// The secret is never returned to the webview and never persisted to SQLite (invariant 14).
#[tauri::command]
pub fn gateway_app_key_create(
    store: State<'_, Arc<Store>>,
    label: String,
) -> Result<AppKeyCreated, String> {
    let id = format!("ak-{}", uuid_like());
    let secret = gateway::generate_random_key();
    let account = format!("{}{}", gateway::APP_KEY_PREFIX, id);
    crate::vault::put(&account, &secret).map_err(|e| e.to_string())?;
    if let Err(e) = crate::persist::gateway_key_insert(&store, &id, &label) {
        // Roll back the keychain entry: a secret with no row is an unrevokable ghost.
        let _ = crate::vault::delete(&account);
        return Err(e.to_string());
    }
    // No provider refresh needed: the key provider re-reads the active ids per request, so the
    // new key works on the very next call without a restart.
    if let Err(e) = gateway::copy_text(&secret) {
        // The key is the ONLY copy of the secret — if it never reaches the clipboard the user
        // can't use it, so unwind both stores rather than leave a credential nobody holds.
        let _ = crate::vault::delete(&account);
        let _ = crate::persist::gateway_key_delete(&store, &id);
        return Err(e);
    }
    Ok(AppKeyCreated { id, label })
}

#[tauri::command]
pub fn gateway_app_keys(store: State<'_, Arc<Store>>) -> Result<Vec<crate::persist::GatewayKeyRow>, String> {
    crate::persist::gateway_keys_list(&store).map_err(|e| e.to_string())
}

/// Revoke one app key. Takes effect on the next request — the master key and every other app
/// key are untouched, which is the whole point (audit R4).
#[tauri::command]
pub fn gateway_app_key_revoke(store: State<'_, Arc<Store>>, id: String) -> Result<(), String> {
    crate::persist::gateway_key_revoke(&store, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn gateway_app_key_delete(store: State<'_, Arc<Store>>, id: String) -> Result<(), String> {
    crate::persist::gateway_key_delete(&store, &id).map_err(|e| e.to_string())
}

/// Short random id — not security-sensitive (the secret is the key), just collision-resistant.
fn uuid_like() -> String {
    use rand::Rng as _;
    (0..16)
        .map(|_| format!("{:x}", rand::rngs::OsRng.gen_range(0..16)))
        .collect()
}

// ---------- audit R4: monthly spend cap ----------

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpendStatus {
    /** Micro-USD spent this calendar month (UTC). */
    pub month_micros: i64,
    /** Configured cap; 0 = disabled. */
    pub cap_micros: i64,
    pub capped: bool,
}

#[tauri::command]
pub fn gateway_spend_status(store: State<'_, Arc<Store>>) -> Result<SpendStatus, String> {
    let month = crate::persist::month_spend_micros(&store);
    let cap = crate::persist::spend_cap_micros(&store).unwrap_or(0);
    Ok(SpendStatus { month_micros: month, cap_micros: cap, capped: cap > 0 && month >= cap })
}

/// Set the monthly cap in micro-USD. `0` disables it.
#[tauri::command]
pub fn gateway_spend_cap_set(store: State<'_, Arc<Store>>, cap_micros: i64) -> Result<(), String> {
    crate::persist::spend_cap_set(&store, cap_micros.max(0)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_tools_enabled(state: State<'_, Arc<GatewayState>>) -> Result<bool, String> {
    Ok(state.core.is_tools_enabled())
}

#[tauri::command]
pub fn set_tools_enabled(enabled: bool, state: State<'_, Arc<GatewayState>>) -> Result<(), String> {
    state.core.set_tools_enabled(enabled);
    Ok(())
}

/// Set the workspace root for local tool execution (write_file, mkdir, run_command).
/// Must be called before tools are used in gateway mode.
#[tauri::command]
pub fn gateway_set_workspace_root(
    state: State<'_, Arc<GatewayState>>,
    root: String,
) -> Result<(), String> {
    let path = std::path::PathBuf::from(&root);
    if !path.exists() {
        return Err(format!("workspace root does not exist: {}", root));
    }
    state.core.set_workspace_root(path);
    Ok(())
}

/// Get the current workspace root, or null if not set.
#[tauri::command]
pub fn gateway_get_workspace_root(
    state: State<'_, Arc<GatewayState>>,
) -> Result<Option<String>, String> {
    Ok(state.core.workspace_root().map(|p| p.to_string_lossy().to_string()))
}

/// Execute a tool call locally (write_file, read_file, list_dir, run_command).
/// Returns the result to the bridge for re-dispatch back to the model.
#[tauri::command]
pub fn gateway_tool_run(
    state: State<'_, Arc<GatewayState>>,
    _request_id: u64,
    tool_name: String,
    arguments: serde_json::Value,
) -> Result<crate::tools::ToolResult, String> {
    let root = state
        .core
        .workspace_root()
        .ok_or_else(|| "workspace root not set — call gateway_set_workspace_root first".to_string())?;
    let req = crate::tools::ToolRunRequest {
        name: tool_name,
        arguments,
        root: root.to_string_lossy().to_string(),
    };
    Ok(crate::tools::tool_run(req))
}

/// Re-dispatch a request with accumulated tool results.
/// Called by the bridge after executing tools locally.
#[tauri::command]
pub fn gateway_followup(
    state: State<'_, Arc<GatewayState>>,
    request_id: u64,
    messages_json: String,
) -> Result<(), String> {
    let messages: Vec<serde_json::Value> =
        serde_json::from_str(&messages_json).map_err(|e| e.to_string())?;
    // Re-dispatch to the webview with updated messages
    state.core.reply(request_id, BridgeMsg::FollowUp { messages });
    Ok(())
}

/// Called by the bridge to re-dispatch with fresh messages after local tool execution.
/// This is the primary tool-loop mechanism: bridge runs tools → builds new messages →
/// calls this command → handler re-dispatches to upstream provider.
#[tauri::command]
pub fn gateway_re_dispatch(
    state: State<'_, Arc<GatewayState>>,
    request_id: u64,
    messages_json: String,
) -> Result<(), String> {
    let messages: Vec<serde_json::Value> =
        serde_json::from_str(&messages_json).map_err(|e| e.to_string())?;
    state.core.re_dispatch(request_id, messages);
    Ok(())
}

/// Webview liveness heartbeat (2s cadence from bridge.ts): proves the router core answers.
#[tauri::command]
pub fn gateway_heartbeat(state: State<'_, Arc<GatewayState>>) -> Result<(), String> {
    state.core.heartbeat();
    Ok(())
}

/// Structured tool calls from the webview router for one bridged request.
#[tauri::command]
pub fn gateway_tool_calls(
    state: State<'_, Arc<GatewayState>>,
    request_id: u64,
    tool_calls_json: String,
) -> Result<(), String> {
    let v: serde_json::Value = serde_json::from_str(&tool_calls_json).map_err(|e| e.to_string())?;
    state.core.reply(request_id, BridgeMsg::ToolCalls(v));
    Ok(())
}

/// Token usage from the webview router for one bridged request.
#[tauri::command]
pub fn gateway_usage(
    state: State<'_, Arc<GatewayState>>,
    request_id: u64,
    prompt_tokens: u64,
    completion_tokens: u64,
) -> Result<(), String> {
    state.core.reply(request_id, BridgeMsg::Usage { prompt_tokens, completion_tokens });
    Ok(())
}

/// Replies from the webview router for one bridged request.
#[tauri::command]
pub fn gateway_chunk(state: State<'_, Arc<GatewayState>>, request_id: u64, text: String) -> Result<(), String> {
    state.core.reply(request_id, BridgeMsg::Delta(text));
    Ok(())
}

#[tauri::command]
pub fn gateway_result(
    state: State<'_, Arc<GatewayState>>,
    request_id: u64,
    body_json: String,
) -> Result<(), String> {
    let v: serde_json::Value = serde_json::from_str(&body_json).map_err(|e| e.to_string())?;
    state.core.reply(request_id, BridgeMsg::Result(v));
    Ok(())
}

#[tauri::command]
pub fn gateway_done(state: State<'_, Arc<GatewayState>>, request_id: u64) -> Result<(), String> {
    state.core.reply(request_id, BridgeMsg::Done);
    Ok(())
}

#[tauri::command]
pub fn gateway_error(
    state: State<'_, Arc<GatewayState>>,
    request_id: u64,
    status: u16,
    message: String,
) -> Result<(), String> {
    state.core.reply(request_id, BridgeMsg::Error { status, message });
    Ok(())
}

pub fn manage(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let core = build_core(app.handle());
    app.manage(Arc::new(GatewayState { core, server: Mutex::new(None) }));
    Ok(())
}

/// §4 rollup job on startup (idempotent; errors never block boot).
pub fn run_rollup(store: &Arc<Store>) {
    let Ok(conn) = store.conn.lock() else { return };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let month_from = now - 62 * 24 * 3600 * 1000;
    let _ = conn.execute(
        "INSERT INTO ledger_rollups (month, provider_id, model, modality, requests, failures, tokens_in, tokens_out, cost_estimate_micros)
         SELECT strftime('%Y-%m', ts/1000, 'unixepoch') AS month,
                COALESCE(provider_id,''), model, modality,
                COUNT(*), SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END),
                SUM(tokens_in), SUM(tokens_out), SUM(cost_estimate_micros)
         FROM ledger WHERE ts < ?1
         GROUP BY month, provider_id, model, modality
         ON CONFLICT(month, provider_id, model, modality) DO UPDATE SET
           requests=excluded.requests, failures=excluded.failures,
           tokens_in=excluded.tokens_in, tokens_out=excluded.tokens_out,
           cost_estimate_micros=excluded.cost_estimate_micros",
        rusqlite::params![month_from],
    );
    let cutoff = now - 90 * 24 * 3600 * 1000;
    let _ = conn.execute("DELETE FROM ledger WHERE ts < ?1", rusqlite::params![cutoff]);
}
