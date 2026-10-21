//! Android device verification over adb (2026-10-20).
//!
//! The browser tools drive Chrome on this machine. This module reaches an already-running
//! Android emulator or USB device through adb, opens a URL in its browser, and captures the
//! screen into the workspace. It deliberately does not install apps, run arbitrary shell
//! commands, or start an emulator: the device must be connected, and every error names that
//! precondition.

use std::path::PathBuf;
use std::process::{Command, Output};
use std::time::Duration;

use base64::Engine as _;
use serde_json::Value;

use crate::core::tools::{save_tool_binary, ToolResult};

/// The screenshot is a PNG; the same 8 MB cap the browser capture uses.
const MAX_SCREENSHOT_BYTES: usize = 8 * 1024 * 1024;

#[cfg(windows)]
fn adb_name() -> &'static str {
    "adb.exe"
}
#[cfg(not(windows))]
fn adb_name() -> &'static str {
    "adb"
}

/// The first adb on this machine: the Android SDK env vars, the two default installs, then PATH.
fn find_adb() -> Result<PathBuf, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    for key in ["ANDROID_HOME", "ANDROID_SDK_ROOT"] {
        if let Some(root) = std::env::var_os(key) {
            candidates.push(PathBuf::from(root).join("platform-tools").join(adb_name()));
        }
    }
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        candidates.push(home.join("Library/Android/sdk/platform-tools").join(adb_name()));
        candidates.push(home.join("Android/Sdk/platform-tools").join(adb_name()));
    }
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path).map(|dir| dir.join(adb_name())));
    }
    candidates.into_iter().find(|p| p.is_file()).ok_or_else(|| {
        "adb was not found — install Android platform-tools or set ANDROID_HOME".to_string()
    })
}

fn run_adb(args: &[&str]) -> Result<Output, String> {
    let adb = find_adb()?;
    let out = Command::new(&adb)
        .args(args)
        .output()
        .map_err(|e| format!("cannot run {}: {e}", adb.display()))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let stderr = stderr.trim();
        return Err(if stderr.is_empty() {
            format!("adb {} exited with {:?}", args.join(" "), out.status.code())
        } else {
            format!("adb {} failed: {stderr}", args.join(" "))
        });
    }
    Ok(out)
}

#[derive(Debug, Clone)]
struct Device {
    serial: String,
    state: String,
    model: String,
}

fn devices() -> Result<Vec<Device>, String> {
    let out = run_adb(&["devices", "-l"])?;
    let text = String::from_utf8_lossy(&out.stdout);
    let mut found = Vec::new();
    for line in text.lines().skip(1) {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let mut parts = line.split_whitespace();
        let serial = parts.next().unwrap_or_default().to_string();
        let state = parts.next().unwrap_or_default().to_string();
        let model = parts
            .find_map(|p| p.strip_prefix("model:").map(ToString::to_string))
            .unwrap_or_default();
        found.push(Device { serial, state, model });
    }
    Ok(found)
}

fn serial_of(args: &Value, devices: &[Device]) -> Result<String, String> {
    if let Some(serial) = args.get("serial").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
        if devices.iter().any(|d| d.serial == serial) {
            return Ok(serial.to_string());
        }
        return Err(format!(
            "no Android device with serial \"{serial}\" — device_list shows what is connected"
        ));
    }
    devices
        .iter()
        .find(|d| d.state == "device")
        .map(|d| d.serial.clone())
        .ok_or_else(|| {
            "no Android device is ready — start an emulator or connect a device with USB debugging (adb devices -l shows the state)".to_string()
        })
}

/// `device_list`: what adb sees right now.
pub fn device_list(_args: &Value) -> ToolResult {
    match (|| -> Result<String, String> {
        let adb = find_adb()?;
        let devices = devices()?;
        if devices.is_empty() {
            return Ok(
                "no Android device or emulator is connected — start an AVD or connect a device with USB debugging"
                    .to_string(),
            );
        }
        let mut out = format!("adb: {}\n", adb.display());
        for d in devices {
            out.push_str(&format!(
                "{}  {}  {}\n",
                d.serial,
                d.state,
                if d.model.is_empty() { "(no model)" } else { &d.model }
            ));
        }
        Ok(out.trim_end().to_string())
    })() {
        Ok(text) => ToolResult::ok(text),
        Err(e) => ToolResult::err(e),
    }
}

