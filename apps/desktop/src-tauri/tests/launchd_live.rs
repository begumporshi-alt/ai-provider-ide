//! The live launchd check, as a command rather than a paragraph.
//!
//! **`#[ignore]`d on purpose, and the reason is the whole point of the file.** Registering a
//! `LaunchAgent` requires a process with an **Aqua session**. A shell spawned by an IDE, an agent
//! host or an SSH connection does not have one, and `launchctl bootstrap` answers
//! `5: Input/output error` there while `launchctl print gui/<uid>` still shows the domain alive and
//! well. Measured twice — 26a's throwaway probe and 26q's independent re-run — with the sandbox
//! ruled out by running outside it, the plist validated by `plutil -lint`, and the legacy
//! `load -w` and `bootstrap user/<uid>` failing identically. So this cannot be a gate step: on CI
//! it would go red for a reason that has nothing to do with the code, which is how a suite teaches
//! people to ignore it.
//!
//! Run it from **Terminal.app**, which launchd starts inside the GUI session:
//!
//! ```text
//! cd apps/desktop/src-tauri
//! cargo test --test launchd_live -- --ignored --nocapture
//! ```
//!
//! **A pass means one of two things, and which one is printed rather than inferred.** With no Aqua
//! session this prints `SKIP` and returns — that is a statement about the environment and *not* a
//! verification. With a session it asserts the real claim 26a could not close: **that
//! `service::install` produces a job launchd actually runs**, not merely one launchd accepted.
//! `bootstrap` registers a job; it does not exec the program, so acceptance and execution are
//! different facts and only the second one is the gateway being up. **A green run with no `SKIP`
//! line is the verification; a green run with one is not.** Read the output, not the exit code.
//!
//! It installs into a scratch directory rather than the real `~/Library/LaunchAgents`, so it cannot
//! disturb an agent that is already installed, and it uninstalls what it installed.
//!
//! **Three things this file covers (26v):**
//! 1. `install_produces_a_job_launchd_actually_runs` — a shell-script stand-in payload proves
//!    that `service::install` produces a job launchd actually *runs*, not merely accepts.
//! 2. `agent_serves_health_and_app_delegates` — a **real `aiproviderd`** binary (Tauri-free,
//!    built with `--no-default-features`) is installed as the agent payload, pointed at a scratch
//!    store via `AIP_DATA_DIR`, and its `/health` endpoint is asserted live. The probe-and-delegate
//!    path from Phase 6 step 4 (`probe_port` + `app_listener_action`) is then asserted against the
//!    agent's port: the delegation must read `Some(port)`, not `None`.
//! 3. **What it does not test, stated rather than implied.** It does not test that the *real*
//!    plist location is scanned at login — that needs a logout, and the real location is what 26b's
//!    UI control installs into.
//!
//! **The real-binary test (2) requires `aiproviderd` to be built first.** The test looks for
//! `target/debug/aiproviderd` and skips loudly (prints `SKIP: aiproviderd not built`) when it is
//! missing. Build it with:
//!
//! ```text
//! cd apps/desktop/src-tauri
//! cargo build --no-default-features --bin aiproviderd
//! ```

use ai_provider_router_lib::core::service::{self, Paths};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// How long launchd gets to spawn the job before the test calls it a failure. `RunAtLoad` starts it
/// as part of loading, so this is generous rather than tight.
const SPAWN_BUDGET: Duration = Duration::from_secs(20);

/// A payload that stays up with **no arguments**, because `render_plist` emits a one-element
/// `ProgramArguments` and names no interpreter.
///
/// It is a shell script relying on the kernel honouring the shebang, which is the ordinary
/// behaviour of `execve` and is **not** something this repository has measured before now — so if
/// the job loads and never gets a pid, suspect this before suspecting `install`. The marker file it
/// writes is the proof that *this* program ran rather than some other process launchd happened to
/// have.
fn payload(dir: &Path) -> PathBuf {
    let path = dir.join("payload");
    let marker = dir.join("marker.txt");
    std::fs::write(
        &path,
        format!("#!/bin/sh\nprintf 'ran\\n' > {}\nsleep 120\n", marker.display()),
    )
    .expect("the scratch directory must be writable");
    let mut perms = std::fs::metadata(&path).unwrap().permissions();
    std::os::unix::fs::PermissionsExt::set_mode(&mut perms, 0o755);
    std::fs::set_permissions(&path, perms).unwrap();
    path
}

