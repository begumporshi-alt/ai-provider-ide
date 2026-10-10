//! Tauri glue: the command surface, the bridge into the Rust router core, and the app entry
//! point. Everything in the desktop UI process that is not the gateway itself.
//!
//! The gateway bridge used to reach a *hidden worker webview*; 25f deleted that webview and the
//! bridge now reaches the in-process router core (`core/router_bridge.rs`). This comment was a
//! fifth site of the D42 class — D42 re-tensed four others (`core/usage.rs`, `core/gateway_normalizer.rs`,
//! `core/gateway.rs`, `core/bridge_policy.rs`) and missed this one, because it is the *module
//! header* rather than a claim inside a module. Corrected 2026-09-27.
//!
//! This half may depend on `core/`; `core/` may not depend on this half.

pub mod app;
pub mod artifact_cmds;
pub mod commands;
pub mod gateway_cmds;
pub mod mcp_cmds;
pub mod service_cmds;
pub mod tools_cmds;
pub mod workbuddy;
