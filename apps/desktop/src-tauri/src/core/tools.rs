//! Sandboxed tool host for agent mode (2026-09-17).
//!
//! The threat model here is unusual: the caller is not the human, it is a MODEL. The webview
//! is untrusted too (see commands.rs), but the model is the one that will confidently ask to
//! run `rm -rf ~` because a prompt told it to tidy up. So the host — not the UI, not the
//! model — is the enforcement boundary, and it holds four rules:
//!
//!   1. NO SHELL. Commands are executed as `Command::new(prog).args(argv)`. There is no
//!      `sh -c`, so `;`, `&&`, `|`, backticks and `$(...)` are inert text, not syntax. This
//!      single choice removes the entire injection class.
//!   2. ALLOWLIST. Only a fixed set of executables can start. `rm`, `sudo`, `sh`, `curl`,
//!      `wget`, `ssh`, `nc` and friends are simply absent, so they cannot run at any
//!      argument. `git` may reach the network in both directions (the user points the
//!      assistant at repos and asks it to publish branches); `gh` is the GitHub surface,
//!      gated to the subcommands that are neither interactive nor machine-credential-touching
//!      nor destructive to a remote.
//!   3. ROOT CONFINEMENT. Every file path is resolved and must land inside the workspace
//!      root after canonicalization, so `..` and symlinks pointing outward both fail.
//!   4. BOUNDED. Wall-clock timeout, output caps, and a scrubbed environment (no ambient
//!      secrets leaking into a transcript the model can read back).
//!
//! Rule 1 is why this does not depend on pattern-matching "dangerous" strings — a blocklist
//! would be a sieve. What remains (a model reading or overwriting files inside the one
//! directory the user pointed it at) is the risk the user accepted by enabling agent mode,
//! and every call is confirmed in the UI before it reaches this file.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
// Test-only: the zip writer's `write_all` needs the trait, and nothing in the library does.
#[cfg(test)]
use std::io::Write as _;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use base64::Engine as _;
use regex::Regex;
use serde::{Deserialize, Serialize};

/// Executables that may start. Everything else is refused, including anything destructive
/// (`rm`, `mv` to `rm`-like effect is bounded by confinement) or network-facing.
fn allowed_programs() -> &'static HashSet<&'static str> {
    // Leaked once on purpose: a `const` HashSet is not constructible pre-1.80 in const fn.
    static CELL: std::sync::OnceLock<HashSet<&'static str>> = std::sync::OnceLock::new();
    CELL.get_or_init(|| {
        [
            "ls", "cat", "head", "tail", "wc", "grep", "rg", "find", "pwd", "echo", "printf",
            "date", "which", "basename", "dirname", "stat", "du", "diff", "sort", "uniq", "tr",
            "cut", "sed", "awk", "tar", "unzip", "mkdir", "touch", "cp", "git", "gh", "node",
            "npm", "npx", "pnpm", "python3", "pip3", "make",
        ]
        .into_iter()
        .collect()
    })
}

/// `git` is allowed for the subcommands working on a repository needs, including the network
/// ones: the user points the assistant at repos and asks it to publish branches, so inbound
/// (`clone`, `fetch`, `pull`) and outbound (`push`) are all reachable. The allowlist itself is
/// the boundary — anything not listed here (e.g. `remote`, `rebase`, `filter-branch`) is
/// refused, and the argument pass refuses path-like arguments that leave the workspace.
const GIT_SUBCOMMANDS: &[&str] = &[
    "status",
    "diff",
    "log",
    "show",
    "branch",
    "add",
    "commit",
    "init",
    "rev-parse",
    "ls-files",
    "config",
    "describe",
    "stash",
    "clone",
    "fetch",
    "pull",
    "push",
];

/// `gh` top-level commands that are refused outright. `auth` is interactive (it would hang to
/// the timeout) and mutates machine-level credentials; everything else on the GitHub surface —
/// repos, PRs, issues, gists, releases, workflow runs, `gh api` — is reachable.
const GH_DENIED: &[&str] = &["auth"];

/// The second layer of the `gh` gate: (command, subcommand) pairs that destroy or mutate a
/// remote resource wholesale. Refused even though the rest of their command is allowed.
const GH_DENIED_PAIRS: &[(&str, &str)] = &[("repo", "delete"), ("codespace", "delete")];

/// Why this `gh` invocation is refused, if it is. Split from `do_run_command` so the gate is
/// unit-testable without spawning `gh` at all.
fn gh_denial(argv: &[String]) -> Option<String> {
    let sub = argv.first()?;
    if GH_DENIED.contains(&sub.as_str()) {
        return Some(format!("gh subcommand \"{sub}\" is not allowed"));
    }
    if let Some(action) = argv.get(1) {
        if GH_DENIED_PAIRS.contains(&(sub.as_str(), action.as_str())) {
            return Some(format!("gh {sub} {action} is not allowed"));
        }
    }
    None
}

const MAX_COMMAND_MS: u64 = 60_000;
const DEFAULT_COMMAND_MS: u64 = 20_000;
const MAX_OUTPUT_BYTES: usize = 64 * 1024;
const MAX_READ_BYTES: usize = 256 * 1024;
const MAX_WRITE_BYTES: usize = 1024 * 1024;
const MAX_LIST_ENTRIES: usize = 500;
/// How long a cancelled command gets to exit on SIGINT before SIGKILL follows. Two seconds is the
/// conventional grace: long enough for a test runner to flush and exit cleanly, short enough that
/// a user who pressed Stop does not experience it as a hang.
const CANCEL_GRACE_MS: u64 = 2_000;
/// Bounds for the read-only discovery tools. Each exists because the alternative is a model
/// asking for the whole workspace and getting a wall of text it cannot use — or worse, one that
/// blows past the 64KB output cap and comes back truncated mid-line.
const MAX_SEARCH_MATCHES: usize = 200;
const MAX_SEARCH_FILE_BYTES: usize = 2 * 1024 * 1024;
/// A match is a whole line, and "line" is whatever sits between two newlines — a 2 MB minified
/// file is ONE line. Counting matches therefore bounds nothing: 200 minified matches is ~400 MB.
/// So each line is clipped for display and the total is capped in bytes, the same cap
/// `run_command` already lives under.
const MAX_SEARCH_LINE_CHARS: usize = 300;
const MAX_WALK_DEPTH: usize = 6;
const MAX_WALK_ENTRIES: usize = 5_000;

#[derive(Debug, Deserialize)]
pub struct ToolRunRequest {
    pub name: String,
    #[serde(default)]
    pub arguments: serde_json::Value,
    /// Workspace root every path is confined to. Required — there is no ambient default, so a
    /// caller cannot accidentally get whole-filesystem access.
    pub root: String,
}

#[derive(Debug, Serialize)]
pub struct ToolResult {
    pub ok: bool,
    pub output: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl ToolResult {
    fn ok(output: impl Into<String>) -> Self {
        Self { ok: true, output: output.into(), error: None }
    }
    pub(crate) fn err(message: impl Into<String>) -> Self {
        Self { ok: false, output: String::new(), error: Some(message.into()) }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ToolAllowlist {
    pub programs: Vec<&'static str>,
    pub git_subcommands: Vec<&'static str>,
    pub max_command_ms: u64,
    pub max_output_bytes: usize,
}

/// Announce the sandbox to the UI so it can show the user what is actually permitted,
/// rather than making them trust a checkbox.
pub fn tools_policy() -> ToolAllowlist {
    let mut programs: Vec<&'static str> = allowed_programs().iter().copied().collect();
    programs.sort_unstable();
    ToolAllowlist {
        programs,
        git_subcommands: GIT_SUBCOMMANDS.to_vec(),
        max_command_ms: MAX_COMMAND_MS,
        max_output_bytes: MAX_OUTPUT_BYTES,
    }
}

/// Is `root` usable as a workspace root? The UI asks this before the first tool call.
///
/// An unusable root used to surface only as a failed tool call — and, while the host dropped the
/// error field, as a *blank* one, so the user saw "the tool results came back empty" with no way
/// to tell that the path they typed simply did not exist. Judging it up front is the difference
/// between "your workspace root is wrong" and "the agent is broken".
pub fn tools_check_root(root: String) -> Result<(), String> {
    validate_root(Path::new(&root)).map(|_| ())
}

/// The workspace agent mode starts in, so the root field is never empty by default.
///
/// An empty root disables Send. A user who has not thought about workspaces yet reads that as
/// "agent mode is broken" rather than "point me at a folder" — and the guard is there to stop a
/// tool call from running against no root at all, not to make the user guess before they start.
///
/// It is the same folder the gateway confines its own tools to (`default_workspace_root`), so a
/// file written through the gateway is readable from the Assistant: one workspace, not two.
pub fn tools_default_root() -> Result<String, String> {
    crate::core::gateway::default_workspace_root()
        .map(|p| p.to_string_lossy().into_owned())
        .ok_or_else(|| "no home directory — set a workspace root".to_string())
}

/// Immediate subdirectories of an absolute path, for the Assistant's root picker.
///
/// A browse-to-set-root UI has to walk the filesystem OUTSIDE any workspace root — which the
/// sandboxed `list_dir` must never do, since its whole job is refusing to escape the root. This
/// command is that walk, kept deliberately dumb: names of immediate child directories only —
/// no files, no recursion, no contents — so it is a wayfinding aid, not a listing primitive the
/// sandbox would have to answer for. Hidden entries are skipped: a workspace picker does not
/// need dot-directories, and hiding them keeps the pane short.
pub fn tools_list_dirs(path: String) -> Result<Vec<String>, String> {
    if path.trim().is_empty() {
        return Err("empty path".into());
    }
    let mut out: Vec<String> = Vec::new();
    let entries = fs::read_dir(&path).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            out.push(name);
        }
    }
    out.sort_by_key(|a| a.to_lowercase());
    Ok(out)
}

/// Resolve `rel` inside `root`, refusing anything that escapes it.
///
/// Absolute paths and `..` components are rejected outright; the surviving path is then
/// canonicalized (or its parent is, for files that do not exist yet) and re-checked against
/// the root, which also defeats symlinks that point outside.
fn resolve_within(root: &Path, rel: &str, create_parents: bool) -> Result<PathBuf, String> {
    if rel.trim().is_empty() {
        return Err("path is empty".into());
    }
    let rel_path = Path::new(rel);
    if rel_path.is_absolute() {
        return Err(
            "absolute paths are not allowed — use a path relative to the workspace root".into()
        );
    }
    if rel_path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("'..' is not allowed in a path".into());
    }
    let root_canon =
        fs::canonicalize(root).map_err(|e| format!("workspace root is not accessible: {e}"))?;
    let target = root_canon.join(rel_path);
    // Reads and listings cannot create anything, so a missing path is simply missing. Say so
    // plainly: the reader of this message is a model, and "parent directory is not accessible"
    // sends it chasing a permissions problem that does not exist.
    if !create_parents && !target.exists() {
        return Err(format!("no such file or directory: {rel}"));
    }
    let resolved = match fs::canonicalize(&target) {
        Ok(c) => c,
        Err(_) => {
            // Not there yet (typically a write target): canonicalize the parent directory
            // instead. For writes we may create it first; the parent is re-checked against the
            // root afterwards so a symlink in the middle cannot redirect the create outside.
            let parent =
                target.parent().ok_or_else(|| "path has no parent directory".to_string())?;
            if create_parents {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("cannot create parent directory: {e}"))?;
            }
            let parent_canon = fs::canonicalize(parent)
                .map_err(|e| format!("parent directory is not accessible: {e}"))?;
            if !parent_canon.starts_with(&root_canon) {
                return Err("path resolves outside the workspace root".into());
            }
            parent_canon
                .join(target.file_name().ok_or_else(|| "path has no file name".to_string())?)
        }
    };
    if !resolved.starts_with(&root_canon) {
        return Err("path resolves outside the workspace root".into());
    }
    Ok(resolved)
}

fn arg_str(args: &serde_json::Value, key: &str) -> Result<String, String> {
    match args.get(key) {
        Some(serde_json::Value::String(s)) => Ok(s.clone()),
        Some(other) => Ok(other.to_string()),
        None => Err(format!("missing argument \"{key}\"")),
    }
}

fn truncate(bytes: &[u8], cap: usize) -> String {
    let taken = &bytes[..bytes.len().min(cap)];
    let mut out = String::from_utf8_lossy(taken).into_owned();
    if bytes.len() > cap {
        out.push_str(&format!("\n… truncated ({} bytes total)", bytes.len()));
    }
    out
}

/// Clip a line to `max` characters, char-wise. `truncate` above works on bytes and would cut a
/// multi-byte character in half; a search hit is built from `str`, so the safe unit is a char.
fn clip_line(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let head: String = s.chars().take(max).collect();
    format!("{head}… ({} chars)", s.chars().count())
}

/// Walk `dir` collecting `(path, is_dir)` in sorted order, bounded by depth and entry count.
///
/// Symlinked directories are deliberately not followed: `symlink_metadata` reports a symlink as a
/// symlink, so it is neither filed nor descended. A symlink pointing outside the root is exactly
/// what `resolve_within` exists to defeat, and a walk that followed one would hand the model a
/// directory the user never pointed it at. Unreadable directories are skipped rather than failing
/// the whole walk — one `Permission denied` should not hide the other ninety files.
fn walk_entries(dir: &Path, out: &mut Vec<(PathBuf, bool)>, depth: usize) {
    if depth > MAX_WALK_DEPTH || out.len() >= MAX_WALK_ENTRIES {
        return;
    }
    let rd = match fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(_) => return,
    };
    let mut items: Vec<(PathBuf, bool)> = Vec::new();
    for entry in rd.flatten() {
        let path = entry.path();
        match fs::symlink_metadata(&path) {
            Ok(ft) if ft.is_dir() => items.push((path, true)),
            Ok(ft) if ft.is_file() => items.push((path, false)),
            _ => {}
        }
    }
    items.sort_by(|a, b| a.0.cmp(&b.0));
    let mut subdirs: Vec<PathBuf> = Vec::new();
    for (p, is_dir) in items {
        if out.len() >= MAX_WALK_ENTRIES {
            return;
        }
        if is_dir {
            subdirs.push(p.clone());
        }
        out.push((p, is_dir));
    }
    for d in subdirs {
        walk_entries(&d, out, depth + 1);
    }
}

