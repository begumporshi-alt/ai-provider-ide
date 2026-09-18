//! Agent-session tests for the sandboxed tool host (2026-09-18).
//!
//! These answer a question the unit tests in `tools.rs` do not: can a model actually *do a
//! coding task* through this sandbox — scaffold a nested module, run it, edit it, run it again
//! — and does it land files where it was told to?
//!
//! Every test drives the real `tool_run` entry point (not the inner `do_*` helpers) against a
//! real temp workspace, so it exercises path confinement, parent-directory creation, the
//! program allowlist and the scrubbed environment exactly as a model would meet them.

use super::*;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

static SEQ: AtomicU64 = AtomicU64::new(0);

fn ws(tag: &str) -> PathBuf {
    let seq = SEQ.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!(
        "aiprovider-agent-{}-{}-{}",
        tag,
        std::process::id(),
        seq
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

/// Drive one tool call through the public command surface.
fn call(root: &Path, name: &str, args: serde_json::Value) -> ToolResult {
    tool_run(ToolRunRequest {
        name: name.to_string(),
        arguments: args,
        root: root.to_string_lossy().to_string(),
    })
}

fn write(root: &Path, path: &str, content: &str) -> ToolResult {
    call(root, "write_file", serde_json::json!({ "path": path, "content": content }))
}

fn read(root: &Path, path: &str) -> ToolResult {
    call(root, "read_file", serde_json::json!({ "path": path }))
}

fn run(root: &Path, program: &str, args: &[&str]) -> ToolResult {
    call(root, "run_command", serde_json::json!({ "program": program, "args": args }))
}

const CALC_V1: &str = r#"def add(a, b):
    return a + b


if __name__ == "__main__":
    print(add(2, 3))
"#;

const CALC_V2: &str = r#"def add(a, b):
    """Edited: now also reports the operands."""
    return a + b


if __name__ == "__main__":
    print("sum", add(2, 3), "of", 2, 3)
"#;

/// The whole point of agent mode: scaffold a nested module, then prove it runs.
#[test]
fn scaffolds_a_nested_module_and_executes_it() {
    let root = ws("scaffold");

    // 1. Write into a path whose parents do not exist — the host must create them.
    let w = write(&root, "src/utils/calc.py", CALC_V1);
    assert!(w.ok, "write_file must succeed: {:?}", w.error);

    // 2. It must land exactly here — not flattened, not beside the root.
    let target = root.join("src").join("utils").join("calc.py");
    assert!(target.is_file(), "expected a file at {}", target.display());
    assert!(root.join("src").join("utils").is_dir(), "parent dirs must be created");
    assert_eq!(fs::read_to_string(&target).unwrap(), CALC_V1);

    // 3. The model reads it back and sees what it wrote.
    let r = read(&root, "src/utils/calc.py");
    assert!(r.ok);
    assert!(r.output.contains("def add(a, b):"));

    // 4. And it runs — real execution through the sandboxed environment.
    let e = run(&root, "python3", &["src/utils/calc.py"]);
    assert!(e.ok, "python3 must run: {:?}", e.error);
    assert!(e.output.trim() == "5", "expected 5, got {:?}", e.output);
}

/// Editing is a second write to the same path; the new version must win and be executable.
#[test]
fn edits_an_existing_file_and_the_change_takes_effect() {
    let root = ws("edit");

    assert!(write(&root, "app.py", "print('v1')\n").ok);
    let first = run(&root, "python3", &["app.py"]);
    assert!(first.ok);
    assert!(first.output.trim() == "v1", "got {:?}", first.output);

    // The edit.
    assert!(write(&root, "app.py", "print('v2')\n").ok);
    let second = run(&root, "python3", &["app.py"]);
    assert!(second.ok);
    assert!(second.output.trim() == "v2", "edit did not take effect: {:?}", second.output);

    // Read-back confirms the file on disk is the edited one, not a cached copy.
    let r = read(&root, "app.py");
    assert!(r.ok);
    assert_eq!(r.output, "print('v2')\n");
}

/// The same edit flow, but for nested paths created by an earlier call in the session.
#[test]
fn nested_edit_preserves_the_tree() {
    let root = ws("nested-edit");
    assert!(write(&root, "src/utils/calc.py", CALC_V1).ok);
    assert!(write(&root, "src/utils/calc.py", CALC_V2).ok);

    let e = run(&root, "python3", &["src/utils/calc.py"]);
    assert!(e.ok);
    assert!(e.output.contains("sum 5 of 2 3"), "got {:?}", e.output);
    assert_eq!(fs::read_to_string(root.join("src/utils/calc.py")).unwrap(), CALC_V2);
}

/// A model must not be able to place a file outside the root, even via parent-dir creation.
#[test]
fn writes_cannot_escape_the_workspace() {
    let root = ws("escape");
    for bad in ["../outside.py", "a/../../outside.py", "/tmp/abs-outside.py"] {
        let w = write(&root, bad, "pwned");
        assert!(!w.ok, "write to {bad} must be refused");
    }
    assert!(!std::env::temp_dir().join("outside.py").exists());
}

/// The destructive / network-facing programs a model is most likely to reach for.
#[test]
fn destructive_and_network_programs_are_absent() {
    let root = ws("allowlist");
    for (prog, argv) in [
        ("rm", vec!["-rf", "."]),
        ("curl", vec!["https://example.com"]),
        ("wget", vec!["https://example.com"]),
        ("sh", vec!["-c", "echo hi"]),
        ("sudo", vec!["echo", "hi"]),
    ] {
        let r = call(&root, "run_command", serde_json::json!({ "program": prog, "args": argv }));
        assert!(!r.ok, "{prog} must be refused");
        assert!(r.error.unwrap().contains("not on the allowlist"));
    }
    // git is allowed, but only for offline subcommands.
    for sub in ["push", "pull", "fetch", "clone"] {
        let r = run(&root, "git", &[sub]);
        assert!(!r.ok, "git {sub} must be refused");
    }
}

/// A model listing what it created should see the tree it built.
#[test]
fn list_dir_reflects_the_scaffolded_tree() {
    let root = ws("list");
    assert!(write(&root, "src/utils/calc.py", CALC_V1).ok);

    let l = call(&root, "list_dir", serde_json::json!({}));
    assert!(l.ok);
    assert!(l.output.contains("dir  src"), "root listing: {:?}", l.output);

    let inner = call(&root, "list_dir", serde_json::json!({ "path": "src/utils" }));
    assert!(inner.ok);
    assert!(inner.output.contains("file calc.py"), "inner listing: {:?}", inner.output);
}

/// Failure must be a message the model can read and recover from — never a panic, never a
/// partial write.
#[test]
fn failures_are_readable_not_fatal() {
    let root = ws("failures");
    // The message has to name the real problem. A model told "parent directory is not
    // accessible" when the file simply is not there will go hunting for a permissions bug.
    let missing = read(&root, "nope/missing.py");
    assert!(!missing.ok);
    assert!(
        missing.error.unwrap().contains("no such file or directory"),
        "expected a plain not-found error"
    );
    let missing_at_root = read(&root, "missing.py");
    assert!(!missing_at_root.ok);
    assert!(missing_at_root.error.unwrap().contains("no such file or directory"));

    let not_a_dir = call(&root, "list_dir", serde_json::json!({ "path": "src/utils/calc.py" }));
    assert!(!not_a_dir.ok);

    let unknown = call(&root, "delete_everything", serde_json::json!({}));
    assert!(!unknown.ok);
    assert!(unknown.error.unwrap().contains("unknown tool"));
}

/// Not an assertion — a measurement, printed under `--nocapture`, so we can say how the
/// sandbox actually performs instead of guessing.
#[test]
fn throughput_measurement() {
    let root = ws("perf");
    let n = 200;

    let t0 = Instant::now();
    for i in 0..n {
        let w = write(&root, &format!("bench/f{i}.txt"), &"x".repeat(512));
        assert!(w.ok);
    }
    let write_ms = t0.elapsed().as_millis();

    let t1 = Instant::now();
    for i in 0..n {
        let r = read(&root, &format!("bench/f{i}.txt"));
        assert!(r.ok);
    }
    let read_ms = t1.elapsed().as_millis();

    let t2 = Instant::now();
    for _ in 0..20 {
        let e = run(&root, "python3", &["-c", "print(1)"]);
        assert!(e.ok);
    }
    let spawn_ms = t2.elapsed().as_millis();

    eprintln!(
        "tool host: {n} writes {}ms ({:.2}ms/op) · {n} reads {}ms ({:.2}ms/op) · 20 python3 spawns {}ms ({:.1}ms/op)",
        write_ms, write_ms as f64 / n as f64,
        read_ms, read_ms as f64 / n as f64,
        spawn_ms, spawn_ms as f64 / 20.0,
    );
}
