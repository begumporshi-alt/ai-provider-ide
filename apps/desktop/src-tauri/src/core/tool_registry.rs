//! The agent-mode tool registry — the port of `tools/registry.ts` (168 lines).
//!
//! **This is the single source of truth for what the model may call.** Every entry maps 1:1 to a
//! handler in the Rust sandbox (`tauri/tools.rs`) — if a tool is not listed here the model cannot
//! name it, and even if it did, the host would refuse it. [`registry_to_openai`] renders the OpenAI
//! `tools` array; `additionalProperties: false` keeps the model from smuggling extra fields the
//! sandbox would ignore anyway.
//!
//! `write_file`, `edit_file`, `mkdir` and `run_command` are **mutating** — the four the gateway
//! refuses unless mutation is explicitly enabled ([`crate::core::gateway::MUTATING_TOOLS`]), and the
//! four the Assistant confirms one call at a time. The other four only read, and are always
//! available.
//!
//! # Why the invariants live in tests rather than in types
//!
//! A malformed entry does not fail loudly. It goes to the model as JSON schema, where the failure
//! modes are all silent: a `required` field absent from `properties` is unsatisfiable under
//! `additionalProperties: false` (the model is told to send something the schema rejects), and a
//! tool the host does not implement is a call that can only ever return an error. Neither surfaces
//! until a model tries to use it — so the checks are asserted in the test module instead.
//!
//! The mutating set is asserted against [`crate::core::gateway::MUTATING_TOOLS`]. That constant is
//! what keeps gateway mutation opt-in; a rename on one side without a rename on the other would
//! silently un-gate a writing tool, so the names are pinned in both places.
//!
//! One divergence: the reference returns `undefined` for an empty registry, which becomes `None`
//! here. Both mean "omit `tools`/`tool_choice` entirely", which is the only correct rendering of
//! "no tools" — some providers reject an empty `tools` array with a 400, so `[]` is not an option.

use std::sync::OnceLock;

use serde_json::{json, Value};

/// A tool the agent may call.
#[derive(Debug, Clone)]
pub struct ToolSpec {
    pub name: &'static str,
    pub description: &'static str,
    /// The `properties` object of the tool's parameter schema.
    pub properties: Value,
    /// Field names the schema requires. Always a subset of `properties`'s keys.
    pub required: &'static [&'static str],
}

/// The registry, built once and then borrowed.
///
/// A `OnceLock` rather than a `const`: the entries carry `serde_json::Value` schemas, which cannot
/// be built in a `const` context. Building once also means every caller shares one allocation.
pub fn agent_tools() -> &'static [ToolSpec] {
    static TOOLS: OnceLock<Vec<ToolSpec>> = OnceLock::new();
    TOOLS.get_or_init(build)
}

/// Render the OpenAI `tools` array from a registry.
///
/// An empty registry yields `None` so the caller can omit `tools`/`tool_choice` entirely (some
/// providers 400 on an empty list).
pub fn registry_to_openai(registry: &[ToolSpec]) -> Option<Value> {
    if registry.is_empty() {
        return None;
    }
    Some(Value::Array(
        registry
            .iter()
            .map(|t| {
                json!({
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": {
                            "type": "object",
                            "properties": t.properties,
                            "required": t.required,
                            "additionalProperties": false,
                        },
                    },
                })
            })
            .collect(),
    ))
}

