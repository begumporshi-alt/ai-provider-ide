//! Artifact bytes for the chat's preview cards.
//!
//! The transcript shows previews of files the agent produced — a rendered HTML page, a PDF's
//! pages, an image. Reading one needs BYTES, and no existing reader returns them for a local
//! path: `read_file` is UTF-8 text (a PDF is refused outright, and an HTML file over 256 KB is
//! truncated, which would render as a broken page), and `read_image` is a model-facing tool
//! limited to four image types. So this is a third, deliberately narrow reader.
//!
//! Boundaries, in the same spirit as the tool sandbox (see the trust note at the top of
//! `tauri::commands`: the webview is untrusted):
//!  - workspace-root confined, reusing `tools::resolve_within` so there is ONE confinement
//!    implementation rather than a second one to keep in sync with the first;
//!  - an allowlist of previewable extensions, so this can never become a general
//!    arbitrary-file reader for the webview;
//!  - a size cap checked before the read, so an oversized file is refused rather than base64'd
//!    into an IPC payload;
//!  - read-only: no write, no secret, no network.
//!
//! It is NOT a model tool — it is absent from the tool registry, so a run cannot pull a PDF's
//! bytes into its own context through it.

use std::fs;
use std::path::Path;

use base64::Engine as _;
use serde::{Deserialize, Serialize};

/// 16 MB: comfortably above a normal PDF or a screenshot, far below what would make the base64
/// round-trip through IPC abusive. The HTML path is text and never approaches this.
const MAX_ARTIFACT_BYTES: u64 = 16 * 1024 * 1024;

/// The extensions this reader will serve, mapped to the media type the preview needs.
///
/// An allowlist rather than a denylist: the failure mode of an extension nobody thought about is
/// "no preview", never "the webview can read any file in the workspace".
fn media_type_for(rel: &str) -> Option<&'static str> {
    let ext = Path::new(rel).extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "html" | "htm" => "text/html",
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        _ => return None,
    })
}

/// Whether `rel` names a file this reader can serve. The UI asks before it offers a preview, so
/// an unsupported path shows no card at all rather than a card that fails when clicked.
pub fn is_previewable(rel: &str) -> bool {
    media_type_for(rel).is_some()
}

#[derive(Debug, Deserialize)]
pub struct ArtifactReadRequest {
    /// Workspace-relative path, exactly as the model or the change set wrote it.
    pub path: String,
    /// The workspace root the path is resolved inside. Required, like `ToolRunRequest.root` —
    /// there is no ambient default, so the webview cannot read outside a root the user chose.
    pub root: String,
    /// Decode as UTF-8 text instead of base64. The HTML preview wants text (it goes straight into
    /// a `srcdoc`), and asking for it here keeps the decode on the side that knows the encoding.
    #[serde(default)]
    pub as_text: bool,
}

#[derive(Debug, Serialize)]
pub struct ArtifactReadResponse {
    pub media_type: String,
    /// Base64 of the raw bytes; empty when `as_text` was set.
    pub base64: String,
    /// UTF-8 text; `None` unless `as_text` was set.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    pub bytes: u64,
}

