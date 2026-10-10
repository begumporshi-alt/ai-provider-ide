//! The artifact-reader command, re-attached to Tauri.
//!
//! Same split as `tools_cmds.rs`, for the same reason: the reader itself lives in
//! `core/artifact.rs` (which never names Tauri) so the app and the headless service can reach one
//! implementation, and this wrapper adds no behaviour. If it ever needs a line of logic, that
//! logic belongs in `core::artifact` — two implementations of a confinement check are how a
//! sandbox grows a hole.

use crate::core::artifact::{ArtifactReadRequest, ArtifactReadResponse};

/// Read one previewable workspace file (HTML page, PDF, image) for the transcript's cards.
///
/// Not a model tool: it is absent from the tool registry, so a run cannot pull a PDF's bytes into
/// its own context through it. Reachable from the webview, which is untrusted — hence the
/// workspace-root confinement, extension allowlist and size cap in `core::artifact`.
#[tauri::command]
pub fn artifact_read(req: ArtifactReadRequest) -> Result<ArtifactReadResponse, String> {
    crate::core::artifact::read(&req)
}
