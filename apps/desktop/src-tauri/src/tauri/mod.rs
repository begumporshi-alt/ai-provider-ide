//! Tauri glue: the command surface, the gateway bridge into the hidden worker webview, and the
//! app entry point. Everything in the desktop UI process that is not the gateway itself.
//!
//! This half may depend on `core/`; `core/` may not depend on this half.

pub mod app;
pub mod commands;
pub mod gateway_cmds;
pub mod tools_cmds;
pub mod workbuddy;
