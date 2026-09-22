//! Crash reporting (L0): local, no-telemetry crash capture.
//!
//! Panic reports are written as JSON files into `{app_data_dir}/crashes/`. Each report
//! contains a timestamp, message, backtrace, OS info, and app version. Reports survive
//! restarts and are surfaced to the user on next launch via the Settings screen.
//!
//! Design invariants:
//! - No external service calls — reports are purely local filesystem artifacts.
//! - No secrets in backtraces (RUST_BACKTRACE=1 is controlled; we snapshot it ourselves).
//! - Reports are included in the diagnostics bundle for bug reports.
//! - User can dismiss/clear reports from the UI.

use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};

/// A single crash report entry. Serialized to JSON on disk.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct CrashReport {
    pub id: String,          // ISO-8601 timestamp, also the filename stem
    pub ts: i64,             // unix ms
    pub message: String,
    pub backtrace: String,
    pub os: String,
    pub arch: String,
    pub app_version: String,
}

const CRASHES_DIR_NAME: &str = "crashes";

/// Return the directory path where crash reports live.
pub fn crashes_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(CRASHES_DIR_NAME)
}

/// Write a crash report to disk. Returns the report id (also the filename stem).
/// The `message` field stores the human-readable summary; `backtrace` stores the raw trace.
pub fn write_crash_report(
    app_data_dir: &Path,
    message: &str,
    backtrace: &str,
) -> String {
    let id = precise_now_ms();
    let ts_str = millis_to_iso(id);
    let report = CrashReport {
        id: ts_str.clone(),
        ts: id,
        message: message.to_string(),
        backtrace: backtrace.to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
    };
    let dir = crashes_dir(app_data_dir);
    let _ = fs::create_dir_all(&dir);
    let path = dir.join(format!("{ts_str}.json"));
    if let Ok(bytes) = serde_json::to_string_pretty(&report) {
        let _ = fs::File::create(&path).and_then(|mut f| f.write_all(bytes.as_bytes()));
    }
    ts_str
}

/// List all crash report ids (ISO strings), newest first.
pub fn list_crash_reports(app_data_dir: &Path) -> Vec<String> {
    let dir = crashes_dir(app_data_dir);
    if !dir.is_dir() {
        return Vec::new();
    }
    let mut entries: Vec<String> = fs::read_dir(&dir)
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().is_some_and(|ext| ext == "json"))
        .filter_map(|e| {
            e.file_name()
                .to_string_lossy()
                .strip_suffix(".json")
                .map(|s| s.to_string())
        })
        .collect();
    entries.sort_by(|a, b| b.cmp(a)); // newest first (ISO strings sort correctly)
    entries
}

/// Read a crash report by its id (filename stem). Returns None if not found.
pub fn read_crash_report(app_data_dir: &Path, id: &str) -> Option<CrashReport> {
    let path = crashes_dir(app_data_dir).join(format!("{id}.json"));
    let bytes = fs::read_to_string(path).ok()?;
    serde_json::from_str(&bytes).ok()
}

/// Delete a single crash report by id. Returns true if it existed.
pub fn clear_crash_report(app_data_dir: &Path, id: &str) -> bool {
    let path = crashes_dir(app_data_dir).join(format!("{id}.json"));
    fs::remove_file(path).is_ok()
}

/// Delete all crash reports. Returns the count removed.
pub fn clear_all_crash_reports(app_data_dir: &Path) -> usize {
    let dir = crashes_dir(app_data_dir);
    if !dir.is_dir() {
        return 0;
    }
    let mut count = 0;
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            if entry.path().extension().is_some_and(|ext| ext == "json") {
                let _ = fs::remove_file(entry.path());
                count += 1;
            }
        }
    }
    // Best-effort dir removal after clearing.
    let _ = fs::remove_dir(&dir);
    count
}

/// Count of unreviewed (still on disk) crash reports.
pub fn crash_count(app_data_dir: &Path) -> usize {
    list_crash_reports(app_data_dir).len()
}

/// Snapshot the current backtrace as a string. Returns empty string if unwinding was not active.
pub fn snapshot_backtrace() -> String {
    let bt = std::backtrace::Backtrace::capture();
    match bt.status() {
        std::backtrace::BacktraceStatus::Disabled => String::new(),
        _ => bt.to_string(),
    }
}

/// Install the global panic hook. Must be called once at app startup (before any threads spawn).
/// Panics are caught, reported to stderr, and written to a crash report file.
pub fn install_panic_hook(app_data_dir: PathBuf) {
    let original_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // Let the default hook run first (prints to stderr).
        original_hook(info);

        let msg = if let Some(s) = info.payload().downcast_ref::<&str>() {
            s.to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "unknown panic".to_string()
        };

        let location = if let Some(loc) = info.location() {
            format!("{}:{}:{}", loc.file(), loc.line(), loc.column())
        } else {
            "unknown location".to_string()
        };

        let backtrace = snapshot_backtrace();
        // The backtrace travels as its own field of the report (the third argument below), so the
        // summary does not encode whether one was captured. An earlier version branched on
        // `backtrace.is_empty()` here and built the *same* string in both arms — a dead branch that
        // implied a distinction the report does not make. Removed; see `clippy::if_same_then_else`.
        let location_msg = format!("{msg} — {location}");

        let _ = write_crash_report(&app_data_dir, &location_msg, &backtrace);
    }));
}

