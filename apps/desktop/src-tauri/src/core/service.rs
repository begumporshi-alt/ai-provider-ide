//! The login-item service: the launchd agent that runs `aiproviderd` **without** the desktop app.
//!
//! Phase 6 of the headless plan (`docs/dev-book/10-headless-service.md`), step 1. Phases 1–5 made
//! the gateway a Rust service that does not need a webview; what none of them did is let it outlive
//! the app *process*. `Cmd+Q` still takes the gateway with it, because the only thing that ever
//! started it was the app. This module is the other half: a `LaunchAgent` that launchd owns, so
//! the gateway is up at login and stays up whether or not a window is open.
//!
//! ## Why the binary is copied out of the bundle
//!
//! The risk register's own hazard, and its own preferred remedy. A plist points
//! `ProgramArguments` at an absolute path, and the obvious one —
//! `/Applications/AI-Provider Router.app/Contents/MacOS/aiproviderd` — moves every time the bundle
//! is versioned or atomically swapped, leaving launchd exec'ing a path that no longer exists.
//! `KeepAlive` *throttles* on repeated failed execs and can leave the job disabled, so a path that
//! is briefly missing during an update is not self-healing. So install copies the bundled binary
//! to a stable path under the app data directory and points the plist there.
//!
//! ## What this module does not do, stated rather than implied
//!
//! - **It does not decide who owns the port.** With `RunAtLoad` and `KeepAlive` both set, the
//!   agent starts the gateway at install time and at every login — and the desktop app *also*
//!   starts a gateway when it runs. Both bind the same persisted port, so until the UI stops
//!   starting its own (Phase 6 step 3), installing the agent and launching the app is a bind
//!   conflict, not a handover. Nothing here detects or resolves that; it is the next increment's
//!   work and the reason `install` is not called anywhere in production yet.
//! - **It does not run at boot.** Nothing in this crate calls `install`. It is a capability with a
//!   command in front of it, and the operator starts it.
//! - **macOS only, and not by `cfg`.** launchd has no counterpart here. The module is written so
//!   it *compiles* on every platform and its tests run everywhere — only `read_uid` and
//!   `run_launchctl` name the outside world, and on a machine without `/bin/launchctl` they fail
//!   with a message rather than at compile time. That is a deliberate departure from gating the
//!   module: a `#[cfg(target_os = "macos")]` module is a module no non-macOS build ever compiles,
//!   which is the shape D17 recorded as a blind spot.
//! - **Uninstall does not guarantee the job is stopped.** `bootout` of a job that was never
//!   loaded fails, and that is not a condition the operator can act on; what uninstalls the agent
//!   is removing the plist. A `bootout` that fails *while the job is running* therefore leaves the
//!   process up until logout. Its status is discarded rather than returned because a caller cannot
//!   distinguish the two failure shapes from the exit code alone.
//!
//! ## The seam
//!
//! Everything impure arrives as a `&impl Fn`, so every branch below is reachable from a test with
//! no launchd and no root. This is the crate's existing shape — `HttpPort`, `AdapterFactory`,
//! `BridgeHost` — and the reason is the same: the alternative is a module whose only coverage is
//! the machine it happens to run on.

use std::fmt;
use std::path::{Path, PathBuf};
use std::process::Command;

/// The launchd label. It is the job's identity: `bootout`, `print` and the plist filename all
/// name it, and a second install under a different label would be a second gateway on the same
/// port rather than a replacement.
pub const LABEL: &str = "dev.aiprovider.router";

/// Absolute, because `Command::new` resolves through `PATH` and a service manager has no
/// business inheriting one.
const LAUNCHCTL: &str = "/bin/launchctl";

/// Absolute for the same reason. `id -u` is the only way this crate can learn the uid without
/// adding a dependency for `getuid`.
const ID: &str = "/usr/bin/id";

/// The four paths an installed agent is made of.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Paths {
    /// Where launchd reads the job from. `~/Library/LaunchAgents/<label>.plist` is the per-user
    /// location launchd scans at login; anywhere else needs an explicit `bootstrap` and nothing
    /// re-reads it after a reboot.
    pub plist: PathBuf,
    /// The copy of `aiproviderd` this module installs — deliberately **not** the one inside the
    /// bundle. See the module note.
    pub binary: PathBuf,
    pub out_log: PathBuf,
    pub err_log: PathBuf,
}

