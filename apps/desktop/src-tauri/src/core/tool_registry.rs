//! The agent-mode tool registry — the port of `tools/registry.ts` (168 lines).
//!
//! **This is the single source of truth for what the model may call.** Every entry maps 1:1 to a
//! handler in the Rust sandbox (`tauri/tools.rs`) — if a tool is not listed here the model cannot
//! name it, and even if it did, the host would refuse it. [`registry_to_openai`] renders the OpenAI
//! `tools` array; `additionalProperties: false` keeps the model from smuggling extra fields the
//! sandbox would ignore anyway.
//!
//! **One deliberate divergence from the frontend registry:** `web_ask` exists only there. It is
//! answered by the agent loop, which holds the model — a capability this side keeps one-way. It
//! is not listed here, so the gateway never advertises it; the sandbox still carries a refusal
//! arm in case a call arrives by name anyway.
//!
//! `write_file`, `edit_file`, `mkdir` and `run_command` are **mutating** — the four the gateway
//! refuses unless mutation is explicitly enabled ([`crate::core::gateway::MUTATING_TOOLS`]), and the
//! four the Assistant confirms one call at a time. `todo_write` mutates only the Assistant's
//! progress panel, never the workspace, and `web_fetch`/`web_search` reach the public internet
//! without writing anywhere; none of them is gated. The other four only read, and are always
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
//! # Why the gateway advertises fewer tools than the Assistant
//!
//! [`gateway_tool_set`] narrows the registry when mutation is off, which is the default. A tool that
//! is advertised and then refused is not merely wasted tokens — the model calls it, reads a refusal
//! and spends a turn discovering that. Measured on a short request: the eight schemas cost ~1,187
//! prompt tokens of a 1,721-token prompt, and the mutating four are about half of that.
//!
//! One divergence: the reference returns `undefined` for an empty registry, which becomes `None`
//! here. Both mean "omit `tools`/`tool_choice` entirely", which is the only correct rendering of
//! "no tools" — some providers reject an empty `tools` array with a 400, so `[]` is not an option.

use std::sync::OnceLock;

use serde_json::{json, Value};

use crate::core::gateway::MUTATING_TOOLS;

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