/// `device_open_url`: open a URL in the connected device's default browser and wait briefly for
/// it to load. `10.0.2.2` reaches the host from the standard Android emulator.
pub fn device_open_url(args: &Value) -> ToolResult {
    match (|| -> Result<String, String> {
        let url = args.get("url").and_then(|v| v.as_str()).ok_or("missing argument \"url\"")?;
        if !url.starts_with("http://") && !url.starts_with("https://") {
            return Err("\"url\" must start with http:// or https://".into());
        }
        let devices = devices()?;
        let serial = serial_of(args, &devices)?;
        let wait_ms = args.get("wait_ms").and_then(|v| v.as_u64()).unwrap_or(1500).min(10_000);
        run_adb(&[
            "-s",
            serial.as_str(),
            "shell",
            "am",
            "start",
            "-W",
            "-a",
            "android.intent.action.VIEW",
            "-d",
            url,
        ])?;
        std::thread::sleep(Duration::from_millis(wait_ms));
        Ok(format!("opened {url} on {serial}"))
    })() {
        Ok(text) => ToolResult::ok(text),
        Err(e) => ToolResult::err(e),
    }
}

/// `device_screenshot`: capture the connected device's screen as a PNG in the workspace and
/// return the READ_IMAGE marker, so a vision model sees the real device in the same turn.
pub fn device_screenshot(args: &Value, root: &std::path::Path) -> ToolResult {
    match (|| -> Result<String, String> {
        let devices = devices()?;
        let serial = serial_of(args, &devices)?;
        let out = run_adb(&["-s", serial.as_str(), "exec-out", "screencap", "-p"])?;
        let bytes = out.stdout;
        if bytes.len() > MAX_SCREENSHOT_BYTES {
            return Err("the device screenshot is over the 8 MB image cap".into());
        }
        if !bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
            return Err(
                "adb returned something that is not a PNG — is the device unlocked and awake?"
                    .into(),
            );
        }
        let rel = match args.get("path").and_then(|v| v.as_str()) {
            Some(p) if !p.is_empty() => p.to_string(),
            _ => {
                let safe: String =
                    serial
                        .chars()
                        .map(|c| {
                            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                                c
                            } else {
                                '-'
                            }
                        })
                        .collect();
                format!(
                    "images/device-{safe}-{}.png",
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_millis())
                        .unwrap_or(0)
                )
            }
        };
        save_tool_binary(root, &rel, &bytes, "png")?;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        Ok(format!("READ_IMAGE:image/png;base64,{b64}\npath: {rel}\nbytes: {}", bytes.len()))
    })() {
        Ok(text) => ToolResult::ok(text),
        Err(e) => ToolResult::err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_url_must_be_http_before_adb_is_touched() {
        let res = device_open_url(&json!({ "url": "file:///etc/passwd" }));
        assert!(!res.ok);
        assert!(res.error.unwrap_or_default().contains("http://"));
    }

    #[test]
    fn device_list_reports_adb_absence_or_a_real_list() {
        let res = device_list(&json!({}));
        match find_adb() {
            Ok(_) => assert!(res.ok, "adb exists, so device_list must answer: {:?}", res.error),
            Err(_) => {
                let reason = res.error.unwrap_or_default();
                assert!(reason.contains("adb was not found"), "got: {reason}");
            }
        }
    }

    #[test]
    fn a_connected_device_can_be_captured() {
        let Ok(devices) = devices() else { return };
        let Some(device) = devices.iter().find(|d| d.state == "device") else { return };
        let dir =
            std::env::temp_dir().join(format!("aiprovider-device-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let res = device_screenshot(
            &json!({ "serial": device.serial, "path": "images/device-test.png" }),
            &dir,
        );
        assert!(res.ok, "screenshot: {:?}", res.error);
        assert!(std::fs::read(dir.join("images/device-test.png"))
            .unwrap()
            .starts_with(&[0x89, b'P', b'N', b'G']));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
