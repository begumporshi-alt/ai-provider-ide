//! The four tool commands, re-attached to Tauri.
//!
//! **The host itself lives in `core::tools`, and increment 24a moved it there.** It never named
//! Tauri: 1,464 lines whose only coupling to the app was four `#[tauri::command]` attributes —
//! no `AppHandle`, no `State`, and a test region that mentions neither either. Sitting in
//! `tauri/` was the accident.
//!
//! It had to move because Phase 5c's `core/router_bridge.rs` must execute tools and `core/` may
//! not name `crate::tauri::*`. Two consequences beyond unblocking the bridge: the ~630 lines of
//! tool tests now compile under `--no-default-features --all-targets`, where they previously
//! were not compiled at all; and the headless service can reach the same host the app does,
//! rather than needing a second one.
//!
//! **These wrappers add no behaviour, and must not.** If one grows a line of logic, that logic
//! belongs in `core::tools` where both callers can reach it — otherwise the app and the service
//! start enforcing two slightly different sandboxes, which is the failure this split exists to
//! prevent.

use crate::core::tools::{ToolAllowlist, ToolResult, ToolRunRequest};

/// Announce the sandbox to the UI so it can show the user what is actually permitted, rather than
/// making them trust a checkbox.
#[tauri::command]
pub fn tools_policy() -> ToolAllowlist {
    crate::core::tools::tools_policy()
}

/// Is `root` usable as a workspace root? The UI asks this before the first tool call.
#[tauri::command]
pub fn tools_check_root(root: String) -> Result<(), String> {
    crate::core::tools::tools_check_root(root)
}

/// The workspace agent mode starts in, so the root field is never empty by default.
#[tauri::command]
pub fn tools_default_root() -> Result<String, String> {
    crate::core::tools::tools_default_root()
}

/// Execute one tool call. Never panics on model input: every failure is a `ToolResult`.
#[tauri::command]
pub fn tool_run(req: ToolRunRequest) -> ToolResult {
    crate::core::tools::tool_run(req)
}