/// A scratch install. Deliberately **not** the real `~/Library/LaunchAgents`: this must not be able
/// to clobber an agent someone is actually running.
///
/// `tag` distinguishes each test's scratch tree so parallel runs do not wipe each other's
/// installed binaries. Without it, test B's `remove_dir_all` fires while test A's launchd
/// job is still running, and test A's binary is gone before it can exec.
fn scratch(tag: &str) -> (Paths, PathBuf) {
    let root = std::env::temp_dir().join(format!("aip-launchd-live-{tag}"));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let home = root.join("home");
    let data = root.join("data");
    std::fs::create_dir_all(&data).unwrap();
    (service::paths(&home, &data), root)
}

/// Boot out any job a previous run left behind under the shared label.
///
/// Both tests use the same label (`dev.aiprovider.router`) in the same gui domain.
/// If a prior run panicked before its `uninstall`, the old job is still tracked by launchd
/// and `launchctl print` will report its (now-stale) pid. Booting out first makes
/// `bootstrap` the only source of the pid we assert on.
fn clean_stale(domain: &str) {
    let _ = service::run_launchctl(&["bootout", &format!("{domain}/{}", service::LABEL)]);
}

/// `launchctl`'s own words for "this process may not mutate that domain". Matching on the message
/// rather than on the exit code, because 5 is also what a malformed plist produces and those need
/// different responses: one is environmental and skips, the other is a defect and fails.
fn no_aqua_session(message: &str) -> bool {
    message.contains("Input/output error")
}

#[test]
#[ignore = "needs a process with an Aqua session; run from Terminal.app with --ignored"]
fn install_produces_a_job_launchd_actually_runs() {
    let (paths, root) = scratch("install");
    let uid = service::read_uid().expect("`id -u` must answer");
    let domain = service::domain(uid);
    clean_stale(&domain);
    let src = payload(&root);

    println!("scratch install at {}", root.display());
    println!("domain {domain}");

    match service::install(&paths, &src, &domain, &service::run_launchctl) {
        Ok(()) => {}
        Err(e) if no_aqua_session(&e.to_string()) => {
            // Environmental, not a defect — and loud, because a silent skip is indistinguishable
            // from a pass. This is the outcome every non-session caller gets.
            println!("\nSKIP: no Aqua session in this process.\n  launchctl said: {e}\n");
            println!("Run this from Terminal.app. Nothing was installed; the scratch tree is at");
            println!("{}", root.display());
            return;
        }
        Err(e) => panic!("install failed for a reason that is not the session: {e}"),
    }

    // `bootstrap` returned 0. That says launchd accepted the plist — **not** that it ran anything,
    // which is the whole reason this file exists.
    //
    // Two-phase poll: first the pid (launchd spawned the process), then the marker file (our
    // payload actually ran). The pid appears the moment `execve` returns, but the shell script's
    // `printf > marker.txt` takes a few milliseconds more. A single check right after the pid is
    // too early — this is what made the 26x run fail with `pid = Some(N), marker = false`.
    //
    // Also: `launchctl print gui/<uid>/<label>` returns a pid for the label that is loaded in
    // this domain. If a *previous* run left a stale job under the same label (and the prior
    // test panicked before its `uninstall`), the pid is not from this install. The marker file
    // is the proof that *this* payload ran, not some other process launchd happens to be tracking.
    let deadline = Instant::now() + SPAWN_BUDGET;
    let mut last = service::status(&paths, &domain, &service::run_launchctl)
        .expect("`launchctl print` must be answerable once the job is loaded");
    let mut marker = false;
    while Instant::now() < deadline {
        if last.pid.is_some() {
            marker = root.join("marker.txt").exists();
            if marker {
                break;
            }
        }
        std::thread::sleep(Duration::from_millis(250));
        last = service::status(&paths, &domain, &service::run_launchctl).expect("print");
    }

    let loaded = last.loaded;
    let pid = last.pid;
    let out_log = std::fs::read_to_string(&paths.out_log).unwrap_or_default();
    let err_log = std::fs::read_to_string(&paths.err_log).unwrap_or_default();

    // Always clean up, and always report whether the cleanup worked — a failed verification that
    // leaves a job loaded would turn one bad run into a broken machine.
    let uninstall = service::uninstall(&paths, &domain, &service::run_launchctl);
    let after = service::status(&paths, &domain, &service::run_launchctl);

    println!("\nloaded = {loaded}, pid = {pid:?}, marker written = {marker}");
    println!("job stdout: {out_log:?}");
    println!("job stderr: {err_log:?}");
    println!("uninstall: {uninstall:?}");
    println!("after uninstall: {after:?}");

    assert!(loaded, "`bootstrap` returned 0 but launchd does not have the job");
    assert!(
        pid.is_some(),
        "the job is loaded but never got a pid within {SPAWN_BUDGET:?} — launchd loaded it and \
         could not run it. Job stderr: {err_log:?}"
    );
    assert!(marker, "a pid exists but our payload never wrote its marker, so that pid is not ours");
    assert!(
        !paths.plist.exists() && !paths.binary.exists(),
        "uninstall must remove what install wrote"
    );
}

