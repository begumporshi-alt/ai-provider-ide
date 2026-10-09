//! Subagent definition files (L0): user-authored `dispatch_agent` specialists under
//! `{app_data_dir}/agents/`.
//!
//! One definition is one JSON file named `<id>.json`. The host is a careful file server, not a
//! validator: it enforces only what it must to be safe — the id is a filename-safe slug (it is
//! the filename, so `../` in an id is path traversal) and the content parses as a JSON object —
//! while the authoritative field validation lives TypeScript-side (`lib/agents/defs.ts`), which
//! sees every load and skips + surfaces a bad file rather than crashing the loop. Duplicating the
//! full guard here would be two truths to keep in step.
//!
//! The file lifecycle mirrors `crash_report.rs`: a directory under the app data dir, ids that are
//! filename stems, and best-effort listing that treats a missing directory as empty rather than
//! an error.

use std::fs;
use std::path::{Path, PathBuf};

const AGENTS_DIR_NAME: &str = "agents";

/// The builtin definitions, shipped as one JSON array and shared with the TypeScript side
/// (which validates each against the same guard it applies to user files). Single source of
/// truth: the Rust host seeds them and the web-test shim mirrors them from this exact file.
const BUILTIN_DEFS_JSON: &str = include_str!("../../../src/lib/agents/builtin-defs.json");

/// Seed every builtin definition whose file does not exist yet. Deliberately
/// **skip-existing, never overwrite**: a builtin is a first-run convenience, and once the file
/// exists — edited, disabled, or left alone — it is the user's, and re-seeding would quietly
/// take it back. Best-effort throughout: a lost seed is a missing builtin, not a fault.
pub fn ensure_builtin_defs(app_data_dir: &Path) {
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(BUILTIN_DEFS_JSON) else {
        return;
    };
    let Some(defs) = parsed.as_array() else { return };
    let dir = agents_dir(app_data_dir);
    for def in defs {
        let Some(id) = def.get("id").and_then(|v| v.as_str()) else { continue };
        if !is_valid_id(id) {
            continue;
        }
        let path = dir.join(format!("{id}.json"));
        if path.exists() {
            continue;
        }
        if fs::create_dir_all(&dir).is_err() {
            return;
        }
        if let Ok(pretty) = serde_json::to_string_pretty(def) {
            let _ = fs::write(path, pretty);
        }
    }
}

/// One definition file as read back: its filename stem and its raw JSON. The TypeScript side
/// parses and validates the content — the host deliberately does not name the fields.
///
/// `rename_all = "camelCase"` is load-bearing, not style: the webview reads `fileName` /
/// `contentJson`, and a snake_case serialization arrives as two `undefined`s — every definition
/// then "fails to load" with an empty filename (measured 2026-10-09: five seeded builtins, five
/// ".json — not valid JSON" warnings). The same rule every DTO crossing this boundary follows.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AgentDefFile {
    pub file_name: String,
    pub content_json: String,
}

/// Return the directory path where agent definitions live.
pub fn agents_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(AGENTS_DIR_NAME)
}

/// True for an id that is also a safe single-segment filename: lowercase letters, digits,
/// `-` and `_`, 1..=64 chars. Mirrors `isValidDefId` in `lib/agents/defs.ts` — the two must
/// agree, because a file the TS side cannot parse as an id is a skip-warning either way, but a
/// file Rust would write under a name TS rejects would strand the user's definition.
pub fn is_valid_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    !(bytes.is_empty() || bytes.len() > 64)
        && bytes.iter().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-' || *b == b'_'
        })
        && !id.starts_with('-')
        && !id.starts_with('_')
}