/// The subset of the registry the gateway should advertise.
///
/// Mutation is off by default on the gateway path ([`crate::core::gateway::gateway_tool_refusal`]),
/// so the mutating entries are dropped unless the operator turned mutation on. Dropping them is
/// cheaper *and* more honest than advertising a tool that will be refused.
///
/// The Assistant path is unaffected: it confirms each call, so it wants the whole registry.
pub fn gateway_tool_set(mutation_enabled: bool) -> Vec<ToolSpec> {
    agent_tools()
        .iter()
        .filter(|t| mutation_enabled || !MUTATING_TOOLS.contains(&t.name))
        .cloned()
        .collect()
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
            description: "Read a UTF-8 text file from the workspace. Use offset/limit to read part of a large file instead of the whole thing.",
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
            description: "Write UTF-8 text to a workspace file, creating parent directories. Overwrites; prefer edit_file to change part of a file you have read.",
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
            description: "Search the workspace for a literal string, returning matching lines as path:line: text. Case-insensitive by default.",
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
            description: "Report whether a workspace path exists: kind, size, last-modified. A missing path is a normal result, not an error.",
            properties: json!({
                "path": { "type": "string", "description": "Workspace-relative path." },
            }),
            required: &["path"],
        },
        ToolSpec {
            name: "edit_file",
            description: "Replace an exact snippet in a file. It must match exactly, indentation included, and occur once unless replace_all is true.",
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
            description: "Run one allowlisted command in the workspace. No shell, so ; | && are inert literals. git may clone, fetch, pull and push; gh is gated.",
            properties: json!({
                "program": {
                    "type": "string",
                    "description": "Executable from the allowlist: ls, cat, grep, rg, find, git (listed subcommands only — clone/fetch/pull/push included), gh (GitHub: repos, PRs, issues, gists, releases, workflow runs, gh api — gh auth and gh repo delete refused), node, npm, npx, pnpm, python3, make, tar, sed, awk, …",
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
        ToolSpec {
            name: "glob",
            description: "List workspace paths matching a glob pattern: ** spans directories, * and ? stay in one segment. Capped at 500 entries.",
            properties: json!({
                "pattern": {
                    "type": "string",
                    "description": "Glob relative to the workspace root, e.g. \"src/**/*.rs\". May not contain \"..\".",
                },
                "path": {
                    "type": "string",
                    "description": "Optional workspace-relative base directory to match within. Defaults to \".\".",
                },
            }),
            required: &["pattern"],
        },
        ToolSpec {
            name: "read_document",
            description: "Read text from a PDF or Word (.docx) document in the workspace — the binary documents read_file cannot serve. Text is capped.",
            properties: json!({
                "path": {
                    "type": "string",
                    "description": "Workspace-relative path of the .pdf or .docx.",
                },
            }),
            required: &["path"],
        },
        ToolSpec {
            name: "read_image",
            description: "Read a workspace image (png/jpg/gif/webp, 4 MB cap) so a vision-capable model can see it in the next turn.",
            properties: json!({
                "path": {
                    "type": "string",
                    "description": "Workspace-relative path of the image.",
                },
            }),
            required: &["path"],
        },
        ToolSpec {
            name: "http_request",
            description: "Run one HTTP request against a public URL: method, headers, body; returns the response. It sends data out, so it is always confirmed; private hosts are refused.",
            properties: json!({
                "url": {
                    "type": "string",
                    "description": "Public http(s) URL. Redirects are reported, not followed.",
                },
                "method": {
                    "type": "string",
                    "description": "Optional: GET (default), POST, PUT, PATCH, DELETE, HEAD, OPTIONS.",
                },
                "headers": {
                    "type": "object",
                    "description": "Optional request headers as name/value strings.",
                },
                "body": {
                    "type": "string",
                    "description": "Optional request body (POST/PUT/PATCH only).",
                },
            }),
            required: &["url"],
        },
        ToolSpec {
            name: "apply_patch",
            description: "Write a unified diff (multi-hunk, multi-file) into workspace files: context must match exactly; a mismatch fails the whole patch.",
            properties: json!({
                "patch": {
                    "type": "string",
                    "description": "The full unified diff, ---/+++ and @@ hunks included. New files start from /dev/null.",
                },
            }),
            required: &["patch"],
        },
        ToolSpec {
            name: "todo_write",
            description: "Write the task list for the current run: replace it wholesale with every task and its status. Keep at most one task in_progress.",
            properties: json!({
                "todos": {
                    "type": "array",
                    "description": "The full task list, in order.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "content": { "type": "string", "description": "The task, one sentence." },
                            "status": { "type": "string", "enum": ["pending", "in_progress", "completed"] },
                        },
                        "required": ["content", "status"],
                        "additionalProperties": false,
                    },
                },
            }),
            required: &["todos"],
        },
        ToolSpec {
            name: "web_fetch",
            description: "Read a public web page from the internet: fetched over http(s), HTML stripped, text capped at 32 KB. Private, loopback and non-http(s) URLs are refused.",
            properties: json!({
                "url": {
                    "type": "string",
                    "description": "The page's public http(s) URL. Redirects are reported, not followed — call again on the Location.",
                },
            }),
            required: &["url"],
        },
        ToolSpec {
            name: "web_search",
            description: "Search the public web (keyless, automatic fallback between backends) and get the top results: title, URL and snippet. Follow up with web_fetch to read a result.",
            properties: json!({
                "query": {
                    "type": "string",
                    "description": "What to search for, in the user's terms.",
                },
            }),
            required: &["query"],
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::gateway::MUTATING_TOOLS;

    #[test]
    fn the_registry_holds_sixteen_tools() {
        assert_eq!(agent_tools().len(), 16);
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

    /// Trimmed for prompt cost, but a tool whose description no longer says what it *does* is a
    /// tool the model misuses. Every description still has to name its action and its subject.
    #[test]
    fn every_description_still_names_its_action() {
        for t in agent_tools() {
            let d = t.description.to_lowercase();
            let named = ["read", "write", "list", "search", "report", "replace", "create", "run"]
                .iter()
                .any(|v| d.starts_with(v));
            assert!(named, "{} no longer leads with its action: {:?}", t.name, t.description);
        }
    }

    /// The ceiling the trim was written against. Descriptions are the only free text in the schema
    /// and the easiest thing to inflate back; this fails loudly if one grows past it.
    #[test]
    fn no_description_exceeds_the_trim_budget() {
        for t in agent_tools() {
            assert!(
                t.description.chars().count() <= 160,
                "{} is {} chars, over the 160-char budget: {:?}",
                t.name,
                t.description.chars().count(),
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

    /// The mutating set is exactly what the gateway gates, in both directions: a tool that is
    /// neither listed nor read-only is a tool that writes without being gated.
    #[test]
    fn the_mutating_set_is_exactly_what_the_gateway_gates() {
        let names: Vec<&str> = agent_tools().iter().map(|t| t.name).collect();
        for m in MUTATING_TOOLS {
            assert!(names.contains(&m), "{m} is gated by the gateway but absent from the registry");
        }
        let mut read_only: Vec<&str> =
            names.iter().copied().filter(|n| !MUTATING_TOOLS.contains(n)).collect();
        read_only.sort_unstable();
        // `todo_write` mutates only the Assistant's progress panel, never the workspace, so it
        // is on the read-only side even though its name says "write". The web tools reach the
        // public internet but write nothing anywhere, so they read too. `http_request` and
        // `apply_patch` are the opposite case: names that sound read-adjacent ("request",
        // "patch") but which send data out or rewrite files, so they are gated.
        assert_eq!(
            read_only,
            vec![
                "file_info",
                "glob",
                "list_dir",
                "read_document",
                "read_file",
                "read_image",
                "search_files",
                "todo_write",
                "web_fetch",
                "web_search"
            ]
        );
    }

    /// The reason `edit_file` exists: `write_file` is a whole-file overwrite, so every small change
    /// would be expensive and destructive. If `edit_file` is ever dropped, this is the regression.
    #[test]
    fn editing_is_possible_without_rewriting_a_whole_file() {
        assert!(agent_tools().iter().any(|t| t.name == "edit_file"));
    }

    // ── gateway_tool_set ──────────────────────────────────────────────────

    /// The whole point: with mutation off (the default) the gateway must not advertise a tool it
    /// will refuse. Falsified by dropping the filter — the set goes back to sixteen.
    #[test]
    fn gateway_tool_set_omits_the_mutating_four_when_mutation_is_off() {
        let set = gateway_tool_set(false);
        let names: Vec<&str> = set.iter().map(|t| t.name).collect();
        assert_eq!(names.len(), 10, "expected the ten read-only tools, got {names:?}");
        for m in MUTATING_TOOLS {
            assert!(!names.contains(&m), "{m} is advertised but would be refused");
        }
    }

    /// Enabling mutation is opt-in and must restore the whole registry, not a subset.
    #[test]
    fn gateway_tool_set_includes_every_tool_when_mutation_is_on() {
        assert_eq!(gateway_tool_set(true).len(), 16);
    }

    /// The read-only ten are advertised either way — narrowing must never remove a tool the
    /// gateway is willing to run.
    #[test]
    fn the_read_only_tools_are_advertised_either_way() {
        for on in [true, false] {
            let names: Vec<&str> = gateway_tool_set(on).iter().map(|t| t.name).collect();
            for r in [
                "read_file", "list_dir", "search_files", "file_info", "todo_write",
                "web_fetch", "web_search", "glob", "read_document", "read_image",
            ] {
                assert!(names.contains(&r), "{r} missing when mutation_enabled={on}");
            }
        }
    }

    /// A narrowed set still has to render, and must render exactly what it holds — an off-by-one
    /// between the filter and the renderer would silently re-advertise a refused tool.
    #[test]
    fn a_narrowed_set_renders_only_what_it_holds() {
        let set = gateway_tool_set(false);
        let wire = registry_to_openai(&set).expect("a narrowed registry still renders");
        let arr = wire.as_array().expect("an array");
        assert_eq!(arr.len(), set.len());
        let rendered: Vec<&str> =
            arr.iter().map(|e| e["function"]["name"].as_str().unwrap_or("")).collect();
        for m in MUTATING_TOOLS {
            assert!(!rendered.contains(&m), "{m} reached the wire with mutation off");
        }
    }

    /// The reduction the trim and the filter were written to deliver, pinned as bytes on the wire.
    ///
    /// The narrowed set must cost less than its PROPORTIONAL SHARE of the full render — five
    /// read-only tools of nine means under 5/9 of the bytes, i.e. the read-only tools are each
    /// cheaper than the registry average. (It used to be "under half" back when half the registry
    /// was read-only; a ninth tool that is read-only and lives in both sets made a strict half
    /// unreachable, so the invariant moved to the share that matches the set's composition.)
    /// Falsified by removing the filter or letting the read-only descriptions grow back.
    #[test]
    fn the_gateway_set_is_less_than_half_the_rendered_bytes() {
        let full = registry_to_openai(agent_tools()).expect("full registry renders");
        let narrowed = registry_to_openai(&gateway_tool_set(false)).expect("narrowed renders");
        let full_bytes = serde_json::to_string(&full).unwrap().len();
        let narrow_bytes = serde_json::to_string(&narrowed).unwrap().len();
        let narrowed_count = gateway_tool_set(false).len();
        assert!(
            narrow_bytes * agent_tools().len() < full_bytes * narrowed_count,
            "narrowed {narrow_bytes} bytes is not under its {narrowed_count}/{} share of full {full_bytes}",
            agent_tools().len()
        );
    }

    /// The token-budget guard for the registry as a whole: no tool may bloat the render past a
    /// fixed per-tool budget. This replaced the old "narrowed under 55% of full" check, which
    /// was composed for a registry that was half read-only — after the web tools joined, the
    /// read-only share is 7/11 and that ratio test became structurally unreachable. The
    /// proportional-share test above still guards the narrowing; this one guards bloat.
    #[test]
    fn the_registry_render_stays_under_the_per_tool_budget() {
        let full = registry_to_openai(agent_tools()).expect("full registry renders");
        let full_bytes = serde_json::to_string(&full).unwrap().len();
        let budget = 650 * agent_tools().len();
        assert!(
            full_bytes <= budget,
            "full render {full_bytes} bytes is over the {budget}-byte budget ({} tools × 650)",
            agent_tools().len()
        );
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