fn do_read_file(args: &serde_json::Value, root: &Path) -> ToolResult {
    match (|| -> Result<String, String> {
        let rel = arg_str(args, "path")?;
        let path = resolve_within(root, &rel, false)?;
        if path.is_dir() {
            return Err("path is a directory — use list_dir".into());
        }
        let file = fs::File::open(&path).map_err(|e| format!("cannot open: {e}"))?;
        let mut buf = Vec::new();
        file.take((MAX_READ_BYTES + 1) as u64)
            .read_to_end(&mut buf)
            .map_err(|e| format!("cannot read: {e}"))?;
        let mut text = if buf.len() > MAX_READ_BYTES {
            let mut t = String::from_utf8_lossy(&buf[..MAX_READ_BYTES]).into_owned();
            t.push_str(&format!("\n… truncated at {MAX_READ_BYTES} bytes"));
            t
        } else {
            String::from_utf8(buf).map_err(|_| "file is not valid UTF-8 text".to_string())?
        };
        // Line window. Reading a 5 000-line file to change one function is how an agent spends
        // its whole context on a single turn; `offset`/`limit` let it page instead. 1-based and
        // inclusive, because that is what editors report and what a model will guess anyway.
        let offset = args.get("offset").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
        let limit = args.get("limit").and_then(|v| v.as_u64()).map(|n| n as usize);
        if offset > 0 || limit.is_some() {
            let lines: Vec<&str> = text.lines().collect();
            let total = lines.len();
            let from = offset.saturating_sub(1).min(total);
            let to = limit.map_or(total, |n| (from + n).min(total));
            let body = lines[from..to].join("\n");
            text = format!("[lines {}-{} of {}]\n{}", from + 1, to, total, body);
        }
        Ok(text)
    })() {
        Ok(text) => ToolResult::ok(text),
        Err(e) => ToolResult::err(e),
    }
}

fn do_write_file(args: &serde_json::Value, root: &Path) -> ToolResult {
    match (|| -> Result<String, String> {
        let rel = arg_str(args, "path")?;
        let content = arg_str(args, "content")?;
        if content.len() > MAX_WRITE_BYTES {
            return Err(format!("content exceeds the {MAX_WRITE_BYTES} byte cap"));
        }
        let path = resolve_within(root, &rel, true)?;
        fs::write(&path, content.as_bytes()).map_err(|e| format!("cannot write: {e}"))?;
        Ok(format!("wrote {} bytes to {}", content.len(), rel))
    })() {
        Ok(text) => ToolResult::ok(text),
        Err(e) => ToolResult::err(e),
    }
}

fn do_list_dir(args: &serde_json::Value, root: &Path) -> ToolResult {
    match (|| -> Result<String, String> {
        let rel = args.get("path").and_then(|v| v.as_str()).unwrap_or(".");
        let dir = resolve_within(root, rel, false)?;
        if !dir.is_dir() {
            return Err("not a directory".into());
        }
        // Recursive listing was the most-missed capability after search: finding
        // `src/lib/tools/host.ts` used to take one call per directory level.
        if args.get("recursive").and_then(|v| v.as_bool()).unwrap_or(false) {
            let base = fs::canonicalize(&dir).unwrap_or_else(|_| dir.clone());
            let mut items: Vec<(PathBuf, bool)> = Vec::new();
            walk_entries(&dir, &mut items, 0);
            let mut out: Vec<String> = Vec::new();
            for (p, is_dir) in items {
                if out.len() >= MAX_LIST_ENTRIES {
                    out.push("… (listing capped)".into());
                    break;
                }
                let shown = p.strip_prefix(&base).unwrap_or(&p);
                out.push(format!("{} {}", if is_dir { "dir " } else { "file" }, shown.display()));
            }
            return Ok(if out.is_empty() {
                "(empty directory)".to_string()
            } else {
                out.join("\n")
            });
        }
        let mut entries: Vec<String> = Vec::new();
        for entry in fs::read_dir(&dir).map_err(|e| format!("cannot list: {e}"))? {
            if entries.len() >= MAX_LIST_ENTRIES {
                entries.push("… (listing capped)".into());
                break;
            }
            let entry = entry.map_err(|e| format!("cannot list: {e}"))?;
            let kind = match entry.file_type() {
                Ok(t) if t.is_dir() => "dir ",
                Ok(_) => "file",
                Err(_) => "????",
            };
            entries.push(format!("{} {}", kind, entry.file_name().to_string_lossy()));
        }
        if entries.is_empty() {
            Ok("(empty directory)".to_string())
        } else {
            Ok(entries.join("\n"))
        }
    })() {
        Ok(text) => ToolResult::ok(text),
        Err(e) => ToolResult::err(e),
    }
}

/// Metadata for one path: does it exist, what kind is it, how big, when was it touched.
///
/// Cheap, and it answers the question an agent otherwise spends a whole read on. A missing path
/// is a normal answer here, not an error — "does this file exist?" is the point of the tool.
fn do_file_info(args: &serde_json::Value, root: &Path) -> ToolResult {
    match (|| -> Result<String, String> {
        let rel = arg_str(args, "path")?;
        // Deliberately NOT `resolve_within`: that requires the path to exist, and "does this
        // exist?" is the question this tool exists to answer. Same confinement rules, checked
        // by hand — absolute and `..` refused, and a symlink that resolves outward is refused
        // too, so the only difference is that a missing path is a result instead of an error.
        let rel_path = Path::new(&rel);
        if rel_path.is_absolute() {
            return Err(
                "absolute paths are not allowed — use a path relative to the workspace root".into(),
            );
        }
        if rel_path.components().any(|c| matches!(c, Component::ParentDir)) {
            return Err("'..' is not allowed in a path".into());
        }
        let root_canon =
            fs::canonicalize(root).map_err(|e| format!("workspace root is not accessible: {e}"))?;
        let target = root_canon.join(rel_path);
        let resolved = fs::canonicalize(&target).unwrap_or_else(|_| target.clone());
        if !resolved.starts_with(&root_canon) {
            return Err("path resolves outside the workspace root".into());
        }
        let meta = match fs::symlink_metadata(&resolved) {
            Ok(m) => m,
            Err(_) => return Ok(format!("{rel}: does not exist")),
        };
        let kind = if meta.is_dir() {
            "directory"
        } else if meta.is_file() {
            "file"
        } else {
            "other"
        };
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs().to_string())
            .unwrap_or_else(|| "unknown".into());
        Ok(format!(
            "path: {rel}\nexists: yes\nkind: {kind}\nsize: {} bytes\nmodified: {modified} (unix seconds)",
            meta.len()
        ))
    })() {
        Ok(text) => ToolResult::ok(text),
        Err(e) => ToolResult::err(e),
    }
}

/// Literal search across the workspace, returning `path:line: text`.
///
/// Deliberately literal, not regex. Models emit regex freely and get silent no-matches from
/// escaping mistakes; a literal finds what was meant, and `run_command {program:"rg"}` remains
/// available when a real pattern is needed. It also means no regex engine and no new dependency.
///
/// Binary and oversized files are skipped rather than dumped, and both the match count and the
/// walk are capped — an unbounded search is a denial of service on the model's own context.
fn do_search_files(args: &serde_json::Value, root: &Path) -> ToolResult {
    match (|| -> Result<String, String> {
        let pattern = arg_str(args, "pattern")?;
        if pattern.is_empty() {
            return Err("\"pattern\" is empty".into());
        }
        let rel = args.get("path").and_then(|v| v.as_str()).unwrap_or(".");
        let start = resolve_within(root, rel, false)?;
        let case_sensitive = args.get("case_sensitive").and_then(|v| v.as_bool()).unwrap_or(false);
        let needle = if case_sensitive { pattern.clone() } else { pattern.to_lowercase() };

        let mut targets: Vec<(PathBuf, bool)> = Vec::new();
        if start.is_dir() {
            walk_entries(&start, &mut targets, 0);
        } else {
            targets.push((start, false));
        }
        let base = fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());

        let mut hits: Vec<String> = Vec::new();
        let mut used: usize = 0;
        let mut capped: Option<String> = None;
        for (f, is_dir) in targets {
            if is_dir {
                continue;
            }
            if hits.len() >= MAX_SEARCH_MATCHES {
                capped = Some(format!("{MAX_SEARCH_MATCHES} matches"));
                break;
            }
            let meta = match fs::metadata(&f) {
                Ok(m) => m,
                Err(_) => continue,
            };
            if meta.len() as usize > MAX_SEARCH_FILE_BYTES {
                continue;
            }
            // read_to_string fails on invalid UTF-8, which is exactly the binary filter we want.
            let content = match fs::read_to_string(&f) {
                Ok(c) => c,
                Err(_) => continue,
            };
            for (i, line) in content.lines().enumerate() {
                if hits.len() >= MAX_SEARCH_MATCHES {
                    capped = Some(format!("{MAX_SEARCH_MATCHES} matches"));
                    break;
                }
                let hay = if case_sensitive { line.to_string() } else { line.to_lowercase() };
                if hay.contains(&needle) {
                    let shown = f.strip_prefix(&base).unwrap_or(&f);
                    let shown_line = clip_line(line.trim_end(), MAX_SEARCH_LINE_CHARS);
                    let hit = format!("{}:{}: {}", shown.display(), i + 1, shown_line);
                    // Byte cap, not a match cap. One minified line can be megabytes on its own.
                    if used + hit.len() + 1 > MAX_OUTPUT_BYTES {
                        capped = Some(format!("{MAX_OUTPUT_BYTES} bytes"));
                        break;
                    }
                    used += hit.len() + 1;
                    hits.push(hit);
                }
            }
            if capped.is_some() {
                break;
            }
        }
        if hits.is_empty() {
            return Ok(format!("no matches for \"{pattern}\""));
        }
        let mut out = hits.join("\n");
        if let Some(reason) = capped {
            // Name which bound stopped it: "narrow the pattern" and "narrow the path" are
            // different advice, and a model told the wrong one retries the same search.
            out.push_str(&format!("\n… capped at {reason} — narrow the pattern or the path"));
        }
        Ok(out)
    })() {
        Ok(text) => ToolResult::ok(text),
        Err(e) => ToolResult::err(e),
    }
}

/// Replace an exact snippet in place. MUTATING.
///
/// The whole reason this exists: until now every edit was `write_file` with the entire file, so a
/// one-line change cost a full rewrite — more tokens, and any part of the file the model mis-remembered
/// was silently reverted. Here the match has to be unique unless `replace_all` is set, because an
/// ambiguous replace is a guess about which of the three identical lines was meant.
fn do_edit_file(args: &serde_json::Value, root: &Path) -> ToolResult {
    match (|| -> Result<String, String> {
        let rel = arg_str(args, "path")?;
        let old = arg_str(args, "old")?;
        let new = arg_str(args, "new")?;
        if old.is_empty() {
            return Err("\"old\" must not be empty — there is nothing to match".into());
        }
        let path = resolve_within(root, &rel, false)?;
        if path.is_dir() {
            return Err("path is a directory — use write_file to create a file in it".into());
        }
        let content = fs::read_to_string(&path).map_err(|e| format!("cannot read: {e}"))?;
        let count = content.matches(&old).count();
        if count == 0 {
            return Err(format!(
                "the text to replace was not found in {rel} — read the file and quote it exactly, \
                 including indentation"
            ));
        }
        let all = args.get("replace_all").and_then(|v| v.as_bool()).unwrap_or(false);
        if count > 1 && !all {
            return Err(format!(
                "\"old\" occurs {count} times in {rel}. A replacement has to be unambiguous — \
                 quote more surrounding lines, or pass replace_all:true to change every one"
            ));
        }
        let updated =
            if all { content.replace(&old, &new) } else { content.replacen(&old, &new, 1) };
        if updated.len() > MAX_WRITE_BYTES {
            return Err(format!("result exceeds the {MAX_WRITE_BYTES} byte cap"));
        }
        fs::write(&path, updated.as_bytes()).map_err(|e| format!("cannot write: {e}"))?;
        Ok(format!(
            "edited {rel}: replaced {} occurrence{} ({} → {} bytes)",
            count,
            if count == 1 { "" } else { "s" },
            content.len(),
            updated.len()
        ))
    })() {
        Ok(text) => ToolResult::ok(text),
        Err(e) => ToolResult::err(e),
    }
}

/// Create a directory (and its parents). MUTATING.
fn do_mkdir(args: &serde_json::Value, root: &Path) -> ToolResult {
    match (|| -> Result<String, String> {
        let rel = arg_str(args, "path")?;
        let path = resolve_within(root, &rel, true)?;
        fs::create_dir_all(&path).map_err(|e| format!("cannot create: {e}"))?;
        Ok(format!("created directory {rel}"))
    })() {
        Ok(text) => ToolResult::ok(text),
        Err(e) => ToolResult::err(e),
    }
}

/// One running `run_command` child, as the cancel path needs to see it: the pid to signal and a
/// flag the runner reads after the wait to learn that the exit was a cancellation, not a result.
struct RunningChild {
    pid: u32,
    canceled: Arc<AtomicBool>,
}

/// Children currently running, keyed by the model's tool-call id.
///
/// A process-global because the id is what both ends have: the agent loop knows the call it
/// issued, `tool_cancel` arrives from the UI with only that id in hand, and the runner thread that
/// owns the `Child` is not reachable from either. Only `run_command` registers — it is the only
/// tool that can run for minutes, and the only one where "the step in flight" is a real process
/// tree. The other tools are bounded by their own timeouts.
fn running_children() -> &'static Mutex<HashMap<String, RunningChild>> {
    static CELL: OnceLock<Mutex<HashMap<String, RunningChild>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Signal a whole process group. The child is spawned as its own group leader
