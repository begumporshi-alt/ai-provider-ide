//! The MCP commands, re-attached to Tauri.
//!
//! Same house rule as `tools_cmds.rs`: **these wrappers add no behaviour, and must not.** The
//! client, the config storage and the connection state all live in `core::mcp`, so the headless
//! service reaches the same code the app does.

use std::sync::Arc;

use tauri::{Manager, State};

use crate::core::mcp::{McpServerConfig, McpState, RefreshOutcome};
use crate::core::store::Store;
use crate::core::tools::ToolResult;

/// The configured servers, as the user wrote them — the settings screen's source of truth.
#[tauri::command]
pub fn mcp_servers_get(store: State<'_, Arc<Store>>) -> Vec<McpServerConfig> {
    crate::core::mcp::servers_config(&store)
}

/// Validate and replace the server list. Validation (id shape, duplicates, command presence)
/// lives in `core::mcp` so a future daemon settings path enforces the same rules.
#[tauri::command]
pub fn mcp_servers_set(store: State<'_, Arc<Store>>, servers: Vec<McpServerConfig>) -> Result<(), String> {
    crate::core::mcp::save_servers_config(&store, &servers)
}

/// Connect to every enabled server and list its tools. One broken server lands in `failures`
/// and does not hide the tools of the healthy ones.
#[tauri::command]
pub async fn mcp_refresh(
    state: State<'_, Arc<McpState>>,
    store: State<'_, Arc<Store>>,
) -> Result<RefreshOutcome, String> {
    Ok(state.refresh(&store).await)
}

/// Execute one MCP tool call, routed by server id. The result is a `ToolResult` — the same shape
/// `tool_run` returns — so the webview's failure mapping is one code path for both.
#[tauri::command]
pub async fn mcp_call(
    state: State<'_, Arc<McpState>>,
    store: State<'_, Arc<Store>>,
    server: String,
    tool: String,
    arguments: serde_json::Value,
) -> Result<ToolResult, String> {
    Ok(state.call(&store, &server, &tool, arguments).await)
}

/// Manage the connection state, the way `gateway_cmds::manage` does.
pub fn manage(app: &tauri::App) -> Result<(), tauri::Error> {
    app.manage(Arc::new(McpState::default()));
    Ok(())
}