/// List every definition file, by filename. A missing directory is an empty list — no
/// definitions yet is the normal first-launch state, not an error.
pub fn list_defs(app_data_dir: &Path) -> Vec<AgentDefFile> {
    let dir = agents_dir(app_data_dir);
    if !dir.is_dir() {
        return Vec::new();
    }
    let mut out: Vec<AgentDefFile> = fs::read_dir(&dir)
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().is_some_and(|ext| ext == "json"))
        .filter_map(|e| {
            let file_name = e.file_name().to_string_lossy().strip_suffix(".json")?.to_string();
            let content_json = fs::read_to_string(e.path()).ok()?;
            Some(AgentDefFile { file_name, content_json })
        })
        .collect();
    out.sort_by(|a, b| a.file_name.cmp(&b.file_name));
    out
}

/// Write a definition. The id must be a safe slug and the content a JSON object; the write is
/// create-then-rename-free on purpose — a plain overwrite is fine here because the file has no
/// other readers mid-write (the loop reads whole files, never appends).
pub fn save_def(app_data_dir: &Path, id: &str, content_json: &str) -> Result<(), String> {
    if !is_valid_id(id) {
        return Err(format!("invalid agent definition id: {id:?}"));
    }
    let parsed: serde_json::Value =
        serde_json::from_str(content_json).map_err(|e| format!("content is not valid JSON: {e}"))?;
    if !parsed.is_object() {
        return Err("content must be a JSON object".to_string());
    }
    let dir = agents_dir(app_data_dir);
    fs::create_dir_all(&dir).map_err(|e| format!("could not create the agents directory: {e}"))?;
    // Pretty-printed: the files are user-editable by design, so diffing and hand-editing them
    // must not fight a single-line blob.
    let pretty = serde_json::to_string_pretty(&parsed).map_err(|e| e.to_string())?;
    fs::write(dir.join(format!("{id}.json")), pretty).map_err(|e| format!("could not write the file: {e}"))
}

/// Flip the `enabled` field in place: read, patch, write. The JSON round-trip preserves any
/// fields this host does not name — the schema is the TypeScript guard's business.
pub fn set_def_enabled(app_data_dir: &Path, id: &str, enabled: bool) -> Result<(), String> {
    if !is_valid_id(id) {
        return Err(format!("invalid agent definition id: {id:?}"));
    }
    let path = agents_dir(app_data_dir).join(format!("{id}.json"));
    let bytes = fs::read_to_string(&path).map_err(|e| format!("could not read the file: {e}"))?;
    let mut parsed: serde_json::Value =
        serde_json::from_str(&bytes).map_err(|e| format!("content is not valid JSON: {e}"))?;
    if !parsed.is_object() {
        return Err("content must be a JSON object".to_string());
    }
    parsed["enabled"] = serde_json::Value::Bool(enabled);
    let pretty = serde_json::to_string_pretty(&parsed).map_err(|e| e.to_string())?;
    fs::write(&path, pretty).map_err(|e| format!("could not write the file: {e}"))
}

/// Delete a definition by id. Returns true if it existed.
pub fn delete_def(app_data_dir: &Path, id: &str) -> Result<bool, String> {
    if !is_valid_id(id) {
        return Err(format!("invalid agent definition id: {id:?}"));
    }
    match fs::remove_file(agents_dir(app_data_dir).join(format!("{id}.json"))) {
        Ok(()) => Ok(true),
        // An absent file is "already deleted", not a failure — idempotency the UI's Remove
        // button can lean on.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!("could not delete the file: {e}")),
    }
}

// ── tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("aip-agentdefs-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn a_def_file_serializes_camelcase_for_the_webview() {
        // The webview's type is `{ fileName, contentJson }`; a snake_case payload arrives as
        // undefined and every definition "fails to load". This pins the wire shape.
        let v = serde_json::to_value(AgentDefFile {
            file_name: "doc-sweeper".into(),
            content_json: "{}".into(),
        })
        .unwrap();
        assert!(v.get("fileName").is_some(), "the key is fileName, not file_name");
        assert!(v.get("contentJson").is_some(), "the key is contentJson, not content_json");
    }

    #[test]
    fn builtins_seed_once_and_survive_user_edits() {
        let dir = temp_dir("builtins");
        assert!(list_defs(&dir).is_empty());

        ensure_builtin_defs(&dir);
        let first = list_defs(&dir);
        assert!(!first.is_empty(), "the seed wrote the builtin set");
        assert!(first.iter().any(|f| f.file_name == "codebase-mapper"));

        // A user edit to a seeded file is the file's truth now.
        set_def_enabled(&dir, "codebase-mapper", false).expect("disable a builtin");

        ensure_builtin_defs(&dir);
        ensure_builtin_defs(&dir); // idempotent: repeat runs change nothing
        let again = list_defs(&dir);
        assert_eq!(again.len(), first.len(), "no re-seed, no duplicates");
        let mapper = again.iter().find(|f| f.file_name == "codebase-mapper").expect("still present");
        let v: serde_json::Value = serde_json::from_str(&mapper.content_json).unwrap();
        assert_eq!(v["enabled"], serde_json::Value::Bool(false), "the user's edit survived the re-seed");

        // Every seed must clear the same guard the TypeScript side applies, or a builtin would
        // land as a skip-warning row the day it ships.
        for f in &again {
            let parsed: serde_json::Value = serde_json::from_str(&f.content_json).expect("valid JSON");
            assert!(parsed.get("id").is_some(), "{} carries an id", f.file_name);
            assert!(parsed.get("name").is_some(), "{} carries a name", f.file_name);
            assert!(parsed.get("description").is_some(), "{} carries a description", f.file_name);
            assert!(parsed.get("systemPrompt").is_some(), "{} carries a systemPrompt", f.file_name);
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_list_delete_round_trip() {
        let dir = temp_dir("round_trip");
        assert!(list_defs(&dir).is_empty(), "no directory yet means no definitions");

        let def = r#"{"id":"doc-sweeper","name":"Doc Sweeper","enabled":true}"#;
        save_def(&dir, "doc-sweeper", def).expect("save");

        let listed = list_defs(&dir);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].file_name, "doc-sweeper");
        // The content round-trips *as data*, not as bytes: the writer pretty-prints so the files
        // stay hand-editable, and the test asserts the value survived, not the formatting.
        let stored: serde_json::Value = serde_json::from_str(&listed[0].content_json).unwrap();
        let written: serde_json::Value = serde_json::from_str(def).unwrap();
        assert_eq!(stored, written);

        assert!(delete_def(&dir, "doc-sweeper").expect("delete"));
        assert!(!delete_def(&dir, "doc-sweeper").expect("delete again"), "already gone");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_id_is_a_filename_so_path_traversal_is_rejected() {
        let dir = temp_dir("traversal");
        for id in ["", "../escape", "a/b", ".hidden", "-lead", "_lead", "UPPER", &( "x".repeat(65))] {
            assert!(!is_valid_id(id), "{id:?} should not be a valid id");
            assert!(save_def(&dir, id, "{}").is_err(), "{id:?} must not write");
        }
        assert!(is_valid_id("doc-sweeper_2"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_rejects_non_object_content_and_bad_json() {
        let dir = temp_dir("content");
        assert!(save_def(&dir, "ok", "[1,2]").is_err());
        assert!(save_def(&dir, "ok", "{not json").is_err());
        assert!(save_def(&dir, "ok", r#"{"id":"ok"}"#).is_ok());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn set_enabled_patches_one_field_and_keeps_the_rest() {
        let dir = temp_dir("enabled");
        save_def(&dir, "doc-sweeper", r#"{"id":"doc-sweeper","name":"Doc Sweeper","enabled":true}"#).unwrap();

        set_def_enabled(&dir, "doc-sweeper", false).expect("disable");
        let listed = list_defs(&dir);
        let v: serde_json::Value = serde_json::from_str(&listed[0].content_json).unwrap();
        assert_eq!(v["enabled"], serde_json::Value::Bool(false));
        assert_eq!(v["name"], "Doc Sweeper", "the other fields survive the patch");
        assert!(set_def_enabled(&dir, "missing", true).is_err(), "a missing file is an error, not a silent ok");
        let _ = fs::remove_dir_all(&dir);
    }
}
