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
//! - A report's id *is* its filename, and it encodes when the crash happened, so the directory
//!   listing sorts into the chronology the reports record.

use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};

use crate::core::injection_log::now_ms;

/// A single crash report entry. Serialized to JSON on disk.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct CrashReport {
    /// The report's identity, and the stem of its file under `crashes/`.
    ///
    /// UTC to the millisecond, shaped `2026-10-03T10.04.51.895Z`. The time separators are dots
    /// rather than the colons of strict ISO-8601 because this string is also a filename, and `:`
    /// is not legal in a Windows filename. The form is fixed-width, so a plain lexicographic
    /// sort is a chronological sort. A `-2`, `-3`, … suffix appears only when two reports were
    /// written inside the same millisecond.
    pub id: String,
    /// Unix **milliseconds** — the unit the rest of the store uses, and the exact value `id` is
    /// formatted from, so the two can never disagree.
    pub ts: i64,
    pub message: String,
    pub backtrace: String,
    pub os: String,
    pub arch: String,
    pub app_version: String,
}

const CRASHES_DIR_NAME: &str = "crashes";

/// How many same-millisecond reports one id can absorb before we give up. A panic aborts the
/// process, so in practice a millisecond never sees more than a couple of writers; the ceiling
/// exists only so that a full or read-only directory cannot spin here.
const SAME_MS_ATTEMPTS: u32 = 64;

/// Return the directory path where crash reports live.
pub fn crashes_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(CRASHES_DIR_NAME)
}

/// Write a crash report to disk. Returns the report id (also the filename stem).
/// The `message` field stores the human-readable summary; `backtrace` stores the raw trace.
///
/// Called from the panic hook, so it must not panic and must not loop unboundedly — losing the
/// report here loses the only evidence the crash happened. The write is best-effort, and the id
/// is returned even when nothing could be written, because the caller has nowhere to report it.
pub fn write_crash_report(app_data_dir: &Path, message: &str, backtrace: &str) -> String {
    let ts = now_ms();
    let dir = crashes_dir(app_data_dir);
    let base = iso_id(ts);
    let mut report = CrashReport {
        id: base.clone(),
        ts,
        message: message.to_string(),
        backtrace: backtrace.to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
    };
    write_unique(&dir, &base, &mut report).unwrap_or(base)
}

/// Serialize `report` into the first free `<base>[-N].json` under `dir`, claiming the name
/// atomically, and return the id it was stored under.
///
/// The suffix is how uniqueness is achieved, rather than by folding sub-millisecond time into
/// the id: `ts` stays a plain, readable millisecond value that agrees with `id`, and `create_new`
/// means a claimed name is never overwritten — two reports in one millisecond become two files.
fn write_unique(dir: &Path, base: &str, report: &mut CrashReport) -> Option<String> {
    let _ = fs::create_dir_all(dir);
    for attempt in 1..=SAME_MS_ATTEMPTS {
        let id = if attempt == 1 { base.to_string() } else { format!("{base}-{attempt}") };
        report.id = id.clone();
        let Ok(bytes) = serde_json::to_string_pretty(&*report) else { return None };
        let path = dir.join(format!("{id}.json"));
        match fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                let _ = file.write_all(bytes.as_bytes());
                return Some(id);
            }
            // Taken by another report in this same millisecond — try the next suffix.
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return None,
        }
    }
    None
}

/// List all crash report ids, newest first. An id is its file's stem and is fixed-width, so a
/// plain string sort of the directory is a chronological sort.
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
            e.file_name().to_string_lossy().strip_suffix(".json").map(|s| s.to_string())
        })
        .collect();
    entries.sort_by(|a, b| b.cmp(a)); // newest first — the id form sorts chronologically
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

/// A report id for a unix-millisecond instant: filesystem-safe UTC, fixed width, so ids sort
/// chronologically as plain strings.
fn iso_id(ms: i64) -> String {
    // A clock before 1970 is not a crash we can usefully date; clamp rather than emit a negative
    // year the zero-padding cannot express.
    let ms = ms.max(0);
    let (days, rem) = (ms / 86_400_000, ms % 86_400_000);
    let (y, mo, d) = civil_from_days(days);
    let (h, mi, s, milli) =
        (rem / 3_600_000, (rem / 60_000) % 60, (rem / 1_000) % 60, rem % 1_000);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}.{mi:02}.{s:02}.{milli:03}Z")
}

/// Days since 1970-01-01 → `(year, month, day)`, by Howard Hinnant's `civil_from_days`.
///
/// Constant time and exact across the whole `i64` range. This replaces subtracting a year's worth
/// of days in a loop until the remainder fit: that version ran inside the panic hook, where an
/// unbounded loop is a liability, and it cast the day count to `u32`, dropping the high bits of
/// any large value.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// True for an id written before the timestamp-unit fix, which carries a five-digit year
/// (`58722-…`): `write_crash_report` fed a microsecond value to a millisecond formatter, so the
/// year it printed ran thousands of years past the one the crash happened in.
fn is_legacy_id(id: &str) -> bool {
    let year = id.split('-').next().unwrap_or("");
    year.len() > 4 && year.bytes().all(|b| b.is_ascii_digit())
}