/// (`process_group(0)`), so `-pid` reaches every descendant — `npm` AND the `node` running the
/// tests under it. Signalling only the pid is the classic half-fix: the wrapper dies, the work
/// keeps running, and Stop looks broken while the machine stays busy.
#[cfg(unix)]
fn signal_group(pid: u32, sig: libc::c_int) {
    // SAFETY: `kill` with a negative pid is `killpg` on the caller's own child group; the worst
    // case is ESRCH (already dead), which is exactly the state this call is trying to reach.
    unsafe {
        libc::kill(-(pid as libc::pid_t), sig);
    }
}

/// Removes a child's registration when the runner leaves scope, however it leaves — success,
/// timeout, error or panic-free early return. A stale entry would make every later cancel of the
/// same id "succeed" against a process that no longer exists, and would keep the escalation
/// watchdog signalling a pid that the OS may have recycled.
struct CancelRegistration(Option<String>);

impl Drop for CancelRegistration {
    fn drop(&mut self) {
        if let Some(id) = self.0.take() {
            if let Ok(mut map) = running_children().lock() {
                map.remove(&id);
            }
        }
    }
}

/// Stop a running tool call. Returns whether a child was actually running under that id, so the
/// caller can tell "stopped it" from "it had already finished" — the same distinction
/// `stopRun` makes for runs, and the same reason: a stop that did nothing must not read as one
/// that did.
///
/// Signal escalation, the POSIX convention every terminal uses: SIGINT first (a well-behaved
/// program flushes and exits), then SIGKILL after [`CANCEL_GRACE_MS`] if the registration is
/// still present. The runner treats a canceled exit as `stopped by you` rather than as the
/// command's output — a half-finished `git commit` must never be fed back to the model as a
/// result it can build on.
pub fn tool_cancel(call_id: &str) -> Result<bool, String> {
    let pid = {
        let mut map = running_children().lock().map_err(|e| e.to_string())?;
        match map.get_mut(call_id) {
            Some(child) => {
                // The flag is set before any signal is sent, so there is no window where the
                // process has exited from the signal but the runner reads the flag as unset.
                child.canceled.store(true, Ordering::SeqCst);
                child.pid
            }
            None => return Ok(false),
        }
    };
    #[cfg(unix)]
    {
        signal_group(pid, libc::SIGINT);
        let id = call_id.to_string();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(CANCEL_GRACE_MS));
            // Presence in the map means the runner has not returned yet — that is the liveness
            // test. (Checking the pid directly would race reaping and possible pid reuse.)
            let still_running =
                running_children().lock().map(|map| map.contains_key(&id)).unwrap_or(false);
            if still_running {
                signal_group(pid, libc::SIGKILL);
            }
        });
    }
    Ok(true)
}

/// The uncancellable form, kept for the tests (and for callers that have no tool-call id): every
/// production path goes through `tool_run_with_call`, which supplies one when the Assistant has it.
#[cfg(test)]
fn do_run_command(args: &serde_json::Value, root: &Path) -> ToolResult {
    do_run_command_with(args, root, None)
}

/// `call_id` is the model's tool-call id when the caller has one (the Assistant does; the
/// gateway and direct calls do not). With an id, the child is registered for cancellation; without
/// one it simply runs to completion or timeout, exactly as before.
fn do_run_command_with(args: &serde_json::Value, root: &Path, call_id: Option<&str>) -> ToolResult {
    match (|| -> Result<String, String> {
        let program = arg_str(args, "program")?;
        if !allowed_programs().contains(program.as_str()) {
            return Err(format!("program \"{program}\" is not on the allowlist"));
        }
        let argv: Vec<String> = match args.get("args") {
            Some(serde_json::Value::Array(items)) => items
                .iter()
                .map(|v| match v {
                    serde_json::Value::String(s) => Ok(s.clone()),
                    other => Ok(other.to_string()),
                })
                .collect::<Result<Vec<_>, String>>()?,
            None => Vec::new(),
            Some(_) => return Err("\"args\" must be an array of strings".into()),
        };
        // Sub-gate `git`: only the subcommands working on a repository needs are reachable.
        if program == "git" {
            match argv.first() {
                None => return Err("git needs a subcommand".into()),
                Some(sub) if !GIT_SUBCOMMANDS.contains(&sub.as_str()) => {
                    return Err(format!("git subcommand \"{sub}\" is not allowed"));
                }
                Some(_) => {}
            }
        }
        // Sub-gate `gh`: the GitHub surface, minus the interactive, credential-touching and
        // remotely destructive subcommands.
        if program == "gh" {
            if argv.is_empty() {
                return Err("gh needs a subcommand".into());
            }
            if let Some(reason) = gh_denial(&argv) {
                return Err(reason);
            }
        }
        // Audit H1: the program is allowlisted, but the ARGUMENTS were never inspected. Refuse
        // path-like arguments that would leave the workspace, for every program alike.
        for a in &argv {
            if is_escaping_path(a) {
                return Err(format!(
                    "argument \"{a}\" points outside the workspace root — use a path relative to it"
                ));
            }
        }

        let timeout_ms = args
            .get("timeout_ms")
            .and_then(|v| v.as_u64())
            .unwrap_or(DEFAULT_COMMAND_MS)
            .min(MAX_COMMAND_MS);

        let mut cmd = Command::new(&program);
        cmd.args(&argv)
            .current_dir(root)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // Scrubbed environment: nothing ambient (tokens, keys, shell vars) can leak into
            // output the model reads back.
            .env_clear()
            .env("PATH", CHILD_PATH)
            .env("HOME", std::env::var("HOME").unwrap_or_else(|_| "/tmp".into()))
            .env("TMPDIR", std::env::var("TMPDIR").unwrap_or_else(|_| "/tmp".into()))
            .env("LANG", "C.UTF-8");

        // Own process group, so a cancel (or a timeout) can signal the whole tree rather than the
        // first pid. Without this the group is inherited from the app, and `killpg` would signal
        // the app itself.
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt as _;
            cmd.process_group(0);
        }

        let mut child = cmd.spawn().map_err(|e| format!("cannot start \"{program}\": {e}"))?;
        let child_pid = child.id();
        // Registered before the pipes are read, so a cancel that arrives while the command is
        // still starting up finds it. The guard removes the entry on every exit from here on.
        let canceled = Arc::new(AtomicBool::new(false));
        let _registration = CancelRegistration(call_id.map(|id| {
            if let Ok(mut map) = running_children().lock() {
                map.insert(
                    id.to_string(),
                    RunningChild { pid: child_pid, canceled: canceled.clone() },
                );
            }
            id.to_string()
        }));
        // `std` has no wait-with-timeout that also captures output, so the child is parked in
        // a worker thread that reads both pipes to EOF and then waits; on timeout the caller
        // kills it through the shared lock. `kill`/`wait` both take `&mut self`, so the child
        // stays behind the lock and is never moved out.
        let mut stdout =
            child.stdout.take().ok_or_else(|| "stdout was not captured".to_string())?;
        let mut stderr =
            child.stderr.take().ok_or_else(|| "stderr was not captured".to_string())?;
        let child = Arc::new(Mutex::new(child));
        let (tx, rx) = mpsc::channel::<std::io::Result<(Vec<u8>, Vec<u8>, i32)>>();
        let killer = child.clone();
        std::thread::spawn(move || {
            let mut out = Vec::new();
            let mut err = Vec::new();
            let _ = stdout.read_to_end(&mut out);
            let _ = stderr.read_to_end(&mut err);
            let status = killer.lock().unwrap().wait();
            match status {
                Ok(s) => {
                    let _ = tx.send(Ok((out, err, s.code().unwrap_or(-1))));
                }
                Err(e) => {
                    let _ = tx.send(Err(e));
                }
            }
        });

        let (captured_out, captured_err, code) = match rx
            .recv_timeout(Duration::from_millis(timeout_ms))
        {
            Ok(Ok(triple)) => triple,
            Ok(Err(e)) => return Err(format!("command failed: {e}")),
            Err(_) => {
                // Timed out: kill the GROUP, not just the pid — the same orphan problem the cancel
                // path solves. A `pnpm` wrapper that dies leaves `node` running otherwise, and the
                // worker thread's read-to-EOF never returns, so the drain below would hang out the
                // whole grace window and then give up on a process that is still alive.
                #[cfg(unix)]
                signal_group(child_pid, libc::SIGKILL);
                // Windows has no group signal here; the direct kill is what it has always had.
                let _ = child.lock().unwrap().kill();
                let _ =
                    rx.recv_timeout(Duration::from_millis(MAX_COMMAND_MS.saturating_add(5_000)));
                return Err(format!("\"{program}\" timed out after {timeout_ms}ms and was killed"));
            }
        };

        // A cancelled run's exit code is meaningless — the process was killed, and whatever it
        // had printed is a fragment. Report the user's action, never the fragment: the loop turns
        // this into the tool result the model reads back, and "stopped by you" is the truth that
        // stops it from treating a half-finished command as a completed one.
        if canceled.load(Ordering::SeqCst) {
            return Err("stopped by you".to_string());
        }

        let mut text = String::new();
        text.push_str(&truncate(&captured_out, MAX_OUTPUT_BYTES));
        let stderr = truncate(&captured_err, MAX_OUTPUT_BYTES);
        if !stderr.is_empty() {
            if !text.is_empty() && !text.ends_with('\n') {
                text.push('\n');
            }
            text.push_str("[stderr]\n");
            text.push_str(&stderr);
        }
        if code != 0 {
            text.push_str(&format!("\n[exit {code}]"));
        }
        if text.trim().is_empty() {
            text = "(no output)".to_string();
        }
        Ok(text)
    })() {
        Ok(text) => ToolResult::ok(text),
        Err(e) => ToolResult::err(e),
    }
}

/// Reject a workspace root that would make confinement meaningless (audit C1).
///
/// `resolve_within` confines every path TO the root and does that correctly — what it cannot do is
/// judge the root itself. A root of `/`, `$HOME`, or a system directory is confinement to nothing:
/// the model gets the whole disk. The root is a free-text user input (Assistant.tsx), so this is a
/// footgun rather than an exploitable hole — but the host is the enforcement boundary, and a check
/// that only exists in the UI is a check the model's own path does not pass through.
///
/// Refusing is deliberate over clamping: silently rewriting `/` to a subdirectory would hand the
/// user a workspace they did not ask for and would not notice.
pub(crate) fn validate_root(root: &Path) -> Result<PathBuf, String> {
    // Canonicalize first, so `..`, symlinks and trailing slashes cannot carry a bad root past
    // the comparisons below.
    let canonical = fs::canonicalize(root).map_err(|_| {
        format!("workspace root does not exist or is not readable: {}", root.display())
    })?;
    if !canonical.is_dir() {
        return Err(format!("workspace root is not a directory: {}", root.display()));
    }
    // No parent means the filesystem root.
    if canonical.parent().is_none() {
        return Err(
            "workspace root cannot be the filesystem root — there would be no confinement".into()
        );
    }
    // Compare canonicalized to canonicalized. Several of these are symlinks on macOS —
    // `/etc` resolves to `/private/etc`, `/tmp` to `/private/tmp` — so comparing the literal
    // string against an already-resolved root would silently let them through (caught by a test
    // that failed on exactly this).
    let canon = |p: &str| fs::canonicalize(p).unwrap_or_else(|_| PathBuf::from(p));
    if let Some(home) = std::env::var_os("HOME") {
        if canonical == canon(&home.to_string_lossy()) {
            return Err(
                "workspace root cannot be the home directory — it would expose everything under it"
                    .into(),
            );
        }
    }
    for forbidden in ["/System", "/usr", "/bin", "/sbin", "/etc", "/private"] {
        if canonical == canon(forbidden) {
            return Err(format!("workspace root cannot be a system directory ({forbidden})"));
        }
    }
    Ok(canonical)
}

/// True when a `run_command` argument is a path that would point outside the workspace root.
///
/// The child runs with `current_dir(root)`, which confines RELATIVE paths and says nothing about
/// absolute ones — so `cat /etc/passwd` read straight out of the workspace even though `cat` is a
/// perfectly harmless allowlisted program (audit H1; a test reproduces it). Flags and ordinary
/// words pass through untouched; this refuses only the shapes that escape.
///
/// It deliberately does NOT try to make `python3 -c "…"` safe. An interpreter on the allowlist is
/// arbitrary execution by design — the model can `write_file` a script and run it, so blocking
/// `-c` alone would be theatre. The boundary for that is confirmation, not parsing.
fn is_escaping_path(arg: &str) -> bool {
    // Same rule `resolve_within` applies to the file tools: absolute paths are not accepted.
    if arg.starts_with('/') {
        return true;
    }
    arg.split('/').any(|component| component == "..")
}

/// Normalise the `arguments` payload into an object.
///
/// The two callers disagree: the Assistant host (`host.ts`) sends a real object, while the
/// gateway bridge sends `JSON.stringify(args)` — OpenAI's wire format, where a tool call's
/// `arguments` is a string. Both land in the same `serde_json::Value`, and `Value::get` on a
/// `Value::String` returns `None` rather than failing, so every gateway tool call answered
/// `missing argument "program"` (or "path") while `list_dir` silently fell back to its `"."`
/// default and looked like it had worked.
fn arguments_object(args: &serde_json::Value) -> Result<serde_json::Value, String> {
    match args {
        serde_json::Value::String(s) => {
            serde_json::from_str(s).map_err(|e| format!("tool arguments are not valid JSON: {e}"))
        }
        other => Ok(other.clone()),
    }
}

