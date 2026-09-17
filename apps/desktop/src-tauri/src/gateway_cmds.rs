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
    Arc::new(GatewayCore::new(
        Arc::new(EventBridge { app: app.clone() }),
        gateway::vault_key_provider(),
    ))
}

// ---------- commands ----------

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayStatus {
    pub running: bool,
    pub port: u16,
    pub has_key: bool,
    pub endpoint_url: String,
}

#[tauri::command]
pub fn gateway_status(state: State<'_, Arc<GatewayState>>) -> Result<GatewayStatus, String> {
    let port = state.core.port();
    Ok(GatewayStatus {
        running: state.core.is_available(),
        port,
        has_key: gateway::vault_key_provider()().is_some(),
        endpoint_url: format!("http://127.0.0.1:{port}/v1"),
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

#[tauri::command]
pub fn get_tools_enabled(state: State<'_, Arc<GatewayState>>) -> Result<bool, String> {
    Ok(state.core.is_tools_enabled())
}

#[tauri::command]
pub fn set_tools_enabled(enabled: bool, state: State<'_, Arc<GatewayState>>) -> Result<(), String> {
    state.core.set_tools_enabled(enabled);
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