/// Read one previewable workspace file. See the module docs for the boundaries.
pub fn read(req: &ArtifactReadRequest) -> Result<ArtifactReadResponse, String> {
    let media_type = media_type_for(&req.path).ok_or_else(|| {
        format!(
            "no preview for this file type: {} — previewable: html, pdf, png, jpg, gif, webp, svg",
            req.path
        )
    })?;

    let root = crate::core::tools::validate_root(Path::new(&req.root))?;
    let path = crate::core::tools::resolve_within(&root, &req.path, false)?;
    if path.is_dir() {
        return Err("path is a directory".into());
    }

    // Cap by metadata BEFORE reading: a 2 GB file must be refused, not loaded and then refused.
    let len = fs::metadata(&path).map_err(|e| format!("cannot stat: {e}"))?.len();
    if len > MAX_ARTIFACT_BYTES {
        return Err(format!(
            "file is {} KB — the preview cap is {} MB",
            len / 1024,
            MAX_ARTIFACT_BYTES / (1024 * 1024)
        ));
    }

    let bytes = fs::read(&path).map_err(|e| format!("cannot read: {e}"))?;
    let n = bytes.len() as u64;

    if req.as_text {
        // Lossy on purpose: a page with one bad byte must still preview, and `String::from_utf8`
        // would refuse the whole file over it.
        let text = String::from_utf8_lossy(&bytes).into_owned();
        return Ok(ArtifactReadResponse {
            media_type: media_type.to_string(),
            base64: String::new(),
            text: Some(text),
            bytes: n,
        });
    }

    Ok(ArtifactReadResponse {
        media_type: media_type.to_string(),
        base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
        text: None,
        bytes: n,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// A fresh directory per test — the pattern `tools.rs` uses, for the same reason (the tests
    /// write real files and must not share state).
    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("aiprovider-artifact-test-{tag}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(root: &Path, rel: &str, bytes: &[u8]) {
        let p = root.join(rel);
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        let mut f = fs::File::create(p).unwrap();
        f.write_all(bytes).unwrap();
    }

    fn req(root: &Path, rel: &str, as_text: bool) -> ArtifactReadRequest {
        ArtifactReadRequest {
            path: rel.to_string(),
            root: root.to_string_lossy().into_owned(),
            as_text,
        }
    }

    #[test]
    fn reads_html_as_text_and_pdf_as_base64() {
        let dir = temp_dir("read");
        let page = "<!doctype html><html><body>hi</body></html>";
        write(&dir, "page.html", page.as_bytes());
        write(&dir, "notes.pdf", b"%PDF-1.4\nbinary-ish");

        let html = read(&req(&dir, "page.html", true)).unwrap();
        assert_eq!(html.media_type, "text/html");
        assert_eq!(html.text.as_deref(), Some(page));
        assert!(html.base64.is_empty(), "text mode must not also carry base64");
        // `bytes` reports the file's real size, measured rather than assumed.
        assert_eq!(html.bytes, page.len() as u64);

        let pdf = read(&req(&dir, "notes.pdf", false)).unwrap();
        assert_eq!(pdf.media_type, "application/pdf");
        assert!(pdf.text.is_none());
        // Round-trips to the exact bytes the file holds.
        let decoded = base64::engine::general_purpose::STANDARD.decode(&pdf.base64).unwrap();
        assert_eq!(decoded, b"%PDF-1.4\nbinary-ish");
    }

    #[test]
    fn refuses_an_extension_that_is_not_previewable() {
        let dir = temp_dir("ext");
        write(&dir, "secrets.txt", b"not for the webview");
        write(&dir, "run.sh", b"#!/bin/sh\n");
        let err = read(&req(&dir, "secrets.txt", true)).unwrap_err();
        assert!(err.contains("no preview for this file type"), "{err}");
        assert!(read(&req(&dir, "run.sh", false)).is_err(), "a shell script is not previewable");
        assert!(!is_previewable("secrets.txt"));
        assert!(is_previewable("REPORT.PDF"), "extension match is case-insensitive");
    }

    /// The confinement tests that matter: this reader is reachable from the webview and is the
    /// only thing that hands back arbitrary bytes, so escaping the root must be impossible.
    #[test]
    fn refuses_to_escape_the_workspace_root() {
        let dir = temp_dir("escape");
        write(&dir, "page.html", b"<html>ok</html>");
        // A real file OUTSIDE the root, to prove the refusal is about the path and not a
        // missing file.
        let outside = dir.parent().unwrap().join("aiprovider-artifact-test-outside.html");
        fs::write(&outside, b"<html>outside</html>").unwrap();

        assert!(read(&req(&dir, "../aiprovider-artifact-test-outside.html", true)).is_err());
        assert!(read(&req(&dir, "/etc/hosts", true)).is_err(), "absolute paths are refused");
        let _ = fs::remove_file(&outside);
    }

    #[test]
    fn refuses_an_oversized_file_before_reading_it() {
        let dir = temp_dir("huge");
        // Sparse: the file claims to be past the cap without writing 16 MB to disk.
        let p = dir.join("huge.pdf");
        let f = fs::File::create(&p).unwrap();
        f.set_len(MAX_ARTIFACT_BYTES + 1).unwrap();
        drop(f);
        let err = read(&req(&dir, "huge.pdf", false)).unwrap_err();
        assert!(err.contains("preview cap"), "{err}");
    }

    #[test]
    fn a_missing_file_says_so_plainly() {
        let dir = temp_dir("missing");
        let err = read(&req(&dir, "nope.html", true)).unwrap_err();
        assert!(err.contains("no such file"), "{err}");
    }
}