/// Where each piece goes, from the two directories the caller resolves.
///
/// `home` and `data_dir` are separate because they are different things and both are already
/// known to the caller: the plist must land under `~/Library/LaunchAgents` for launchd to find
/// it at login, while the binary and its logs belong with the rest of the app's data.
pub fn paths(home: &Path, data_dir: &Path) -> Paths {
    Paths {
        plist: home.join("Library").join("LaunchAgents").join(format!("{LABEL}.plist")),
        binary: data_dir.join("bin").join("aiproviderd"),
        out_log: data_dir.join("aiproviderd.log"),
        err_log: data_dir.join("aiproviderd.err.log"),
    }
}

/// The five characters that make a `<string>` element a string.
///
/// Not defensive padding. launchd rejects a malformed plist silently — the job simply never
/// appears, and the only symptom is a gateway that is not running — so a path containing `&`
/// would produce an agent that fails with nothing to diagnose.
fn escape_xml(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// The job definition.
///
/// **`RunAtLoad` and `KeepAlive` are the whole point of the agent and the whole of its hazard.**
/// `RunAtLoad` starts the gateway without the app; `KeepAlive` restarts it if it dies. Both are
/// what make availability independent of the UI process, and both are why installing this while
/// the app still starts its own gateway is a bind conflict rather than a handover.
pub fn render_plist(p: &Paths) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>{binary}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>{out}</string>
    <key>StandardErrorPath</key>
    <string>{err}</string>
</dict>
</plist>
"#,
        label = LABEL,
        binary = escape_xml(&p.binary.display().to_string()),
        out = escape_xml(&p.out_log.display().to_string()),
        err = escape_xml(&p.err_log.display().to_string()),
    )
}

/// What one `launchctl` invocation answered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outcome {
    pub status: i32,
    pub stdout: String,
    pub stderr: String,
}

