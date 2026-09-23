//! The single error type shared by the Tauri command surface and the core store helpers.
//!
//! It lives in `core/` because `persist` is core and returns it, while the `From` conversions
//! that mention glue-side types (notably `egress::EgressError`) stay in `tauri::commands`.
//! A trait impl is visible crate-wide regardless of which module it is written in, so splitting
//! the type from its conversions costs nothing at any call site.

use std::fmt;

#[derive(Debug, serde::Serialize)]
pub struct CommandError(pub String);

/// `CommandError` is serialized to the webview (Tauri requires `Serialize`). It also implements
/// `Display` so non-command callers — e.g. `gateway_cmds`, which needs a `String` error — can
/// reuse `persist::*` helpers through the ordinary `?`/`map_err` idiom instead of reaching into
/// the tuple field. One error type, two surfaces.
impl fmt::Display for CommandError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<CommandError> for String {
    fn from(e: CommandError) -> Self {
        e.0
    }
}