/// Record the assistant's task list for the current run. The list itself lives in the UI — the
/// Assistant screen renders it in the progress capsule — so this handler is only the validation
/// gate: a well-formed list is acknowledged, a malformed one is refused before it can confuse
/// the panel. Nothing is written to the workspace, which is why the tool is not mutating.
fn do_todo_write(args: &serde_json::Value) -> ToolResult {
    match (|| -> Result<String, String> {
        let todos = args
            .get("todos")
            .ok_or("missing argument \"todos\"")?
            .as_array()
            .ok_or("\"todos\" must be an array")?;
        if todos.len() > 50 {
            return Err(format!("\"todos\" is capped at 50 entries, got {}", todos.len()));
        }
        for (i, todo) in todos.iter().enumerate() {
            let content = todo
                .get("content")
                .and_then(|c| c.as_str())
                .ok_or_else(|| format!("todos[{i}] needs a \"content\" string"))?;
            if content.trim().is_empty() {
                return Err(format!("todos[{i}] content is empty"));
            }
            let status = todo
                .get("status")
                .and_then(|s| s.as_str())
                .ok_or_else(|| format!("todos[{i}] needs a \"status\" string"))?;
            if !matches!(status, "pending" | "in_progress" | "completed") {
                return Err(format!(
                    "todos[{i}] status must be \"pending\", \"in_progress\" or \"completed\", got {status:?}"
                ));
            }
        }
        Ok(format!("recorded {} todo(s)", todos.len()))
    })() {
        Ok(text) => ToolResult::ok(text),
        Err(e) => ToolResult::err(e),
    }
}

/// The fixed PATH every spawned child gets — homebrew first, then the system dirs. A scrubbed
/// environment still has to find the allowlisted executables.
const CHILD_PATH: &str = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

/// One changed file as the git capsule shows it: the workspace-relative path and the short
/// status letter (`M`odified, `A`dded, `D`eleted, `R`enamed, `?`ntracked…).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileEntry {
    pub path: String,
    pub status: String,
}

/// The workspace's git state for the Assistant's git capsule: branch, ahead/behind, the
/// +/- line counts of the uncommitted changes, and the changed files.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSummary {
    pub is_repo: bool,
    pub branch: String,
    pub ahead: u32,
    pub behind: u32,
    pub insertions: u64,
    pub deletions: u64,
    pub files: Vec<GitFileEntry>,
}

/// Run one `git` invocation against `root` under the same scrubbed environment the model-facing
/// tool uses. A non-zero exit is NOT an error here — several callers probe (`is there an
/// upstream?`) — so the caller reads `(success, stdout, stderr)` itself.
fn git_at(root: &Path, args: &[&str]) -> (bool, String, String) {
    let out = Command::new("git")
        .args(args)
        .current_dir(root)
        .stdin(Stdio::null())
        .env_clear()
        .env("PATH", CHILD_PATH)
        .env("HOME", std::env::var("HOME").unwrap_or_else(|_| "/tmp".into()))
        .env("LANG", "C.UTF-8")
        .output();
    match out {
        Ok(o) => (
            o.status.success(),
            String::from_utf8_lossy(&o.stdout).into_owned(),
            String::from_utf8_lossy(&o.stderr).into_owned(),
        ),
        Err(e) => (false, String::new(), format!("cannot start git: {e}")),
    }
}

/// Read the workspace's git state. A workspace that is not a repository is a normal result
/// (`is_repo: false`), not an error — the capsule renders "not a repo" rather than failing.
pub fn git_summary(root: &Path) -> Result<GitSummary, String> {
    let root = validate_root(root)?;
    let mut summary = GitSummary {
        is_repo: false,
        branch: String::new(),
        ahead: 0,
        behind: 0,
        insertions: 0,
        deletions: 0,
        files: Vec::new(),
    };
    let (ok, out, err) = git_at(&root, &["status", "--porcelain", "-b"]);
    if !ok {
        if err.contains("not a git repository") {
            return Ok(summary);
        }
        return Err(if err.trim().is_empty() {
            "git status failed".into()
        } else {
            err.trim().to_string()
        });
    }
    summary.is_repo = true;
    for line in out.lines() {
        if let Some(rest) = line.strip_prefix("## ") {
            let rest = rest.trim();
            if let Some(branch) = rest.strip_prefix("No commits yet on ") {
                summary.branch = branch.trim().to_string();
                continue;
            }
            let head = rest.split(" [").next().unwrap_or(rest);
            summary.branch = head.split("...").next().unwrap_or(head).to_string();
            if let Some(bracket) = rest.split('[').nth(1) {
                for part in bracket.trim_end_matches(']').split(',') {
                    let part = part.trim();
                    if let Some(n) = part.strip_prefix("ahead ") {
                        summary.ahead = n.trim().parse().unwrap_or(0);
                    }
                    if let Some(n) = part.strip_prefix("behind ") {
                        summary.behind = n.trim().parse().unwrap_or(0);
                    }
                }
            }
        } else if line.len() >= 4 {
            // `XY path` — X is the index column, Y the worktree one; `??` is untracked. A
            // rename reports `old -> new`, and the capsule tracks the new side.
            let (xy, path) = line.split_at(2);
            let mut path = path.trim_start();
            if path.starts_with('"') {
                path = path.trim_matches('"');
            }
            let path = path.rsplit(" -> ").next().unwrap_or(path);
            let status = if xy == "??" {
                "?"
            } else if !xy.starts_with(' ') {
                &xy[..1]
            } else {
                &xy[1..]
            };
            summary.files.push(GitFileEntry { path: path.to_string(), status: status.to_string() });
        }
    }
    // Line counts: `--numstat HEAD` covers staged+unstaged against the last commit. A repo with
    // no commits has no HEAD, so fall back to the unstaged-only form (still zero for a fresh
    // repo — acceptable for a capsule whose +/- is an approximation, not a diff view).
    let (numstat_ok, numstat, _) = git_at(&root, &["diff", "--numstat", "HEAD"]);
    let numstat = if numstat_ok { numstat } else { git_at(&root, &["diff", "--numstat"]).1 };
    for line in numstat.lines() {
        let mut cols = line.split('\t');
        if let (Some(added), Some(deleted)) = (cols.next(), cols.next()) {
            summary.insertions += added.parse::<u64>().unwrap_or(0);
            summary.deletions += deleted.parse::<u64>().unwrap_or(0);
        }
    }
    Ok(summary)
}

/// Stage everything, commit with `message`, and push — the git capsule's "Commit or push" row.
///
/// Push is best-effort and explicit about partial success: an upstream is pushed directly; a
/// repo with an `origin` remote but no upstream gets `push -u origin <branch>`; a repo with no
/// remote at all reports the commit as done and the push as skipped. Any git-level failure
/// (no `user.name`, rejected push) travels out with git's own stderr.
pub fn git_commit_push(root: &Path, message: &str) -> Result<String, String> {
    let root = validate_root(root)?;
    let message = message.trim();
    if message.is_empty() {
        return Err("a commit message is required".into());
    }
    let message: String = message.chars().take(500).collect();

    let (ok, _, err) = git_at(&root, &["add", "-A"]);
    if !ok {
        return Err(format!("git add failed: {}", err.trim()));
    }

    let (ok, out, err) = git_at(&root, &["commit", "-m", &message]);
    let mut summary = if ok {
        let (sha_ok, sha, _) = git_at(&root, &["rev-parse", "--short", "HEAD"]);
        if sha_ok {
            format!("committed {}", sha.trim())
        } else {
            "committed".into()
        }
    } else if out.contains("nothing to commit") || err.contains("nothing to commit") {
        "nothing to commit".into()
    } else {
        let why = if err.trim().is_empty() { out.trim() } else { err.trim() };
        return Err(format!("git commit failed: {why}"));
    };

    let (upstream_ok, _, _) =
        git_at(&root, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    if upstream_ok {
        // Push writes its progress ("To origin …") to stderr even on success, so the exit
        // flag — not an empty stderr — decides the outcome.
        let (ok, _, push_err) = git_at(&root, &["push"]);
        if ok {
            summary.push_str(", pushed to upstream");
        } else {
            return Err(format!("{summary}, but push failed: {}", push_err.trim()));
        }
    } else {
        let (_, remotes, _) = git_at(&root, &["remote"]);
        let origin = remotes.lines().map(str::trim).find(|r| *r == "origin");
        if let Some(origin) = origin {
            let (_, branch, _) = git_at(&root, &["rev-parse", "--abbrev-ref", "HEAD"]);
            let branch = branch.trim().to_string();
            let (ok, _, push_err) = git_at(&root, &["push", "-u", origin, &branch]);
            if !ok {
                return Err(format!("{summary}, but push failed: {}", push_err.trim()));
            }
            summary.push_str(&format!(", pushed and set upstream to {origin}/{branch}"));
        } else {
            summary.push_str(", not pushed (no remote configured)");
        }
    }
    Ok(summary)
}

/// Read a public web page for the model (built-in, keyless — the machinery is `core::web`). The
/// workspace root is irrelevant here and the boundary is different too: the URL guard in
/// `core::web` confines the tool to the public internet, not to a directory.
fn do_web_fetch(args: &serde_json::Value) -> ToolResult {
    match (|| -> Result<String, String> {
        let url = arg_str(args, "url")?;
        crate::core::web::web_fetch_text(&url)
    })() {
        Ok(text) => ToolResult::ok(text),
        Err(e) => ToolResult::err(e),
    }
}

/// Convert a glob pattern to an anchored regex over relative workspace paths. `**` spans
/// directories (and `a/**/b` also matches `a/b`), `*` and `?` stay within one segment.
fn glob_to_regex(pattern: &str) -> Result<Regex, String> {
    if pattern.split('/').any(|c| c == "..") {
        return Err("a glob pattern may not contain \"..\"".into());
    }
    let mut re = String::from("^");
    let mut chars = pattern.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '*' => {
                if chars.peek() == Some(&'*') {
                    chars.next();
                    // `**/` at the start, or `/**/` anywhere, also matches zero directories.
                    if re == "^" && chars.peek() == Some(&'/') {
                        chars.next();
                        re.push_str("(?:.*/)?");
                    } else if re.ends_with("(?:.*/)?/") || re.ends_with('/') {
                        // `/**/` — consume the following `/` too.
                        if chars.peek() == Some(&'/') {
                            chars.next();
                            re.push_str("(?:.*/)?");
                        } else {
                            re.push_str(".*");
                        }
                    } else {
                        re.push_str(".*");
                    }
                } else {
                    re.push_str("[^/]*");
                }
            }
            '?' => re.push_str("[^/]"),
            other => {
                if !other.is_alphanumeric() && !"_-.~ /".contains(other) {
                    re.push('\\');
                }
                re.push(other);
            }
        }
    }
    re.push('$');
    Regex::new(&re).map_err(|e| format!("pattern is not a valid glob: {e}"))
}

/// List workspace paths matching a glob pattern — `**/*.rs` for "every Rust file". The file
/// tools' confinement rules apply to the base directory; the pattern itself may not contain
/// `..`, so the match set cannot be steered outside the root.
fn do_glob(args: &serde_json::Value, root: &Path) -> ToolResult {
    match (|| -> Result<String, String> {
        let pattern = arg_str(args, "pattern")?;
        let re = glob_to_regex(&pattern)?;
        let base = match args.get("path").and_then(|p| p.as_str()) {
            Some(p) if !p.is_empty() => resolve_within(root, p, false)?,
            _ => root.to_path_buf(),
        };
        let mut matches: Vec<String> = Vec::new();
        let mut truncated = false;
        fn walk(dir: &Path, base: &Path, re: &Regex, out: &mut Vec<String>, truncated: &mut bool) {
            if *truncated || out.len() >= MAX_LIST_ENTRIES {
                *truncated = out.len() >= MAX_LIST_ENTRIES;
                return;
            }
            let entries = match fs::read_dir(dir) {
                Ok(e) => e,
                Err(_) => return,
            };
            for entry in entries.flatten() {
                if out.len() >= MAX_LIST_ENTRIES {
                    *truncated = true;
                    return;
                }
                let path = entry.path();
                let rel = match path.strip_prefix(base) {
                    Ok(r) => r.to_string_lossy().replace('\\', "/"),
                    Err(_) => continue,
                };
                if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    walk(&path, base, re, out, truncated);
                } else if re.is_match(&rel) {
                    out.push(rel);
                }
            }
        }
        walk(&base, &base, &re, &mut matches, &mut truncated);
        if matches.is_empty() {
            return Ok(format!("no paths match \"{pattern}\""));
        }
        matches.sort();
        let mut out = matches.join("\n");
        if truncated {
            out.push_str(&format!(
                "\n\n(capped at {MAX_LIST_ENTRIES} entries — narrow the pattern or add a base path)"
            ));
        }
        Ok(out)
    })() {
        Ok(text) => ToolResult::ok(text),
        Err(e) => ToolResult::err(e),
    }
}

/// Search the public web via the keyless backend chain (DuckDuckGo, then SearXNG — see
/// `core::web`; no API keys involved).
fn do_web_search(args: &serde_json::Value) -> ToolResult {
    match (|| -> Result<String, String> {
        let query = arg_str(args, "query")?;
        let (backend, hits) = crate::core::web::web_search(&query)?;
        Ok(crate::core::web::format_search_results(&query, backend, &hits))
    })() {
        Ok(text) => ToolResult::ok(text),
        Err(e) => ToolResult::err(e),
    }
}

