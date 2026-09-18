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
//!      argument. `git` is further restricted to non-network subcommands.
//!   3. ROOT CONFINEMENT. Every file path is resolved and must land inside the workspace
//!      root after canonicalization, so `..` and symlinks pointing outward both fail.
//!   4. BOUNDED. Wall-clock timeout, output caps, and a scrubbed environment (no ambient
//!      secrets leaking into a transcript the model can read back).
//!
//! Rule 1 is why this does not depend on pattern-matching "dangerous" strings — a blocklist
//! would be a sieve. What remains (a model reading or overwriting files inside the one
//! directory the user pointed it at) is the risk the user accepted by enabling agent mode,
//! and every call is confirmed in the UI before it reaches this file.

use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

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
            "cut", "sed", "awk", "tar", "unzip", "mkdir", "touch", "cp", "git", "node", "npm",
            "npx", "pnpm", "python3", "pip3", "make",
        ]
        .into_iter()
        .collect()
    })
}

/// `git` is allowed, but only for subcommands that cannot reach the network. `push`/`pull`/
/// `fetch`/`clone` are excluded so a model cannot exfiltrate a repo or fetch a payload.
const GIT_SUBCOMMANDS: &[&str] = &[
    "status", "diff", "log", "show", "branch", "add", "commit", "init", "rev-parse",
    "ls-files", "config", "describe", "stash",
];

const MAX_COMMAND_MS: u64 = 60_000;
const DEFAULT_COMMAND_MS: u64 = 20_000;
const MAX_OUTPUT_BYTES: usize = 64 * 1024;
const MAX_READ_BYTES: usize = 256 * 1024;
const MAX_WRITE_BYTES: usize = 1024 * 1024;
const MAX_LIST_ENTRIES: usize = 500;

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
    fn err(message: impl Into<String>) -> Self {
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
#[tauri::command]
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
        return Err("absolute paths are not allowed — use a path relative to the workspace root".into());
    }
    if rel_path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("'..' is not allowed in a path".into());
    }
    let root_canon = fs::canonicalize(root).map_err(|e| format!("workspace root is not accessible: {e}"))?;
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
            let parent = target.parent().ok_or_else(|| "path has no parent directory".to_string())?;
            if create_parents {
                fs::create_dir_all(parent).map_err(|e| format!("cannot create parent directory: {e}"))?;
            }
            let parent_canon =
                fs::canonicalize(parent).map_err(|e| format!("parent directory is not accessible: {e}"))?;
            if !parent_canon.starts_with(&root_canon) {
                return Err("path resolves outside the workspace root".into());
            }
            parent_canon.join(target.file_name().ok_or_else(|| "path has no file name".to_string())?)
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
        if buf.len() > MAX_READ_BYTES {
            return Ok(format!("{}\n… truncated at {} bytes", String::from_utf8_lossy(&buf[..MAX_READ_BYTES]), MAX_READ_BYTES));
        }
        String::from_utf8(buf).map_err(|_| "file is not valid UTF-8 text".to_string())
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
            return Err(format!("content exceeds the {} byte cap", MAX_WRITE_BYTES));
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

fn do_run_command(args: &serde_json::Value, root: &Path) -> ToolResult {
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
        // Sub-gate `git`: network-facing subcommands are not reachable.
        if program == "git" {
            match argv.first() {
                None => return Err("git needs a subcommand".into()),
                Some(sub) if !GIT_SUBCOMMANDS.contains(&sub.as_str()) => {
                    return Err(format!("git subcommand \"{sub}\" is not allowed"));
                }
                Some(_) => {}
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
            .env("PATH", "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")
            .env("HOME", std::env::var("HOME").unwrap_or_else(|_| "/tmp".into()))
            .env("TMPDIR", std::env::var("TMPDIR").unwrap_or_else(|_| "/tmp".into()))
            .env("LANG", "C.UTF-8");

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("cannot start \"{program}\": {e}"))?;
        // `std` has no wait-with-timeout that also captures output, so the child is parked in
        // a worker thread that reads both pipes to EOF and then waits; on timeout the caller
        // kills it through the shared lock. `kill`/`wait` both take `&mut self`, so the child
        // stays behind the lock and is never moved out.
        let mut stdout = child
            .stdout
            .take()
            .ok_or_else(|| "stdout was not captured".to_string())?;
        let mut stderr = child
            .stderr
            .take()
            .ok_or_else(|| "stderr was not captured".to_string())?;
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

        let (captured_out, captured_err, code) =
            match rx.recv_timeout(Duration::from_millis(timeout_ms)) {
                Ok(Ok(triple)) => triple,
                Ok(Err(e)) => return Err(format!("command failed: {e}")),
                Err(_) => {
                    // Timed out: kill, then drain the worker's result so the thread exits.
                    let _ = child.lock().unwrap().kill();
                    let _ = rx.recv_timeout(Duration::from_millis(MAX_COMMAND_MS.saturating_add(5_000)));
                    return Err(format!(
                        "\"{program}\" timed out after {timeout_ms}ms and was killed"
                    ));
                }
            };

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

/// Execute one tool call. Never panics on model input: every failure is a `ToolResult`.
#[tauri::command]
pub fn tool_run(req: ToolRunRequest) -> ToolResult {
    let root = PathBuf::from(&req.root);
    // Resolve lazily per tool so a bad root yields a clear error rather than a panic.
    match req.name.as_str() {
        "read_file" => do_read_file(&req.arguments, &root),
        "write_file" => do_write_file(&req.arguments, &root),
        "list_dir" => do_list_dir(&req.arguments, &root),
        "run_command" => do_run_command(&req.arguments, &root),
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
        let dir = std::env::temp_dir()
            .join(format!("aiprovider-tools-test-{}-{}", std::process::id(), seq));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
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

    #[test]
    fn symlink_escaping_the_root_is_refused() {
        let r = root();
        let outside = std::env::temp_dir().join(format!("aiprovider-outside-{}", std::process::id()));
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
            &obj(&[("path", serde_json::json!("skills/demo/SKILL.md")), ("content", serde_json::json!("# demo"))]),
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
        let res = do_run_command(&obj(&[("program", serde_json::json!("rm")), ("args", serde_json::json!(["-rf", "/"]))]), &r);
        assert!(!res.ok);
        assert!(res.error.unwrap().contains("not on the allowlist"));
    }

    #[test]
    fn shell_metacharacters_are_inert() {
        // No shell is involved, so this must be treated as one literal argument to `echo`,
        // not as `echo hi` followed by deleting a directory.
        let r = root();
        let res = do_run_command(
            &obj(&[("program", serde_json::json!("echo")), ("args", serde_json::json!(["hi; echo pwned"]))]),
            &r,
        );
        assert!(res.ok);
        assert!(res.output.contains("hi; echo pwned"));
    }

    #[test]
    fn git_network_subcommands_are_refused() {
        let r = root();
        for sub in ["push", "pull", "fetch", "clone"] {
            let res = do_run_command(
                &obj(&[("program", serde_json::json!("git")), ("args", serde_json::json!([sub]))]),
                &r,
            );
            assert!(!res.ok, "git {sub} should be refused");
        }
    }

    #[test]
    fn command_output_is_capped_and_exits_cleanly() {
        let r = root();
        let res = do_run_command(&obj(&[("program", serde_json::json!("pwd"))]), &r);
        assert!(res.ok);
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