/// Phase 6 step 4, end-to-end: a **real `aiproviderd`** binary is installed as the agent payload,
/// its `/health` is asserted live, and the app's probe-and-delegate decision is pinned against the
/// agent's port.
///
/// **The payload is the Tauri-free `aiproviderd` binary, not a shell stand-in.** The first test
/// proves `service::install` runs a payload; this one proves the *gateway* runs behind it. The two
/// together close the loop: install → launchd execs `aiproviderd` → the binary opens its own store
/// → `gateway::spawn` binds → `/health` answers.
///
/// `AIP_DATA_DIR` reaches the agent via launchd's `EnvironmentVariables` dict (added to
/// `render_plist` in 26v), not via a wrapper script. The dict is empty in the production install
/// path, so the production plist is unchanged.
///
/// **Prerequisite:** `target/debug/aiproviderd` must exist. Without it this test skips loudly
/// (`SKIP: aiproviderd not built`), which is a statement about the build, not a pass.
#[test]
#[ignore = "needs a process with an Aqua session; run from Terminal.app with --ignored; requires `cargo build --no-default-features --bin aiproviderd` first"]
fn agent_serves_health_and_app_delegates() {
    use ai_provider_router_lib::core::gateway::{app_listener_action, probe_port};

    // The pre-built Tauri-free binary. Without it, the test cannot point the agent at a real
    // gateway and the 26t delegation has no live listener to assert against.
    let aip = target_dir().join("debug").join("aiproviderd");
    if !aip.is_file() {
        println!(
            "\nSKIP: {aip:?} not built.\n  Run: cargo build --no-default-features --bin aiproviderd\n  \
             Then re-run this test. Nothing was installed."
        );
        return;
    }

    let (mut paths, root) = scratch("agent");
    // Point the agent at a scratch store so it never touches the user's real application data.
    // `Store::open` creates the SQLite file and runs migrations on first use.
    paths.environment.insert("AIP_DATA_DIR".into(), paths.data_dir.display().to_string());

    let uid = service::read_uid().expect("`id -u` must answer");
    let domain = service::domain(uid);
    clean_stale(&domain);

    println!("scratch install at {}", root.display());
    println!("domain {domain}");
    println!("agent data dir: {}", paths.data_dir.display());

    match service::install(&paths, &aip, &domain, &service::run_launchctl) {
        Ok(()) => {}
        Err(e) if no_aqua_session(&e.to_string()) => {
            println!("\nSKIP: no Aqua session in this process.\n  launchctl said: {e}\n");
            println!("Run this from Terminal.app. Nothing was installed; the scratch tree is at");
            println!("{}", root.display());
            return;
        }
        Err(e) => panic!("install failed for a reason that is not the session: {e}"),
    }

    // Wait for launchd to spawn the agent and for the gateway to be up.
    // `aiproviderd`'s `main` blocks on `pending()` after `gateway::spawn`, so the pid is
    // present the moment launchd execs it — before the tokio runtime has finished binding.
    // The port poll below is what pins the bind; the pid poll pins the exec.
    let deadline = Instant::now() + SPAWN_BUDGET;
    let mut last = service::status(&paths, &domain, &service::run_launchctl)
        .expect("`launchctl print` must be answerable once the job is loaded");
    while last.pid.is_none() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(250));
        last = service::status(&paths, &domain, &service::run_launchctl).expect("print");
    }

    let loaded = last.loaded;
    let pid = last.pid;

    if pid.is_none() {
        let out_log = std::fs::read_to_string(&paths.out_log).unwrap_or_default();
        let err_log = std::fs::read_to_string(&paths.err_log).unwrap_or_default();
        let _ = service::uninstall(&paths, &domain, &service::run_launchctl);
        println!("\nloaded = {loaded}, pid = None");
        println!("job stdout: {out_log:?}");
        println!("job stderr: {err_log:?}");
        panic!(
            "the job is loaded but never got a pid within {SPAWN_BUDGET:?} — launchd loaded it \
             and could not run it. Job stderr: {err_log:?}",
        );
    }

    // **The 26t assertion against a live agent, not a seam.** The agent's port is the one the
    // `aiproviderd` binary read from `persisted_gateway_port` (or fell back to `SERVICE_DEFAULT_PORT`
    // = 8800 when no setting row exists yet — which is the shape of a fresh scratch store).
    //
    // Polling rather than a single probe: `pid` is present the moment `tokio::main` starts running,
    // but `gateway::spawn` (the async `TcpListener::bind`) can complete up to several seconds after
    // that. One probe against a not-yet-bound socket is `ECONNREFUSED` — a false negative that makes
    // the test assert the gateway is down while it is still coming up.
    const PORT_POLL_INTERVAL: Duration = Duration::from_millis(200);
    const PORT_POLL_BUDGET: Duration = Duration::from_secs(30);
    let port_deadline = Instant::now() + PORT_POLL_BUDGET;
    let probe = loop {
        let p = probe_port(8800, PORT_POLL_INTERVAL);
        if p.is_ok() || Instant::now() >= port_deadline {
            break p;
        }
        std::thread::sleep(PORT_POLL_INTERVAL);
    };
    let action = app_listener_action(&probe, 8800);
    println!("probe: {probe:?}");
    println!("app_listener_action: {action:?}");

    let out_log = std::fs::read_to_string(&paths.out_log).unwrap_or_default();
    let err_log = std::fs::read_to_string(&paths.err_log).unwrap_or_default();

    // Always clean up, and always report whether the cleanup worked — a failed verification that
    // leaves a job loaded would turn one bad run into a broken machine.
    let uninstall = service::uninstall(&paths, &domain, &service::run_launchctl);
    let after = service::status(&paths, &domain, &service::run_launchctl);

    println!("\nloaded = {loaded}, pid = {pid:?}");
    println!("job stdout: {out_log:?}");
    println!("job stderr: {err_log:?}");
    println!("uninstall: {uninstall:?}");
    println!("after uninstall: {after:?}");

    assert!(loaded, "`bootstrap` returned 0 but launchd does not have the job");
    assert!(
        action.is_some(),
        "probe = {probe:?} but the app must delegate (the agent is serving on 8800). If this \
         failed, either the agent did not bind 8800 (check the stdout/stderr above) or the probe \
         did not see it (check the port the agent actually bound)."
    );
    assert!(
        !paths.plist.exists() && !paths.binary.exists(),
        "uninstall must remove what install wrote"
    );
}

/// `aiproviderd` is built into `target/debug/` by `cargo build --no-default-features --bin
/// aiproviderd`. The test harness runs from `src-tauri/`, so the target dir is two levels up.
fn target_dir() -> PathBuf {
    // CARGO_TARGET_DIR (if set by cargo) points at the target/ dir directly;
    // otherwise target/ lives in CARGO_MANIFEST_DIR.
    match std::env::var("CARGO_TARGET_DIR") {
        Ok(d) => PathBuf::from(d),
        Err(_) => Path::new(env!("CARGO_MANIFEST_DIR")).join("target"),
    }
}