fn build() -> Vec<ToolSpec> {
    vec![
        ToolSpec {
            name: "read_file",
            description: "Read a UTF-8 text file from the workspace and return its contents. Directories are rejected. Use offset/limit to read part of a large file instead of swallowing the whole thing.",
            properties: json!({
                "path": {
                    "type": "string",
                    "description": r#"Workspace-relative path, e.g. "src/main.rs". Cannot be absolute or escape the root."#,
                },
                "offset": {
                    "type": "number",
                    "description": "Optional first line to return, 1-based. Omit to start at the top.",
                },
                "limit": {
                    "type": "number",
                    "description": "Optional number of lines to return. Omit to read to the end.",
                },
            }),
            required: &["path"],
        },
        ToolSpec {
            name: "write_file",
            description: "Write UTF-8 text to a workspace file, creating parent directories as needed. Overwrites any existing file — prefer edit_file for changing one part of a file you have read.",
            properties: json!({
                "path": { "type": "string", "description": "Workspace-relative path." },
                "content": { "type": "string", "description": "Full text content to write." },
            }),
            required: &["path", "content"],
        },
        ToolSpec {
            name: "list_dir",
            description: "List the entries of a workspace directory. Defaults to the workspace root.",
            properties: json!({
                "path": {
                    "type": "string",
                    "description": "Workspace-relative directory path. Optional; defaults to \".\".",
                },
                "recursive": {
                    "type": "boolean",
                    "description": "Optional. true to include subdirectories instead of just one level.",
                },
            }),
            required: &[],
        },
        ToolSpec {
            name: "search_files",
            description: "Search the workspace for a literal string and return matching lines as path:line: text. Case-insensitive by default. Use this to find where something is defined instead of reading files one at a time.",
            properties: json!({
                "pattern": { "type": "string", "description": "Literal text to find. Not a regex." },
                "path": {
                    "type": "string",
                    "description": "Optional workspace-relative file or directory to search. Defaults to \".\".",
                },
                "case_sensitive": {
                    "type": "boolean",
                    "description": "Optional. true to match case exactly (default is case-insensitive).",
                },
            }),
            required: &["pattern"],
        },
        ToolSpec {
            name: "file_info",
            description: "Report whether a workspace path exists, and its kind, size and last-modified time. A missing path is a normal result, not an error.",
            properties: json!({
                "path": { "type": "string", "description": "Workspace-relative path." },
            }),
            required: &["path"],
        },
        ToolSpec {
            name: "edit_file",
            description: "Replace an exact snippet in a file. The snippet must match exactly — including indentation — and must occur exactly once unless replace_all is true. Safer than rewriting a whole file.",
            properties: json!({
                "path": { "type": "string", "description": "Workspace-relative path of the file to edit." },
                "old": { "type": "string", "description": "Exact text to find. Quote enough surrounding lines to make it unique." },
                "new": { "type": "string", "description": "Replacement text. May be empty to delete the snippet." },
                "replace_all": {
                    "type": "boolean",
                    "description": "Optional. true to replace every occurrence instead of refusing an ambiguous match.",
                },
            }),
            required: &["path", "old", "new"],
        },
        ToolSpec {
            name: "mkdir",
            description: "Create a directory inside the workspace, including any missing parents.",
            properties: json!({
                "path": { "type": "string", "description": "Workspace-relative directory path." },
            }),
            required: &["path"],
        },
        ToolSpec {
            name: "run_command",
            description: "Run a single allowlisted command inside the workspace. There is no shell, so ; | && ` ` and $( ) are inert literals, not syntax. Network-facing git subcommands (push/pull/fetch/clone) are refused.",
            properties: json!({
                "program": {
                    "type": "string",
                    "description": "Executable from the allowlist: ls, cat, grep, rg, find, git, node, npm, npx, pnpm, python3, make, tar, sed, awk, …",
                },
                "args": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Positional arguments, each a literal string.",
                },
                "timeout_ms": {
                    "type": "number",
                    "description": "Optional wall-clock timeout in ms (enforced upper bound is 60 000).",
                },
            }),
            required: &["program"],
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::gateway::MUTATING_TOOLS;

    #[test]
    fn the_registry_holds_eight_tools() {
        assert_eq!(agent_tools().len(), 8);
    }

    #[test]
    fn names_are_unique() {
        let names: Vec<&str> = agent_tools().iter().map(|t| t.name).collect();
        let unique: std::collections::HashSet<&str> = names.iter().copied().collect();
        assert_eq!(unique.len(), names.len());
    }

    /// The description is all the model is told about a tool, so an empty one is a tool it cannot
    /// decide to use.
    #[test]
    fn every_tool_is_described() {
        for t in agent_tools() {
            assert!(
                t.description.trim().chars().count() > 20,
                "{} has a thin description: {:?}",
                t.name,
                t.description
            );
        }
    }

    /// A `required` field that is not in `properties` is unsatisfiable under
    /// `additionalProperties: false` — the model is told to send something the schema rejects.
    #[test]
    fn every_required_field_is_declared_in_properties() {
        for t in agent_tools() {
            let props = t.properties.as_object().expect("properties is an object");
            for field in t.required {
                assert!(
                    props.contains_key(*field),
                    "{}.{} is required but not declared in properties",
                    t.name,
                    field
                );
            }
        }
    }

    #[test]
    fn every_property_has_a_type_and_a_description() {
        for t in agent_tools() {
            for (key, spec) in t.properties.as_object().expect("properties is an object") {
                let ty = spec.get("type").and_then(Value::as_str).unwrap_or("");
                assert!(!ty.is_empty(), "{}.{} has no type", t.name, key);
                let described = spec
                    .get("description")
                    .and_then(Value::as_str)
                    .map(|d| !d.trim().is_empty())
                    .unwrap_or(false);
                assert!(described, "{}.{} has no description", t.name, key);
            }
        }
    }

    /// The mutating set is exactly the four the gateway gates, in both directions: a tool that is
    /// neither listed nor read-only is a tool that writes without being gated.
    #[test]
    fn the_mutating_set_is_exactly_the_four_the_gateway_gates() {
        let names: Vec<&str> = agent_tools().iter().map(|t| t.name).collect();
        for m in MUTATING_TOOLS {
            assert!(names.contains(&m), "{m} is gated by the gateway but absent from the registry");
        }
        let mut read_only: Vec<&str> =
            names.iter().copied().filter(|n| !MUTATING_TOOLS.contains(n)).collect();
        read_only.sort_unstable();
        assert_eq!(read_only, vec!["file_info", "list_dir", "read_file", "search_files"]);
    }

    /// The reason `edit_file` exists: `write_file` is a whole-file overwrite, so every small change
    /// would be expensive and destructive. If `edit_file` is ever dropped, this is the regression.
    #[test]
    fn editing_is_possible_without_rewriting_a_whole_file() {
        assert!(agent_tools().iter().any(|t| t.name == "edit_file"));
    }

    // ── registry_to_openai ────────────────────────────────────────────────

    #[test]
    fn renders_one_function_per_tool_and_forces_additional_properties_off() {
        let wire = registry_to_openai(agent_tools()).expect("a non-empty registry renders");
        let arr = wire.as_array().expect("an array");
        assert_eq!(arr.len(), agent_tools().len());
        for (entry, spec) in arr.iter().zip(agent_tools()) {
            assert_eq!(entry["type"], json!("function"));
            assert_eq!(entry["function"]["name"], json!(spec.name));
            assert_eq!(entry["function"]["description"], json!(spec.description));
            assert_eq!(entry["function"]["parameters"]["type"], json!("object"));
            assert_eq!(entry["function"]["parameters"]["additionalProperties"], json!(false));
            assert_eq!(entry["function"]["parameters"]["properties"], spec.properties);
        }
    }

    /// Some providers reject an empty `tools` array with a 400, so omitting is the only correct
    /// rendering of "no tools" — not `[]`.
    #[test]
    fn an_empty_registry_yields_none_so_callers_can_omit_tools_entirely() {
        assert_eq!(registry_to_openai(&[]), None);
    }

    #[test]
    fn required_is_always_an_array_never_absent() {
        let wire = registry_to_openai(agent_tools()).expect("a non-empty registry renders");
        for entry in wire.as_array().expect("an array") {
            assert!(
                entry["function"]["parameters"]["required"].is_array(),
                "{} rendered no required array",
                entry["function"]["name"]
            );
        }
    }

    /// `list_dir` requires nothing, and that must render as `[]` rather than being dropped.
    #[test]
    fn a_tool_with_no_required_fields_renders_an_empty_array() {
        let wire = registry_to_openai(agent_tools()).expect("a non-empty registry renders");
        let list_dir = wire
            .as_array()
            .expect("an array")
            .iter()
            .find(|e| e["function"]["name"] == json!("list_dir"))
            .expect("list_dir is in the registry");
        assert_eq!(list_dir["function"]["parameters"]["required"], json!([]));
    }
}