/// The real `launchctl`. Passed as `&run_launchctl` wherever one of the functions below asks for
/// a runner; a test passes a closure that records its argv instead.
pub fn run_launchctl(args: &[&str]) -> Result<Outcome, String> {
    let out = Command::new(LAUNCHCTL)
        .args(args)
        .output()
        .map_err(|e| format!("cannot run {LAUNCHCTL}: {e}"))?;
    Ok(Outcome {
        status: out.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

/// One error type, and it is a `String` because every consumer turns it into one: the command
/// surface serializes it and the log prints it.
#[derive(Debug)]
pub struct ServiceError(pub String);

impl fmt::Display for ServiceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// The runner's own error is already the message an operator needs — `launchctl` is not there,
/// or refused to start — so it passes through rather than being wrapped in a second noun.
impl From<String> for ServiceError {
    fn from(s: String) -> Self {
        ServiceError(s)
    }
}

/// The launchd domain a per-user agent belongs to. `bootstrap` and `bootout` both require it, so
/// it is the caller's to resolve and the tests' to fix.
pub fn domain(uid: u32) -> String {
    format!("gui/{uid}")
}

/// The uid, from whatever `id -u` printed.
///
/// Split out of `read_uid` so the parse is testable: the interesting inputs are the ones `id`
/// does not produce either (a trailing newline it always does, a non-numeric answer it never
/// should), and a test can only reach them if the parse is its own function.
pub fn parse_uid(raw: &str) -> Result<u32, ServiceError> {
    let trimmed = raw.trim();
    trimmed
        .parse::<u32>()
        .map_err(|_| ServiceError(format!("`{ID} -u` answered {trimmed:?}, which is not a uid")))
}

/// This process's uid. The one function here with no test of its own — it names the outside
/// world's identity — and the reason it is three lines: everything it can get wrong is in
/// `parse_uid`, which is tested.
pub fn read_uid() -> Result<u32, ServiceError> {
    let out = Command::new(ID)
        .arg("-u")
        .output()
        .map_err(|e| ServiceError(format!("cannot run `{ID} -u`: {e}")))?;
    parse_uid(&String::from_utf8_lossy(&out.stdout))
}

/// Copy the service binary to its stable path, write the plist, and bootstrap the job.
///
/// **The `bootout` first is not tidiness.** `bootstrap` of an already-loaded label fails, so a
/// re-install — the shape an update takes, and the only way a new binary reaches an agent that is
/// already running — would otherwise be a no-op that reports success while launchd keeps exec'ing
/// the old path. Its status is discarded because a job that was never loaded has nothing to boot
/// out, and launchd answers that with a non-zero exit the caller cannot act on either.
pub fn install(
    p: &Paths,
    source: &Path,
    domain: &str,
    run: &impl Fn(&[&str]) -> Result<Outcome, String>,
) -> Result<(), ServiceError> {
    let bin_dir = p
        .binary
        .parent()
        .ok_or_else(|| {
            ServiceError(format!("the binary path {} has no parent", p.binary.display()))
        })?
        .to_path_buf();
    std::fs::create_dir_all(&bin_dir)
        .map_err(|e| ServiceError(format!("cannot create {}: {e}", bin_dir.display())))?;
    // Permissions come along: `fs::copy` copies the mode, and the bundled binary is already
    // executable. A `chmod` here would be a second spelling of a fact the source already carries.
    std::fs::copy(source, &p.binary).map_err(|e| {
        ServiceError(format!(
            "cannot install {} from {}: {e}",
            p.binary.display(),
            source.display()
        ))
    })?;

    let plist_dir = p
        .plist
        .parent()
        .ok_or_else(|| ServiceError(format!("the plist path {} has no parent", p.plist.display())))?
        .to_path_buf();
    std::fs::create_dir_all(&plist_dir)
        .map_err(|e| ServiceError(format!("cannot create {}: {e}", plist_dir.display())))?;
    std::fs::write(&p.plist, render_plist(p))
        .map_err(|e| ServiceError(format!("cannot write {}: {e}", p.plist.display())))?;

    let target = format!("{domain}/{LABEL}");
    let plist = p.plist.display().to_string();
    let _ = run(&["bootout", &target]);
    let out = run(&["bootstrap", domain, &plist])?;
    if out.status != 0 {
        return Err(ServiceError(format!(
            "launchctl bootstrap {domain} {plist} failed ({}): {}",
            out.status,
            first_line(&out)
        )));
    }
    Ok(())
}

/// Stop the job and remove what installed it.
///
/// Removing the plist is what uninstalls; the `bootout` only stops a running instance. See the
/// module note for the case this leaves open.
pub fn uninstall(
    p: &Paths,
    domain: &str,
    run: &impl Fn(&[&str]) -> Result<Outcome, String>,
) -> Result<(), ServiceError> {
    let target = format!("{domain}/{LABEL}");
    let _ = run(&["bootout", &target]);
    if p.plist.exists() {
        std::fs::remove_file(&p.plist)
            .map_err(|e| ServiceError(format!("cannot remove {}: {e}", p.plist.display())))?;
    }
    if p.binary.exists() {
        std::fs::remove_file(&p.binary)
            .map_err(|e| ServiceError(format!("cannot remove {}: {e}", p.binary.display())))?;
    }
    Ok(())
}

/// What the UI needs to answer "is the service running": whether it is installed, whether
/// launchd has it, and — if it is up — its pid.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// The plist is on disk. Answers "has this ever been installed".
    pub plist_present: bool,
    /// launchd knows the job. Distinct from `pid`: a loaded job that is between restarts has no
    /// pid, and reporting that as "not running" would send the operator looking for a plist that
    /// is fine.
    pub loaded: bool,
    pub pid: Option<i32>,
}

/// The pid out of `launchctl print`'s output, which is a property list rather than a table:
/// `pid = 1234` appears only while the job is actually running.
fn parse_pid(out: &str) -> Option<i32> {
    out.lines()
        .filter_map(|l| l.trim().strip_prefix("pid ="))
        .filter_map(|v| v.trim().trim_end_matches(';').parse::<i32>().ok())
        .next()
}

/// `launchctl print` exits non-zero for a job it does not have, which is the ordinary state and
/// not an error: "not installed" is an answer this function exists to give.
pub fn status(
    p: &Paths,
    domain: &str,
    run: &impl Fn(&[&str]) -> Result<Outcome, String>,
) -> Result<Status, ServiceError> {
    let plist_present = p.plist.is_file();
    let target = format!("{domain}/{LABEL}");
    match run(&["print", &target])? {
        Outcome { status: 0, stdout, .. } => {
            Ok(Status { plist_present, loaded: true, pid: parse_pid(&stdout) })
        }
        _ => Ok(Status { plist_present, loaded: false, pid: None }),
    }
}

/// The first non-empty line of a command's output, for an error message. `stderr` first:
/// `launchctl` explains itself there, and its stdout is usually empty.
fn first_line(out: &Outcome) -> String {
    out.stderr
        .lines()
        .chain(out.stdout.lines())
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("no output")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Records every invocation and answers each from a script.
    ///
    /// The recorded argv is what most of these tests assert on, because the alternative —
    /// inspecting the filesystem after a real `launchctl` — needs a real launchd and a real uid.
    struct Recorder {
        calls: RefCell<Vec<Vec<String>>>,
        answers: RefCell<VecDeque<Result<Outcome, String>>>,
    }

    impl Recorder {
        /// Every invocation answers the same thing.
        fn ok(status: i32, stdout: &str) -> Recorder {
            let mut answers = VecDeque::new();
            // Generous: a test that does not know how many calls the code makes should not fail
            // on the count. It asserts on the argv instead.
            for _ in 0..16 {
                answers.push_back(Ok(Outcome {
                    status,
                    stdout: stdout.to_string(),
                    stderr: String::new(),
                }));
            }
            Recorder { calls: RefCell::new(Vec::new()), answers: RefCell::new(answers) }
        }

        fn run(&self, args: &[&str]) -> Result<Outcome, String> {
            self.calls.borrow_mut().push(args.iter().map(|s| s.to_string()).collect());
            self.answers
                .borrow_mut()
                .pop_front()
                .unwrap_or_else(|| Err("the script ran out of answers".to_string()))
        }

        fn calls(&self) -> Vec<Vec<String>> {
            self.calls.borrow().clone()
        }
    }

    /// A scratch install. `AtomicUsize`, not `pid + timestamp`: two tests in the same millisecond
    /// would share a directory and one of them would fail for a reason unrelated to what it is
    /// testing.
    fn scratch() -> (Paths, PathBuf) {
        static N: AtomicUsize = AtomicUsize::new(0);
        let n = N.fetch_add(1, Ordering::SeqCst);
        let root = std::env::temp_dir().join(format!("aip-service-{n}"));
        let _ = std::fs::remove_dir_all(&root);
        let home = root.join("home");
        let data = root.join("data");
        std::fs::create_dir_all(&data).unwrap();
        let p = paths(&home, &data);
        (p, root)
    }

    /// A source binary to install from, with the one property that matters: it exists.
    fn source(dir: &Path) -> PathBuf {
        let src = dir.join("bundled-aiproviderd");
        std::fs::write(&src, "#!/bin/sh\nexit 0\n").unwrap();
        src
    }

    /// The plist on disk, for the status tests — which are about what launchd says, not about
    /// whether install wrote the file.
    fn write_plist(p: &Paths) {
        std::fs::create_dir_all(p.plist.parent().unwrap()).unwrap();
        std::fs::write(&p.plist, render_plist(p)).unwrap();
    }

    const DOMAIN: &str = "gui/501";

    /* ---------------------------------- the paths ---------------------------------- */

    #[test]
    fn the_plist_lands_where_launchd_scans_and_the_binary_where_the_bundle_cannot_move_it() {
        let (p, _dir) = scratch();
        assert!(p.plist.ends_with("Library/LaunchAgents/dev.aiprovider.router.plist"));
        assert!(p.binary.ends_with("bin/aiproviderd"));
        // The whole reason for the split: the binary is under the data dir, not under any
        // `.app`. Asserted as a property rather than by string-matching "Contents".
        assert!(
            !p.binary.components().any(|c| c.as_os_str().to_string_lossy().ends_with(".app")),
            "the installed binary must not live inside the bundle: {}",
            p.binary.display()
        );
    }

    #[test]
    fn the_plist_carries_the_label_the_binary_and_both_logs() {
        let (p, _dir) = scratch();
        let plist = render_plist(&p);
        assert!(plist.contains(&format!("<string>{LABEL}</string>")), "{plist}");
        assert!(plist.contains(&format!("<string>{}</string>", p.binary.display())), "{plist}");
        assert!(plist.contains(&format!("<string>{}</string>", p.out_log.display())), "{plist}");
        assert!(plist.contains(&format!("<string>{}</string>", p.err_log.display())), "{plist}");
    }

    #[test]
    fn the_plist_asks_to_be_started_at_load_and_kept_alive() {
        let (p, _dir) = scratch();
        let plist = render_plist(&p);
        // Both, and in that order: RunAtLoad is what starts it without the app, KeepAlive is what
        // keeps it. Either alone is half the property this agent exists for.
        let run = plist.find("<key>RunAtLoad</key>").expect("RunAtLoad is missing");
        let keep = plist.find("<key>KeepAlive</key>").expect("KeepAlive is missing");
        assert!(run < keep, "both are present but the order is not the documented one");
        assert!(plist[run..].contains("<true/>"), "RunAtLoad must be true");
        assert!(plist[keep..].contains("<true/>"), "KeepAlive must be true");
    }

    #[test]
    fn a_path_with_an_ampersand_still_produces_a_well_formed_plist() {
        let (mut p, _dir) = scratch();
        p.binary = PathBuf::from("/tmp/a&b/aiproviderd");
        let plist = render_plist(&p);
        // Unescaped, this is a plist launchd rejects with nothing to diagnose — the job simply
        // never appears.
        assert!(plist.contains("<string>/tmp/a&amp;b/aiproviderd</string>"), "{plist}");
        assert!(!plist.contains("<string>/tmp/a&b/"), "the raw ampersand must not survive");
    }

    /* --------------------------------- install ---------------------------------- */

    #[test]
    fn install_copies_the_binary_out_of_the_bundle_to_the_stable_path() {
        let (p, dir) = scratch();
        let src = source(&dir);
        let rec = Recorder::ok(0, "");
        install(&p, &src, DOMAIN, &|a| rec.run(a)).unwrap();
        assert!(p.binary.is_file(), "the binary must exist at {}", p.binary.display());
        assert_eq!(
            std::fs::read_to_string(&p.binary).unwrap(),
            std::fs::read_to_string(&src).unwrap(),
            "the installed binary must be the source's bytes"
        );
    }

    #[test]
    fn install_writes_the_plist_where_launchd_will_read_it() {
        let (p, dir) = scratch();
        let src = source(&dir);
        let rec = Recorder::ok(0, "");
        install(&p, &src, DOMAIN, &|a| rec.run(a)).unwrap();
        assert!(p.plist.is_file(), "the plist must exist at {}", p.plist.display());
        assert_eq!(std::fs::read_to_string(&p.plist).unwrap(), render_plist(&p));
    }

    #[test]
    fn install_bootouts_before_it_bootstraps() {
        let (p, dir) = scratch();
        let src = source(&dir);
        let rec = Recorder::ok(0, "");
        install(&p, &src, DOMAIN, &|a| rec.run(a)).unwrap();
        let calls = rec.calls();
        // A re-install is the shape an update takes; without the bootout, `bootstrap` of an
        // already-loaded label fails and the old binary keeps running.
        let bootout = calls.iter().position(|c| c.first().map(String::as_str) == Some("bootout"));
        let bootstrap =
            calls.iter().position(|c| c.first().map(String::as_str) == Some("bootstrap"));
        let (b, s) = (bootout.expect("no bootout"), bootstrap.expect("no bootstrap"));
        assert!(b < s, "bootout must precede bootstrap: {calls:?}");
        assert_eq!(calls[b], vec!["bootout".to_string(), format!("{DOMAIN}/{LABEL}")]);
        assert_eq!(calls[s][1], DOMAIN, "bootstrap must target the domain it was given");
        assert_eq!(calls[s][2], p.plist.display().to_string());
    }

    #[test]
    fn a_bootstrap_that_launchd_refuses_is_an_error_not_a_silent_success() {
        let (p, dir) = scratch();
        let src = source(&dir);
        let rec = Recorder::ok(5, "Bootstrap failed: 5: Input/output error");
        let err = install(&p, &src, DOMAIN, &|a| rec.run(a)).unwrap_err();
        assert!(err.to_string().contains("bootstrap"), "{err}");
        assert!(err.to_string().contains(DOMAIN), "the error must name the domain: {err}");
        // launchctl explains itself on stderr; an error that dropped it would leave the operator
        // with an exit code and nothing else.
        assert!(err.to_string().contains("Input/output error"), "{err}");
    }

    /* --------------------------------- uninstall ---------------------------------- */

    #[test]
    fn uninstall_stops_the_job_and_removes_what_installed_it() {
        let (p, dir) = scratch();
        let src = source(&dir);
        let rec = Recorder::ok(0, "");
        install(&p, &src, DOMAIN, &|a| rec.run(a)).unwrap();
        let rec2 = Recorder::ok(0, "");
        uninstall(&p, DOMAIN, &|a| rec2.run(a)).unwrap();
        assert!(!p.plist.exists(), "the plist must be gone");
        assert!(!p.binary.exists(), "the installed binary must be gone");
        let calls = rec2.calls();
        assert_eq!(
            calls.first().cloned(),
            Some(vec!["bootout".to_string(), format!("{DOMAIN}/{LABEL}")]),
            "uninstall must boot the job out before it deletes the definition: {calls:?}"
        );
    }

    #[test]
    fn uninstall_of_something_that_was_never_installed_is_not_an_error() {
        let (p, _dir) = scratch();
        let rec = Recorder::ok(0, "");
        // Nothing on disk. `bootout` of an unknown job fails, and that must not surface.
        uninstall(&p, DOMAIN, &|a| rec.run(a)).unwrap();
    }

    /* --------------------------------- status ---------------------------------- */

    #[test]
    fn status_reports_the_pid_of_a_running_job() {
        let (p, _dir) = scratch();
        write_plist(&p);
        let rec = Recorder::ok(0, "{\n\tpid = 4321;\n\tstate = running;\n}\n");
        let s = status(&p, DOMAIN, &|a| rec.run(a)).unwrap();
        assert!(s.plist_present);
        assert!(s.loaded);
        assert_eq!(s.pid, Some(4321));
    }

    #[test]
    fn status_reports_loaded_with_no_pid_when_the_job_is_loaded_but_not_up() {
        let (p, _dir) = scratch();
        write_plist(&p);
        // launchd prints no `pid` line for a job it holds but is not currently running.
        let rec = Recorder::ok(0, "{\n\tstate = waiting;\n}\n");
        let s = status(&p, DOMAIN, &|a| rec.run(a)).unwrap();
        assert!(s.loaded, "a job launchd knows about is loaded");
        assert_eq!(s.pid, None, "loaded is not the same claim as running");
    }

    #[test]
    fn a_job_launchd_does_not_have_is_not_loaded_however_many_plists_are_on_disk() {
        let (p, _dir) = scratch();
        write_plist(&p);
        // A leftover plist is the state an uninstall-that-failed leaves behind, and it is the one
        // a UI would most like to report as running.
        let rec = Recorder::ok(3, "");
        let s = status(&p, DOMAIN, &|a| rec.run(a)).unwrap();
        assert!(s.plist_present, "the plist is on disk");
        assert!(!s.loaded, "a plist on disk is not a job launchd has");
        assert_eq!(s.pid, None);
    }

    /* --------------------------------- the uid ---------------------------------- */

    #[test]
    fn the_domain_is_the_gui_domain_for_the_uid() {
        assert_eq!(domain(501), "gui/501");
        assert_eq!(domain(0), "gui/0", "root has a gui domain too");
    }

    #[test]
    fn parse_uid_takes_the_trailing_newline_and_rejects_everything_else() {
        assert_eq!(parse_uid("501\n").unwrap(), 501);
        assert_eq!(parse_uid(" 501 ").unwrap(), 501);
        assert!(parse_uid("").is_err(), "an empty answer is not a uid");
        assert!(parse_uid("nobody").is_err(), "a name is not a uid");
        assert!(parse_uid("-1").is_err(), "a negative is not a u32");
    }
}