/// Re-home reports written by the microsecond-as-millisecond bug, so each id matches its own
/// timestamp again.
///
/// Their `ts` was always right — microseconds — so the repair divides it into milliseconds and
/// reformats the id, then renames. Best-effort and idempotent: a well-formed report is left
/// alone, and the corrected copy is written *before* the old file is removed, so a failure
/// halfway leaves a readable original rather than nothing at all.
pub fn repair_legacy_reports(app_data_dir: &Path) {
    let dir = crashes_dir(app_data_dir);
    let Ok(entries) = fs::read_dir(&dir) else { return };
    for path in entries.flatten().map(|e| e.path()) {
        if path.extension().is_none_or(|ext| ext != "json") {
            continue;
        }
        let Some(stem) = path.file_stem().map(|s| s.to_string_lossy().into_owned()) else {
            continue;
        };
        if !is_legacy_id(&stem) {
            continue;
        }
        let Ok(bytes) = fs::read_to_string(&path) else { continue };
        let Ok(mut report) = serde_json::from_str::<CrashReport>(&bytes) else { continue };
        report.ts /= 1_000;
        let base = iso_id(report.ts);
        if write_unique(&dir, &base, &mut report).is_some() {
            let _ = fs::remove_file(&path);
        }
    }
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
    fn iso_id_is_fixed_width_and_correct() {
        assert_eq!(iso_id(0), "1970-01-01T00.00.00.000Z");
        assert_eq!(iso_id(1_700_000_000_000), "2023-11-14T22.13.20.000Z");
        // A leap day, so the calendar is exercised rather than just the clock.
        assert_eq!(iso_id(1_709_164_800_000), "2024-02-29T00.00.00.000Z");
        // Fixed width is what makes a plain string sort chronological.
        assert_eq!(iso_id(0).len(), iso_id(1_700_000_000_000).len());
    }

    /// The bug this module shipped with: `ts` held microseconds while its doc — and the
    /// formatter — said milliseconds, so ids came out as `58722-…`. A millisecond stamp must fall
    /// between two `now_ms()` readings taken either side of the write, and the id must restate it.
    #[test]
    fn a_report_is_stamped_in_milliseconds_and_its_id_agrees() {
        let dir = temp_dir("units");
        let before = now_ms();
        let id = write_crash_report(&dir, "boom", "");
        let after = now_ms();

        let report = read_crash_report(&dir, &id).expect("report exists");
        assert!(
            (before..=after).contains(&report.ts),
            "ts {} is not a millisecond clock between {before} and {after}",
            report.ts
        );
        assert_eq!(report.id, id);
        assert_eq!(id, iso_id(report.ts), "the id is the timestamp, formatted");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn same_millisecond_reports_get_their_own_files() {
        let dir = temp_dir("collide");
        let crashes = crashes_dir(&dir);
        let ts = 1_800_000_000_000i64;
        let make = || CrashReport {
            id: String::new(),
            ts,
            message: "boom".into(),
            backtrace: String::new(),
            os: "macos".into(),
            arch: "aarch64".into(),
            app_version: "1.2.0".into(),
        };

        let first = write_unique(&crashes, &iso_id(ts), &mut make()).expect("first write");
        let second = write_unique(&crashes, &iso_id(ts), &mut make()).expect("second write");

        assert_eq!(first, iso_id(ts));
        assert_eq!(second, format!("{}-2", iso_id(ts)), "the second claims a suffixed name");
        assert_eq!(list_crash_reports(&dir), vec![second, first], "both survive, newest first");
        let _ = fs::remove_dir_all(&dir);
    }

    /// Rebuilds the exact shape the bug left on disk — a fifth-millennium id over a microsecond
    /// `ts` — and checks the report is re-homed onto its real timestamp, once.
    #[test]
    fn repair_rehomes_reports_written_by_the_unit_bug() {
        let dir = temp_dir("repair");
        let crashes = crashes_dir(&dir);
        fs::create_dir_all(&crashes).unwrap();

        let ms = 1_790_951_191_491i64; // 2026-10-02T14.26.31.491Z
        let legacy_id = "58722-12-26T18:04:51.895Z";
        let legacy = CrashReport {
            id: legacy_id.into(),
            ts: ms * 1_000, // microseconds, exactly as the buggy writer stored them
            message: "boom".into(),
            backtrace: String::new(),
            os: "macos".into(),
            arch: "aarch64".into(),
            app_version: "1.2.0".into(),
        };
        fs::write(
            crashes.join(format!("{legacy_id}.json")),
            serde_json::to_string_pretty(&legacy).unwrap(),
        )
        .unwrap();
        assert_eq!(crash_count(&dir), 1);

        repair_legacy_reports(&dir);
        repair_legacy_reports(&dir); // idempotent — a second pass must change nothing

        let ids = list_crash_reports(&dir);
        assert_eq!(ids, vec![iso_id(ms)], "the legacy name is gone and the repaired one is here");
        assert!(!crashes.join(format!("{legacy_id}.json")).exists());
        let recovered = read_crash_report(&dir, &ids[0]).expect("repaired report reads back");
        assert_eq!(recovered.ts, ms, "ts is milliseconds after the repair");
        assert_eq!(recovered.message, "boom", "nothing else about the report changed");
        let _ = fs::remove_dir_all(&dir);
    }
}