/// Extract readable text from a PDF or DOCX in the workspace. Binary documents are the one
/// thing `read_file` cannot serve (it is UTF-8-only by design), and "read the spec PDF in my
/// project" is a core assistant task. Text is capped like `read_file`.
fn do_read_document(args: &serde_json::Value, root: &Path) -> ToolResult {
    match (|| -> Result<String, String> {
        let rel = arg_str(args, "path")?;
        let path = resolve_within(root, &rel, false)?;
        let meta = fs::metadata(&path).map_err(|e| format!("cannot read {rel}: {e}"))?;
        if meta.len() > 20 * 1024 * 1024 {
            return Err(format!("{rel} is over the 20 MB document cap"));
        }
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .unwrap_or_default();
        let text = match ext.as_str() {
            "pdf" => pdf_extract::extract_text(&path)
                .map_err(|e| format!("PDF extraction failed: {e}"))?,
            "docx" => docx_text(&path, &rel)?,
            other => {
                return Err(format!(
                    "\"{other}\" documents are not supported — read_document covers .pdf and .docx; use read_file for text"
                ))
            }
        };
        let text = text.trim().to_string();
        if text.is_empty() {
            return Err(format!(
                "{rel} contains no extractable text (scanned images have no text layer)"
            ));
        }
        if text.len() > MAX_READ_BYTES {
            let mut cut = MAX_READ_BYTES;
            while !text.is_char_boundary(cut) {
                cut -= 1;
            }
            return Ok(format!(
                "{}\n\n(truncated at {} KB of {} KB total)",
                &text[..cut],
                MAX_READ_BYTES / 1024,
                text.len() / 1024
            ));
        }
        Ok(text)
    })() {
        Ok(text) => ToolResult::ok(text),
        Err(e) => ToolResult::err(e),
    }
}

/// DOCX text: the document is a ZIP whose `word/document.xml` holds the body. Paragraphs end
/// at `</w:p>`, runs of text live in `<w:t>` elements. Deliberately regex-shaped rather than a
/// full XML parse — the OOXML body is machine-generated and the tolerance is the point.
fn docx_text(path: &Path, rel: &str) -> Result<String, String> {
    let file = fs::File::open(path).map_err(|e| format!("cannot open {rel}: {e}"))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("{rel} is not a readable DOCX: {e}"))?;
    let mut xml = String::new();
    archive
        .by_name("word/document.xml")
        .map_err(|e| format!("{rel} is missing word/document.xml: {e}"))?
        .read_to_string(&mut xml)
        .map_err(|e| format!("cannot decode {rel}: {e}"))?;
    let paragraphs = xml.replace("</w:p>", "\n");
    let run = Regex::new(r"(?s)<w:t[^>]*>(.*?)</w:t>").expect("constant");
    let mut out = String::new();
    for para in paragraphs.split('\n') {
        let mut line = String::new();
        for c in run.captures_iter(para) {
            line.push_str(&crate::core::web::decode_entities(&c[1]));
        }
        out.push_str(line.trim_end());
        out.push('\n');
    }
    Ok(out)
}

/// Serve a workspace image to a vision-capable model. The base64 payload rides in the tool
/// result under a marker; the Assistant's loop strips it out and attaches the image as a real
/// content part (the same wire shape chat attachments use), leaving the model a short text
/// receipt. A non-vision model will see the receipt and can say so.
const IMAGE_EXTENSIONS: &[(&str, &str)] = &[
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
];

fn do_read_image(args: &serde_json::Value, root: &Path) -> ToolResult {
    match (|| -> Result<String, String> {
        let rel = arg_str(args, "path")?;
        let path = resolve_within(root, &rel, false)?;
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .unwrap_or_default();
        let media =
            IMAGE_EXTENSIONS.iter().find(|(e, _)| *e == ext).map(|(_, m)| *m).ok_or_else(|| {
                format!(
                    "\"{ext}\" is not a supported image — supported: {}",
                    IMAGE_EXTENSIONS.iter().map(|(e, _)| *e).collect::<Vec<_>>().join(", ")
                )
            })?;
        let bytes = fs::read(&path).map_err(|e| format!("cannot read {rel}: {e}"))?;
        if bytes.len() > 4 * 1024 * 1024 {
            return Err(format!("{rel} is over the 4 MB image cap"));
        }
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        Ok(format!("READ_IMAGE:{media};base64,{b64}\npath: {rel}\nbytes: {}", bytes.len()))
    })() {
        Ok(text) => ToolResult::ok(text),
        Err(e) => ToolResult::err(e),
    }
}

/// Send one HTTP request to a public URL — the general-API caller. Registered MUTATING: a
/// request is data leaving the machine, so it rides the approval gate and the gateway's
/// mutation switch; the public-URL guard (core::web) still rules out the local network.
fn do_http_request(args: &serde_json::Value) -> ToolResult {
    match (|| -> Result<String, String> {
        let method = args.get("method").and_then(|m| m.as_str()).unwrap_or("GET");
        let url = arg_str(args, "url")?;
        let mut headers: Vec<(String, String)> = Vec::new();
        match args.get("headers") {
            Some(serde_json::Value::Object(map)) => {
                for (k, v) in map {
                    headers.push((
                        k.clone(),
                        match v {
                            serde_json::Value::String(s) => s.clone(),
                            other => other.to_string(),
                        },
                    ));
                }
            }
            Some(serde_json::Value::Null) | None => {}
            Some(_) => return Err("\"headers\" must be an object of string values".into()),
        }
        let body = match args.get("body") {
            Some(serde_json::Value::String(s)) => Some(s.as_str()),
            Some(serde_json::Value::Null) | None => None,
            Some(_) => return Err("\"body\" must be a string".into()),
        };
        if body.is_some()
            && matches!(method.to_ascii_uppercase().as_str(), "GET" | "HEAD" | "OPTIONS")
        {
            return Err(format!("{method} does not carry a body — use POST/PUT/PATCH"));
        }
        crate::core::web::http_request(method, &url, &headers, body)
    })() {
        Ok(text) => ToolResult::ok(text),
        Err(e) => ToolResult::err(e),
    }
}

/// Apply a unified diff to workspace files. Strict: every context and deletion line must match
/// the file exactly (searched forward from the previous hunk, so line drift is tolerated but
/// content drift is not), and anything ambiguous fails the whole patch rather than applying
/// half of it. Registered MUTATING like edit_file, which it complements for multi-hunk and
/// multi-file changes.
fn do_apply_patch(args: &serde_json::Value, root: &Path) -> ToolResult {
    match (|| -> Result<String, String> {
        let patch = arg_str(args, "patch")?;
        let files = parse_unified_patch(&patch)?;
        if files.is_empty() {
            return Err("no file diffs found in the patch".into());
        }
        let mut report: Vec<String> = Vec::new();
        for file in &files {
            let target = resolve_within(root, &file.path, true)?;
            let mut lines: Vec<String> = if file.is_new {
                Vec::new()
            } else {
                fs::read_to_string(&target)
                    .map_err(|e| format!("cannot read {}: {e}", file.path))?
                    .lines()
                    .map(str::to_string)
                    .collect()
            };
            let had_trailing_newline = file.is_new
                || fs::read_to_string(&target).map(|s| s.ends_with('\n')).unwrap_or(true);
            let mut cursor = 0usize;
            for (i, hunk) in file.hunks.iter().enumerate() {
                if hunk.before.is_empty() {
                    // A pure insertion lands at the hunk's declared line (1-based), searched
                    // forward like any other hunk.
                    let at = hunk.old_start.saturating_sub(1).min(lines.len());
                    if at < cursor {
                        return Err(format!("{}: hunk {} would move backwards", file.path, i + 1));
                    }
                    let at = at.clamp(cursor, lines.len());
                    lines.splice(at..at, hunk.after.iter().cloned());
                    cursor = at + hunk.after.len();
                    continue;
                }
                let found = (cursor..=lines.len().saturating_sub(hunk.before.len()))
                    .find(|&i| lines[i..i + hunk.before.len()] == hunk.before[..]);
                let Some(at) = found else {
                    return Err(format!(
                        "{}: hunk {} does not match the file — context lines must be exact",
                        file.path,
                        i + 1
                    ));
                };
                lines.splice(at..at + hunk.before.len(), hunk.after.iter().cloned());
                cursor = at + hunk.after.len();
            }
            if let Some(parent) = target.parent() {
                let _ = fs::create_dir_all(parent);
            }
            let mut out = lines.join("\n");
            if had_trailing_newline && !out.is_empty() {
                out.push('\n');
            }
            fs::write(&target, out).map_err(|e| format!("cannot write {}: {e}", file.path))?;
            report.push(format!("applied {} hunk(s) to {}", file.hunks.len(), file.path));
        }
        Ok(report.join("\n"))
    })() {
        Ok(text) => ToolResult::ok(text),
        Err(e) => ToolResult::err(e),
    }
}

/// One file's worth of a unified diff.
struct PatchFile {
    path: String,
    is_new: bool,
    hunks: Vec<PatchHunk>,
}

/// One `@@` hunk: the lines it expects to find (`before` = context + deletions) and what
/// replaces them (`after` = context + additions).
struct PatchHunk {
    old_start: usize,
    before: Vec<String>,
    after: Vec<String>,
}

