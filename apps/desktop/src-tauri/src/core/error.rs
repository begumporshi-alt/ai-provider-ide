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

// ---------- conversions from the store's error types ----------
//
// These live here rather than in `tauri::commands` because `core::persist` needs them, and
// `core` must compile with the Tauri glue switched off. None of them names a glue-side type —
// `StoreError` and `rusqlite::Error` are both core dependencies — so this module's own rule
// ("conversions that mention glue-side types stay in `tauri::commands`") puts them on this
// side. The conversions that *do* name glue-side types (`egress::EgressError`,
// `vault::VaultError`) remain in `tauri::commands`.

impl From<crate::core::store::StoreError> for CommandError {
    fn from(e: crate::core::store::StoreError) -> Self {
        match e {
            crate::core::store::StoreError::Sql(inner) => CommandError(ui_db_error(&inner)),
            crate::core::store::StoreError::Io(inner) => {
                tracing::warn!("store io error (detail withheld from the UI): {inner}");
                CommandError(match inner.kind() {
                    std::io::ErrorKind::NotFound => {
                        "a required file or folder is missing".to_string()
                    }
                    std::io::ErrorKind::PermissionDenied => "permission was denied".to_string(),
                    std::io::ErrorKind::AlreadyExists => "that already exists".to_string(),
                    _ => "a file operation failed".to_string(),
                })
            }
            // A migration carries its own id, which is safe and is the one thing the operator
            // needs — the rest of the detail is SQL.
            crate::core::store::StoreError::Migration(id, detail) => {
                tracing::warn!("migration {id} failed: {detail}");
                CommandError(format!("migration {id} failed"))
            }
        }
    }
}

impl From<rusqlite::Error> for CommandError {
    fn from(e: rusqlite::Error) -> Self {
        CommandError(ui_db_error(&e))
    }
}

/// What the caller is told when the store fails.
///
/// rusqlite's `Display` is honest, and that is exactly the problem — measured, not assumed:
///
/// | failure | `e.to_string()` |
/// |---|---|
/// | cannot open | `unable to open database file: /Users/<account>/Library/…/ai-provider-router.db` |
/// | bad SQL | `near "FROM": syntax error in SELECT FROM WHERE at offset 7` |
/// | missing column | `no such column: nope in SELECT nope FROM t at offset 7` |
///
/// All three carry something the caller does not need: an absolute path that names the account,
/// or the schema's own table and column names. None of it helps them decide what to do next. So
/// the detail is logged host-side and the boundary returns a stable sentence that still names
/// the *class* of failure. The headless service has the same problem with a different audience —
/// an HTTP client instead of a webview — which is why this helper is core-resident.
///
/// Deliberately not applied to hand-written messages (`context::record`'s "unknown node kind")
/// — those are already written for a person to read, and sanitising them would strip the one
/// thing that makes them useful.
pub(crate) fn ui_db_error(e: &rusqlite::Error) -> String {
    tracing::warn!("store error (detail withheld from the UI): {e}");
    match e {
        // The SQL text is embedded in this variant by construction.
        rusqlite::Error::SqlInputError { .. } => "an internal query failed".to_string(),
        rusqlite::Error::SqliteFailure(ffi, _) => match ffi.code {
            rusqlite::ErrorCode::CannotOpen => "the database could not be opened".to_string(),
            rusqlite::ErrorCode::NotADatabase => {
                "the database file is not a valid database".to_string()
            }
            rusqlite::ErrorCode::DatabaseBusy => "the database is busy; try again".to_string(),
            rusqlite::ErrorCode::DiskFull => "the disk is full".to_string(),
            rusqlite::ErrorCode::ReadOnly => "the database is read-only".to_string(),
            rusqlite::ErrorCode::ConstraintViolation => {
                "the change was rejected by a database constraint".to_string()
            }
            _ => "a database error occurred".to_string(),
        },
        rusqlite::Error::QueryReturnedNoRows => "no matching row was found".to_string(),
        _ => "a database error occurred".to_string(),
    }
}
