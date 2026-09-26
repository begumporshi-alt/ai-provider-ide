//! The five service commands, re-attached to Tauri.
//!
//! **The logic lives in `core::service`, and these wrappers add none** — the same rule
//! `tools_cmds.rs` states for the tool host, and for the same reason. If one of them grows a line
//! of policy, that line belongs where a future headless caller can reach it; otherwise the app
//! and anything else that installs the agent enforce two slightly different installs, which is
//! the failure the `core`/`tauri` split exists to prevent.
//!
//! What these *do* own is the two things only a running app can answer: where its home and data
//! directories are, and which uid it is running as. `core::service` takes both as arguments
//! precisely so it does not have to know.

use std::path::PathBuf;

use tauri::Manager as _;

use crate::core::service;

/// The two directories and the domain, resolved once for whichever command asked.
///
/// Three separate failures rather than one, because "cannot find your home directory" and "cannot
/// find your data directory" have different remedies and a merged message would erase which.
fn context(app: &tauri::AppHandle) -> Result<(service::Paths, String), String> {
    let home =
        app.path().home_dir().map_err(|e| format!("cannot resolve the home directory: {e}"))?;
    let data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("cannot resolve the app data directory: {e}"))?;
    let uid = service::read_uid().map_err(|e| e.to_string())?;
    Ok((service::paths(&home, &data), service::domain(uid)))
}

/// The service binary this app shipped with: the sibling of the running executable.
///
/// `tauri build` copies every `[[bin]]` next to the main one, so in a bundle this is
/// `…/Contents/MacOS/aiproviderd` and in a dev build `target/debug/aiproviderd`. The existence
/// check is load-bearing rather than defensive: without it a missing binary fails much later as
/// `launchctl bootstrap` refusing a path that does not exist, and the message names neither the
/// path nor the remedy.
fn bundled_binary() -> Result<PathBuf, String> {
    let exe = std::env::current_exe()
        .map_err(|e| format!("cannot resolve the running executable: {e}"))?;
    let dir = exe.parent().ok_or_else(|| format!("{exe:?} has no parent directory"))?;
    let binary = dir.join("aiproviderd");
    if !binary.is_file() {
        return Err(format!(
            "{} is missing — build it with `cargo build --bin aiproviderd`",
            binary.display()
        ));
    }
    Ok(binary)
}

/// Install the login-item service: copy `aiproviderd` to its stable path, write the LaunchAgent
/// plist, and hand the job to launchd. Returns where it put things, so the UI can say so.
#[tauri::command]
pub fn service_install(app: tauri::AppHandle) -> Result<service::Paths, String> {
    let (paths, domain) = context(&app)?;
    let source = bundled_binary()?;
    service::install(&paths, &source, &domain, &service::run_launchctl)
        .map_err(|e| e.to_string())?;
    Ok(paths)
}

/// Remove the job and the files that defined it.
#[tauri::command]
pub fn service_uninstall(app: tauri::AppHandle) -> Result<(), String> {
    let (paths, domain) = context(&app)?;
    service::uninstall(&paths, &domain, &service::run_launchctl).map_err(|e| e.to_string())
}

/// Bring the installed job up — `bootstrap` if launchd has never had it, `kickstart` if it holds it
/// but is not running it. See `service::start`; the branch is there because `bootstrap` refuses a
/// label launchd already holds, and the throttled-after-a-restart state is exactly that.
///
/// **This is the command that has to run in the app.** Registering a `LaunchAgent` needs an Aqua
/// session, and the app is the process that has one — which is the whole reason the login-item
/// control is a button rather than a line in the README. `aiproviderd install` from a shell without
/// a session answers `5: Input/output error`. That shape is the one `service::describe_failure`
/// recognises, so a refusal here reaches the card with the cause appended rather than bare.
#[tauri::command]
pub fn service_start(app: tauri::AppHandle) -> Result<(), String> {
    let (paths, domain) = context(&app)?;
    service::start(&paths, &domain, &service::run_launchctl).map_err(|e| e.to_string())
}

/// Take the job down without uninstalling it: the plist survives, so `service_start` brings it back.
#[tauri::command]
pub fn service_stop(app: tauri::AppHandle) -> Result<(), String> {
    let (paths, domain) = context(&app)?;
    service::stop(&paths, &domain, &service::run_launchctl).map_err(|e| e.to_string())
}

/// Is the service installed, is launchd holding it, and is it up?
///
/// Never fails for the ordinary "not installed" case: launchd not having the job is the answer
/// this command exists to give, not an error.
#[tauri::command]
pub fn service_status(app: tauri::AppHandle) -> Result<service::Status, String> {
    let (paths, domain) = context(&app)?;
    service::status(&paths, &domain, &service::run_launchctl).map_err(|e| e.to_string())
}