// ── helpers ──────────────────────────────────────────────────────────────────

/// Nanosecond-precise timestamp for unique crash report IDs even under rapid successive calls.
fn precise_now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| {
            // Use seconds * 1_000_000 + subsec_micros for microsecond uniqueness
            // (nanoseconds would overflow i64 for typical unix epoch values).
            ((d.as_secs() as i64) * 1_000_000) + (d.subsec_micros() as i64)
        })
        .unwrap_or(0)
}

fn millis_to_iso(ms: i64) -> String {
    // Format as YYYY-MM-DDTHH:MM:SS.sssZ without needing chrono.
    let secs = ms / 1000;
    let millis = (ms % 1000) as u32;
    let total_secs = secs as u64;
    // Simple UTC conversion (sufficient for crash timestamps).
    let mut unix = total_secs;
    // Days since epoch
    let days = unix / 86400;
    unix %= 86400;
    let secs_rem = unix;
    let mins = secs_rem / 60;
    let secs = secs_rem % 60;
    let hours = mins / 60;
    let mins_rem = mins % 60;

    // Convert days since Unix epoch to Y-M-D (simplified, good enough for recent dates).
    // Unix epoch = Thursday, Jan 1, 1970.
    let mut y = 1970u32;
    let mut d = days as u32;
    loop {
        let leap = is_leap(y);
        let year_days = if leap { 366 } else { 365 };
        if d < year_days {
            break;
        }
        d -= year_days;
        y += 1;
    }
    let leap = is_leap(y);
    let month_days = month_days_array(leap);
    let mut m = 1u32;
    while m <= 12 {
        if d < month_days[m as usize - 1] {
            break;
        }
        d -= month_days[m as usize - 1];
        m += 1;
    }
    let day = d + 1;

    format!(
        "{y:04}-{m:02}-{day:02}T{hours:02}:{mins_rem:02}:{secs:02}.{millis:03}Z"
    )
}

fn is_leap(year: u32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0)
}

fn month_days_array(leap: bool) -> [u32; 12] {
    [
        31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
    ]
}

// ── tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("aip-crash-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn write_and_read_crash_report() {
        let dir = temp_dir("write_read");
        let id = write_crash_report(&dir, "test panic", "stack trace line 1\nstack trace line 2");
        assert!(!id.is_empty());

        let reports = list_crash_reports(&dir);
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0], id);

        let report = read_crash_report(&dir, &id).expect("report exists");
        assert_eq!(report.message, "test panic");
        assert_eq!(report.backtrace, "stack trace line 1\nstack trace line 2");
        assert_eq!(report.os, std::env::consts::OS);
        assert_eq!(report.arch, std::env::consts::ARCH);
        assert_eq!(report.app_version, env!("CARGO_PKG_VERSION"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn clear_all_removes_reports() {
        let dir = temp_dir("clear_all");
        write_crash_report(&dir, "crash 1", "bt1");
        write_crash_report(&dir, "crash 2", "bt2");
        write_crash_report(&dir, "crash 3", "bt3");
        assert_eq!(crash_count(&dir), 3);

        let removed = clear_all_crash_reports(&dir);
        assert_eq!(removed, 3);
        assert_eq!(crash_count(&dir), 0);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn clear_single_report() {
        let dir = temp_dir("clear_one");
        let id1 = write_crash_report(&dir, "crash 1", "bt1");
        let id2 = write_crash_report(&dir, "crash 2", "bt2");
        assert!(clear_crash_report(&dir, &id1));
        assert!(!clear_crash_report(&dir, &id1)); // already gone
        assert_eq!(crash_count(&dir), 1);
        assert!(read_crash_report(&dir, &id2).is_some());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_returns_newest_first() {
        let dir = temp_dir("sort_order");
        let id1 = write_crash_report(&dir, "first", "bt");
        std::thread::sleep(std::time::Duration::from_millis(10));
        let id2 = write_crash_report(&dir, "second", "bt");
        let ids = list_crash_reports(&dir);
        assert_eq!(ids, vec![id2, id1]);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn millis_to_iso_is_readable() {
        let ms = 1758000000000i64; // ~2025-09-16
        let iso = millis_to_iso(ms);
        assert!(iso.starts_with("2025-"));
        assert!(iso.ends_with("Z"));
        assert!(iso.contains('T'));
    }
}
