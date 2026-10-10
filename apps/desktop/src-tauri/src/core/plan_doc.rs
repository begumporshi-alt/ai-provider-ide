//! Plan documents (2026-10-10).
//!
//! When `exit_plan_mode` is approved, the plan the user just approved is written to
//! `<workspace>/.zcode/plans/plan-<session>.md` — ZCode's own convention, so a workspace that both
//! tools touch keeps ONE plans directory and either can read the other's plans.
//!
//! **Deliberately not a sandbox tool.** A plan is not a workspace change: routed through
//! `write_file` it would land in the run's change set, be offered to "revert this run", and be
//! refused by plan mode itself as a mutation — the plan pass is forbidden to write, and the plan
//! is the one document it must be able to leave behind. It writes directly, and it is bounded to
//! the workspace by the same `resolve_within` the sandbox uses: one confinement rule, not two.
//!
//! Not the same thing as `core::planner` (the route planner that expands one request into
//! candidate `(provider, key, model)` triples) — that is routing, this is a markdown artifact.

use std::fs;
use std::path::Path;

use super::tools::resolve_within;

/// Where plans live, relative to the workspace root.
const PLANS_DIR: &str = ".zcode/plans";

/// Session ids reach this module as plain strings from the store and from history rows, and they
/// end up inside a filename — so they are validated rather than trusted, the same discipline
/// `agent_defs::is_valid_id` applies to definition ids. The accepted set covers what the app
/// itself mints (`s-<epoch-ms>`) and the ids the web tests inject; anything with a separator, a
/// dot-prefix or a `..` never reaches a path.
pub(crate) fn is_valid_session_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && !id.starts_with('.')
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

/// Write `markdown` as the plan for `session_id`. Returns the workspace-relative path written.
pub(crate) fn save_plan(root: &str, session_id: &str, markdown: &str) -> Result<String, String> {
    if root.trim().is_empty() {
        return Err("no workspace root is set".into());
    }
    if !is_valid_session_id(session_id) {
        return Err(format!(
            "invalid session id for a plan file: {session_id:?}"
        ));
    }
    if markdown.trim().is_empty() {
        return Err("refusing to write an empty plan".into());
    }
    let rel = format!("{PLANS_DIR}/plan-{session_id}.md");
    // `resolve_within` creates the missing parents itself (and re-checks the parent against the
    // root afterwards, so a symlinked `.zcode` cannot redirect the write outside the workspace).
    let path = resolve_within(Path::new(root.trim()), &rel, true)?;
    fs::write(&path, markdown).map_err(|e| format!("could not write {}: {e}", path.display()))?;
    Ok(rel)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "aiprovider-plan-doc-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        fs::create_dir_all(&dir).expect("temp root");
        dir
    }

    #[test]
    fn writes_the_plan_under_the_workspace_and_returns_the_relative_path() {
        let root = temp_root("write");
        let rel = save_plan(&root.to_string_lossy(), "s-123", "# Plan\n\n1. do the thing\n")
            .expect("save succeeds");
        assert_eq!(rel, ".zcode/plans/plan-s-123.md");
        let written = fs::read_to_string(root.join(&rel)).expect("file exists");
        assert_eq!(written, "# Plan\n\n1. do the thing\n");
        // The return value is workspace-relative; the file lives under the root, not the cwd.
        assert!(root.join(&rel).starts_with(&root));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn rewrites_the_same_session_in_place_rather_than_piling_up_plans() {
        let root = temp_root("rewrite");
        let root_s = root.to_string_lossy().to_string();
        save_plan(&root_s, "s-9", "first").expect("first");
        save_plan(&root_s, "s-9", "second").expect("second");
        assert_eq!(
            fs::read_to_string(root.join(".zcode/plans/plan-s-9.md")).expect("file"),
            "second"
        );
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn refuses_a_session_id_that_would_escape_or_decorate_the_filename() {
        for bad in ["", "..", "../evil", "a/b", ".hidden", "with space"] {
            assert!(!is_valid_session_id(bad), "{bad:?} must be refused");
            assert!(save_plan("/tmp", bad, "x").is_err(), "{bad:?} must not write");
        }
        // The app's own id shape stays valid.
        assert!(is_valid_session_id("s-1759999999999"));
    }

    #[test]
    fn refuses_an_empty_plan_and_a_missing_root() {
        let root = temp_root("empty");
        assert!(save_plan(&root.to_string_lossy(), "s-1", "   \n  ").is_err());
        assert!(save_plan("   ", "s-1", "# Plan").is_err());
        fs::remove_dir_all(&root).ok();
    }
}
