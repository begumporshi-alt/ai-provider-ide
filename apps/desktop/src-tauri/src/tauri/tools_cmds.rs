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

use std::path::Path;

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

/// Immediate subdirectories of an absolute path, for the Assistant's root picker.
#[tauri::command]
pub fn tools_list_dirs(path: String) -> Result<Vec<String>, String> {
    crate::core::tools::tools_list_dirs(path)
}

/// Execute one tool call. Never panics on model input: every failure is a `ToolResult`.
///
/// `call_id` is the model's tool-call id, sent by the Assistant so the call can be stopped
/// mid-flight; absent for a gateway call, which has no Stop button to serve.
#[tauri::command]
pub fn tool_run(req: ToolRunRequest, call_id: Option<String>) -> ToolResult {
    crate::core::tools::tool_run_with_call(req, call_id.as_deref())
}

/// Stop a tool call that is still running — the Stop button's mid-flight path.
///
/// Returns whether a child was actually running under that id: `false` means it had already
/// finished, which the UI can report honestly rather than as a stop that happened. Only
/// `run_command` registers for cancellation; every other tool is bounded by its own timeout.
#[tauri::command]
pub fn tool_cancel(call_id: String) -> Result<bool, String> {
    crate::core::tools::tool_cancel(&call_id)
}

/// The workspace's git state for the Assistant's git capsule.
#[tauri::command]
pub fn git_summary(root: String) -> Result<crate::core::tools::GitSummary, String> {
    crate::core::tools::git_summary(Path::new(&root))
}

/// Stage, commit and push the workspace from the Assistant's git capsule.
#[tauri::command]
pub fn git_commit_push(root: String, message: String) -> Result<String, String> {
    crate::core::tools::git_commit_push(Path::new(&root), &message)
}