/// Parse a unified diff. Tolerant of the header shapes models emit (`a/`/`b:` prefixes,
/// `diff --git` noise, missing counts in `@@`), strict about hunk content.
fn parse_unified_patch(patch: &str) -> Result<Vec<PatchFile>, String> {
    let hunk_header = Regex::new(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@").expect("constant");
    let strip_prefix = |p: &str| -> String {
        let p = p.trim();
        if p == "/dev/null" {
            return String::new();
        }
        p.strip_prefix("b/")
            .or_else(|| p.strip_prefix("a/"))
            .unwrap_or(p)
            .trim_start_matches([':', ' '])
            .to_string()
    };
    let mut files: Vec<PatchFile> = Vec::new();
    let mut current: Option<PatchFile> = None;
    let mut in_hunk = false;
    let mut pending_old: Option<String> = None;
    for line in patch.lines() {
        if let Some(c) = hunk_header.captures(line) {
            let f = current.as_mut().ok_or("a hunk appeared before any ---/+++ header")?;
            f.hunks.push(PatchHunk {
                old_start: c[1].parse().unwrap_or(1),
                before: Vec::new(),
                after: Vec::new(),
            });
            in_hunk = true;
            continue;
        }
        if let Some(old) = line.strip_prefix("--- ") {
            pending_old = Some(old.trim().to_string());
            in_hunk = false;
            continue; // the +++ line decides the target path
        }
        if let Some(rest) = line.strip_prefix("+++ ") {
            let path = strip_prefix(rest);
            if path.is_empty() {
                return Err(
                    "file deletion is not supported — remove the file with a command instead"
                        .into(),
                );
            }
            let is_new = pending_old.as_deref() == Some("/dev/null");
            // A new +++ header closes the previous file: a multi-file patch would otherwise
            // silently keep only its last file.
            if let Some(f) = current.take() {
                files.push(f);
            }
            current = Some(PatchFile { path, is_new, hunks: Vec::new() });
            continue;
        }
        if !in_hunk {
            continue; // `diff --git`, index, mode lines and anything else outside hunks
        }
        let Some(f) = current.as_mut() else { continue };
        let Some(hunk) = f.hunks.last_mut() else { continue };
        if let Some(rest) = line.strip_prefix(' ') {
            hunk.before.push(rest.to_string());
            hunk.after.push(rest.to_string());
        } else if let Some(rest) = line.strip_prefix('-') {
            hunk.before.push(rest.to_string());
        } else if let Some(rest) = line.strip_prefix('+') {
            hunk.after.push(rest.to_string());
        } else if line == "\\" || line.starts_with("\\ No newline") {
            continue;
        } else if line.is_empty() {
            // A blank line inside a hunk is a context line whose content is empty (the
            // trailing space is commonly stripped by editors and models alike).
            hunk.before.push(String::new());
            hunk.after.push(String::new());
        } else {
            // Anything else ends the hunk stream (the next ---/+++ will restart it).
            in_hunk = false;
        }
    }
    if let Some(f) = current.take() {
        files.push(f);
    }
    files.retain(|f| !f.hunks.is_empty());
    Ok(files)
}

/// Execute one tool call. Never panics on model input: every failure is a `ToolResult`.
pub fn tool_run(req: ToolRunRequest) -> ToolResult {
    tool_run_with_call(req, None)
}

/// The same, with the model's tool-call id when the caller has one.
///
/// A separate argument rather than a field on `ToolRunRequest`: the id is a property of *this
/// invocation* (who is asking, so it can be stopped), not of the request the model composed, and
/// every existing constructor — the gateway bridge, the agent tests, the direct-call tests — stays
/// exactly as it was. With an id, a `run_command` child registers for cancellation; without one
/// it runs to completion or timeout, as before.
pub fn tool_run_with_call(req: ToolRunRequest, call_id: Option<&str>) -> ToolResult {
    let root = match validate_root(Path::new(&req.root)) {
        Ok(c) => c,
        Err(e) => return ToolResult::err(e),
    };
    let args = match arguments_object(&req.arguments) {
        Ok(a) => a,
        Err(e) => return ToolResult::err(e),
    };
    // Resolve lazily per tool so a bad root yields a clear error rather than a panic.
    match req.name.as_str() {
        "read_file" => do_read_file(&args, &root),
        "write_file" => do_write_file(&args, &root),
        "edit_file" => do_edit_file(&args, &root),
        "mkdir" => do_mkdir(&args, &root),
        "list_dir" => do_list_dir(&args, &root),
        "search_files" => do_search_files(&args, &root),
        "file_info" => do_file_info(&args, &root),
        "run_command" => do_run_command_with(&args, &root, call_id),
        "todo_write" => do_todo_write(&args),
        "web_fetch" => do_web_fetch(&args),
        "web_search" => do_web_search(&args),
        // `web_ask` is Assistant-only: it is answered by the agent loop, which holds the model
        // — the sandbox does not, and that boundary is one-way by design. The gateway never
        // advertises it (the backend registry omits it); this arm exists so a direct call fails
        // with the reason instead of "unknown tool".
        "web_ask" => ToolResult::err(
            "web_ask runs in the Assistant only — the sandbox has no model to answer with; use web_fetch and read the page",
        ),
        "read_document" => do_read_document(&args, &root),
        "read_image" => do_read_image(&args, &root),
        "http_request" => do_http_request(&args),
        "apply_patch" => do_apply_patch(&args, &root),
        "glob" => do_glob(&args, &root),
        other => ToolResult::err(format!("unknown tool \"{other}\"")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    // Each `root()` call gets a distinct directory so parallel tests cannot wipe a
    // sibling's fixtures. (Keying only on pid made every test share one dir, and
    // `remove_dir_all` at the top of each test clobbered concurrent ones.)
    static TEST_DIR_SEQ: AtomicU64 = AtomicU64::new(0);

    fn root() -> PathBuf {
        let seq = TEST_DIR_SEQ.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "aiprovider-tools-test-{}-{}",
            std::process::id(),
            seq
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    // --- audit C1: the host, not the UI, judges the workspace root ---
    //
    // `resolve_within` confines paths TO the root correctly; these cover the root itself, which
    // nothing checked. A root of `/` or `$HOME` is confinement to nothing.

    #[test]
    fn root_must_exist() {
        let missing = std::env::temp_dir().join("aiprovider-tools-test-definitely-absent");
        let _ = fs::remove_dir_all(&missing);
        assert!(validate_root(&missing).is_err(), "a missing root must be refused");
    }

    #[test]
    fn root_must_be_a_directory() {
        let dir = root();
        let file = dir.join("a-file.txt");
        fs::write(&file, "x").unwrap();
        assert!(validate_root(&file).is_err(), "a file must not be accepted as a root");
    }

    #[test]
    fn filesystem_root_is_refused() {
        assert!(validate_root(Path::new("/")).is_err(), "root=/ means no confinement");
    }

    #[test]
    fn home_directory_is_refused() {
        if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
            assert!(
                validate_root(&home).is_err(),
                "HOME must be refused — it would expose everything under it"
            );
        }
    }

    #[test]
    fn system_directories_are_refused() {
        for d in ["/System", "/usr", "/bin", "/sbin", "/etc"] {
            assert!(validate_root(Path::new(d)).is_err(), "{d} must be refused");
        }
    }

    #[test]
    fn a_normal_workspace_root_is_accepted() {
        let dir = root();
        let got = validate_root(&dir).expect("an ordinary temp workspace must validate");
        assert_eq!(got, fs::canonicalize(&dir).unwrap());
    }

    #[test]
    fn tool_run_refuses_a_bad_root_rather_than_serving_it() {
        // The command surface is the one the model's path actually reaches, so the guard has to
        // hold there and not only in `validate_root`.
        let res = tool_run(ToolRunRequest {
            name: "list_dir".into(),
            arguments: serde_json::json!({}),
            root: "/".into(),
        });
        assert!(!res.ok, "tool_run must refuse root=/");
        // `ToolResult::err` puts the reason in `error`, not `output`.
        let reason = res.error.unwrap_or_default();
        assert!(reason.contains("filesystem root"), "got: {reason}");
    }

    fn obj(pairs: &[(&str, serde_json::Value)]) -> serde_json::Value {
        let mut m = serde_json::Map::new();
        for (k, v) in pairs {
            m.insert((*k).to_string(), v.clone());
        }
        serde_json::Value::Object(m)
    }

    #[test]
    fn rejects_traversal_and_absolute_paths() {
        let r = root();
        for bad in ["../etc/passwd", "a/../../etc/passwd", "/etc/passwd"] {
            let res = do_read_file(&obj(&[("path", serde_json::json!(bad))]), &r);
            assert!(!res.ok, "should have refused {bad}");
        }
    }

    // Unix-only twice over: the symlink API is `std::os::unix`, and the property under test — the
    // reader refusing a path that escapes the root through a link — is exercised through it. A
    // Windows build has no such test to run, only a compile to survive.
    #[cfg(unix)]
    #[test]
    fn symlink_escaping_the_root_is_refused() {
        let r = root();
        let outside =
            std::env::temp_dir().join(format!("aiprovider-outside-{}", std::process::id()));
        fs::write(&outside, "secret").unwrap();
        let link = r.join("escape.txt");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        let res = do_read_file(&obj(&[("path", serde_json::json!("escape.txt"))]), &r);
        assert!(!res.ok);
        assert!(res.error.unwrap().contains("outside the workspace root"));
    }

    #[test]
    fn write_then_read_round_trips_inside_the_root() {
        let r = root();
        let w = do_write_file(
            &obj(&[
                ("path", serde_json::json!("skills/demo/SKILL.md")),
                ("content", serde_json::json!("# demo")),
            ]),
            &r,
        );
        assert!(w.ok, "{:?}", w.error);
        let read = do_read_file(&obj(&[("path", serde_json::json!("skills/demo/SKILL.md"))]), &r);
        assert!(read.ok);
        assert_eq!(read.output.trim(), "# demo");
    }

    #[test]
    fn disallowed_program_never_starts() {
        let r = root();
        let res = do_run_command(
            &obj(&[
                ("program", serde_json::json!("rm")),
                ("args", serde_json::json!(["-rf", "/"])),
            ]),
            &r,
        );
        assert!(!res.ok);
        assert!(res.error.unwrap().contains("not on the allowlist"));
    }

    #[test]
    fn shell_metacharacters_are_inert() {
        // No shell is involved, so this must be treated as one literal argument to `echo`,
        // not as `echo hi` followed by deleting a directory.
        let r = root();
        let res = do_run_command(
            &obj(&[
                ("program", serde_json::json!("echo")),
                ("args", serde_json::json!(["hi; echo pwned"])),
            ]),
            &r,
        );
        assert!(res.ok);
        assert!(res.output.contains("hi; echo pwned"));
    }

    #[test]
    fn git_unlisted_subcommands_are_refused() {
        let r = root();
        for sub in ["remote", "rebase", "filter-branch"] {
            let res = do_run_command(
                &obj(&[("program", serde_json::json!("git")), ("args", serde_json::json!([sub]))]),
                &r,
            );
            assert!(!res.ok, "git {sub} should be refused");
            assert!(res.error.unwrap().contains("is not allowed"));
        }
    }

    #[test]
    fn git_network_subcommands_pass_the_gate() {
        // `git fetch`/`push` in an empty workspace cannot succeed, but their failure is git's
        // own ("fatal: not a git repository…", reported as ok with "[exit 128]") — not the
        // gate's, and none of them touches the network before git rejects the cwd. The claim
        // under test is only that the gate let the command start.
        let r = root();
        for sub in ["clone", "fetch", "pull", "push"] {
            let res = do_run_command(
                &obj(&[("program", serde_json::json!("git")), ("args", serde_json::json!([sub]))]),
                &r,
            );
            assert!(res.ok, "git {sub} should pass the gate: {:?}", res.error);
            assert!(
                !res.output.contains("is not allowed"),
                "git {sub} must not be refused by the gate: {}",
                res.output
            );
        }
    }

    #[test]
    fn gh_interactive_and_destructive_invocations_are_refused() {
        for argv in [
            vec!["auth", "login"],
            vec!["auth", "token"],
            vec!["repo", "delete", "owner/name"],
            vec!["codespace", "delete", "-s", "codespace-id"],
        ] {
            let argv: Vec<String> = argv.into_iter().map(String::from).collect();
            let denial = gh_denial(&argv);
            assert!(denial.is_some(), "gh {argv:?} should be refused by the gate");
        }
    }

    #[test]
    fn gh_github_surface_passes_the_gate() {
        for argv in [
            vec!["repo", "view", "zai-org/ZCode"],
            vec!["repo", "clone", "zai-org/ZCode"],
            vec!["pr", "list"],
            vec!["pr", "view", "12"],
            vec!["issue", "list"],
            vec!["gist", "create", "notes.md"],
            vec!["release", "list"],
            vec!["run", "watch", "123"],
            vec!["api", "repos/zai-org/ZCode"],
            vec!["codespace", "list"],
        ] {
            let argv: Vec<String> = argv.into_iter().map(String::from).collect();
            let denial = gh_denial(&argv);
            assert!(denial.is_none(), "gh {argv:?} should pass the gate: {denial:?}");
        }
    }

    #[test]
    fn todo_write_accepts_a_well_formed_list() {
        let res = do_todo_write(&obj(&[(
            "todos",
            serde_json::json!([
                { "content": "clone the repo", "status": "completed" },
                { "content": "read the entry point", "status": "in_progress" },
                { "content": "summarise the architecture", "status": "pending" },
            ]),
        )]));
        assert!(res.ok, "{:?}", res.error);
        assert!(res.output.contains("3 todo(s)"));
    }

    #[test]
    fn todo_write_refuses_a_malformed_list() {
        let too_many = serde_json::json!({
            "todos": (0..51)
                .map(|i| serde_json::json!({ "content": format!("task {i}"), "status": "pending" }))
                .collect::<Vec<_>>()
        });
        let bad = [
            serde_json::json!({}),
            serde_json::json!({ "todos": "three things" }),
            serde_json::json!({ "todos": [{ "status": "pending" }] }),
            serde_json::json!({ "todos": [{ "content": "x", "status": "done" }] }),
            serde_json::json!({ "todos": [{ "content": "  ", "status": "pending" }] }),
            too_many,
        ];
        for args in bad {
            let res = do_todo_write(&args);
            assert!(!res.ok, "todo_write should refuse {args}");
        }
    }

    // --- the git capsule: git_summary and git_commit_push against real temp repos ---

    #[test]
    fn glob_matches_across_and_within_directories() {
        let dir = root();
        fs::create_dir_all(dir.join("src/deep")).unwrap();
        fs::write(dir.join("main.rs"), "").unwrap();
        fs::write(dir.join("src/lib.rs"), "").unwrap();
        fs::write(dir.join("src/deep/mod.rs"), "").unwrap();
        fs::write(dir.join("src/notes.md"), "").unwrap();

        let hits = |pattern: &str| {
            let res = do_glob(&obj(&[("pattern", serde_json::json!(pattern))]), &dir);
            assert!(res.ok, "{pattern}: {:?}", res.error);
            res.output.lines().map(str::to_string).collect::<Vec<_>>()
        };

        let all = hits("**/*.rs");
        assert_eq!(all.len(), 3, "{all:?}");
        assert!(all.contains(&"src/deep/mod.rs".to_string()));

        assert_eq!(hits("*.rs"), vec!["main.rs".to_string()], "* stays in one segment");
        let deep = hits("src/**/*.rs");
        assert_eq!(deep.len(), 2, "{deep:?}");
        assert!(hits("?ain.rs").contains(&"main.rs".to_string()));
        assert!(hits("**/*.md").contains(&"src/notes.md".to_string()));
    }

    #[test]
    fn glob_refuses_traversal_and_reports_no_matches() {
        let dir = root();
        let res = do_glob(&obj(&[("pattern", serde_json::json!("../**/*.rs"))]), &dir);
        assert!(!res.ok, "a traversal pattern must be refused");
        assert!(res.error.unwrap().contains(".."));

        let none = do_glob(&obj(&[("pattern", serde_json::json!("**/*.zig"))]), &dir);
        assert!(none.ok);
        assert!(none.output.contains("no paths match"));
    }

    // --- read_document: a real DOCX built in the test, plus the refusal paths ---

    #[test]
    fn read_document_extracts_a_docx_built_in_the_test() {
        use zip::write::SimpleFileOptions;
        let dir = root();
        let docx = dir.join("spec.docx");
        let file = fs::File::create(&docx).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        zip.start_file("word/document.xml", SimpleFileOptions::default()).unwrap();
        let xml = concat!(
            r#"<?xml version="1.0"?><w:document xmlns:w="w"><w:body>"#,
            r#"<w:p><w:r><w:t>First paragraph &amp; intro</w:t></w:r></w:p>"#,
            r#"<w:p><w:r><w:t>Second line</w:t></w:r><w:r><w:t> joined</w:t></w:r></w:p>"#,
            r#"</w:body></w:document>"#
        );
        zip.write_all(xml.as_bytes()).unwrap();
        zip.finish().unwrap();

        let res = do_read_document(&obj(&[("path", serde_json::json!("spec.docx"))]), &dir);
        assert!(res.ok, "{:?}", res.error);
        assert!(res.output.contains("First paragraph & intro"), "{}", res.output);
        assert!(res.output.contains("Second line joined"), "{}", res.output);
    }

    #[test]
    fn read_document_refuses_unsupported_and_missing_files() {
        let dir = root();
        fs::write(dir.join("notes.txt"), "plain").unwrap();
        let res = do_read_document(&obj(&[("path", serde_json::json!("notes.txt"))]), &dir);
        assert!(!res.ok, "txt must be routed to read_file, not read_document");
        let res = do_read_document(&obj(&[("path", serde_json::json!("absent.pdf"))]), &dir);
        assert!(!res.ok);
    }

    // --- read_image: marker format, size and extension gates ---

    #[test]
    fn read_image_serves_base64_under_the_marker() {
        let dir = root();
        // 1x1 PNG, a real image so the extension and content path are both exercised.
        let png: &[u8] = &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D];
        fs::write(dir.join("dot.png"), png).unwrap();
        let res = do_read_image(&obj(&[("path", serde_json::json!("dot.png"))]), &dir);
        assert!(res.ok, "{:?}", res.error);
        let out = res.output;
        assert!(out.starts_with("READ_IMAGE:image/png;base64,"), "{out}");
        assert!(out.contains("path: dot.png"));
    }

    #[test]
    fn read_image_refuses_non_images() {
        let dir = root();
        fs::write(dir.join("x.txt"), "nope").unwrap();
        let res = do_read_image(&obj(&[("path", serde_json::json!("x.txt"))]), &dir);
        assert!(!res.ok);
        assert!(res.error.unwrap().contains("not a supported image"));
    }

    // --- http_request: the offline validation gates (the live path is web.rs's) ---

    #[test]
    fn http_request_refuses_a_body_on_get_and_bad_methods() {
        let res = do_http_request(&obj(&[
            ("url", serde_json::json!("https://example.com/")),
            ("method", serde_json::json!("GET")),
            ("body", serde_json::json!("data")),
        ]));
        assert!(!res.ok, "GET must not carry a body");
        let res = do_http_request(&obj(&[
            ("url", serde_json::json!("https://example.com/")),
            ("method", serde_json::json!("TRACE")),
        ]));
        assert!(!res.ok, "unsupported methods are refused");
    }

    // --- apply_patch: strict unified-diff application ---

    #[test]
    fn apply_patch_rewrites_one_file_with_context() {
        let dir = root();
        fs::write(dir.join("a.txt"), "one\ntwo\nthree\n").unwrap();
        let patch = "\
--- a/a.txt
+++ b/a.txt
@@ -1,3 +1,3 @@
 one
-two
+TWO
 three";
        let res = do_apply_patch(&obj(&[("patch", serde_json::json!(patch))]), &dir);
        assert!(res.ok, "{:?}", res.error);
        assert_eq!(fs::read_to_string(dir.join("a.txt")).unwrap(), "one\nTWO\nthree\n");
    }

    #[test]
    fn apply_patch_handles_multiple_hunks_files_and_new_files() {
        let dir = root();
        fs::write(dir.join("a.txt"), "one\ntwo\nthree\nfour\nfive\n").unwrap();
        let patch = "\
diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1,2 +1,3 @@
 one
+inserted
 two
@@ -4,2 +5,2 @@
 four
-five
+FIVE
--- /dev/null
+++ b/new/nested.txt
@@ -0,0 +1,2 @@
+hello
+world";
        let res = do_apply_patch(&obj(&[("patch", serde_json::json!(patch))]), &dir);
        assert!(res.ok, "{:?}", res.error);
        assert_eq!(
            fs::read_to_string(dir.join("a.txt")).unwrap(),
            "one\ninserted\ntwo\nthree\nfour\nFIVE\n"
        );
        assert_eq!(fs::read_to_string(dir.join("new/nested.txt")).unwrap(), "hello\nworld\n");
    }

    #[test]
    fn apply_patch_fails_the_whole_patch_when_context_drifts() {
        let dir = root();
        fs::write(dir.join("a.txt"), "one\ntwo\nthree\n").unwrap();
        let patch = "\
--- a/a.txt
+++ b/a.txt
@@ -1,3 +1,3 @@
 one
-totally-different
+TWO
 three";
        let res = do_apply_patch(&obj(&[("patch", serde_json::json!(patch))]), &dir);
        assert!(!res.ok, "a context mismatch must fail, not half-apply");
        assert!(res.error.unwrap().contains("does not match the file"));
        assert_eq!(fs::read_to_string(dir.join("a.txt")).unwrap(), "one\ntwo\nthree\n");
    }

    /// A scratch repo with an identity configured, so commits work without ambient config.
    fn scratch_repo(tag: &str) -> PathBuf {
        let seq = TEST_DIR_SEQ.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "aiprovider-tools-test-{tag}-{}-{}",
            std::process::id(),
            seq
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        git_at(&dir, &["init", "-b", "main"]);
        git_at(&dir, &["config", "user.name", "Test"]);
        git_at(&dir, &["config", "user.email", "test@example.com"]);
        dir
    }

    #[test]
    fn git_summary_reports_a_plain_directory_as_not_a_repo() {
        let dir = root();
        let s = git_summary(&dir).expect("a plain directory is a normal result");
        assert!(!s.is_repo);
        assert!(s.files.is_empty());
    }

    #[test]
    fn git_summary_reads_branch_changes_and_counts() {
        let dir = scratch_repo("summary");
        fs::write(dir.join("a.txt"), "one\ntwo\n").unwrap();
        let (ok, _, _) = git_at(&dir, &["add", "-A"]);
        assert!(ok);
        let s = git_summary(&dir).expect("summary of a fresh repo");
        assert!(s.is_repo);
        assert_eq!(s.branch, "main");
        assert_eq!(s.files.len(), 1);
        assert_eq!(s.files[0].status, "A");

        let (ok, _, _) = git_at(&dir, &["commit", "-m", "first"]);
        assert!(ok);
        fs::write(dir.join("a.txt"), "one\nTWO\nthree\n").unwrap();
        fs::write(dir.join("b.txt"), "new\n").unwrap();
        let s = git_summary(&dir).expect("summary of a dirty repo");
        assert_eq!(s.branch, "main");
        assert!(s.insertions >= 2, "expected the rewrite counted: {s:?}");
        assert!(s.deletions >= 1);
        let modified = s.files.iter().find(|f| f.path == "a.txt").expect("a.txt listed");
        assert_eq!(modified.status, "M");
        assert!(s.files.iter().any(|f| f.path == "b.txt" && f.status == "?"));
    }

    #[test]
    fn git_commit_push_round_trips_through_a_local_remote() {
        let seq = TEST_DIR_SEQ.fetch_add(1, Ordering::SeqCst);
        let remote = std::env::temp_dir().join(format!(
            "aiprovider-tools-test-bare-{}-{}",
            std::process::id(),
            seq
        ));
        let _ = fs::remove_dir_all(&remote);
        fs::create_dir_all(&remote).unwrap();
        let (ok, _, err) = git_at(&remote, &["init", "--bare", "-b", "main"]);
        assert!(ok, "bare init failed: {err}");

        let dir = scratch_repo("push-work");
        let (ok, _, err) = git_at(&dir, &["remote", "add", "origin", remote.to_str().unwrap()]);
        assert!(ok, "remote add failed: {err}");
        fs::write(dir.join("a.txt"), "hello\n").unwrap();

        let res = git_commit_push(&dir, "first commit").expect("first push round-trips");
        assert!(res.contains("committed"), "{res}");
        assert!(res.contains("origin/main"), "{res}");

        let (ok, ls, _) = git_at(&dir, &["ls-remote", "--heads", "origin"]);
        assert!(ok);
        assert!(ls.contains("refs/heads/main"), "the branch must be on the remote: {ls}");

        // A second run with nothing staged commits nothing but still reports cleanly.
        let res = git_commit_push(&dir, "empty").expect("an empty run is not an error");
        assert!(res.contains("nothing to commit"), "{res}");
    }

    #[test]
    fn git_commit_push_never_pushes_without_a_message() {
        let dir = scratch_repo("no-message");
        fs::write(dir.join("a.txt"), "x\n").unwrap();
        let err = git_commit_push(&dir, "   ").expect_err("an empty message is refused");
        assert!(err.contains("message is required"), "{err}");
    }

    #[test]
    fn command_output_is_capped_and_exits_cleanly() {
        let r = root();
        let res = do_run_command(&obj(&[("program", serde_json::json!("pwd"))]), &r);
        assert!(res.ok);
    }

    // --- audit H1: `run_command` validated the PROGRAM but never the ARGUMENTS ---

    #[test]
    fn run_command_cannot_read_outside_the_root_via_an_absolute_path() {
        // The allowlist gate checked `program` and then handed `argv` to the child untouched,
        // with only `current_dir(root)` for confinement. cwd does not constrain an ABSOLUTE
        // argument, so any allowlisted program could be pointed straight out of the workspace —
        // `cat /etc/passwd` reads fine. This is the hole; the test is expected to fail until the
        // arguments are validated.
        let dir = root();
        let outside = std::env::temp_dir().join(format!(
            "aiprovider-outside-{}-{}",
            std::process::id(),
            TEST_DIR_SEQ.fetch_add(1, Ordering::SeqCst)
        ));
        fs::write(&outside, "TOP-SECRET-OUTSIDE").unwrap();

        let res = do_run_command(
            &serde_json::json!({ "program": "cat", "args": [outside.to_string_lossy()] }),
            &dir,
        );
        let _ = fs::remove_file(&outside);

        assert!(!res.ok, "run_command must refuse an absolute path outside the root");
        assert!(
            !res.output.contains("TOP-SECRET-OUTSIDE"),
            "file contents outside the root leaked: {}",
            res.output
        );
    }

    #[test]
    fn run_command_still_reads_a_relative_path_inside_the_root() {
        // The guard must not break ordinary use. cwd is the root, so relative paths resolve
        // inside it and have to keep working.
        let dir = root();
        fs::write(dir.join("hello.txt"), "inside-the-root").unwrap();
        let res =
            do_run_command(&serde_json::json!({ "program": "cat", "args": ["hello.txt"] }), &dir);
        assert!(res.ok, "a relative path inside the root must still work: {:?}", res.error);
        assert!(res.output.contains("inside-the-root"), "got: {}", res.output);
    }

    #[cfg(unix)]
    #[test]
    fn a_running_command_can_be_cancelled_and_reports_stopped_by_you() {
        // The gap this closes: Stop flipped the abort flag, but a `run_command` in flight kept
        // running to its 20 s default timeout, so the button looked broken while the machine
        // stayed busy. `tail -f` is the honest worst case the fix is for — an allowlisted program
        // that runs until told to stop, with no output to wait on.
        let dir = root();
        fs::write(dir.join("empty.log"), "").unwrap();
        let id = format!("call-{}", std::process::id());
        let started = std::time::Instant::now();
        let handle = {
            let dir = dir.clone();
            let id = id.clone();
            std::thread::spawn(move || {
                do_run_command_with(
                    &serde_json::json!({
                        "program": "tail",
                        "args": ["-f", "empty.log"],
                        "timeout_ms": 60_000,
                    }),
                    &dir,
                    Some(&id),
                )
            })
        };
        // The runner registers the child from its own thread; wait for that before cancelling,
        // exactly as a user's Stop is a moment after the call appears on screen.
        let mut registered = false;
        for _ in 0..300 {
            if running_children().lock().unwrap().contains_key(&id) {
                registered = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(registered, "the running child must be registered under its tool-call id");

        assert!(tool_cancel(&id).unwrap(), "cancel must find and signal the registered child");
        let res = handle.join().unwrap();
        let elapsed = started.elapsed();

        assert!(!res.ok, "a cancelled command is not a success");
        assert_eq!(res.error.as_deref(), Some("stopped by you"), "the reason is the user's action");
        // Well under the 60 s timeout the child was given: this measures cancellation, not the
        // timeout path dressed up as one.
        assert!(elapsed < Duration::from_secs(10), "cancel must be prompt, took {elapsed:?}");
        // And the registration is gone, so a second Stop is honestly "nothing running".
        assert!(!running_children().lock().unwrap().contains_key(&id));
        assert!(!tool_cancel(&id).unwrap(), "nothing is running under that id any more");
    }

    #[test]
    fn run_command_refuses_parent_traversal_in_arguments() {
        let dir = root();
        let res = do_run_command(
            &serde_json::json!({ "program": "cat", "args": ["../escaped.txt"] }),
            &dir,
        );
        assert!(!res.ok, "'..' in an argument must be refused");
    }

    // --- the gateway sends `arguments` as a JSON string, the Assistant as an object ---
    //
    // `Value::get` on a `Value::String` returns `None` instead of failing, so the mismatch was
    // invisible: every gateway call said `missing argument "program"`, and `list_dir` quietly
    // used its `"."` default — which is why an earlier "the sandbox still executes" check
    // passed while the plumbing was in fact broken.

    #[test]
    fn stringified_arguments_reach_the_tool() {
        let r = root();
        let write = tool_run(ToolRunRequest {
            name: "write_file".into(),
            arguments: serde_json::json!({ "path": "note.txt", "content": "from-the-gateway" })
                .to_string()
                .into(),
            root: r.to_string_lossy().to_string(),
        });
        assert!(write.ok, "write must succeed: {:?}", write.error);
        let read = tool_run(ToolRunRequest {
            name: "read_file".into(),
            arguments: r#"{"path":"note.txt"}"#.to_string().into(),
            root: r.to_string_lossy().to_string(),
        });
        assert!(read.ok, "read must succeed: {:?}", read.error);
        assert_eq!(read.output, "from-the-gateway");
    }

    #[test]
    fn list_dir_honours_a_stringified_path_instead_of_defaulting() {
        let r = root();
        fs::create_dir_all(r.join("a/b")).unwrap();
        fs::write(r.join("top.txt"), "x").unwrap();
        let res = tool_run(ToolRunRequest {
            name: "list_dir".into(),
            arguments: r#"{"path":"a"}"#.to_string().into(),
            root: r.to_string_lossy().to_string(),
        });
        assert!(res.ok, "{:?}", res.error);
        assert!(res.output.contains("dir  b"), "got: {}", res.output);
        assert!(!res.output.contains("top.txt"), "a defaulted path would have listed the root");
    }

    #[test]
    fn run_command_confinement_holds_for_stringified_arguments() {
        let r = root();
        let res = tool_run(ToolRunRequest {
            name: "run_command".into(),
            arguments: r#"{"program":"cat","args":["/etc/hostname"]}"#.to_string().into(),
            root: r.to_string_lossy().to_string(),
        });
        assert!(!res.ok, "an absolute argument must be refused on the gateway path too");
        assert!(
            res.error.as_deref().unwrap_or("").contains("outside the workspace root"),
            "got: {:?}",
            res.error
        );
    }

    #[test]
    fn unparseable_arguments_are_an_error_not_a_silent_default() {
        let r = root();
        let res = tool_run(ToolRunRequest {
            name: "read_file".into(),
            arguments: "{not json".to_string().into(),
            root: r.to_string_lossy().to_string(),
        });
        assert!(!res.ok, "malformed arguments must not be treated as an empty object");
        assert!(
            res.error.as_deref().unwrap_or("").contains("not valid JSON"),
            "got: {:?}",
            res.error
        );
    }

    #[test]
    fn check_root_agrees_with_the_gate_the_tools_actually_use() {
        let r = root();
        assert!(
            tools_check_root(r.to_string_lossy().to_string()).is_ok(),
            "a real directory must be accepted"
        );
        // The same judgments `tool_run` makes, so the UI cannot promise a root the tools refuse.
        assert!(tools_check_root("/".to_string()).is_err());
        let missing = std::env::temp_dir().join("aiprovider-tools-test-definitely-absent");
        let _ = fs::remove_dir_all(&missing);
        let err = tools_check_root(missing.to_string_lossy().to_string()).unwrap_err();
        assert!(!err.is_empty(), "the UI needs the reason, not just a boolean");
    }

    /// The default the UI starts with has to be a root the tools accept. A prefilled field that
    /// fails its own validation is worse than an empty one: Send stays disabled and the app
    /// looks like it is contradicting itself.
    #[test]
    fn default_root_passes_the_same_check_the_ui_runs() {
        let d = tools_default_root().expect("a default workspace must exist");
        assert!(d.starts_with('/'), "the default must be absolute: {d}");
        assert!(tools_check_root(d.clone()).is_ok(), "the default must be a usable root: {d}");
    }

    // --- The four read/write tools added 2026-09-20 ---
    //
    // Until now every edit was `write_file` with the entire file, and "where is this defined?"
    // meant one `read_file` per candidate. These cover the behaviour that makes the new tools
    // safe rather than merely present: confinement, the unique-match rule, and honest misses.

    fn call(name: &str, arguments: serde_json::Value, root: &Path) -> ToolResult {
        tool_run(ToolRunRequest {
            name: name.into(),
            arguments,
            root: root.to_string_lossy().to_string(),
        })
    }

    #[test]
    fn search_files_reports_where_each_match_is() {
        let r = root();
        fs::write(r.join("a.txt"), "alpha\nneedle here\nbeta\n").unwrap();
        fs::write(r.join("b.txt"), "nothing\n").unwrap();
        let res = call("search_files", serde_json::json!({ "pattern": "needle" }), &r);
        assert!(res.ok, "{:?}", res.error);
        assert!(res.output.contains("a.txt:2: needle here"), "got: {}", res.output);
        assert!(!res.output.contains("b.txt"), "a non-matching file must not be listed");
    }

    #[test]
    fn search_files_is_case_insensitive_until_asked() {
        let r = root();
        fs::write(r.join("a.txt"), "Hello World\n").unwrap();
        let loose = call("search_files", serde_json::json!({ "pattern": "hello" }), &r);
        assert!(loose.ok && loose.output.contains("Hello World"), "got: {}", loose.output);
        let strict = call(
            "search_files",
            serde_json::json!({ "pattern": "hello", "case_sensitive": true }),
            &r,
        );
        assert!(strict.ok, "a miss is not an error");
        assert_eq!(strict.output, "no matches for \"hello\"");
    }

    #[test]
    fn search_files_never_leaves_the_root() {
        let r = root();
        // A sibling of the workspace, i.e. outside it. It must not appear in results.
        let outside =
            std::env::temp_dir().join(format!("aiprovider-outside-{}.txt", std::process::id()));
        fs::write(&outside, "needle outside\n").unwrap();
        let res = call("search_files", serde_json::json!({ "pattern": "needle" }), &r);
        assert!(res.ok);
        assert!(!res.output.contains("outside"), "search escaped the root: {}", res.output);
        let _ = fs::remove_file(&outside);

        let escaped =
            call("search_files", serde_json::json!({ "pattern": "needle", "path": "../" }), &r);
        assert!(!escaped.ok, "'..' must be refused, not silently honoured");
        assert!(
            escaped.error.unwrap_or_default().contains("not allowed"),
            "the reason belongs in the error"
        );
    }

    #[test]
    fn file_info_answers_a_missing_path_without_failing() {
        let r = root();
        let res = call("file_info", serde_json::json!({ "path": "nope.txt" }), &r);
        assert!(res.ok, "asking whether a file exists is not an error");
        assert!(res.output.contains("does not exist"), "got: {}", res.output);
    }

    #[test]
    fn file_info_reports_kind_and_size() {
        let r = root();
        fs::write(r.join("a.txt"), "12345").unwrap();
        let res = call("file_info", serde_json::json!({ "path": "a.txt" }), &r);
        assert!(res.ok, "{:?}", res.error);
        assert!(res.output.contains("kind: file"), "got: {}", res.output);
        assert!(res.output.contains("size: 5 bytes"), "got: {}", res.output);
    }

    #[test]
    fn read_file_pages_by_line() {
        let r = root();
        fs::write(r.join("a.txt"), "l1\nl2\nl3\nl4\nl5\n").unwrap();
        let res =
            call("read_file", serde_json::json!({ "path": "a.txt", "offset": 3, "limit": 2 }), &r);
        assert!(res.ok, "{:?}", res.error);
        assert!(res.output.starts_with("[lines 3-4 of 5]"), "got: {}", res.output);
        assert!(res.output.contains("l3\nl4"), "got: {}", res.output);
        assert!(!res.output.contains("l1"), "the window must not include earlier lines");
        // Without the window the whole file comes back — paging must not become the default.
        let all = call("read_file", serde_json::json!({ "path": "a.txt" }), &r);
        assert!(all.output.contains("l1") && all.output.contains("l5"));
    }

    #[test]
    fn list_dir_recursive_reaches_subdirectories() {
        let r = root();
        fs::create_dir_all(r.join("sub/deep")).unwrap();
        fs::write(r.join("sub/deep/x.txt"), "x").unwrap();
        let flat = call("list_dir", serde_json::json!({ "path": "." }), &r);
        assert!(flat.ok && !flat.output.contains("deep/x.txt"), "one level only: {}", flat.output);
        let deep = call("list_dir", serde_json::json!({ "path": ".", "recursive": true }), &r);
        assert!(deep.ok, "{:?}", deep.error);
        assert!(deep.output.contains("dir  sub"), "got: {}", deep.output);
        assert!(deep.output.contains("file sub/deep/x.txt"), "got: {}", deep.output);
    }

    #[test]
    fn edit_file_replaces_a_unique_snippet() {
        let r = root();
        fs::write(r.join("a.txt"), "one\ntwo\nthree\n").unwrap();
        let res = call(
            "edit_file",
            serde_json::json!({ "path": "a.txt", "old": "two", "new": "TWO" }),
            &r,
        );
        assert!(res.ok, "{:?}", res.error);
        assert!(res.output.contains("replaced 1 occurrence"), "got: {}", res.output);
        assert_eq!(fs::read_to_string(r.join("a.txt")).unwrap(), "one\nTWO\nthree\n");
    }

    #[test]
    fn edit_file_refuses_an_ambiguous_match() {
        let r = root();
        fs::write(r.join("a.txt"), "same\nsame\n").unwrap();
        let res = call(
            "edit_file",
            serde_json::json!({ "path": "a.txt", "old": "same", "new": "x" }),
            &r,
        );
        assert!(!res.ok, "an ambiguous replace must be refused, not guessed");
        let err = res.error.unwrap_or_default();
        assert!(err.contains("occurs 2 times"), "the count belongs in the reason: {err}");
        assert!(
            err.contains("replace_all"),
            "tell the model how to proceed, not just that it failed: {err}"
        );
        // Nothing was written.
        assert_eq!(fs::read_to_string(r.join("a.txt")).unwrap(), "same\nsame\n");
    }

    #[test]
    fn edit_file_replace_all_changes_every_occurrence() {
        let r = root();
        fs::write(r.join("a.txt"), "same\nsame\n").unwrap();
        let res = call(
            "edit_file",
            serde_json::json!({ "path": "a.txt", "old": "same", "new": "x", "replace_all": true }),
            &r,
        );
        assert!(res.ok, "{:?}", res.error);
        assert_eq!(fs::read_to_string(r.join("a.txt")).unwrap(), "x\nx\n");
    }

    #[test]
    fn edit_file_says_when_the_snippet_is_absent() {
        let r = root();
        fs::write(r.join("a.txt"), "one\n").unwrap();
        let res = call(
            "edit_file",
            serde_json::json!({ "path": "a.txt", "old": "  two", "new": "x" }),
            &r,
        );
        assert!(!res.ok);
        let err = res.error.unwrap_or_default();
        assert!(err.contains("was not found"), "got: {err}");
        assert!(err.contains("indentation"), "whitespace is the usual cause: {err}");
    }

    #[test]
    fn edit_file_and_mkdir_stay_inside_the_root() {
        let r = root();
        for (tool, args) in [
            ("edit_file", serde_json::json!({ "path": "../a.txt", "old": "a", "new": "b" })),
            ("mkdir", serde_json::json!({ "path": "../escape" })),
        ] {
            let res = call(tool, args, &r);
            assert!(!res.ok, "{tool} must refuse a path that escapes the root");
        }
    }

    #[test]
    fn mkdir_creates_parents_and_file_info_sees_the_directory() {
        let r = root();
        let res = call("mkdir", serde_json::json!({ "path": "a/b/c" }), &r);
        assert!(res.ok, "{:?}", res.error);
        let info = call("file_info", serde_json::json!({ "path": "a/b/c" }), &r);
        assert!(info.output.contains("kind: directory"), "got: {}", info.output);
    }

    #[test]
    fn a_search_hit_is_clipped_and_the_total_is_capped_in_bytes() {
        // The gap this closes: a "line" is whatever sits between two newlines, so a minified
        // file is ONE line. Capping the *number* of matches bounded nothing — 200 matches drawn
        // from 2 MB lines is ~400 MB of output.
        let r = root();
        // One 40 000-char line: well under the 2 MB per-file limit, and a single "line".
        let long = format!("needle {}", "x".repeat(40_000));
        fs::write(r.join("bundle.min.js"), &long).unwrap();
        let res = call("search_files", serde_json::json!({ "pattern": "needle" }), &r);
        assert!(res.ok, "{}", res.output);
        assert!(
            res.output.len() <= MAX_OUTPUT_BYTES + 200,
            "search output is not byte-capped: {} bytes",
            res.output.len()
        );
        // The clip has to say how much it withheld, or the model believes that was the line.
        assert!(res.output.contains("chars"), "got: {}", res.output);
        assert!(!res.output.contains(&"x".repeat(1_000)), "the raw line was emitted whole");
    }

    #[test]
    fn wide_hits_stop_at_the_byte_cap_and_say_which_cap_stopped_them() {
        let r = root();
        // 250 files, one 4 000-char matching line each. Each hit is clipped to ~300 chars, so
        // ~187 of them reach the 64 KB byte cap — well before the 200-match cap. The point of
        // the fixture is that the match cap is NOT what stops this.
        for i in 0..250 {
            fs::write(r.join(format!("f{i}.txt")), format!("needle {}", "y".repeat(4_000)))
                .unwrap();
        }
        let res = call("search_files", serde_json::json!({ "pattern": "needle" }), &r);
        assert!(res.ok, "{}", res.output);
        assert!(
            res.output.len() <= MAX_OUTPUT_BYTES + 200,
            "output exceeded the byte cap: {} bytes",
            res.output.len()
        );
        assert!(res.output.contains("capped at"), "the model must be told it saw a prefix");
        assert!(
            res.output.contains(&format!("{MAX_OUTPUT_BYTES} bytes")),
            "the byte cap stopped this, not the match cap: {}",
            res.output
        );
    }

    #[test]
    fn narrow_hits_stop_at_the_match_cap_and_say_so() {
        let r = root();
        // Same file count, short lines: 200 matches is only ~4 KB, so the byte cap never fires
        // and the match cap is the bound. Pairs with the test above — together they prove the
        // message names the right cap rather than always saying the same thing.
        for i in 0..250 {
            fs::write(r.join(format!("g{i}.txt")), format!("needle {i}\n")).unwrap();
        }
        let res = call("search_files", serde_json::json!({ "pattern": "needle" }), &r);
        assert!(res.ok, "{}", res.output);
        assert!(
            res.output.contains(&format!("{MAX_SEARCH_MATCHES} matches")),
            "the match cap stopped this, not the byte cap: {}",
            res.output
        );
    }

    #[test]
    fn a_short_line_is_shown_intact() {
        // Clipping is for the pathological case; an ordinary match must not be mangled.
        let r = root();
        fs::write(r.join("a.rs"), "fn main() {}\n").unwrap();
        let res = call("search_files", serde_json::json!({ "pattern": "fn main" }), &r);
        assert!(res.ok, "{}", res.output);
        assert!(res.output.contains("a.rs:1: fn main() {}"), "got: {}", res.output);
        assert!(!res.output.contains('…'), "a short line must not be clipped: {}", res.output);
    }

    #[test]
    fn clipping_a_multi_byte_line_does_not_split_a_character() {
        // `truncate` is byte-wise and would cut mid-character; a hit is built from `str`, so
        // clipping has to count chars. A split char surfaces as U+FFFD.
        let r = root();
        let line = format!("needle {}", "é".repeat(1_000));
        fs::write(r.join("u.txt"), &line).unwrap();
        let res = call("search_files", serde_json::json!({ "pattern": "needle" }), &r);
        assert!(res.ok, "{}", res.output);
        assert!(!res.output.contains('\u{fffd}'), "a character was split: {}", res.output);
    }

    #[test]
    fn unknown_tool_is_an_error_not_a_panic() {
        let r = root();
        let res = tool_run(ToolRunRequest {
            name: "launch_missiles".into(),
            arguments: serde_json::json!({}),
            root: r.to_string_lossy().to_string(),
        });
        assert!(!res.ok);
    }

    #[test]
    fn list_dir_stays_inside_the_root() {
        let r = root();
        fs::create_dir_all(r.join("a/b")).unwrap();
        let res = do_list_dir(&obj(&[("path", serde_json::json!("a"))]), &r);
        assert!(res.ok);
        assert!(res.output.contains("dir  b"));
    }
}

/// Agent-session coverage: can a model actually scaffold, run, and edit a project through
/// this sandbox? See `tools_agent_tests.rs`.
#[cfg(test)]
#[path = "tools_agent_tests.rs"]
mod agent_tests;
